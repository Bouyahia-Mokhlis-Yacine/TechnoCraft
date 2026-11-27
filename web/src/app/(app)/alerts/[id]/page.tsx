import { AlertSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { getAnomaly } from '@/lib/api';
import { fmtDate, fmtDelta, fmtNum } from '@/lib/format';
import { CHANNEL_VAR, TYPES, fmtKind } from '@/lib/labels';
import { AreaChart, HourBars, ProgressRows } from '@/components/charts';
import { Gauge, GaugeCell, NextSteps, fmtShort } from '@/components/visuals';
import { HybridEvidence } from '@/components/satim-evidence';
import { LifecycleChip, PageHeader, SeverityBadge } from '@/components/ui';

type Params = Promise<{ id: string }>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function AlertPage({ params }: { params: Params }) {
  return <Suspense fallback={<AlertSkeleton />}><Alert params={params} /></Suspense>;
}

async function Alert({ params }: { params: Params }) {
  const data = getAnomaly(decodeURIComponent((await params).id));
  if (!data) notFound();
  const { anomaly: a, day, series, stats, channels, hours, incident, advisory, policy, runId, hybrid } = data;
  const kind = a.unit === 'DZD' ? 'dzd' : a.unit === 'ratio' ? 'pct' : 'int';
  const chMax = Math.max(...channels.flatMap((c) => [c.observed, c.usual]), 1);
  const diff = a.expected === null || a.observed === null ? 'n/a' : a.unit === 'ratio' ? `${a.observed >= a.expected ? '+' : '−'}${fmtNum(Math.abs(a.observed - a.expected) * 100, 0)} pts` : fmtDelta(a.observed, a.expected);

  return (
    <>
      <PageHeader
        crumbs={<><Link transitionTypes={['nav-back']} href="/alerts">Alerts</Link><span>/</span><Link transitionTypes={['nav-back']} href={`/merchants/${a.merchant}`}>{a.merchant}</Link><span>/</span><span>{fmtDate(a.date)}</span></>}
        title="Alert explanation"
      >
        <Link className="btn btn-primary" href={`/incidents/${a.incidentId}`}>Open incident <ArrowRight /></Link>
      </PageHeader>

      <div className="detail-grid">
        <div className="stack">
          <section className={`story sev-${a.severity} m-rise`}>
            <div className="row"><SeverityBadge severity={a.severity} /><span className="meta">{TYPES[a.type].label}</span>{incident && <LifecycleChip l={incident.lifecycle} />}</div>
            <h1>{a.merchant} · {fmtDate(a.date)}</h1>
            <p>{a.explanation}</p>
            <div className="compare" aria-hidden><b>{fmtShort(a.observed, a.unit)}</b><span className="unit">{a.unit === 'tx' ? 'tx' : a.indicator}</span><span className="delta num">{diff}</span></div>
            <Gauge tone="hero" size="lg" observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={a.explanation} />
          </section>

          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Evidence</h2></div></div>
            <ul className="reasons">{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Next check</h2></div></div>
            <NextSteps owner={a.owner} steps={[a.check, ...a.steps]} href={advisory ? { to: `/intelligence/${advisory.id}`, label: `Network advisory · ${advisory.members.filter((m) => m.affected).length} merchants` } : undefined} />
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head tight"><div><h2>That day vs usual</h2></div></div>
            <div className="ref-rows">
              {stats.map((s) => {
                const unit = s.kind === 'pct' ? 'ratio' as const : s.kind === 'dzd' ? 'DZD' as const : 'tx' as const;
                const hl = s.label.toLowerCase() === a.indicator;
                return (
                  <div key={s.label} className={`ref-row${hl ? ' hl' : ''}`}>
                    <span className="ref-label">{s.label}{s.note && <small>{s.note}</small>}</span>
                    {s.observed === null ? <span className="muted num">no data</span>
                      : <GaugeCell observed={s.observed} expected={s.usual ?? null} lo={s.label === 'Transactions' ? day.expected_lo : null} hi={s.label === 'Transactions' ? day.expected_hi : null} unit={unit} severity={hl ? a.severity : 'normal'} label={`${s.label}: ${fmtKind(s.observed, s.kind)}${s.usual != null ? ` vs ${fmtKind(s.usual, s.kind)} expected` : ''}`} />}
                  </div>
                );
              })}
            </div>
            <details className="how">
              <summary>How was this computed?</summary>
              <ul>
                <li>Historical count reference uses a weekday-adjusted Poisson law or a pooled Gamma–Poisson law for sparse merchant history.</li>
                <li>Frozen Sequential Detection combines instantaneous and persistent count evidence. Managed score {fmtNum(a.score, 4)} · boundary {fmtNum(policy.high, 4)}.</li>
                <li>Reference {a.evidence.reference_version} · {a.historyDays} eligible prior merchant-days · run {runId}.</li>
                <li>The score measures unusualness relative to historical activity. Confirm causes using independent evidence.</li>
              </ul>
            </details>
          </section>
        </div>

        <div className="stack">
          {hybrid && <HybridEvidence row={hybrid} />}
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{a.indicator[0].toUpperCase() + a.indicator.slice(1)} per day</h2><p>4 weeks before · 1 week after</p></div></div>
            <AreaChart points={series} kind={kind} highlight={a.date} label={`${a.indicator} for ${a.merchant} around ${a.date}, with the expected level`} />
            <div className="legend below"><span><i />Observed</span><span><i className="line" />Expected</span><span><i style={{ background: 'var(--sev-high)' }} />Other flagged days (click)</span></div>
          </section>
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Channels that day</h2><p>Bar = that day · mark = usual</p></div></div>
            <ProgressRows rows={channels.map((c) => ({ label: c.label, value: c.observed, max: chMax, mark: c.usual, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', right: `${c.observed} / usual ${fmtNum(c.usual, 0)}${c.declined ? ` (${c.declined} declined)` : ''}` }))} />
          </section>
          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><h2>Transactions per hour</h2><p>Dark = that day · light = usual</p></div></div>
            <HourBars rows={hours} />
          </section>
        </div>
      </div>
    </>
  );
}
