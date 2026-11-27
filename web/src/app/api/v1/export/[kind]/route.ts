// GET /api/v1/export/{transactions|anomalies|incidents}: sanitized CSV of the current filter scope,
// logged in the audit ledger (SRS FR-25, FR-49, NFR-01).
import type { NextRequest } from 'next/server';
import { listAnomalies, listIncidents, listTransactions } from '@/lib/api';
import { csv, fail, params, userOf } from '@/lib/http';
import { model } from '@/lib/model';
import { resolveView } from '@/lib/dataset';
import { explanationText } from '@/lib/i18n/engine';
import { translate, type Key } from '@/lib/i18n';
import { appendEvent } from '@/lib/reviews';
import { can } from '@/lib/session';

export async function GET(req: NextRequest, ctx: RouteContext<'/api/v1/export/[kind]'>) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to export.');
  if (!can(user, 'export')) return fail(403, 'forbidden', 'Your account cannot export.');
  const { kind } = await ctx.params;
  const q = params(req);
  // the active dataset (pinned ?run= or the selection cookie), as on the page the export was asked from
  const view = await resolveView(q.run);
  const p = { ...q, run: view.runId ?? undefined } as Record<string, string>, run = model(view.runId).snap.run.run_id;
  let body: string;
  if (kind === 'transactions') {
    const r = listTransactions(p).all;
    body = csv(['source_row', 'timestamp', 'merchant_id', 'category', 'channel', 'status', 'amount', 'quality_flags', 'contactless_limit'],
      r.map((t) => [t.id, t.ts, t.merchant, t.category, t.channel, t.status, t.amount, t.flags.map((f) => (f === 'contactless_limit' ? 'contactless limit exceeded' : f.replaceAll('_', ' '))).join('|'), Number(t.contactlessLimit)]));
  } else if (kind === 'predictions') {
    const snap = model().snap;   // the official submission only ever comes from the official run
    if (!snap.run.parity.sealed) return fail(409, 'unsealed_replay', 'The sealed submission parity check has not passed.');
    body = csv(['merchant_id', 'date', 'is_anomaly', 'anomaly_score'],
      snap.official_predictions.map((r) => [r.merchant_id, r.date, r.is_anomaly, r.anomaly_score]));
  } else if (kind === 'anomalies') {
    const r = listAnomalies(p).all;
    body = csv(['merchant_id', 'date', 'type', 'severity', 'anomaly_score', 'indicator', 'observed', 'expected', 'incident_id', 'explanation'], r.map((a) => [a.merchant, a.date, a.type, a.severity, a.score, translate('en', `ind.${a.evidence.indicator}` as Key), a.observed, a.expected, a.incidentId, explanationText(a.evidence, 'en')]));
  } else if (kind === 'incidents') {
    const r = listIncidents({ ...p, scope: p.scope ?? 'all' }, view.runId);
    body = csv(['incident_id', 'rank', 'priority', 'merchant_id', 'type', 'severity', 'lifecycle', 'review_status', 'owner', 'onset', 'end', 'days', 'affected_events', 'value_exposure_dzd'],
      r.map((i) => [i.id, i.rank, i.priority, i.merchant, i.type, i.severity, i.lifecycle, i.review.status, i.review.owner, i.onset, i.end, i.days, i.affectedEvents, i.valueExposure]));
  } else return fail(404, 'not_found', 'Unknown export.');
  appendEvent({ actor: user.id, action: 'export', target: `export:${kind}`, run_id: run, reason: 'CSV export', prior: 'new', next: 'new', escalated: false, version: 0 });
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="pai-${kind}-${run}.csv"` } });
}
