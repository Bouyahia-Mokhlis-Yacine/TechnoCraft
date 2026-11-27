import { ListSkeleton } from '@/components/skeletons';
import { healthBand, healthScore } from '@/lib/insights';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listMerchants } from '@/lib/api';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { FilterForm } from '@/components/client';
import { Sparkline } from '@/components/charts';
import { GaugeCell } from '@/components/visuals';
import { CHANNEL_VAR } from '@/lib/labels';
import { EmptyState, PageHeader, SeverityBadge, flat } from '@/components/ui';

export const metadata: Metadata = { title: 'Merchants' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function MerchantsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="Merchants" fields={3} cols={[16, 15, 6, 9, 8, 18, 7, 8, 12]} rows={10} actions={0} />}><Merchants searchParams={searchParams} /></Suspense>;
}

async function Merchants({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const rows = listMerchants(p);
  const meta = getMeta();
  return (
    <>
      <PageHeader title="Merchants" />
      <FilterForm>
        <label className="field">Search<input type="search" name="q" defaultValue={p.q} placeholder="MER-… or category, then Enter" /></label>
        <label className="field">Category
          <select name="category" defaultValue={p.category ?? ''}>
            <option value="">All</option>
            {meta.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">Sort
          <select name="sort" defaultValue={p.sort ?? ''}>
            <option value="">Needs attention first</option>
            <option value="volume">Busiest first</option>
            <option value="declines">Highest decline rate</option>
            <option value="id">Merchant ID</option>
          </select>
        </label>
      </FilterForm>

      {rows.length ? (
        <div className="panel table-panel m-rise">
          <table className="data tight">
            <thead><tr><th>Merchant</th><th>Main channel</th><th className="r">Tx / day</th><th className="r">Value / day</th><th className="r">Declines</th><th className="r">Latest / expected</th><th className="r">Health</th><th>Open</th><th style={{ width: 110 }}>Last 30 days</th></tr></thead>
            <tbody>
              {rows.map((m, i) => (
                <tr key={m.id}>
                  <td><Link className="cell-link" href={`/merchants/${m.id}`}><span className="inc-cell"><span><b>{m.id}</b> {m.isNew && <span className="chip">New</span>} {m.learning && <span className="chip" title="Still building its reference: count alerts start after 7 days of history">Learning</span>}</span><small className="muted">{m.category}</small></span></Link></td>
                  <td>{(() => { const [ch, share] = m.topChannel.split(' · '); return <span className="ch-cell" title={m.topChannel}><i className="dot" style={{ background: CHANNEL_VAR[ch] ?? 'var(--ch-unknown)' }} />{ch.split(' (')[0].split(' / ')[0]}<span className="muted num">{share}</span></span>; })()}</td>
                  <td className="r num">{fmtNum(m.avgDaily, 1)}</td>
                  <td className="r num">{fmtCompactDzd(m.avgValue)}</td>
                  <td className="r num">{fmtPct(m.declineRate, 1)}</td>
                  <td className="r">{m.lastExpected !== null ? <GaugeCell observed={m.lastDay} expected={m.lastExpected} unit="tx" severity={m.worst ?? 'normal'} label={`${fmtInt(m.lastDay)} transactions on the latest day vs ${fmtInt(m.lastExpected)} expected`} /> : <span className="num">{fmtInt(m.lastDay)}</span>}</td>
                  <td className="r">{(() => { const h = healthScore(m.id); const b = healthBand(h.score); return <span className={`hs hm-${b} num`} title={h.parts.map((p) => `${p.label}: ${p.level}`).join(' · ')}><i aria-hidden />{h.score ?? '—'}</span>; })()}</td>
                  <td>{m.worst ? <span className="row"><SeverityBadge severity={m.worst} />{m.openIncidents > 1 && <span className="muted">×{m.openIncidents}</span>}</span> : <span className="muted">—</span>}</td>
                  <td><Sparkline values={m.spark} delay={Math.min(i, 12) * 30} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title="No merchant matches">Check the spelling or reset the filters.</EmptyState>}
    </>
  );
}
