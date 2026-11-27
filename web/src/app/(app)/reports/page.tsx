import Image from 'next/image';
import { ImpactEvidence, symptomLabel } from '@/components/satim-evidence';
import { ReportsSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import { Download } from 'lucide-react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { dailyBrief, getIncident, getMerchant, getMeta, listAnomalies } from '@/lib/api';
import { fmtCompactDzd, fmtDate, fmtDay, fmtDelta, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { LIFECYCLE, REVIEW, SEVERITIES, TYPES, observedVsExpected } from '@/lib/labels';
import { addDays, model, PLAYBOOK } from '@/lib/model';
import { listReports } from '@/lib/custom-report';
import { currentUser } from '@/lib/session';
import { FileText } from 'lucide-react';
import { AutoPrint, FilterForm, PrintButton } from '@/components/client';
import { EmptyState, ExportLink, PageHeader, SeverityBadge, flat } from '@/components/ui';
import { DayBars, ForecastBars, PairBars } from '@/components/charts';
import { weeklyBrief } from '@/lib/insights';
import { GaugeCell } from '@/components/visuals';

export const metadata: Metadata = { title: 'Reports' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function ReportsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ReportsSkeleton />}><Reports searchParams={searchParams} /></Suspense>;
}

async function Reports({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const meta = getMeta();
  const type = p.type === 'merchant' ? 'merchant' : p.type === 'weekly' ? 'weekly' : p.type === 'alerts' ? 'alerts' : p.type === 'incident' ? 'incident' : 'daily';
  const date = p.date && p.date >= meta.firstDate && p.date <= meta.asOf ? p.date : meta.asOf;
  const merchant = p.merchant && meta.merchants.includes(p.merchant) ? p.merchant : meta.merchants[0];
  const al = alertScope(p);
  const incident = p.incident ? getIncident(p.incident) : null;
  const user = await currentUser();
  const mine = user ? listReports(user.id).slice(0, 8) : [];
  const pdf = `/api/v1/reports/pdf?${new URLSearchParams(type === 'merchant' ? { type, merchant } : type === 'alerts' ? { type, ...al.query } : type === 'incident' && incident ? { type, incident: incident.incident.id } : { type, date })}`;
  return (
    <>
      <AutoPrint />
      <div className="no-print"><PageHeader title="Reports"><a className="btn btn-secondary" href={pdf}><Download aria-hidden />Download PDF</a><PrintButton /></PageHeader></div>
      <div className="no-print">
        <FilterForm>
          <label className="field">Brief<select name="type" defaultValue={type}><option value="daily">Daily operational brief</option><option value="weekly">Weekly management brief</option><option value="merchant">Merchant health brief</option><option value="alerts">Alerts brief</option>{incident && <option value="incident">Incident brief</option>}</select></label>
          {type === 'incident' && incident ? <input type="hidden" name="incident" value={incident.incident.id} /> : type === 'alerts' ? <>
            <label className="field">From<input type="date" name="from" defaultValue={al.from} min={meta.firstDate} max={meta.asOf} /></label>
            <label className="field">To<input type="date" name="to" defaultValue={al.to} min={meta.firstDate} max={meta.asOf} /></label>
            <label className="field">Severity<select name="severity" defaultValue={al.severity ?? ''}><option value="">All severities</option>{(['critical', 'high', 'medium', 'low'] as const).map((v) => <option key={v} value={v}>{SEVERITIES[v].label}</option>)}</select></label>
            <label className="field">Merchant<select name="merchant" defaultValue={al.merchant ?? ''}><option value="">All merchants</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
          </> : type !== 'merchant'
            ? <label className="field">{type === 'weekly' ? 'Week ending' : 'Day'}<input type="date" name="date" defaultValue={date} min={meta.firstDate} max={meta.asOf} /></label>
            : <label className="field">Merchant<select name="merchant" defaultValue={merchant}>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>}
        </FilterForm>
      </div>
      {mine.length > 0 && (
        <section className="panel no-print prepared">
          <div className="panel-head"><div><h2>Prepared by the assistant</h2></div><span className="chip">{mine.length}</span></div>
          <div className="prepared-list">{mine.map((r) => (
            <Link key={r.id} href={`/reports/${r.id}`} className="prepared-item"><FileText aria-hidden /><span><b dir="auto">{r.spec.title}</b><small>{r.spec.sections.length} section{r.spec.sections.length > 1 ? 's' : ''} · {fmtDate(r.created.slice(0, 10))}</small></span></Link>
          ))}</div>
        </section>
      )}
      {type === 'daily' ? <Daily date={date} /> : type === 'weekly' ? <Weekly end={date} /> : type === 'alerts' ? <AlertsBrief {...al} /> : type === 'incident' ? (incident ? <IncidentBrief details={incident} /> : <EmptyState title="Incident unavailable" />) : <MerchantBrief id={merchant} />}
    </>
  );
}

/** Alerts brief scope from the query: a period (default the last 7 days), optional severity, merchant, channel. */
function alertScope(p: Record<string, string | undefined>) {
  const meta = getMeta(), ok = (d?: string) => !!d && d >= meta.firstDate && d <= meta.asOf;
  const to = ok(p.to) ? p.to! : meta.asOf, from = ok(p.from) && p.from! <= to ? p.from! : addDays(to, -6);
  const severity = p.severity && ['critical', 'high', 'medium', 'low'].includes(p.severity) ? p.severity : undefined;
  const merchant = p.merchant && meta.merchants.includes(p.merchant) ? p.merchant : undefined;
  const channel = p.channel && p.channel.split(',').every((c) => meta.channels.includes(c)) ? p.channel : undefined;
  const query = Object.fromEntries(Object.entries({ from, to, severity, merchant, channel }).filter(([, v]) => v)) as Record<string, string>;
  return { from, to, severity, merchant, channel, query };
}

function AlertsBrief({ from, to, severity, merchant, channel }: ReturnType<typeof alertScope>) {
  const rows = listAnomalies({ from, to, severity, merchant, channel, sort: 'score' }).all;
  const count = (s: string) => rows.filter((a) => a.severity === s).length;
  const merchants = new Set(rows.map((a) => a.merchant)), incidents = new Set(rows.map((a) => a.incidentId));
  const bySymptom = [...rows.reduce((m, a) => m.set(a.type, (m.get(a.type) ?? 0) + 1), new Map<keyof typeof TYPES, number>())].sort((a, b) => b[1] - a[1]);
  const scope = [severity ? `${SEVERITIES[severity as keyof typeof SEVERITIES].label} only` : 'All severities', merchant ?? 'all merchants', channel ? channel.split(',').join(' + ') : 'all channels'].join(' · ');
  return (
    <article className="panel report m-rise">
      <ReportHead title={`Alerts brief · ${fmtDay(from)} – ${fmtDate(to)}`} scope={scope} />
      <div className="report-kpis">
        <div><span>Alerts</span><b>{rows.length}</b><small>flagged merchant-days</small></div>
        <div><span>Merchants</span><b>{merchants.size}</b><small>with at least one alert</small></div>
        <div><span>Critical or high</span><b>{count('critical') + count('high')}</b><small>{count('critical')} critical · {count('high')} high</small></div>
        <div><span>Incidents</span><b>{incidents.size}</b><small>the alerts belong to</small></div>
      </div>
      {rows.length ? <>
        <h3>By symptom</h3>
        <div className="health-chips">{bySymptom.map(([t, n]) => <span key={t} className="hc hc-watch"><i aria-hidden />{TYPES[t].label}<small>{n} alert{n > 1 ? 's' : ''}</small></span>)}</div>
        <h3>Alerts, strongest first</h3>
        <table className="stats alerts-table">
          <thead><tr><th>Day</th><th>Merchant</th><th>Symptom</th><th>Severity</th><th>Observed vs expected</th><th className="r">Score</th><th>Incident</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}><td className="num nowrap">{fmtDay(a.date)}</td><td className="nowrap"><Link href={`/alerts/${a.id}`}>{a.merchant}</Link></td><td>{TYPES[a.type].label}</td><td>{SEVERITIES[a.severity].label}</td><td className="num">{observedVsExpected(a)}</td><td className="r num nowrap">{fmtNum(a.score, 1)}</td><td className="nowrap"><Link href={`/incidents/${a.incidentId}`}>{a.incidentId}</Link></td></tr>
          ))}</tbody>
        </table>
        <h3>What each alert means</h3>
        <ul className="report-notes">{rows.map((a) => <li key={a.id}><b>{a.merchant} · {fmtDay(a.date)}</b> {a.explanation} <span className="muted">Next check: {a.check}</span></li>)}</ul>
      </> : <EmptyState title="No alert in this scope" />}
      <RunEvidence from={from} to={to} merchant={merchant} />
      <p className="report-foot">Engine {getMeta().run.policy.version} · alert threshold {getMeta().run.policy.high} · causes not confirmed · no card data.</p>
      <div className="no-print row"><ExportLink kind="anomalies" params={Object.fromEntries(Object.entries({ from, to, severity, merchant, channel }).filter(([, v]) => v)) as Record<string, string>} label="These alerts (CSV)" /></div>
    </article>
  );
}

function ReportHead({ title, scope }: { title: string; scope: string }) {
  const meta = getMeta();
  return (
    <header className="report-head">
      <div><span className="report-brand"><Image src="/brand/satim-emblem.png" alt="" width={22} height={22} /><b>SATIM</b> · Anomaly Intelligence</span><h2>{title}</h2><p>{scope}</p></div>
      <dl><dt>Engine run</dt><dd>{meta.run.run_id} ({meta.run.policy.version})</dd><dt>Historical cutoff</dt><dd>{fmtDate(meta.asOf)} · batch {meta.run.batch_status} · {meta.run.parity.sealed ? 'sealed replay' : 'unsealed preview'}</dd></dl>
    </header>
  );
}

function IncidentBrief({ details }: { details: NonNullable<ReturnType<typeof getIncident>> }) {
  const { incident, anomalies, advisory } = details;
  return <article className="panel report">
    <ReportHead title={'Incident brief · ' + incident.id} scope={incident.merchant + ' · ' + incident.onset + ' to ' + incident.end} />
    <p>Model lifecycle {LIFECYCLE[incident.lifecycle]} · operator review {REVIEW[incident.review.status]}</p>
    <h3>Official Sequential Detection evidence</h3>
    <ul className="report-notes">{anomalies.map((a) => <li key={a.id}><b>{a.date}</b> {a.explanation} {a.check}</li>)}</ul>
    {advisory && <p>Collective Detection advisory · {advisory.channel} · {symptomLabel(advisory.symptom)}. The shared cause remains unverified.</p>}
    <ImpactEvidence record={incident.evidence} />
    <RunEvidence from={incident.onset} to={incident.end} merchant={incident.merchant} />
  </article>;
}

function RunEvidence({ from, to, merchant }: { from: string; to: string; merchant?: string }) {
  const s = model().snap;
  const candidates = s.hybrid?.rows.filter((r) => r.investigation_candidate && r.date >= from && r.date <= to
    && (!merchant || r.merchant_id === merchant)).length;
  const breaches = s.transactions.ts.reduce((count, ts, i) => {
    const day = ts.slice(0, 10);
    return count + Number(day >= from && day <= to && s.transactions.contactless_limit[i] &&
      (!merchant || s.transactions.merchants[s.transactions.merchant[i]] === merchant));
  }, 0);
  return <div className="report-foot">
    <p>Hybrid ML investigation candidates {candidates ?? 'unavailable'} · advisory ranking.</p>
    <p>Contactless limit evidence {breaches} retained events above 2,500 DZD. High breach prevalence reflects synthetic data generation.</p>
    <p>Archive batch coverage is assumed. Monetary comparisons require complete qualifying amounts.</p>
  </div>;
}

function Daily({ date }: { date: string }) {
  const b = dailyBrief(date), k = b.overview.kpis;
  return (
    <article className="panel report m-rise">
      <ReportHead title={`Daily operational brief · ${fmtDate(date)}`} scope={`Whole network · compared with ${b.overview.priorScope ? fmtDate(b.overview.priorScope.from) : 'no prior day'}`} />
      <div className="report-kpis">
        <div><span>Transactions</span><b>{fmtInt(k.events.value)}</b><small>{k.events.prior !== null ? `${fmtDelta(k.events.value, k.events.prior)} vs prior day` : 'N/A'}</small></div>
        <div><span>Accepted value</span><b>{fmtCompactDzd(k.acceptedValue.value)}</b><small>{k.acceptedValue.prior !== null && k.acceptedValue.value !== null ? `${fmtDelta(k.acceptedValue.value, k.acceptedValue.prior)} vs prior day` : 'N/A'}</small></div>
        <div><span>Decline rate</span><b>{k.declineRate.value === null ? 'N/A' : fmtPct(k.declineRate.value)}</b><small>{k.declineRate.prior !== null ? `prior day ${fmtPct(k.declineRate.prior)}` : 'N/A'}</small></div>
        <div><span>Flagged merchant-days</span><b>{b.anomalies.length}</b><small>{b.opened.length} incident(s) opened</small></div>
      </div>

      <h3>Incidents active on this day</h3>
      {b.active.length ? (
        <table className="stats">
          <thead><tr><th>Incident</th><th>Merchant</th><th>Symptom</th><th>Severity</th><th>State today</th><th>Review</th><th className="r">Exposure</th></tr></thead>
          <tbody>{b.active.map((i) => (
            <tr key={i.id}><td><Link href={`/incidents/${i.id}`}>{i.id}</Link></td><td>{i.merchant}</td><td>{TYPES[i.type].label}</td><td>{SEVERITIES[i.severity].label}</td><td>{LIFECYCLE[i.lifecycle]}</td><td>{REVIEW[i.review.status]}{i.review.owner ? ` · ${i.review.owner}` : ''}</td><td className="r">{fmtInt(i.affectedEvents)} tx · {fmtCompactDzd(i.valueExposure)}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="muted">No incident was active on this day.</p>}

      <h3>Flagged merchant-days</h3>
      {b.anomalies.length ? <div className="ref-rows">{b.anomalies.map((a) => (
        <div key={a.id} className="ref-row"><span className="ref-label">{a.merchant}<small>{TYPES[a.type].label}</small></span><span className="row"><SeverityBadge severity={a.severity} /><GaugeCell observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={a.explanation} /></span></div>
      ))}</div> : <p className="muted">None.</p>}

      {b.advisories.length > 0 && (<>
        <h3>Network advisories</h3>
        {b.advisories.map((a) => (
          <div key={a.id} className="report-adv"><span className="ref-label">{a.channel}<small>{a.members.filter((m) => m.affected).length} merchants corroborated · advisory only</small></span>
            <p>{fmtInt(a.observed)} observed vs {fmtNum(a.expected, 1)} expected · {symptomLabel(a.symptom)}</p></div>
        ))}
      </>)}

      <h3>Recommended follow-up</h3>
      {b.active.length ? <div className="ref-rows">{b.active.map((i) => (
        <div key={i.id} className="ref-row followup"><span className="ref-label">{i.id}<small>{PLAYBOOK[i.type].owner}</small></span>
          <ol className="step-chips">{PLAYBOOK[i.type].steps.map((st, n) => <li key={st}><span className="ns-n">{n + 1}</span>{st}</li>)}</ol></div>
      ))}</div> : <p className="muted">Nothing to follow up.</p>}

      <p className="report-foot">Engine {getMeta().run.policy.version} · causes not confirmed · exposure is an estimate, not a loss · no card data.</p>
      <div className="no-print row"><ExportLink kind="anomalies" params={{ from: date, to: date }} label="Alerts of the day (CSV)" /><ExportLink kind="incidents" params={{ scope: 'all' }} label="All incidents (CSV)" /></div>
      <RunEvidence from={date} to={date} />
    </article>
  );
}

function Weekly({ end }: { end: string }) {
  const b = weeklyBrief(end), k = b.overview.kpis;
  const d = (v: number | null, p: number | null) => (p !== null && v !== null ? `${fmtDelta(v, p)} vs prior week` : 'no prior week');
  return (
    <article className="panel report m-rise">
      <ReportHead title={`Weekly management brief · ${fmtDay(b.from)} – ${fmtDate(b.to)}`} scope="Whole network · compared with the previous 7 days" />
      <div className="report-kpis">
        <div><span>Transactions</span><b>{fmtInt(k.events.value)}</b><small>{d(k.events.value, k.events.prior)}</small></div>
        <div><span>Accepted value</span><b>{fmtCompactDzd(k.acceptedValue.value)}</b><small>{d(k.acceptedValue.value, k.acceptedValue.prior)}</small></div>
        <div><span>Decline rate</span><b>{k.declineRate.value === null ? 'N/A' : fmtPct(k.declineRate.value)}</b><small>{k.declineRate.prior !== null ? `prior week ${fmtPct(k.declineRate.prior)}` : 'no prior week'}</small></div>
        <div><span>Flagged merchant-days</span><b>{b.anomalies.length}</b><small>{b.opened.length} opened · {b.resolvedInWeek.length} resolved</small></div>
      </div>
      <h3>Activity against the expected level</h3>
      <PairBars points={b.overview.trend} height={240} label={`Daily transactions from ${b.from} to ${b.to} next to the expected level`} />
      <h3>Incidents during the week</h3>
      {b.active.length ? <div className="ref-rows">{b.active.map((i) => (
        <div key={i.id} className="ref-row"><span className="ref-label">{TYPES[i.type].label} · {i.merchant}<small>{i.id} · {fmtDay(i.onset)}{i.days > 1 ? ` → ${fmtDay(i.end)}` : ''} · {LIFECYCLE[i.lifecycle]} · {REVIEW[i.review.status]}</small></span>
          <span className="row"><SeverityBadge severity={i.severity} /><span className="muted num">{fmtInt(i.affectedEvents)} tx · {fmtCompactDzd(i.valueExposure)}</span></span></div>
      ))}</div> : <p className="muted">No incident during the week.</p>}
      {b.topMerchants.length > 0 && (<>
        <h3>Merchants flagged most often</h3>
        <div className="health-chips">{b.topMerchants.map(([id, n]) => <span key={id} className="hc hc-issue"><i aria-hidden />{id}<small>{n} flagged day{n > 1 ? 's' : ''}</small></span>)}</div>
      </>)}
      {b.advisories.length > 0 && <>
        <h3>Collective Detection warnings</h3>
        <ul className="report-notes">{b.advisories.map((a) => <li key={a.id}>{fmtDate(a.date)} · {a.channel} · {symptomLabel(a.symptom)} · {fmtInt(a.observed)} observed vs {fmtNum(a.expected, 1)} expected</li>)}</ul>
      </>}
      <RunEvidence from={b.from} to={b.to} />
      {b.forecast && (<>
        <h3>Next 7 days · advisory forecast</h3>
        <div style={{ maxWidth: 560 }}><ForecastBars points={b.forecast} height={180} /></div>
      </>)}
      <p className="report-foot">Engine {getMeta().run.policy.version} · causes not confirmed · exposure is an estimate, not a loss · no card data.</p>
      <div className="no-print row"><ExportLink kind="anomalies" params={{ from: b.from, to: b.to }} label="Alerts of the week (CSV)" /><ExportLink kind="incidents" params={{ scope: 'all' }} label="All incidents (CSV)" /></div>
    </article>
  );
}

function MerchantBrief({ id }: { id: string }) {
  const m = getMerchant(id);
  if (!m) return <EmptyState title="Unknown merchant" />;
  const recent = m.series.slice(-14);
  return (
    <article className="panel report m-rise">
      <ReportHead title={`Merchant health brief · ${m.id}`} scope={`${m.category} · observed since ${fmtDate(m.firstSeen)} (${m.daysObserved} days)`} />
      <div className="report-kpis">
        <div><span>Transactions / day</span><b>{fmtInt(m.kpis.avgDailyTx)}</b><small>average</small></div>
        <div><span>Accepted value / day</span><b>{fmtCompactDzd(m.kpis.avgDailyValue)}</b><small>average</small></div>
        <div><span>Decline rate</span><b>{fmtPct(m.kpis.rejectionRate)}</b><small>whole period</small></div>
        <div><span>Flagged days</span><b>{m.kpis.flagged}</b><small>{m.incidents.length} incident(s)</small></div>
      </div>
      <h3>Health · last 7 days</h3>
      <div className="health-chips">{m.health.map((h) => <span key={h.label} className={`hc hc-${h.level}`} title={h.detail}><i aria-hidden />{h.label}<small>{h.detail}</small></span>)}</div>
      <h3>Incidents</h3>
      {m.incidents.length ? <div className="ref-rows">{m.incidents.map((i) => (
        <div key={i.id} className="ref-row"><span className="ref-label">{TYPES[i.type].label}<small>{i.id} · {fmtDay(i.onset)}{i.days > 1 ? ` → ${fmtDay(i.end)}` : ''} · {LIFECYCLE[i.lifecycle]} · {REVIEW[i.review.status]}</small></span>
          <GaugeCell observed={i.latest.observed} expected={i.latest.expected} lo={i.latest.lo} hi={i.latest.hi} unit={i.latest.unit} severity={i.severity} label={observedVsExpected(i.latest)} /></div>
      ))}</div> : <p className="muted">No incident.</p>}
      <h3>Last 14 days</h3>
      <DayBars points={recent} width={900} height={220} label={`Transactions per day for ${m.id}, last 14 days, with the expected level`} />
      {m.forecast.length > 0 && (<>
        <h3>Next 7 days · advisory forecast</h3>
        <div style={{ maxWidth: 520 }}><ForecastBars points={m.forecast} height={180} /></div>
      </>)}
      <p className="report-foot">For coordination with the acquiring bank · causes not confirmed · no card data.</p>
      <div className="no-print row"><ExportLink kind="transactions" params={{ merchant: m.id }} /></div>
      <RunEvidence from={m.firstSeen} to={getMeta().asOf} merchant={m.id} />
    </article>
  );
}
