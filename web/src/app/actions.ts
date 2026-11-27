'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE, encode, ROLES, type Role } from '@/lib/session';

/** Demo sign-in: local accounts only, one per role (SRS FR-05). */
export async function signIn(form: FormData) {
  const role = String(form.get('role')) as Role;
  if (!(role in ROLES)) redirect('/login?error=role');
  (await cookies()).set(COOKIE, encode(role), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 3600 });
  const next = String(form.get('next') ?? '/');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}
