// POST /api/v1/incidents/{id}/review: authorized review action with reason and expected version (SRS FR-05, FR-29).
import type { NextRequest } from 'next/server';
import { getIncident } from '@/lib/api';
import { fail, userOf } from '@/lib/http';
import { model } from '@/lib/model';
import { applyReview, ReviewError, type Action } from '@/lib/reviews';
import { can } from '@/lib/session';

const ACTIONS: Action[] = ['comment', 'acknowledge', 'assign', 'escalate', 'close', 'reopen'];

export async function POST(req: NextRequest, ctx: RouteContext<'/api/v1/incidents/[id]/review'>) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to review incidents.');
  const { id } = await ctx.params;
  if (!getIncident(id)) return fail(404, 'not_found', 'Unknown incident.');
  let body: { action?: string; reason?: string; owner?: string; version?: number };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  const action = body.action as Action;
  if (!ACTIONS.includes(action) || typeof body.version !== 'number') return fail(422, 'invalid_payload', 'Expected { action, reason, version }.');
  if (!can(user.role, action)) return fail(403, 'forbidden', `Your role cannot ${action} incidents.`);
  try {
    const state = applyReview({ target: id, run_id: model().snap.run.run_id, actor: user.role, action, reason: String(body.reason ?? ''), owner: body.owner ? String(body.owner).slice(0, 80) : undefined, version: body.version });
    return Response.json({ incident: id, review: { status: state.status, owner: state.owner, escalated: state.escalated, version: state.version } });
  } catch (e) {
    if (e instanceof ReviewError) return fail(e.status, e.status === 409 ? 'stale_version' : 'invalid_transition', e.message);
    throw e;
  }
}
