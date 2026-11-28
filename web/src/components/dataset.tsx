// Server pieces of the active dataset: the header control, the banner on data pages, and the
// placeholder shown while a selection's first combined analysis runs.
import Link from 'next/link';
import { Layers, Loader2, XCircle } from 'lucide-react';
import { resolveViewOrNull, type View } from '@/lib/dataset';
import { shownName } from '@/lib/collection-name';
import { getMeta } from '@/lib/api';
import { fmtRange } from '@/lib/format';
import { getT } from '@/lib/i18n/server';
import { DatasetMenu, ViewWatcher } from './dataset-client';

export async function DatasetControl() {
  let view: View | null;
  try { view = await resolveViewOrNull(); } catch { return null; }
  if (!view) return <DatasetMenu kind="empty" names={[]} combined={false} running={false} />;
  return <DatasetMenu kind={view.kind} names={view.names} combined={view.combined} running={view.state === 'running'} />;
}

/** "Combined view · 3 collections" (names, dates, analysis version) above a page's data. */
export async function ViewBanner({ view, path }: { view: View; path: string }) {
  if (view.kind === 'archive') return null;
  const t = await getT();
  view = { ...view, names: view.names.map((n) => shownName(n, t('ds.satimName'))) };
  let range = '';
  try { const m = getMeta(view.runId); range = fmtRange(m.firstDate, m.asOf); } catch { /* shown without dates */ }
  const label = view.combined ? t('ds.combined', { n: view.ids.length }) : t('ds.collection', { name: view.names[0] });
  const running = view.state === 'running' && view.status && !view.pinned;
  return (
    <div className={`run-banner view-banner${view.state !== 'ready' ? ' is-stale' : ''}`} role="note">
      <Layers aria-hidden />
      <b>{label}</b>
      <span className="muted">{view.combined ? `${view.names.join(', ')} · ` : ''}{range}{view.runId ? ` · ${t('view.version', { id: view.runId.slice(0, 8) })}` : ''}</span>
      {view.state === 'running' && !view.pinned && <span className="view-note"><Loader2 className="spin" aria-hidden />{t('view.runningPrevious')}{running && <ViewWatcher runId={view.status!.run_id} />}</span>}
      {view.state === 'failed' && !view.pinned && <span className="view-note err"><XCircle aria-hidden />{t('view.failedPrevious')}</span>}
      {view.pinned && <Link href={path}>{t('view.openCurrent')}</Link>}
      <Link href="/data#collections">{t('ds.manage')} ›</Link>
    </div>
  );
}

/** Nothing to show yet: the selection's analysis is running (or failed) and no earlier result exists. */
export async function ViewPending({ view }: { view: View }) {
  const t = await getT();
  view = { ...view, names: view.names.map((n) => shownName(n, t('ds.satimName'))) };
  const label = view.combined ? t('ds.combined', { n: view.ids.length }) : t('ds.collection', { name: view.names[0] });
  return (
    <section className="panel view-pending m-rise" role="status">
      {view.state === 'failed' ? <XCircle aria-hidden /> : <Loader2 className="spin" aria-hidden />}
      <div>
        <b>{view.state === 'failed' ? t('view.failedTitle', { label }) : t('view.pendingTitle', { label })}</b>
        <p className="muted">{view.names.join(', ')}{view.state === 'running' && view.status && <ViewWatcher runId={view.status.run_id} />}</p>
        <p>{view.state === 'failed' ? t('view.failedBody') : t('view.pendingBody')}</p>
        <Link className="btn btn-secondary" href="/data#collections">{t('ds.manage')}</Link>
      </div>
    </section>
  );
}
