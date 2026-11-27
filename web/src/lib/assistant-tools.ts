// The assistant's app tools, beyond the 9 benchmarked ones in llm/contract/tools.json: incident
// detail, alerts, merchant comparison, what-if simulation, collective anomalies, engine quality,
// PDF reports and CSV exports. Each is read-only and returns engine figures: a JSON result for the
// model and the evidence links / table shown under the answer.
import { dailyBrief, fmtUnit, getMerchant, getOverview, listAnomalies, listIncidents, listTransactions, rankedIncidents } from './api';
import { healthScore, incidentHypotheses, listClusters, simulatorBaseline, weeklyBrief } from './insights';
import { addDays, model, PLAYBOOK, type AnomalyType, type Severity } from './model';
import { simulate, type Baseline } from './simulate';
import { fmtCompactDzd, fmtInt, fmtPct } from './format';
import { LIFECYCLE, REVIEW, SEVERITIES, TYPES } from './labels';
import { briefQuery, type BriefParams } from './pdf';
import type { Lang, Reply } from './assistant';

export type Display = Pick<Reply, 'evidence' | 'table' | 'scope' | 'intent' | 'report'>;
export type ToolOut = { result: unknown; display?: Display };
type Args = Record<string, unknown>;
type Ctx = { lang: Lang };

/* ── shared vocabulary ── */
export const CHANNEL_KEYS: Record<string, string> = { ecommerce: 'E-commerce (CIB / Edahabia)', pos: 'TPE / POS Terminal', mobile: 'Mobile App', nfc: 'Contactless / NFC', transfer: 'Bank Transfer / Virement' };
const PERIOD_ENUM = ['today', 'yesterday', 'this_week', 'last_week', 'last_30_days'];
const SYMPTOMS: Record<string, AnomalyType> = { interruption: 'INTERRUPTION', activity_drop: 'DROP_VOLUME', surge: 'ATYPICAL_SURGE', amount_spike: 'SPIKE_AMOUNT', decline_spike: 'SPIKE_DECLINED', network_declines: 'NETWORK_DECLINES', cancellation_spike: 'CANCEL_SPIKE' };
const MER = { type: 'string', pattern: '^MER-\\d{4}$', description: 'Merchant id, e.g. MER-1234.' };
const PERIOD = { type: 'string', enum: PERIOD_ENUM, description: 'Time window relative to the data date. Default this_week (last 7 days).' };
const CHANNEL = { type: 'string', enum: Object.keys(CHANNEL_KEYS), description: 'ecommerce = E-commerce CIB/Edahabia, pos = TPE/POS terminal, mobile = Mobile App, nfc = Contactless/NFC, transfer = Bank transfer.' };
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

function window(period: unknown): { from: string; to: string } {
  const asOf = model().snap.run.as_of;
  switch (period) {
    case 'today': return { from: asOf, to: asOf };
    case 'yesterday': return { from: addDays(asOf, -1), to: addDays(asOf, -1) };
    case 'last_week': return { from: addDays(asOf, -13), to: addDays(asOf, -7) };
    case 'last_30_days': return { from: addDays(asOf, -29), to: asOf };
    default: return { from: addDays(asOf, -6), to: asOf };
  }
}
const fr = (c: Ctx, en: string, f: string) => (c.lang === 'fr' ? f : en);
const run = () => model().snap.run;
const scopeLine = (c: Ctx, what: string, from?: string, to?: string) =>
  `${fr(c, 'Scope', 'Périmètre')}: ${what}${from ? ` · ${from}${to && to !== from ? ` – ${to}` : ''}` : ''} · ${fr(c, 'engine run', 'exécution moteur')} ${run().run_id}`;
const err = (error: string): ToolOut => ({ result: { error } });
const knownMerchant = (id: unknown) => typeof id === 'string' && /^MER-\d{4}$/.test(id.toUpperCase()) && model().byMerchant.has(id.toUpperCase());

/* ── tool definitions (sent to the model) ── */
export function appToolDefs() {
  const categories = model().categories;
  return [
    fn('incident_detail', 'Full detail of one incident: severity, state, review status and owner, period, exposure, priority, possible causes with the evidence for and against each, and the next steps. Give an incident id, or a merchant id for its latest incident.',
      { incident: { type: 'string', pattern: '^INC-\\d{4}-\\d{4}$', description: 'Incident id, e.g. INC-6434-1111.' }, merchant: MER }),
    fn('list_alerts', 'Flagged merchant-days (alerts) with symptom, severity, observed vs expected and score; filter by period, severity, symptom, merchant or channel.',
      { period: PERIOD, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, symptom: { type: 'string', enum: Object.keys(SYMPTOMS) }, merchant: MER, channel: CHANNEL }),
    fn('compare_merchants', 'Side-by-side comparison of 2 to 4 merchants over the last 7 days: transactions vs expected, declines, health score, open incidents and flagged days.',
      { merchants: { type: 'array', items: MER, minItems: 2, maxItems: 4 } }, ['merchants']),
    fn('simulate_disruption', 'What-if simulator: estimates the impact of a hypothetical outage or decline surge (transactions lost or extra declines, value at risk, merchants touched, merchants exposed to the hypothetical scenario). Uses each merchant\'s engine baseline; the disruption itself is an assumption.',
      { mode: { type: 'string', enum: ['outage', 'declines'] }, channel: CHANNEL, category: { type: 'string', enum: categories }, day_type: { type: 'string', enum: ['weekday', 'weekend'], description: 'weekend = Friday-Saturday. Default weekday.' },
        start_hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Default 10.' }, hours: { type: 'integer', minimum: 1, maximum: 24, description: 'Duration. Default 3.' }, decline_rate: { type: 'integer', minimum: 5, maximum: 100, description: 'Percent declined during a decline surge. Default 40.' } }, ['mode']),
    fn('collective_anomalies', 'Groups of merchants that moved together on the same day (network-level subset scan): declines or activity drops shared by several merchants, with relative risk and significance.',
      { period: { ...PERIOD, description: 'Default last_30_days.' } }),
    fn('engine_quality', 'How reliable the engine is: validation precision/recall on the labelled period, forecast backtest error and interval coverage, data cleaning counts, alert threshold and data freshness.', {}),
    fn('generate_report', 'Prepare a PDF report and return its key figures; the PDF download link is shown to the user under the answer. Types: alerts = the alerts (anomalies) of a period, optionally one severity, merchant or channel (use it for any request about a report on alerts or anomalies); daily = one day\'s operational brief; weekly = the week\'s management brief; merchant = one merchant\'s health brief (for a merchant\'s alerts use alerts with merchant).',
      { type: { type: 'string', enum: ['alerts', 'daily', 'weekly', 'merchant'] }, period: { ...PERIOD, description: 'Alerts report window. Default this_week.' }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Day (daily) or week end (weekly), YYYY-MM-DD. Default the data date.' }, merchant: MER, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, channel: CHANNEL }, ['type']),
    fn('day_detail', 'Everything about one day, for one merchant or for the whole network. Merchant: transactions vs expected and normal range, declines and cancellations vs expected, typical payment, channels, busiest hours, whether it was flagged and why. Network: totals vs expected, merchants flagged that day, advisories and collective anomalies. Use it for a selected chart bar, table row or alert that has a date.',
      { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD.' }, merchant: MER }, ['date']),
    fn('export_data', 'Prepare a CSV export of alerts, incidents or transactions (sanitized, no card data) for a scope. The download link is shown to the user under the answer.',
      { kind: { type: 'string', enum: ['alerts', 'incidents', 'transactions'] }, period: PERIOD, merchant: MER, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, channel: CHANNEL, status: { type: 'string', enum: ['accepted', 'declined', 'cancelled', 'refunded'], description: 'Transactions only.' } }, ['kind']),
  ];
}

/* ── executors ── */
function incidentDetail(a: Args, c: Ctx): ToolOut {
  const all = rankedIncidents();
  const wanted = typeof a.incident === 'string' ? a.incident.toUpperCase() : null;
  let inc = wanted ? all.find((i) => i.id === wanted) : undefined;
  if (!inc && a.merchant) {
    if (!knownMerchant(a.merchant)) return err(`${a.merchant} is not in this run.`);
    inc = all.filter((i) => i.merchant === String(a.merchant).toUpperCase()).sort((x, y) => Number(y.open) - Number(x.open) || y.onset.localeCompare(x.onset))[0];
    if (!inc) return err(`${a.merchant} has no incident in this run.`);
  }
  if (!inc) return err(a.incident ? `${a.incident} is not in this run.` : 'Give an incident id or a merchant id.');
  const steps = PLAYBOOK[inc.type].steps;
  const causes = incidentHypotheses(inc).slice(0, 4).map((h) => ({ title: h.title, evidence_for: h.for, evidence_against: h.against, would_confirm: h.missing }));
  return {
    result: {
      id: inc.id, merchant: inc.merchant, category: inc.category, symptom: TYPES[inc.type].label, severity: SEVERITIES[inc.severity].label,
      state: LIFECYCLE[inc.lifecycle], review_status: REVIEW[inc.review.status], owner: inc.review.owner ?? 'unassigned', onset: inc.onset, last_day: inc.end, days: inc.days,
      affected_transactions: inc.affectedEvents, estimated_exposure: fmtCompactDzd(inc.valueExposure), priority: inc.priority, queue_rank: inc.rank,
      latest_alert: inc.latest.explanation, possible_causes_not_confirmed: causes, next_steps: steps, check_owner: PLAYBOOK[inc.type].owner, network_advisory: inc.advisoryId,
    },
    display: {
      intent: 'incident_detail', scope: scopeLine(c, inc.id, inc.onset, inc.end),
      evidence: [{ label: inc.id, href: `/incidents/${inc.id}` }, { label: `${inc.merchant}`, href: `/merchants/${inc.merchant}` }, ...(inc.advisoryId ? [{ label: inc.advisoryId, href: `/intelligence/${inc.advisoryId}` }] : [])],
    },
  };
}

function alerts(a: Args, c: Ctx): ToolOut {
  if (a.merchant && !knownMerchant(a.merchant)) return err(`${a.merchant} is not in this run.`);
  const w = window(a.period);
  const f = { from: w.from, to: w.to, severity: a.severity as Severity | undefined, type: a.symptom ? SYMPTOMS[String(a.symptom)] : undefined, merchant: a.merchant ? String(a.merchant).toUpperCase() : undefined, channel: a.channel ? CHANNEL_KEYS[String(a.channel)] : undefined, sort: 'score' };
  const r = listAnomalies(f).all, top = r.slice(0, 8);
  const q = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && k !== 'sort') as [string, string][]).toString();
  return {
    result: { total: r.length, from: w.from, to: w.to, shown: top.length, alerts: top.map((x) => ({ merchant: x.merchant, date: x.date, symptom: TYPES[x.type].label, severity: x.severity, observed: fmtUnit(x.observed, x.unit), expected: x.expected === null ? null : fmtUnit(x.expected, x.unit), score: x.score.toFixed(1) })) },
    display: {
      intent: 'list_alerts', scope: scopeLine(c, `${r.length} ${fr(c, 'alerts', 'alertes')}`, w.from, w.to),
      table: top.length ? { head: [fr(c, 'Merchant', 'Commerçant'), fr(c, 'Day', 'Jour'), fr(c, 'Symptom', 'Symptôme'), fr(c, 'Severity', 'Gravité'), fr(c, 'Observed / expected', 'Observé / attendu'), 'Score'], rows: top.map((x) => [x.merchant, x.date, TYPES[x.type].label, x.severity, `${fmtUnit(x.observed, x.unit)} / ${x.expected === null ? '—' : fmtUnit(x.expected, x.unit)}`, x.score.toFixed(1)]) } : undefined,
      evidence: [{ label: fr(c, 'All matching alerts', 'Toutes les alertes'), href: `/alerts?${q}` }, ...top.slice(0, 3).map((x) => ({ label: `${x.merchant} · ${x.date}`, href: `/alerts/${x.id}` }))],
    },
  };
}

function compare(a: Args, c: Ctx): ToolOut {
  const ids = [...new Set((Array.isArray(a.merchants) ? a.merchants : []).map((x) => String(x).toUpperCase()))].slice(0, 4);
  if (ids.length < 2) return err('Give 2 to 4 merchant ids.');
  const missing = ids.filter((id) => !knownMerchant(id));
  if (missing.length) return err(`${missing.join(', ')} not in this run.`);
  const asOf = run().as_of, from = addDays(asOf, -6);
  const rows = ids.map((id) => {
    const ds = model().byMerchant.get(id)!.filter((d) => d.date >= from), m = getMerchant(id)!;
    const n = ds.reduce((s, d) => s + d.n, 0), dec = ds.reduce((s, d) => s + d.n_dec, 0), exp = Math.round(ds.reduce((s, d) => s + (d.expected_n_adj ?? 0), 0));
    return { merchant: id, category: m.category, transactions_7d: n, expected_7d: exp, declined_7d: dec, decline_rate_7d: n ? fmtPct(dec / n) : 'n/a', health_score: healthScore(id).score, open_incidents: m.incidents.filter((i) => i.open).map((i) => i.id), flagged_days_7d: ds.filter((d) => d.is_anomaly).length };
  });
  return {
    result: { from, to: asOf, merchants: rows },
    display: {
      intent: 'compare_merchants', scope: scopeLine(c, ids.join(', '), from, asOf),
      table: { head: [fr(c, 'Merchant', 'Commerçant'), fr(c, 'Tx / expected', 'Tx / attendu'), fr(c, 'Declines', 'Refus'), fr(c, 'Health', 'Santé'), fr(c, 'Open incidents', 'Incidents ouverts')], rows: rows.map((r) => [r.merchant, `${fmtInt(r.transactions_7d)} / ${fmtInt(r.expected_7d)}`, `${r.declined_7d} (${r.decline_rate_7d})`, r.health_score === null ? '—' : String(r.health_score), r.open_incidents.join(', ') || '—']) },
      evidence: ids.map((id) => ({ label: id, href: `/merchants/${id}` })),
    },
  };
}

let baseline: { id: string; b: Baseline } | null = null;
function simulateTool(a: Args, c: Ctx): ToolOut {
  const id = run().run_id;
  if (baseline?.id !== id) baseline = { id, b: simulatorBaseline() as Baseline };
  const base = baseline.b;
  const mode = a.mode === 'declines' ? 'declines' : 'outage';
  const channel = a.channel ? CHANNEL_KEYS[String(a.channel)] : mode === 'declines' ? base.channels[0] : '';
  if (channel && !base.channels.includes(channel)) return err(`No baseline for ${channel}.`);
  const category = typeof a.category === 'string' && base.categories.includes(a.category) ? a.category : '';
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const sc = { mode, channel, category, weekend: a.day_type === 'weekend' ? 1 : 0, start: clamp(a.start_hour, 0, 23, 10), hours: clamp(a.hours, 1, 24, 3), rate: clamp(a.decline_rate, 5, 100, 40) } as const;
  const r = simulate(base, sc);
  const end = Math.min(24, sc.start + sc.hours);
  return {
    result: {
      hypothetical: true, scenario: { mode, channel: channel || 'all channels', category: category || 'all categories', day: sc.weekend ? 'Friday-Saturday' : 'weekday', from_hour: `${sc.start}:00`, to_hour: `${end}:00`, ...(mode === 'declines' ? { declined_percent: sc.rate } : {}) },
      [mode === 'outage' ? 'transactions_lost_estimate' : 'extra_declines_estimate']: r.affected,
      value_at_risk_estimate: fmtCompactDzd(r.value), value_at_risk_estimate_dzd: r.value, merchants_touched: r.touched, merchants_in_scope: r.cohort,
      baseline: `each merchant's same-day-type median and hourly mix, ${base.from} to ${base.asOf}`,
    },
    display: { intent: 'simulate_disruption', scope: scopeLine(c, fr(c, 'what-if (hypothesis)', 'simulation (hypothèse)'), base.from, base.asOf), evidence: [{ label: fr(c, 'Open the simulator', 'Ouvrir le simulateur'), href: '/simulate' }] },
  };
}

function collective(a: Args, c: Ctx): ToolOut {
  const w = window(a.period ?? 'last_30_days'), cl = listClusters();
  if (!cl) return err('This run has no collective scan.');
  const rows = cl.clusters.filter((x) => x.date >= w.from && x.date <= w.to);
  return {
    result: { method: cl.method, from: w.from, to: w.to, groups: rows.map((x) => ({ date: x.date, kind: x.kind === 'declines' ? 'shared decline wave' : 'shared activity drop', channel: x.channel ?? 'all channels', merchants: x.members.length, observed: Math.round(x.observed), expected: Math.round(x.expected), relative_risk: x.relative_risk.toFixed(1), p_value: x.p_value.toFixed(3), advisory: x.advisory })) },
    display: { intent: 'collective_anomalies', scope: scopeLine(c, fr(c, 'collective scan', 'analyse collective'), w.from, w.to), evidence: [{ label: fr(c, 'Network intelligence', 'Intelligence réseau'), href: '/intelligence' }, ...rows.filter((x) => x.advisory).map((x) => ({ label: x.advisory!, href: `/intelligence/${x.advisory}` }))] },
  };
}

function quality(_: Args, c: Ctx): ToolOut {
  const r = run(), v = r.validation, bt = model().snap.forecast.backtest;
  return {
    result: {
      run: r.run_id, data_as_of: r.as_of, batch: r.batch_status, alert_threshold: r.policy.high, labelled_period_until: r.train_end,
      validation: { precision: fmtPct(v.precision), recall: fmtPct(v.recall), f1: fmtPct(v.f1), caught_days: v.tp, false_alert_days: v.fp, missed_days: v.fn, episodes_found: `${Math.round(v.episode_recall * v.true_episodes)} of ${v.true_episodes}` },
      forecast_backtest: { error_model: bt.mae_model, error_seasonal_naive: bt.mae_seasonal_naive, interval_coverage: fmtPct(bt.interval_coverage), nominal_coverage: fmtPct(bt.nominal_coverage), origins: bt.origins },
      cleaning: { rows_raw: r.cleaning.raw_rows, rows_clean: r.cleaning.retained_events, duplicates_removed: r.cleaning.exact_duplicate, negative_amounts_excluded: r.cleaning.negative_amount, missing_category: r.cleaning.missing_category, channels_unknown: r.cleaning.missing_channel },
    },
    display: { intent: 'engine_quality', scope: scopeLine(c, fr(c, 'engine validation', 'validation du moteur'), r.first_date, r.as_of), evidence: [{ label: fr(c, 'Data & runs', 'Données et exécutions'), href: '/data' }] },
  };
}

function report(a: Args, c: Ctx): ToolOut {
  const m = model(), r = m.snap.run;
  const type = a.type === 'weekly' || a.type === 'merchant' || a.type === 'alerts' ? a.type : 'daily';
  let p: BriefParams, result: Record<string, unknown>;
  if (type === 'alerts') {
    if (a.merchant && !knownMerchant(a.merchant)) return err(`${a.merchant} is not in this run.`);
    const w = window(a.period), merchant = a.merchant ? String(a.merchant).toUpperCase() : undefined;
    const severity = ['critical', 'high', 'medium', 'low'].includes(String(a.severity)) ? String(a.severity) : undefined, channel = a.channel ? CHANNEL_KEYS[String(a.channel)] : undefined;
    const rows = listAnomalies({ from: w.from, to: w.to, severity, merchant, channel, sort: 'score' }).all;
    p = { type, from: w.from, to: w.to, severity, merchant, channel };
    result = { title: `Alerts brief · ${w.from} to ${w.to}`, days: Math.round((Date.parse(w.to) - Date.parse(w.from)) / 864e5) + 1, alerts: rows.length, merchants: [...new Set(rows.map((x) => x.merchant))], critical: rows.filter((x) => x.severity === 'critical').length, high: rows.filter((x) => x.severity === 'high').length,
      strongest: rows.slice(0, 5).map((x) => `${x.merchant} ${x.date} ${TYPES[x.type].label} (${x.severity})`), filters: { severity: severity ?? 'all', merchant: merchant ?? 'all', channel: channel ?? 'all' } };
  } else if (type === 'merchant') {
    if (!knownMerchant(a.merchant)) return err(a.merchant ? `${a.merchant} is not in this run.` : 'A merchant report needs a merchant id.');
    const id = String(a.merchant).toUpperCase(), mm = getMerchant(id)!, hs = healthScore(id);
    p = { type, merchant: id };
    result = { title: `Merchant health brief · ${id}`, category: mm.category, health_score: hs.score, components: mm.health.map((h) => `${h.label}: ${h.level} (${h.detail})`), open_incidents: mm.incidents.filter((i) => i.open).map((i) => i.id) };
  } else {
    const date = typeof a.date === 'string' && a.date >= r.first_date && a.date <= r.as_of ? a.date : r.as_of;
    if (a.date && date !== a.date) return err(`Reports cover ${r.first_date} to ${r.as_of}.`);
    p = { type, date };
    if (type === 'daily') {
      const b = dailyBrief(date), k = b.overview.kpis;
      result = { title: `Daily operational brief · ${date}`, transactions: fmtInt(k.events.value), accepted_value: fmtCompactDzd(k.acceptedValue.value), decline_rate: k.declineRate.value === null ? 'n/a' : fmtPct(k.declineRate.value), flagged_merchant_days: b.anomalies.length, incidents_active: b.active.map((i) => i.id), incidents_opened: b.opened.length, advisories: b.advisories.map((x) => x.id) };
    } else {
      const b = weeklyBrief(date), k = b.overview.kpis;
      result = { title: `Weekly management brief · ${b.from} to ${b.to}`, transactions: fmtInt(k.events.value), accepted_value: fmtCompactDzd(k.acceptedValue.value), decline_rate: k.declineRate.value === null ? 'n/a' : fmtPct(k.declineRate.value), alerts: b.anomalies.length, incidents_opened: b.opened.length, incidents_active: b.active.length, incidents_resolved: b.resolvedInWeek.length, advisories: b.advisories.length, collective_groups: b.clusters.length, most_flagged: b.topMerchants.map(([id, n]) => `${id} (${n})`) };
    }
  }
  const q = briefQuery(p);
  return {
    result: { ...result, pdf: 'ready, linked under the answer' },
    display: { intent: 'generate_report', scope: scopeLine(c, String(result.title)), evidence: [{ label: fr(c, 'Download PDF', 'Télécharger le PDF'), href: `/api/v1/reports/pdf?${q}` }, { label: fr(c, 'Open the report', 'Ouvrir le rapport'), href: `/reports?${q}` }] },
  };
}

function exportData(a: Args, c: Ctx): ToolOut {
  if (a.merchant && !knownMerchant(a.merchant)) return err(`${a.merchant} is not in this run.`);
  const kind = a.kind === 'incidents' || a.kind === 'transactions' ? a.kind : 'alerts';
  const w = a.period ? window(a.period) : null, merchant = a.merchant ? String(a.merchant).toUpperCase() : undefined;
  const channel = a.channel ? CHANNEL_KEYS[String(a.channel)] : undefined, severity = a.severity as string | undefined;
  const status = kind === 'transactions' && ['accepted', 'declined', 'cancelled', 'refunded'].includes(String(a.status)) ? String(a.status)[0].toUpperCase() + String(a.status).slice(1) : undefined;
  const f: Record<string, string | undefined> = kind === 'incidents' ? { merchant, severity, scope: 'all' } : { from: w?.from, to: w?.to, merchant, channel, ...(kind === 'alerts' ? { severity } : { status }) };
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const rows = kind === 'incidents' ? listIncidents(f).length : kind === 'alerts' ? listAnomalies(f).total : listTransactions(f).total;
  return {
    result: { kind, rows, scope: { ...(w ?? {}), merchant: merchant ?? 'all', ...(channel ? { channel } : {}), ...(severity ? { severity } : {}), ...(status ? { status } : {}) }, csv: 'ready, linked under the answer', card_data: 'never included' },
    display: { intent: 'export_data', scope: scopeLine(c, `${kind} · ${rows} ${fr(c, 'rows', 'lignes')}`, w?.from, w?.to), evidence: [{ label: fr(c, 'Download CSV', 'Télécharger le CSV'), href: `/api/v1/export/${kind === 'alerts' ? 'anomalies' : kind}?${q}` }] },
  };
}

function dayDetail(a: Args, c: Ctx): ToolOut {
  const m = model(), r = m.snap.run, date = String(a.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < r.first_date || date > r.as_of) return err(`Days run from ${r.first_date} to ${r.as_of}.`);
  if (a.merchant) {
    if (!knownMerchant(a.merchant)) return err(`${a.merchant} is not in this run.`);
    const id = String(a.merchant).toUpperCase(), d = m.byMerchant.get(id)!.find((x) => x.date === date);
    if (!d) return err(`${id} has no data on ${date}.`);
    const an = m.anomalyById.get(`${id}_${date}`);
    const hours = d.hours.map((v, h) => [h, v] as const).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 3);
    return {
      result: {
        merchant: id, date, category: d.category, public_holiday: d.holiday, transactions: d.n, expected: d.expected_n_adj === null ? 'no reference yet' : Math.round(d.expected_n_adj), normal_range: d.expected_lo === null ? null : `${d.expected_lo}–${d.expected_hi}`,
        declined: d.n_dec, decline_rate: d.n ? fmtPct(d.n_dec / d.n) : 'n/a', expected_decline_rate: d.expected_dec_rate === null ? 'n/a' : fmtPct(d.expected_dec_rate),
        cancelled: d.n_can, typical_payment: d.ticket === null ? 'n/a' : fmtCompactDzd(d.ticket), expected_typical_payment: d.expected_ticket === null ? 'n/a' : fmtCompactDzd(d.expected_ticket), accepted_value: fmtCompactDzd(d.value),
        channels: Object.fromEntries(Object.entries(d.channels).map(([ch, [n, dec]]) => [ch, { transactions: n, declined: dec }])), busiest_hours: hours.map(([h, v]) => `${h}:00 (${v})`),
        anomaly_score: d.anomaly_score?.toFixed(4) ?? 'unscored', alert_threshold: r.policy.high, still_learning: d.warming_up,
        flagged: an ? { severity: an.severity, symptom: TYPES[an.type].label, explanation: an.explanation, incident: an.incidentId } : 'no',
      },
      display: { intent: 'day_detail', scope: scopeLine(c, id, date), evidence: [...(an ? [{ label: `${id} · ${date}`, href: `/alerts/${an.id}` }] : []), { label: id, href: `/merchants/${id}` }] },
    };
  }
  const ov = getOverview({ from: date, to: date }), k = ov.kpis, day = ov.trend[0];
  const flagged = m.anomalies.filter((x) => x.date === date);
  return {
    result: {
      network: true, date, public_holiday: ov.holiday ?? 'no', transactions: fmtInt(k.events.value), expected: day?.usual === undefined ? 'n/a' : fmtInt(Math.round(day.usual)), accepted_value: fmtCompactDzd(k.acceptedValue.value), decline_rate: k.declineRate.value === null ? 'n/a' : fmtPct(k.declineRate.value),
      merchants_flagged: flagged.map((x) => ({ merchant: x.merchant, symptom: TYPES[x.type].label, severity: x.severity, explanation: x.explanation })),
      network_advisories: m.advisories.filter((x) => x.date === date).map((x) => `${x.id} (${x.channel})`),
      collective_anomalies: (listClusters()?.clusters ?? []).filter((x) => x.date === date).map((x) => `${x.kind === 'declines' ? 'shared decline wave' : 'shared activity drop'} on ${x.channel ?? 'all channels'}, ${x.members.length} merchants`),
      channels: ov.channels.map((x) => ({ channel: x.label, transactions: x.value })),
    },
    display: { intent: 'day_detail', scope: scopeLine(c, fr(c, 'network', 'réseau'), date), evidence: [{ label: fr(c, 'That day on the overview', 'Ce jour sur la vue d’ensemble'), href: `/?from=${date}&to=${date}` }, ...flagged.slice(0, 3).map((x) => ({ label: `${x.merchant} · ${date}`, href: `/alerts/${x.id}` }))] },
  };
}

const RUN: Record<string, (a: Args, c: Ctx) => ToolOut> = {
  day_detail: dayDetail,
  incident_detail: incidentDetail, list_alerts: alerts, compare_merchants: compare, simulate_disruption: simulateTool,
  collective_anomalies: collective, engine_quality: quality, generate_report: report, export_data: exportData,
};
export const isAppTool = (name: string) => name in RUN;
export function runAppTool(name: string, args: Args, c: Ctx): ToolOut {
  try { return RUN[name](args, c); } catch (e) {
    console.warn(`[assistant] tool ${name} failed:`, e instanceof Error ? e.message : e);
    return err('The tool failed on this input.');
  }
}
