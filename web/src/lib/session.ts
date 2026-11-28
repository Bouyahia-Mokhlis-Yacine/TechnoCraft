// Sessions for the local accounts (SRS FR-05, NFR-02). The session is a signed cookie holding the
// account id and version; every request reloads the account, so a deleted or edited account loses
// access at once. Every page, write and export is checked on the server, whatever the UI shows.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { runsDir } from './snapshot';
import { ACTIONS, PAGES, getAccount, type PageKey, type User } from './accounts';

export type { User } from './accounts';
export const COOKIE = 'pai_session';
const TTL_MS = 12 * 3600e3; // session expiry: one shift

/** Local signing key: SESSION_SECRET, else a random key generated once next to the runs. */
function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(/*turbopackIgnore: true*/ runsDir(), '.session-secret');
  try { return fs.readFileSync(file, 'utf8'); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const sign = (body: string) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

export function encode(user: User): string {
  const body = Buffer.from(JSON.stringify({ id: user.id, ver: user.ver, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decode(value: string | undefined): User | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { id, ver, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof id !== 'string' || !(exp > Date.now())) return null;
    const user = getAccount(id);
    return user && user.ver === ver ? user : null;
  } catch { return null; }
}

export async function currentUser(): Promise<User | null> {
  await connection();
  return decode((await cookies()).get(COOKIE)?.value);
}

/** Server-side permission check. 'audit' (the audit ledger) and 'accounts' are the administrator's. */
export function can(user: User | null | undefined, action: string): boolean {
  if (!user) return false;
  if (user.admin) return true;
  return user.actions.some((k) => (ACTIONS[k]?.can as readonly string[] | undefined)?.includes(action));
}
/** Every action the account may take (for the review panel's buttons). */
export const allowed = (user: User | null) => (user ? (user.admin ? Object.values(ACTIONS).flatMap((a) => [...a.can]) : user.actions.flatMap((k) => [...ACTIONS[k].can])) : []);

/** Which page key a path belongs to; null for paths open to every signed-in account. */
export function pageOf(pathname: string): PageKey | 'admin' | null {
  const p = pathname.replace(/^\/api\/v1/, '').replace(/^\/embed/, '');
  if (pathname.startsWith('/admin') || p.startsWith('/accounts')) return 'admin';
  if (pathname.startsWith('/api/v1/')) {
    // API resources map onto the page that shows them
    const api: Record<string, PageKey> = { imports: 'data', overview: 'overview', kpis: 'overview', forecasts: 'overview', incidents: 'incidents', anomalies: 'alerts', advisories: 'intelligence', assistant: 'assistant', reports: 'reports', runs: 'data', rules: 'rules' };
    const [res, kind] = p.split('/').filter(Boolean);
    if (res === 'live') return 'live';
    if (res === 'export') return kind === 'transactions' ? 'transactions' : kind === 'anomalies' ? 'alerts' : kind === 'incidents' ? 'incidents' : null;
    return api[res] ?? null;
  }
  if (p === '/' || p === '') return 'overview';
  const first = `/${p.split('/')[1]}`;
  return (Object.keys(PAGES) as PageKey[]).find((k) => PAGES[k].path === first) ?? null;
}
export function canSee(user: User, pathname: string): boolean {
  const page = pageOf(pathname);
  if (page === 'admin') return user.admin;
  return page === null || user.admin || user.pages.includes(page);
}
/** Where an account lands: the overview if it may see it, else its first page. */
export const homeOf = (user: User) => (user.admin || user.pages.includes('overview') ? '/' : PAGES[user.pages[0] ?? 'overview'].path);
