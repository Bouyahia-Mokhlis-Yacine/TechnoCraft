import { DateRange } from '@/components/date-range';
import Image from 'next/image';
import { ImpactEvidence, symptomLabel } from '@/components/satim-evidence';
import { ReportsSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import { Download } from 'lucide-react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { dailyBrief, getIncident, getMerchant, getMeta, listAnomalies } from '@/lib/api';
import { fmtCompactDzd, fmtDate, fmtDay, fmtDelta, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { LIFECYCLE, REVIEW, SEVERITIES, TYPES, categoryLabel, channelLabel, observedVsExpected } from '@/lib/labels';
import { addDays, model, PLAYBOOK } from '@/lib/model';
import { listReports } from '@/lib/custom-report';
import { currentUser } from '@/lib/session';
import { FileText } from 'lucide-react';
import { AutoPrint, FilterForm, PrintButton } from '@/components/client';
import { EmptyState, ExportLink, PageHeader, SeverityBadge, flat } from '@/components/ui';
import { DayBars, ForecastBars, PairBars } from '@/components/charts';
import { weeklyBrief } from '@/lib/insights';
import { GaugeCell } from '@/components/visuals';
import { makeT } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { ViewBanner } from '@/components/dataset';
import { resolveView } from '@/lib/dataset';
import { connection } from 'next/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.reports') };
}
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function ReportsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ReportsSkeleton />}><Reports searchParams={searchParams} /></Suspense>;
}

async function Reports({ searchParams }: { searchParams: SP }) {
  await connection();
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);   // pins the run for every brief below
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
      <div className="no-print"><PageHeader title={t('nav.reports')}><a className="btn btn-secondary" href={pdf}><Download aria-hidden />{t('rep.pdf')}</a><PrintButton /></PageHeader></div>
      <div className="no-print"><ViewBanner view={view} path="/reports" /></div>
      <div className="no-print">
        <FilterForm>
          <label className="field">{t('rep.brief')}<select name="type" defaultValue={type}><option value="daily">{t('rep.daily')}</option><option value="weekly">{t('rep.weekly')}</option><option value="merchant">{t('rep.merchant')}</option><option value="alerts">{t('rep.alerts')}</option>{incident && <option value="incident">{t('incd.brief')}</option>}</select></label>
          {type === 'incident' && incident ? <input type="hidden" name="incident" value={incident.incident.id} /> : type === 'alerts' ? <>
            <DateRange from={al.from} to={al.to} min={meta.firstDate} max={meta.asOf} />
            <label className="field">{t('f.severity')}<select name="severity" defaultValue={al.severity ?? ''}><option value="">{t('rep.allSeverities')}</option>{(['critical', 'high', 'medium', 'low'] as const).map((v) => <option key={v} value={v}>{SEVERITIES[v].label}</option>)}</select></label>
            <label className="field">{t('f.merchant')}<select name="merchant" defaultValue={al.merchant ?? ''}><option value="">{t('f.allMerchants')}</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
          </> : type !== 'merchant'
            ? <label className="field">{type === 'weekly' ? t('rep.weekEnding') : t('al.day')}<input type="date" name="date" defaultValue={date} min={meta.firstDate} max={meta.asOf} /></label>
            : <label className="field">{t('f.merchant')}<select name="merchant" defaultValue={merchant}>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>}
        </FilterForm>
      </div>
      {mine.length > 0 && (
        <section className="panel no-print prepared">
          <div className="panel-head"><div><h2>{t('rep.prepared')}</h2></div><span className="chip">{mine.length}</span></div>
          <div className="prepared-list">{mine.map((r) => (
            <Link key={r.id} href={`/reports/${r.id}`} className="prepared-item"><FileText aria-hidden /><span><b dir="auto">{r.spec.title}</b><small>{t('rep.sections', { n: r.spec.sections.length })} · {fmtDate(r.created.slice(0, 10))}</small></span></Link>
          ))}</div>
        </section>
      )}
      {type === 'daily' ? <Daily date={date} /> : type === 'weekly' ? <Weekly end={date} /> : type === 'alerts' ? <AlertsBrief {...al} /> : type === 'incident' ? (incident ? <IncidentBrief details={incident} /> : <EmptyState title={t('rep.incidentUnavailable')} />) : <MerchantBrief id={merchant} />}
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
  const t = makeT();
  const rows = listAnomalies({ from, to, severity, merchant, channel, sort: 'score' }).all;
  const count = (s: string) => rows.filter((a) => a.severity === s).length;
  const merchants = new Set(rows.map((a) => a.merchant)), incidents = new Set(rows.map((a) => a.incidentId));
  const bySymptom = [...rows.reduce((m, a) => m.set(a.type, (m.get(a.type) ?? 0) + 1), new Map<keyof typeof TYPES, number>())].sort((a, b) => b[1] - a[1]);
  const scope = [severity ? t('rep.sevOnly', { sev: SEVERITIES[severity as keyof typeof SEVERITIES].label }) : t('rep.allSeverities'), merchant ?? t('f.allMerchants').toLowerCase(), channel ? channel.split(',').map((c) => channelLabel(c)).join(' + ') : t('f.allChannels').toLowerCase()].join(' · ');
  return (
    <article className="panel report m-rise">
      <ReportHead title={t('rep.alertsTitle', { from: fmtDay(from), to: fmtDate(to) })} scope={scope} />
      <div className="report-kpis">
        <div><span>{t('nav.alerts')}</span><b>{rows.length}</b><small>{t('rep.flaggedDaysLower')}</small></div>
        <div><span>{t('nav.merchants')}</span><b>{merchants.size}</b><small>{t('rep.withAlert')}</small></div>
        <div><span>{t('rep.critHigh')}</span><b>{count('critical') + count('high')}</b><small>{t('rep.critHighDetail', { c: count('critical'), h: count('high') })}</small></div>
        <div><span>{t('nav.incidents')}</span><b>{incidents.size}</b><small>{t('rep.belongTo')}</small></div>
      </div>
      {rows.length ? <>
        <h3>{t('rep.bySymptom')}</h3>
        <div className="health-chips">{bySymptom.map(([k, n]) => <span key={k} className="hc hc-watch"><i aria-hidden />{TYPES[k].label}<small>{t('imp.alertsN', { n })}</small></span>)}</div>
        <h3>{t('rep.strongest')}</h3>
        <table className="stats alerts-table">
          <thead><tr><th>{t('al.day')}</th><th>{t('f.merchant')}</th><th>{t('f.symptom')}</th><th>{t('f.severity')}</th><th>{t('al.obsExp')}</th><th className="r">{t('al.score')}</th><th>{t('inc.incident')}</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}><td className="num nowrap">{fmtDay(a.date)}</td><td className="nowrap"><Link href={`/alerts/${a.id}`}>{a.merchant}</Link></td><td>{TYPES[a.type].label}</td><td>{SEVERITIES[a.severity].label}</td><td className="num">{observedVsExpected(a)}</td><td className="r num nowrap">{fmtNum(a.score, 1)}</td><td className="nowrap"><Link href={`/incidents/${a.incidentId}`}>{a.incidentId}</Link></td></tr>
          ))}</tbody>
        </table>
        <h3>{t('rep.meaning')}</h3>
        <ul className="report-notes">{rows.map((a) => <li key={a.id}><b>{a.merchant} · {fmtDay(a.date)}</b> {a.explanation} <span className="muted">{t('rep.nextCheck', { check: a.check })}</span></li>)}</ul>
      </> : <EmptyState title={t('rep.noAlert')} />}
      <RunEvidence from={from} to={to} merchant={merchant} />
      <p className="report-foot">{t('rep.footAlerts', { engine: getMeta().run.policy.version, cutoff: fmtNum(getMeta().run.policy.high, 4) })}</p>
      <div className="no-print row"><ExportLink kind="anomalies" params={Object.fromEntries(Object.entries({ from, to, severity, merchant, channel }).filter(([, v]) => v)) as Record<string, string>} label={t('rep.theseCsv')} /></div>
    </article>
  );
}

/** Where a brief's figures come from: the official run, or the imported collections of the run shown. */
const datasetLabel = (run: { data_status?: string; selection?: { name: string }[] }, t: ReturnType<typeof makeT>) =>
  run.data_status === 'imported_batch' ? t('rep.datasetImported', { names: (run.selection ?? []).map((s) => s.name).join(', ') || '—' }) : t('ds.satimName');

function ReportHead({ title, scope }: { title: string; scope: string }) {
  const t = makeT();
  const meta = getMeta();
  return (
    <header className="report-head">
      <div><span className="report-brand"><Image src="/brand/satim-emblem.png" alt="" width={22} height={22} /><b>SATIM</b> · Anomaly Intelligence</span><h2>{title}</h2><p>{scope}</p></div>
      <dl><dt>{t('rep.dataset')}</dt><dd>{datasetLabel(meta.run, t)}</dd><dt>{t('rep.engineRun')}</dt><dd>{meta.run.run_id} ({meta.run.policy.version})</dd><dt>{t('rep.cutoff')}</dt><dd>{fmtDate(meta.asOf)} · {t('data.batch', { status: t(`batch.${meta.run.batch_status}` as 'batch.complete') }).toLowerCase()} · {meta.run.parity.sealed ? t('rep.sealed') : t('rep.unsealed')}</dd></dl>
    </header>
  );
}

function IncidentBrief({ details }: { details: NonNullable<ReturnType<typeof getIncident>> }) {
  const t = makeT();
  const { incident, anomalies, advisory } = details;
  return <article className="panel report">
    <ReportHead title={t('rep.incidentTitle', { id: incident.id })} scope={`${incident.merchant} · ${t('tx.fromTo', { from: fmtDate(incident.onset), to: fmtDate(incident.end) })}`} />
    <p>{t('rep.lifecycleReview', { life: LIFECYCLE[incident.lifecycle], review: REVIEW[incident.review.status] })}</p>
    <h3>{t('rep.officialEvidence')}</h3>
    <ul className="report-notes">{anomalies.map((a) => <li key={a.id}><b>{fmtDate(a.date)}</b> {a.explanation} {a.check}</li>)}</ul>
    {advisory && <p>{t('rep.advisoryLine', { channel: channelLabel(advisory.channel), symptom: symptomLabel(advisory.symptom) })}</p>}
    <ImpactEvidence record={incident.evidence} />
    <RunEvidence from={incident.onset} to={incident.end} merchant={incident.merchant} />
  </article>;
}

function RunEvidence({ from, to, merchant }: { from: string; to: string; merchant?: string }) {
  const t = makeT();
  const s = model().snap;
  const candidates = s.hybrid?.rows.filter((r) => r.investigation_candidate && r.date >= from && r.date <= to
    && (!merchant || r.merchant_id === merchant)).length;
  const breaches = s.transactions.ts.reduce((count, ts, i) => {
    const day = ts.slice(0, 10);
    return count + Number(day >= from && day <= to && s.transactions.contactless_limit[i] &&
      (!merchant || s.transactions.merchants[s.transactions.merchant[i]] === merchant));
  }, 0);
  return <div className="report-foot">
    <p>{t('rep.mlLine', { n: candidates ?? t('common.unavailable') })}</p>
    <p>{t('rep.contactlessLine', { n: breaches })}</p>
    <p>{t('rep.coverageLine')}</p>
  </div>;
}

function Daily({ date }: { date: string }) {
  const t = makeT();
  const b = dailyBrief(date), k = b.overview.kpis, NA = t('ov.na');
  return (
    <article className="panel report m-rise">
      <ReportHead title={t('rep.dailyTitle', { date: fmtDate(date) })} scope={b.overview.priorScope ? t('rep.dailyScope', { date: fmtDate(b.overview.priorScope.from) }) : t('rep.dailyScopeNone')} />
      <div className="report-kpis">
        <div><span>{t('ov.transactions')}</span><b>{fmtInt(k.events.value)}</b><small>{k.events.prior !== null ? t('rep.vsPriorDay', { d: fmtDelta(k.events.value, k.events.prior) }) : NA}</small></div>
        <div><span>{t('al.statValue')}</span><b>{fmtCompactDzd(k.acceptedValue.value)}</b><small>{k.acceptedValue.prior !== null && k.acceptedValue.value !== null ? t('rep.vsPriorDay', { d: fmtDelta(k.acceptedValue.value, k.acceptedValue.prior) }) : NA}</small></div>
        <div><span>{t('al.statRej')}</span><b>{k.declineRate.value === null ? NA : fmtPct(k.declineRate.value)}</b><small>{k.declineRate.prior !== null ? t('rep.priorDay', { v: fmtPct(k.declineRate.prior) }) : NA}</small></div>
        <div><span>{t('ov.flaggedDays')}</span><b>{b.anomalies.length}</b><small>{t('rep.opened', { n: b.opened.length })}</small></div>
      </div>

      <h3>{t('rep.activeDay')}</h3>
      {b.active.length ? (
        <table className="stats">
          <thead><tr><th>{t('inc.incident')}</th><th>{t('f.merchant')}</th><th>{t('f.symptom')}</th><th>{t('f.severity')}</th><th>{t('rep.stateToday')}</th><th>{t('f.review')}</th><th className="r">{t('inc.exposure')}</th></tr></thead>
          <tbody>{b.active.map((i) => (
            <tr key={i.id}><td><Link href={`/incidents/${i.id}`}>{i.id}</Link></td><td>{i.merchant}</td><td>{TYPES[i.type].label}</td><td>{SEVERITIES[i.severity].label}</td><td>{LIFECYCLE[i.lifecycle]}</td><td>{REVIEW[i.review.status]}{i.review.owner ? ` · ${i.review.owner}` : ''}</td><td className="r">{t('inc.exposureValue', { tx: fmtInt(i.affectedEvents), value: fmtCompactDzd(i.valueExposure) })}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="muted">{t('rep.noActive')}</p>}

      <h3>{t('ov.flaggedDays')}</h3>
      {b.anomalies.length ? <div className="ref-rows">{b.anomalies.map((a) => (
        <div key={a.id} className="ref-row"><span className="ref-label">{a.merchant}<small>{TYPES[a.type].label}</small></span><span className="row"><SeverityBadge severity={a.severity} /><GaugeCell observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={a.explanation} /></span></div>
      ))}</div> : <p className="muted">{t('common.none')}.</p>}

      {b.advisories.length > 0 && (<>
        <h3>{t('rep.networkAdvisories')}</h3>
        {b.advisories.map((a) => (
          <div key={a.id} className="report-adv"><span className="ref-label">{channelLabel(a.channel)}<small>{t('rep.corroboratedAdvisory', { n: a.members.filter((m) => m.affected).length })}</small></span>
            <p>{t('intel.obsExp', { obs: fmtInt(a.observed), exp: fmtNum(a.expected, 1) })} · {symptomLabel(a.symptom)}</p></div>
        ))}
      </>)}

      <h3>{t('rep.followUp')}</h3>
      {b.active.length ? <div className="ref-rows">{b.active.map((i) => (
        <div key={i.id} className="ref-row followup"><span className="ref-label">{i.id}<small>{PLAYBOOK[i.type].owner}</small></span>
          <ol className="step-chips">{PLAYBOOK[i.type].steps.map((st, n) => <li key={st}><span className="ns-n">{n + 1}</span>{st}</li>)}</ol></div>
      ))}</div> : <p className="muted">{t('rep.nothingFollow')}</p>}

      <p className="report-foot">{t('rep.foot', { engine: getMeta().run.policy.version })}</p>
      <div className="no-print row"><ExportLink kind="anomalies" params={{ from: date, to: date }} label={t('rep.dayCsv')} /><ExportLink kind="incidents" params={{ scope: 'all' }} label={t('rep.allIncidentsCsv')} /></div>
      <RunEvidence from={date} to={date} />
    </article>
  );
}

function Weekly({ end }: { end: string }) {
  const t = makeT();
  const b = weeklyBrief(end), k = b.overview.kpis;
  const d = (v: number | null, p: number | null) => (p !== null && v !== null ? t('rep.vsPriorWeek', { d: fmtDelta(v, p) }) : t('rep.noPriorWeek'));
  return (
    <article className="panel report m-rise">
      <ReportHead title={t('rep.weeklyTitle', { from: fmtDay(b.from), to: fmtDate(b.to) })} scope={t('rep.weeklyScope')} />
      <div className="report-kpis">
        <div><span>{t('ov.transactions')}</span><b>{fmtInt(k.events.value)}</b><small>{d(k.events.value, k.events.prior)}</small></div>
        <div><span>{t('al.statValue')}</span><b>{fmtCompactDzd(k.acceptedValue.value)}</b><small>{d(k.acceptedValue.value, k.acceptedValue.prior)}</small></div>
        <div><span>{t('al.statRej')}</span><b>{k.declineRate.value === null ? t('ov.na') : fmtPct(k.declineRate.value)}</b><small>{k.declineRate.prior !== null ? t('rep.priorWeek', { v: fmtPct(k.declineRate.prior) }) : t('rep.noPriorWeek')}</small></div>
        <div><span>{t('ov.flaggedDays')}</span><b>{b.anomalies.length}</b><small>{t('rep.openedResolved', { o: b.opened.length, r: b.resolvedInWeek.length })}</small></div>
      </div>
      <h3>{t('rep.activityVsExpected')}</h3>
      <PairBars points={b.overview.trend} height={240} label={t('rep.weeklyChart', { from: fmtDate(b.from), to: fmtDate(b.to) })} />
      <h3>{t('rep.incidentsWeek')}</h3>
      {b.active.length ? <div className="ref-rows">{b.active.map((i) => (
        <div key={i.id} className="ref-row"><span className="ref-label">{TYPES[i.type].label} · {i.merchant}<small>{i.id} · {fmtDay(i.onset)}{i.days > 1 ? ` → ${fmtDay(i.end)}` : ''} · {LIFECYCLE[i.lifecycle]} · {REVIEW[i.review.status]}</small></span>
          <span className="row"><SeverityBadge severity={i.severity} /><span className="muted num">{t('inc.exposureValue', { tx: fmtInt(i.affectedEvents), value: fmtCompactDzd(i.valueExposure) })}</span></span></div>
      ))}</div> : <p className="muted">{t('rep.noIncidentWeek')}</p>}
      {b.topMerchants.length > 0 && (<>
        <h3>{t('rep.topMerchants')}</h3>
        <div className="health-chips">{b.topMerchants.map(([id, n]) => <span key={id} className="hc hc-issue"><i aria-hidden />{id}<small>{t('rep.flaggedDaysN', { n })}</small></span>)}</div>
      </>)}
      {b.advisories.length > 0 && <>
        <h3>{t('ov.sigCollective')}</h3>
        <ul className="report-notes">{b.advisories.map((a) => <li key={a.id}>{fmtDate(a.date)} · {channelLabel(a.channel)} · {symptomLabel(a.symptom)} · {t('intel.obsExp', { obs: fmtInt(a.observed), exp: fmtNum(a.expected, 1) })}</li>)}</ul>
      </>}
      <RunEvidence from={b.from} to={b.to} />
      {b.forecast && (<>
        <h3>{t('rep.next7')}</h3>
        <div style={{ maxWidth: 560 }}><ForecastBars points={b.forecast} height={180} /></div>
      </>)}
      <p className="report-foot">{t('rep.foot', { engine: getMeta().run.policy.version })}</p>
      <div className="no-print row"><ExportLink kind="anomalies" params={{ from: b.from, to: b.to }} label={t('rep.weekCsv')} /><ExportLink kind="incidents" params={{ scope: 'all' }} label={t('rep.allIncidentsCsv')} /></div>
    </article>
  );
}

function MerchantBrief({ id }: { id: string }) {
  const t = makeT();
  const m = getMerchant(id);
  if (!m) return <EmptyState title={t('rep.unknownMerchant')} />;
  const recent = m.series.slice(-14);
  return (
    <article className="panel report m-rise">
      <ReportHead title={t('rep.merchantTitle', { id: m.id })} scope={t('rep.merchantScope', { cat: categoryLabel(m.category), since: fmtDate(m.firstSeen), n: m.daysObserved })} />
      <div className="report-kpis">
        <div><span>{t('mer.txDay')}</span><b>{fmtInt(m.kpis.avgDailyTx)}</b><small>{t('mer.average')}</small></div>
        <div><span>{t('mer.valueDay')}</span><b>{fmtCompactDzd(m.kpis.avgDailyValue)}</b><small>{m.kpis.valueDays.known < m.kpis.valueDays.total ? t('mer.valuePartial', { k: m.kpis.valueDays.known, n: m.kpis.valueDays.total }) : t('mer.average')}</small></div>
        <div><span>{t('al.statRej')}</span><b>{fmtPct(m.kpis.rejectionRate)}</b><small>{t('rep.wholePeriod')}</small></div>
        <div><span>{t('mer.kFlagged')}</span><b>{m.kpis.flagged}</b><small>{t('rep.incidentsN', { n: m.incidents.length })}</small></div>
      </div>
      <h3>{t('rep.health7')}</h3>
      <div className="health-chips">{m.health.map((h) => <span key={h.key} className={`hc hc-${h.level}`} title={h.detail}><i aria-hidden />{h.label}<small>{h.detail}</small></span>)}</div>
      <h3>{t('nav.incidents')}</h3>
      {m.incidents.length ? <div className="ref-rows">{m.incidents.map((i) => (
        <div key={i.id} className="ref-row"><span className="ref-label">{TYPES[i.type].label}<small>{i.id} · {fmtDay(i.onset)}{i.days > 1 ? ` → ${fmtDay(i.end)}` : ''} · {LIFECYCLE[i.lifecycle]} · {REVIEW[i.review.status]}</small></span>
          <GaugeCell observed={i.latest.observed} expected={i.latest.expected} lo={i.latest.lo} hi={i.latest.hi} unit={i.latest.unit} severity={i.severity} label={observedVsExpected(i.latest)} /></div>
      ))}</div> : <p className="muted">{t('rep.noIncident')}</p>}
      <h3>{t('rep.last14')}</h3>
      <DayBars points={recent} width={900} height={220} label={t('rep.merchantChart', { id: m.id })} />
      {m.forecast.length > 0 && (<>
        <h3>{t('rep.next7')}</h3>
        <div style={{ maxWidth: 520 }}><ForecastBars points={m.forecast} height={180} /></div>
      </>)}
      <p className="report-foot">{t('rep.footMerchant')}</p>
      <div className="no-print row"><ExportLink kind="transactions" params={{ merchant: m.id }} /></div>
      <RunEvidence from={m.firstSeen} to={getMeta().asOf} merchant={m.id} />
    </article>
  );
}
