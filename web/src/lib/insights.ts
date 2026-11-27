// Decision support built on the engine snapshot: merchant health score, incident hypotheses,
// weekly brief, collective clusters and the simulator baseline. Read-only: nothing here changes a
// flag, a score or a review. Every figure is computed from the snapshot or typed in by the user.
import { addDays, model, type AnomalyType } from './model';
import { getOverview, merchantHealth, rankedIncidents, type HealthLevel, type Ranked } from './api';
import type { MerchantDay } from './snapshot';
import { currentLocale, fmtPct } from './format';
import { translate, type Key, type Vars } from './i18n';
import { channelLabel } from './labels';

/* ── merchant health score (FR-44) ──────────────────────────────────── */
// Transparent weighted mean of the six health components. Unknown components are left out (never
// counted as healthy) and the coverage is reported next to the score.
const WEIGHTS: Record<string, number> = { activity: 0.3, rejections: 0.2, cancellations: 0.1, incidents: 0.25, recovery: 0.05, completeness: 0.1 };
const POINTS: Record<HealthLevel, number | null> = { ok: 1, watch: 0.5, issue: 0, unknown: null };

export function healthScore(id: string, run?: string | null) {
  const parts = merchantHealth(id, run).map((h) => ({ ...h, weight: WEIGHTS[h.key] ?? 0, points: POINTS[h.level] }));
  const known = parts.filter((p) => p.points !== null);
  const wsum = known.reduce((s, p) => s + p.weight, 0);
  const score = wsum ? Math.round((100 * known.reduce((s, p) => s + p.weight * (p.points as number), 0)) / wsum) : null;
  return { score, coverage: wsum, parts: parts.map((p) => ({ ...p, share: wsum && p.points !== null ? p.weight / wsum : 0 })) };
}
export const healthBand = (s: number | null) => (s === null ? 'unknown' : s >= 80 ? 'ok' : s >= 50 ? 'watch' : 'issue');

/* ── incident hypotheses (FR-34 for single-merchant incidents) ──────── */
// Rule-based: each hypothesis lists the evidence for and against it from the snapshot, plus the
// data that would confirm it. They are ranked by (for − against); none is ever a confirmed cause.
// Sentences are built in the operator's language from the same computed values.
export interface Hypothesis { title: string; for: string[]; against: string[]; missing: string[]; support: number }

const tr = (key: string, vars?: Vars) => translate(currentLocale(), key as Key, vars);
const pct = (x: number) => fmtPct(x, 0);
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
const ratio = (ds: MerchantDay[]) => {
  const e = ds.reduce((s, d) => s + (d.expected_n_adj ?? 0), 0);
  return e ? ds.reduce((s, d) => s + d.n, 0) / e : null;
};

export function incidentHypotheses(inc: Ranked, run?: string | null): Hypothesis[] {
  const m = model(run), a = inc.latest, ds = m.byMerchant.get(inc.merchant)!;
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
  const ch = (c: string) => channelLabel(c);
  const H: Hypothesis[] = [];
  const add = (title: string, f: (string | false | null | undefined | 0)[], ag: (string | false | null | undefined | 0)[], missing: string[]) => {
    const fr = f.filter((x): x is string => !!x), ar = ag.filter((x): x is string => !!x);
    H.push({ title, for: fr, against: ar, missing, support: fr.length - ar.length });
  };
  const peersOk = peers !== null && peers >= 0.8, peersDown = peers !== null && peers < 0.7;
  const netDown = network !== null && network < 0.8;
  const t: AnomalyType = a.type;

  if (t === 'INTERRUPTION' || t === 'DROP_VOLUME') {
    add(tr('hyp.terminal'),
      [peersOk && tr('hyp.peersOk', { pct: pct(peers!) }), down.length >= 2 && tr('hyp.channelsFell', { n: down.length, list: down.map((x) => ch(x.c).split(' (')[0]).join(', ') })],
      [peersDown && tr('hyp.peersDown', { pct: pct(peers!) })], [tr('hyp.needTerminalLogs'), tr('hyp.needAcquirer')]);
    add(tr('hyp.feed'),
      [netDown && tr('hyp.networkDown', { pct: pct(network!) }), peersDown && tr('hyp.peersDown', { pct: pct(peers!) })],
      [network !== null && network >= 0.9 && tr('hyp.networkOk', { pct: pct(network) })], [tr('hyp.needWatermark')]);
    add(tr('hyp.closed'),
      [d.holiday && tr('hyp.holiday'), d.n > 0 && lastHour >= 0 && usualLast > 0 && lastHour < usualLast - 2 && tr('hyp.lastTx', { last: hour(lastHour), usual: hour(usualLast) })],
      [down.length === 1 && chans.length > 1 && tr('hyp.oneChannelOnly')], [tr('hyp.needOperating')]);
    if (down.length === 1 && chans.length > 1) {
      add(tr('hyp.channelFailure', { channel: ch(down[0].c) }),
        [tr('hyp.channelVs', { channel: ch(down[0].c), obs: down[0].obs, usual: Math.round(down[0].usual) }), tr('hyp.othersNormal')],
        [], [tr('hyp.needGatewayFor', { channel: ch(down[0].c) })]);
    }
  } else if (t === 'SPIKE_DECLINED' || t === 'NETWORK_DECLINES') {
    const concentrated = worst && decTotal > 0 && worst.dec / decTotal >= 0.7;
    add(worst ? tr('hyp.gatewayOn', { channel: ch(worst.c) }) : tr('hyp.gateway'),
      [concentrated && tr('hyp.declinesOn', { k: worst.dec, n: decTotal, channel: ch(worst.c) }), a.advisoryId && tr('hyp.advisorySameDay', { id: a.advisoryId })],
      [!concentrated && decTotal > 0 && tr('hyp.declinesSpread')], [tr('hyp.needReasonCodes'), tr('hyp.needSwitchLogs')]);
    add(tr('hyp.config'),
      [!a.advisoryId && tr('hyp.noNetworkDecline'), peersOk && tr('hyp.peersTraded', { pct: pct(peers!) })],
      [a.advisoryId && tr('hyp.manyAffected')], [tr('hyp.needChangeRecords')]);
  } else if (t === 'ATYPICAL_SURGE') {
    const peak = Math.max(...d.hours), share = d.n ? peak / d.n : 0;
    add(tr('hyp.event'),
      [peersOk && peers! < 1.3 && tr('hyp.surgeSpecific'), (d.holiday || [4, 5].includes(new Date(`${a.date}T00:00:00Z`).getUTCDay())) && tr('hyp.weekend')],
      [], [tr('hyp.needBankConfirm')]);
    add(tr('hyp.retries'),
      [share >= 0.3 && tr('hyp.oneHour', { pct: pct(share) }), d.n_dec + d.n_can > 0.2 * d.n && tr('hyp.decCanOf', { k: d.n_dec + d.n_can, n: d.n })],
      [share < 0.2 && tr('hyp.spread')], [tr('hyp.needIds')]);
  } else if (t === 'SPIKE_AMOUNT') {
    add(tr('hyp.largerOrders'),
      [d.expected_lo !== null && d.expected_hi !== null && d.n >= d.expected_lo && d.n <= d.expected_hi && tr('hyp.countWithin')], [], [tr('hyp.needOrders')]);
    add(tr('hyp.integrity'),
      [d.ticket !== null && (d.expected_ticket ?? 0) > 0 && d.ticket > 3 * (d.expected_ticket ?? 0) && tr('hyp.ticket3x')], [], [tr('hyp.needRaw')]);
  } else if (t === 'CANCEL_SPIKE') {
    add(tr('hyp.reversals'), [d.n_dec > 0 && tr('hyp.declinesSameDay', { n: d.n_dec })], [], [tr('hyp.needReversal')]);
    add(tr('hyp.cancelProcess'), [inc.days > 1 && tr('hyp.lasted', { n: inc.days })], [], [tr('hyp.needProcess')]);
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
    resolvedInWeek: inc.filter((i) => i.lifecycle === 'resolved' && i.evidence.as_of >= from && i.evidence.as_of <= end),
    topMerchants: [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    advisories: m.advisories.filter((a) => a.date >= from && a.date <= end),
    clusters: m.advisories.filter((c) => c.date >= from && c.date <= end),
    candidates: m.snap.hybrid?.rows.filter((c) => c.investigation_candidate && c.date >= from && c.date <= end) ?? [],
    forecast: end === m.snap.run.as_of ? m.snap.forecast.network : null,
  };
}

/* ── collective clusters (V3 subset scan) ───────────────────────────── */
export function listClusters() {
  const m = model();
  if (!m.snap.run.models.v3) return null;
  return {
    method: 'Frozen Collective Detection likelihood subset scan with ordinary date-max calibration',
    clusters: m.advisories.map((a) => ({
      id: a.id, kind: a.symptom === 'rejection_increase' ? 'declines' as const : 'activity' as const,
      date: a.date, channel: a.channel, observed: a.observed, expected: a.expected,
      relative_risk: a.expected ? a.observed / a.expected : 0, score: a.score,
      p_value: a.calibration_date_tail_rank, cohort: a.members.length, advisory: a.id, symptom: a.symptom,
      members: a.members.map((row) => ({ id: row.merchant_id, flagged: row.flagged,
        observed: row.observed, expected: row.expected, total: row.exposure })),
    })),
  };
}

export function simulatorBaseline() {
  const m = model(), t = m.snap.transactions;
  const from = m.snap.run.first_date, asOf = m.snap.run.reference_last_date;
  const weekend = (iso: string) => [4, 5].includes(new Date(iso + 'T00:00:00Z').getUTCDay());
  const channels = m.channels;
  const hourly = new Map<string, Record<string, number[][]>>();
  for (let i = 0; i < t.ts.length; i++) {
    const date = t.ts[i].slice(0, 10);
    if (date > asOf) continue;
    const id = t.merchants[t.merchant[i]], profile = hourly.get(id) ?? {};
    profile[t.channel[i]] ??= [Array<number>(24).fill(0), Array<number>(24).fill(0)];
    profile[t.channel[i]][Number(weekend(date))][Number(t.ts[i].slice(11, 13))]++;
    hourly.set(id, profile);
  }
  const merchants = [...m.byMerchant.entries()].map(([id, days]) => {
    const byChannel = hourly.get(id) ?? {};
    const metrics = [false, true].map((kind) => {
      const forecasts = m.snap.forecast.detail.days.filter((d) => weekend(d.date) === kind).map((d) => d.merchants[id]);
      const n = forecasts.reduce((sum, d) => sum + (d?.transactions?.mean ?? 0), 0);
      const sum = (metric: 'accepted_value' | 'rejections') =>
        n > 0 && forecasts.every((d) => d?.[metric]) ? forecasts.reduce((total, d) => total + (d[metric]?.mean ?? 0), 0) / n : null;
      return { expected: n / Math.max(1, forecasts.length), valuePerEvent: sum('accepted_value'), rejectionRate: sum('rejections') };
    });
    const share = [0, 1].map((kind) => {
      const total = Object.values(byChannel).reduce((n, hours) => n + hours[kind].reduce((a, b) => a + b, 0), 0);
      return Object.fromEntries(channels.map((c) => [c, (byChannel[c]?.[kind] ?? Array<number>(24).fill(0)).map((n) => total ? n / total : 0)]));
    });
    return { id, category: days[days.length - 1].category, expected: metrics.map((r) => r.expected), share,
      valuePerEvent: metrics.map((r) => r.valuePerEvent), rejectionRate: metrics.map((r) => r.rejectionRate) };
  }).filter((m) => hourly.has(m.id));
  return { asOf, from, channels, categories: m.categories, merchants };
}

export function valueCurve() {
  const r = model().snap.run;
  const { tp, fp, fn } = r.validation;
  return { curve: [{ threshold: r.policy.high, tp, fp, fn, flagged: tp + fp }], policy: r.policy.high, trainEnd: r.train_end };
}
