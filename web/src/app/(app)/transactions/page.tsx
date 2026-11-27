import { ListSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listTransactions } from '@/lib/api';
import { fmtDzd, fmtInt } from '@/lib/format';
import { CHANNEL_VAR, STATUS_VAR } from '@/lib/labels';
import { FilterForm } from '@/components/client';
import { MethodNote } from '@/components/visuals';
import { EmptyState, ExportLink, PageHeader, Pager, flat } from '@/components/ui';

export const metadata: Metadata = { title: 'Transactions' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['Accepted', 'Declined', 'Cancelled', 'Refunded', 'Unknown'];

export default function TransactionsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="Transactions" fields={7} cols={[14, 10, 16, 20, 11, 9, 8]} rows={10} />}><Transactions searchParams={searchParams} /></Suspense>;
}

async function Transactions({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const meta = getMeta();
  const res = listTransactions({ ...p, page: Number(p.page) || 1 });
  const c = meta.run.cleaning;

  return (
    <>
      <PageHeader title="Transactions">
        <ExportLink kind="transactions" params={p} />
      </PageHeader>
      <FilterForm>
        <label className="field">Merchant<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">All</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="field">Category<select name="category" defaultValue={p.category ?? ''}><option value="">All</option>{meta.categories.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Channel<select name="channel" defaultValue={p.channel ?? ''}><option value="">All</option>{meta.channels.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Status<select name="status" defaultValue={p.status ?? ''}><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="field">From<input type="date" name="from" defaultValue={p.from} min={meta.firstDate} max={meta.asOf} /></label>
        <label className="field">To<input type="date" name="to" defaultValue={p.to} min={meta.firstDate} max={meta.asOf} /></label>
        <label className="field">Quality<select name="quality" defaultValue={p.quality ?? ''}><option value="">All</option><option value="missing_amount">Missing amount</option><option value="negative_amount">Negative input amount</option><option value="invalid_amount">Invalid amount</option><option value="unknown_channel">Unknown channel</option><option value="category_imputed">Recovered category</option></select></label>
        <label className="field">Contactless<select name="contactless" defaultValue={p.contactless ?? ''}><option value="">All</option><option value="breach">Over 2,500 DZD</option><option value="within">Within limit</option></select></label>
        <label className="field">Min amount (DZD)<input type="number" name="min" min={0} step="any" inputMode="decimal" defaultValue={p.min ?? ''} style={{ minWidth: 0, width: 130 }} /></label>
        <label className="field">Max amount (DZD)<input type="number" name="max" min={0} step="any" inputMode="decimal" defaultValue={p.max ?? ''} style={{ minWidth: 0, width: 130 }} /></label>
        <label className="field">Sort<select name="sort" defaultValue={p.sort ?? ''}><option value="">Newest first</option><option value="amount_desc">Largest amount</option><option value="amount_asc">Smallest amount</option><option value="status">Status</option></select></label>
      </FilterForm>

      {res.rows.length ? (
        <div className="panel table-panel m-rise">
          <table className="data">
            <thead><tr><th>Time</th><th>Merchant</th><th>Category</th><th>Channel</th><th>Status</th><th className="r">Amount</th><th>Quality</th></tr></thead>
            <tbody>
              {res.rows.map((t) => (
                <tr key={t.id}>
                  <td className="num">{t.ts.slice(0, 16)}<br /><small className="muted">{t.id}</small></td>
                  <td><Link className="merchant" href={`/merchants/${t.merchant}`}><b>{t.merchant}</b></Link></td>
                  <td>{t.category}</td>
                  <td><span className="status"><i className="dot" style={{ background: CHANNEL_VAR[t.channel] ?? 'var(--ch-unknown)' }} />{t.channel}</span></td>
                  <td><span className="status"><i className="dot" style={{ background: STATUS_VAR[t.status] }} />{t.status}</span></td>
                  <td className="r num">{t.amount === null ? '—' : fmtDzd(t.amount)}</td>
                  <td>{t.flags.map((f) => <span key={f} className="chip warn">{f}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title="No transaction matches these filters">Try another period or reset the filters.</EmptyState>}
      <Pager page={res.page} pageSize={res.pageSize} total={res.total} params={p} path="/transactions" />

      <MethodNote label="Data cleaning">
        Cleaning kept {fmtInt(c.retained_events)} of {fmtInt(c.raw_rows)} input rows. Negative and missing amounts are excluded from monetary totals. Contactless amounts remain unchanged. High limit breach prevalence comes from synthetic data generation. <Link href="/data">Full data audit</Link>
      </MethodNote>
    </>
  );
}
