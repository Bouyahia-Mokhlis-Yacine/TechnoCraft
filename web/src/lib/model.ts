// Domain model derived from the engine snapshot: official anomalies (V2 flags, immutable),
// incidents (episodes of consecutive flagged days), advisories, watchlist and aggregates.
// Nothing here changes a flag or a score; it only reads and explains them (SRS FR-13–16, FR-26–39).
import { snapshot, type AdvisoryRaw, type MerchantDay, type Snapshot } from './snapshot';
import { fmtDate, fmtDzd, fmtInt, fmtPct } from './format';

export type AnomalyType = 'INTERRUPTION' | 'DROP_VOLUME' | 'ATYPICAL_SURGE' | 'SPIKE_AMOUNT' | 'SPIKE_DECLINED' | 'NETWORK_DECLINES' | 'CANCEL_SPIKE';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Lifecycle = 'active' | 'recovering' | 'resolved';
export type Unit = 'tx' | 'ratio' | 'DZD';

export const SIGNAL_LABEL: Record<string, string> = {
  s_drop: 'Low activity that day', s_surge: 'High activity that day',
  s_drop_sustained: 'Low activity over 3 days', s_surge_sustained: 'High activity over 3 days',
  s_decline: 'Excess declines', s_decline_channel: 'Excess declines on one channel',
  s_cancel: 'Excess cancellations', s_amount: 'Larger payments than usual', s_incident: 'Network-wide channel incident',
};

/** Investigation playbook (SRS §8): suggested check and accountable owner per symptom. */
export const PLAYBOOK: Record<AnomalyType, { check: string; owner: string; steps: string[] }> = {
  INTERRUPTION: { check: 'Check the ingestion watermark, the merchant’s opening schedule and terminal / gateway connectivity.', owner: 'Operations analyst + technical investigator', steps: ['Ingestion watermark', 'Opening schedule', 'Terminal / gateway link'] },
  DROP_VOLUME: { check: 'Check feed completeness and the merchant’s operating status, then the main channel’s acceptance.', owner: 'Operations analyst', steps: ['Feed completeness', 'Operating status', 'Main channel acceptance'] },
  ATYPICAL_SURGE: { check: 'Confirm with the acquiring bank whether an event or promotion explains the volume; watch capacity.', owner: 'Operations analyst', steps: ['Event or promotion (acquiring bank)', 'Capacity'] },
  SPIKE_AMOUNT: { check: 'Inspect the distribution of valid ticket sizes, the category’s activity and data integrity.', owner: 'Operations analyst', steps: ['Ticket-size distribution', 'Category activity', 'Data integrity'] },
  SPIKE_DECLINED: { check: 'Compare statuses by channel; request gateway reason codes and service logs.', owner: 'Technical investigator', steps: ['Statuses by channel', 'Gateway reason codes', 'Service logs'] },
  NETWORK_DECLINES: { check: 'Treat as part of the network advisory: request gateway reason codes and service logs for the channel.', owner: 'Technical investigator', steps: ['Network advisory', 'Gateway reason codes', 'Channel service logs'] },
  CANCEL_SPIKE: { check: 'Review the cancellation mix and retry / reversal behaviour.', owner: 'Operations analyst', steps: ['Cancellation mix', 'Retry / reversal behaviour'] },
};

export interface Signal { key: string; label: string; score: number }
export interface Anomaly {
  id: string; merchant: string; category: string; date: string; type: AnomalyType; severity: Severity; score: number;
  signals: Signal[]; indicator: string; observed: number; expected: number | null; lo: number | null; hi: number | null; unit: Unit;
  explanation: string; reasons: string[]; check: string; owner: string; steps: string[]; incidentId: string; advisoryId: string | null;
  holiday: boolean; holidayFactor: number; historyDays: number;
}
export interface Incident {
  id: string; merchant: string; category: string; onset: string; end: string; days: number; anomalyIds: string[];
  type: AnomalyType; types: AnomalyType[]; severity: Severity; peakScore: number; lifecycle: Lifecycle; quietDays: number;
  affectedEvents: number; valueExposure: number; advisoryId: string | null; latest: Anomaly;
}
export type Advisory = AdvisoryRaw & { otherChannels: { channel: string; n: number; n_dec: number }[]; incidentIds: string[] };

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const sevRank = (s: Severity) => SEV_RANK[s];
export const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 864e5).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function typeOf(d: MerchantDay): AnomalyType {
  const s = d.main_signal;
  if (s === 'drop' || s === 'drop_sustained') return d.n === 0 ? 'INTERRUPTION' : 'DROP_VOLUME';
  if (s.startsWith('surge')) return 'ATYPICAL_SURGE';
  if (s === 'incident') return 'NETWORK_DECLINES';
  if (s.startsWith('decline')) return 'SPIKE_DECLINED';
  if (s === 'cancel') return 'CANCEL_SPIKE';
  if (s === 'amount') return 'SPIKE_AMOUNT';
  return d.n < (d.expected_n_adj ?? 0) ? 'DROP_VOLUME' : 'ATYPICAL_SURGE';
}
/** Severity from the engine's evidence (−log10 p): ≥10 critical, ≥7 high, ≥4 opens an alert, below = joined by hysteresis. */
const severityOf = (d: MerchantDay, t: AnomalyType): Severity =>
  t === 'INTERRUPTION' || d.anomaly_score >= 10 ? 'critical' : d.anomaly_score >= 7 ? 'high' : d.anomaly_score >= 4 ? 'medium' : 'low';

const rate = (k: number, n: number) => (n > 0 ? k / n : 0);

function indicatorOf(d: MerchantDay, t: AnomalyType) {
  if (t === 'SPIKE_DECLINED') return { indicator: 'rejection rate', observed: rate(d.n_dec, d.n), expected: d.expected_dec_rate, lo: null, hi: null, unit: 'ratio' as Unit };
  if (t === 'NETWORK_DECLINES') {
    const c = d.incident_channel ? d.channels[d.incident_channel] : undefined;
    return { indicator: `rejection rate on ${d.incident_channel ?? 'the channel'}`, observed: c ? rate(c[1], c[0]) : rate(d.n_dec, d.n), expected: d.expected_dec_rate, lo: null, hi: null, unit: 'ratio' as Unit };
  }
  if (t === 'CANCEL_SPIKE') return { indicator: 'cancellation rate', observed: rate(d.n_can, d.n), expected: d.expected_can_rate, lo: null, hi: null, unit: 'ratio' as Unit };
  if (t === 'SPIKE_AMOUNT') return { indicator: 'typical payment', observed: d.ticket ?? 0, expected: d.expected_ticket, lo: null, hi: null, unit: 'DZD' as Unit };
  return { indicator: 'transactions', observed: d.n, expected: d.expected_n_adj, lo: d.expected_lo, hi: d.expected_hi, unit: 'tx' as Unit };
}

export const fmtUnit = (v: number | null, u: Unit) => (v === null ? 'n/a' : u === 'DZD' ? fmtDzd(v) : u === 'ratio' ? fmtPct(v, 1) : fmtInt(v));

/** B4 explanation contract: merchant, period, indicator, observed vs reference, what triggered it. */
function explain(d: MerchantDay, t: AnomalyType, ind: ReturnType<typeof indicatorOf>, advisoryId: string | null) {
  const day = fmtDate(d.date), exp = ind.expected;
  if (ind.unit === 'tx') {
    const range = ind.lo !== null && ind.hi !== null ? ` (normal range ${fmtInt(ind.lo)}–${fmtInt(ind.hi)})` : '';
    const diff = exp ? Math.round(((d.n - exp) / exp) * 100) : 0;
    const how = d.main_signal.endsWith('sustained') ? 'Accumulated evidence over three days' : 'Activity this far from the merchant’s own reference';
    return t === 'ATYPICAL_SURGE'
      ? `${d.merchant_id} recorded ${fmtInt(d.n)} transactions on ${day}, compared with ${fmtInt(exp ?? 0)} expected${range}, ${diff >= 100 ? `×${(d.n / (exp || 1)).toFixed(1).replace('.', ',')}` : `+${diff} %`} above. ${how} triggered the alert.`
      : `${d.merchant_id} recorded ${fmtInt(d.n)} transactions on ${day}, compared with ${fmtInt(exp ?? 0)} expected${range}, a ${Math.abs(diff)} % shortfall. ${d.n === 0 ? 'No activity at all' : how} triggered the alert.`;
  }
  if (t === 'SPIKE_AMOUNT') return `${d.merchant_id}’s typical accepted payment on ${day} was ${fmtDzd(d.ticket ?? 0)}, compared with ${fmtDzd(exp ?? 0)} expected, across ${fmtInt(d.n_acc)} accepted payments. Ticket sizes this far above the reference triggered the alert.`;
  if (t === 'NETWORK_DECLINES') return `${ind.indicator[0].toUpperCase()}${ind.indicator.slice(1)} at ${d.merchant_id} reached ${fmtPct(ind.observed, 0)} on ${day}, compared with ${fmtPct(exp ?? 0, 1)} expected, on a day when the same channel showed excess declines across the network${advisoryId ? ` (advisory ${advisoryId})` : ''}.`;
  if (t === 'CANCEL_SPIKE') return `${fmtInt(d.n_can)} of ${fmtInt(d.n)} transactions at ${d.merchant_id} were cancelled on ${day} (${fmtPct(ind.observed, 0)}), compared with ${fmtPct(exp ?? 0, 1)} expected.`;
  return `${fmtInt(d.n_dec)} of ${fmtInt(d.n)} payments at ${d.merchant_id} were declined on ${day} (${fmtPct(ind.observed, 0)}), compared with ${fmtPct(exp ?? 0, 1)} expected for this merchant.`;
}

function reasonsFor(d: MerchantDay, t: AnomalyType, prior: MerchantDay[]): string[] {
  const r: string[] = [];
  const chans = [...new Set([...Object.keys(d.channels), ...prior.flatMap((p) => Object.keys(p.channels))])];
  const usual = (c: string, i: 0 | 1) => median(prior.map((p) => p.channels[c]?.[i] ?? 0));
  if (t === 'INTERRUPTION' || t === 'DROP_VOLUME' || t === 'ATYPICAL_SURGE') {
    const diffs = chans.map((c) => ({ c, obs: d.channels[c]?.[0] ?? 0, u: usual(c, 0) })).filter((x) => x.u >= 1 || x.obs >= 1);
    diffs.sort((a, b) => Math.abs(b.obs - b.u) - Math.abs(a.obs - a.u));
    for (const x of diffs.slice(0, 2)) if (Math.abs(x.obs - x.u) >= 2) r.push(`${x.c}: ${fmtInt(x.obs)} transactions vs a usual ${fmtInt(x.u)}`);
    if (t === 'DROP_VOLUME' && d.n > 0) {
      const last = d.hours.reduce((acc, v, h) => (v ? h : acc), -1);
      const tot = prior.reduce((s, p) => s + p.n, 0) || 1;
      const after = prior.reduce((s, p) => s + p.hours.slice(last + 1).reduce((a, b) => a + b, 0), 0) / tot;
      if (last >= 0 && last < 21 && after >= 0.3) r.push(`No transaction after ${String(last + 1).padStart(2, '0')}:00, while ${fmtPct(after, 0)} of the merchant’s activity usually comes later`);
    }
    if (d.main_signal.endsWith('sustained')) {
      const w = [...prior.slice(-2), d];
      r.push(`Last 3 days: ${fmtInt(w.reduce((s, x) => s + x.n, 0))} transactions vs ${fmtInt(w.reduce((s, x) => s + (x.expected_n_adj ?? 0), 0))} expected`);
    }
  } else if (t === 'SPIKE_DECLINED' || t === 'NETWORK_DECLINES') {
    const worst = chans.map((c) => ({ c, k: d.channels[c]?.[1] ?? 0, n: d.channels[c]?.[0] ?? 0 })).sort((a, b) => b.k - a.k)[0];
    if (worst?.k) r.push(`Most declines on ${worst.c}: ${fmtInt(worst.k)} of ${fmtInt(worst.n)}`);
    r.push(`Overall: ${fmtInt(d.n_dec)} declined of ${fmtInt(d.n)} transactions`);
  } else if (t === 'SPIKE_AMOUNT') {
    r.push(`Value accepted: ${fmtDzd(d.value)}`);
    r.push(`Number of transactions ${d.expected_n_adj !== null && Math.abs(d.n - d.expected_n_adj) <= 2 * Math.sqrt(d.expected_n_adj) ? 'stayed within its normal range' : 'also moved'}: ${fmtInt(d.n)} vs ${fmtInt(d.expected_n_adj ?? 0)} expected`);
  } else if (t === 'CANCEL_SPIKE') {
    r.push(`Cancelled: ${fmtInt(d.n_can)} · refunded: ${fmtInt(d.n_ref)} · declined: ${fmtInt(d.n_dec)}`);
  }
  if (d.holiday) r.push(`Public holiday: the expectation was scaled ×${d.holiday_factor.toFixed(2).replace('.', ',')} from the category’s own movement that day`);
  if (d.history_days < 14) r.push(`Sparse history: only ${d.history_days} prior days for this merchant`);
  return r;
}

interface Model {
  snap: Snapshot; byMerchant: Map<string, MerchantDay[]>; anomalies: Anomaly[]; anomalyById: Map<string, Anomaly>;
  incidents: Incident[]; incidentById: Map<string, Incident>; advisories: Advisory[]; categories: string[]; channels: string[];
  watchlist: { merchant: string; date: string; score: number; signal: string }[];
}

let memo: { id: string; m: Model } | null = null;

export function model(): Model {
  const snap = snapshot();
  if (memo?.id === snap.run.run_id) return memo.m;
  const byMerchant = new Map<string, MerchantDay[]>();
  for (const d of snap.merchant_days) byMerchant.set(d.merchant_id, [...(byMerchant.get(d.merchant_id) ?? []), d]);
  for (const days of byMerchant.values()) days.sort((a, b) => a.date.localeCompare(b.date));
  const asOf = snap.run.as_of, W = snap.run.policy.window_days;
  const advFor = (d: MerchantDay) => (d.s_incident > 0 ? snap.advisories.find((a) => a.date === d.date && a.channel === d.incident_channel)?.id ?? null : null);

  const anomalies: Anomaly[] = [], incidents: Incident[] = [];
  for (const [mid, days] of byMerchant) {
    let cur: Anomaly[] = [];
    const close = () => {
      if (!cur.length) return;
      const peak = cur.reduce((p, a) => (a.score > p.score ? a : p));
      const first = cur[0], last = cur[cur.length - 1];
      const id = `INC-${mid.slice(4)}-${first.date.slice(5).replace('-', '')}`;
      let affected = 0, value = 0;
      for (const a of cur) {
        const d = days.find((x) => x.date === a.date)!;
        const ticket = d.expected_ticket ?? 0;
        let ev = 0;
        if (a.type === 'INTERRUPTION' || a.type === 'DROP_VOLUME') ev = Math.max(0, (d.expected_n_adj ?? 0) - d.n);
        else if (a.type === 'ATYPICAL_SURGE') ev = Math.max(0, d.n - (d.expected_n_adj ?? 0));
        else if (a.type === 'SPIKE_DECLINED' || a.type === 'NETWORK_DECLINES') ev = Math.max(0, d.n_dec - (d.expected_dec_rate ?? 0) * d.n);
        else if (a.type === 'CANCEL_SPIKE') ev = Math.max(0, d.n_can - (d.expected_can_rate ?? 0) * d.n);
        affected += a.type === 'SPIKE_AMOUNT' ? 0 : ev;
        value += a.type === 'SPIKE_AMOUNT' ? Math.max(0, ((d.ticket ?? 0) - ticket) * d.n_acc) : ev * ticket;
      }
      const quiet = daysBetween(last.date, asOf);
      for (const a of cur) a.incidentId = id;
      incidents.push({
        id, merchant: mid, category: first.category, onset: first.date, end: last.date, days: cur.length, anomalyIds: cur.map((a) => a.id),
        type: peak.type, types: [...new Set(cur.map((a) => a.type))], severity: cur.reduce((s, a) => (SEV_RANK[a.severity] < SEV_RANK[s] ? a.severity : s), 'low' as Severity),
        peakScore: peak.score, lifecycle: quiet === 0 ? 'active' : quiet === 1 ? 'recovering' : 'resolved', quietDays: quiet,
        affectedEvents: Math.round(affected), valueExposure: Math.round(value), advisoryId: cur.map((a) => a.advisoryId).find(Boolean) ?? null, latest: last,
      });
      cur = [];
    };
    days.forEach((d, i) => {
      if (!d.is_anomaly) { close(); return; }
      if (cur.length && daysBetween(cur[cur.length - 1].date, d.date) !== 1) close();
      const t = typeOf(d), ind = indicatorOf(d, t), advisoryId = advFor(d);
      const prior = days.slice(Math.max(0, i - W), i).filter((p) => !p.is_anomaly);
      const signals = Object.keys(SIGNAL_LABEL).map((k) => ({ key: k, label: SIGNAL_LABEL[k], score: (d as unknown as Record<string, number>)[k] })).filter((s) => s.score >= 1).sort((a, b) => b.score - a.score);
      const a: Anomaly = {
        id: `${mid}_${d.date}`, merchant: mid, category: d.category, date: d.date, type: t, severity: severityOf(d, t), score: d.anomaly_score, signals,
        ...ind, explanation: explain(d, t, ind, advisoryId), reasons: reasonsFor(d, t, prior), ...PLAYBOOK[t], incidentId: '', advisoryId,
        holiday: d.holiday, holidayFactor: d.holiday_factor, historyDays: d.history_days,
      };
      anomalies.push(a); cur.push(a);
    });
    close();
  }

  const advisories: Advisory[] = snap.advisories.map((a) => {
    const ch: Record<string, [number, number]> = {};
    for (const d of snap.merchant_days) if (d.date === a.date) for (const [c, v] of Object.entries(d.channels)) ch[c] = [(ch[c]?.[0] ?? 0) + v[0], (ch[c]?.[1] ?? 0) + v[1]];
    return { ...a, otherChannels: Object.entries(ch).filter(([c]) => c !== a.channel).map(([channel, [n, n_dec]]) => ({ channel, n, n_dec })), incidentIds: incidents.filter((i) => i.advisoryId === a.id).map((i) => i.id) };
  });

  const watchlist = [...byMerchant.values()].map((days) => days[days.length - 1])
    .filter((d) => !d.is_anomaly && d.anomaly_score >= snap.run.policy.low && d.date === asOf)
    .map((d) => ({ merchant: d.merchant_id, date: d.date, score: d.anomaly_score, signal: SIGNAL_LABEL[`s_${d.main_signal}`] ?? d.main_signal }));

  const m: Model = {
    snap, byMerchant, anomalies, anomalyById: new Map(anomalies.map((a) => [a.id, a])), incidents, incidentById: new Map(incidents.map((i) => [i.id, i])),
    advisories, watchlist, categories: [...new Set(snap.merchant_days.map((d) => d.category))].sort(), channels: [...new Set(snap.transactions.channel)].sort(),
  };
  memo = { id: snap.run.run_id, m };
  return m;
}

/* ── network aggregates straight from the sanitized transactions (FR-17, FR-19) ── */
/** `channel` may list several channels separated by commas (overview multi-select). */
export interface Scope { from: string; to: string; merchant?: string; category?: string; channel?: string }
export const channelSet = (c?: string) => (c ? new Set(c.split(',').map((x) => x.trim()).filter(Boolean)) : null);
export interface DayAgg { date: string; events: number; accepted: number; acceptedValue: number; attemptedValue: number; declined: number; cancelled: number; refunded: number }

export function aggregate(s: Scope) {
  const t = model().snap.transactions;
  const mIdx = s.merchant ? t.merchants.indexOf(s.merchant) : -1, chs = channelSet(s.channel);
  const days = new Map<string, DayAgg>();
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) days.set(d, { date: d, events: 0, accepted: 0, acceptedValue: 0, attemptedValue: 0, declined: 0, cancelled: 0, refunded: 0 });
  const byChannel = new Map<string, number>(), byCategory = new Map<string, number>(), byMerchant = new Map<string, DayAgg>();
  for (let i = 0; i < t.ts.length; i++) {
    const date = t.ts[i].slice(0, 10);
    const day = days.get(date);
    if (!day) continue;
    if ((s.merchant && t.merchant[i] !== mIdx) || (s.category && t.category[i] !== s.category) || (chs && !chs.has(t.channel[i]))) continue;
    const st = t.status[i], amt = t.amount[i];
    const mid = t.merchants[t.merchant[i]];
    const mm = byMerchant.get(mid) ?? { date: mid, events: 0, accepted: 0, acceptedValue: 0, attemptedValue: 0, declined: 0, cancelled: 0, refunded: 0 };
    for (const a of [day, mm]) {
      a.events++;
      if (st === 'Accepted') { a.accepted++; if (amt !== null) a.acceptedValue += amt; }
      if (st !== 'Refunded' && amt !== null) a.attemptedValue += amt;
      if (st === 'Declined') a.declined++; else if (st === 'Cancelled') a.cancelled++; else if (st === 'Refunded') a.refunded++;
    }
    byMerchant.set(mid, mm);
    byChannel.set(t.channel[i], (byChannel.get(t.channel[i]) ?? 0) + 1);
    byCategory.set(t.category[i], (byCategory.get(t.category[i]) ?? 0) + 1);
  }
  const list = [...days.values()];
  const sum = (k: keyof Omit<DayAgg, 'date'>) => list.reduce((x, d) => x + d[k], 0);
  return {
    days: list,
    totals: { events: sum('events'), accepted: sum('accepted'), acceptedValue: sum('acceptedValue'), attemptedValue: sum('attemptedValue'), declined: sum('declined'), cancelled: sum('cancelled'), refunded: sum('refunded') },
    byChannel: [...byChannel.entries()].sort((a, b) => b[1] - a[1]), byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    byMerchant: [...byMerchant.values()].sort((a, b) => b.events - a.events),
  };
}
