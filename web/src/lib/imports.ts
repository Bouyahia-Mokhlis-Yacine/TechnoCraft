// Saved data collections and their analyses (Data & runs → Data collections).
//
// A collection (runs/collections/<id>/collection.json) is a named list of batches; a batch is one
// import operation: one or more validated CSV files (kept under their SHA-256 in
// runs/imports/uploads/) with the coverage the operator declared (partial or complete). A
// collection's `version` is a digest of its batch list, so it changes exactly when data is added.
//
// Every analysis, of one collection or of a selection analysed together, is a run of the Python
// worker `python -m engine.import_batch analyze`, in runs/imports/<run_id>/ with a status.json the
// browser polls. The run ID is derived from the selected collection IDs and their versions, so an
// unchanged selection reuses its result and an updated collection gets a fresh analysis. An import
// changes its collection only after its analysis succeeds; a failure keeps the last good version.
// The original SATIM dataset is a collection like the others (id "satim"): it can be selected alone or with
// others, renamed, appended to, activated, moved to the trash and restored. Its data is the archive the
// engine was built on, read in place (never copied); alone and without added files its analysis is the
// archive's own run (run id null). Its record (name, trash state, added batches) is
// runs/collections/satim/collection.json, written on its first change; the archive files are never touched.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Msg } from './i18n';
import { runsDir, snapshot } from './snapshot';

export type { Msg };
export interface ImportCheck {
  ok: boolean; upload_id: string; filename: string; rows: number; columns?: string[]; missing_columns?: string[];
  errors: Msg[]; warnings: Msg[]; counts?: Record<string, number>;
  first_date?: string; last_date?: string; merchants?: number; usable_rows?: number;
  coverage?: { observed_merchant_days: number; merchant_date_grid: number };
  preview?: { merchant_id: string; transaction_date: string; payment_channel: string; transaction_status: string; merchant_category: string; amount: string }[];
}
export interface ImportPreview {
  ok: boolean; errors: Msg[]; files: number; rows_received: number; invalid_rows: number; duplicates_within: number;
  duplicates_existing: number; rows_ready: number; existing_rows: number; first_date?: string; last_date?: string; merchants?: number;
  coverage?: { observed_merchant_days: number; merchant_date_grid: number };
  /** files skipped because the destination already holds the same file (same SHA-256) */
  already: { upload_id: string; filename: string }[];
  destination: { id: string; name: string } | null;
}
export interface Upload { sha: string; filename: string; rows: number }
export interface Batch {
  batch_id: string; uploads: Upload[]; complete: boolean; actor: string; run_id?: string; rows_added?: number; added_at?: string;
  first_date?: string; last_date?: string; merchants?: number; rows_received?: number;
}
export interface Collection {
  id: string; name: string; created_at: string; created_by: string; updated_at?: string; trashed_at: string | null;
  version: string | null; batches: Batch[];
  stats: { first_date: string; last_date: string; merchants: number; transactions: number; rows_received: number } | null;
  analysis: { version: string; run_id: string } | null;
  pending: { run_id: string; started_at: string } | null;
  last_error: { run_id: string; stage: string; message: string; at: string } | null;
}
export interface SelectionItem { id: string; name: string; version: string }
export interface ImportStatus {
  run_id: string; kind: 'import' | 'view'; selection: SelectionItem[]; collection_id?: string; collection_name?: string;
  filenames: string[]; complete: boolean; created_at: string; updated_at?: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed'; stage?: string; stage_label?: string; stage_order?: string[];
  progress?: { done: number | null; total: number | null; unit: string | null } | null; stages_done?: string[];
  started_at?: string; finished_at?: string; pid?: number; actor?: string;
  result?: { rows_received: number; rows_processed: number; duplicates_removed: number; merchant_days_scored: number; alerts: number; incidents: number; first_date: string; last_date: string; merchants?: number; complete: boolean; rows_added?: number;
    collective_warnings?: number; hybrid_candidates?: number | null; hybrid_note?: string | null; reference_version?: string; preprocessing_version?: string; model_version?: string; contactless_limit_events?: number };
  error?: { stage: string; stage_label: string; message: string; action: string; code?: string; values?: Record<string, string> };
  /** legacy single-file runs (before collections) */
  upload_id?: string; filename?: string;
}

export const SATIM_ID = 'satim';
export const ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), '..');
const dir = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'imports');
const uploads = () => path.join(dir(), 'uploads');
const cdir = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'collections');
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 12;
export const isRunId = (id: string) => /^[a-f0-9]{16}$/.test(id);
export const isCollectionId = (id: string) => id === 'satim' || /^c[a-f0-9]{11}$/.test(id);
const isSha = (s: string) => /^[a-f0-9]{64}$/.test(s);
const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Same interpreter choice as scripts/engine.mjs: SATIM_PYTHON, an active conda env, the repo .venv, python3. */
export function python(): string {
  const venv = path.join(ROOT, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  return process.env.SATIM_PYTHON ?? (process.env.CONDA_PREFIX ? 'python' : fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3');
}
export const env = () => ({ ...process.env, RUNS_DIR: runsDir(), PYTHONNOUSERSITE: '1' });
const engine = (args: string[], timeout = 180_000) => new Promise<string>((resolve, reject) => execFile(python(), ['-m', 'engine.import_batch', ...args],
  { cwd: ROOT, env: env(), timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(new Error('engine process failed')) : resolve(stdout))));
const lastJson = <X,>(out: string) => JSON.parse(out.trim().split('\n').pop() ?? '{}') as X;
const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/* ── uploads ─────────────────────────────────────────────────────────── */

/** Validate one uploaded file with the backend and keep it (owner-readable only) under its SHA-256. */
export async function checkUpload(bytes: Buffer, filename: string): Promise<ImportCheck> {
  fs.mkdirSync(uploads(), { recursive: true, mode: 0o700 });
  const temp = path.join(uploads(), `.incoming-${crypto.randomUUID()}.csv`);
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  try {
    const check = lastJson<ImportCheck>(await engine(['validate', '--file', temp, '--filename', filename], 120_000));
    if (isSha(check.upload_id) && check.ok) {
      fs.renameSync(temp, path.join(uploads(), `${check.upload_id}.csv`));
      writeJson(path.join(uploads(), `${check.upload_id}.json`), { filename, checked_at: new Date().toISOString(), rows: check.rows });
    }
    return check;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function uploadMeta(sha: string): Upload {
  if (!isSha(sha) || !fs.existsSync(path.join(uploads(), `${sha}.csv`))) throw new Error('upload_not_found');
  const m = JSON.parse(fs.readFileSync(path.join(uploads(), `${sha}.json`), 'utf8')) as { filename: string; rows: number };
  return { sha, filename: m.filename, rows: m.rows };
}

/** Combined preview of one import operation (all its files) against the destination collection. */
export async function previewImport(uploadIds: string[], destination: string | null): Promise<ImportPreview> {
  const files = [...new Set(uploadIds)].map(uploadMeta);
  const dest = destination ? getCollection(destination) : null;
  if (destination && (!dest || dest.trashed_at)) throw new Error('collection_not_found');
  const held = new Set(dest?.batches.flatMap((b) => b.uploads.map((u) => u.sha)) ?? []);
  const fresh = files.filter((f) => !held.has(f.sha));
  const already = files.filter((f) => held.has(f.sha)).map((f) => ({ upload_id: f.sha, filename: f.filename }));
  const base = { already, destination: dest ? { id: dest.id, name: dest.name } : null };
  if (!fresh.length) {
    return { ok: false, errors: [{ code: 'files_already_in', text: 'These files are already in this collection: nothing would be added.' }],
      files: 0, rows_received: 0, invalid_rows: 0, duplicates_within: 0, duplicates_existing: 0, rows_ready: 0, existing_rows: 0, ...base };
  }
  const p = lastJson<Omit<ImportPreview, 'already' | 'destination'>>(await engine(['preview', '--uploads', fresh.map((f) => f.sha).join(','), '--existing', [...held].join(',')]));
  return { ...p, ...base };
}

/* ── runs ────────────────────────────────────────────────────────────── */

function read(id: string): ImportStatus | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir(), id, 'status.json'), 'utf8')); } catch { return null; }
}
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** A run whose worker died (server restart, crash) is reported as failed instead of spinning forever. */
export function getImport(id: string): ImportStatus | null {
  if (!isRunId(id)) return null;
  const s = read(id);
  if (!s) return null;
  const quiet = Date.now() - Date.parse(s.updated_at ?? s.created_at);
  if ((s.state === 'running' && !alive(s.pid) && quiet > 5_000) || (s.state === 'queued' && quiet > 60_000)) {
    const failed: ImportStatus = { ...s, state: 'failed', finished_at: new Date().toISOString(),
      error: { stage: s.stage ?? 'collect', stage_label: s.stage_label ?? 'Starting', code: 'worker_stopped', message: 'The analysis process stopped before finishing.', action: 'Retry the analysis; the uploaded files are kept.' } };
    writeJson(path.join(dir(), id, 'status.json'), failed);
    if (s.collection_id) {
      const c = getCollection(s.collection_id);
      if (c?.pending?.run_id === id) saveCollection({ ...c, pending: null, last_error: { run_id: id, stage: failed.error!.stage, message: failed.error!.message, at: failed.finished_at! } });
    }
    return failed;
  }
  return normalize(s);
}
/** Runs written before collections had one file and no kind. */
function normalize(s: ImportStatus): ImportStatus {
  if (s.kind) return s;
  return { ...s, kind: 'import', selection: s.selection ?? [], filenames: s.filenames ?? (s.filename ? [s.filename] : []) };
}

export function listImports(): ImportStatus[] {
  let ids: string[] = [];
  try { ids = fs.readdirSync(dir()).filter(isRunId); } catch { /* no import yet */ }
  return ids.map(getImport).filter((s): s is ImportStatus => !!s).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

interface Spec { kind: 'import' | 'view'; selection: SelectionItem[]; batches: Batch[]; commit: { collection_id: string; batch: Batch; version: string } | null }

/** Start the worker for a run ID (or return the run already there). A failed run with the same ID is retried in place. */
function startRun(runId: string, spec: Spec, extra: Partial<ImportStatus>, actor: string): { status: ImportStatus; existing: boolean } {
  const prior = getImport(runId);
  if (prior && prior.state !== 'failed') return { status: prior, existing: true };
  const folder = path.join(dir(), runId);
  fs.rmSync(path.join(folder, 'snapshot.json'), { force: true });
  const status: ImportStatus = { run_id: runId, kind: spec.kind, selection: spec.selection, filenames: [], complete: spec.batches.every((b) => b.complete),
    created_at: new Date().toISOString(), state: 'queued', stage_label: 'Starting analysis', actor, ...extra };
  writeJson(path.join(folder, 'spec.json'), { run_id: runId, ...spec });
  writeJson(path.join(folder, 'status.json'), status);
  const log = fs.openSync(path.join(folder, 'worker.log'), 'a');
  const child = spawn(python(), ['-m', 'engine.import_batch', 'analyze', '--run-id', runId], { cwd: ROOT, env: env(), detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  return { status: { ...status, pid: child.pid }, existing: false };
}

/** The analysis ID of a selection: the selected collection IDs with their data versions. */
export const viewRunId = (sel: { id: string; version: string }[]) =>
  digest(`view|${[...sel].sort((a, b) => a.id.localeCompare(b.id)).map((s) => `${s.id}:${s.version}`).join('|')}`).slice(0, 16);
const batchId = (shas: string[], complete: boolean) => digest(`${[...shas].sort().join(',')}|${complete ? 'complete' : 'partial'}`).slice(0, 16);
const versionOf = (batches: Batch[]) => digest(batches.map((b) => b.batch_id).join('\n')).slice(0, 12);

/* ── collections ─────────────────────────────────────────────────────── */

const cfile = (id: string) => path.join(cdir(), id, 'collection.json');
import { SATIM_NAME } from './collection-name';
/** The SATIM collection: its stored record over the archive's figures (no record yet = untouched). */
function satimCollection(): Collection | null {
  let saved: Partial<Collection> = {};
  try { saved = JSON.parse(fs.readFileSync(cfile(SATIM_ID), 'utf8')); } catch { /* never changed */ }
  let run: ReturnType<typeof snapshot>['run'], tx: number, merchants: number;
  try { const snap = snapshot(null); run = snap.run; tx = snap.transactions.ts.length; merchants = snap.transactions.merchants.length; } catch { return null; }   // no archive run on this server
  const batches = saved.batches ?? [];
  // without added files its analysis is the archive's own run; with some, the import that added the last ones
  const version = batches.length ? versionOf(batches) : `archive-${run.run_id}`.slice(0, 24);
  const base = { first_date: run.first_date, last_date: run.as_of, merchants, transactions: tx, rows_received: run.cleaning?.raw_rows ?? tx };
  return { id: SATIM_ID, name: saved.name ?? SATIM_NAME, created_at: run.generated_at ?? '1970-01-01T00:00:00Z', created_by: 'system',
    trashed_at: saved.trashed_at ?? null, version, batches, stats: batches.length ? saved.stats ?? base : base,
    analysis: batches.length ? saved.analysis ?? null : null, pending: saved.pending ?? null, last_error: saved.last_error ?? null };
}

export function getCollection(id: string): Collection | null {
  if (!isCollectionId(id)) return null;
  migrate();
  if (id === SATIM_ID) return satimCollection();
  try { return JSON.parse(fs.readFileSync(cfile(id), 'utf8')); } catch { return null; }
}
function saveCollection(c: Collection) { writeJson(cfile(c.id), { ...c, updated_at: new Date().toISOString() }); }

export function listCollections(): Collection[] {
  migrate();
  let ids: string[] = [];
  try { ids = fs.readdirSync(cdir()).filter((x) => isCollectionId(x) && x !== SATIM_ID); } catch { /* none yet */ }
  const sat = satimCollection();
  // newest first; the SATIM collection is the oldest data and comes last
  return [...ids.map(getCollection).filter((c): c is Collection => !!c).sort((a, b) => b.created_at.localeCompare(a.created_at)), ...(sat ? [sat] : [])];
}

/** One-time move of the single-file imported runs made before collections into collections of their own. */
let migrated = false;
function migrate() {
  if (migrated) return;
  migrated = true;
  const marker = path.join(cdir(), '.migrated');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(cdir(), { recursive: true, mode: 0o700 });
  let ids: string[] = [];
  try { ids = fs.readdirSync(dir()).filter(isRunId); } catch { /* nothing to move */ }
  for (const id of ids) {
    const s = read(id);
    if (!s || s.kind || s.state !== 'succeeded' || !s.upload_id || !s.result || !fs.existsSync(path.join(dir(), id, 'snapshot.json'))) continue;
    const batch: Batch = { batch_id: batchId([s.upload_id], s.complete), uploads: [{ sha: s.upload_id, filename: s.filename ?? 'import.csv', rows: s.result.rows_received }],
      complete: s.complete, actor: s.actor ?? 'admin', run_id: id, rows_added: s.result.rows_processed, added_at: s.finished_at ?? s.created_at,
      first_date: s.result.first_date, last_date: s.result.last_date, rows_received: s.result.rows_received };
    const version = versionOf([batch]);
    let merchants = 0;
    try { merchants = (JSON.parse(fs.readFileSync(path.join(dir(), id, 'snapshot.json'), 'utf8')) as { transactions: { merchants: string[] } }).transactions.merchants.length; } catch { /* left at 0 */ }
    const c: Collection = { id: `c${crypto.randomBytes(6).toString('hex').slice(0, 11)}`, name: (s.filename ?? 'Import').replace(/\.csv$/i, ''),
      created_at: s.created_at, created_by: s.actor ?? 'admin', trashed_at: null, version, batches: [batch],
      stats: { first_date: s.result.first_date, last_date: s.result.last_date, merchants, transactions: s.result.rows_processed, rows_received: s.result.rows_received },
      analysis: { version, run_id: id }, pending: null, last_error: null };
    saveCollection(c);
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

export const cleanName = (name: string) => name.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

function createCollection(name: string, actor: string): Collection {
  const clean = cleanName(name);
  if (!clean) throw new Error('name_required');
  if (listCollections().some((c) => !c.trashed_at && c.name.toLowerCase() === clean.toLowerCase())) throw new Error('name_taken');
  const c: Collection = { id: `c${crypto.randomBytes(6).toString('hex').slice(0, 11)}`, name: clean, created_at: new Date().toISOString(), created_by: actor,
    trashed_at: null, version: null, batches: [], stats: null, analysis: null, pending: null, last_error: null };
  saveCollection(c);
  return c;
}

export type Destination = { name: string } | { collection: string };
export interface StartResult { status: ImportStatus | null; existing: boolean; collection: Collection; skipped: string[] }

/** Start an import: all its files become one batch of the destination (a new or an existing collection). */
export function startImport(uploadIds: string[], complete: boolean, destination: Destination, actor: string): StartResult {
  const files = [...new Set(uploadIds)].map(uploadMeta);
  if (!files.length || files.length > MAX_FILES) throw new Error('invalid_files');
  if (listCollections().some((c) => c.pending && ['queued', 'running'].includes(getImport(c.pending.run_id)?.state ?? ''))) throw new Error('busy');
  let dest: Collection;
  if ('collection' in destination) {
    const c = getCollection(destination.collection);
    if (!c || c.trashed_at) throw new Error('collection_not_found');
    dest = c;
  } else dest = createCollection(destination.name, actor);
  const held = new Set(dest.batches.flatMap((b) => b.uploads.map((u) => u.sha)));
  const fresh = files.filter((f) => !held.has(f.sha));
  const skipped = files.filter((f) => held.has(f.sha)).map((f) => f.filename);
  if (!fresh.length) return { status: null, existing: true, collection: dest, skipped };
  const batch: Batch = { batch_id: batchId(fresh.map((f) => f.sha), complete), uploads: fresh, complete, actor };
  const batches = [...dest.batches, batch];
  const version = versionOf(batches);
  const selection = [{ id: dest.id, name: dest.name, version }];
  const runId = viewRunId(selection);
  const started = startRun(runId, { kind: 'import', selection, batches, commit: { collection_id: dest.id, batch, version } },
    { collection_id: dest.id, collection_name: dest.name, filenames: fresh.map((f) => f.filename), complete }, actor);
  if (!started.existing) saveCollection({ ...dest, pending: { run_id: runId, started_at: started.status.created_at }, last_error: null });
  return { ...started, collection: getCollection(dest.id) ?? dest, skipped };
}

/** Retry a failed run. An import retries the same batch only if its collection has not changed since. */
export function retryImport(id: string, actor: string) {
  const s = getImport(id);
  if (!s || s.state !== 'failed') throw new Error('not_failed');
  const spec = JSON.parse(fs.readFileSync(path.join(dir(), id, 'spec.json'), 'utf8')) as Spec;
  if (spec.commit) {
    const c = getCollection(spec.commit.collection_id);
    if (!c || c.trashed_at || versionOf(c.batches) !== versionOf(spec.batches.slice(0, -1))) throw new Error('stale');
    const r = startRun(id, spec, { collection_id: s.collection_id, collection_name: c.name, filenames: s.filenames, complete: s.complete }, actor);
    saveCollection({ ...c, pending: { run_id: id, started_at: r.status.created_at }, last_error: null });
    return r;
  }
  return startRun(id, spec, { filenames: s.filenames }, actor);
}

export function trashCollection(id: string) {
  const c = getCollection(id);
  if (!c) throw new Error('collection_not_found');
  if (c.pending && ['queued', 'running'].includes(getImport(c.pending.run_id)?.state ?? '')) throw new Error('busy');
  saveCollection({ ...c, trashed_at: new Date().toISOString() });
}
export function restoreCollection(id: string) {
  const c = getCollection(id);
  if (!c) throw new Error('collection_not_found');
  // a restored name that clashes with an active collection gets a suffix rather than failing
  const taken = new Set(listCollections().filter((x) => !x.trashed_at).map((x) => x.name.toLowerCase()));
  let name = c.name;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${c.name} (${n})`;
  saveCollection({ ...c, name, trashed_at: null });
}
export function renameCollection(id: string, name: string) {
  const c = getCollection(id);
  if (!c || c.trashed_at) throw new Error('collection_not_found');
  const clean = cleanName(name);
  if (!clean) throw new Error('name_required');
  if (listCollections().some((x) => x.id !== id && !x.trashed_at && x.name.toLowerCase() === clean.toLowerCase())) throw new Error('name_taken');
  saveCollection({ ...c, name: clean });
}

/* ── the analysed view of a selection ────────────────────────────────── */

export const usable = (c: Collection | null | undefined): c is Collection => !!c && !c.trashed_at && !!c.version && !!c.stats;

/** The analysis of a selection of collections: the collection's own analysis for one, a combined run for several.
 *  runId null: the SATIM collection alone without added files, read from the archive's own run. */
export function selectionRun(cols: Collection[], actor = 'system'): { runId: string | null; status: ImportStatus | null } {
  if (cols.length === 1 && cols[0].id === SATIM_ID && !cols[0].batches.length) return { runId: null, status: null };
  if (cols.length === 1 && cols[0].analysis?.version === cols[0].version) return { runId: cols[0].analysis.run_id, status: getImport(cols[0].analysis.run_id) };
  const selection = cols.map((c) => ({ id: c.id, name: c.name, version: c.version! }));
  const runId = viewRunId(selection);
  const existing = getImport(runId);
  if (existing) return { runId, status: existing };
  // the union of the selected collections' batches, in a stable order; duplicates are removed by the engine's cleaning
  const batches = [...cols].sort((a, b) => a.id.localeCompare(b.id)).flatMap((c) => c.batches);
  return { runId, status: startRun(runId, { kind: 'view', selection, batches, commit: null }, { filenames: [] }, actor).status };
}

/** The newest successful analysis of exactly these collections (any earlier versions): shown while a fresh one runs. */
export function lastGoodRun(ids: string[]): ImportStatus | null {
  const want = [...ids].sort().join(',');
  return listImports().find((s) => s.state === 'succeeded' && s.selection.map((x) => x.id).sort().join(',') === want
    && fs.existsSync(path.join(dir(), s.run_id, 'snapshot.json'))) ?? null;
}

/* ── platform-wide active dataset ──────────────────────────────────────── */
// The administrator can make collections the active dataset for every account (runs/active.json).
// An account that chose a dataset itself (the pai_view cookie, including an explicit return to SATIM)
// keeps its choice. The official SATIM run, its prediction file and its reviews are never changed by this.
export interface ActiveDataset { ids: string[]; activated_at: string; actor: string }
const activeFile = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'active.json');
export function getActive(): ActiveDataset | null {
  try {
    const a = JSON.parse(fs.readFileSync(activeFile(), 'utf8')) as ActiveDataset;
    const ids = a.ids.filter((id) => usable(getCollection(id)));
    return ids.length ? { ...a, ids } : null;
  } catch { return null; }
}
/** What an account sees when it chose nothing itself: the platform's active dataset, else the SATIM collection if it is still there. */
export const defaultIds = () => getActive()?.ids ?? (usable(getCollection(SATIM_ID)) ? [SATIM_ID] : []);
export function setActive(ids: string[], actor: string): ActiveDataset | null {
  if (!ids.length) { fs.rmSync(activeFile(), { force: true }); return null; }
  if (ids.some((id) => !usable(getCollection(id)))) throw new Error('not_selectable');
  const a = { ids, activated_at: new Date().toISOString(), actor };
  writeJson(activeFile(), a);
  return a;
}
/** The operational predictions of a finished run: every scored merchant-day, never the sealed submission. */
export function predictionsFile(runId: string): string | null {
  if (!isRunId(runId)) return null;
  const f = path.join(dir(), runId, 'operational_predictions.csv');
  return fs.existsSync(f) ? f : null;
}

