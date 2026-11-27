// POST /api/v1/reports/{id}/undo: back to the previous version of a report the assistant composed.
import type { NextRequest } from 'next/server';
import { undoReport } from '@/lib/custom-report';
import { fail, userOf } from '@/lib/http';

export async function POST(req: NextRequest, ctx: RouteContext<'/api/v1/reports/[id]/undo'>) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  const r = undoReport(user.role, (await ctx.params).id);
  return r ? Response.json({ id: r.id, version: r.version }) : fail(404, 'not_found', 'Nothing to undo.');
}
