// GET /api/v1/anomalies: official V2 flags with scores and explanations (paginated, stable order).
import type { NextRequest } from 'next/server';
import { listAnomalies } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const p = params(req);
  const r = listAnomalies({ ...p, page: Number(p.page) || 1 });
  return Response.json({ total: r.total, page: r.page, pageSize: r.pageSize, rows: r.rows });
}
