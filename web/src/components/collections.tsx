'use client';
// Data & runs → Data collections: the protected SATIM dataset and the saved collections, with
// multi-selection ("Apply selection" analyses the selected collections as one combined view), an
// actions menu per row, the Trash with Restore, and the import dialog (several CSV files in one
// import, each validated by the backend; one combined preview; a new or an existing collection as
// destination). Progress always comes from the run's status on the server, so it survives a refresh.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArchiveRestore, CheckCircle2, Database, Download, FileUp, History, Loader2, MoreHorizontal, Pencil, Radio, RotateCcw, Trash2, Upload, X, XCircle } from 'lucide-react';
import type { ImportCheck, ImportPreview, ImportStatus } from '@/lib/imports';
import { fmtInt, fmtRange, fmtStamp } from '@/lib/format';
import { msgText, type T } from '@/lib/i18n';
import type { CollectionRow } from '@/app/api/v1/collections/shared';
import { useT } from './i18n';
import { shownName } from '@/lib/collection-name';

export interface CollectionsPayload {
  collections: CollectionRow[]; trash: CollectionRow[]; selection: string[];
  view: { ids: string[]; names: string[]; run_id: string | null; state: 'ready' | 'running' | 'failed'; combined: boolean; status: ImportStatus | null } | null;
  active: { ids: string[]; activated_at: string; actor: string } | null;
  runs: RunRow[];
}
export interface RunRow {
  run_id: string; kind: 'import' | 'view'; sources: { id: string; name: string; deleted: boolean }[]; collection_id: string | null; collection_name: string | null; filenames: string[]; created_at: string;
  state: ImportStatus['state']; complete: boolean; result: ImportStatus['result'] | null; error: { message: string; code?: string } | null; current: boolean;
}
const ACTIVE = (s?: ImportStatus | null) => s?.state === 'queued' || s?.state === 'running';
const STAGE_ORDER = ['collect', 'validate', 'clean', 'aggregate', 'reference', 'score', 'evidence', 'hybrid', 'save'];
const errText = (t: T, data: { error?: { code?: string; message?: string } } | null, fallback: string) => {
  const code = data?.error?.code;
  const k = `err.${code}` as Parameters<T>[0];
  const s = code ? t(k) : '';
  return s && s !== k ? s : data?.error?.message ?? fallback;
};

async function getJson<X>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: X & { error?: { code?: string; message?: string } } }> {
  const res = await fetch(url, { cache: 'no-store', ...init, headers: init?.body ? { 'content-type': 'application/json' } : undefined });
  let data: X & { error?: { code?: string; message?: string } };
  try { data = await res.json(); } catch { data = {} as X & { error?: { code?: string; message?: string } }; }
  return { ok: res.ok, data };
}

export function DataCollections({ initial, canManage, canExport, official }: { initial: CollectionsPayload; canManage: boolean; canExport: boolean; official: { runId: string; sealed: boolean; first: string; last: string; flagged: number } }) {
  const t = useT(), router = useRouter();
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<'list' | 'trash'>('list');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.selection));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [runs, setRuns] = useState<ImportStatus[]>([]);
  const [current, setCurrent] = useState<ImportStatus | null>(null);
  const [confirm, setConfirm] = useState<CollectionRow | null>(null);
  const [renaming, setRenaming] = useState<CollectionRow | null>(null);
  const [mountedAt] = useState(() => Date.now()); // fixed at mount: a finished run stays shown for 15 min after load
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [importInto, setImportInto] = useState<string | null | undefined>(undefined);   // undefined: dialog closed
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);

  const apply = useCallback((p: CollectionsPayload) => { setData(p); setPicked(new Set(p.selection)); }, []);
  const reload = useCallback(async () => {
    const [c, i] = await Promise.all([getJson<CollectionsPayload>('/api/v1/collections'), canManage ? getJson<{ imports: ImportStatus[] }>('/api/v1/imports') : Promise.resolve(null)]);
    if (c.ok) setData(c.data);
    if (i?.ok) { setRuns(i.data.imports); setCurrent((cur) => (cur ? i.data.imports.find((r) => r.run_id === cur.run_id) ?? cur : i.data.imports[0] ?? null)); }
  }, [canManage]);
  useEffect(() => {
    let live = true;
    if (canManage) getJson<{ imports: ImportStatus[] }>('/api/v1/imports').then((r) => { if (live && r.ok) { setRuns(r.data.imports); setCurrent(r.data.imports[0] ?? null); } });
    return () => { live = false; };
  }, [canManage]);

  // live status: the running import, and the combined analysis of the active selection
  const watched = [current && ACTIVE(current) ? current.run_id : null, data.view && ACTIVE(data.view.status) ? data.view.status!.run_id : null].filter(Boolean) as string[];
  const watchKey = watched.join(',');
  useEffect(() => {
    if (!watchKey) return;
    const timer = setInterval(async () => {
      tick((n) => n + 1);
      const done: string[] = [];
      for (const id of watchKey.split(',')) {
        const r = await getJson<{ run: ImportStatus }>(`/api/v1/imports/${id}`);
        if (!r.ok) continue;
        if (r.data.run.kind === 'import') setCurrent(r.data.run);
        else setData((d) => (d.view ? { ...d, view: { ...d.view, status: r.data.run } } : d));
        if (!ACTIVE(r.data.run)) done.push(id);
      }
      if (done.length) { await reload(); router.refresh(); }
    }, 1200);
    return () => clearInterval(timer);
  }, [watchKey, reload, router]);

  // an import asked to join the current combined view: once it succeeds, add it to the selection (once)
  useEffect(() => {
    if (current?.state !== 'succeeded' || !current.collection_id) return;
    let joinKey = '';
    try { joinKey = sessionStorage.getItem('pai-join') ?? ''; } catch { /* storage off */ }
    if (joinKey !== current.run_id) return;
    try { sessionStorage.removeItem('pai-join'); } catch { /* storage off */ }
    const ids = [...new Set([...data.selection, current.collection_id])];
    getJson<CollectionsPayload>('/api/v1/collections/selection', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => { if (r.ok) { apply(r.data); router.refresh(); } });
  }, [current, data.selection, apply, router]);

  const select = async (ids: string[], message?: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await getJson<CollectionsPayload>('/api/v1/collections/selection', { method: 'POST', body: JSON.stringify({ ids }) });
      if (!r.ok) { setNote({ tone: 'err', text: errText(t, r.data, t('col.applyFailed')) }); return; }
      apply(r.data);
      setNote({ tone: 'ok', text: message ?? t('col.applied', { n: r.data.selection.length }) });
      router.refresh();
    } finally { setBusy(false); }
  };
  const change = async (row: CollectionRow, body: { action: 'trash' | 'restore' | 'rename'; name?: string }) => {
    setBusy(true); setNote(null);
    try {
      const r = await getJson<CollectionsPayload>(`/api/v1/collections/${row.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (!r.ok) { setNote({ tone: 'err', text: errText(t, r.data, t('col.changeFailed')) }); return false; }
      apply(r.data);
      setNote({ tone: 'ok', text: body.action === 'trash' ? (r.data.selection.length ? t('col.trashed', { name: label(row) }) : t('col.trashedNothingLeft', { name: label(row) }))
        : body.action === 'restore' ? t('col.restored', { name: row.name }) : t('col.renamed', { name: body.name ?? row.name }) });
      router.refresh();
      return true;
    } finally { setBusy(false); }
  };

  /** Administrator: make collections the active dataset for every account ([] = the platform default). */
  const activate = async (ids: string[], name: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await getJson<CollectionsPayload>('/api/v1/collections/active', { method: 'POST', body: JSON.stringify({ ids }) });
      if (!r.ok) { setNote({ tone: 'err', text: errText(t, r.data, t('col.changeFailed')) }); return; }
      apply(r.data);
      setNote({ tone: 'ok', text: ids.length ? t('col.activated', { name }) : t('col.deactivated') });
      router.refresh();
    } finally { setBusy(false); }
  };

  // every collection, the original SATIM one included, is selected the same way, alone or with others
  const toggle = (id: string) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const pickedIds = [...picked];
  const dirty = pickedIds.slice().sort().join(',') !== data.selection.slice().sort().join(',');
  const viewing = data.view;
  const label = (c: { name: string }) => shownName(c.name, t('ds.satimName'));
  const viewNames = viewing?.names.map((n) => shownName(n, t('ds.satimName'))) ?? [];
  const activeLabel = !viewing ? t('ds.none') : viewing.combined ? t('ds.combined', { n: viewing.ids.length }) : viewNames[0];
  // the platform default when the administrator chose nothing: the SATIM collection
  const platformIds = data.active?.ids ?? data.collections.filter((c) => c.id === 'satim' && c.usable).map((c) => c.id);
  const editable = data.collections.filter((c) => !c.pending);
  const anyImport = ACTIVE(current) || data.collections.some((c) => c.pending);

  return (
    <section className="panel m-rise collections" id="collections" aria-labelledby="col-h">
      <div className="panel-head">
        <div><h2 id="col-h">{t('col.title')}</h2><p>{t('col.subtitle')}</p></div>
        <div className="row">
          <div className="seg" role="tablist" aria-label={t('col.title')}>
            <button type="button" role="tab" aria-selected={tab === 'list'} onClick={() => setTab('list')}>{t('col.tabList', { n: data.collections.length })}</button>
            <button type="button" role="tab" aria-selected={tab === 'trash'} onClick={() => setTab('trash')}><Trash2 aria-hidden />{t('col.tabTrash', { n: data.trash.length })}</button>
          </div>
          {canManage && <button type="button" className="btn btn-primary" onClick={() => setImportInto(null)} disabled={anyImport} title={anyImport ? t('imp.running') : undefined}><FileUp aria-hidden />{t('imp.button')}</button>}
        </div>
      </div>

      <p className="col-active" role="status"><Database aria-hidden /><span>{t('col.activeNow')} <b>{activeLabel}</b>{viewing && viewing.combined && <span className="muted"> · {viewNames.join(', ')}</span>}</span></p>
      {!viewing && <p className="col-empty" role="alert">{data.collections.some((c) => c.usable) ? t('col.emptySelection') : t('col.emptyAll')}
        {canManage && !data.collections.some((c) => c.usable) && <button type="button" className="btn btn-primary" onClick={() => setImportInto(null)} disabled={anyImport}><FileUp aria-hidden />{t('imp.button')}</button>}</p>}
      {viewing && viewing.state !== 'ready' && <ViewProgress view={viewing} t={t} />}
      {note && <p className={note.tone === 'ok' ? 'ok-note' : 'err'} role={note.tone === 'ok' ? 'status' : 'alert'}>{note.text}</p>}
      {current && !data.trash.some((c) => c.id === current.collection_id) && (ACTIVE(current) || current.state !== 'succeeded' || mountedAt - Date.parse(current.finished_at ?? current.created_at) < 15 * 60e3) && (
        <RunCard run={current} t={t} onRetry={async (id) => { const r = await getJson<{ run: ImportStatus }>(`/api/v1/imports/${id}`, { method: 'POST' }); if (r.ok) { setCurrent(r.data.run); reload(); } else setNote({ tone: 'err', text: errText(t, r.data, t('imp.retryFailed')) }); }}
          onOpen={(id) => select([id], t('col.opened', { name: label(data.collections.find((c) => c.id === id) ?? { name: '' }) }))} onReimport={() => setImportInto(current.collection_id ?? null)} />
      )}

      {tab === 'list' ? (
        <>
          <div className="table-scroll">
            <table className="data col-table">
              <caption className="sr-only">{t('col.caption')}</caption>
              <thead><tr><th className="col-check"><span className="sr-only">{t('col.select')}</span></th><th>{t('col.name')}</th><th>{t('col.dates')}</th><th className="r">{t('col.merchants')}</th><th className="r">{t('col.transactions')}</th><th>{t('col.status')}</th><th className="r"><span className="sr-only">{t('col.actions')}</span></th></tr></thead>
              <tbody>
                {data.collections.map((c) => {
                  const inView = !!viewing?.ids.includes(c.id);
                  return (
                    <Fragment key={c.id}>
                      <tr className={`${picked.has(c.id) ? 'is-picked' : ''}${inView ? ' is-active' : ''}`}>
                        <td className="col-check"><input type="checkbox" checked={picked.has(c.id)} disabled={!c.usable || busy} onChange={() => toggle(c.id)}
                          aria-label={t('col.selectRow', { name: label(c) })} title={!c.usable ? t('col.notReady') : undefined} /></td>
                        <td><span className="col-name"><b>{label(c)}</b></span></td>
                        <td className="num">{c.first_date && c.last_date ? fmtRange(c.first_date, c.last_date, t.locale) : '—'}</td>
                        <td className="r num">{c.merchants === null ? '—' : fmtInt(c.merchants, t.locale)}</td>
                        <td className="r num">{c.transactions === null ? '—' : fmtInt(c.transactions, t.locale)}</td>
                        <td><StatusCell c={c} inView={inView} t={t} />{platformIds.includes(c.id) && <small className="col-platform">{t('col.platform')}</small>}</td>
                        <td className="r"><RowMenu c={c} t={t} canManage={canManage} busy={busy || anyImport}
                          onOpen={() => select([c.id], t('col.opened', { name: label(c) }))}
                          onHistory={() => setHistoryOf(historyOf === c.id ? null : c.id)}
                          onImport={() => setImportInto(c.id)}
                          onRename={() => { setRenaming(c); requestAnimationFrame(() => renameDialog.current?.showModal()); }}
                          onTrash={() => { setConfirm(c); requestAnimationFrame(() => confirmDialog.current?.showModal()); }}
                          platform={platformIds.includes(c.id)} platformFixed={!data.active && platformIds.includes(c.id)}
                          onPlatform={() => activate(platformIds.includes(c.id) ? platformIds.filter((x) => x !== c.id) : [c.id], label(c))} /></td>
                      </tr>
                      {historyOf === c.id && (
                        <tr className="col-history-row"><td /><td colSpan={6}><ImportHistory c={c} t={t} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="col-foot">
            <span className="muted" aria-live="polite">{t('col.picked', { n: picked.size })}</span>
            <button type="button" className="btn btn-primary" disabled={busy || !dirty || !picked.size} onClick={() => select(pickedIds)}>{busy ? t('common.saving') : t('col.apply')}</button>
          </div>
          <p className="muted small">{t('col.combineNote')}</p>
        </>
      ) : (
        data.trash.length ? (
          <div className="table-scroll">
            <table className="data col-table">
              <caption className="sr-only">{t('col.trashCaption')}</caption>
              <thead><tr><th>{t('col.name')}</th><th>{t('col.dates')}</th><th className="r">{t('col.transactions')}</th><th>{t('col.trashedAt')}</th><th className="r"><span className="sr-only">{t('col.actions')}</span></th></tr></thead>
              <tbody>{data.trash.map((c) => (
                <tr key={c.id}>
                  <td><b>{label(c)}</b><small className="muted block">{t('col.batches', { n: c.batches.length })}</small></td>
                  <td className="num">{c.first_date && c.last_date ? fmtRange(c.first_date, c.last_date, t.locale) : '—'}</td>
                  <td className="r num">{c.transactions === null ? '—' : fmtInt(c.transactions, t.locale)}</td>
                  <td className="num">{c.trashed_at ? fmtStamp(c.trashed_at, t.locale) : ''}</td>
                  <td className="r">{canManage ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => change(c, { action: 'restore' })}><ArchiveRestore aria-hidden />{t('col.restore')}</button> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="muted empty-line">{t('col.trashEmpty')}</p>
      )}

      <dialog ref={confirmDialog} className="kpi-dialog confirm-dialog" aria-labelledby="trash-h" onClose={() => setConfirm(null)}>
        <h2 id="trash-h">{t('col.trashTitle', { name: confirm ? label(confirm) : '' })}</h2>
        <p>{t('col.trashBody', { name: confirm ? label(confirm) : '' })}</p>
        {confirm && viewing?.ids.includes(confirm.id) && <p className="muted">{viewing.ids.length > 1 ? t('col.trashInView') : t('col.trashLastInView')}</p>}
        <div className="kpi-dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={() => confirmDialog.current?.close()}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (confirm && await change(confirm, { action: 'trash' })) confirmDialog.current?.close(); }}><Trash2 aria-hidden />{t('col.trash')}</button>
        </div>
      </dialog>
      <RenameDialog ref={renameDialog} row={renaming} t={t} busy={busy} onSave={async (name) => { if (renaming && await change(renaming, { action: 'rename', name })) renameDialog.current?.close(); }} onClose={() => setRenaming(null)} />

      {importInto !== undefined && canManage && (
        <ImportDialog t={t} into={importInto} collections={editable} selection={data.selection}
          onClose={() => setImportInto(undefined)}
          onStarted={(run, info) => { setImportInto(undefined); if (run) setCurrent(run); setNote(info ? { tone: 'ok', text: info } : null); reload(); }} />
      )}
      <RunHistory runs={data.runs} official={official} active={data.active} satimDefault={platformIds.includes('satim')} canExport={canExport} t={t} onOpen={(r) => setCurrent(runs.find((x) => x.run_id === r) ?? null)} />
    </section>
  );
}

/** Every execution mode, kept apart: the official run, imported operational runs, and the simulated replay. */
function RunHistory({ runs, official, active, satimDefault, canExport, t, onOpen }: { runs: RunRow[]; official: { runId: string; sealed: boolean; first: string; last: string; flagged: number }; active: CollectionsPayload['active']; satimDefault: boolean; canExport: boolean; t: T; onOpen: (runId: string) => void }) {
  const l = t.locale;
  return (
    <details className="run-history" open>
      <summary><History aria-hidden className="inline-ico" />{t('rh.title')}</summary>
      <div className="table-scroll"><table className="data col-table">
        <caption className="sr-only">{t('rh.title')}</caption>
        <thead><tr><th>{t('rh.mode')}</th><th>{t('rh.run')}</th><th>{t('rh.dataset')}</th><th>{t('rh.period')}</th><th className="r">{t('col.transactions')}</th><th className="r">{t('col.merchants')}</th>
          <th>{t('rh.quality')}</th><th>{t('rh.policy')}</th><th className="r">{t('rh.flagged')}</th><th className="r">{t('rh.collective')}</th><th className="r">{t('rh.hybrid')}</th><th>{t('col.status')}</th><th className="r"><span className="sr-only">{t('col.actions')}</span></th></tr></thead>
        <tbody>
          <tr>
            <td>{t('rh.modeArchive')}</td><td className="num">{official.runId}</td><td>{t('ds.satimName')}<small className="muted block">{official.sealed ? t('rh.modeSealed') : t('rh.modePreview')}</small></td>
            <td className="num">{fmtRange(official.first, official.last, l)}</td><td className="r">—</td><td className="r">—</td><td>{t('rh.officialQuality')}</td><td>{t('rh.frozen')}</td>
            <td className="r num">{fmtInt(official.flagged, l)}</td><td className="r">—</td><td className="r">—</td>
            <td>{satimDefault ? <b>{t('col.platform')}</b> : t('col.ready')}</td><td className="r">{canExport && official.sealed && <a href="/api/v1/export/predictions" download>{t('rh.officialCsv')}</a>}</td>
          </tr>
          {runs.map((r) => {
            const x = r.result;
            return (
              <tr key={r.run_id}>
                <td>{r.kind === 'view' ? t('rh.modeCombined') : t('rh.modeImport')}</td>
                <td className="num"><button type="button" className="link-btn" onClick={() => onOpen(r.run_id)}>{r.run_id}</button><small className="muted block">{fmtStamp(r.created_at, l)}</small></td>
                <td>{r.sources.length ? r.sources.map((x, i) => <Fragment key={x.id}>{i ? ', ' : ''}{shownName(x.name, t('ds.satimName'))}{x.deleted && <small className="muted"> ({t('rh.deleted')})</small>}</Fragment>) : r.collection_name ?? '—'}
                  <small className="muted block">{r.filenames.length ? `${r.filenames.join(', ')} · ` : ''}{t(r.complete ? 'imp.complete' : 'imp.partial')}</small></td>
                <td className="num">{x ? fmtRange(x.first_date, x.last_date, l) : '—'}</td>
                <td className="r num">{x ? fmtInt(x.rows_processed, l) : '—'}</td><td className="r num">{x?.merchants != null ? fmtInt(x.merchants, l) : '—'}</td>
                <td>{x ? t('rh.qualityLine', { dup: x.duplicates_removed, nfc: x.contactless_limit_events ?? 0 }) : '—'}</td>
                <td><small>{x?.model_version ?? '—'} · {x?.preprocessing_version ?? '—'}<span className="muted block" title={x?.reference_version}>{t('rh.reference')} {x?.reference_version?.split('-').pop() ?? '—'}</span></small></td>
                <td className="r num">{x ? fmtInt(x.alerts, l) : '—'}</td><td className="r num">{x?.collective_warnings ?? '—'}</td>
                <td className="r num" title={x?.hybrid_note ?? undefined}>{x?.hybrid_candidates ?? '—'}</td>
                <td>{t(`run.${r.state}` as Parameters<T>[0])}{r.current && r.collection_id && active?.ids.includes(r.collection_id) ? <b className="block">{t('col.platform')}</b> : r.current ? <small className="muted block">{t('rh.current')}</small> : null}</td>
                <td className="r">{canExport && r.state === 'succeeded' && <a href={`/api/v1/imports/${r.run_id}/predictions`} download>{t('rh.csv')}</a>}</td>
              </tr>
            );
          })}
          <tr><td>{t('rh.modeReplay')}</td><td colSpan={11} className="muted">{t('rh.replayNote')}</td><td className="r"><a href="/live">{t('nav.live')}</a></td></tr>
        </tbody>
      </table></div>
    </details>
  );
}

function StatusCell({ c, inView, t }: { c: CollectionRow; inView: boolean; t: T }) {
  if (c.pending) {
    const p = c.pending.progress;
    return <span className="col-status running"><Loader2 className="spin" aria-hidden />{t(`stage.${c.pending.stage ?? 'queued'}` as Parameters<T>[0])}{p?.total && p.done !== null ? ` · ${fmtInt(p.done, t.locale)} / ${fmtInt(p.total, t.locale)}` : ''}</span>;
  }
  if (!c.usable && c.last_error) return <span className="col-status failed"><XCircle aria-hidden />{t('col.importFailed')}</span>;
  if (!c.usable) return <span className="col-status muted">{t('col.notReady')}</span>;
  return <span className="col-status">{inView ? <><CheckCircle2 aria-hidden />{t('col.inView')}</> : c.last_error ? <span className="muted" title={c.last_error.message}>{t('col.lastImportFailed')}</span> : <span className="muted">{t('col.ready')}</span>}</span>;
}

function RowMenu({ c, t, canManage, busy, onOpen, onHistory, onImport, onRename, onTrash, platform, platformFixed, onPlatform }: { c: CollectionRow; platformFixed?: boolean; t: T; canManage: boolean; busy: boolean; onOpen: () => void; onHistory: () => void; onImport: () => void; onRename: () => void; onTrash: () => void; platform: boolean; onPlatform: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const run = (f: () => void) => () => { if (ref.current) ref.current.open = false; f(); };
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) { d.open = false; if (e instanceof KeyboardEvent) d.querySelector('summary')?.focus(); }
    };
    document.addEventListener('click', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, []);
  const name = shownName(c.name, t('ds.satimName'));
  return (
    <details ref={ref} className="row-menu">
      <summary className="icon-btn" aria-label={t('col.actionsFor', { name })} title={t('col.actions')}><MoreHorizontal aria-hidden /></summary>
      <div className="row-menu-pop" role="menu">
        <button type="button" role="menuitem" disabled={!c.usable} onClick={run(onOpen)}><Database aria-hidden />{t('col.openAlone')}</button>
        {canManage && c.usable && !platformFixed && <button type="button" role="menuitem" disabled={busy} onClick={run(onPlatform)}><Radio aria-hidden />{platform ? t('col.platformOff') : t('col.platformOn')}</button>}
        <button type="button" role="menuitem" onClick={run(onHistory)}><History aria-hidden />{t('col.history')}</button>
        {canManage && <>
            <button type="button" role="menuitem" disabled={busy} onClick={run(onImport)}><FileUp aria-hidden />{t('col.addFiles')}</button>
            <button type="button" role="menuitem" disabled={busy} onClick={run(onRename)}><Pencil aria-hidden />{t('col.rename')}</button>
            <button type="button" role="menuitem" className="danger" disabled={busy || !!c.pending} onClick={run(onTrash)}><Trash2 aria-hidden />{t('col.trash')}</button>
          </>}
      </div>
    </details>
  );
}

function ImportHistory({ c, t }: { c: CollectionRow; t: T }) {
  if (!c.batches.length) return <p className="muted">{c.last_error ? `${t('col.importFailed')} · ${c.last_error.message}` : t('col.noBatches')}</p>;
  return (
    <ol className="batch-list">
      {[...c.batches].reverse().map((b) => (
        <li key={b.batch_id}>
          <b>{b.added_at ? fmtStamp(b.added_at, t.locale) : '—'}</b>
          <span>{b.filenames.join(', ')}</span>
          <span className="muted">{[b.first_date && b.last_date ? fmtRange(b.first_date, b.last_date, t.locale) : null, t(b.complete ? 'imp.complete' : 'imp.partial'),
            b.rows_added !== undefined ? t('col.rowsAdded', { n: b.rows_added }) : null, b.actor].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ol>
  );
}

function RenameDialog({ ref, row, t, busy, onSave, onClose }: { ref: React.Ref<HTMLDialogElement>; row: CollectionRow | null; t: T; busy: boolean; onSave: (name: string) => void; onClose: () => void }) {
  return (
    <dialog ref={ref} className="kpi-dialog confirm-dialog" aria-labelledby="rename-h" onClose={onClose}>
      <form key={row?.id} method="dialog" onSubmit={(e) => { e.preventDefault(); onSave(String(new FormData(e.currentTarget).get('name') ?? '')); }}>
        <h2 id="rename-h">{t('col.renameTitle')}</h2>
        <label className="field">{t('col.name')}<input name="name" defaultValue={row?.name ?? ''} maxLength={80} required autoFocus /></label>
        <div className="kpi-dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={(e) => (e.currentTarget.closest('dialog') as HTMLDialogElement).close()}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('common.save')}</button>
        </div>
      </form>
    </dialog>
  );
}

function ViewProgress({ view, t }: { view: NonNullable<CollectionsPayload['view']>; t: T }) {
  const s = view.status;
  return (
    <div className={`view-progress ${view.state}`} role="status">
      {view.state === 'failed' ? <XCircle aria-hidden /> : <Loader2 className="spin" aria-hidden />}
      <span>{view.state === 'failed' ? t('view.failed') : t('view.analysing', { n: view.ids.length })}
        {s && ACTIVE(s) && <> · {t(`stage.${s.stage ?? 'queued'}` as Parameters<T>[0])}{s.progress?.total && s.progress.done !== null ? ` (${fmtInt(s.progress.done, t.locale)} / ${fmtInt(s.progress.total, t.locale)})` : ''}</>}
        {view.run_id ? ` · ${t('view.showingPrevious')}` : ''}</span>
    </div>
  );
}

/* ── import dialog ───────────────────────────────────────────────────── */

type FileState = { key: string; name: string; phase: 'uploading' | 'checking' | 'done' | 'error'; pct: number; check?: ImportCheck; error?: string };

function ImportDialog({ t, into, collections, selection, onClose, onStarted }: {
  t: T; into: string | null; collections: CollectionRow[]; selection: string[];
  onClose: () => void; onStarted: (run: ImportStatus | null, info: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [over, setOver] = useState(false);
  const activeEditable = collections.filter((c) => selection.includes(c.id));
  // one editable collection active: it is the default destination; several: the operator must choose
  const [mode, setMode] = useState<'new' | 'existing'>(into ? 'existing' : activeEditable.length === 1 ? 'existing' : 'new');
  const [dest, setDest] = useState<string>(into ?? (activeEditable.length === 1 ? activeEditable[0].id : ''));
  const [name, setName] = useState('');
  const [join, setJoin] = useState(selection.length > 0);
  const [complete, setComplete] = useState(false);
  const [preview, setPreview] = useState<{ key: string; data: ImportPreview | null; error: string | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const nameOf = (id: string) => shownName(collections.find((c) => c.id === id)?.name ?? '', t('ds.satimName'));
  const shownNow = selection.map(nameOf).filter(Boolean).join(', ') || t('ds.none');
  const valid = files.filter((f) => f.phase === 'done' && f.check?.ok);
  const pending = files.some((f) => f.phase === 'uploading' || f.phase === 'checking');
  const target = mode === 'existing' ? dest : '';
  const previewKey = valid.length && !pending ? `${valid.map((f) => f.check!.upload_id).join(',')}|${target}` : '';
  const defaultName = useMemo(() => (valid[0]?.name ?? '').replace(/\.csv$/i, '').slice(0, 60), [valid]);

  // the combined preview follows the valid files and the destination
  useEffect(() => {
    if (!previewKey || (mode === 'existing' && !dest)) return;
    let live = true;
    getJson<ImportPreview>('/api/v1/imports/preview', { method: 'POST', body: JSON.stringify({ upload_ids: valid.map((f) => f.check!.upload_id), destination: target || undefined }) })
      .then((r) => { if (live) setPreview({ key: previewKey, data: r.ok ? r.data : null, error: r.ok ? null : errText(t, r.data, t('imp.previewFailed')) }); });
    return () => { live = false; };
    // valid/target are encoded in previewKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, mode, dest]);
  const shown = preview?.key === previewKey ? preview : null;

  function add(list: FileList | File[]) {
    setError(null);
    for (const file of Array.from(list)) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (files.some((f) => f.key === key)) continue;
      if (!/\.csv$/i.test(file.name)) { setFiles((fs) => [...fs, { key, name: file.name, phase: 'error', pct: 0, error: t('imp.notCsv') }]); continue; }
      if (files.length >= 12) { setError(t('imp.tooManyFiles')); break; }
      setFiles((fs) => [...fs, { key, name: file.name, phase: 'uploading', pct: 0 }]);
      const patch = (p: Partial<FileState>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));
      const form = new FormData();
      form.append('file', file);
      const xhr = new XMLHttpRequest();   // XHR: the only browser API that reports upload progress
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) patch({ pct: Math.round((e.loaded / e.total) * 100) }); };
      xhr.upload.onload = () => patch({ phase: 'checking', pct: 100 });
      xhr.onload = () => {
        let data: ImportCheck & { error?: { code?: string; message?: string } };
        try { data = JSON.parse(xhr.responseText); } catch { patch({ phase: 'error', error: t('imp.unreadableAnswer') }); return; }
        if (xhr.status >= 400) patch({ phase: 'error', error: errText(t, data, t('imp.validateFailed')) });
        else patch({ phase: 'done', check: data });
      };
      xhr.onerror = () => patch({ phase: 'error', error: t('imp.uploadFailed') });
      xhr.open('POST', '/api/v1/imports/validate');
      xhr.send(form);
    }
  }

  const destName = mode === 'existing' ? (dest ? nameOf(dest) : undefined) : (name.trim() || defaultName);
  // what the pages will show once the analysis succeeds, said before anything is submitted
  const scopeText = mode === 'existing'
    ? (selection.includes(dest) ? t('imp.scopeInView', { name: destName ?? '', shown: shownNow }) : t('imp.scopeNotInView', { name: destName ?? '', shown: shownNow }))
    : join && selection.length ? t('imp.scopeJoin', { name: destName ?? '', shown: shownNow }) : t('imp.scopeAlone', { name: destName ?? '', shown: shownNow });
  const canStart = !!shown?.data?.ok && !pending && valid.length > 0 && (mode === 'new' ? !!(name.trim() || defaultName) : !!dest);

  async function start() {
    setStarting(true); setError(null);
    try {
      const destination = mode === 'existing' ? { collection: dest } : { name: name.trim() || defaultName };
      const r = await getJson<{ run: ImportStatus | null; existing: boolean; collection: { id: string; name: string }; skipped: string[] }>('/api/v1/imports',
        { method: 'POST', body: JSON.stringify({ upload_ids: valid.map((f) => f.check!.upload_id), complete, destination }) });
      if (!r.ok) { setError(errText(t, r.data, t('imp.startFailed'))); return; }
      if (mode === 'new' && join && selection.length && r.data.run) { try { sessionStorage.setItem('pai-join', r.data.run.run_id); } catch { /* storage off */ } }
      const info = !r.data.run ? t('imp.nothingNew', { name: r.data.collection.name })
        : r.data.existing ? t('imp.alreadyRunning', { name: r.data.collection.name })
        : r.data.skipped.length ? t('imp.skipped', { files: r.data.skipped.join(', ') }) : null;
      dialog.current?.close();
      onStarted(r.data.run, info);
    } finally { setStarting(false); }
  }

  const p = shown?.data;
  return (
    <dialog ref={dialog} className="kpi-dialog import-dialog" aria-labelledby="import-dialog-h" onClose={onClose}>
      <div className="kpi-dialog-head">
        <h2 id="import-dialog-h">{t('imp.title')}</h2>
        <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={() => dialog.current?.close()}><X /></button>
      </div>
      <p className="muted">{t('imp.intro')} <a href="/api/v1/imports/template" download>{t('imp.template')} <Download aria-hidden className="inline-ico" /></a></p>

      <label className={`dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
        <Upload aria-hidden />
        <b>{t('imp.drop')}</b><span>{t('imp.dropHint')}</span>
        <input type="file" accept=".csv,text/csv" multiple className="sr-only" onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
      </label>

      {files.length > 0 && (
        <ul className="file-list" aria-label={t('imp.files')}>
          {files.map((f) => (
            <li key={f.key} className={`file-row ${f.phase}${f.check && !f.check.ok ? ' bad' : ''}`}>
              <span className="file-ico" aria-hidden>{f.phase === 'uploading' || f.phase === 'checking' ? <Loader2 className="spin" /> : f.phase === 'error' || (f.check && !f.check.ok) ? <XCircle /> : <CheckCircle2 />}</span>
              <span className="file-main">
                <b>{f.name}</b>
                {f.phase === 'uploading' && <span className="muted">{t('imp.uploadingPct', { pct: f.pct })}<progress max={100} value={f.pct} aria-label={t('imp.uploadProgress', { name: f.name })} /></span>}
                {f.phase === 'checking' && <span className="muted">{t('imp.checking')}</span>}
                {f.phase === 'error' && <span className="err" role="alert">{f.error}</span>}
                {f.check && (
                  <>
                    <span className="muted">{t('imp.fileFacts', { rows: fmtInt(f.check.rows, t.locale), usable: fmtInt(f.check.usable_rows ?? 0, t.locale) })}{f.check.first_date && f.check.last_date ? ` · ${fmtRange(f.check.first_date, f.check.last_date, t.locale)}` : ''}{f.check.merchants !== undefined ? ` · ${t('imp.merchantsN', { n: f.check.merchants })}` : ''}</span>
                    {f.check.errors.length > 0 && <ul className="file-errs" role="alert">{f.check.errors.map((m) => <li key={m.code}>{msgText(t, m)}</li>)}</ul>}
                    {f.check.warnings.length > 0 && <details className="file-warns"><summary><AlertTriangle aria-hidden className="inline-ico" />{t('imp.handled', { n: f.check.warnings.length })}</summary><ul>{f.check.warnings.map((m) => <li key={m.code}>{msgText(t, m)}</li>)}</ul></details>}
                  </>
                )}
              </span>
              <button type="button" className="icon-btn" aria-label={t('imp.removeFile', { name: f.name })} onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}><X aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      {files.some((f) => f.phase === 'error' || (f.check && !f.check.ok)) && valid.length > 0 && <p className="muted small">{t('imp.invalidExcluded')}</p>}

      {valid.length > 0 && !pending && (
        <div className="import-check">
          <fieldset className="checks dest">
            <legend>{t('imp.destination')}</legend>
            <label><input type="radio" name="dest" checked={mode === 'new'} onChange={() => setMode('new')} />{t('imp.destNew')}
              <small>{t('imp.destNewHint', { n: valid.length })}</small></label>
            {mode === 'new' && (
              <div className="dest-extra">
                <label className="field">{t('imp.newName')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} maxLength={80} /></label>
                {selection.length > 0 && <label className="check-inline"><input type="checkbox" checked={join} onChange={(e) => setJoin(e.target.checked)} />{t('imp.joinView', { n: selection.length })}</label>}
              </div>
            )}
            <label><input type="radio" name="dest" checked={mode === 'existing'} disabled={!collections.length} onChange={() => setMode('existing')} />{t('imp.destExisting')}
              <small>{collections.length ? t('imp.destExistingHint') : t('imp.noEditable')}</small></label>
            {mode === 'existing' && (
              <div className="dest-extra">
                <label className="field">{t('imp.chooseCollection')}
                  <select value={dest} onChange={(e) => setDest(e.target.value)} required>
                    <option value="">{activeEditable.length > 1 ? t('imp.chooseRequired') : t('imp.choose')}</option>
                    {collections.map((c) => <option key={c.id} value={c.id}>{nameOf(c.id)}{selection.includes(c.id) ? ` · ${t('col.inView')}` : ''}</option>)}
                  </select>
                </label>
                {activeEditable.length > 1 && !dest && <p className="muted small">{t('imp.ambiguous', { n: activeEditable.length })}</p>}
              </div>
            )}
          </fieldset>

          {shown?.error && <p className="err" role="alert">{shown.error}</p>}
          {!shown && (mode === 'new' || dest) && <div className="import-step" role="status"><Loader2 className="spin" aria-hidden /><div><b>{t('imp.previewing')}</b></div></div>}
          {p && (
            <>
              <dl className="import-facts">
                <div><dt>{t('imp.factDestination')}</dt><dd>{destName ?? '—'}{mode === 'new' ? ` (${t('imp.newTag')})` : ''}</dd></div>
                {p.first_date && p.last_date && <div><dt>{t('col.dates')}</dt><dd>{fmtRange(p.first_date, p.last_date, t.locale)}</dd></div>}
                {p.merchants !== undefined && <div><dt>{t('col.merchants')}</dt><dd>{fmtInt(p.merchants, t.locale)}</dd></div>}
                <div><dt>{t('imp.factReceived')}</dt><dd>{fmtInt(p.rows_received, t.locale)}</dd></div>
                <div><dt>{t('imp.factDuplicates')}</dt><dd>{fmtInt(p.duplicates_within + p.duplicates_existing, t.locale)}{p.duplicates_existing > 0 && <small className="block muted">{t('imp.dupExisting', { n: p.duplicates_existing })}</small>}{p.duplicates_within > 0 && <small className="block muted">{t('imp.dupWithin', { n: p.duplicates_within })}</small>}</dd></div>
                <div className="hl"><dt>{mode === 'existing' ? t('imp.factToAdd') : t('imp.factReady')}</dt><dd>{fmtInt(p.rows_ready, t.locale)}</dd></div>
              </dl>
              <p className="import-scope" role="note">{scopeText}</p>
              {p.invalid_rows > 0 && <p className="muted small">{t('imp.invalidRows', { n: p.invalid_rows })}</p>}
              {p.already.length > 0 && <p className="ok-note">{t('imp.alreadyIn', { files: p.already.map((a) => a.filename).join(', ') })}</p>}
              {p.errors.length > 0 && <div className="import-msgs bad" role="alert"><b><XCircle aria-hidden />{t('imp.mustFix')}</b><ul>{p.errors.map((m) => <li key={m.code}>{msgText(t, m)}</li>)}</ul></div>}
              {p.ok && p.coverage && (
                <fieldset className="checks coverage">
                  <legend>{t('imp.coverage')}</legend>
                  <label><input type="radio" name="coverage" checked={!complete} onChange={() => setComplete(false)} />{t('imp.partial')}<small>{t('imp.partialHint')}</small></label>
                  <label><input type="radio" name="coverage" checked={complete} onChange={() => setComplete(true)} />{t('imp.complete')}<small>{t('imp.completeHint', { n: p.merchants ?? 0, range: p.first_date && p.last_date ? fmtRange(p.first_date, p.last_date, t.locale) : '', zero: fmtInt(p.coverage.merchant_date_grid - p.coverage.observed_merchant_days, t.locale), grid: fmtInt(p.coverage.merchant_date_grid, t.locale) })}</small></label>
                </fieldset>
              )}
              {valid[0]?.check?.preview && valid[0].check.preview.length > 0 && (
                <details className="import-sample">
                  <summary>{t('imp.sample', { name: valid[0].name })}</summary>
                  <div className="table-scroll"><table className="data tight">
                    <thead><tr><th>{t('tx.merchant')}</th><th>{t('tx.time')}</th><th>{t('tx.channel')}</th><th>{t('tx.status')}</th><th>{t('tx.category')}</th><th className="r">{t('tx.amount')}</th></tr></thead>
                    <tbody>{valid[0].check.preview.map((r, i) => <tr key={i}><td>{r.merchant_id}</td><td className="num">{r.transaction_date}</td><td>{r.payment_channel}</td><td>{r.transaction_status}</td><td>{r.merchant_category}</td><td className="r num">{r.amount}</td></tr>)}</tbody>
                  </table></div>
                </details>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="err" role="alert">{error}</p>}

      <div className="kpi-dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!canStart || starting} onClick={start}>{starting ? t('imp.starting') : mode === 'existing' && destName ? t('imp.startAdd', { name: destName }) : t('imp.startCreate')}</button>
      </div>
    </dialog>
  );
}

/* ── live import status ──────────────────────────────────────────────── */

/** The current time, ticking each second after mount (null during the server render and hydration). */
function useNow() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const tick = () => setNow(Date.now()); const first = setTimeout(tick, 0), id = setInterval(tick, 1000); return () => { clearTimeout(first); clearInterval(id); }; }, []);
  return now;
}
const since = (iso: string | undefined, t: T, now: number | null) => { if (!iso || now === null) return '…'; const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); return s < 60 ? t('time.sec', { n: s }) : t('time.minSec', { m: Math.floor(s / 60), s: s % 60 }); };

export function RunCard({ run, t, onRetry, onOpen, onReimport }: { run: ImportStatus; t: T; onRetry: (id: string) => void; onOpen: (collectionId: string) => void; onReimport: () => void }) {
  const order = run.stage_order ?? STAGE_ORDER, now = useNow();
  const at = order.indexOf(run.stage ?? '');
  const p = run.progress;
  const unitKey = (u: string | null) => `unit.${(u ?? '').replace(/[^a-z]+/g, '_')}` as Parameters<T>[0];
  const created = run.collection_id && run.result && run.result.rows_added === run.result.rows_processed;
  return (
    <div className={`run-card ${run.state}`} aria-live="polite">
      <div className="run-card-head">
        {run.state === 'succeeded' ? <CheckCircle2 aria-hidden /> : run.state === 'failed' ? <XCircle aria-hidden /> : <Loader2 className="spin" aria-hidden />}
        <div>
          <b>{run.state === 'succeeded' ? (created ? t('run.created', { name: run.collection_name ?? '' }) : t('run.updated', { name: run.collection_name ?? '' }))
            : run.state === 'failed' ? t('run.failedAt', { stage: t(`stage.${run.error?.stage ?? run.stage ?? 'collect'}` as Parameters<T>[0]) })
            : t(`stage.${run.stage ?? 'queued'}` as Parameters<T>[0])}</b>
          <span className="muted">{run.collection_name && `${run.collection_name} · `}{t('run.filesN', { n: run.filenames.length })}: {run.filenames.join(', ')} · {t(run.complete ? 'imp.complete' : 'imp.partial').toLowerCase()}
            {ACTIVE(run) && ` · ${t('run.elapsed', { time: since(run.started_at ?? run.created_at, t, now) })}`}</span>
        </div>
      </div>
      {ACTIVE(run) && (
        <>
          {p && p.total ? (p.done !== null
            ? <><p className="run-count">{t('run.progress', { done: fmtInt(p.done, t.locale), total: fmtInt(p.total, t.locale), unit: t(unitKey(p.unit)) })}</p><progress max={p.total} value={p.done} aria-label={t(`stage.${run.stage}` as Parameters<T>[0])} /></>
            : <p className="run-count">{t('run.noPartial', { total: fmtInt(p.total, t.locale), unit: t(unitKey(p.unit)) })}</p>) : null}
          <ol className="run-stages">{order.map((k, i) => (
            <li key={k} className={run.stages_done?.includes(k) || (at >= 0 && i < at) ? 'done' : i === at ? 'now' : ''}>{t(`stage.${k}` as Parameters<T>[0])}</li>
          ))}</ol>
        </>
      )}
      {run.state === 'succeeded' && run.result && (
        <>
          <dl className="import-facts">
            {run.result.rows_added !== undefined && <div className="hl"><dt>{t('run.rowsAdded')}</dt><dd>{fmtInt(run.result.rows_added, t.locale)}</dd></div>}
            <div><dt>{t('run.collectionTotal')}</dt><dd>{fmtInt(run.result.rows_processed, t.locale)}</dd></div>
            <div><dt>{t('run.duplicatesRemoved')}</dt><dd>{fmtInt(run.result.duplicates_removed, t.locale)}</dd></div>
            <div><dt>{t('run.daysScored')}</dt><dd>{fmtInt(run.result.merchant_days_scored, t.locale)}</dd></div>
            <div><dt>{t('run.alerts')}</dt><dd>{fmtInt(run.result.alerts, t.locale)}</dd></div>
            <div><dt>{t('col.dates')}</dt><dd>{fmtRange(run.result.first_date, run.result.last_date, t.locale)}</dd></div>
          </dl>
          {run.collection_id && <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => onOpen(run.collection_id!)}>{t('run.open', { name: run.collection_name ?? '' })}</button>
            <Link className="btn btn-secondary" href={`/alerts?run=${run.run_id}`}>{t('run.viewAlerts')}</Link>
          </div>}
        </>
      )}
      {run.state === 'failed' && run.error && (
        <>
          <p className="err">{msgText(t, { code: run.error.code ?? 'engine_message', values: { detail: run.error.message, ...run.error.values }, text: run.error.message })}</p>
          <p className="muted">{t('run.failedKeep')}</p>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={() => onRetry(run.run_id)}><RotateCcw aria-hidden />{t('run.retry')}</button>
            <button type="button" className="btn btn-ghost" onClick={onReimport}>{t('run.reimport')}</button>
          </div>
        </>
      )}
    </div>
  );
}

