// GET /api/v1/advisories: collective channel advisories (advisory-only, never official flags).
import type { NextRequest } from 'next/server';
import { listAdvisories } from '@/lib/api';
import { fail, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  return Response.json({ advisories: listAdvisories() });
}
