import { MerchantSkeleton } from '@/components/skeletons';
import { InteractivePie } from '@/components/charts-client';
import { ForecastEvidence } from '@/components/satim-evidence';
import { GaugeCell, HealthMeter } from '@/components/visuals';
import { healthScore } from '@/lib/insights';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Ban, Banknote, CircleCheck, CircleHelp, Eye, OctagonAlert, Receipt, Siren } from 'lucide-react';
import { getMerchant, type HealthLevel } from '@/lib/api';
import { fmtDay, fmtNum } from '@/lib/format';
import { CHANNEL_VAR, STATUS_VAR, TYPES } from '@/lib/labels';
import { CountUp } from '@/components/client';
import { DayBars, ForecastBars, ProgressRows } from '@/components/charts';
import { EmptyState, IconTile, LifecycleChip, PageHeader, ReviewChip, SeverityBadge } from '@/components/ui';

type Params = Promise<{ id: string }>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;
const HEALTH: Record<HealthLevel, { icon: typeof Eye; label: string }> = { ok: { icon: CircleCheck, label: 'OK' }, watch: { icon: Eye, label: 'Watch' }, issue: { icon: OctagonAlert, label: 'Issue' }, unknown: { icon: CircleHelp, label: 'Unknown' } };

export default function MerchantPage({ params }: { params: Params }) {
  return <Suspense fallback={<MerchantSkeleton />}><Merchant params={params} /></Suspense>;
}

async function Merchant({ params }: { params: Params }) {
  const m = getMerchant(decodeURIComponent((await params).id));
  if (!m) notFound();
  const kpis = [
    { label: 'Transactions per day', value: m.kpis.avgDailyTx, kind: 'int' as const, icon: Receipt, note: 'average' },
    { label: 'Accepted value per day', value: m.kpis.avgDailyValue, kind: 'dzd' as const, icon: Banknote, note: 'average' },
    { label: 'Decline rate', value: m.kpis.rejectionRate, kind: 'pct' as const, icon: Ban, note: 'of all events' },
    { label: 'Flagged days', value: m.kpis.flagged, kind: 'int' as const, icon: Siren, note: 'official flags' },
  ];
  const statusTotal = m.statuses.reduce((s, x) => s + x.value, 0) || 1;
  const health = healthScore(m.id);
  const cold = m.cold;
  return (
    <>
      <PageHeader
        crumbs={<><Link transitionTypes={['nav-back']} href="/merchants">Merchants</Link><span>/</span><span>{m.id}</span></>}
        title={`${m.id} · ${m.category}`}
      >
        <Link className="btn btn-primary" href={`/transactions?merchant=${m.id}`}>Transactions <ArrowRight /></Link>
        <Link className="btn btn-secondary" href={`/reports?type=merchant&merchant=${m.id}`}>Health brief</Link>
        <Link className="btn btn-secondary" href={`/assistant?q=${encodeURIComponent(`Why was ${m.id} flagged?`)}`}>Ask about it</Link>
      </PageHeader>

      <div className="kpi-grid four">
        {kpis.map((k, i) => (
          <div key={k.label} className={`kpi m-rise${i === 0 ? ' hero' : ''}`} style={css({ '--i': i })}>
            <IconTile icon={k.icon} tone={i === 0 ? 'hero' : 'plain'} />
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-line">{k.value === null ? 'n/a' : <CountUp value={k.value} kind={k.kind} />}<span className="kpi-note">{k.note}</span></span>
          </div>
        ))}
      </div>

      <section className="panel m-rise" style={css({ '--i': 4 })}>
        <div className="panel-head">
          <div><h2>Transactions per day</h2></div>
          <div className="legend"><span><i />Normal day</span><span><i style={{ background: 'var(--sev-critical)' }} />Critical</span><span><i style={{ background: 'var(--sev-high)' }} />High</span><span><i style={{ background: 'var(--sev-medium)' }} />Medium</span><span><i className="line" />Expected</span></div>
        </div>
        <DayBars points={m.series} label={`Daily transactions for ${m.id} with the expected level`} />
      </section>

      <div className="ov">
        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 5 })}>
            <div className="panel-head"><div><h2>Operational checklist</h2><p>Heuristic index · last 7 days</p></div></div>
            <HealthMeter {...health} />
            <p className="ns-foot">{m.reference.history_days} eligible prior days. {m.reference.warming_up ? 'Count intervals use pooled merchant history.' : 'Count intervals use the merchant’s own weekday-adjusted activity.'}</p>
            <div className="health-grid tiles">
              {m.health.map((h) => {
                const H = HEALTH[h.level];
                return <div key={h.label} className={`health-item h-${h.level}`}><H.icon aria-hidden /><span><b>{h.label}</b><small>{h.detail}</small></span><span className="chip">{H.label}</span></div>;
              })}
            </div>
          </section>
          <section className="panel m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head"><div><h2>Incidents</h2><p>{m.incidents.length || 'None'}</p></div></div>
            {m.incidents.length ? (
              <div className="queue">
                {m.incidents.map((i, n) => (
                  <Link key={i.id} href={`/incidents/${i.id}`} className={`queue-row compact sev-${i.severity} m-rise`} style={css({ '--i': Math.min(n, 7) })}>
                    <span className="rank">{i.rank ?? '–'}</span>
                    <span className="q-main"><b>{TYPES[i.type].label} · {i.id}</b><span className="muted">{i.days > 1 ? `${fmtDay(i.onset)} → ${fmtDay(i.end)}` : fmtDay(i.onset)}</span></span>
                    <span className="row"><LifecycleChip l={i.lifecycle} /><ReviewChip s={i.review.status} /></span>
                    <SeverityBadge severity={i.severity} />
                    <ArrowRight className="chev" aria-hidden />
                  </Link>
                ))}
              </div>
            ) : <EmptyState title="No incident for this merchant" />}
          </section>
          {cold.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 7 })}>
              <div className="panel-head"><div><h2>First days · category reference</h2><p>Before its own reference exists, the merchant is compared with its category</p></div></div>
              <div className="ref-rows">{cold.map((c) => (
                <div key={c.date} className="ref-row"><span className="ref-label">{fmtDay(c.date)}<small>{c.own_days} own day{c.own_days === 1 ? '' : 's'} · category median {fmtNum(c.category_ref, 1)}</small></span>
                  <GaugeCell observed={c.n} expected={c.expected} unit="tx" severity={c.would_alert ? 'high' : 'normal'} label={`${c.n} transactions vs ${fmtNum(c.expected, 1)} from the category reference`} /></div>
              ))}</div>
              <p className="ns-foot">Advisory only: official alerts start once the merchant has {7} days of its own history.</p>
            </section>
          )}
        </div>

        <div className="stack">
          {m.forecast.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 5 })}>
              <div className="panel-head"><div><h2>Next 7 days</h2><p>Advisory forecast · 80 % interval</p></div></div>
              <ForecastBars points={m.forecast} />
              <ForecastEvidence forecast={m.forecastDetail} merchant={m.id} />
            </section>
          )}
          <section className="panel tinted mix m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head flush"><div><h2>Channel mix</h2></div></div>
            <InteractivePie size={200} rows={m.channels.map((c) => ({ label: c.label, value: c.value, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', href: `/transactions?merchant=${m.id}&channel=${encodeURIComponent(c.label)}` }))} />
          </section>
          <section className="panel m-rise" style={css({ '--i': 7 })}>
            <div className="panel-head"><div><h2>Status mix</h2></div></div>
            <ProgressRows rows={m.statuses.map((s) => ({ label: s.label, value: s.value, max: statusTotal, color: STATUS_VAR[s.label], right: `${s.value} · ${Math.round((s.value / statusTotal) * 100)} %` }))} />
          </section>
        </div>
      </div>
    </>
  );
}
