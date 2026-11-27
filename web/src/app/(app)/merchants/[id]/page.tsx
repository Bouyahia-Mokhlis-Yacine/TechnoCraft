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
import { fmtDay, fmtNum, fmtPct, na } from '@/lib/format';
import { CHANNEL_INK, CHANNEL_VAR, STATUS_VAR, TYPES, categoryLabel, channelLabel, statusLabel } from '@/lib/labels';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { CountUp } from '@/components/client';
import { DayBars, ForecastBars, ProgressRows } from '@/components/charts';
import { EmptyState, IconTile, LifecycleChip, PageHeader, ReviewChip, SeverityBadge } from '@/components/ui';
import { Balanced } from '@/components/balanced';

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;
const HEALTH: Record<HealthLevel, typeof Eye> = { ok: CircleCheck, watch: Eye, issue: OctagonAlert, unknown: CircleHelp };

export default function MerchantPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  return <Suspense fallback={<MerchantSkeleton />}><Merchant params={params} searchParams={searchParams} /></Suspense>;
}

async function Merchant({ params, searchParams }: { params: Params; searchParams: SP }) {
  const sp = await searchParams;
  const t = await getT();
  const view = await resolveView(typeof sp.run === 'string' ? sp.run : null);
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('nav.merchants')} /><ViewPending view={view} /></>;
  const run = view.runId;
  let m: ReturnType<typeof getMerchant> = null;
  try { m = getMerchant(decodeURIComponent((await params).id), run); } catch { notFound(); }
  if (!m) notFound();
  const kpis = [
    { label: t('mer.kTxDay'), value: m.kpis.avgDailyTx, kind: 'int' as const, icon: Receipt, note: t('mer.average') },
    { label: t('mer.kValueDay'), value: m.kpis.avgDailyValue, kind: 'dzd' as const, icon: Banknote,
      note: m.kpis.valueDays.known < m.kpis.valueDays.total ? t('mer.valuePartial', { k: m.kpis.valueDays.known, n: m.kpis.valueDays.total }) : t('mer.average'),
      tip: m.kpis.valueDays.known < m.kpis.valueDays.total ? t('mer.valuePartialTip', { n: m.kpis.valueDays.total - m.kpis.valueDays.known }) : undefined },
    { label: t('al.statRej'), value: m.kpis.rejectionRate, kind: 'pct' as const, icon: Ban, note: t('mer.ofAll') },
    { label: t('mer.kFlagged'), value: m.kpis.flagged, kind: 'int' as const, icon: Siren, note: t('mer.officialFlags') },
  ];
  const statusTotal = m.statuses.reduce((s, x) => s + x.value, 0) || 1;
  const health = healthScore(m.id, run);
  const LEVEL: Record<HealthLevel, string> = { ok: t('health.ok'), watch: t('health.watch'), issue: t('health.issue'), unknown: t('health.unknown') };
  const pin = view.kind === 'collections' ? run : null;
  const tx = (q: Record<string, string>) => `/transactions?${new URLSearchParams({ ...q, ...(pin ? { run: pin } : {}) })}`;
  const cold = m.cold;
  return (
    <>
      <PageHeader
        crumbs={<><Link transitionTypes={['nav-back']} href={keepRun('/merchants', view)}>{t('nav.merchants')}</Link><span>/</span><span>{m.id}</span></>}
        title={`${m.id} · ${categoryLabel(m.category)}`}
      >
        <Link className="btn btn-primary" href={tx({ merchant: m.id })}>{t('nav.transactions')} <ArrowRight /></Link>
        {view.kind === 'official' && <Link className="btn btn-secondary" href={`/reports?type=merchant&merchant=${m.id}`}>{t('mer.healthBrief')}</Link>}
        {view.kind === 'official' && <Link className="btn btn-secondary" href={`/assistant?q=${encodeURIComponent(t('mer.askQ', { id: m.id }))}`}>{t('mer.ask')}</Link>}
      </PageHeader>
      <ViewBanner view={view} path={`/merchants/${m.id}`} />

      <div className="kpi-grid four">
        {kpis.map((k, i) => (
          <div key={k.label} className={`kpi m-rise${i === 0 ? ' hero' : ''}`} style={css({ '--i': i })}>
            <IconTile icon={k.icon} tone={i === 0 ? 'hero' : 'plain'} />
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-line">{k.value === null ? na() : <CountUp value={k.value} kind={k.kind} />}<span className="kpi-note" title={'tip' in k ? k.tip : undefined}>{k.note}{'tip' in k && k.tip && <span className="sr-only"> · {k.tip}</span>}</span></span>
          </div>
        ))}
      </div>

      <section className="panel m-rise" style={css({ '--i': 4 })}>
        <div className="panel-head">
          <div><h2>{t('mer.kTxDay')}</h2></div>
          <div className="legend"><span><i />{t('mer.normalDay')}</span><span><i style={{ background: 'var(--sev-critical)' }} />{t('sev.critical')}</span><span><i style={{ background: 'var(--sev-high)' }} />{t('sev.high')}</span><span><i style={{ background: 'var(--sev-medium)' }} />{t('sev.medium')}</span><span><i className="line" />{t('ov.expected')}</span></div>
        </div>
        <DayBars points={m.series} label={t('mer.chartLabel', { id: m.id })} />
      </section>

      <Balanced className="ov">
        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 5 })}>
            <div className="panel-head"><div><h2>{t('mer.checklist')}</h2><p>{t('mer.checklistSub')}</p></div></div>
            <HealthMeter {...health} />
            <p className="ns-foot">{t('mer.priorDays', { n: m.reference.history_days })} {m.reference.warming_up ? t('mer.pooled') : t('mer.own')}</p>
            <div className="health-grid tiles">
              {m.health.map((h) => {
                const Icon = HEALTH[h.level];
                return <div key={h.key} className={`health-item h-${h.level}`}><Icon aria-hidden /><span><b>{h.label}</b><small>{h.detail}</small></span><span className="chip">{LEVEL[h.level]}</span></div>;
              })}
            </div>
          </section>
          <section className="panel m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head"><div><h2>{t('nav.incidents')}</h2><p>{m.incidents.length || t('common.none')}</p></div></div>
            {m.incidents.length ? (
              <div className="queue">
                {m.incidents.map((i, n) => (
                  <Link key={i.id} href={keepRun(`/incidents/${i.id}`, view)} className={`queue-row compact sev-${i.severity} m-rise`} style={css({ '--i': Math.min(n, 7) })}>
                    <span className="rank">{i.rank ?? '–'}</span>
                    <span className="q-main"><b>{TYPES[i.type].label} · {i.id}</b><span className="muted">{i.days > 1 ? `${fmtDay(i.onset)} → ${fmtDay(i.end)}` : fmtDay(i.onset)}</span></span>
                    <span className="row"><LifecycleChip l={i.lifecycle} />{view.kind === 'official' && <ReviewChip s={i.review.status} />}</span>
                    <SeverityBadge severity={i.severity} />
                    <ArrowRight className="chev" aria-hidden />
                  </Link>
                ))}
              </div>
            ) : <EmptyState title={t('mer.noIncident')} />}
          </section>
          {cold.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 7 })}>
              <div className="panel-head"><div><h2>{t('mer.coldTitle')}</h2><p>{t('mer.coldSub')}</p></div></div>
              <div className="ref-rows">{cold.map((c) => (
                <div key={c.date} className="ref-row"><span className="ref-label">{fmtDay(c.date)}<small>{t('mer.ownDays', { n: c.own_days })} · {t('mer.catMedian', { v: fmtNum(c.category_ref, 1) })}</small></span>
                  <GaugeCell observed={c.n} expected={c.expected} unit="tx" severity={c.would_alert ? 'high' : 'normal'} label={t('mer.coldLabel', { n: c.n, exp: fmtNum(c.expected, 1) })} /></div>
              ))}</div>
              <p className="ns-foot">{t('mer.coldFoot', { n: 7 })}</p>
            </section>
          )}
        </div>

        <div className="stack">
          {m.forecast.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 5 })}>
              <div className="panel-head"><div><h2>{t('ov.next7')}</h2><p>{t('ov.forecastSub')}</p></div></div>
              <ForecastBars points={m.forecast} />
              <ForecastEvidence forecast={m.forecastDetail} merchant={m.id} />
            </section>
          )}
          <section className="panel tinted mix m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head flush"><div><h2>{t('mer.channelMix')}</h2></div></div>
            <InteractivePie size={200} rows={m.channels.map((c) => ({ label: channelLabel(c.label), value: c.value, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', ink: CHANNEL_INK[c.label] ?? 'var(--ch-unknown-ink)', href: tx({ merchant: m.id, channel: c.label }) }))} />
          </section>
          <section className="panel m-rise" style={css({ '--i': 7 })}>
            <div className="panel-head"><div><h2>{t('mer.statusMix')}</h2></div></div>
            <ProgressRows rows={m.statuses.map((s) => ({ label: statusLabel(s.label), value: s.value, max: statusTotal, color: STATUS_VAR[s.label], right: `${s.value} · ${fmtPct(s.value / statusTotal, 0)}` }))} />
          </section>
        </div>
      </Balanced>
    </>
  );
}
