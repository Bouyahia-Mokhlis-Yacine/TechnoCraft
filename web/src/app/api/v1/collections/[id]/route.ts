// PATCH /api/v1/collections/{id} { action: "trash" | "restore" | "rename", name? }. Administrator only.
// The SATIM dataset is protected. A collection moved to the trash leaves the active selection; when
// nothing is left selected, the original SATIM dataset is active again.
import { NextResponse, type NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { renameCollection, restoreCollection, SATIM_ID, trashCollection } from '@/lib/imports';
import { parseIds, VIEW_COOKIE } from '@/lib/dataset';
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
  if (id === SATIM_ID) return fail(403, 'protected', 'The original SATIM dataset is protected.');
  let body: { action?: unknown; name?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  let ids = parseIds(req.cookies.get(VIEW_COOKIE)?.value);
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
  if (ids.length) res.cookies.set(VIEW_COOKIE, ids.join('.'), { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 30 * 864e2 });
  else res.cookies.delete(VIEW_COOKIE);
  return res;
}
