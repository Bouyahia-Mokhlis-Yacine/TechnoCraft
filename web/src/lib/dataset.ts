// The active dataset: the original SATIM dataset (official run) or one or more saved collections.
// The selection is kept in the `pai_view` cookie, so it follows the operator across pages and
// refreshes; `?run=<16 hex>` pins one analysis version (links such as "View transactions for this
// alert" carry it, so a refresh shows exactly the same records).
import fs from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { getActive, getImport, getCollection, isCollectionId, isRunId, lastGoodRun, listCollections, selectionRun, usable, type Collection, type ImportStatus } from './imports';
import { runsDir } from './snapshot';
import { pinRun } from './run-scope';

export const VIEW_COOKIE = 'pai_view';
export const parseIds = (v: string | undefined | null) => [...new Set((v ?? '').split('.').filter(isCollectionId))];

export interface View {
  kind: 'official' | 'collections';
  ids: string[]; names: string[];
  /** the analysis the pages show (null: nothing to show yet) */
  runId: string | null;
  /** ready: current data · running/failed: a fresh analysis is running or failed (runId is the previous one, if any) */
  state: 'ready' | 'running' | 'failed';
  status: ImportStatus | null;
  pinned: boolean; combined: boolean;
  /** query string to keep on internal links ("run=…" when pinned, else "") */
  keep: string;
}
const OFFICIAL: View = { kind: 'official', ids: [], names: [], runId: null, state: 'ready', status: null, pinned: false, combined: false, keep: '' };

/** The account's own choice (cookie; "satim" is an explicit return to the official run), else the platform's active dataset. */
export const idsFor = (cookie: string | undefined) => (cookie !== undefined ? parseIds(cookie) : getActive()?.ids ?? []);
export async function selectedIds(): Promise<string[]> {
  return idsFor((await cookies()).get(VIEW_COOKIE)?.value);
}

/** The view for a page: a pinned `run` when given and available, else the cookie selection, else the official run. */
/** The view for a page; it also pins its run for the rest of the request (lib/run-scope.ts). */
export async function resolveView(runParam?: string | null): Promise<View> {
  const view = await viewFor(runParam);
  pinRun(view.runId);
  return view;
}

async function viewFor(runParam?: string | null): Promise<View> {
  if (runParam && isRunId(runParam) && fs.existsSync(path.join(/*turbopackIgnore: true*/ runsDir(), 'imports', runParam, 'snapshot.json'))) {
    const s = getImport(runParam);
    let ids = s?.selection.map((x) => x.id) ?? [], names = s?.selection.map((x) => x.name) ?? [];
    if (!ids.length) {   // a collection's first analysis made before collections existed
      const owner = listCollections().find((c) => c.analysis?.run_id === runParam);
      if (owner) { ids = [owner.id]; names = [owner.name]; }
    }
    names = ids.map((id, i) => getCollection(id)?.name ?? names[i] ?? id);
    return { kind: 'collections', ids, names, runId: runParam, state: 'ready', status: s, pinned: true, combined: ids.length > 1, keep: `run=${runParam}` };
  }
  const cols = (await selectedIds()).map(getCollection).filter(usable);
  if (!cols.length) return OFFICIAL;
  return viewOf(cols);
}

export function viewOf(cols: Collection[]): View {
  const ids = cols.map((c) => c.id), names = cols.map((c) => c.name);
  const { runId, status } = selectionRun(cols);
  const base = { kind: 'collections' as const, ids, names, status, pinned: false, combined: cols.length > 1, keep: '' };
  if (status?.state === 'succeeded') return { ...base, runId, state: 'ready' };
  const fallback = lastGoodRun(ids);
  return { ...base, runId: fallback?.run_id ?? null, state: status?.state === 'failed' ? 'failed' : 'running' };
}

/** Append `keep` (the pinned run) to an internal link. */
export const keepRun = (href: string, view: Pick<View, 'keep'>) => (view.keep ? `${href}${href.includes('?') ? '&' : '?'}${view.keep}` : href);
