// POST /api/v1/learning { method, args }: one call to the continuous learning service as the signed-in
// account (reviewer or supervisor, decided server-side from the account store). Reads and writes are
// whitelisted; operational batches are fed only by the import worker, never from HTTP.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { canSee } from '@/lib/session';
import { learning, READ, WRITE } from '@/lib/learning';
import { hasSensitiveIdentifier } from '@/lib/privacy';

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!canSee(user, '/learning')) return fail(403, 'forbidden', 'Your account does not have access to controlled learning.');
  let body: { method?: unknown; args?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  const method = String(body.method ?? '');
  if (![...READ, ...WRITE].includes(method as never) || (body.args !== undefined && (typeof body.args !== 'object' || Array.isArray(body.args))))
    return fail(422, 'invalid_payload', 'Expected { method, args }.');
  const args = (body.args ?? {}) as Record<string, unknown>;
  if (JSON.stringify(args).length > 8000 || hasSensitiveIdentifier(JSON.stringify(args))) return fail(422, 'invalid_payload', 'Remove card identifiers and keep requests short.');
  const r = await learning(user.id, method, args);
  return 'ok' in r ? Response.json({ ok: r.ok }, { headers: { 'cache-control': 'no-store' } }) : fail(r.error.status, r.error.code, r.error.message);
}
