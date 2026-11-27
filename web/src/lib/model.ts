// Domain model derived from the engine snapshot: official anomalies (V2 flags, immutable),
// incidents (episodes of consecutive flagged days), advisories, watchlist and aggregates.
// Nothing here changes a flag or a score; it only reads and explains them (SRS FR-13–16, FR-26–39).
import { snapshot, type AdvisoryRaw, type Explanation, type IncidentEvidence, type MerchantDay, type Snapshot } from './snapshot';
import { currentLocale, fmtDzd, fmtInt, fmtPct, na } from './format';
import { translate, type Key } from './i18n';
import { engineText, explanationText } from './i18n/engine';

export type AnomalyType = 'INTERRUPTION' | 'DROP_VOLUME' | 'ATYPICAL_SURGE' | 'SPIKE_AMOUNT' | 'SPIKE_DECLINED' | 'NETWORK_DECLINES' | 'CANCEL_SPIKE';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Lifecycle = 'active' | 'recovering' | 'resolved';
export type Unit = 'tx' | 'ratio' | 'DZD';

const tr = (key: Key) => translate(currentLocale(), key);
const SIGNALS = ['s_drop', 's_surge', 's_drop_sustained', 's_surge_sustained', 's_decline', 's_decline_channel', 's_cancel', 's_amount', 's_incident'];
/** Signal names in the operator's language (read when used). */
export const SIGNAL_LABEL = Object.defineProperties({} as Record<string, string>,
  Object.fromEntries(SIGNALS.map((k) => [k, { enumerable: true, get: () => tr(`signal.${k}` as Key) }])));

/** Investigation playbook (SRS §8): suggested check and accountable owner per symptom, in the operator's language. */
const TYPES_ALL: AnomalyType[] = ['INTERRUPTION', 'DROP_VOLUME', 'ATYPICAL_SURGE', 'SPIKE_AMOUNT', 'SPIKE_DECLINED', 'NETWORK_DECLINES', 'CANCEL_SPIKE'];
export const PLAYBOOK = Object.fromEntries(TYPES_ALL.map((t) => [t, {
  get check() { return tr(`pb.${t}.check` as Key); },
  get owner() { return tr(`pb.${t}.owner` as Key); },
  get steps() { return tr(`pb.${t}.steps` as Key).split(' | '); },
}])) as Record<AnomalyType, { check: string; owner: string; steps: string[] }>;

export interface Signal { key: string; label: string; score: number }
export interface Anomaly {
  id: string; merchant: string; category: string; date: string; type: AnomalyType; severity: Severity; score: number;
  signals: Signal[]; indicator: string; observed: number | null; expected: number | null; lo: number | null; hi: number | null; unit: Unit;
  explanation: string; reasons: string[]; check: string; owner: string; steps: string[]; incidentId: string; advisoryId: string | null;
  holiday: boolean; holidayFactor: number; historyDays: number; evidence: Explanation;
}
export interface Incident {
  id: string; merchant: string; category: string; onset: string; end: string; days: number; anomalyIds: string[];
  type: AnomalyType; types: AnomalyType[]; severity: Severity; peakScore: number; lifecycle: Lifecycle; quietDays: number;
  affectedEvents: number | null; valueExposure: number | null; advisoryId: string | null; latest: Anomaly;
  evidence: IncidentEvidence; historical: boolean;
}
export type Advisory = AdvisoryRaw & { otherChannels: { channel: string; n: number; n_dec: number }[]; incidentIds: string[] };

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const sevRank = (s: Severity) => SEV_RANK[s];
export const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 864e5).toISOString().slice(0, 10);
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
export const fmtUnit = (v: number | null, u: Unit) => (v === null ? na() : u === 'DZD' ? fmtDzd(v) : u === 'ratio' ? fmtPct(v, 1) : fmtInt(v));

function displayIndicator(e: Explanation) {
  const { observed, expected, interval } = e.observed_expected;
  return { observed, expected, lo: interval?.[0] ?? null, hi: interval?.[1] ?? null, unit: (e.indicator === 'median_ticket' ? 'DZD' : 'tx') as Unit };
}
/** The indicator's name in the operator's language ("transactions", "paiements refusés"). */
export const indicatorLabel = (indicator: string) => { const k = `ind.${indicator}` as Key; const s = tr(k); return s === k ? indicator : s; };

function businessSeverity(e: IncidentEvidence | undefined, t: AnomalyType): Severity {
  if (t === 'INTERRUPTION') return 'critical';
  if (e?.criticality === 'high') return 'high';
  if (e?.criticality === 'elevated') return 'medium';
  return 'low';
}

interface Model {
  snap: Snapshot; byMerchant: Map<string, MerchantDay[]>; anomalies: Anomaly[]; anomalyById: Map<string, Anomaly>;
  incidents: Incident[]; incidentById: Map<string, Incident>; advisories: Advisory[]; categories: string[]; channels: string[];
  watchlist: { merchant: string; date: string; score: number; signal: string }[];
}

let memo: { id: string; m: Model } | null = null;
const importedMemo = new Map<string, Model>();

/** The official run's model, or an imported run's when `run` is given (Data & runs → Import). */
export function model(run?: string | null): Model {
  const snap = snapshot(run);
  if (!run && memo?.id === snap.run.run_id) return memo.m;
  if (run && importedMemo.has(run)) return importedMemo.get(run)!;
  const byMerchant = new Map<string, MerchantDay[]>();
  for (const d of snap.merchant_days) byMerchant.set(d.merchant_id, [...(byMerchant.get(d.merchant_id) ?? []), d]);
  for (const days of byMerchant.values()) days.sort((a, b) => a.date.localeCompare(b.date));
  const asOf = snap.run.as_of;
  const evidenceById = new Map(snap.incidents.map((i) => [i.id, i]));
  const anomalies: Anomaly[] = [];
  for (const d of snap.merchant_days) {
    const e = d.explanation;
    if (!d.is_anomaly || d.anomaly_score === null || !e) continue;
    const type = typeOf(d);
    const advisoryId = snap.advisories.find((a) => a.date === d.date && a.symptom === e.symptom &&
      a.members.some((x) => x.merchant_id === d.merchant_id && x.affected))?.id ?? null;
    const signals = SIGNALS.flatMap((key) => {
      const score = (d as unknown as Record<string, number | undefined>)[key];
      return score === undefined ? [] : [{ key, get label() { return SIGNAL_LABEL[key]; }, score }];
    }).sort((a, b) => b.score - a.score);
    const evidence = e;
    // text fields are getters: the cached model stays language-neutral and each read is in the operator's language
    anomalies.push({
      id: d.merchant_id + '_' + d.date, merchant: d.merchant_id, category: d.category, date: d.date,
      type, severity: businessSeverity(evidenceById.get(e.incident_id), type), score: d.anomaly_score, signals,
      ...displayIndicator(e),
      get indicator() { return indicatorLabel(evidence.indicator); },
      get explanation() { return explanationText(evidence); },
      get reasons() {
        const out = [...evidence.limitations.map((x) => engineText(x)), tr('reason.support' as Key).replace('{days}', fmtInt(evidence.reference_support.eligible_days)).replace('{date}', evidence.reference_last_date)];
        if (evidence.signal_source === 'persistent_count') out.push(tr('reason.persistent' as Key).replace('{n}', fmtInt(evidence.count_cusum.minimum_streak)));
        return out;
      },
      get check() { return engineText(evidence.first_action); },
      get owner() { return engineText(evidence.responsible_role); },
      get steps() { return PLAYBOOK[type].steps; },
      incidentId: e.incident_id, advisoryId, holiday: d.holiday, holidayFactor: d.holiday_factor,
      historyDays: d.history_days, evidence: e,
    });
  }

  const grouped = new Map<string, Anomaly[]>();
  for (const a of anomalies) grouped.set(a.incidentId, [...(grouped.get(a.incidentId) ?? []), a]);
  const incidents: Incident[] = snap.incidents.flatMap((e) => {
    const alerts = grouped.get(e.id);
    if (!alerts?.length) return [];
    const first = alerts[0], last = alerts[alerts.length - 1];
    const peak = alerts.reduce((p, a) => a.score > p.score ? a : p);
    const lifecycle = e.recovery_status === 'active_incident' ? 'active' : e.recovery_status;
    return [{
      id: e.id, merchant: first.merchant, category: first.category, onset: e.start, end: e.last_alert,
      days: e.duration_days, anomalyIds: alerts.map((a) => a.id), type: peak.type,
      types: [...new Set(alerts.map((a) => a.type))],
      severity: alerts.reduce((severity, a) => sevRank(a.severity) < sevRank(severity) ? a.severity : severity, first.severity),
      peakScore: e.comparable_score, lifecycle, quietDays: e.recovery_quiet_days,
      affectedEvents: e.affected_transactions, valueExposure: e.potential_value,
      advisoryId: alerts.find((a) => a.advisoryId)?.advisoryId ?? null, latest: last,
      evidence: e, historical: e.last_alert <= snap.run.train_end,
    }];
  });

  const advisories: Advisory[] = snap.advisories.map((a) => {
    const ch: Record<string, [number, number]> = {};
    for (const d of snap.merchant_days) if (d.date === a.date) for (const [c, v] of Object.entries(d.channels)) ch[c] = [(ch[c]?.[0] ?? 0) + v[0], (ch[c]?.[1] ?? 0) + v[1]];
    return { ...a, otherChannels: Object.entries(ch).filter(([c]) => c !== a.channel).map(([channel, [n, n_dec]]) => ({ channel, n, n_dec })), incidentIds: incidents.filter((i) => i.advisoryId === a.id).map((i) => i.id) };
  });

  const watchlist = [...byMerchant.values()].map((days) => days[days.length - 1])
    .filter((d) => d.lifecycle?.phase === 'under_observation' && d.date === asOf)
    .map((d) => ({ merchant: d.merchant_id, date: d.date, score: d.anomaly_score ?? 0, get signal() { return SIGNAL_LABEL[`s_${d.main_signal}`] ?? d.main_signal; } }));

  const m: Model = {
    snap, byMerchant, anomalies, anomalyById: new Map(anomalies.map((a) => [a.id, a])), incidents, incidentById: new Map(incidents.map((i) => [i.id, i])),
    advisories, watchlist, categories: [...new Set(snap.merchant_days.map((d) => d.category))].sort(), channels: [...new Set(snap.transactions.channel)].sort(),
  };
  if (run) { if (importedMemo.size >= 4) importedMemo.delete(importedMemo.keys().next().value!); importedMemo.set(run, m); }
  else memo = { id: snap.run.run_id, m };
  return m;
}

/* ── network aggregates straight from the sanitized transactions (FR-17, FR-19) ── */
/** `channel` may list several channels separated by commas (overview multi-select). */
export interface Scope { from: string; to: string; merchant?: string; category?: string; channel?: string }
export const channelSet = (c?: string) => (c ? new Set(c.split(',').map((x) => x.trim()).filter(Boolean)) : null);
export interface DayAgg { date: string; events: number; accepted: number; acceptedValue: number; attemptedValue: number; missingAccepted: number; missingAttempted: number; declined: number; cancelled: number; refunded: number }

export function aggregate(s: Scope, run?: string | null) {
  const t = model(run).snap.transactions;
  const mIdx = s.merchant ? t.merchants.indexOf(s.merchant) : -1, chs = channelSet(s.channel);
  const days = new Map<string, DayAgg>();
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) days.set(d, { date: d, events: 0, accepted: 0, acceptedValue: 0, attemptedValue: 0, missingAccepted: 0, missingAttempted: 0, declined: 0, cancelled: 0, refunded: 0 });
  const byChannel = new Map<string, number>(), byCategory = new Map<string, number>(), byMerchant = new Map<string, DayAgg>();
  for (let i = 0; i < t.ts.length; i++) {
    const date = t.ts[i].slice(0, 10);
    const day = days.get(date);
    if (!day) continue;
    if ((s.merchant && t.merchant[i] !== mIdx) || (s.category && t.category[i] !== s.category) || (chs && !chs.has(t.channel[i]))) continue;
    const st = t.status[i], amt = t.amount[i];
    const mid = t.merchants[t.merchant[i]];
    const mm = byMerchant.get(mid) ?? { date: mid, events: 0, accepted: 0, acceptedValue: 0, attemptedValue: 0, missingAccepted: 0, missingAttempted: 0, declined: 0, cancelled: 0, refunded: 0 };
    for (const a of [day, mm]) {
      a.events++;
      if (st === 'Accepted') {
        a.accepted++;
        if (amt === null) a.missingAccepted++; else a.acceptedValue += amt;
      }
      if (st !== 'Refunded') {
        if (amt === null) a.missingAttempted++; else a.attemptedValue += amt;
      }
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
    totals: { events: sum('events'), accepted: sum('accepted'), acceptedValue: sum('missingAccepted') ? null : sum('acceptedValue'), attemptedValue: sum('missingAttempted') ? null : sum('attemptedValue'),
      knownAcceptedValue: sum('acceptedValue'), knownAttemptedValue: sum('attemptedValue'),
      missingAccepted: sum('missingAccepted'), missingAttempted: sum('missingAttempted'), declined: sum('declined'), cancelled: sum('cancelled'), refunded: sum('refunded') },
    byChannel: [...byChannel.entries()].sort((a, b) => b[1] - a[1]), byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    byMerchant: [...byMerchant.values()].sort((a, b) => b.events - a.events),
  };
}
