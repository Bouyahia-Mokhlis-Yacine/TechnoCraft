// Decision support built on the engine snapshot: merchant health score, incident hypotheses,
// weekly brief, collective clusters and the simulator baseline. Read-only: nothing here changes a
// flag, a score or a review. Every figure is computed from the snapshot or typed in by the user.
import { addDays, model, type AnomalyType } from './model';
import { getOverview, merchantHealth, rankedIncidents, type HealthLevel, type Ranked } from './api';
import type { MerchantDay } from './snapshot';

/* ── merchant health score (FR-44) ──────────────────────────────────── */
// Transparent weighted mean of the six health components. Unknown components are left out (never
// counted as healthy) and the coverage is reported next to the score.
const WEIGHTS: Record<string, number> = { 'Recent activity': 0.3, Rejections: 0.2, Cancellations: 0.1, 'Open incidents': 0.25, Recovery: 0.05, 'Data completeness': 0.1 };
const POINTS: Record<HealthLevel, number | null> = { ok: 1, watch: 0.5, issue: 0, unknown: null };

export function healthScore(id: string) {
  const parts = merchantHealth(id).map((h) => ({ ...h, weight: WEIGHTS[h.label] ?? 0, points: POINTS[h.level] }));
  const known = parts.filter((p) => p.points !== null);
  const wsum = known.reduce((s, p) => s + p.weight, 0);
  const score = wsum ? Math.round((100 * known.reduce((s, p) => s + p.weight * (p.points as number), 0)) / wsum) : null;
  return { score, coverage: wsum, parts: parts.map((p) => ({ ...p, share: wsum && p.points !== null ? p.weight / wsum : 0 })) };
}
export const healthBand = (s: number | null) => (s === null ? 'unknown' : s >= 80 ? 'ok' : s >= 50 ? 'watch' : 'issue');

/* ── incident hypotheses (FR-34 for single-merchant incidents) ──────── */
// Rule-based: each hypothesis lists the evidence for and against it from the snapshot, plus the
// data that would confirm it. They are ranked by (for − against); none is ever a confirmed cause.
export interface Hypothesis { title: string; for: string[]; against: string[]; missing: string[]; support: number }

const pct = (x: number) => `${Math.round(x * 100)} %`;
const ratio = (ds: MerchantDay[]) => {
  const e = ds.reduce((s, d) => s + (d.expected_n_adj ?? 0), 0);
  return e ? ds.reduce((s, d) => s + d.n, 0) / e : null;
};

export function incidentHypotheses(inc: Ranked): Hypothesis[] {
  const m = model(), a = inc.latest, ds = m.byMerchant.get(inc.merchant)!;
  const i = ds.findIndex((d) => d.date === a.date), d = ds[i];
  const prior = ds.slice(Math.max(0, i - 28), i).filter((p) => !p.is_anomaly);
  const sameDay = [...m.byMerchant.entries()].filter(([id]) => id !== inc.merchant).map(([, x]) => x.find((y) => y.date === a.date)).filter((y): y is MerchantDay => !!y && !y.warming_up);
  const peers = ratio(sameDay.filter((y) => y.category === inc.category)), network = ratio(sameDay);
  const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
  const chans = [...new Set([...Object.keys(d.channels), ...prior.flatMap((p) => Object.keys(p.channels))])]
    .map((c) => ({ c, obs: d.channels[c]?.[0] ?? 0, dec: d.channels[c]?.[1] ?? 0, usual: median(prior.map((p) => p.channels[c]?.[0] ?? 0)) }))
    .filter((x) => x.usual >= 1 || x.obs >= 1);
  const down = chans.filter((x) => x.usual >= 1 && x.obs <= 0.5 * x.usual);
  const lastHour = d.hours.reduce((acc, v, h) => (v ? h : acc), -1);
  const usualLast = median(prior.map((p) => p.hours.reduce((acc, v, h) => (v ? h : acc), -1)).filter((h) => h >= 0));
  const decTotal = chans.reduce((s, x) => s + x.dec, 0), worst = [...chans].sort((p, q) => q.dec - p.dec)[0];
  const H: Hypothesis[] = [];
  const add = (title: string, f: (string | false | null | undefined | 0)[], ag: (string | false | null | undefined | 0)[], missing: string[]) => {
    const fr = f.filter((x): x is string => !!x), ar = ag.filter((x): x is string => !!x);
    H.push({ title, for: fr, against: ar, missing, support: fr.length - ar.length });
  };
  const peersOk = peers !== null && peers >= 0.8, peersDown = peers !== null && peers < 0.7;
  const netDown = network !== null && network < 0.8;
  const t: AnomalyType = a.type;

  if (t === 'INTERRUPTION' || t === 'DROP_VOLUME') {
    add('Terminal, integration or gateway problem at the merchant',
      [peersOk && `Same-category merchants were at ${pct(peers!)} of their expected level that day`, down.length >= 2 && `${down.length} channels fell together (${down.map((x) => x.c.split(' (')[0]).join(', ')})`],
      [peersDown && `Same-category merchants also fell (${pct(peers!)} of expected)`], ['Terminal and gateway logs for the merchant', 'Acquirer connectivity status']);
    add('Data feed or ingestion gap',
      [netDown && `The whole network was at ${pct(network!)} of its expected level`, peersDown && `Same-category merchants also fell (${pct(peers!)} of expected)`],
      [network !== null && network >= 0.9 && `The rest of the network was normal (${pct(network)} of expected)`], ['Ingestion watermark and batch completeness for the day']);
    add('Merchant closed or reduced opening hours',
      [d.holiday && 'Public holiday', d.n > 0 && lastHour >= 0 && usualLast > 0 && lastHour < usualLast - 2 && `Last transaction at ${String(lastHour).padStart(2, '0')}:00, usually around ${String(usualLast).padStart(2, '0')}:00`],
      [down.length === 1 && chans.length > 1 && 'Only one channel fell, the others kept trading'], ['Merchant’s operating status that day']);
    if (down.length === 1 && chans.length > 1) {
      add(`Failure of one payment channel (${down[0].c})`,
        [`${down[0].c}: ${down[0].obs} transactions vs a usual ${Math.round(down[0].usual)}`, `Other channels traded normally`],
        [], [`Gateway reason codes and service logs for ${down[0].c}`]);
    }
  } else if (t === 'SPIKE_DECLINED' || t === 'NETWORK_DECLINES') {
    const concentrated = worst && decTotal > 0 && worst.dec / decTotal >= 0.7;
    add(`Gateway or acquirer issue${worst ? ` on ${worst.c}` : ''}`,
      [concentrated && `${worst.dec} of ${decTotal} declines on ${worst.c}`, a.advisoryId && `Same-day network advisory ${a.advisoryId}`],
      [!concentrated && decTotal > 0 && 'Declines were spread across channels'], ['Gateway reason codes', 'Switch and service logs for the day']);
    add('Merchant-side configuration or integration change',
      [!a.advisoryId && 'No network-wide decline on the channel that day', peersOk && `Same-category merchants traded normally (${pct(peers!)} of expected)`],
      [a.advisoryId && 'Many merchants on the same channel were affected the same day'], ['Merchant terminal and integration change records']);
  } else if (t === 'ATYPICAL_SURGE') {
    const peak = Math.max(...d.hours), share = d.n ? peak / d.n : 0;
    add('Event, promotion or seasonal demand',
      [peersOk && peers! < 1.3 && 'The surge is specific to this merchant', (d.holiday || [4, 5].includes(new Date(`${a.date}T00:00:00Z`).getUTCDay())) && 'Weekend or public holiday'],
      [], ['Confirmation from the acquiring bank or the merchant']);
    add('Retries or duplicated traffic',
      [share >= 0.3 && `${pct(share)} of the day’s transactions fell in one hour`, d.n_dec + d.n_can > 0.2 * d.n && `${d.n_dec + d.n_can} declined or cancelled of ${d.n}`],
      [share < 0.2 && 'Activity was spread across the day'], ['Transaction identifiers to check for duplicates']);
  } else if (t === 'SPIKE_AMOUNT') {
    const exp = d.expected_n_adj ?? 0;
    add('Genuinely larger orders',
      [exp > 0 && Math.abs(d.n - exp) <= 2 * Math.sqrt(exp) && 'The number of transactions stayed within its normal range'], [], ['Order details from the merchant']);
    add('Data entry or integrity problem',
      [d.ticket !== null && (d.expected_ticket ?? 0) > 0 && d.ticket > 3 * (d.expected_ticket ?? 0) && 'Typical amount more than three times the reference'], [], ['Raw amounts and currency fields from the source']);
  } else if (t === 'CANCEL_SPIKE') {
    add('Retries or reversals after failed payments', [d.n_dec > 0 && `${d.n_dec} declines the same day`], [], ['Reversal and retry logs']);
    add('Change in the merchant’s cancellation process', [inc.days > 1 && `Lasted ${inc.days} days`], [], ['Merchant process change records']);
  }
  return H.sort((x, y) => y.support - x.support);
}

/* ── weekly brief (FR-48) ───────────────────────────────────────────── */
export function weeklyBrief(end: string) {
  const m = model(), from = addDays(end, -6);
  const ov = getOverview({ from, to: end });
  const inc = rankedIncidents();
  const anomalies = m.anomalies.filter((a) => a.date >= from && a.date <= end);
  const byMerchant = new Map<string, number>();
  for (const a of anomalies) byMerchant.set(a.merchant, (byMerchant.get(a.merchant) ?? 0) + 1);
  return {
    from, to: end, overview: ov, anomalies,
    opened: inc.filter((i) => i.onset >= from && i.onset <= end),
    active: inc.filter((i) => i.onset <= end && i.end >= from),
    resolvedInWeek: inc.filter((i) => i.lifecycle === 'resolved' && i.end >= from && i.end <= end),
    topMerchants: [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    advisories: m.advisories.filter((a) => a.date >= from && a.date <= end),
    clusters: (m.snap.collective?.clusters ?? []).filter((c) => c.date >= from && c.date <= end),
    forecast: end === m.snap.run.as_of ? m.snap.forecast.network : null,
  };
}

/* ── collective clusters (V3 subset scan) ───────────────────────────── */
export function listClusters() {
  const m = model(), c = m.snap.collective;
  if (!c) return null;
  return {
    ...c,
    clusters: c.clusters.map((x) => ({
      ...x,
      members: x.members.map((id) => {
        const d = m.byMerchant.get(id)?.find((y) => y.date === x.date);
        const ch = x.channel && d ? d.channels[x.channel] : undefined;
        return { id, flagged: !!d?.is_anomaly, observed: x.kind === 'declines' ? ch?.[1] ?? 0 : d?.n ?? 0, total: x.kind === 'declines' ? ch?.[0] ?? 0 : null, expected: x.kind === 'activity' ? d?.expected_n_adj ?? null : null };
      }),
      advisory: m.advisories.find((a) => a.date === x.date && a.channel === x.channel)?.id ?? null,
    })),
  };
}

/* ── simulator baseline ─────────────────────────────────────────────── */
// Per merchant: expected daily count by day type (the engine's same-day-type median of the last 28
// days), hourly share by channel over those days, typical accepted ticket and expected decline rate.
export function simulatorBaseline() {
  const m = model(), asOf = m.snap.run.as_of, t = m.snap.transactions;
  const from = addDays(asOf, -27);
  const weekend = (iso: string) => [4, 5].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
  const channels = m.channels.filter((c) => c !== 'Unknown');
  type Acc = { hours: Record<string, number[][]>; tickets: number[] };
  const acc = new Map<string, Acc>();
  for (let i = 0; i < t.ts.length; i++) {
    const date = t.ts[i].slice(0, 10);
    if (date < from || date > asOf || t.channel[i] === 'Unknown') continue;
    const id = t.merchants[t.merchant[i]];
    const a = acc.get(id) ?? { hours: {}, tickets: [] };
    const k = weekend(date) ? 1 : 0;
    a.hours[t.channel[i]] ??= [Array(24).fill(0), Array(24).fill(0)];
    a.hours[t.channel[i]][k][Number(t.ts[i].slice(11, 13))]++;
    if (t.status[i] === 'Accepted' && t.amount[i] !== null) a.tickets.push(t.amount[i] as number);
    acc.set(id, a);
  }
  const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
  const merchants = [...m.byMerchant.entries()].map(([id, ds]) => {
    const win = ds.filter((d) => d.date >= from && d.date <= asOf);
    const exp = [0, 1].map((k) => median(win.filter((d) => weekend(d.date) === (k === 1) && !d.is_anomaly).map((d) => d.n)));
    const a = acc.get(id);
    const last = ds[ds.length - 1];
    // hourly share by channel for each day type, normalised to the day's total
    const share = [0, 1].map((k) => {
      const tot = channels.reduce((s, c) => s + (a?.hours[c]?.[k].reduce((x, y) => x + y, 0) ?? 0), 0) || 1;
      return Object.fromEntries(channels.map((c) => [c, (a?.hours[c]?.[k] ?? Array(24).fill(0)).map((v) => v / tot)]));
    });
    return { id, category: last.category, expected: exp, share, ticket: median(a?.tickets ?? []), decRate: last.expected_dec_rate ?? 0, learning: last.warming_up };
  });
  // busiest channel first, so the simulator opens on a scenario that matters
  const vol = (c: string) => merchants.reduce((s, x) => s + x.expected[0] * (x.share[0][c]?.reduce((a, b) => a + b, 0) ?? 0), 0);
  channels.sort((a, b) => vol(b) - vol(a));
  return { asOf, from, channels, categories: m.categories, alpha: m.snap.run.dispersion, high: m.snap.run.policy.high, incidentMin: 6, merchants };
}

export function valueCurve() {
  const r = model().snap.run;
  return { curve: r.value_curve ?? [], policy: r.policy.high, trainEnd: r.train_end };
}
