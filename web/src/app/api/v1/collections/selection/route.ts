// POST /api/v1/collections/selection { ids }: show these collections on every page, for this account (one
// collection: its analysis; several, the original SATIM collection included: one combined analysis, started
// here if needed). The selection is kept in the pai_view cookie.
import { NextResponse, type NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { getCollection, usable } from '@/lib/imports';
import { VIEW_COOKIE } from '@/lib/dataset';
import { collectionsPayload } from '../shared';

export async function POST(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  let body: { ids?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== 'string') || body.ids.length > 20) return fail(422, 'invalid_payload', 'Expected { ids: string[] }.');
  const ids = [...new Set(body.ids as string[])];
  if (!ids.length) return fail(422, 'empty_selection', 'Select at least one collection.');
  const cols = ids.map(getCollection);
  if (cols.some((c) => !usable(c))) return fail(409, 'not_selectable', 'A selected collection is in the trash or has no analysed data yet.');
  const res = NextResponse.json(collectionsPayload(ids));
  res.cookies.set(VIEW_COOKIE, ids.join('.'), { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 30 * 864e2 });
  return res;
}
