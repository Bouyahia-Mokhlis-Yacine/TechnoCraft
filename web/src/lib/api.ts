// Page-facing data contract. Everything is derived from the V2 engine snapshot (snapshot.ts) and
// the review ledger (reviews.ts); nothing here alters an official flag or score.
import type { Values } from './formula';
import { aggregate, addDays, channelSet, fmtUnit, model, sevRank, type Advisory, type Anomaly, type AnomalyType, type Incident, type Lifecycle, type Scope, type Severity } from './model';
import { caseState, readAll, type ReviewEvent, type ReviewStatus } from './reviews';
import type { ForecastPoint, MerchantDay } from './snapshot';

export type { Advisory, Anomaly, AnomalyType, Incident, Lifecycle, Severity, ReviewEvent, ReviewStatus, Scope };
export { fmtUnit };

export interface SeriesPoint { date: string; value: number; usual?: number; lo?: number; hi?: number; severity?: Severity; anomalyId?: string; holiday?: string; anomalies?: number }
export interface Compare { label: string; observed: number; usual: number }

const HOLIDAY_NAMES: Record<string, string> = { '11-01': 'Revolution Day' };
const holidayName = (iso: string) => (model().snap.run.holidays.includes(iso) ? HOLIDAY_NAMES[iso.slice(5)] ?? 'Public holiday' : undefined);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/* ── run + meta ─────────────────────────────────────────────────────── */
export function getMeta() {
  const m = model();
  return { run: m.snap.run, categories: m.categories, channels: m.channels, merchants: [...m.byMerchant.keys()].sort(), asOf: m.snap.run.as_of, firstDate: m.snap.run.first_date };
}
export const openIncidentCount = () => rankedIncidents().filter((i) => i.open).length;

export interface Ranked extends Incident {
  review: ReturnType<typeof caseState>; open: boolean; rank: number | null; priority: number;
}

export function rankedIncidents(): Ranked[] {
  const m = model(), events = readAll();
  const ranks = new Map(m.snap.priority_queue.map((i) => [i.id, i.rank]));
  const rows = m.incidents.map((i) => {
    const review = caseState(i.id, events);
    const open = !i.historical && i.lifecycle !== 'resolved' && review.status !== 'closed';
    return { ...i, review, open, rank: open ? ranks.get(i.id) ?? null : null,
      priority: Math.round(100 * i.evidence.priority_utility) };
  });
  return rows.sort((a, b) => Number(b.open) - Number(a.open) ||
    (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.end.localeCompare(a.end) || a.id.localeCompare(b.id));
}

export interface IncidentFilters { lifecycle?: string; status?: string; severity?: string; merchant?: string; scope?: string }
export function listIncidents(f: IncidentFilters) {
  return rankedIncidents().filter((i) =>
    (f.scope === 'all' || (!f.scope && i.open) || (f.scope === 'closed' && !i.open)) &&
    (!f.lifecycle || i.lifecycle === f.lifecycle) && (!f.status || i.review.status === f.status) &&
    (!f.severity || i.severity === f.severity) && (!f.merchant || i.merchant === f.merchant));
}

export function getIncident(id: string) {
  const m = model();
  const inc = rankedIncidents().find((i) => i.id === id);
  if (!inc) return null;
  const ds = m.byMerchant.get(inc.merchant)!;
  const from = addDays(inc.onset, -7), to = addDays(inc.end, 5);
  const timeline = ds.filter((d) => d.date >= from && d.date <= to).map((d) => ({
    date: d.date, value: d.n, usual: d.expected_n_adj ?? undefined, lo: d.expected_lo ?? undefined, hi: d.expected_hi ?? undefined,
    severity: m.anomalyById.get(`${inc.merchant}_${d.date}`)?.severity, anomalyId: d.is_anomaly ? `${inc.merchant}_${d.date}` : undefined,
    holiday: holidayName(d.date), score: d.anomaly_score, inIncident: d.date >= inc.onset && d.date <= inc.end,
  }));
  return { incident: inc, anomalies: inc.anomalyIds.map((a) => m.anomalyById.get(a)!), timeline, advisory: inc.advisoryId ? m.advisories.find((a) => a.id === inc.advisoryId) ?? null : null, policy: m.snap.run.policy };
}

/* ── overview (FR-17–20) ─────────────────────────────────────────────── */
export interface OverviewFilters { from?: string; to?: string; category?: string; channel?: string; merchant?: string }
export function getOverview(f: OverviewFilters) {
  const m = model(), asOf = m.snap.run.as_of;
  const first = m.snap.run.first_date;
  const to = f.to && f.to <= asOf && f.to >= first ? f.to : asOf;
  const from = f.from && f.from <= to ? (f.from < first ? first : f.from) : (addDays(to, -6) < first ? first : addDays(to, -6));
  const len = days(from, to) + 1;
  const scope: Scope = { from, to, category: f.category, channel: f.channel, merchant: f.merchant };
  const priorScope: Scope = { ...scope, from: addDays(from, -len), to: addDays(from, -1) };
  const cur = aggregate(scope), prev = priorScope.from >= m.snap.run.first_date ? aggregate(priorScope) : null;
  // the channel mix ignores the channel filter, so the pie can show what is selected among all channels
  const mixCur = f.channel ? aggregate({ ...scope, channel: undefined }) : cur;
  const mixPrev = f.channel && prev ? aggregate({ ...priorScope, channel: undefined }) : prev;
  const chs = channelSet(f.channel);
  const inScope = (mid: string, cat: string) => (!f.merchant || mid === f.merchant) && (!f.category || cat === f.category);
  const anomalies = m.anomalies.filter((a) => a.date >= from && a.date <= to && inScope(a.merchant, a.category));
  const incidents = rankedIncidents().filter((i) => inScope(i.merchant, i.category));
  const openInScope = incidents.filter((i) => i.open);
  const affected = new Set(anomalies.map((a) => a.merchant)).size;
  const priorAnomalies = prev ? m.anomalies.filter((a) => a.date >= priorScope.from && a.date <= priorScope.to && inScope(a.merchant, a.category)) : null;
  // the named measures KPI formulas are built from (lib/formula.ts), for the period, the prior period and each day
  // amounts: the known sum (the engine leaves missing amounts out); cards say when it is partial
  const base = (t: { events: number; accepted: number; declined: number; cancelled: number; refunded: number; acceptedValue: number | null; attemptedValue: number | null; knownAcceptedValue?: number; knownAttemptedValue?: number }) =>
    ({ transactions: t.events, accepted: t.accepted, declined: t.declined, cancelled: t.cancelled, refunded: t.refunded, accepted_value: t.knownAcceptedValue ?? t.acceptedValue, attempted_value: t.knownAttemptedValue ?? t.attemptedValue });
  const measures: { cur: Values; prior: Values | null; daily: Values[] } = {
    cur: { ...base(cur.totals), alerts: anomalies.length, merchants_flagged: affected, open_incidents: openInScope.length, critical_incidents: openInScope.filter((i) => i.severity === 'critical').length, days: len },
    // incidents are a state "now": no prior value and no daily history
    prior: prev && priorAnomalies ? { ...base(prev.totals), alerts: priorAnomalies.length, merchants_flagged: new Set(priorAnomalies.map((a) => a.merchant)).size, days: len } : null,
    daily: cur.days.map((d) => { const day = anomalies.filter((a) => a.date === d.date); return { ...base(d), alerts: day.length, merchants_flagged: new Set(day.map((a) => a.merchant)).size, days: 1 }; }),
  };
  const rateOf = (a: { declined: number; events: number } | undefined) => (a && a.events ? a.declined / a.events : null);
  // expected per day only without a channel filter: the engine's reference is per merchant, not per channel (FR-24)
  const expected = (date: string) => {
    if (f.channel) return undefined;
    const rows = m.snap.merchant_days.filter((d) => d.date === date && inScope(d.merchant_id, d.category));
    return rows.length && rows.every((d) => d.expected_n_adj !== null)
      ? rows.reduce((sum, d) => sum + (d.expected_n_adj ?? 0), 0) : undefined;
  };
  return {
    scope, priorScope: prev ? priorScope : null, holiday: holidayName(to),
    kpis: {
      events: { value: cur.totals.events, prior: prev?.totals.events ?? null },
      acceptedValue: { value: cur.totals.acceptedValue, prior: prev?.totals.acceptedValue ?? null,
        knownValue: cur.totals.knownAcceptedValue, missingEvents: cur.totals.missingAccepted },
      attemptedValue: { value: cur.totals.attemptedValue, prior: prev?.totals.attemptedValue ?? null,
        knownValue: cur.totals.knownAttemptedValue, missingEvents: cur.totals.missingAttempted },
      cancellationRate: { value: cur.totals.events ? cur.totals.cancelled / cur.totals.events : null,
        prior: prev?.totals.events ? prev.totals.cancelled / prev.totals.events : null },
      declineRate: { value: rateOf(cur.totals), prior: rateOf(prev?.totals) },
      affectedMerchants: { value: affected, prior: priorAnomalies ? new Set(priorAnomalies.map((a) => a.merchant)).size : null },
      openIncidents: { value: openInScope.length, critical: openInScope.filter((i) => i.severity === 'critical').length },
    },
    trend: cur.days.map((d): SeriesPoint => ({ date: d.date, value: d.events, usual: expected(d.date), anomalies: anomalies.filter((a) => a.date === d.date).length, holiday: holidayName(d.date) })),
    channels: cur.byChannel.map(([label, value]) => ({ label, value, prior: prev?.byChannel.find(([c]) => c === label)?.[1] ?? null })),
    channelMix: mixCur.byChannel.map(([label, value]) => ({ label, value, prior: mixPrev?.byChannel.find(([c]) => c === label)?.[1] ?? null, selected: !chs || chs.has(label) })),
    selectedChannels: chs ? [...chs] : [],
    categories: cur.byCategory.map(([label, value]) => ({ label, value })),
    queue: openInScope.slice(0, 6),
    severityMix: (['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => ({ severity: s, value: openInScope.filter((i) => i.severity === s).length })),
    advisories: m.advisories.filter((a) => a.date >= addDays(to, -13) && a.date <= to && (!chs || chs.has(a.channel))),
    mlCandidates: m.snap.hybrid?.rows.filter((r) => r.investigation_candidate && r.date >= addDays(to, -13) &&
      r.date <= to && (!f.merchant || r.merchant_id === f.merchant)).length ?? null,
    watchlist: m.watchlist.filter((w) => !f.merchant || w.merchant === f.merchant),
    forecast: f.merchant ? m.snap.forecast.merchants[f.merchant] ?? [] : f.category || f.channel ? null : m.snap.forecast.network,
    backtest: m.snap.forecast.backtest, forecastDetail: m.snap.forecast,
    measures,
  };
}

/* ── official anomalies (FR-26) ──────────────────────────────────────── */
export interface AlertFilters { severity?: string; type?: string; merchant?: string; category?: string; channel?: string; from?: string; to?: string; sort?: string; page?: number }
export function listAnomalies(f: AlertFilters) {
  const m = model();
  const day = (a: Anomaly) => m.byMerchant.get(a.merchant)!.find((d) => d.date === a.date)!;
  const chs = channelSet(f.channel);
  let rows = m.anomalies.filter((a) =>
    (!f.severity || a.severity === f.severity) && (!f.type || a.type === f.type) && (!f.merchant || a.merchant === f.merchant) &&
    (!f.category || a.category === f.category) && (!f.from || a.date >= f.from) && (!f.to || a.date <= f.to) && (!chs || [...chs].some((c) => (day(a).channels[c]?.[0] ?? 0) > 0)));
  rows = [...rows].sort(f.sort === 'score' ? (a, b) => b.score - a.score || b.date.localeCompare(a.date) : (a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  const pageSize = 25, page = Math.max(1, f.page ?? 1);
  return { total: rows.length, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize), all: rows };
}
export const anomalyIds = () => model().anomalies.map((a) => a.id);

export function getAnomaly(id: string) {
  const m = model();
  const a = m.anomalyById.get(id);
  if (!a) return null;
  const ds = m.byMerchant.get(a.merchant)!;
  const i = ds.findIndex((d) => d.date === a.date), d = ds[i];
  const prior = ds.slice(Math.max(0, i - m.snap.run.policy.window_days), i).filter((p) => !p.is_anomaly);
  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
  const pick = (x: MerchantDay): { value: number; usual?: number; lo?: number; hi?: number } => {
    const evidence = x.detectors[a.evidence.indicator];
    const observed = a.evidence.indicator === 'declines' ? x.n_dec :
      a.evidence.indicator === 'cancellations' ? x.n_can : a.unit === 'DZD' ? x.ticket : x.n;
    return { value: observed ?? 0, usual: evidence?.expected ?? undefined,
      lo: evidence?.interval?.[0], hi: evidence?.interval?.[1] };
  };
  const chans = [...new Set([...Object.keys(d.channels), ...prior.flatMap((p) => Object.keys(p.channels))])];
  const tot = prior.reduce((s, p) => s + p.n, 0) || 1;
  return {
    anomaly: a, day: d, incident: rankedIncidents().find((x) => x.id === a.incidentId) ?? null,
    advisory: a.advisoryId ? m.advisories.find((x) => x.id === a.advisoryId) ?? null : null,
    series: ds.slice(Math.max(0, i - 28), i + 8).filter((x) => a.unit !== 'DZD' || x.ticket !== null).map((x): SeriesPoint => ({ date: x.date, ...pick(x), severity: m.anomalyById.get(`${a.merchant}_${x.date}`)?.severity, anomalyId: x.is_anomaly ? `${a.merchant}_${x.date}` : undefined, holiday: holidayName(x.date) })),
    stats: [
      { label: 'Transactions', observed: d.n as number | null, usual: d.expected_n_adj, kind: 'int' as const, note: d.expected_lo !== null ? `normal range ${d.expected_lo}–${d.expected_hi}` : '' },
      { label: 'Rejection rate', observed: d.n ? d.n_dec / d.n : null, usual: d.expected_dec_rate, kind: 'pct' as const, note: `${d.n_dec} of ${d.n}` },
      { label: 'Cancellation rate', observed: d.n ? d.n_can / d.n : null, usual: d.expected_can_rate, kind: 'pct' as const, note: `${d.n_can} of ${d.n}` },
      { label: 'Typical payment', observed: d.ticket, usual: d.expected_ticket, kind: 'dzd' as const, note: `${d.n_acc} accepted` },
      { label: 'Accepted value', observed: d.value as number | null, usual: null, kind: 'dzd' as const, note: '' },
    ],
    channels: chans.map((c): Compare & { declined: number } => ({ label: c, observed: d.channels[c]?.[0] ?? 0, usual: med(prior.map((p) => p.channels[c]?.[0] ?? 0)), declined: d.channels[c]?.[1] ?? 0 })).filter((c) => c.observed || c.usual),
    hours: d.hours.map((v, h): Compare => ({ label: String(h).padStart(2, '0'), observed: v, usual: (prior.reduce((s, p) => s + p.hours[h], 0) / tot) * (d.expected_n_adj ?? 0) })),
    policy: m.snap.run.policy, runId: m.snap.run.run_id,
    hybrid: m.snap.hybrid?.rows.find((row) => row.merchant_id === a.merchant && row.date === a.date) ?? null,
  };
}

/* ── collective advisories (FR-31–35) ────────────────────────────────── */
export const listAdvisories = () => model().advisories;
export function getAdvisory(id: string) {
  const m = model(), a = m.advisories.find((x) => x.id === id);
  if (!a) return null;
  const otherRate = a.otherChannels.reduce((s, c) => s + c.n_dec, 0) / Math.max(1, a.otherChannels.reduce((s, c) => s + c.n, 0));
  const hypotheses = a.hypotheses.map((h) => ({ title: h.hypothesis, for: [h.support],
    against: [h.counterevidence], missing: [], next: h.check }));
  return { advisory: a, otherRate, hypotheses, incidents: rankedIncidents().filter((i) => a.incidentIds.includes(i.id)) };
}

/* ── merchants (FR-21–22, FR-43) ─────────────────────────────────────── */
export interface MerchantFilters { q?: string; category?: string; sort?: string }
export function listMerchants(f: MerchantFilters) {
  const m = model(), inc = rankedIncidents();
  const rows = [...m.byMerchant.entries()].map(([id, ds]) => {
    const last = ds[ds.length - 1];
    const ch: Record<string, number> = {};
    for (const d of ds) for (const [c, v] of Object.entries(d.channels)) ch[c] = (ch[c] ?? 0) + v[0];
    const top = Object.entries(ch).sort((a, b) => b[1] - a[1])[0];
    const total = ds.reduce((s, d) => s + d.n, 0);
    const open = inc.filter((i) => i.merchant === id && i.open);
    return {
      id, category: last.category, firstSeen: ds[0].date, isNew: ds[0].date > m.snap.run.train_end, learning: last.warming_up, latestDate: last.date,
      avgDaily: total / ds.length, avgValue: ds.some((d) => d.value === null) ? null : ds.reduce((sum, d) => sum + (d.value ?? 0), 0) / ds.length, declineRate: ds.reduce((s, d) => s + d.n_dec, 0) / Math.max(1, total),
      lastDay: last.n, lastExpected: last.expected_n_adj, topChannel: top ? `${top[0]} · ${Math.round((top[1] / Math.max(1, total)) * 100)} %` : '—',
      openIncidents: open.length, worst: open.map((i) => i.severity).sort((a, b) => sevRank(a) - sevRank(b))[0] ?? null,
      spark: ds.slice(-30).map((d) => d.n),
    };
  }).filter((r) => (!f.category || r.category === f.category) && (!f.q || `${r.id} ${r.category}`.toLowerCase().includes(f.q.toLowerCase())));
  rows.sort(f.sort === 'volume' ? (a, b) => b.avgDaily - a.avgDaily : f.sort === 'id' ? (a, b) => a.id.localeCompare(b.id)
    : f.sort === 'declines' ? (a, b) => b.declineRate - a.declineRate
    : (a, b) => (a.worst ? sevRank(a.worst) : 9) - (b.worst ? sevRank(b.worst) : 9) || b.openIncidents - a.openIncidents || a.id.localeCompare(b.id));
  return rows;
}

export type HealthLevel = 'ok' | 'watch' | 'issue' | 'unknown';
export function merchantHealth(id: string) {
  const m = model(), ds = m.byMerchant.get(id)!, asOf = m.snap.run.as_of;
  const week = ds.filter((d) => d.date > addDays(asOf, -7));
  const exp = week.reduce((s, d) => s + (d.expected_n_adj ?? 0), 0), obs = week.reduce((s, d) => s + d.n, 0);
  const dec = week.reduce((s, d) => s + d.n_dec, 0), can = week.reduce((s, d) => s + d.n_can, 0);
  const expDec = week.reduce((s, d) => s + (d.expected_dec_rate ?? 0) * d.n, 0), expCan = week.reduce((s, d) => s + (d.expected_can_rate ?? 0) * d.n, 0);
  const inc = rankedIncidents().filter((i) => i.merchant === id);
  const open = inc.filter((i) => i.open), recovering = inc.filter((i) => i.lifecycle === 'recovering');
  const level = (ok: boolean, issue: boolean): HealthLevel => (issue ? 'issue' : ok ? 'ok' : 'watch');
  const ratio = exp ? obs / exp : null;
  return [
    { label: 'Recent activity', level: ratio === null ? 'unknown' as HealthLevel : level(ratio >= 0.8 && ratio <= 1.5, ratio < 0.5 || ratio > 2), detail: ratio === null ? 'No reference yet' : `${obs} transactions in 7 days vs ${Math.round(exp)} expected` },
    { label: 'Rejections', level: obs ? level(dec <= expDec * 1.5 + 1, dec > expDec * 3 + 3) : 'unknown' as HealthLevel, detail: obs ? `${dec} declined of ${obs} (expected about ${Math.round(expDec)})` : 'No transactions' },
    { label: 'Cancellations', level: obs ? level(can <= expCan * 1.5 + 1, can > expCan * 3 + 3) : 'unknown' as HealthLevel, detail: obs ? `${can} cancelled (expected about ${Math.round(expCan)})` : 'No transactions' },
    { label: 'Open incidents', level: level(open.length === 0, open.some((i) => i.severity === 'critical' || i.severity === 'high')), detail: open.length ? open.map((i) => i.id).join(', ') : 'None' },
    { label: 'Recovery', level: level(recovering.length === 0, false), detail: recovering.length ? `${recovering.length} incident(s) recovering` : 'Nothing recovering' },
    { label: 'Data completeness', level: ds[ds.length - 1].warming_up ? 'watch' as HealthLevel : 'ok' as HealthLevel, detail: `${ds.length} days observed, ${ds[ds.length - 1].warming_up ? 'still building its reference' : 'full reference'}` },
  ];
}

export function getMerchant(id: string) {
  const m = model(), ds = m.byMerchant.get(id);
  if (!ds) return null;
  const t = m.snap.transactions, idx = t.merchants.indexOf(id);
  const channels: Record<string, number> = {}, statuses: Record<string, number> = {};
  for (let i = 0; i < t.ts.length; i++) if (t.merchant[i] === idx) { channels[t.channel[i]] = (channels[t.channel[i]] ?? 0) + 1; statuses[t.status[i]] = (statuses[t.status[i]] ?? 0) + 1; }
  const total = ds.reduce((s, d) => s + d.n, 0);
  return {
    id, category: ds[ds.length - 1].category, firstSeen: ds[0].date, isNew: ds[0].date > m.snap.run.train_end, learning: ds[ds.length - 1].warming_up, daysObserved: ds.length,
    kpis: { avgDailyTx: total / ds.length, avgDailyValue: ds.some((d) => d.value === null) ? null : ds.reduce((sum, d) => sum + (d.value ?? 0), 0) / ds.length, rejectionRate: ds.reduce((s, d) => s + d.n_dec, 0) / Math.max(1, total), flagged: ds.filter((d) => d.is_anomaly).length },
    series: ds.map((d): SeriesPoint => ({ date: d.date, value: d.n, usual: d.expected_n_adj ?? undefined, lo: d.expected_lo ?? undefined, hi: d.expected_hi ?? undefined, severity: m.anomalyById.get(`${id}_${d.date}`)?.severity, anomalyId: d.is_anomaly ? `${id}_${d.date}` : undefined, holiday: holidayName(d.date) })),
    channels: Object.entries(channels).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
    statuses: ['Accepted', 'Declined', 'Cancelled', 'Refunded'].map((label) => ({ label, value: statuses[label] ?? 0 })),
    incidents: rankedIncidents().filter((i) => i.merchant === id).sort((a, b) => b.onset.localeCompare(a.onset)),
    cold: ds.filter((d) => d.cold_start).map((d) => ({ date: d.date, n: d.n, ...d.cold_start! })),
    reference: ds[ds.length - 1], forecastDetail: m.snap.forecast, health: merchantHealth(id), forecast: m.snap.forecast.merchants[id] ?? ([] as ForecastPoint[]),
  };
}

/* ── transactions (FR-23, sanitized) ─────────────────────────────────── */
export interface TxFilters { merchant?: string; from?: string; to?: string; category?: string; channel?: string; status?: string; quality?: string; contactless?: string; sort?: string; page?: number }
export function listTransactions(f: TxFilters, pageSize = 50) {
  const t = model().snap.transactions;
  const mIdx = f.merchant ? t.merchants.indexOf(f.merchant) : -1, chs = channelSet(f.channel);
  const rows: { id: string; ts: string; merchant: string; category: string; channel: string; status: string; amount: number | null; flags: string[]; contactlessLimit: boolean }[] = [];
  for (let i = t.ts.length - 1; i >= 0; i--) {
    const date = t.ts[i].slice(0, 10);
    if ((f.merchant && t.merchant[i] !== mIdx) || (f.from && date < f.from) || (f.to && date > f.to) || (f.category && t.category[i] !== f.category) || (chs && !chs.has(t.channel[i])) || (f.status && t.status[i] !== f.status)) continue;
    if (f.quality && !t.quality[i].includes(f.quality)) continue;
    if (f.contactless === 'breach' && !t.contactless_limit[i]) continue;
    if (f.contactless === 'within' && (t.channel[i] !== 'Contactless / NFC' || t.amount[i] === null || t.contactless_limit[i])) continue;
    const flags = t.quality[i].map((flag) => flag.replaceAll('_', ' '));
    if (t.contactless_limit[i]) flags.push('contactless limit exceeded');
    rows.push({ id: t.source_row[i], ts: t.ts[i], merchant: t.merchants[t.merchant[i]], category: t.category[i],
      channel: t.channel[i], status: t.status[i], amount: t.amount[i], flags, contactlessLimit: t.contactless_limit[i] });
  }
  if (f.sort === 'amount_desc') rows.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
  else if (f.sort === 'amount_asc') rows.sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity));
  else if (f.sort === 'status') rows.sort((a, b) => a.status.localeCompare(b.status) || b.ts.localeCompare(a.ts));
  const page = Math.max(1, f.page ?? 1);
  const accepted = rows.filter((r) => r.status === 'Accepted');
  const value = accepted.some((r) => r.amount === null) ? null : accepted.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  return { total: rows.length, value, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize), all: rows };
}

/* ── reports (FR-48) ─────────────────────────────────────────────────── */
export function dailyBrief(date: string) {
  const m = model(), ov = getOverview({ from: date, to: date });
  const inc = rankedIncidents();
  return {
    date, run: m.snap.run, overview: ov,
    opened: inc.filter((i) => i.onset === date), active: inc.filter((i) => m.byMerchant.get(i.merchant)?.some((d) => d.date === date && d.lifecycle?.incident_id === i.id && ['active_incident', 'recovering'].includes(d.lifecycle.phase))),
    anomalies: m.anomalies.filter((a) => a.date === date), advisories: m.advisories.filter((a) => a.date === date),
  };
}
