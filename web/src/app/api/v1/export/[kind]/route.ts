// GET /api/v1/export/{transactions|anomalies|incidents}: sanitized CSV of the current filter scope,
// logged in the audit ledger (SRS FR-25, FR-49, NFR-01).
import type { NextRequest } from 'next/server';
import { listAnomalies, listIncidents, listTransactions } from '@/lib/api';
import { csv, fail, params, userOf } from '@/lib/http';
import { model } from '@/lib/model';
import { appendEvent } from '@/lib/reviews';
import { can } from '@/lib/session';

export async function GET(req: NextRequest, ctx: RouteContext<'/api/v1/export/[kind]'>) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to export.');
  if (!can(user.role, 'export')) return fail(403, 'forbidden', 'Your role cannot export.');
  const { kind } = await ctx.params;
  const p = params(req), run = model().snap.run.run_id;
  let body: string;
  if (kind === 'transactions') {
    const r = listTransactions(p).all;
    body = csv(['timestamp', 'merchant_id', 'category', 'channel', 'status', 'amount', 'quality_flags'], r.map((t) => [t.ts, t.merchant, t.category, t.channel, t.status, t.amount, t.flags.join('|')]));
  } else if (kind === 'anomalies') {
    const r = listAnomalies(p).all;
    body = csv(['merchant_id', 'date', 'type', 'severity', 'anomaly_score', 'indicator', 'observed', 'expected', 'incident_id', 'explanation'], r.map((a) => [a.merchant, a.date, a.type, a.severity, a.score.toFixed(4), a.indicator, a.observed, a.expected, a.incidentId, a.explanation]));
  } else if (kind === 'incidents') {
    const r = listIncidents({ ...p, scope: p.scope ?? 'all' });
    body = csv(['incident_id', 'rank', 'priority', 'merchant_id', 'type', 'severity', 'lifecycle', 'review_status', 'owner', 'onset', 'end', 'days', 'affected_events', 'value_exposure_dzd'],
      r.map((i) => [i.id, i.rank, i.priority, i.merchant, i.type, i.severity, i.lifecycle, i.review.status, i.review.owner, i.onset, i.end, i.days, i.affectedEvents, i.valueExposure]));
  } else return fail(404, 'not_found', 'Unknown export.');
  appendEvent({ actor: user.role, action: 'export', target: `export:${kind}`, run_id: run, reason: new URLSearchParams(p).toString(), prior: 'new', next: 'new', escalated: false, version: 0 });
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="pai-${kind}-${run}.csv"` } });
}
