// What the Data collections card and the active-dataset control read: the protected SATIM dataset,
// the saved collections (active and in the trash), the selection and the state of its analysis.
import { getMeta } from '@/lib/api';
import { getActive, getImport, listCollections, listImports, usable, type Collection, type ImportStatus } from '@/lib/imports';
import { viewOf, type View } from '@/lib/dataset';

export interface CollectionRow {
  id: string; name: string; protected: boolean; trashed_at: string | null; usable: boolean;
  first_date: string | null; last_date: string | null; merchants: number | null; transactions: number | null;
  batches: { batch_id: string; filenames: string[]; complete: boolean; added_at?: string; actor: string; rows_added?: number; first_date?: string; last_date?: string; run_id?: string }[];
  pending: ImportStatus | null; last_error: Collection['last_error'];
}

export function satimRow(): CollectionRow {
  const m = getMeta();
  return { id: 'satim', name: 'SATIM', protected: true, trashed_at: null, usable: true, first_date: m.firstDate, last_date: m.asOf,
    merchants: m.merchants.length, transactions: m.transactions, batches: [], pending: null, last_error: null };
}

export function rowOf(c: Collection): CollectionRow {
  const pending = c.pending ? getImport(c.pending.run_id) : null;
  return { id: c.id, name: c.name, protected: false, trashed_at: c.trashed_at, usable: usable(c),
    first_date: c.stats?.first_date ?? null, last_date: c.stats?.last_date ?? null, merchants: c.stats?.merchants ?? null, transactions: c.stats?.transactions ?? null,
    batches: c.batches.map((b) => ({ batch_id: b.batch_id, filenames: b.uploads.map((u) => u.filename), complete: b.complete, added_at: b.added_at, actor: b.actor, rows_added: b.rows_added, first_date: b.first_date, last_date: b.last_date, run_id: b.run_id })),
    pending: pending && (pending.state === 'queued' || pending.state === 'running') ? pending : null, last_error: c.last_error };
}

export function collectionsPayload(ids: string[]) {
  const all = listCollections();
  const active = all.filter((c) => !c.trashed_at);
  const chosen = ids.map((id) => active.find((c) => c.id === id)).filter(usable);
  const view: View | null = chosen.length ? viewOf(chosen) : null;
  return {
    satim: satimRow(), collections: active.map(rowOf), trash: all.filter((c) => c.trashed_at).map(rowOf),
    selection: chosen.map((c) => c.id),
    // the administrator's platform-wide active dataset (null: the official SATIM run)
    active: getActive(),
    // finished and failed operational imports, newest first, for the run history table
    runs: listImports().filter((r) => r.kind === 'import').slice(0, 50).map((r) => ({
      run_id: r.run_id, collection_id: r.collection_id ?? null, collection_name: r.collection_name ?? r.filename ?? null, filenames: r.filenames,
      created_at: r.created_at, state: r.state, complete: r.complete, result: r.result ?? null, error: r.error ? { message: r.error.message, code: r.error.code } : null,
      current: !!r.collection_id && all.find((c) => c.id === r.collection_id)?.analysis?.run_id === r.run_id,
    })),
    view: view && { ids: view.ids, names: view.names, run_id: view.runId, state: view.state, combined: view.combined, status: view.status },
  };
}
