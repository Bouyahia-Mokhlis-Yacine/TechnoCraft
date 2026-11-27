// GET / PATCH { title } / DELETE /api/v1/assistant/conversations/{id}: one of the caller's conversations.
import type { NextRequest } from 'next/server';
import { deleteConversation, getConversation, renameConversation } from '@/lib/conversations';
import { fail, userOf } from '@/lib/http';

type Ctx = RouteContext<'/api/v1/assistant/conversations/[id]'>;

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to see your conversations.');
  const c = getConversation(user.role, (await ctx.params).id);
  return c ? Response.json(c) : fail(404, 'not_found', 'Conversation not found.');
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to rename conversations.');
  let body: { title?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  if (typeof body.title !== 'string' || !body.title.trim()) return fail(422, 'invalid_payload', 'Expected { title }.');
  const c = renameConversation(user.role, (await ctx.params).id, body.title);
  return c ? Response.json({ id: c.id, title: c.title }) : fail(404, 'not_found', 'Conversation not found.');
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to delete conversations.');
  return deleteConversation(user.role, (await ctx.params).id) ? new Response(null, { status: 204 }) : fail(404, 'not_found', 'Conversation not found.');
}
