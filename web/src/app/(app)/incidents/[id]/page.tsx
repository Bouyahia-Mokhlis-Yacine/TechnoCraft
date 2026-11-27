import { IncidentSkeleton } from '@/components/skeletons';
import { incidentHypotheses } from '@/lib/insights';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CircleHelp, ThumbsDown, ThumbsUp } from 'lucide-react';
import { getIncident } from '@/lib/api';
import { fmtCompactDzd, fmtDate, fmtDay, fmtInt, fmtNum } from '@/lib/format';
import { REVIEW, TYPES, observedVsExpected } from '@/lib/labels';
import { GaugeCell, Gauge, NextSteps, PriorityStack, fmtShort } from '@/components/visuals';
import { ImpactEvidence } from '@/components/satim-evidence';
import { ROLES, currentUser } from '@/lib/session';
import { ReviewPanel } from '@/components/client';
import { DayBars, ProgressRows } from '@/components/charts';
import { LifecycleChip, PageHeader, ReviewChip, SeverityBadge, TypeLabel } from '@/components/ui';

type Params = Promise<{ id: string }>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function IncidentPage({ params }: { params: Params }) {
  return <Suspense fallback={<IncidentSkeleton />}><IncidentView params={params} /></Suspense>;
}

async function IncidentView({ params }: { params: Params }) {
  const data = getIncident(decodeURIComponent((await params).id));
  if (!data) notFound();
  const user = await currentUser();
  const { incident: i, anomalies, timeline, advisory } = data;
  const peak = anomalies.reduce((p, a) => (a.score > p.score ? a : p));
  const triage = i.evidence.priority_explanation;
  const weightTotal = Object.values(triage.weights).reduce((a, b) => a + b, 0);
  const hyps = incidentHypotheses(i);

  return (
    <>
      <PageHeader
        crumbs={<><Link transitionTypes={['nav-back']} href="/incidents">Incidents</Link><span>/</span><span>{i.id}</span></>}
        title={`${TYPES[i.type].label} at ${i.merchant}`}
      >
        <Link className="btn btn-secondary" href={"/reports?type=incident&incident=" + encodeURIComponent(i.id)}>Incident brief</Link>
        <Link className="btn btn-secondary" href={`/assistant?q=${encodeURIComponent(`Why was ${i.merchant} flagged, and what should I check?`)}`}>Ask about it</Link>
      </PageHeader>

      <div className="detail-grid">
        <div className="stack">
          <section className={`story sev-${i.severity} m-rise`}>
            <div className="row"><SeverityBadge severity={i.severity} /><LifecycleChip l={i.lifecycle} /><ReviewChip s={i.review.status} escalated={i.review.escalated} />{i.rank && <span className="meta">Rank {i.rank} in the queue</span>}</div>
            <p className="sr-only">{i.latest.explanation}</p>
            <div className="compare" aria-hidden><b>{fmtShort(i.latest.observed, i.latest.unit)}</b><span className="unit">{i.latest.unit === 'tx' ? 'tx' : i.latest.indicator}</span><span className="vs">on {fmtDay(i.latest.date)}</span></div>
            <Gauge tone="hero" size="lg" observed={i.latest.observed} expected={i.latest.expected} lo={i.latest.lo} hi={i.latest.hi} unit={i.latest.unit} severity={i.severity} label={i.latest.explanation} />
            <div className="figures small">
              <div><b>{i.priority}</b><span>priority</span></div>
              <div><b>{i.days}</b><span>days from first to last alert</span></div>
              <div><b>{fmtInt(i.affectedEvents)}</b><span>estimated affected events</span></div>
              <div><b>{fmtCompactDzd(i.valueExposure)}</b><span>gross value shortfall estimate</span></div>
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Next check</h2></div></div>
            <NextSteps owner={i.evidence.responsible_role} steps={[i.evidence.first_action]} href={advisory ? { to: `/intelligence/${advisory.id}`, label: `Network advisory · ${advisory.members.filter((m) => m.affected).length} merchants` } : undefined} />
          </section>


          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Review</h2><p>{REVIEW[i.review.status]} · {i.review.owner ?? 'no owner'}</p></div></div>
            <ReviewPanel id={i.id} version={i.review.version} status={i.review.status} allowed={user ? ROLES[user.role].can : []} />
            <h3 className="sub-h">History</h3>
            {i.review.history.length ? (
              <ol className="history">
                {[...i.review.history].reverse().map((e) => (
                  <li key={e.event_id}><b>{e.action}</b> by {ROLES[e.actor].name} · {new Date(e.ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                    <span className="muted"> · {REVIEW[e.prior]} → {REVIEW[e.next]}{e.owner ? ` · owner ${e.owner}` : ''}</span>{e.reason && <q>{e.reason}</q>}</li>
                ))}
              </ol>
            ) : <p className="muted">No action yet.</p>}
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Why it ranks here</h2></div></div>
            <PriorityStack total={i.priority} parts={Object.entries(triage.criteria).map(([key, value]) => ({
              key, value, label: key, weight: triage.weights[key] / weightTotal,
              detail: triage.leading_mcda_factors.includes(key) ? 'Leading factor' : 'Operational criterion',
            }))} />
            <p className="ns-foot">Multi-criteria priority · {triage.preference_status}</p>
          </section>
        </div>

        <div className="stack">
          <ImpactEvidence record={i.evidence} />
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Timeline</h2><p>Daily transactions around the incident</p></div></div>
            <DayBars points={timeline} width={520} height={260} label={`Transactions for ${i.merchant} around incident ${i.id}`} />
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Flagged days</h2></div></div>
            <div className="queue">
              {anomalies.map((a) => (
                <Link key={a.id} href={`/alerts/${a.id}`} className={`queue-row compact sev-${a.severity}`}>
                  <span className="rank">{fmtDay(a.date)}</span>
                  <span className="q-main q-stack"><TypeLabel type={a.type} /><GaugeCell observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={observedVsExpected(a)} /></span>
                  <SeverityBadge severity={a.severity} />
                  <ArrowRight className="chev" aria-hidden />
                </Link>
              ))}
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><h2>Evidence</h2><p>Strongest day · {fmtDate(peak.date)}</p></div></div>
            <ProgressRows rows={peak.signals.map((s) => ({ label: s.label, value: Math.min(s.score, 12), max: 12, color: 'var(--primary)', right: `score ${fmtNum(s.score, 1)}` }))} />
          </section>


          {hyps.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 4 })}>
              <div className="panel-head"><div><h2>Possible causes</h2><p>Ranked by the evidence · none confirmed</p></div></div>
              <div className="hypotheses">
                {hyps.map((h, n) => (
                  <article key={h.title} className="hypo">
                    <h3><span className="hypo-rank num">{n + 1}</span>{h.title}{n === 0 && h.support > 0 && <small className="hypo-top">most consistent</small>}</h3>
                    <ul>
                      {h.for.map((x) => <li key={x}><ThumbsUp aria-label="For" />{x}</li>)}
                      {h.against.map((x) => <li key={x}><ThumbsDown aria-label="Against" />{x}</li>)}
                      {!h.for.length && !h.against.length && <li className="muted"><CircleHelp aria-hidden />No evidence either way in the data</li>}
                      {h.missing.map((x) => <li key={x} className="muted"><CircleHelp aria-label="Would confirm" />{x}</li>)}
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
