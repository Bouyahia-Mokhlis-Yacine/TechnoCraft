// POST /api/v1/assistant { question, conversation_id? }: read-only, allowlisted (SRS FR-45–47). With
// LLM_URL set, a local model on our own HPC answers from allowlisted tools and sees the earlier turns
// of the conversation (llm/README.md). Without the model, or when its answer fails the checks, the
// built-in deterministic assistant answers, marked `fallback` with the reason.
// `page` ({ path, search }) is the page the question was asked from (assistant dock): the model can
// read that page's figures; `selection` holds parts of it the user selected. Every turn is saved in the caller's conversation. No third-party API.
import type { NextRequest } from 'next/server';
import { ask } from '@/lib/llm';
import { appendTurn, getConversation } from '@/lib/conversations';
import { fail, userOf } from '@/lib/http';
import { describePage } from '@/lib/page-context';
import { sanitizeSelections } from '@/lib/selection';
import { hasSensitiveIdentifier } from '@/lib/privacy';
import { localeOf } from '@/lib/i18n/server';
import { withLocale } from '@/lib/i18n/scope';
import { liveContext, LIVE_QUESTION } from '@/lib/live-context';
import { canSee } from '@/lib/session';
import { shownName } from '@/lib/collection-name';
import { resolveViewOrNull, type View } from '@/lib/dataset';
import { withRun } from '@/lib/run-scope';
import { model } from '@/lib/model';
import { makeT } from '@/lib/i18n';

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to ask questions.');
  if (!canSee(user, '/assistant')) return fail(403, 'forbidden', 'Your account does not have access to the assistant.');
  let body: { question?: unknown; conversation_id?: unknown; page?: { path?: unknown; search?: unknown }; selection?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  if (typeof body.question !== 'string' || !body.question.trim()) return fail(422, 'invalid_payload', 'Expected { question }.');
  if (body.question.length > 500) return fail(422, 'too_long', 'Keep questions under 500 characters.');
  if (hasSensitiveIdentifier(body.question) || hasSensitiveIdentifier(JSON.stringify([body.page, body.selection]))) {
    return fail(422, 'private_identifier', 'Remove payment card identifiers before sending.');
  }
  const id = typeof body.conversation_id === 'string' ? body.conversation_id : null;
  const conv = getConversation(user.id, id);
  if (id && !conv) return fail(404, 'not_found', 'Conversation not found.');
  const question = body.question.trim();
  // asked from another page through the dock: the server rebuilds that page's figures itself
  const path = typeof body.page?.path === 'string' && /^\/[\w\-/%.]*$/.test(body.page.path) && body.page.path.length < 120 && !body.page.path.startsWith('/api') ? body.page.path : null;
  const search = typeof body.page?.search === 'string' && body.page.search.length < 400 ? body.page.search.replace(/^\?/, '') : '';
  // the dataset the operator is viewing (a run pinned on the asking page, else their selection), for the whole answer
  const view = await resolveViewOrNull(new URLSearchParams(search).get('run'));
  if (!view) return fail(409, 'no_dataset', 'No data is selected. Choose or import data in Data & runs.');
  return withRun(view.runId, () => answer(req, user, question, conv, path, search, body.selection, view));
}

async function answer(req: NextRequest, user: NonNullable<ReturnType<typeof userOf>>, question: string, conv: ReturnType<typeof getConversation>,
  path: string | null, search: string, rawSelection: unknown, view: View) {
  const live = path === '/live' || LIVE_QUESTION.test(question);
  if (live && !canSee(user, '/live')) return fail(403, 'forbidden', 'Your account does not have access to Live Monitoring.');
  const page = live ? await liveContext(user.id, question)
    // only a page this account may open: its figures are rebuilt here, never trusted from the browser
    : path && path !== '/assistant' && canSee(user, path) ? withLocale(localeOf(req), () => describePage(path, search, user.id)) : null;
  const selection = page ? sanitizeSelections(rawSelection) : [];
  // the language model answers; the built-in assistant stands in (marked `fallback`) when it cannot
  const locale = localeOf(req);
  const asked = await withLocale(locale, () => ask(question, conv?.turns ?? [], page, selection, user.id, locale));
  // provenance on every answer: which dataset and run its figures come from (live replay answers name the replay instead)
  const t = makeT(locale), label = view.combined ? t('ds.combined', { n: view.ids.length }) : view.kind === 'archive' ? shownName(view.names[0] ?? '', t('ds.satimName')) : t('ds.collection', { name: shownName(view.names[0] ?? '', t('ds.satimName')) });
  const reply = live ? asked : { ...asked, scope: [asked.scope, t('asst.provenance', { label, run: model().snap.run.run_id })].filter(Boolean).join(' · ') };
  const saved = appendTurn(user.id, conv?.id, question, reply, page ? { title: page.title, href: page.link.href } : undefined, selection);
  return Response.json({ ...reply, conversation: { id: saved.id, title: saved.title, updated: saved.updated }, page: page ? { title: page.title, href: page.link.href } : null });
}
