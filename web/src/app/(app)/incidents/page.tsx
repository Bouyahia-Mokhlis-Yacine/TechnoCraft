import { ListSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listIncidents } from '@/lib/api';
import { fmtCompactDzd, fmtDay, fmtInt } from '@/lib/format';
import { LIFECYCLE, REVIEW, SEVERITIES } from '@/lib/labels';
import { engineText } from '@/lib/i18n/engine';
import { FilterForm } from '@/components/client';
import { MethodNote } from '@/components/visuals';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { EmptyState, ExportLink, LifecycleChip, PageHeader, ReviewChip, SeverityBadge, TypeLabel, flat } from '@/components/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.incidents') };
}
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function IncidentsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="" fields={5} cols={[6, 7, 22, 9, 10, 7, 15, 13]} rows={2} />}><Incidents searchParams={searchParams} /></Suspense>;
}

async function Incidents({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);
  if (!view.pinned) delete p.run;
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('nav.incidents')} /><ViewPending view={view} /></>;
  const run = view.runId;
  const rows = listIncidents(p, run);
  const meta = getMeta(run);
  const href = (id: string) => keepRun(`/incidents/${id}`, view);
  return (
    <>
      <PageHeader title={t('nav.incidents')}>
        <ExportLink kind="incidents" params={p} />
      </PageHeader>
      <ViewBanner view={view} path="/incidents" />
      <FilterForm>
        <label className="field">{t('f.show')}<select name="scope" defaultValue={p.scope ?? ''}><option value="">{t('f.openRanked')}</option><option value="all">{t('common.all')}</option><option value="closed">{t('f.closedResolved')}</option></select></label>
        <label className="field">{t('f.lifecycle')}<select name="lifecycle" defaultValue={p.lifecycle ?? ''}><option value="">{t('common.any')}</option>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {view.kind === 'official' && <label className="field">{t('f.review')}<select name="status" defaultValue={p.status ?? ''}><option value="">{t('common.any')}</option>{Object.entries(REVIEW).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
        <label className="field">{t('f.severity')}<select name="severity" defaultValue={p.severity ?? ''}><option value="">{t('common.any')}</option>{(['critical', 'high', 'medium', 'low'] as const).map((s) => <option key={s} value={s}>{SEVERITIES[s].label}</option>)}</select></label>
        <label className="field">{t('f.merchant')}<select name="merchant" defaultValue={p.merchant ?? ''}><option value="">{t('common.all')}</option>{meta.merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="field">{t('f.sortBy')}<select name="sort" defaultValue={p.sort ?? ''}><option value="">{t('f.priority')}</option><option value="severity">{t('f.statSeverity')}</option><option value="impact">{t('f.impact')}</option><option value="duration">{t('f.duration')}</option></select></label>
      </FilterForm>
      {rows.length ? (
        <div className="panel table-panel m-rise">
          <table className="data">
            <thead><tr><th className="r">{t('inc.rank')}</th><th className="r">{t('inc.priorityCol')}</th><th>{t('inc.incident')}</th><th>{t('f.severity')}</th><th>{t('inc.state')}</th>{view.kind === 'official' && <th>{t('f.review')}</th>}<th>{t('inc.period')}</th><th className="r">{t('inc.exposure')}</th><th>{t('inc.whoActs')}</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="r"><Link className="cell-link" href={href(i.id)}><b>{i.rank ?? '–'}</b></Link></td>
                  <td className="r"><Link className="cell-link" href={href(i.id)}><b className="prio-num" title={t('inc.priorityTitle')}>{i.priority}</b></Link></td>
                  <td><Link className="cell-link" href={href(i.id)}><span className="inc-cell"><span className="merchant"><b>{i.merchant}</b> <span className="muted">{i.id}</span></span><TypeLabel type={i.type} /></span></Link></td>
                  <td><SeverityBadge severity={i.severity} /></td>
                  <td><LifecycleChip l={i.lifecycle} /></td>
                  {view.kind === 'official' && <td><ReviewChip s={i.review.status} escalated={i.review.escalated} />{i.review.owner && <span className="muted"> {i.review.owner}</span>}</td>}
                  <td className="num">{i.days > 1 ? `${fmtDay(i.onset)} → ${fmtDay(i.end)} (${t('inc.daysShort', { n: i.days })})` : fmtDay(i.onset)}</td>
                  <td className="r num">{t('inc.exposureValue', { tx: fmtInt(i.affectedEvents), value: fmtCompactDzd(i.valueExposure) })}</td>
                  <td className="who-acts"><b>{engineText(i.evidence.responsible_role)}</b><small className="muted">{engineText(i.evidence.first_action)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState title={t('inc.empty')}>{t('inc.emptyHint')}</EmptyState>}
      <MethodNote>{t('inc.method')}</MethodNote>
    </>
  );
}
