'use server';
// Account administration. Every action re-checks that the caller is the administrator and is
// written to the audit ledger (who changed which account, and how).
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AccountError, createAccount, deleteAccount, setPassword, updateAccess } from '@/lib/accounts';
import { COOKIE, currentUser, encode } from '@/lib/session';
import { appendEvent } from '@/lib/reviews';
import { getAccount } from '@/lib/accounts';
import { model } from '@/lib/model';

async function admin() {
  const user = await currentUser();
  if (!user?.admin) redirect('/');
  return user;
}
const log = (actor: string, id: string, reason: string) =>
  appendEvent({ actor, action: 'account', target: `account:${id}`, run_id: model().snap.run.run_id, reason, prior: 'new', next: 'new', escalated: false, version: 0 });
const list = (f: FormData, k: string) => f.getAll(k).map(String);
const back = (q: Record<string, string>) => redirect(`/admin?${new URLSearchParams(q)}`);

/** Runs one change; AccountError messages go back to the page, anything else is a real failure. */
async function attempt(fn: () => string) {
  let done: string;
  try { done = fn(); } catch (e) {
    if (e instanceof AccountError) back({ error: e.message });
    throw e;
  }
  back({ done });
}

export async function create(f: FormData) {
  const me = await admin();
  await attempt(() => {
    const u = createAccount({ id: String(f.get('id') ?? ''), name: String(f.get('name') ?? ''), password: String(f.get('password') ?? ''), pages: list(f, 'pages'), actions: list(f, 'actions') });
    log(me.id, u.id, `created · pages: ${u.pages.join(', ')} · actions: ${u.actions.join(', ') || 'none'}`);
    return `Account ${u.id} created.`;
  });
}

export async function update(f: FormData) {
  const me = await admin();
  await attempt(() => {
    const u = updateAccess(String(f.get('id')), { name: String(f.get('name') ?? ''), pages: list(f, 'pages'), actions: list(f, 'actions') });
    log(me.id, u.id, `access changed · pages: ${u.pages.join(', ')} · actions: ${u.actions.join(', ') || 'none'}`);
    return `Access for ${u.id} saved. Their open sessions were signed out.`;
  });
}

export async function resetPassword(f: FormData) {
  const me = await admin();
  const id = String(f.get('id'));
  await attempt(() => {
    setPassword(id, String(f.get('password') ?? ''));
    log(me.id, id, 'password reset');
    return id === me.id ? 'Your password was changed.' : `Password for ${id} reset. Their open sessions were signed out.`;
  });
}

/** Changing one's own password bumps the session version: keep the administrator signed in. */
export async function resetOwnPassword(f: FormData) {
  const me = await admin();
  try { setPassword(me.id, String(f.get('password') ?? '')); } catch (e) {
    if (e instanceof AccountError) back({ error: e.message });
    throw e;
  }
  log(me.id, me.id, 'password changed');
  const fresh = getAccount(me.id);
  if (fresh) (await cookies()).set(COOKIE, encode(fresh), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 3600 });
  back({ done: 'Your password was changed.' });
}

export async function remove(f: FormData) {
  const me = await admin();
  const id = String(f.get('id'));
  if (f.get('confirm') !== 'yes') back({ error: `Tick “confirm” to delete ${id}.` });
  await attempt(() => { deleteAccount(id); log(me.id, id, 'deleted'); return `Account ${id} deleted.`; });
}
