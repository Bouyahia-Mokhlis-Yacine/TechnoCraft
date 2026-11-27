// POST /api/v1/collections/selection { ids }: make these collections the active dataset (one
// collection: its analysis; several: one combined analysis, started here if needed). [] or ["satim"]
// returns to the original SATIM dataset. The selection is kept in the pai_view cookie.
import { NextResponse, type NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { getCollection, SATIM_ID, usable } from '@/lib/imports';
import { VIEW_COOKIE } from '@/lib/dataset';
import { collectionsPayload } from '../shared';

export async function POST(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  let body: { ids?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== 'string') || body.ids.length > 20) return fail(422, 'invalid_payload', 'Expected { ids: string[] }.');
  const raw = [...new Set(body.ids as string[])];
  if (raw.includes(SATIM_ID) && raw.length > 1) return fail(422, 'satim_alone', 'The original SATIM dataset is analysed by the official pipeline and cannot be combined with imported collections. Select it alone.');
  const ids = raw.filter((id) => id !== SATIM_ID);
  const cols = ids.map(getCollection);
  if (cols.some((c) => !usable(c))) return fail(409, 'not_selectable', 'A selected collection is in the trash or has no analysed data yet.');
  const res = NextResponse.json(collectionsPayload(ids));
  if (ids.length) res.cookies.set(VIEW_COOKIE, ids.join('.'), { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 30 * 864e2 });
  else res.cookies.delete(VIEW_COOKIE);
  return res;
}
