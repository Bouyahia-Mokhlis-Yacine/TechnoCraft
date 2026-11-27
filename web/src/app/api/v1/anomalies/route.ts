// GET /api/v1/anomalies: official V2 flags with scores and explanations (paginated, stable order).
import type { NextRequest } from 'next/server';
import { listAnomalies } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';
import { snapshot } from '@/lib/snapshot';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const p = params(req);
  const run = snapshot();
  if (p.scope === 'official') {
    const predictions = run.official_predictions.filter((row) => (!p.merchant || row.merchant_id === p.merchant)
      && (!p.from || row.date >= p.from) && (!p.to || row.date <= p.to));
    return Response.json({ run_id: run.run.run_id, sealed_parity: run.run.parity.sealed, predictions });
  }
  const r = listAnomalies({ ...p, page: Number(p.page) || 1 });
  return Response.json({ run_id: run.run.run_id, sealed_parity: run.run.parity.sealed, total: r.total,
    page: r.page, pageSize: r.pageSize, rows: r.rows });
}
