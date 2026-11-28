import { DateRange } from '@/components/date-range';
import { notFound } from 'next/navigation';
import { ListSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listAnomalies, type AnomalyType } from '@/lib/api';
import { fmtDay, fmtNum } from '@/lib/format';
import { GaugeCell, MethodNote } from '@/components/visuals';
import { SEVERITIES, TYPES, observedVsExpected, LIFECYCLE, categoryLabel, channelLabel } from '@/lib/labels';
import { FilterForm } from '@/components/client';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { EmptyState, ExportLink, PageHeader, Pager, SeverityBadge, TypeLabel, flat } from '@/components/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.alerts') };
}
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function AlertsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="" fields={8} cols={[9, 18, 20, 12, 20, 6]} rows={10} />}><Alerts searchParams={searchParams} /></Suspense>;
}

async function Alerts({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);
  if (!view.pinned) delete p.run;
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('nav.alerts')} /><ViewPending view={view} /></>;
  const run = view.runId ?? undefined;
  let meta: ReturnType<typeof getMeta>, res: ReturnType<typeof listAnomalies>;
  try { meta = getMeta(run); res = listAnomalies({ ...p, run, page: Number(p.page) || 1 }); } catch { notFound(); }
  const alertHref = (id: string) => keepRun(`/alerts/${id}`, view);

  return (
    <>
      <PageHeader title={t('nav.alerts')}>
        <ExportLink kind="anomalies" params={p} />
      </PageHeader>
      <ViewBanner view={view} path="/alerts" />
      <FilterForm>
        <label className="field">{t('f.severity')}<select name="severity" defaultValue={p.severity ?? ''}><option value="">{t('common.all')}</option>{(['critical', 'high', 'medium', 'low'] as const).map((s) => <option key={s} value={s}>{SEVERITIES[s].label}</option>)}</select></label>
        <label className="field">{t('f.criticality')}<select name="criticality" defaultValue={p.criticality ?? ''}><option value="">{t('common.all')}</option><option value="high">{t('criticality.high')}</option><option value="elevated">{t('criticality.elevated')}</option><option value="resolved">{t('criticality.resolved')}</option></select></label>
        <label className="field">{t('f.incidentState')}<select name="lifecycle" defaultValue={p.lifecycle ?? ''}><option value="">{t('common.all')}</option>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">{t('f.symptom')}<select name="type" defaultValue={p.type ?? ''}><option value="">{t('common.all')}</option>{(Object.keys(TYPES) as AnomalyType[]).map((k) => <option key={k} value={k}>{TYPES[k].label}</option>)}</select></label>
        <label className="field">{t('f.merchant')}<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">{t('common.all')}</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="field">{t('f.category')}<select name="category" defaultValue={p.category ?? ''}><option value="">{t('common.all')}</option>{meta.categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</select></label>
        <label className="field">{t('f.channel')}<select name="channel" defaultValue={p.channel ?? ''}><option value="">{t('common.all')}</option>{meta.channels.map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}</select></label>
        <DateRange from={p.from} to={p.to} min={meta.firstDate} max={meta.asOf} />
        <label className="field">{t('f.sort')}<select name="sort" defaultValue={p.sort ?? ''}><option value="">{t('f.newest')}</option><option value="score">{t('f.highestScore')}</option></select></label>
      </FilterForm>

      {res.rows.length ? (
        <div className="panel table-panel m-rise">
          <table className="data">
            <thead><tr><th>{t('f.severity')}</th><th>{t('f.symptom')}</th><th>{t('f.merchant')}</th><th>{t('al.day')}</th><th className="r">{t('al.obsExp')}</th><th className="r">{t('al.score')}</th></tr></thead>
            <tbody>
              {res.rows.map((a) => (
                <tr key={a.id}>
                  <td><Link className="cell-link" href={alertHref(a.id)}><SeverityBadge severity={a.severity} /></Link></td>
                  <td><Link className="cell-link" href={alertHref(a.id)}><TypeLabel type={a.type} tile /></Link></td>
                  <td><Link className="cell-link" href={alertHref(a.id)}><span className="inc-cell"><b>{a.merchant}</b><small className="muted">{categoryLabel(a.category)}</small></span></Link></td>
                  <td><Link className="cell-link" href={alertHref(a.id)}>{fmtDay(a.date)}</Link></td>
                  <td className="r"><Link className="cell-link" href={alertHref(a.id)}><GaugeCell observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={observedVsExpected(a)} /></Link></td>
                  <td className="r num"><Link className="cell-link muted" href={alertHref(a.id)}>{fmtNum(a.score, 1)}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title={t('al.empty')}>{t('al.emptyHint')}</EmptyState>}
      <Pager page={res.page} pageSize={res.pageSize} total={res.total} params={p} path="/alerts" />
      <MethodNote>{t('al.method', { cutoff: fmtNum(meta.run.policy.high, 4) })}</MethodNote>
    </>
  );
}
