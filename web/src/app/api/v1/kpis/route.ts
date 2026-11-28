// PUT /api/v1/kpis { kpis }: saves the signed-in account's own Overview cards. Every formula is
// parsed again here (lib/formula.ts): the client's check is a convenience, this one is the gate.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { checkKpis } from '@/lib/formula';
import { setKpis } from '@/lib/accounts';

export async function PUT(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  let body: { kpis?: unknown };
  try { body = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  const r = checkKpis(body.kpis);
  if (!r.ok) return fail(422, 'invalid_kpis', r.error);
  setKpis(user.id, r.kpis);
  return Response.json({ kpis: r.kpis });
}
