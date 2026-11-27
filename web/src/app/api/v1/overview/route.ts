// GET /api/v1/overview?from&to&merchant&category&channel: network KPIs and trends (SRS §13).
import type { NextRequest } from 'next/server';
import { getOverview } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const p = params(req);
  if ((p.from && !/^\d{4}-\d{2}-\d{2}$/.test(p.from)) || (p.to && !/^\d{4}-\d{2}-\d{2}$/.test(p.to))) return fail(400, 'invalid_filter', 'Dates must be YYYY-MM-DD.');
  return Response.json(getOverview(p));
}
