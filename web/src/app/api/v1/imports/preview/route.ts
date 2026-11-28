// POST /api/v1/imports/preview { upload_ids, destination? }: combined preview of one import
// operation (all its validated files) against the destination collection: date range, merchants,
// rows received, duplicates (across the files and with the destination) and rows ready. Administrator only.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { MAX_FILES, previewImport } from '@/lib/imports';

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can import transactions.');
  let body: { upload_ids?: unknown; destination?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  const ids = body.upload_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES || ids.some((x) => typeof x !== 'string')) return fail(422, 'invalid_payload', 'Expected { upload_ids: string[], destination?: string }.');
  try {
    return Response.json(await previewImport(ids as string[], typeof body.destination === 'string' ? body.destination : null));
  } catch (e) {
    const m = (e as Error).message;
    if (m === 'upload_not_found') return fail(404, 'upload_not_found', 'A file is no longer available. Upload it again.');
    if (m === 'collection_not_found') return fail(404, 'collection_not_found', 'Collection not found.');
    return fail(500, 'preview_failed', 'The backend could not prepare the preview.');
  }
}
