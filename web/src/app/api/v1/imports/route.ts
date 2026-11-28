// GET /api/v1/imports: import runs (newest first). POST { upload_ids, complete, destination }: start
// one import. Its files become one batch of the destination, { name } for a new collection or
// { collection } for an existing one. The worker runs in the background and the collection changes
// only when its analysis succeeds. Files the destination already holds are skipped, never counted
// twice. Administrator only.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { listImports, MAX_FILES, startImport, type Destination } from '@/lib/imports';

const ERR: Record<string, [number, string]> = {
  upload_not_found: [404, 'A file is no longer available. Upload it again.'], invalid_files: [422, 'Choose between 1 and 12 validated files.'],
  busy: [409, 'Another import is running. Wait until it finishes.'],
  collection_not_found: [404, 'Collection not found.'], name_required: [422, 'Give the new collection a name.'], name_taken: [409, 'Another collection already has this name.'],
};

export async function GET(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can see imports.');
  return Response.json({ imports: listImports().filter((s) => s.kind === 'import') }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can import transactions.');
  let body: { upload_ids?: unknown; complete?: unknown; destination?: { name?: unknown; collection?: unknown } };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  const ids = body.upload_ids, d = body.destination;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES || ids.some((x) => typeof x !== 'string') || !d || (typeof d.name !== 'string' && typeof d.collection !== 'string'))
    return fail(422, 'invalid_payload', 'Expected { upload_ids, complete, destination: { name } | { collection } }.');
  const destination: Destination = typeof d.collection === 'string' ? { collection: d.collection } : { name: d.name as string };
  try {
    const r = startImport(ids as string[], body.complete === true, destination, user.id);
    return Response.json({ run: r.status, existing: r.existing, collection: { id: r.collection.id, name: r.collection.name }, skipped: r.skipped }, { status: r.status && !r.existing ? 202 : 200 });
  } catch (e) {
    const code = (e as Error).message;
    const [status, message] = ERR[code] ?? [500, 'The import could not start.'];
    return fail(status, code in ERR ? code : 'start_failed', message);
  }
}
