// POST /api/v1/collections/active { ids }: make these collections the active dataset for every account
// (their analysis feeds the pages that follow the dataset selector). [] returns the platform to its default
// (the original SATIM collection while it exists). Administrator only. Accounts that chose a dataset themselves keep their choice.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { idsFor, VIEW_COOKIE } from '@/lib/dataset';
import { setActive } from '@/lib/imports';
import { appendEvent } from '@/lib/reviews';
import { collectionsPayload } from '../shared';

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can change the active dataset.');
  let body: { ids?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== 'string') || body.ids.length > 20) return fail(422, 'invalid_payload', 'Expected { ids: string[] }.');
  const ids = [...new Set(body.ids as string[])];
  try { setActive(ids, user.id); } catch { return fail(409, 'not_selectable', 'A collection is in the trash or has no analysed data yet.'); }
  appendEvent({ actor: user.id, action: 'activate', target: `dataset:${ids.join('.') || 'default'}`, run_id: 'platform', reason: 'Platform active dataset', prior: 'new', next: 'new', escalated: false, version: 0 });
  return Response.json(collectionsPayload(idsFor(req.cookies.get(VIEW_COOKIE)?.value)));
}
