'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE, encode, homeOf } from '@/lib/session';
import { verifyLogin } from '@/lib/accounts';

/** Sign-in with a local account (SRS FR-05). Errors never say whether the username exists. */
export async function signIn(form: FormData) {
  const id = String(form.get('username') ?? '').trim(), pw = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '');
  const back = `/login?${new URLSearchParams(next ? { next } : {})}`;
  if (!id || !pw) redirect(`${back}&error=invalid`);
  const r = verifyLogin(id, pw);
  if ('error' in r) redirect(`${back}&error=${r.error}`);
  (await cookies()).set(COOKIE, encode(r.user), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 3600 });
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : homeOf(r.user));
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}
