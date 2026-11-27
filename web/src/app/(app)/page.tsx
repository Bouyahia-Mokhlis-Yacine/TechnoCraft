import { OverviewSkeleton } from '@/components/skeletons';
import { InteractivePie } from '@/components/charts-client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, Ban, Banknote, CreditCard, Receipt, Sigma, Siren, Store } from 'lucide-react';
import { getMeta, getOverview } from '@/lib/api';
import { fmtDay, fmtDelta, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { CHANNEL_INK, CHANNEL_VAR, SEVERITIES } from '@/lib/labels';
import { CountUp, FilterForm } from '@/components/client';
import { listClusters } from '@/lib/insights';
import { addDays } from '@/lib/model';
import { Bubbles, ForecastBars, KpiChart, PairBars } from '@/components/charts';
import { KpiEditor } from '@/components/kpi-editor';
import { DEFAULT_KPIS, evaluate, parse } from '@/lib/formula';
import { currentUser } from '@/lib/session';
import { Delta, EmptyState, IconTile, InfoTip, PageHeader, flat } from '@/components/ui';

type SP = Promise<Record<string, string | string[] | undefined>>;
/** The overview URL with some filters changed (undefined removes one). */
const qs = (p: Record<string, string | undefined>, change: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries({ ...p, ...change }).filter(([, v]) => v) as [string, string][]).toString();
  return q ? `/?${q}` : '/';
};
const css = (o: Record<string, string | number>) => o as React.CSSProperties;
type Tone = 'good' | 'bad' | 'flat';
/** Change vs the prior period; N/A when there is no comparable period or the denominator is zero (FR-19). */
const change = (v: number | null, p: number | null, lowerIsBetter = false): { text: string; tone: Tone } => {
  if (v === null || p === null || p === 0) return { text: 'N/A', tone: 'flat' };
  const r = v / p, tone: Tone = Math.abs(r - 1) < 0.05 ? 'flat' : (r > 1) !== lowerIsBetter ? 'good' : 'bad';
  return { text: fmtDelta(v, p), tone };
};

export default function OverviewPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<OverviewSkeleton />}><Overview searchParams={searchParams} /></Suspense>;
}

async function Overview({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const meta = getMeta();
  const o = getOverview(p);
  const k = o.kpis;
  const prior = o.priorScope ? `vs ${fmtDay(o.priorScope.from)}–${fmtDay(o.priorScope.to)}` : 'no prior period in the data';
  // the account's own KPI cards (Customize), defaults to the original six; each is a formula over named measures
  const user = await currentUser();
  const kpis = user?.kpis ?? DEFAULT_KPIS;
  const ICON: Record<string, typeof Receipt> = { transactions: Receipt, 'accepted-value': Banknote, 'attempted-value': CreditCard, 'decline-rate': Ban, 'merchants-flagged': Store, 'open-incidents': Siren };
  const NOTE: Record<string, string> = { transactions: prior, 'accepted-value': 'accepted payments', 'attempted-value': 'all non-refund payments', 'decline-rate': 'of all events', 'merchants-flagged': 'flagged in the period' };
  const cards = kpis.map((c) => {
    const f = parse(c.formula);
    const at = (v: typeof o.measures.cur | null) => (f.ok && v ? evaluate(f.tree, v) : null);
    const value = at(o.measures.cur), before = at(o.measures.prior);
    const d = c.formula === 'open_incidents'
      ? { text: k.openIncidents.critical ? `${k.openIncidents.critical} critical` : 'none critical', tone: (k.openIncidents.critical ? 'bad' : 'good') as Tone }
      : c.good === 'none' ? { ...change(value, before), tone: 'flat' as Tone } : change(value, before, c.good === 'down');
    const isDefault = DEFAULT_KPIS.some((x) => x.id === c.id && x.formula === c.formula);
    return {
      ...c, icon: ICON[c.id] ?? Sigma, value, d,
      note: c.formula === 'open_incidents' ? 'active or recovering' : isDefault && NOTE[c.id] ? NOTE[c.id] : `= ${c.formula}`,
      series: c.chart === 'number' || !f.ok ? [] : o.measures.daily.map((v) => evaluate(f.tree, v)),
    };
  });
  const clusters = (listClusters()?.clusters ?? []).filter((c) => c.date >= addDays(o.scope.to, -13) && c.date <= o.scope.to).length;
  const totalMix = o.channelMix.reduce((s, c) => s + c.value, 0) || 1;
  const multi = o.selectedChannels.length > 1;

  return (
    <>
      <PageHeader title="Network overview"><KpiEditor initial={kpis} /></PageHeader>

      <FilterForm>
        <label className="field">From<input type="date" name="from" defaultValue={o.scope.from} min={meta.firstDate} max={meta.asOf} /></label>
        <label className="field">To<input type="date" name="to" defaultValue={o.scope.to} min={meta.firstDate} max={meta.asOf} /></label>
        <label className="field">Category<select name="category" defaultValue={p.category ?? ''}><option value="">All categories</option>{meta.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Channel<select name="channel" defaultValue={p.channel ?? ''}><option value="">All channels</option>{multi && <option value={p.channel}>{o.selectedChannels.length} channels selected</option>}{meta.channels.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Merchant<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">All merchants</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
      </FilterForm>

      <div className="ov">
        <div className="stack">
          <div className="kpi-grid three">
            {cards.map((c, i) => (
              <div key={c.id} className={`kpi m-rise${i === 0 ? ' hero' : ''}`} style={css({ '--i': i })}>
                <IconTile icon={c.icon} tone={i === 0 ? 'hero' : 'plain'} />
                <Delta text={c.d.text} tone={c.d.tone} />
                <span className="kpi-label">{c.label}</span>
                <span className="kpi-line">{c.value === null ? <span className="kpi-value" title="No value: a measure is missing or a division by zero">—</span> : <CountUp value={c.value} kind={c.format} />}</span>
                {c.chart !== 'number' && c.chart && <KpiChart values={c.series} type={c.chart} label={`${c.label}, per day`} />}
                <span className="kpi-note wide">{c.note}</span>
              </div>
            ))}
          </div>

          <section className="panel m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head">
              <div className="title-info"><h2>Network activity</h2><InfoTip id="info-activity">Daily transactions next to the expected level. The expected level is a statistical reference from the engine (each merchant’s usual activity for that kind of day), not a target. Figures from engine run {meta.run.run_id}.</InfoTip></div>
              <span className="chip">{o.trend.length} days</span>
            </div>
            <div className="legend above">
              {!p.channel && <span><i className="usual-swatch" />Expected</span>}
              <span><i />Transactions</span><span><i style={{ background: 'var(--sev-critical)' }} />Flagged merchant-days</span>
              {p.channel && <span className="muted">No expected level with a channel filter</span>}
            </div>
            {o.trend.length > 31 ? <p className="muted">Pick 31 days or fewer to see daily bars.</p> : <PairBars drill points={o.trend} label="Daily transactions in the selected period next to the expected level" />}
          </section>

          <section className="panel m-rise" style={css({ '--i': 7 })}>
            <div className="panel-head"><div><h2>Signals</h2><p>Last 14 days</p></div></div>
            <div className="signal-stats">
              <Link href="/intelligence" className="sig"><b className="num">{o.advisories.length}</b><span>network advisor{o.advisories.length === 1 ? 'y' : 'ies'}</span><ArrowRight aria-hidden /></Link>
              <Link href="/intelligence" className="sig"><b className="num">{clusters}</b><span>collective anomal{clusters === 1 ? 'y' : 'ies'}</span><ArrowRight aria-hidden /></Link>
              <div className="sig" title={o.watchlist.map((w) => `${w.merchant} · ${w.signal}`).join('\n')}><b className="num">{o.watchlist.length}</b><span>on watch, below the alert threshold{o.watchlist.length ? ` · ${o.watchlist.slice(0, 3).map((w) => w.merchant).join(', ')}` : ''}</span></div>
            </div>
          </section>

        </div>

        <div className="stack">
          <section className="panel tinted mix m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head flush"><div><h2>Channels</h2></div></div>
            {o.channelMix.length ? <>
              <InteractivePie clearHref={o.selectedChannels.length ? qs(p, { channel: undefined }) : undefined} clearLabel="All channels" rows={o.channelMix.map((c) => {
                const d = change(c.value, c.prior);
                // click: only this channel · tick or Ctrl-click: add / remove it (from "all", it starts a selection)
                const sel = new Set(o.selectedChannels);
                if (sel.has(c.label)) sel.delete(c.label); else sel.add(c.label);
                return { label: c.label, value: c.value, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', ink: CHANNEL_INK[c.label] ?? 'var(--ch-unknown-ink)', detail: `${fmtInt(c.value)} · ${fmtPct(c.value / totalMix, 0)}`, extra: <Delta text={d.text} tone={d.tone} />,
                  selected: o.selectedChannels.length ? c.selected : undefined,
                  href: qs(p, { channel: c.label }), toggleHref: qs(p, { channel: sel.size ? [...sel].join(',') : undefined }) };
              })} />
            </> : <EmptyState title="No transaction in this scope" />}
          </section>

          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><div className="title-info"><h2>Open incidents</h2><InfoTip id="info-incidents">Severity says how far activity is from normal and for how long; critical is handled first. In the queue, priority = 100 × (0.4 impact + 0.3 urgency + 0.2 evidence + 0.1 actionability).</InfoTip></div><p>Network-wide, by severity</p></div></div>
            {o.queue.length ? <Bubbles items={o.severityMix.map((s) => ({ label: SEVERITIES[s.severity].label, value: s.value, cls: `sev-${s.severity}`, href: `/incidents?severity=${s.severity}` }))} />
              : <EmptyState title="Nothing open" />}
          </section>


          {o.forecast && o.forecast.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 5 })}>
              <div className="panel-head"><div><div className="title-info"><h2>Next 7 days</h2><InfoTip id="info-forecast">An advisory forecast with its 80 % interval: a statistical reference, not a target, and it never raises alerts. MAE is the average daily error on past weeks, next to a seasonal naive forecast.</InfoTip></div><p>Advisory forecast · 80 % interval</p></div><span className="chip">MAE {fmtNum(o.backtest.mae_model, 0)} vs {fmtNum(o.backtest.mae_seasonal_naive, 0)} naive</span></div>
              <ForecastBars points={o.forecast} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
