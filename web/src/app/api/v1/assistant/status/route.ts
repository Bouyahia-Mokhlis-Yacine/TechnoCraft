// GET /api/v1/assistant/status: whether the optional language model is reachable ('online'),
// configured but unreachable ('offline'), or not configured ('off'). The chat shows a note when it
// is not online: the assistant cannot answer without it.
import type { NextRequest } from 'next/server';
import { modelStatus } from '@/lib/llm';
import { fail, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  return Response.json({ model: await modelStatus() }, { headers: { 'cache-control': 'no-store' } });
}
