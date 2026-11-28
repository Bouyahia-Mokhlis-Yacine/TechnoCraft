import { DateRange } from '@/components/date-range';
import { OverviewSkeleton } from '@/components/skeletons';
import { InteractivePie } from '@/components/charts-client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, Ban, Banknote, CreditCard, Receipt, Sigma, Siren, Store } from 'lucide-react';
import { getMeta, getOverview } from '@/lib/api';
import { fmtDay, fmtDelta, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { CHANNEL_INK, CHANNEL_VAR, SEVERITIES, categoryLabel, channelLabel } from '@/lib/labels';
import { CountUp, FilterForm } from '@/components/client';
import { ForecastEvidence } from '@/components/satim-evidence';
import { Bubbles, ForecastBars, KpiChart, PairBars } from '@/components/charts';
import { KpiEditor } from '@/components/kpi-editor';
import { DEFAULT_KPIS, evaluate, kpiLabel, parse } from '@/lib/formula';
import { currentUser } from '@/lib/session';
import { resolveView } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { Delta, EmptyState, IconTile, InfoTip, PageHeader, flat } from '@/components/ui';
import { Balanced } from '@/components/balanced';

type SP = Promise<Record<string, string | string[] | undefined>>;
/** The overview URL with some filters changed (undefined removes one). */
const qs = (p: Record<string, string | undefined>, change: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries({ ...p, ...change }).filter(([, v]) => v) as [string, string][]).toString();
  return q ? `/?${q}` : '/';
};
const css = (o: Record<string, string | number>) => o as React.CSSProperties;
type Tone = 'good' | 'bad' | 'flat';
/** Change vs the prior period; N/A when there is no comparable period or the denominator is zero (FR-19). */
const change = (v: number | null, p: number | null, lowerIsBetter = false, na = 'N/A'): { text: string; tone: Tone } => {
  if (v === null || p === null || p === 0) return { text: na, tone: 'flat' };
  const r = v / p, tone: Tone = Math.abs(r - 1) < 0.05 ? 'flat' : (r > 1) !== lowerIsBetter ? 'good' : 'bad';
  return { text: fmtDelta(v, p), tone };
};

export default function OverviewPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<OverviewSkeleton />}><Overview searchParams={searchParams} /></Suspense>;
}

async function Overview({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);
  if (!view.pinned) delete p.run;
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('ov.title')} /><ViewPending view={view} /></>;
  const run = view.runId;
  const meta = getMeta(run);
  const o = getOverview(p, run);
  const k = o.kpis;
  const NA = t('ov.na');
  const prior = o.priorScope ? t('ov.vsPrior', { from: fmtDay(o.priorScope.from), to: fmtDay(o.priorScope.to) }) : t('ov.noPrior');
  // the account's own KPI cards (Customize), defaults to the original six; each is a formula over named measures
  const user = await currentUser();
  const kpis = user?.kpis ?? DEFAULT_KPIS;
  const ICON: Record<string, typeof Receipt> = { transactions: Receipt, 'accepted-value': Banknote, 'attempted-value': CreditCard, 'decline-rate': Ban, 'merchants-flagged': Store, 'open-incidents': Siren };
  const partial = (n: number) => t('ov.partialAmounts', { n });
  const NOTE: Record<string, string> = {
    transactions: prior,
    'accepted-value': k.acceptedValue.missingEvents ? partial(k.acceptedValue.missingEvents) : t('ov.noteAccepted'),
    'attempted-value': k.attemptedValue.missingEvents ? partial(k.attemptedValue.missingEvents) : t('ov.noteAttempted'),
    'decline-rate': k.declineRate.value === null ? t('ov.noTx') : t('ov.cancelRate', { rate: fmtPct(k.cancellationRate.value ?? 0) }),
    'merchants-flagged': t('ov.noteFlagged'),
  };
  const cards = kpis.map((c) => {
    const f = parse(c.formula);
    const at = (v: typeof o.measures.cur | null) => (f.ok && v ? evaluate(f.tree, v) : null);
    const value = at(o.measures.cur), before = at(o.measures.prior);
    const d = c.formula === 'open_incidents'
      ? { text: k.openIncidents.critical ? t('ov.criticalN', { n: k.openIncidents.critical }) : t('ov.noneCritical'), tone: (k.openIncidents.critical ? 'bad' : 'good') as Tone }
      : c.good === 'none' ? { ...change(value, before, false, NA), tone: 'flat' as Tone } : change(value, before, c.good === 'down', NA);
    const isDefault = DEFAULT_KPIS.some((x) => x.id === c.id && x.formula === c.formula);
    return {
      ...c, label: kpiLabel(c, t), icon: ICON[c.id] ?? Sigma, value, d,
      note: c.formula === 'open_incidents' ? t('ov.noteOpen') : isDefault && NOTE[c.id] ? NOTE[c.id]
        : /\baffected_/.test(c.formula) ? t('ov.noteEstimate', { formula: c.formula }) : `= ${c.formula}`,
      series: c.chart === 'number' || !f.ok ? [] : o.measures.daily.map((v) => evaluate(f.tree, v)),
    };
  });
  const totalMix = o.channelMix.reduce((s, c) => s + c.value, 0) || 1;
  const multi = o.selectedChannels.length > 1;
  const source = view.kind === 'collections' ? (view.combined ? t('ds.combined', { n: view.ids.length }) : t('ds.collection', { name: view.names[0] }))
    : meta.run.parity.sealed ? t('ov.archive') : t('ov.preview');

  return (
    <>
      <PageHeader title={t('ov.title')}><KpiEditor initial={kpis} values={o.measures.cur} /></PageHeader>
      <ViewBanner view={view} path="/" />
      <p className="muted">{t('ov.sourceLine', { source, date: fmtDay(meta.asOf), batch: t(`batch.${meta.run.batch_status}` as 'batch.complete') })}</p>

      <FilterForm>
        <DateRange from={o.scope.from} to={o.scope.to} min={meta.firstDate} max={meta.asOf} />
        <label className="field">{t('f.category')}<select name="category" defaultValue={p.category ?? ''}><option value="">{t('f.allCategories')}</option>{meta.categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</select></label>
        <label className="field">{t('f.channel')}<select name="channel" defaultValue={p.channel ?? ''}><option value="">{t('f.allChannels')}</option>{multi && <option value={p.channel}>{t('f.channelsSelected', { n: o.selectedChannels.length })}</option>}{meta.channels.map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}</select></label>
        <label className="field">{t('f.merchant')}<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">{t('f.allMerchants')}</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
      </FilterForm>

      <Balanced className="ov">
        <div className="stack">
          <div className="kpi-grid three">
            {cards.map((c, i) => (
              <div key={c.id} className={`kpi m-rise${i === 0 ? ' hero' : ''}`} style={css({ '--i': i })}>
                <IconTile icon={c.icon} tone={i === 0 ? 'hero' : 'plain'} />
                <Delta text={c.d.text} tone={c.d.tone} />
                <span className="kpi-label">{c.label}</span>
                <span className="kpi-line">{c.value === null ? <span className="kpi-value" title={t('ov.noValue')}>—</span> : <CountUp value={c.value} kind={c.format} />}</span>
                {c.chart !== 'number' && c.chart && <KpiChart values={c.series} type={c.chart} label={t('ov.perDay', { label: c.label })} />}
                <span className="kpi-note wide">{c.note}</span>
              </div>
            ))}
          </div>

          <section className="panel m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head">
              <div className="title-info"><h2>{t('ov.activity')}</h2><InfoTip id="info-activity">{t('ov.activityInfo', { run: meta.run.run_id })}</InfoTip></div>
              <span className="chip">{t('common.days', { n: o.trend.length })}</span>
            </div>
            <div className="legend above">
              {!p.channel && <span><i className="usual-swatch" />{t('ov.expected')}</span>}
              <span><i />{t('ov.transactions')}</span><span><i style={{ background: 'var(--sev-critical)' }} />{t('ov.flaggedDays')}</span>
              {p.channel && <span className="muted">{t('ov.noExpectedChannel')}</span>}
            </div>
            {o.trend.length > 31 ? <p className="muted">{t('ov.pick31')}</p> : <PairBars drill points={o.trend} label={t('ov.activityLabel')} />}
          </section>

          <section className="panel m-rise" style={css({ '--i': 7 })}>
            <div className="panel-head"><div><h2>{t('ov.signals')}</h2><p>{t('ov.last14')}</p></div></div>
            <div className="signal-stats">
              <Link href="/intelligence" className="sig"><b className="num">{meta.run.models.v3 ? o.advisories.length : '—'}</b><span>{t('ov.sigCollective')}</span><ArrowRight aria-hidden /></Link>
              <Link href="/intelligence?tab=ml" className="sig"><b className="num">{o.mlCandidates ?? '—'}</b><span>{t('ov.sigMl')}</span><ArrowRight aria-hidden /></Link>
              <div className="sig" title={o.watchlist.map((w) => `${w.merchant} · ${w.signal}`).join('\n')}><b className="num">{o.watchlist.length}</b><span>{t('ov.sigWatch')}</span></div>
            </div>
          </section>

        </div>

        <div className="stack">
          <section className="panel tinted mix m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head flush"><div><h2>{t('ov.channels')}</h2></div></div>
            {o.channelMix.length ? <>
              <InteractivePie clearHref={o.selectedChannels.length ? qs(p, { channel: undefined }) : undefined} clearLabel={t('f.allChannels')} rows={o.channelMix.map((c) => {
                const d = change(c.value, c.prior, false, NA);
                // click: only this channel · tick or Ctrl-click: add / remove it (from "all", it starts a selection)
                const sel = new Set(o.selectedChannels);
                if (sel.has(c.label)) sel.delete(c.label); else sel.add(c.label);
                return { label: channelLabel(c.label), value: c.value, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', ink: CHANNEL_INK[c.label] ?? 'var(--ch-unknown-ink)', detail: `${fmtInt(c.value)} · ${fmtPct(c.value / totalMix, 0)}`, extra: <Delta text={d.text} tone={d.tone} />,
                  selected: o.selectedChannels.length ? c.selected : undefined,
                  href: qs(p, { channel: c.label }), toggleHref: qs(p, { channel: sel.size ? [...sel].join(',') : undefined }) };
              })} />
            </> : <EmptyState title={t('ov.noTxScope')} />}
          </section>

          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><div className="title-info"><h2>{t('ov.openIncidents')}</h2><InfoTip id="info-incidents">{t('ov.incidentsInfo')}</InfoTip></div><p>{t('ov.bySeverity')}</p></div></div>
            {o.queue.length ? <Bubbles items={o.severityMix.map((s) => ({ label: SEVERITIES[s.severity].label, value: s.value, cls: `sev-${s.severity}`, href: `/incidents?severity=${s.severity}` }))} />
              : <EmptyState title={t('ov.nothingOpen')} />}
          </section>


          {o.forecast && o.forecast.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 5 })}>
              <div className="panel-head"><div><div className="title-info"><h2>{t('ov.next7')}</h2><InfoTip id="info-forecast">{t('ov.forecastInfo')}</InfoTip></div><p>{t('ov.forecastSub')}</p></div><span className="chip">{t('ov.mae', { model: fmtNum(o.backtest.mae_model, 0), naive: fmtNum(o.backtest.mae_seasonal_naive, 0) })}</span></div>
              <ForecastBars points={o.forecast} />
              <ForecastEvidence forecast={o.forecastDetail} merchant={p.merchant} />
            </section>
          )}
        </div>
      </Balanced>
    </>
  );
}
