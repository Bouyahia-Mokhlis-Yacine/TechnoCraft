import { DateRange } from '@/components/date-range';
import { notFound } from 'next/navigation';
import { ListSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listTransactions } from '@/lib/api';
import { fmtDzd, fmtInt, fmtLongDate } from '@/lib/format';
import { CHANNEL_VAR, STATUS_VAR, categoryLabel, channelLabel, qualityLabel, statusLabel } from '@/lib/labels';
import { FilterForm } from '@/components/client';
import { MethodNote } from '@/components/visuals';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import type { T } from '@/lib/i18n';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { EmptyState, ExportLink, PageHeader, Pager, flat } from '@/components/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.transactions') };
}
type SP = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['Accepted', 'Declined', 'Cancelled', 'Refunded', 'Unknown'];
const QUALITY = ['missing_amount', 'negative_amount', 'invalid_amount', 'unknown_channel', 'category_imputed'];

/** "0 transactions recorded for MER-6434 on 13 November 2026": the empty result says exactly what was searched. */
function emptyTitle(p: Record<string, string>, t: T) {
  if (!p.merchant || !p.from) return t('tx.empty');
  const when = !p.to || p.to === p.from ? t('tx.on', { date: fmtLongDate(p.from) }) : t('tx.fromTo', { from: fmtLongDate(p.from), to: fmtLongDate(p.to) });
  const what = [p.status && statusLabel(p.status).toLowerCase(), p.channel && channelLabel(p.channel)].filter(Boolean).join(' · ');
  return t('tx.emptyFor', { what: what ? ` (${what})` : '', merchant: p.merchant, when });
}

export default function TransactionsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="" fields={7} cols={[14, 10, 16, 20, 11, 9, 8]} rows={10} />}><Transactions searchParams={searchParams} /></Suspense>;
}

async function Transactions({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);
  if (!view.pinned) delete p.run;
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('nav.transactions')} /><ViewPending view={view} /></>;
  const run = view.runId ?? undefined;
  let meta: ReturnType<typeof getMeta>, res: ReturnType<typeof listTransactions>;
  try { meta = getMeta(run); res = listTransactions({ ...p, run, page: Number(p.page) || 1 }); } catch { notFound(); }
  const c = meta.run.cleaning;

  return (
    <>
      <PageHeader title={t('nav.transactions')}>
        <ExportLink kind="transactions" params={p} />
      </PageHeader>
      <ViewBanner view={view} path="/transactions" />
      <FilterForm>
        <label className="field">{t('f.merchant')}<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">{t('common.all')}</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="field">{t('f.category')}<select name="category" defaultValue={p.category ?? ''}><option value="">{t('common.all')}</option>{meta.categories.map((x) => <option key={x} value={x}>{categoryLabel(x)}</option>)}</select></label>
        <label className="field">{t('f.channel')}<select name="channel" defaultValue={p.channel ?? ''}><option value="">{t('common.all')}</option>{meta.channels.map((x) => <option key={x} value={x}>{channelLabel(x)}</option>)}</select></label>
        <label className="field">{t('f.status')}<select name="status" defaultValue={p.status ?? ''}><option value="">{t('common.all')}</option>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
        <DateRange from={p.from} to={p.to} min={meta.firstDate} max={meta.asOf} />
        <label className="field">{t('f.quality')}<select name="quality" defaultValue={p.quality ?? ''}><option value="">{t('common.all')}</option>{QUALITY.map((q) => <option key={q} value={q}>{qualityLabel(q)}</option>)}</select></label>
        <label className="field">{t('f.min')}<input type="number" name="min" min={0} step="any" inputMode="decimal" defaultValue={p.min ?? ''} /></label>
        <label className="field">{t('f.max')}<input type="number" name="max" min={0} step="any" inputMode="decimal" defaultValue={p.max ?? ''} /></label>
        <label className="field">{t('f.sort')}<select name="sort" defaultValue={p.sort ?? ''}><option value="">{t('f.newest')}</option><option value="amount_desc">{t('f.largest')}</option><option value="amount_asc">{t('f.smallest')}</option><option value="status">{t('f.status')}</option></select></label>
      </FilterForm>

      {res.rows.length ? (
        <div className="panel table-panel m-rise">
          <p className="table-count muted">{t('tx.count', { n: res.total })}{res.value !== null ? ` · ${t('tx.acceptedValue', { value: fmtDzd(res.value) })}` : ''}</p>
          <table className="data">
            <thead><tr><th>{t('tx.timeCol')}</th><th>{t('tx.merchant')}</th><th>{t('tx.category')}</th><th>{t('tx.channel')}</th><th>{t('tx.status')}</th><th className="r">{t('tx.amount')}</th><th>{t('f.quality')}</th></tr></thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.ts.slice(0, 16)}<br /><small className="muted">{r.id}</small></td>
                  <td><Link className="merchant" href={keepRun(`/merchants/${r.merchant}`, view)}><b>{r.merchant}</b></Link></td>
                  <td>{categoryLabel(r.category)}</td>
                  <td><span className="status"><i className="dot" style={{ background: CHANNEL_VAR[r.channel] ?? 'var(--ch-unknown)' }} />{channelLabel(r.channel)}</span></td>
                  <td><span className="status"><i className="dot" style={{ background: STATUS_VAR[r.status] }} />{statusLabel(r.status)}</span></td>
                  <td className="r num">{r.amount === null ? '—' : fmtDzd(r.amount)}</td>
                  <td>{r.flags.map((f) => <span key={f} className="chip warn">{qualityLabel(f)}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title={emptyTitle(p, t)}>{p.merchant && p.from ? t('tx.emptyKept') : t('tx.emptyHint')}</EmptyState>}
      <Pager page={res.page} pageSize={res.pageSize} total={res.total} params={p} path="/transactions" />

      <MethodNote label={t('tx.cleaningLabel')}>
        {t('tx.cleaningNote', { kept: fmtInt(c.retained_events), raw: fmtInt(c.raw_rows) })} <Link href="/data">{t('tx.fullAudit')}</Link>
      </MethodNote>
    </>
  );
}
