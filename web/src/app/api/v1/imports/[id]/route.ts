// GET /api/v1/imports/{id}: status of one analysis run (stage, real counts, result or failure).
// POST /api/v1/imports/{id}: retry a failed run (same files, same destination). Signed-in users may
// read a run's status (combined views are analysed for everyone); only the administrator retries imports.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { getImport, retryImport } from '@/lib/imports';

export async function GET(req: NextRequest, ctx: RouteContext<'/api/v1/imports/[id]'>) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const s = getImport((await ctx.params).id);
  return s ? Response.json({ run: s }, { headers: { 'cache-control': 'no-store' } }) : fail(404, 'not_found', 'Run not found.');
}

export async function POST(req: NextRequest, ctx: RouteContext<'/api/v1/imports/[id]'>) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  const s = getImport((await ctx.params).id);
  if (!s) return fail(404, 'not_found', 'Run not found.');
  if (s.kind === 'import' && !can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can retry imports.');
  try {
    const { status } = retryImport(s.run_id, user.id);
    return Response.json({ run: status }, { status: 202 });
  } catch (e) {
    if ((e as Error).message === 'stale') return fail(409, 'stale', 'The collection changed since this import started. Import the files again.');
    return fail(409, 'not_retryable', 'Only a failed run can be retried.');
  }
}
