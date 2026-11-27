// GET /api/v1/incidents: ranked incident list with review state and priority factors.
import type { NextRequest } from 'next/server';
import { listIncidents } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  return Response.json({ incidents: listIncidents(params(req)).map((i) => ({ ...i, latest: undefined })) });
}
