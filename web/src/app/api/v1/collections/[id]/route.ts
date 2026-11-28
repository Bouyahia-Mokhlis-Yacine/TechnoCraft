// PATCH /api/v1/collections/{id} { action: "trash" | "restore" | "rename", name? }. Administrator only.
// Every collection, the original SATIM one included, follows the same rules. A collection moved to the trash
// leaves this account's selection; when nothing is left selected, the pages invite to choose or import data.
import { NextResponse, type NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { renameCollection, restoreCollection, trashCollection } from '@/lib/imports';
import { idsFor, VIEW_COOKIE } from '@/lib/dataset';
import { collectionsPayload } from '../shared';

const ERR: Record<string, [number, string]> = {
  collection_not_found: [404, 'Collection not found.'], busy: [409, 'An import into this collection is running. Wait until it finishes.'],
  name_required: [422, 'Give the collection a name.'], name_taken: [409, 'Another collection already has this name.'],
};

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/v1/collections/[id]'>) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can change collections.');
  const { id } = await ctx.params;
  let body: { action?: unknown; name?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  let ids = idsFor(req.cookies.get(VIEW_COOKIE)?.value);
  try {
    if (body.action === 'trash') { trashCollection(id); ids = ids.filter((x) => x !== id); }
    else if (body.action === 'restore') restoreCollection(id);
    else if (body.action === 'rename' && typeof body.name === 'string') renameCollection(id, body.name);
    else return fail(422, 'invalid_payload', 'Expected { action: "trash" | "restore" | "rename" }.');
  } catch (e) {
    const [status, message] = ERR[(e as Error).message] ?? [500, 'The change could not be saved.'];
    return fail(status, (e as Error).message in ERR ? (e as Error).message : 'failed', message);
  }
  const res = NextResponse.json(collectionsPayload(ids));
  // an explicit (possibly empty) choice: an emptied selection does not silently fall back to another dataset
  res.cookies.set(VIEW_COOKIE, ids.join('.') || '-', { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 30 * 864e2 });
  return res;
}
