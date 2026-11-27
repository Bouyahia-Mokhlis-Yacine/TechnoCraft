import { ListSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listAnomalies, type AnomalyType } from '@/lib/api';
import { fmtDay, fmtNum } from '@/lib/format';
import { GaugeCell, MethodNote } from '@/components/visuals';
import { SEVERITIES, TYPES, observedVsExpected, LIFECYCLE } from '@/lib/labels';
import { FilterForm } from '@/components/client';
import { EmptyState, ExportLink, PageHeader, Pager, SeverityBadge, TypeLabel, flat } from '@/components/ui';

export const metadata: Metadata = { title: 'Alerts' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function AlertsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="Alerts" fields={8} cols={[9, 18, 20, 12, 20, 6]} rows={10} />}><Alerts searchParams={searchParams} /></Suspense>;
}

async function Alerts({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const meta = getMeta();
  const res = listAnomalies({ ...p, page: Number(p.page) || 1 });

  return (
    <>
      <PageHeader title="Alerts">
        <ExportLink kind="anomalies" params={p} />
      </PageHeader>
      <FilterForm>
        <label className="field">Severity<select name="severity" defaultValue={p.severity ?? ''}><option value="">All</option>{(['critical', 'high', 'medium', 'low'] as const).map((s) => <option key={s} value={s}>{SEVERITIES[s].label}</option>)}</select></label>
        <label className="field">Business criticality<select name="criticality" defaultValue={p.criticality ?? ''}><option value="">All</option><option value="high">High</option><option value="elevated">Elevated</option><option value="resolved">Resolved</option></select></label>
        <label className="field">Incident state<select name="lifecycle" defaultValue={p.lifecycle ?? ''}><option value="">All</option>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Symptom<select name="type" defaultValue={p.type ?? ''}><option value="">All</option>{(Object.keys(TYPES) as AnomalyType[]).map((t) => <option key={t} value={t}>{TYPES[t].label}</option>)}</select></label>
        <label className="field">Merchant<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">All</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="field">Category<select name="category" defaultValue={p.category ?? ''}><option value="">All</option>{meta.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Channel<select name="channel" defaultValue={p.channel ?? ''}><option value="">All</option>{meta.channels.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">From<input type="date" name="from" defaultValue={p.from} min={meta.firstDate} max={meta.asOf} /></label>
        <label className="field">To<input type="date" name="to" defaultValue={p.to} min={meta.firstDate} max={meta.asOf} /></label>
        <label className="field">Sort<select name="sort" defaultValue={p.sort ?? ''}><option value="">Newest first</option><option value="score">Highest score first</option></select></label>
      </FilterForm>

      {res.rows.length ? (
        <div className="panel table-panel m-rise">
          <table className="data">
            <thead><tr><th>Severity</th><th>Symptom</th><th>Merchant</th><th>Day</th><th className="r">Observed / expected</th><th className="r">Score</th></tr></thead>
            <tbody>
              {res.rows.map((a) => (
                <tr key={a.id}>
                  <td><Link className="cell-link" href={`/alerts/${a.id}`}><SeverityBadge severity={a.severity} /></Link></td>
                  <td><Link className="cell-link" href={`/alerts/${a.id}`}><TypeLabel type={a.type} tile /></Link></td>
                  <td><Link className="cell-link" href={`/alerts/${a.id}`}><span className="inc-cell"><b>{a.merchant}</b><small className="muted">{a.category}</small></span></Link></td>
                  <td><Link className="cell-link" href={`/alerts/${a.id}`}>{fmtDay(a.date)}</Link></td>
                  <td className="r"><Link className="cell-link" href={`/alerts/${a.id}`}><GaugeCell observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={observedVsExpected(a)} /></Link></td>
                  <td className="r num"><Link className="cell-link muted" href={`/alerts/${a.id}`}>{fmtNum(a.score, 1)}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title="No alert matches these filters">Try a wider period or reset the filters.</EmptyState>}
      <Pager page={res.page} pageSize={res.pageSize} total={res.total} params={p} path="/alerts" />
      <MethodNote>Official Sequential Detection combines instantaneous probabilistic and persistent count evidence at the frozen cutoff {meta.run.policy.high}. The gauge shows the predictive interval, expected level and observed value. Collective Detection advisories and Hybrid ML investigation candidates are available under Intelligence.</MethodNote>
    </>
  );
}
