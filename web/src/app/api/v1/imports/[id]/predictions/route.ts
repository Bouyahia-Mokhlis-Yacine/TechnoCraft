// GET /api/v1/imports/{id}/predictions: the run's operational predictions as
// operational_predictions_<run_id>.csv (merchant_id,date,is_anomaly,anomaly_score for every scored
// merchant-day). Never the sealed competition y_pred_anomalies.csv. Requires the export permission.
import fs from 'node:fs';
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { getImport, predictionsFile } from '@/lib/imports';
import { appendEvent } from '@/lib/reviews';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'export')) return fail(403, 'forbidden', 'Your account cannot export data.');
  const id = (await ctx.params).id, run = getImport(id), file = predictionsFile(id);
  if (!run || run.state !== 'succeeded' || !file) return fail(404, 'not_found', 'No predictions for this run.');
  appendEvent({ actor: user.id, action: 'export', target: 'export:operational-predictions', run_id: id, reason: 'Operational predictions CSV', prior: 'new', next: 'new', escalated: false, version: 0 });
  return new Response(fs.readFileSync(file), { headers: {
    'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="operational_predictions_${id}.csv"` } });
}
