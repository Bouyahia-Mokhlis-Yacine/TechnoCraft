// GET /api/v1/collections: the SATIM dataset, saved collections, the trash, the selection and its analysis.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { idsFor, VIEW_COOKIE } from '@/lib/dataset';
import { collectionsPayload } from './shared';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  return Response.json(collectionsPayload(idsFor(req.cookies.get(VIEW_COOKIE)?.value)), { headers: { 'cache-control': 'no-store' } });
}
