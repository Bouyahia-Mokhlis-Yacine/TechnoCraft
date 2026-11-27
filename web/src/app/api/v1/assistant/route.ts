// POST /api/v1/assistant { question, conversation_id? }: read-only, allowlisted (SRS FR-45–47). With
// LLM_URL set, a local model on our own HPC answers from allowlisted tools and sees the earlier turns
// of the conversation (llm/README.md); otherwise, or if it fails, the deterministic assistant answers.
// `page` ({ path, search }) is the page the question was asked from (assistant dock): the model can
// read that page's figures; `selection` holds parts of it the user selected. Every turn is saved in the caller's conversation. No third-party API.
import type { NextRequest } from 'next/server';
import { ask } from '@/lib/llm';
import { appendTurn, getConversation } from '@/lib/conversations';
import { fail, userOf } from '@/lib/http';
import { describePage } from '@/lib/page-context';
import { sanitizeSelections } from '@/lib/selection';

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to ask questions.');
  let body: { question?: unknown; conversation_id?: unknown; page?: { path?: unknown; search?: unknown }; selection?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  if (typeof body.question !== 'string' || !body.question.trim()) return fail(422, 'invalid_payload', 'Expected { question }.');
  if (body.question.length > 500) return fail(422, 'too_long', 'Keep questions under 500 characters.');
  const id = typeof body.conversation_id === 'string' ? body.conversation_id : null;
  const conv = getConversation(user.role, id);
  if (id && !conv) return fail(404, 'not_found', 'Conversation not found.');
  const question = body.question.trim();
  // asked from another page through the dock: the server rebuilds that page's figures itself
  const path = typeof body.page?.path === 'string' && /^\/[\w\-/%.]*$/.test(body.page.path) && body.page.path.length < 120 && !body.page.path.startsWith('/api') ? body.page.path : null;
  const search = typeof body.page?.search === 'string' && body.page.search.length < 400 ? body.page.search.replace(/^\?/, '') : '';
  const page = path && path !== '/assistant' ? describePage(path, search, user.role) : null;
  const selection = page ? sanitizeSelections(body.selection) : [];
  const reply = await ask(question, conv?.turns ?? [], page, selection, user.role);
  const saved = appendTurn(user.role, conv?.id, question, reply, page ? { title: page.title, href: page.link.href } : undefined, selection);
  return Response.json({ ...reply, conversation: { id: saved.id, title: saved.title, updated: saved.updated }, page: page ? { title: page.title, href: page.link.href } : null });
}
