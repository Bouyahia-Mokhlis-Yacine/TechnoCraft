// Local accounts (runs/accounts.json). One administrator creates the other accounts and chooses
// the pages each one sees and the actions it may take. Passwords are scrypt hashes; nothing here
// is ever sent to the browser except names, pages and actions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from './snapshot';
import type { KpiCard } from './formula';

/** Pages an account can be given. Detail pages follow their list (an incident page needs Incidents). */
export const PAGES = {
  overview: { label: 'Overview', path: '/' },
  live: { label: 'Live Monitoring', path: '/live' },
  incidents: { label: 'Incidents', path: '/incidents' },
  alerts: { label: 'Alerts', path: '/alerts' },
  intelligence: { label: 'Intelligence', path: '/intelligence' },
  merchants: { label: 'Merchants', path: '/merchants' },
  transactions: { label: 'Transactions', path: '/transactions' },
  assistant: { label: 'Assistant', path: '/assistant' },
  simulate: { label: 'Simulator', path: '/simulate' },
  reports: { label: 'Reports', path: '/reports' },
  data: { label: 'Data & runs', path: '/data' },
  learning: { label: 'Controlled learning', path: '/learning' },
} as const;
export type PageKey = keyof typeof PAGES;

/** Action groups the administrator ticks per account. */
export const ACTIONS = {
  review: { label: 'Review incidents', help: 'Comment and acknowledge', can: ['comment', 'acknowledge'] },
  manage: { label: 'Manage incidents', help: 'Assign, escalate, close and reopen', can: ['assign', 'escalate', 'close', 'reopen'] },
  export: { label: 'Export', help: 'CSV exports and PDF reports', can: ['export'] },
  replay: { label: 'Control live replay', help: 'Start, pause, step and reset your training replay', can: ['replay'] },
  label: { label: 'Expert labelling', help: 'Review queued merchant-days and submit labels', can: ['label'] },
  supervise: { label: 'Supervise learning', help: 'Approve labels, run learning jobs, activate and roll back models', can: ['supervise'] },
} as const;
export type ActionKey = keyof typeof ACTIONS;

export interface Account {
  id: string; name: string; hash: string; admin: boolean; pages: PageKey[]; actions: ActionKey[];
  ver: number;            // bumped on password change or edit: older sessions stop working
  created: string; kpis?: KpiCard[];
}
/** What the rest of the app sees of the signed-in account (no hash). */
export type User = Omit<Account, 'hash'>;

export const ADMIN_ID = 'admin';
const file = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'accounts.json');

/* ── passwords ───────────────────────────────────────────────────────── */
export const MIN_PASSWORD = 10;
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32), want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ── storage ─────────────────────────────────────────────────────────── */
let cache: { mtime: number; list: Account[] } | null = null;

/** First start: one administrator. Its password is ADMIN_PASSWORD, else a random one written to
 *  runs/admin-password.txt (readable by the machine owner only), to change after signing in. */
function bootstrap(): Account[] {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  if (!process.env.ADMIN_PASSWORD) {
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.writeFileSync(path.join(/*turbopackIgnore: true*/ runsDir(), 'admin-password.txt'), `${pw}\n`, { mode: 0o600 });
    console.warn('[accounts] created the administrator account "admin"; its password is in runs/admin-password.txt');
  }
  const admin: Account = { id: ADMIN_ID, name: 'Administrator', hash: hashPassword(pw), admin: true, pages: Object.keys(PAGES) as PageKey[], actions: Object.keys(ACTIONS) as ActionKey[], ver: 1, created: new Date().toISOString() };
  save([admin]);
  return [admin];
}

function load(): Account[] {
  let mtime: number;
  try { mtime = fs.statSync(file()).mtimeMs; } catch { return bootstrap(); }
  if (cache?.mtime === mtime) return cache.list;
  const list = JSON.parse(fs.readFileSync(file(), 'utf8')) as Account[];
  cache = { mtime, list };
  return list;
}

function save(list: Account[]) {
  // write then rename: a crash mid-write never leaves a half file (no account lost)
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  cache = null;
}

const strip = ({ hash: _hash, ...u }: Account): User => u; // eslint-disable-line @typescript-eslint/no-unused-vars

export const listAccounts = (): User[] => load().map(strip);
export function getAccount(id: string): User | null { const a = load().find((x) => x.id === id); return a ? strip(a) : null; }
/** Display name for an id in the audit trail; older entries hold the former role names. */
const LEGACY: Record<string, string> = { analyst: 'Operations analyst', supervisor: 'Operations supervisor', reader: 'Bank / management reader' };
export const nameOf = (id: string) => getAccount(id)?.name ?? LEGACY[id] ?? id;

/* ── sign-in, with a short lock after repeated failures ─────────────────── */
const fails = new Map<string, { n: number; until: number }>();
export function verifyLogin(id: string, pw: string): { user: User } | { error: 'locked' | 'invalid' } {
  const key = id.toLowerCase(), f = fails.get(key);
  if (f && f.until > Date.now()) return { error: 'locked' };
  const a = load().find((x) => x.id === key);
  // hash a dummy when the account does not exist, so timing does not reveal valid usernames
  const ok = checkPassword(pw, a?.hash ?? 'scrypt:00:00') && !!a;
  if (!ok) {
    const n = (f?.n ?? 0) + 1;
    fails.set(key, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    return { error: 'invalid' };
  }
  fails.delete(key);
  return { user: strip(a!) };
}

/* ── administration (callers check that the actor is the administrator) ── */
export class AccountError extends Error {}
const ID = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const clean = (pages: string[], actions: string[]) => ({
  pages: [...new Set(pages)].filter((p): p is PageKey => p in PAGES),
  actions: [...new Set(actions)].filter((a): a is ActionKey => a in ACTIONS),
});

export function createAccount(input: { id: string; name: string; password: string; pages: string[]; actions: string[] }): User {
  const id = input.id.trim().toLowerCase(), name = input.name.trim().slice(0, 60), list = load();
  if (!ID.test(id)) throw new AccountError('Username: 3–32 characters, lowercase letters, digits, dot, dash or underscore.');
  if (list.some((a) => a.id === id)) throw new AccountError(`The username “${id}” is taken.`);
  if (!name) throw new AccountError('Give the account a display name.');
  if (input.password.length < MIN_PASSWORD) throw new AccountError(`Passwords need at least ${MIN_PASSWORD} characters.`);
  const { pages, actions } = clean(input.pages, input.actions);
  if (!pages.length) throw new AccountError('Tick at least one page.');
  const a: Account = { id, name, hash: hashPassword(input.password), admin: false, pages, actions, ver: 1, created: new Date().toISOString() };
  save([...list, a]);
  return strip(a);
}

export function updateAccess(id: string, input: { name: string; pages: string[]; actions: string[] }): User {
  const list = load(), a = list.find((x) => x.id === id);
  if (!a) throw new AccountError('Account not found.');
  if (a.admin) throw new AccountError('The administrator always sees every page.');
  const { pages, actions } = clean(input.pages, input.actions);
  if (!pages.length) throw new AccountError('Tick at least one page.');
  const next = { ...a, name: input.name.trim().slice(0, 60) || a.name, pages, actions, ver: a.ver + 1 };
  save(list.map((x) => (x.id === id ? next : x)));
  return strip(next);
}

export function setPassword(id: string, password: string) {
  if (password.length < MIN_PASSWORD) throw new AccountError(`Passwords need at least ${MIN_PASSWORD} characters.`);
  const list = load();
  if (!list.some((x) => x.id === id)) throw new AccountError('Account not found.');
  save(list.map((x) => (x.id === id ? { ...x, hash: hashPassword(password), ver: x.ver + 1 } : x)));
}

export function deleteAccount(id: string) {
  const list = load(), a = list.find((x) => x.id === id);
  if (!a) throw new AccountError('Account not found.');
  if (a.admin) throw new AccountError('The administrator account cannot be deleted.');
  save(list.filter((x) => x.id !== id));
}

/** The account's own Overview cards (any account, its own only). */
export function setKpis(id: string, kpis: KpiCard[]) {
  const list = load();
  save(list.map((x) => (x.id === id ? { ...x, kpis } : x)));
}
