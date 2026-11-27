// Reports the assistant composes on request: a title and an ordered list of sections the user asked
// for (KPIs, charts, alert tables, incidents, merchants, comparisons, forecast, signals, engine quality,
// a what-if simulation, or text the model wrote). Every section is filled from the engine snapshot
// when the report is rendered; only the spec is stored, in runs/reports/<id>.json, owned by the
// account. The report page /reports/<id> renders it and the PDF route prints that page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getIncident, getMerchant, getMeta, getOverview, listAnomalies, listIncidents, type SeriesPoint } from './api';
import { healthScore, incidentHypotheses, listClusters, simulatorBaseline } from './insights';
import { addDays, model, PLAYBOOK, type AnomalyType, type Severity } from './model';
import { simulate, type Baseline } from './simulate';
import { fmtCompactDzd, fmtDelta, fmtInt, fmtNum, fmtPct } from './format';
import { LIFECYCLE, REVIEW, SEVERITIES, TYPES, observedVsExpected } from './labels';
import { runsDir } from './snapshot';
import type { Role } from './session';

/* ── spec (what the model sends, what is stored) ─────────────────────── */
export const SECTION_KINDS = ['kpis', 'activity', 'channel_mix', 'alerts', 'incidents', 'incident', 'merchant', 'compare', 'top_declines', 'shortfall', 'forecast', 'network_signals', 'engine_quality', 'simulation', 'text'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];
export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'last_30_days', 'all'] as const;
export const CHANNEL_KEYS: Record<string, string> = { ecommerce: 'E-commerce (CIB / Edahabia)', pos: 'TPE / POS Terminal', mobile: 'Mobile App', nfc: 'Contactless / NFC', transfer: 'Bank Transfer / Virement' };
const SYMPTOMS: Record<string, AnomalyType> = { interruption: 'INTERRUPTION', activity_drop: 'DROP_VOLUME', surge: 'ATYPICAL_SURGE', amount_spike: 'SPIKE_AMOUNT', decline_spike: 'SPIKE_DECLINED', network_declines: 'NETWORK_DECLINES', cancellation_spike: 'CANCEL_SPIKE' };
const SEVS = ['critical', 'high', 'medium', 'low'];

export interface SectionSpec {
  kind: SectionKind; title?: string; note?: string;
  period?: string; from?: string; to?: string; merchant?: string; merchants?: string[]; channel?: string; category?: string;
  severity?: string; symptom?: string; incident?: string; status?: 'open' | 'all'; limit?: number; explain?: boolean;
  body?: string;                                                   // text sections
  mode?: 'outage' | 'declines'; day_type?: 'weekday' | 'weekend'; start_hour?: number; hours?: number; decline_rate?: number; // simulation
}
export interface ReportSpec { title: string; subtitle?: string; sections: SectionSpec[] }
/** `history` keeps earlier versions (oldest first); `version` = history.length + 1. */
export interface StoredReport { id: string; owner: Role; created: string; updated?: string; run_id: string; spec: ReportSpec; version?: number; history?: ReportSpec[] }

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);

/** Normalise a spec from the model; returns problems the model should fix instead of guessing. */
export function validateSpec(raw: unknown): { spec?: ReportSpec; errors: string[] } {
  const errors: string[] = [], o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const m = model(), merchants = m.byMerchant;
  const title = str(o.title, 120);
  if (!title) errors.push('title is required');
  const list = Array.isArray(o.sections) ? o.sections.slice(0, 12) : [];
  if (!list.length) errors.push('give at least one section');
  const sections: SectionSpec[] = [];
  list.forEach((x, i) => {
    const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const kind = SECTION_KINDS.includes(s.kind as SectionKind) ? (s.kind as SectionKind) : null;
    if (!kind) { errors.push(`section ${i + 1}: unknown kind ${String(s.kind)}`); return; }
    const mer = (v: unknown) => { const id = typeof v === 'string' ? v.toUpperCase() : ''; if (!merchants.has(id)) { errors.push(`section ${i + 1}: ${v || 'merchant'} is not in this run`); return undefined; } return id; };
    const sec: SectionSpec = { kind, title: str(s.title, 100), note: str(typeof s.note === 'string' ? s.note.replace(/\\n/g, ' ') : s.note, 400) };
    if (s.period !== undefined) sec.period = PERIODS.includes(s.period as (typeof PERIODS)[number]) ? String(s.period) : undefined;
    sec.from = date(s.from); sec.to = date(s.to);
    if (s.merchant) sec.merchant = mer(s.merchant);
    if (Array.isArray(s.merchants)) sec.merchants = s.merchants.slice(0, 6).map(mer).filter((v): v is string => !!v);
    if (s.channel) { sec.channel = CHANNEL_KEYS[String(s.channel)]; if (!sec.channel) errors.push(`section ${i + 1}: unknown channel ${String(s.channel)}`); }
    if (s.category) { sec.category = m.categories.find((c) => c.toLowerCase() === String(s.category).toLowerCase()); if (!sec.category) errors.push(`section ${i + 1}: unknown category ${String(s.category)}`); }
    if (s.severity) sec.severity = SEVS.includes(String(s.severity)) ? String(s.severity) : undefined;
    if (s.symptom) sec.symptom = SYMPTOMS[String(s.symptom)] ? String(s.symptom) : undefined;
    if (s.incident) {
      const id = String(s.incident).toUpperCase();
      if (m.incidentById.has(id)) sec.incident = id;
      else if (/^MER-\d{4}$/.test(id) && merchants.has(id)) sec.merchant = id;   // a merchant id: its latest incident
      else errors.push(`section ${i + 1}: ${s.incident} is not in this run`);
    }
    if (s.status) sec.status = s.status === 'all' ? 'all' : 'open';
    sec.limit = int(s.limit, 1, 50); sec.explain = s.explain === true;
    if (kind === 'text') sec.body = str(typeof s.body === 'string' ? s.body.replace(/\\n/g, '\n') : s.body, 3000); // a copied spec may arrive double-escaped   // may be empty: the model writes it once it has the figures
    if (kind === 'incident' && !sec.incident && !sec.merchant) errors.push(`section ${i + 1}: an incident section needs an incident id`);
    if (kind === 'merchant' && !sec.merchant) errors.push(`section ${i + 1}: a merchant section needs a merchant id`);
    if (kind === 'compare' && (sec.merchants?.length ?? 0) < 2) errors.push(`section ${i + 1}: compare needs 2 to 6 merchants`);
    if (kind === 'simulation') {
      sec.mode = s.mode === 'declines' ? 'declines' : 'outage'; sec.day_type = s.day_type === 'weekend' ? 'weekend' : 'weekday';
      sec.start_hour = int(s.start_hour, 0, 23) ?? 10; sec.hours = int(s.hours, 1, 24) ?? 3; sec.decline_rate = int(s.decline_rate, 5, 100) ?? 40;
    }
    sections.push(sec);
  });
  return errors.length ? { errors } : { spec: { title: title!, subtitle: str(o.subtitle, 200), sections }, errors };
}

/* ── storage ─────────────────────────────────────────────────────────── */
const dir = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'reports');
const ID = /^[a-f0-9]{16}$/;
const write = (r: StoredReport) => {
  fs.mkdirSync(dir(), { recursive: true });
  const f = path.join(/*turbopackIgnore: true*/ dir(), `${r.id}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(r));
  fs.renameSync(`${f}.tmp`, f);
  return r;
};
export function saveReport(owner: Role, spec: ReportSpec): StoredReport {
  const now = new Date().toISOString();
  return write({ id: crypto.randomBytes(8).toString('hex'), owner, created: now, updated: now, run_id: model().snap.run.run_id, spec, version: 1, history: [] });
}
/** A change the user asked for: the new spec becomes the current version, the old one is kept. */
export function updateReport(owner: Role, id: string, spec: ReportSpec): StoredReport | null {
  const r = getReport(owner, id);
  if (!r) return null;
  const history = [...(r.history ?? []), r.spec].slice(-30);
  return write({ ...r, spec, history, version: (r.version ?? 1) + 1, updated: new Date().toISOString(), run_id: model().snap.run.run_id });
}
/** Back to the previous version (the undone one is dropped). */
export function undoReport(owner: Role, id: string): StoredReport | null {
  const r = getReport(owner, id);
  if (!r || !r.history?.length) return null;
  const history = r.history.slice(0, -1);
  return write({ ...r, spec: r.history[r.history.length - 1], history, version: Math.max(1, (r.version ?? 1) - 1), updated: new Date().toISOString() });
}
/** The spec as it was at version `v` (the current one when v is missing or newer). */
export function specAt(r: StoredReport, v?: number): ReportSpec {
  const cur = r.version ?? 1;
  if (!v || v >= cur) return r.spec;
  return r.history?.[v - 1] ?? r.spec;
}
export function getReport(owner: Role, id: string | undefined): StoredReport | null {
  if (!id || !ID.test(id)) return null;
  try { const r = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir(), `${id}.json`), 'utf8')) as StoredReport; return r.owner === owner ? r : null; } catch { return null; }
}
export function listReports(owner: Role): StoredReport[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => getReport(owner, n.slice(0, -5))).filter((r): r is StoredReport => !!r).sort((a, b) => b.created.localeCompare(a.created));
}

/* ── building: fill each section from the engine ─────────────────────── */
function windowOf(s: SectionSpec, fallback = 'this_week') {
  const r = model().snap.run, asOf = r.as_of;
  if (s.from || s.to) { const to = s.to && s.to <= asOf ? s.to : asOf; const from = s.from && s.from >= r.first_date && s.from <= to ? s.from : addDays(to, -6); return { from, to }; }
  switch (s.period ?? fallback) {
    case 'today': return { from: asOf, to: asOf };
    case 'yesterday': return { from: addDays(asOf, -1), to: addDays(asOf, -1) };
    case 'last_week': return { from: addDays(asOf, -13), to: addDays(asOf, -7) };
    case 'last_30_days': return { from: addDays(asOf, -29), to: asOf };
    case 'all': return { from: r.first_date, to: asOf };
    default: return { from: addDays(asOf, -6), to: asOf };
  }
}
const scopeText = (w: { from: string; to: string }, s: SectionSpec) => [w.from === w.to ? w.from : `${w.from} to ${w.to}`, s.merchant, s.channel, s.category, s.severity && `${s.severity} only`].filter(Boolean).join(' · ');

export type Built =
  | { kind: 'kpis'; scope: string; cards: { label: string; value: string; note: string }[] }
  | { kind: 'activity'; scope: string; points: (SeriesPoint & { anomalies?: number })[]; tooLong: boolean; expected: boolean }
  | { kind: 'channel_mix'; scope: string; rows: { label: string; value: number; share: string; change: string | null }[] }
  | { kind: 'alerts'; scope: string; total: number; rows: { id: string; day: string; merchant: string; symptom: string; severity: Severity; vs: string; score: string; incident: string; explanation: string; check: string }[]; explain: boolean }
  | { kind: 'incidents'; scope: string; rows: { id: string; rank: number | null; priority: number; merchant: string; symptom: string; severity: Severity; state: string; review: string; period: string; exposure: string }[] }
  | { kind: 'incident'; id: string; head: Record<string, string | number>; causes: { title: string; for: string[]; against: string[]; missing: string[] }[]; steps: string[]; owner: string; timeline: SeriesPoint[] }
  | { kind: 'merchant'; id: string; category: string; score: number | null; kpis: { label: string; value: string }[]; health: { label: string; level: string; detail: string }[]; series: SeriesPoint[]; incidents: string[] }
  | { kind: 'compare'; scope: string; rows: { merchant: string; category: string; tx: number; expected: number; declined: number; rate: string; health: number | null; open: string }[] }
  | { kind: 'top_declines' | 'shortfall'; scope: string; rows: { merchant: string; category: string; observed: string; expected: string; gap: string }[] }
  | { kind: 'forecast'; scope: string; points: { date: string; expected: number; lo: number; hi: number }[]; backtest: string }
  | { kind: 'network_signals'; scope: string; advisories: { id: string; day: string; channel: string; rate: string; expected: string; merchants: number }[]; clusters: { day: string; kind: string; channel: string; merchants: number; observed: number; expected: number; rr: string; p: string }[] }
  | { kind: 'engine_quality'; rows: { label: string; value: string }[] }
  | { kind: 'simulation'; scenario: string; rows: { label: string; value: string }[] }
  | { kind: 'text'; body: string };
export type BuiltSection = Built & { title: string; note?: string };

const DEFAULT_TITLE: Record<SectionKind, string> = {
  kpis: 'Key figures', activity: 'Activity against the expected level', channel_mix: 'Channel mix', alerts: 'Alerts', incidents: 'Incidents', incident: 'Incident', merchant: 'Merchant health',
  compare: 'Merchant comparison', top_declines: 'Merchants with the most excess declines', shortfall: 'Merchants furthest below their expected activity', forecast: 'Next 7 days · advisory forecast',
  network_signals: 'Network-wide signals', engine_quality: 'Engine quality', simulation: 'What-if simulation (hypothesis)', text: '',
};

let baseCache: { id: string; b: Baseline } | null = null;

function buildOne(s: SectionSpec): Built {
  const m = model(), r = m.snap.run;
  switch (s.kind) {
    case 'kpis': {
      const w = windowOf(s), o = getOverview({ ...w, merchant: s.merchant, channel: s.channel, category: s.category }), k = o.kpis;
      const d = (v: number | null, p: number | null) => (p && v !== null ? `${fmtDelta(v, p)} vs previous period` : 'no previous period');
      return { kind: 'kpis', scope: scopeText(w, s), cards: [
        { label: 'Transactions', value: fmtInt(k.events.value), note: d(k.events.value, k.events.prior) },
        { label: 'Accepted value', value: fmtCompactDzd(k.acceptedValue.value), note: d(k.acceptedValue.value, k.acceptedValue.prior) },
        { label: 'Decline rate', value: k.declineRate.value === null ? 'n/a' : fmtPct(k.declineRate.value), note: k.declineRate.prior === null ? 'no previous period' : `previous period ${fmtPct(k.declineRate.prior)}` },
        { label: 'Merchants with alerts', value: String(k.affectedMerchants.value), note: `${k.openIncidents.value} open incident(s), ${k.openIncidents.critical} critical` },
      ] };
    }
    case 'activity': {
      const w = windowOf(s);
      if (s.merchant) {
        const mm = getMerchant(s.merchant)!;
        return { kind: 'activity', scope: scopeText(w, s), points: mm.series.filter((p) => p.date >= w.from && p.date <= w.to), tooLong: false, expected: true };
      }
      const o = getOverview({ ...w, channel: s.channel, category: s.category });
      return { kind: 'activity', scope: scopeText(w, s), points: o.trend, tooLong: o.trend.length > 31, expected: !s.channel };
    }
    case 'channel_mix': {
      const w = windowOf(s), o = getOverview({ ...w, merchant: s.merchant, category: s.category }), tot = o.channels.reduce((a, c) => a + c.value, 0) || 1;
      return { kind: 'channel_mix', scope: scopeText(w, s), rows: o.channels.map((c) => ({ label: c.label, value: c.value, share: fmtPct(c.value / tot, 0), change: c.prior ? fmtDelta(c.value, c.prior) : null })) };
    }
    case 'alerts': {
      const w = windowOf(s), all = listAnomalies({ ...w, severity: s.severity, merchant: s.merchant, channel: s.channel, category: s.category, type: s.symptom ? SYMPTOMS[s.symptom] : undefined, sort: 'score' }).all;
      return { kind: 'alerts', scope: scopeText(w, s), total: all.length, explain: !!s.explain, rows: all.slice(0, s.limit ?? 25).map((a) => ({ id: a.id, day: a.date, merchant: a.merchant, symptom: TYPES[a.type].label, severity: a.severity, vs: observedVsExpected(a), score: fmtNum(a.score, 1), incident: a.incidentId, explanation: a.explanation, check: a.check })) };
    }
    case 'incidents': {
      const rows = listIncidents({ scope: s.status === 'all' ? 'all' : undefined, severity: s.severity, merchant: s.merchant }).slice(0, s.limit ?? 20);
      return { kind: 'incidents', scope: [s.status === 'all' ? 'all incidents' : 'open incidents', s.merchant, s.severity].filter(Boolean).join(' · '), rows: rows.map((i) => ({ id: i.id, rank: i.rank, priority: i.priority, merchant: i.merchant, symptom: TYPES[i.type].label, severity: i.severity, state: LIFECYCLE[i.lifecycle], review: REVIEW[i.review.status], period: i.onset === i.end ? i.onset : `${i.onset} to ${i.end}`, exposure: `${fmtInt(i.affectedEvents)} tx · ${fmtCompactDzd(i.valueExposure)}` })) };
    }
    case 'incident': {
      const id = s.incident ?? m.incidents.filter((i) => i.merchant === s.merchant).sort((a, b) => b.onset.localeCompare(a.onset))[0]?.id;
      const d = id ? getIncident(id) : null;
      if (!d) return { kind: 'text', body: `No incident found for ${s.merchant ?? s.incident}.` };
      const i = d.incident;
      return { kind: 'incident', id: i.id, owner: PLAYBOOK[i.type].owner, steps: PLAYBOOK[i.type].steps, timeline: d.timeline,
        head: { Merchant: i.merchant, Symptom: TYPES[i.type].label, Severity: SEVERITIES[i.severity].label, State: LIFECYCLE[i.lifecycle], Review: `${REVIEW[i.review.status]}${i.review.owner ? ` · ${i.review.owner}` : ''}`, Period: i.onset === i.end ? i.onset : `${i.onset} to ${i.end}`, 'Affected transactions': fmtInt(i.affectedEvents), Exposure: fmtCompactDzd(i.valueExposure), Priority: i.priority },
        causes: incidentHypotheses(i).slice(0, 4).map((h) => ({ title: h.title, for: h.for, against: h.against, missing: h.missing })) };
    }
    case 'merchant': {
      const mm = getMerchant(s.merchant!)!, hs = healthScore(mm.id);
      return { kind: 'merchant', id: mm.id, category: mm.category, score: hs.score, series: mm.series.slice(-30), incidents: mm.incidents.filter((i) => i.open).map((i) => i.id),
        kpis: [{ label: 'Transactions / day', value: fmtNum(mm.kpis.avgDailyTx, 0) }, { label: 'Accepted value / day', value: fmtCompactDzd(mm.kpis.avgDailyValue) }, { label: 'Decline rate', value: fmtPct(mm.kpis.rejectionRate) }, { label: 'Flagged days', value: String(mm.kpis.flagged) }],
        health: mm.health.map((h) => ({ label: h.label, level: h.level, detail: h.detail })) };
    }
    case 'compare': {
      const w = windowOf(s);
      return { kind: 'compare', scope: scopeText(w, s), rows: (s.merchants ?? []).map((id) => {
        const ds = m.byMerchant.get(id)!.filter((d) => d.date >= w.from && d.date <= w.to), mm = getMerchant(id)!;
        const n = ds.reduce((a, d) => a + d.n, 0), dec = ds.reduce((a, d) => a + d.n_dec, 0);
        return { merchant: id, category: mm.category, tx: n, expected: Math.round(ds.reduce((a, d) => a + (d.expected_n_adj ?? 0), 0)), declined: dec, rate: n ? fmtPct(dec / n) : 'n/a', health: healthScore(id).score, open: mm.incidents.filter((i) => i.open).map((i) => i.id).join(', ') || '—' };
      }) };
    }
    case 'top_declines':
    case 'shortfall': {
      const w = windowOf(s);
      const rows = [...m.byMerchant.entries()].filter(([id, ds]) => (!s.category || ds[0].category === s.category) && (!s.merchant || id === s.merchant)).map(([id, ds]) => {
        const d = ds.filter((x) => x.date >= w.from && x.date <= w.to);
        const n = d.reduce((a, x) => a + x.n, 0), dec = d.reduce((a, x) => a + x.n_dec, 0), expDec = d.reduce((a, x) => a + (x.expected_dec_rate ?? 0) * x.n, 0), exp = d.reduce((a, x) => a + (x.expected_n_adj ?? 0), 0);
        return { id, category: ds[0].category, n, dec, expDec, exp };
      });
      const top = s.kind === 'top_declines'
        ? rows.filter((x) => x.n >= 10 && x.dec > x.expDec).sort((a, b) => (b.dec - b.expDec) - (a.dec - a.expDec)).slice(0, s.limit ?? 8).map((x) => ({ merchant: x.id, category: x.category, observed: `${x.dec} declined of ${x.n} (${fmtPct(x.dec / x.n)})`, expected: `about ${Math.round(x.expDec)}`, gap: `+${Math.round(x.dec - x.expDec)}` }))
        : rows.filter((x) => x.exp >= 5 && x.n < x.exp).sort((a, b) => (b.exp - b.n) / b.exp - (a.exp - a.n) / a.exp).slice(0, s.limit ?? 8).map((x) => ({ merchant: x.id, category: x.category, observed: `${fmtInt(x.n)} tx`, expected: `${fmtInt(Math.round(x.exp))} tx`, gap: `−${Math.round(((x.exp - x.n) / x.exp) * 100)} %` }));
      return { kind: s.kind, scope: scopeText(w, s), rows: top };
    }
    case 'forecast': {
      const pts = s.merchant ? m.snap.forecast.merchants[s.merchant] ?? [] : m.snap.forecast.network, bt = m.snap.forecast.backtest;
      return { kind: 'forecast', scope: s.merchant ?? 'whole network', points: pts, backtest: `Backtest error ${fmtNum(bt.mae_model, 0)} vs ${fmtNum(bt.mae_seasonal_naive, 0)} for a seasonal naive forecast · 80 % interval covered ${fmtPct(bt.interval_coverage, 0)} of days` };
    }
    case 'network_signals': {
      const w = windowOf(s, 'last_30_days'), cl = listClusters();
      return { kind: 'network_signals', scope: scopeText(w, s),
        advisories: m.advisories.filter((a) => a.date >= w.from && a.date <= w.to).map((a) => ({ id: a.id, day: a.date, channel: a.channel, rate: fmtPct(a.observed_rate), expected: fmtPct(a.expected_rate), merchants: a.members.filter((x) => x.affected).length })),
        clusters: (cl?.clusters ?? []).filter((c) => c.date >= w.from && c.date <= w.to).map((c) => ({ day: c.date, kind: c.kind === 'declines' ? 'Shared decline wave' : 'Shared activity drop', channel: c.channel ?? 'all channels', merchants: c.members.length, observed: Math.round(c.observed), expected: Math.round(c.expected), rr: fmtNum(c.relative_risk, 1), p: c.p_value.toFixed(3) })) };
    }
    case 'engine_quality': {
      const v = r.validation, bt = m.snap.forecast.backtest;
      return { kind: 'engine_quality', rows: [
        { label: 'Precision (labelled period)', value: fmtPct(v.precision) }, { label: 'Recall', value: fmtPct(v.recall) }, { label: 'Caught / false alerts / missed days', value: `${v.tp} / ${v.fp} / ${v.fn}` },
        { label: 'Episodes found', value: `${Math.round(v.episode_recall * v.true_episodes)} of ${v.true_episodes}` }, { label: 'Alert threshold', value: String(r.policy.high) },
        { label: 'Forecast error (model vs naive)', value: `${fmtNum(bt.mae_model, 1)} vs ${fmtNum(bt.mae_seasonal_naive, 1)}` }, { label: 'Rows cleaned', value: `${fmtInt(r.cleaning.raw_rows)} → ${fmtInt(r.cleaning.retained_events)}` },
        { label: 'Data as of', value: `${r.as_of} (${r.batch_status})` },
      ] };
    }
    case 'simulation': {
      if (baseCache?.id !== r.run_id) baseCache = { id: r.run_id, b: simulatorBaseline() as Baseline };
      const b = baseCache.b, channel = s.channel ?? (s.mode === 'declines' ? b.channels[0] : '');
      const sc = { mode: s.mode ?? 'outage', channel, category: s.category ?? '', weekend: s.day_type === 'weekend' ? 1 : 0, start: s.start_hour ?? 10, hours: s.hours ?? 3, rate: s.decline_rate ?? 40 } as const;
      const res = simulate(b, sc);
      return { kind: 'simulation',
        scenario: `${sc.mode === 'outage' ? 'Outage' : `Decline surge to ${sc.rate} %`} on ${channel || 'all channels'}${sc.category ? ` · ${sc.category}` : ''} · ${sc.weekend ? 'Friday–Saturday' : 'weekday'} · ${sc.start}:00 to ${Math.min(24, sc.start + sc.hours)}:00`,
        rows: [{ label: sc.mode === 'outage' ? 'Transactions lost (estimate)' : 'Extra declines (estimate)', value: fmtInt(res.affected) }, { label: 'Value at risk (estimate)', value: fmtCompactDzd(res.value) }, { label: 'Merchants touched', value: `${res.touched} of ${res.cohort}` }] };
    }
    case 'text': return { kind: 'text', body: s.body ?? '' };
  }
}

export function buildReport(spec: ReportSpec): BuiltSection[] {
  return spec.sections.map((s) => ({ ...buildOne(s), title: s.title ?? DEFAULT_TITLE[s.kind], note: s.note }));
}

/** Short figures per section, for the model to describe what it prepared. */
export function reportSummary(sections: BuiltSection[]) {
  return sections.map((s) => {
    switch (s.kind) {
      case 'kpis': return { section: s.title, scope: s.scope, figures: Object.fromEntries(s.cards.map((c) => [c.label, `${c.value} (${c.note})`])) };
      case 'alerts': return { section: s.title, scope: s.scope, alerts: s.total, shown: s.rows.length, strongest: s.rows.slice(0, 3).map((r) => `${r.merchant} ${r.day} ${r.symptom} (${r.severity})`) };
      case 'incidents': return { section: s.title, scope: s.scope, incidents: s.rows.length, top: s.rows.slice(0, 3).map((r) => `${r.id} ${r.merchant} ${r.severity} priority ${r.priority}`) };
      case 'incident': return { section: s.title, incident: s.id, ...s.head, most_supported_cause: s.causes[0]?.title };
      case 'merchant': return { section: s.title, merchant: s.id, health_score: s.score, issues: s.health.filter((h) => h.level !== 'ok').map((h) => `${h.label}: ${h.detail}`) };
      case 'compare': return { section: s.title, merchants: s.rows.map((r) => `${r.merchant}: ${r.tx} tx vs ${r.expected} expected, ${r.rate} declined, health ${r.health}`) };
      case 'top_declines': case 'shortfall': return { section: s.title, scope: s.scope, rows: s.rows.slice(0, 5).map((r) => `${r.merchant} ${r.observed} vs ${r.expected}`) };
      case 'channel_mix': return { section: s.title, scope: s.scope, channels: s.rows.map((r) => `${r.label} ${r.share}`) };
      case 'activity': return { section: s.title, scope: s.scope, days: s.points.length };
      case 'forecast': return { section: s.title, scope: s.scope, days: s.points.length };
      case 'network_signals': return { section: s.title, advisories: s.advisories.length, collective_anomalies: s.clusters.length };
      case 'engine_quality': return { section: s.title, ...Object.fromEntries(s.rows.map((r) => [r.label, r.value])) };
      case 'simulation': return { section: s.title, scenario: s.scenario, ...Object.fromEntries(s.rows.map((r) => [r.label, r.value])) };
      case 'text': return { section: s.title || 'text' };
    }
  });
}

export const reportMeta = () => { const meta = getMeta(); return { run: meta.run.run_id, version: meta.run.policy.version, asOf: meta.asOf, batch: meta.run.batch_status }; };

/* ── the tool the model calls ────────────────────────────────────────── */
export function composeToolDef() {
  const cats = model().categories;
  return { type: 'function' as const, function: {
    name: 'compose_report',
    description: 'Build a report (page + PDF, previewed under the answer) of exactly what the user asks for and return its key figures. To CHANGE an existing report, pass its report_id with the complete updated title and sections: keep every section the user did not ask to change, exactly as it was. Follow the user\'s instructions: include only the sections they ask for, in their order, with their filters, title and wording, in their language. Use it for any report request that describes content, covers several topics, or is not one of the standard briefs. Section kinds: kpis (key figures for a scope), activity (daily transactions vs expected, ≤31 days), channel_mix, alerts (table; explain=true adds one line per alert), incidents (open or all), incident (one incident in depth: causes, next steps, timeline), merchant (health, KPIs, last 30 days), compare (2–6 merchants), top_declines, shortfall (merchants furthest below expected), forecast, network_signals (advisories and collective anomalies), engine_quality, simulation (hypothetical outage or decline surge), text (your own summary, recommendations or commentary: only figures already returned by tools).',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'sections'], properties: {
      report_id: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'Only to modify an existing report.' },
      title: { type: 'string', description: 'Report title, in the user\'s language.' },
      subtitle: { type: 'string' },
      sections: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
        kind: { type: 'string', enum: [...SECTION_KINDS] }, title: { type: 'string', description: 'Section heading (optional; in the user\'s language).' }, note: { type: 'string', description: 'A short remark shown under the section.' },
        period: { type: 'string', enum: [...PERIODS] }, from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        merchant: { type: 'string', pattern: '^MER-\\d{4}$' }, merchants: { type: 'array', items: { type: 'string', pattern: '^MER-\\d{4}$' }, maxItems: 6 },
        channel: { type: 'string', enum: Object.keys(CHANNEL_KEYS) }, category: { type: 'string', enum: cats }, severity: { type: 'string', enum: SEVS },
        symptom: { type: 'string', enum: Object.keys(SYMPTOMS) }, incident: { type: 'string', pattern: '^INC-\\d{4}-\\d{4}$' }, status: { type: 'string', enum: ['open', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 }, explain: { type: 'boolean' }, body: { type: 'string', description: 'Text sections: the real text (paragraphs, or "- " bullets). Leave it empty to receive the report\'s figures first, then call again with the text written from them.' },
        mode: { type: 'string', enum: ['outage', 'declines'] }, day_type: { type: 'string', enum: ['weekday', 'weekend'] }, start_hour: { type: 'integer', minimum: 0, maximum: 23 }, hours: { type: 'integer', minimum: 1, maximum: 24 }, decline_rate: { type: 'integer', minimum: 5, maximum: 100 },
      } } },
    } },
  } };
}

/** Text sections still to write: no body, or a placeholder ("Recommendation 1", "…", "TBD"). */
export function unwrittenText(spec: ReportSpec): number[] {
  const placeholder = (b: string) => b.split('\n').map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean)
    .every((l) => /^(recommendations?|recommandations?|summary|résumé|resume|point|item|conclusion|note|text|texte|tbd|todo|à compléter|\.{3}|…)\s*\d*\s*[:.]?$/i.test(l) || l.length < 4);
  return spec.sections.flatMap((x, i) => (x.kind === 'text' && (!x.body || placeholder(x.body)) ? [i + 1] : []));
}
