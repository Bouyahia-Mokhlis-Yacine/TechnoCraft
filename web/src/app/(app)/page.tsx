import { OverviewSkeleton } from '@/components/skeletons';
import { InteractivePie } from '@/components/charts-client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, Ban, Banknote, CreditCard, Receipt, Siren, Store } from 'lucide-react';
import { getMeta, getOverview } from '@/lib/api';
import { fmtCompactDzd, fmtDay, fmtDelta, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { CHANNEL_VAR, SEVERITIES, fmtKind } from '@/lib/labels';
import { CountUp, FilterForm } from '@/components/client';
import { ForecastEvidence } from '@/components/satim-evidence';
import { MethodNote } from '@/components/visuals';
import { Bubbles, ForecastBars, PairBars } from '@/components/charts';
import { Delta, EmptyState, IconTile, PageHeader, flat } from '@/components/ui';

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
  const cards = [
    { label: 'Transactions', icon: Receipt, value: k.events.value, kind: 'int' as const, d: change(k.events.value, k.events.prior), note: prior },
    { label: 'Accepted value', icon: Banknote, value: k.acceptedValue.value ?? k.acceptedValue.knownValue, kind: 'dzd' as const, d: change(k.acceptedValue.value, k.acceptedValue.prior), note: k.acceptedValue.missingEvents ? `Partial · ${fmtInt(k.acceptedValue.missingEvents)} amounts unavailable` : 'accepted payments' },
    { label: 'Attempted value', icon: CreditCard, value: k.attemptedValue.value ?? k.attemptedValue.knownValue, kind: 'dzd' as const, d: change(k.attemptedValue.value, k.attemptedValue.prior), note: k.attemptedValue.missingEvents ? `Partial · ${fmtInt(k.attemptedValue.missingEvents)} amounts unavailable` : 'all non-refund payments' },
    { label: 'Decline rate', icon: Ban, value: k.declineRate.value, kind: 'pct' as const, d: change(k.declineRate.value, k.declineRate.prior, true), note: k.declineRate.value === null ? 'no transactions' : `Cancellation rate ${fmtPct(k.cancellationRate.value)}` },
    { label: 'Merchants with alerts', icon: Store, value: k.affectedMerchants.value, kind: 'int' as const, d: change(k.affectedMerchants.value, k.affectedMerchants.prior, true), note: 'flagged in the period' },
    { label: 'Open incidents', icon: Siren, value: k.openIncidents.value, kind: 'int' as const, d: { text: k.openIncidents.critical ? `${k.openIncidents.critical} critical` : 'none critical', tone: (k.openIncidents.critical ? 'bad' : 'good') as Tone }, note: 'active or recovering' },
  ];
  const totalMix = o.channelMix.reduce((s, c) => s + c.value, 0) || 1;
  const multi = o.selectedChannels.length > 1;

  return (
    <>
      <PageHeader title="Network overview" />
      <p className="muted">{meta.run.parity.sealed ? 'Historical competition archive' : 'Unsealed replay preview'} · data through {fmtDay(meta.asOf)} · batch {meta.run.batch_status}</p>

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
              <div key={c.label} className={`kpi m-rise${i === 0 ? ' hero' : ''}`} style={css({ '--i': i })}>
                <IconTile icon={c.icon} tone={i === 0 ? 'hero' : 'plain'} />
                <Delta text={c.d.text} tone={c.d.tone} />
                <span className="kpi-label">{c.label}</span>
                <span className="kpi-line">{c.value === null ? 'n/a' : <CountUp value={c.value} kind={c.kind} />}</span>
                <span className="kpi-note wide">{c.note}</span>
              </div>
            ))}
          </div>

          <section className="panel m-rise" style={css({ '--i': 6 })}>
            <div className="panel-head">
              <div><h2>Network activity</h2></div>
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
              <Link href="/intelligence" className="sig"><b className="num">{meta.run.models.v3 ? o.advisories.length : '—'}</b><span>V3 collective advisories</span><ArrowRight aria-hidden /></Link>
              <Link href="/intelligence#ml-candidates" className="sig"><b className="num">{o.mlCandidates ?? '—'}</b><span>V4 investigation candidates</span><ArrowRight aria-hidden /></Link>
              <div className="sig" title={o.watchlist.map((w) => `${w.merchant} · ${w.signal}`).join('\n')}><b className="num">{o.watchlist.length}</b><span>under V2 observation at data cutoff</span></div>
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
                return { label: c.label, value: c.value, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', detail: `${fmtInt(c.value)} · ${fmtPct(c.value / totalMix, 0)}`, extra: <Delta text={d.text} tone={d.tone} />,
                  selected: o.selectedChannels.length ? c.selected : undefined,
                  href: qs(p, { channel: c.label }), toggleHref: qs(p, { channel: sel.size ? [...sel].join(',') : undefined }) };
              })} />
            </> : <EmptyState title="No transaction in this scope" />}
          </section>

          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><h2>Open incidents</h2><p>Network-wide, by severity</p></div></div>
            {o.queue.length ? <Bubbles items={o.severityMix.map((s) => ({ label: SEVERITIES[s.severity].label, value: s.value, cls: `sev-${s.severity}`, href: `/incidents?severity=${s.severity}` }))} />
              : <EmptyState title="Nothing open" />}
          </section>


          {o.forecast && o.forecast.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 5 })}>
              <div className="panel-head"><div><h2>Next 7 days</h2><p>Advisory forecast · 80 % interval</p></div><span className="chip">MAE {fmtNum(o.backtest.mae_model, 0)} vs {fmtNum(o.backtest.mae_seasonal_naive, 0)} naive</span></div>
              <ForecastBars points={o.forecast} />
              <ForecastEvidence forecast={o.forecastDetail} merchant={p.merchant} />
            </section>
          )}

        </div>
      </div>
      <MethodNote label="About these numbers">Values come from engine run {meta.run.run_id}. Accepted value {fmtCompactDzd(k.acceptedValue.value)} {o.priorScope ? `(${fmtKind(k.acceptedValue.prior ?? 0, 'dzd')} in the prior period)` : ''}. Expected levels and forecasts use prior eligible activity. Cancellation rate {fmtPct(k.cancellationRate.value)} of retained events. The priority queue uses the evaluated operational criteria exposed in incident details.</MethodNote>
    </>
  );
}
