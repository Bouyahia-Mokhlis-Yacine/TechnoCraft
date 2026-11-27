// What the user is looking at, for the assistant dock on every page: the page, its filters and the
// figures behind each panel and chart, under the panel names shown on screen. The model reads it
// through the page_context tool to interpret "this chart" or "this page"; `summary` is the
// deterministic description used when the model is not available. Engine data only, no card data.
import { dailyBrief, fmtUnit, getAdvisory, getAnomaly, getIncident, getMerchant, getMeta, getOverview, listAnomalies, listIncidents, listMerchants, listTransactions } from './api';
import { healthScore, incidentHypotheses, listClusters, weeklyBrief } from './insights';
import { addDays, model, PLAYBOOK } from './model';
import { fmtCompactDzd, fmtDay, fmtDelta, fmtInt, fmtNum, fmtPct } from './format';
import { LIFECYCLE, REVIEW, SEVERITIES, TYPES } from './labels';
import { buildReport, getReport, reportSummary } from './custom-report';
import type { Role } from './session';

export interface PageContext { title: string; path: string; panels: string[]; data: Record<string, unknown>; summary: string[]; link: { label: string; href: string } }

const delta = (v: number | null, prior: number | null) => (v === null || prior === null || !prior ? null : fmtDelta(v, prior));
const pct = (v: number | null) => (v === null ? 'n/a' : fmtPct(v));
const rate = (num: number, den: number) => (den ? fmtPct(num / den) : 'n/a');
const series = (pts: { date: string; value: number; usual?: number; lo?: number; hi?: number; anomalies?: number; severity?: string }[], unit: 'tx' | 'ratio' | 'DZD' = 'tx') =>
  pts.map((p) => ({ day: p.date, observed: fmtUnit(p.value, unit), ...(p.usual !== undefined ? { expected: fmtUnit(Math.round(p.usual * 100) / 100, unit) } : {}), ...(p.lo !== undefined ? { normal_range: `${p.lo}–${p.hi}` } : {}), ...(p.anomalies ? { flagged_merchant_days: p.anomalies } : {}), ...(p.severity ? { flagged: p.severity } : {}) }));
const unitWord = (c: { unit: string; signal: string }) => (c.unit === 'tx' ? 'transactions' : c.unit === 'DZD' ? 'DZD' : /cancel/i.test(c.signal) ? 'cancellations' : 'declines');
const forecast = (pts: { date: string; expected: number; lo: number; hi: number }[]) => pts.map((p) => ({ day: p.date, expected: Math.round(p.expected), interval_80: `${Math.round(p.lo)}–${Math.round(p.hi)}` }));

function overview(q: URLSearchParams): Omit<PageContext, 'path' | 'link'> {
  const f = Object.fromEntries(q.entries());
  const o = getOverview(f), k = o.kpis, tot = o.channels.reduce((s, c) => s + c.value, 0) || 1;
  const clusters = (listClusters()?.clusters ?? []).filter((c) => c.date >= addDays(o.scope.to, -13) && c.date <= o.scope.to).length;
  const scope = `${fmtDay(o.scope.from)} – ${fmtDay(o.scope.to)}${f.category ? ` · ${f.category}` : ''}${f.channel ? ` · ${f.channel}` : ''}${f.merchant ? ` · ${f.merchant}` : ''}`;
  return {
    title: 'Network overview',
    panels: ['KPI cards', 'Network activity', 'Signals', 'Channels', 'Open incidents', 'Next 7 days'],
    data: {
      scope: { from: o.scope.from, to: o.scope.to, category: f.category ?? 'all', channel: f.channel ?? 'all', merchant: f.merchant ?? 'all', compared_with: o.priorScope ? `${o.priorScope.from} to ${o.priorScope.to}` : 'no prior period' },
      kpi_cards: {
        transactions: { value: fmtInt(k.events.value), change: delta(k.events.value, k.events.prior) },
        accepted_value: { value: fmtCompactDzd(k.acceptedValue.value), change: delta(k.acceptedValue.value, k.acceptedValue.prior) },
        attempted_value: { value: fmtCompactDzd(k.attemptedValue.value), change: delta(k.attemptedValue.value, k.attemptedValue.prior) },
        decline_rate: { value: pct(k.declineRate.value), prior_period: pct(k.declineRate.prior) },
        merchants_with_alerts: { value: k.affectedMerchants.value, prior_period: k.affectedMerchants.prior },
        open_incidents: { value: k.openIncidents.value, critical: k.openIncidents.critical },
      },
      network_activity_chart: { reads: f.channel ? 'one bar per day: transactions on the selected channel (no expected level is drawn for a single channel, because the engine\'s reference is per merchant); a red badge counts flagged merchant-days' : 'one pair of bars per day: expected level (light) and actual transactions (dark); a red badge counts flagged merchant-days', days: o.trend.length > 31 ? 'more than 31 days selected: the page asks for a shorter period instead of drawing bars' : series(o.trend) },
      signals_last_14_days: { network_advisories: o.advisories.map((a) => a.id), collective_anomalies: clusters, on_watch_below_threshold: o.watchlist.slice(0, 6).map((w) => `${w.merchant} (${w.signal})`) },
      channels_pie: o.channels.map((c) => ({ channel: c.label, transactions: c.value, share: fmtPct(c.value / tot, 0), change: delta(c.value, c.prior) })),
      open_incidents_bubbles: o.severityMix.map((s) => ({ severity: SEVERITIES[s.severity].label, count: s.value })),
      next_7_days_forecast: o.forecast?.length ? { points: forecast(o.forecast), backtest_error: `${fmtNum(o.backtest.mae_model, 0)} vs ${fmtNum(o.backtest.mae_seasonal_naive, 0)} for a seasonal naive forecast`, note: 'advisory, never used to flag' } : 'not shown for this filter',
    },
    summary: [
      `Network overview, ${scope}: ${fmtInt(k.events.value)} transactions${delta(k.events.value, k.events.prior) ? ` (${delta(k.events.value, k.events.prior)} vs the previous period)` : ''}, ${fmtCompactDzd(k.acceptedValue.value)} accepted, decline rate ${pct(k.declineRate.value)}.`,
      `${k.affectedMerchants.value} merchant(s) with alerts and ${k.openIncidents.value} open incident(s), ${k.openIncidents.critical} critical. The Network activity chart puts each day's transactions next to the expected level; days with a red badge had flagged merchants.`,
      `Busiest channel: ${o.channels[0] ? `${o.channels[0].label} (${fmtPct(o.channels[0].value / tot, 0)} of transactions)` : 'none'}.`,
    ],
  };
}

function merchant(id: string): Omit<PageContext, 'path' | 'link'> | null {
  const m = getMerchant(id);
  if (!m) return null;
  const hs = healthScore(id), last = m.series.slice(-14), chTot = m.channels.reduce((s, c) => s + c.value, 0) || 1, stTot = m.statuses.reduce((s, c) => s + c.value, 0) || 1;
  return {
    title: `Merchant ${id} · ${m.category}`,
    panels: ['KPI cards', 'Transactions per day', 'Health', 'Incidents', 'Next 7 days', 'Channel mix', 'Status mix', ...(m.cold.length ? ['First days · category reference'] : [])],
    data: {
      merchant: id, category: m.category, first_seen: m.firstSeen, days_observed: m.daysObserved, still_learning: m.learning,
      kpi_cards: { transactions_per_day: fmtNum(m.kpis.avgDailyTx, 0), accepted_value_per_day: fmtCompactDzd(m.kpis.avgDailyValue), decline_rate: fmtPct(m.kpis.rejectionRate), flagged_days: m.kpis.flagged },
      transactions_per_day_chart: { reads: 'bars = transactions per day, dashed line = expected level; coloured bars are flagged days', last_14_days: series(last) },
      health: { score: hs.score, components: m.health.map((h) => ({ part: h.label, level: h.level, detail: h.detail })) },
      incidents: m.incidents.slice(0, 5).map((i) => ({ id: i.id, symptom: TYPES[i.type].label, severity: i.severity, state: LIFECYCLE[i.lifecycle], period: `${i.onset} to ${i.end}`, exposure: fmtCompactDzd(i.valueExposure) })),
      next_7_days_forecast: m.forecast.length ? forecast(m.forecast) : 'none',
      channel_mix: m.channels.map((c) => ({ channel: c.label, transactions: c.value, share: fmtPct(c.value / chTot, 0) })),
      status_mix: m.statuses.map((s) => ({ status: s.label, transactions: s.value, share: fmtPct(s.value / stTot, 0) })),
      ...(m.cold.length ? { first_days_category_reference: m.cold.map((c) => ({ day: c.date, observed: c.n, category_reference: Math.round(c.category_ref), would_alert: c.would_alert })) } : {}),
    },
    summary: [
      `${id} (${m.category}): about ${fmtNum(m.kpis.avgDailyTx, 0)} transactions and ${fmtCompactDzd(m.kpis.avgDailyValue)} accepted per day, decline rate ${fmtPct(m.kpis.rejectionRate)}, ${m.kpis.flagged} flagged day(s).`,
      `Health score ${hs.score ?? 'n/a'}: ${m.health.filter((h) => h.level !== 'ok').map((h) => `${h.label} (${h.detail})`).join('; ') || 'all components normal'}.`,
      `The Transactions per day chart compares each day with the expected level (dashed line); coloured bars are flagged days.`,
    ],
  };
}

function incident(id: string): Omit<PageContext, 'path' | 'link'> | null {
  const d = getIncident(id);
  if (!d) return null;
  const i = d.incident, f = i.factors;
  const causes = incidentHypotheses(i).slice(0, 4);
  return {
    title: `Incident ${i.id}`,
    panels: ['Summary card', 'Timeline', 'Why it ranks here', 'Possible causes', 'Flagged days', 'Evidence', 'Next check', 'Review'],
    data: {
      incident: { id: i.id, merchant: i.merchant, symptom: TYPES[i.type].label, severity: SEVERITIES[i.severity].label, state: LIFECYCLE[i.lifecycle], review: REVIEW[i.review.status], owner: i.review.owner ?? 'unassigned', onset: i.onset, last_day: i.end, days: i.days, affected_transactions: i.affectedEvents, exposure: fmtCompactDzd(i.valueExposure), priority: i.priority, queue_rank: i.rank },
      timeline_chart: { reads: 'transactions per day with the expected level and normal range; days inside the incident are highlighted', days: series(d.timeline) },
      why_it_ranks_here: { formula: 'priority = 40 % impact + 30 % urgency + 20 % evidence + 10 % actionability', impact: fmtPct(f.impact, 0), urgency: fmtPct(f.urgency, 0), evidence: fmtPct(f.evidence, 0), actionability: fmtPct(f.actionability, 0) },
      possible_causes_not_confirmed: causes.map((h) => ({ cause: h.title, for: h.for, against: h.against, would_confirm: h.missing })),
      flagged_days: d.anomalies.map((a) => ({ day: a.date, symptom: TYPES[a.type].label, severity: a.severity, score: fmtNum(a.score, 1), explanation: a.explanation })),
      next_check: { owner: PLAYBOOK[i.type].owner, steps: PLAYBOOK[i.type].steps },
      network_advisory: d.advisory?.id ?? null,
    },
    summary: [
      `${i.id}: ${TYPES[i.type].label.toLowerCase()} at ${i.merchant}, ${SEVERITIES[i.severity].label.toLowerCase()}, ${LIFECYCLE[i.lifecycle].toLowerCase()}, ${i.days} day(s) from ${fmtDay(i.onset)}; ${fmtInt(i.affectedEvents)} transactions and ${fmtCompactDzd(i.valueExposure)} estimated exposure.`,
      `Priority ${i.priority}/100 (impact ${fmtPct(f.impact, 0)}, urgency ${fmtPct(f.urgency, 0)}, evidence ${fmtPct(f.evidence, 0)}). Most supported possible cause, not confirmed: ${causes[0]?.title ?? 'none'}.`,
      `Next check (${PLAYBOOK[i.type].owner}): ${PLAYBOOK[i.type].steps.join(', ')}.`,
    ],
  };
}

function alert(id: string): Omit<PageContext, 'path' | 'link'> | null {
  const d = getAnomaly(id);
  if (!d) return null;
  const a = d.anomaly, cf = d.day.counterfactual ?? [];
  const peak = [...d.hours].sort((x, y) => Math.abs(y.observed - y.usual) - Math.abs(x.observed - x.usual)).slice(0, 4);
  return {
    title: `Alert ${a.merchant} · ${a.date}`,
    panels: ['Summary card', 'That day vs usual', 'Channels that day', 'Transactions per hour', 'What would have been normal', 'Evidence', 'Next check'],
    data: {
      alert: { merchant: a.merchant, day: a.date, symptom: TYPES[a.type].label, severity: SEVERITIES[a.severity].label, score: fmtNum(a.score, 1), alert_threshold: d.policy.high, explanation: a.explanation, incident: a.incidentId },
      that_day_vs_usual: d.stats.map((s) => ({ measure: s.label, observed: s.observed === null ? 'n/a' : s.kind === 'pct' ? fmtPct(s.observed) : s.kind === 'dzd' ? fmtCompactDzd(s.observed) : fmtInt(s.observed), usual: s.usual === null ? 'n/a' : s.kind === 'pct' ? fmtPct(s.usual) : s.kind === 'dzd' ? fmtCompactDzd(s.usual) : fmtNum(s.usual, 0), note: s.note })),
      channels_that_day: d.channels.map((c) => ({ channel: c.label, transactions: c.observed, usual: fmtNum(c.usual, 0), declined: c.declined })),
      transactions_per_hour_chart: { reads: 'bars per hour that day next to the usual hourly level', largest_gaps: peak.map((h) => ({ hour: `${h.label}:00`, observed: h.observed, usual: fmtNum(h.usual, 1) })) },
      what_would_have_been_normal: cf.length ? cf.map((c) => ({ signal: c.signal, no_alert_if: `${c.op === '>=' ? 'at least' : 'at most'} ${fmtNum(c.bound, 0)} ${unitWord(c)}${c.channel ? ` on ${c.channel}` : ''}`, observed: c.observed, scope: c.scope })) : 'not computed for this alert',
      evidence: a.reasons, next_check: { owner: a.owner, check: a.check, steps: a.steps },
    },
    summary: [
      `${a.merchant} on ${fmtDay(a.date)}: ${a.explanation} Severity ${SEVERITIES[a.severity].label.toLowerCase()}, score ${fmtNum(a.score, 1)} (alert threshold ${d.policy.high}).`,
      ...(cf[0] ? [`It would not have been flagged with ${cf[0].op === '>=' ? 'at least' : 'at most'} ${fmtNum(cf[0].bound, 0)} ${unitWord(cf[0])}${cf[0].channel ? ` on ${cf[0].channel}` : ''} (observed ${cf[0].observed}).`] : []),
      `Next check (${a.owner}): ${a.check}`,
    ],
  };
}

function advisory(id: string): Omit<PageContext, 'path' | 'link'> | null {
  const d = getAdvisory(id);
  if (!d) return null;
  const a = d.advisory, affected = a.members.filter((x) => x.affected);
  return {
    title: `Network advisory ${a.id}`,
    panels: ['Summary card', 'Merchants on the channel', 'Merchant × channel', 'Hypotheses', 'Linked incidents'],
    data: {
      advisory: { id: a.id, day: a.date, channel: a.channel, symptom: a.symptom, transactions: a.n, declined: a.n_dec, decline_rate: fmtPct(a.observed_rate), expected_rate: fmtPct(a.expected_rate), score: fmtNum(a.score, 1), threshold: a.threshold, other_channels_rate: fmtPct(d.otherRate) },
      merchants_on_the_channel: { total: a.members.length, affected: affected.length, flagged: a.members.filter((x) => x.flagged).length, top: [...a.members].sort((x, y) => y.n_dec - x.n_dec).slice(0, 8).map((x) => ({ merchant: x.merchant_id, transactions: x.n, declined: x.n_dec, affected: x.affected, flagged: x.flagged })) },
      hypotheses_not_confirmed: d.hypotheses.map((h) => ({ cause: h.title, for: h.for, against: h.against, missing: h.missing })),
      linked_incidents: d.incidents.map((i) => i.id),
    },
    summary: [
      `${a.id}: on ${fmtDay(a.date)}, ${a.channel} declined ${fmtPct(a.observed_rate)} of ${fmtInt(a.n)} transactions against ${fmtPct(a.expected_rate)} expected; other channels ${fmtPct(d.otherRate)}.`,
      `${affected.length} of ${a.members.length} merchants on the channel were affected, ${a.members.filter((x) => x.flagged).length} flagged. Leading hypothesis, not confirmed: ${d.hypotheses[0].title}.`,
    ],
  };
}

function lists(path: string, q: URLSearchParams): Omit<PageContext, 'path' | 'link'> | null {
  const f = Object.fromEntries(q.entries());
  if (path === '/incidents') {
    const r = listIncidents(f);
    return {
      title: 'Incidents', panels: ['Filters', 'Incident queue'],
      data: { filters: f, shown: r.length, queue: r.slice(0, 10).map((i) => ({ rank: i.rank, priority: i.priority, id: i.id, merchant: i.merchant, symptom: TYPES[i.type].label, severity: i.severity, state: LIFECYCLE[i.lifecycle], review: REVIEW[i.review.status], period: `${i.onset} to ${i.end}`, exposure: `${i.affectedEvents} tx · ${fmtCompactDzd(i.valueExposure)}` })), priority_formula: '40 % impact + 30 % urgency + 20 % evidence + 10 % actionability' },
      summary: [`${r.length} incident(s) in this view, ranked by priority (0–100).${r[0] ? ` Top: ${r[0].id} at ${r[0].merchant}, priority ${r[0].priority}, ${r[0].severity}.` : ''}`],
    };
  }
  if (path === '/alerts') {
    const r = listAnomalies(f);
    return {
      title: 'Alerts', panels: ['Filters', 'Alert table'],
      data: { filters: f, total: r.total, page: r.page, rows: r.rows.slice(0, 12).map((a) => ({ merchant: a.merchant, day: a.date, symptom: TYPES[a.type].label, severity: a.severity, observed: fmtUnit(a.observed, a.unit), expected: a.expected === null ? null : fmtUnit(a.expected, a.unit), score: fmtNum(a.score, 1) })) },
      summary: [`${r.total} alert(s) match these filters.${r.rows[0] ? ` Most recent: ${r.rows[0].merchant} on ${fmtDay(r.rows[0].date)} (${TYPES[r.rows[0].type].label.toLowerCase()}, ${r.rows[0].severity}).` : ''}`],
    };
  }
  if (path === '/merchants') {
    const r = listMerchants(f);
    return {
      title: 'Merchants', panels: ['Filters', 'Merchant table'],
      data: { filters: f, total: r.length, rows: r.slice(0, 12).map((m) => ({ merchant: m.id, category: m.category, health: healthScore(m.id).score, open_incidents: m.openIncidents, worst_severity: m.worst ?? 'none', decline_rate: fmtPct(m.declineRate) })) },
      summary: [`${r.length} merchant(s) in this view, sorted ${f.sort ?? 'by severity'}.${r[0] ? ` First: ${r[0].id} (${r[0].category}).` : ''}`],
    };
  }
  if (path === '/transactions') {
    const r = listTransactions(f), all = r.all, by = (s: string) => all.filter((t) => t.status === s).length;
    return {
      title: 'Transactions', panels: ['Filters', 'Transaction table'],
      data: { filters: f, total: r.total, accepted_value: fmtCompactDzd(r.value), statuses: { accepted: by('Accepted'), declined: by('Declined'), cancelled: by('Cancelled'), refunded: by('Refunded') }, decline_rate: rate(by('Declined'), all.length), card_data: 'never shown' },
      summary: [`${fmtInt(r.total)} transaction(s) match these filters, ${fmtCompactDzd(r.value)} accepted; ${by('Declined')} declined (${rate(by('Declined'), all.length)}). Card data is never shown.`],
    };
  }
  return null;
}

function intelligence(): Omit<PageContext, 'path' | 'link'> {
  const adv = model().advisories, cl = listClusters();
  return {
    title: 'Network intelligence', panels: ['Network advisories', 'Collective anomalies'],
    data: {
      network_advisories: adv.map((a) => ({ id: a.id, day: a.date, channel: a.channel, decline_rate: fmtPct(a.observed_rate), expected_rate: fmtPct(a.expected_rate), merchants_affected: a.members.filter((x) => x.affected).length })),
      collective_anomalies: cl ? { method: cl.method, groups: cl.clusters.map((c) => ({ day: c.date, kind: c.kind === 'declines' ? 'shared decline wave' : 'shared activity drop', channel: c.channel ?? 'all', merchants: c.members.length, observed: Math.round(c.observed), expected: Math.round(c.expected), relative_risk: fmtNum(c.relative_risk, 1), p_value: c.p_value.toFixed(3) })) } : 'not in this run',
    },
    summary: [`${adv.length} network advisor${adv.length === 1 ? 'y' : 'ies'} and ${cl?.clusters.length ?? 0} collective anomal${cl?.clusters.length === 1 ? 'y' : 'ies'} in this run. Advisories are channel-level decline waves; collective anomalies are groups of merchants that moved together on the same day.`],
  };
}

function reports(q: URLSearchParams): Omit<PageContext, 'path' | 'link'> {
  const meta = getMeta(), type = q.get('type') === 'weekly' ? 'weekly' : q.get('type') === 'merchant' ? 'merchant' : 'daily';
  const date = q.get('date') && q.get('date')! >= meta.firstDate && q.get('date')! <= meta.asOf ? q.get('date')! : meta.asOf;
  if (type === 'merchant') { const m = merchant(q.get('merchant') && meta.merchants.includes(q.get('merchant')!) ? q.get('merchant')! : meta.merchants[0])!; return { ...m, title: `Reports · merchant health brief · ${m.title}` }; }
  if (type === 'weekly') {
    const b = weeklyBrief(date), k = b.overview.kpis;
    return { title: `Reports · weekly management brief (${b.from} to ${b.to})`, panels: ['KPI cards', 'Activity against the expected level', 'Incidents during the week', 'Forecast'],
      data: { transactions: fmtInt(k.events.value), change: delta(k.events.value, k.events.prior), accepted_value: fmtCompactDzd(k.acceptedValue.value), decline_rate: pct(k.declineRate.value), prior_decline_rate: pct(k.declineRate.prior), alerts: b.anomalies.length, incidents_opened: b.opened.length, incidents_active: b.active.map((i) => i.id), resolved: b.resolvedInWeek.length, advisories: b.advisories.map((a) => a.id), activity_chart: series(b.overview.trend) },
      summary: [`Weekly brief ${fmtDay(b.from)} – ${fmtDay(b.to)}: ${fmtInt(k.events.value)} transactions, ${fmtCompactDzd(k.acceptedValue.value)} accepted, decline rate ${pct(k.declineRate.value)}; ${b.anomalies.length} alert(s), ${b.opened.length} incident(s) opened.`] };
  }
  const b = dailyBrief(date), k = b.overview.kpis;
  return { title: `Reports · daily operational brief (${date})`, panels: ['KPI cards', 'Incidents active on this day', 'Flagged merchant-days'],
    data: { transactions: fmtInt(k.events.value), change: delta(k.events.value, k.events.prior), accepted_value: fmtCompactDzd(k.acceptedValue.value), decline_rate: pct(k.declineRate.value), incidents_active: b.active.map((i) => ({ id: i.id, merchant: i.merchant, severity: i.severity })), flagged: b.anomalies.map((a) => ({ merchant: a.merchant, symptom: TYPES[a.type].label, severity: a.severity, explanation: a.explanation })) },
    summary: [`Daily brief for ${fmtDay(date)}: ${fmtInt(k.events.value)} transactions, ${fmtCompactDzd(k.acceptedValue.value)} accepted, decline rate ${pct(k.declineRate.value)}; ${b.anomalies.length} flagged merchant-day(s), ${b.active.length} incident(s) active.`] };
}

function data(): Omit<PageContext, 'path' | 'link'> {
  const r = model().snap.run, v = r.validation;
  return {
    title: 'Data & runs', panels: ['Current run', 'Cleaning', 'Validation', 'Calibration', 'Digests', 'Known limitations', 'Audit ledger'],
    data: {
      current_run: { run: r.run_id, as_of: r.as_of, batch: r.batch_status, engine: r.policy.version, alert_threshold: r.policy.high, window_days: r.policy.window_days },
      cleaning: r.cleaning,
      validation: { precision: fmtPct(v.precision), recall: fmtPct(v.recall), f1: fmtPct(v.f1), caught_days: v.tp, false_alert_days: v.fp, missed_days: v.fn, episodes: `${Math.round(v.episode_recall * v.true_episodes)} of ${v.true_episodes}`, labelled_until: r.train_end },
      calibration: (r.calibration ?? []).map((c) => ({ score_band: `${c.lo}–${c.hi}`, days: c.n, real_anomalies: c.positives, rate: c.rate === null ? 'n/a' : fmtPct(c.rate, 0) })),
    },
    summary: [`Run ${r.run_id}, data as of ${fmtDay(r.as_of)} (${r.batch_status}). On the labelled period the engine caught ${v.tp} anomaly days with ${v.fp} false alert(s) and missed ${v.fn}: precision ${fmtPct(v.precision)}, recall ${fmtPct(v.recall)}.`, `Cleaning: ${fmtInt(r.cleaning.rows_raw)} raw rows to ${fmtInt(r.cleaning.rows_clean)} clean rows (${r.cleaning.exact_duplicates_removed} duplicates removed).`],
  };
}

function simulator(): Omit<PageContext, 'path' | 'link'> {
  const r = model().snap.run;
  return {
    title: 'Simulator', panels: ['What if a disruption hits?', 'Review cost vs missed anomalies'],
    data: { note: 'the scenario the user set on this page is not visible to the assistant; to reproduce one, use the simulate_disruption tool with the same inputs', current_alert_threshold: r.policy.high, validation_outcomes_by_threshold: (r.value_curve ?? []).map((c) => ({ threshold: c.threshold, caught: c.tp, false_alerts: c.fp, missed: c.fn })) },
    summary: ['The Simulator estimates what a hypothetical outage or decline surge would cost and whether the engine would flag it, from each merchant\'s own baseline. The second panel compares review cost against missed anomalies for each alert threshold, using your own cost assumptions.'],
  };
}

function customReport(id: string, owner?: Role): Omit<PageContext, 'path' | 'link'> | null {
  const r = owner ? getReport(owner, id) : null;
  if (!r) return null;
  const built = buildReport(r.spec);
  return { title: `Report · ${r.spec.title}`, panels: built.map((x) => x.title || 'text'), data: { report: r.spec.title, subtitle: r.spec.subtitle, prepared: r.created.slice(0, 10), sections: reportSummary(built) }, summary: [`Report “${r.spec.title}” with ${built.length} section(s): ${built.map((x) => x.title || 'text').join(', ')}.`] };
}

/** The page at `path` (with its query string), or null when there is nothing to describe. */
export function describePage(path: string, search = '', owner?: Role): PageContext | null {
  const q = new URLSearchParams(search), parts = path.split('/').filter(Boolean);
  const href = `${path}${search ? `?${search}` : ''}`;
  let c: Omit<PageContext, 'path' | 'link'> | null = null;
  try {
    if (!parts.length) c = overview(q);
    else if (parts.length === 2 && parts[0] === 'merchants') c = merchant(parts[1]);
    else if (parts.length === 2 && parts[0] === 'incidents') c = incident(parts[1]);
    else if (parts.length === 2 && parts[0] === 'alerts') c = alert(decodeURIComponent(parts[1]));
    else if (parts.length === 2 && parts[0] === 'intelligence') c = advisory(parts[1]);
    else if (parts.length === 1 && parts[0] === 'intelligence') c = intelligence();
    else if (parts.length === 1 && parts[0] === 'reports') c = reports(q);
    else if (parts.length === 2 && parts[0] === 'reports') c = customReport(parts[1], owner);
    else if (parts.length === 1 && parts[0] === 'data') c = data();
    else if (parts.length === 1 && parts[0] === 'simulate') c = simulator();
    else if (parts.length === 1) c = lists(`/${parts[0]}`, q);
  } catch (e) {
    console.warn('[assistant] page context failed:', e instanceof Error ? e.message : e);
    return null;
  }
  return c ? { ...c, path: href, link: { label: c.title, href } } : null;
}

