'use client';
// The active-dataset control (page header) and the watcher that refreshes a page when the analysis
// it waits for finishes.
import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Database, Layers, Loader2, RotateCcw } from 'lucide-react';
import { useT } from './i18n';
import { shownName } from '@/lib/collection-name';

export function DatasetMenu({ kind, names, combined, running }: { kind: 'archive' | 'collections' | 'empty'; names: string[]; combined: boolean; running: boolean }) {
  const t = useT(), router = useRouter(), path = usePathname(), search = useSearchParams();
  const ref = useRef<HTMLDetailsElement>(null);
  const [pending, start] = useTransition();
  names = names.map((n) => shownName(n, t('ds.satimName')));
  const label = kind === 'archive' ? (names[0] === t('ds.satimName') ? t('ds.satim') : names[0]) : combined ? t('ds.combined', { n: names.length }) : t('ds.collection', { name: names[0] });
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const d = ref.current;
      if (d?.open && (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node))) d.open = false;
    };
    document.addEventListener('click', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, []);
  const back = () => start(async () => {
    await fetch('/api/v1/collections/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['satim'] }) });
    if (ref.current) ref.current.open = false;
    // a pinned analysis (?run=) belongs to the previous selection: drop it with the selection
    const q = new URLSearchParams(search.toString());
    q.delete('run'); q.delete('page');
    router.push(q.size ? `${path}?${q}` : path, { scroll: false });
    router.refresh();
  });
  return (
    <details ref={ref} className={`dataset-menu${kind === 'collections' ? ' is-imported' : ''}`}>
      <summary className="dataset-btn" aria-label={t('ds.controlLabel', { label })} title={t('ds.controlTitle')}>
        {kind === 'archive' ? <Database aria-hidden /> : <Layers aria-hidden />}<span className="dataset-text">{label}</span>
        {running && <Loader2 className="spin" aria-label={t('view.running')} />}<ChevronDown aria-hidden className="chev" />
      </summary>
      <div className="dataset-pop" role="dialog" aria-label={t('ds.popTitle')}>
        <b>{t('ds.popTitle')}</b>
        {kind === 'archive'
          ? <p className="muted">{t('ds.satimHint')}</p>
          : <ul>{names.map((n) => <li key={n}>{n}</li>)}</ul>}
        {kind === 'collections' && <p className="muted small">{combined ? t('ds.combinedHint') : t('ds.collectionHint')}</p>}
        <div className="dataset-actions">
          {kind === 'collections' && <button type="button" className="btn btn-secondary" disabled={pending} onClick={back}><RotateCcw aria-hidden />{t('ds.return')}</button>}
          <Link className="btn btn-ghost" href="/data#collections" onClick={() => { if (ref.current) ref.current.open = false; }}>{t('ds.manage')}</Link>
        </div>
      </div>
    </details>
  );
}

/** Polls an analysis run and refreshes the page once it is no longer queued or running. */
export function ViewWatcher({ runId }: { runId: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<string | null>(null);
  const t = useT();
  useEffect(() => {
    const timer = setInterval(async () => {
      const res = await fetch(`/api/v1/imports/${runId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { run } = await res.json();
      setStage(run.stage ?? null);
      if (run.state !== 'queued' && run.state !== 'running') { clearInterval(timer); router.refresh(); }
    }, 1500);
    return () => clearInterval(timer);
  }, [runId, router]);
  return stage ? <span className="muted"> · {t(`stage.${stage}` as Parameters<typeof t>[0])}</span> : null;
}
