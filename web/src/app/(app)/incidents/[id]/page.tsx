import { IncidentSkeleton } from '@/components/skeletons';
import { incidentHypotheses } from '@/lib/insights';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CircleHelp, ThumbsDown, ThumbsUp } from 'lucide-react';
import { getIncident } from '@/lib/api';
import { fmtCompactDzd, fmtDate, fmtDay, fmtInt, fmtNum, fmtStamp } from '@/lib/format';
import { REVIEW, TYPES, observedVsExpected } from '@/lib/labels';
import { engineText } from '@/lib/i18n/engine';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { GaugeCell, Gauge, NextSteps, PriorityStack, fmtShort } from '@/components/visuals';
import { ImpactEvidence } from '@/components/satim-evidence';
import { allowed, currentUser } from '@/lib/session';
import { nameOf } from '@/lib/accounts';
import { ReviewPanel } from '@/components/client';
import { DayBars, ProgressRows } from '@/components/charts';
import { LifecycleChip, PageHeader, ReviewChip, SeverityBadge, TypeLabel } from '@/components/ui';
import { Balanced } from '@/components/balanced';

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function IncidentPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  return <Suspense fallback={<IncidentSkeleton />}><IncidentView params={params} searchParams={searchParams} /></Suspense>;
}

async function IncidentView({ params, searchParams }: { params: Params; searchParams: SP }) {
  const sp = await searchParams;
  const t = await getT();
  const view = await resolveView(typeof sp.run === 'string' ? sp.run : null);
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('nav.incidents')} /><ViewPending view={view} /></>;
  const run = view.runId;
  let data: ReturnType<typeof getIncident> = null;
  try { data = getIncident(decodeURIComponent((await params).id), run); } catch { notFound(); }
  if (!data) notFound();
  const official = view.kind === 'official';
  const user = await currentUser();
  const { incident: i, anomalies, timeline, advisory } = data;
  const peak = anomalies.reduce((p, a) => (a.score > p.score ? a : p));
  const triage = i.evidence.priority_explanation;
  const weightTotal = Object.values(triage.weights).reduce((a, b) => a + b, 0);
  const hyps = incidentHypotheses(i, run);

  return (
    <>
      <PageHeader
        crumbs={<><Link transitionTypes={['nav-back']} href={keepRun('/incidents', view)}>{t('nav.incidents')}</Link><span>/</span><span>{i.id}</span></>}
        title={t('incd.title', { type: TYPES[i.type].label, merchant: i.merchant })}
      >
        {official && <Link className="btn btn-secondary" href={"/reports?type=incident&incident=" + encodeURIComponent(i.id)}>{t('incd.brief')}</Link>}
        {official && <Link className="btn btn-secondary" href={`/assistant?q=${encodeURIComponent(t('incd.askQ', { merchant: i.merchant }))}`}>{t('mer.ask')}</Link>}
      </PageHeader>
      <ViewBanner view={view} path={`/incidents/${i.id}`} />

      <Balanced className="detail-grid">
        <div className="stack">
          <section className={`story sev-${i.severity} m-rise`}>
            <div className="row"><SeverityBadge severity={i.severity} /><LifecycleChip l={i.lifecycle} />{official && <ReviewChip s={i.review.status} escalated={i.review.escalated} />}{i.rank && <span className="meta">{t('incd.rankIn', { n: i.rank })}</span>}</div>
            <p className="sr-only">{i.latest.explanation}</p>
            <div className="compare" aria-hidden><b>{fmtShort(i.latest.observed, i.latest.unit)}</b><span className="unit">{i.latest.unit === 'tx' ? t('unit.txShort') : i.latest.indicator}</span><span className="vs">{t('incd.on', { date: fmtDay(i.latest.date) })}</span></div>
            <Gauge tone="hero" size="lg" observed={i.latest.observed} expected={i.latest.expected} lo={i.latest.lo} hi={i.latest.hi} unit={i.latest.unit} severity={i.severity} label={i.latest.explanation} />
            <div className="figures small">
              <div><b>{i.priority}</b><span>{t('inc.priority')}</span></div>
              <div><b>{i.days}</b><span>{t('incd.daysSpan')}</span></div>
              <div><b>{fmtInt(i.affectedEvents)}</b><span>{t('incd.affected')}</span></div>
              <div><b>{fmtCompactDzd(i.valueExposure)}</b><span>{t('incd.shortfall')}</span></div>
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('al.nextCheck')}</h2></div></div>
            <NextSteps owner={engineText(i.evidence.responsible_role)} steps={[engineText(i.evidence.first_action)]} href={advisory && official ? { to: `/intelligence/${advisory.id}`, label: t('al.advisoryLink', { n: advisory.members.filter((m) => m.affected).length }) } : undefined} />
          </section>


          {official ? <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('f.review')}</h2><p>{REVIEW[i.review.status]} · {i.review.owner ?? t('incd.noOwner')}</p></div></div>
            <ReviewPanel id={i.id} version={i.review.version} status={i.review.status} allowed={allowed(user)} />
            <h3 className="sub-h">{t('incd.history')}</h3>
            {i.review.history.length ? (
              <ol className="history">
                {[...i.review.history].reverse().map((e) => (
                  <li key={e.event_id}><b>{t(`rev.action.${e.action}` as 'rev.action.close')}</b> {t('data.by', { name: nameOf(e.actor) })} · {fmtStamp(e.ts)}
                    <span className="muted"> · {REVIEW[e.prior]} → {REVIEW[e.next]}{e.owner ? ` · ${t('incd.ownerIs', { owner: e.owner })}` : ''}</span>{e.reason && <q>{e.reason}</q>}</li>
                ))}
              </ol>
            ) : <p className="muted">{t('incd.noAction')}</p>}
          </section> : <section className="panel m-rise" style={css({ '--i': 1 })}><div className="panel-head"><div><h2>{t('f.review')}</h2></div></div><p className="muted">{t('incd.reviewOfficialOnly')}</p></section>}

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>{t('incd.whyRank')}</h2></div></div>
            <PriorityStack total={i.priority} parts={Object.entries(triage.criteria).map(([key, value]) => ({
              key, value, label: t(`crit.${key}` as 'crit.evidence'), weight: triage.weights[key] / weightTotal,
              detail: triage.leading_mcda_factors.includes(key) ? t('incd.leading') : t('incd.criterion'),
            }))} />
            <p className="ns-foot">{t('incd.mcda', { status: engineText(triage.preference_status) })}</p>
          </section>
        </div>

        <div className="stack">
          <ImpactEvidence record={i.evidence} />
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('incd.timeline')}</h2><p>{t('incd.timelineSub')}</p></div></div>
            <DayBars points={timeline} width={520} height={260} label={t('incd.timelineLabel', { merchant: i.merchant, id: i.id })} />
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>{t('incd.flagged')}</h2></div></div>
            <div className="queue">
              {anomalies.map((a) => (
                <Link key={a.id} href={keepRun(`/alerts/${a.id}`, view)} className={`queue-row compact sev-${a.severity}`}>
                  <span className="rank">{fmtDay(a.date)}</span>
                  <span className="q-main q-stack"><TypeLabel type={a.type} /><GaugeCell observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={observedVsExpected(a)} /></span>
                  <SeverityBadge severity={a.severity} />
                  <ArrowRight className="chev" aria-hidden />
                </Link>
              ))}
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><h2>{t('al.evidence')}</h2><p>{t('incd.strongest', { date: fmtDate(peak.date) })}</p></div></div>
            <ProgressRows rows={peak.signals.map((s) => ({ label: s.label, value: Math.min(s.score, 12), max: 12, color: 'var(--primary)', right: t('incd.scoreN', { v: fmtNum(s.score, 1) }) }))} />
          </section>


          {hyps.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 4 })}>
              <div className="panel-head"><div><h2>{t('incd.causes')}</h2><p>{t('incd.causesSub')}</p></div></div>
              <div className="hypotheses">
                {hyps.map((h, n) => (
                  <article key={h.title} className="hypo">
                    <h3><span className="hypo-rank num">{n + 1}</span>{h.title}{n === 0 && h.support > 0 && <small className="hypo-top">{t('incd.mostConsistent')}</small>}</h3>
                    <ul>
                      {h.for.map((x) => <li key={x}><ThumbsUp aria-label={t('incd.for')} />{x}</li>)}
                      {h.against.map((x) => <li key={x}><ThumbsDown aria-label={t('incd.against')} />{x}</li>)}
                      {!h.for.length && !h.against.length && <li className="muted"><CircleHelp aria-hidden />{t('incd.noEvidence')}</li>}
                      {h.missing.map((x) => <li key={x} className="muted"><CircleHelp aria-label={t('incd.wouldConfirm')} />{x}</li>)}
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </Balanced>
    </>
  );
}
