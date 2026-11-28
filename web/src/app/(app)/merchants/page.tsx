import { ListSkeleton } from '@/components/skeletons';
import { healthBand, healthScore } from '@/lib/insights';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getMeta, listMerchants } from '@/lib/api';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { ClickRows, FilterForm } from '@/components/client';
import { Sparkline } from '@/components/charts';
import { GaugeCell } from '@/components/visuals';
import { CHANNEL_VAR, categoryLabel, channelLabel } from '@/lib/labels';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { EmptyState, PageHeader, SeverityBadge, flat } from '@/components/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.merchants') };
}
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function MerchantsPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<ListSkeleton title="" fields={3} cols={[16, 15, 6, 9, 8, 18, 7, 8, 12]} rows={10} actions={0} />}><Merchants searchParams={searchParams} /></Suspense>;
}

async function Merchants({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);
  if (!view.pinned) delete p.run;
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('nav.merchants')} /><ViewPending view={view} /></>;
  const run = view.runId;
  const rows = listMerchants(p, run);
  const meta = getMeta(run);
  const href = (id: string) => keepRun(`/merchants/${id}`, view);
  const LEVEL: Record<string, string> = { ok: t('health.ok'), watch: t('health.watch'), issue: t('health.issue'), unknown: t('health.unknown') };
  return (
    <>
      <PageHeader title={t('nav.merchants')} />
      <ViewBanner view={view} path="/merchants" />
      <FilterForm>
        <label className="field">{t('common.search')}<input type="search" name="q" defaultValue={p.q} placeholder={t('mer.searchPlaceholder')} /></label>
        <label className="field">{t('f.category')}
          <select name="category" defaultValue={p.category ?? ''}>
            <option value="">{t('common.all')}</option>
            {meta.categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
          </select>
        </label>
        <label className="field">{t('f.sort')}
          <select name="sort" defaultValue={p.sort ?? ''}>
            <option value="">{t('mer.sortAttention')}</option>
            <option value="volume">{t('mer.sortBusiest')}</option>
            <option value="declines">{t('mer.sortDeclines')}</option>
            <option value="id">{t('mer.sortId')}</option>
          </select>
        </label>
      </FilterForm>

      {rows.length ? (
        <div className="panel table-panel m-rise">
          <ClickRows><table className="data tight">
            <thead><tr><th>{t('f.merchant')}</th><th>{t('mer.mainChannel')}</th><th className="r">{t('mer.txDay')}</th><th className="r">{t('mer.valueDay')}</th><th className="r">{t('mer.declines')}</th><th className="r">{t('mer.latestExpected')}</th><th className="r">{t('mer.health')}</th><th>{t('mer.open')}</th><th style={{ width: 110 }}>{t('mer.last30')}</th></tr></thead>
            <tbody>
              {rows.map((m, i) => (
                <tr key={m.id} data-href={href(m.id)}>
                  <td><Link className="cell-link" href={href(m.id)}><span className="inc-cell"><span><b>{m.id}</b> {m.isNew && <span className="chip">{t('mer.new')}</span>} {m.learning && <span className="chip" title={t('mer.learningTitle')}>{t('mer.learning')}</span>}</span><small className="muted">{categoryLabel(m.category)}</small></span></Link></td>
                  <td>{m.topChannel ? <span className="ch-cell" title={`${channelLabel(m.topChannel.channel)} · ${fmtPct(m.topChannel.share, 0)}`}><i className="dot" style={{ background: CHANNEL_VAR[m.topChannel.channel] ?? 'var(--ch-unknown)' }} />{channelLabel(m.topChannel.channel).split(' (')[0].split(' / ')[0]}<span className="muted num">{fmtPct(m.topChannel.share, 0)}</span></span> : '—'}</td>
                  <td className="r num">{fmtNum(m.avgDaily, 1)}</td>
                  <td className="r num">{fmtCompactDzd(m.avgValue)}</td>
                  <td className="r num">{fmtPct(m.declineRate, 1)}</td>
                  <td className="r">{m.lastExpected !== null ? <GaugeCell observed={m.lastDay} expected={m.lastExpected} unit="tx" severity={m.worst ?? 'normal'} label={t('mer.latestLabel', { obs: fmtInt(m.lastDay), exp: fmtInt(m.lastExpected) })} /> : <span className="num">{fmtInt(m.lastDay)}</span>}</td>
                  <td className="r">{(() => { const h = healthScore(m.id, run); const b = healthBand(h.score); return <span className={`hs hm-${b} num`} title={h.parts.map((p) => `${p.label} : ${LEVEL[p.level]}`).join(' · ')}><i aria-hidden />{h.score ?? '—'}</span>; })()}</td>
                  <td>{m.worst ? <span className="row"><SeverityBadge severity={m.worst} />{m.openIncidents > 1 && <span className="muted">×{m.openIncidents}</span>}</span> : <span className="muted">—</span>}</td>
                  <td><Sparkline values={m.spark} delay={Math.min(i, 12) * 30} /></td>
                </tr>
              ))}
            </tbody>
          </table></ClickRows>
        </div>
      ) : <EmptyState title={t('mer.empty')}>{t('mer.emptyHint')}</EmptyState>}
    </>
  );
}
