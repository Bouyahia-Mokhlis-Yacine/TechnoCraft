// Demo accounts with server-enforced roles (SRS FR-05, NFR-02). The session is a signed cookie;
// every write and export re-checks the role on the server, whatever the UI shows.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { runsDir } from './snapshot';

export type Role = 'analyst' | 'supervisor' | 'reader' | 'admin';
export const ROLES: Record<Role, { name: string; title: string; can: string[] }> = {
  analyst: { name: 'Operations analyst', title: 'Investigate and acknowledge incidents', can: ['comment', 'acknowledge', 'export'] },
  supervisor: { name: 'Operations supervisor', title: 'Assign, escalate and close incidents', can: ['comment', 'acknowledge', 'assign', 'escalate', 'close', 'reopen', 'export', 'audit'] },
  reader: { name: 'Bank / management reader', title: 'Read briefs and dashboards only', can: ['export'] },
  admin: { name: 'Administrator', title: 'Runs, data quality and audit', can: ['export', 'audit'] },
};
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

export function encode(role: Role): string {
  const body = Buffer.from(JSON.stringify({ role, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decode(value: string | undefined): { role: Role } | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { role, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return role in ROLES && exp > Date.now() ? { role } : null;
  } catch { return null; }
}

export async function currentUser(): Promise<{ role: Role } | null> {
  await connection();
  return decode((await cookies()).get(COOKIE)?.value);
}

export const can = (role: Role | undefined, action: string) => !!role && ROLES[role].can.includes(action);
