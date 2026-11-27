import { ListSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listIncidents } from '@/lib/api';
import { fmtCompactDzd, fmtDay, fmtInt } from '@/lib/format';
import { LIFECYCLE, REVIEW, SEVERITIES } from '@/lib/labels';
import { FilterForm } from '@/components/client';
import { MethodNote } from '@/components/visuals';
import { EmptyState, ExportLink, LifecycleChip, PageHeader, ReviewChip, SeverityBadge, TypeLabel, flat } from '@/components/ui';

export const metadata: Metadata = { title: 'Incidents' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function IncidentsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="Incidents" fields={5} cols={[6, 7, 22, 9, 10, 7, 15, 13]} rows={2} />}><Incidents searchParams={searchParams} /></Suspense>;
}

async function Incidents({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const rows = listIncidents(p);
  const meta = getMeta();
  return (
    <>
      <PageHeader title="Incidents">
        <ExportLink kind="incidents" params={p} />
      </PageHeader>
      <FilterForm>
        <label className="field">Show<select name="scope" defaultValue={p.scope ?? ''}><option value="">Open (ranked)</option><option value="all">All</option><option value="closed">Closed or resolved</option></select></label>
        <label className="field">Lifecycle<select name="lifecycle" defaultValue={p.lifecycle ?? ''}><option value="">Any</option>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Review<select name="status" defaultValue={p.status ?? ''}><option value="">Any</option>{Object.entries(REVIEW).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Severity<select name="severity" defaultValue={p.severity ?? ''}><option value="">Any</option>{(['critical', 'high', 'medium', 'low'] as const).map((s) => <option key={s} value={s}>{SEVERITIES[s].label}</option>)}</select></label>
        <label className="field">Merchant<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">All</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
      </FilterForm>
      {rows.length ? (
        <div className="panel table-panel m-rise">
          <table className="data">
            <thead><tr><th className="r">Rank</th><th className="r">Priority</th><th>Incident</th><th>Severity</th><th>State</th><th>Review</th><th>Period</th><th className="r">Exposure</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="r"><Link className="cell-link" href={`/incidents/${i.id}`}><b>{i.rank ?? '–'}</b></Link></td>
                  <td className="r"><Link className="cell-link" href={`/incidents/${i.id}`}><b className="prio-num" title="Priority score (0–100)">{i.priority}</b></Link></td>
                  <td><Link className="cell-link" href={`/incidents/${i.id}`}><span className="inc-cell"><span className="merchant"><b>{i.merchant}</b> <span className="muted">{i.id}</span></span><TypeLabel type={i.type} /></span></Link></td>
                  <td><SeverityBadge severity={i.severity} /></td>
                  <td><LifecycleChip l={i.lifecycle} /></td>
                  <td><ReviewChip s={i.review.status} escalated={i.review.escalated} />{i.review.owner && <span className="muted"> {i.review.owner}</span>}</td>
                  <td className="num">{i.days > 1 ? `${fmtDay(i.onset)} → ${fmtDay(i.end)} (${i.days} d)` : fmtDay(i.onset)}</td>
                  <td className="r num">{fmtInt(i.affectedEvents)} tx · {fmtCompactDzd(i.valueExposure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title="No incident matches">Try “All” or reset the filters.</EmptyState>}
      <MethodNote>Impact combines forecast volume, payment outcome and observed ticket history. Priority uses the backend’s evaluated multi-criteria policy. Open an incident to see the drivers, uncertainty and provisional assumptions.</MethodNote>
    </>
  );
}
