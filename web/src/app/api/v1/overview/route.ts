// GET /api/v1/overview?from&to&merchant&category&channel: network KPIs and trends (SRS §13).
import type { NextRequest } from 'next/server';
import { getMeta, getOverview } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';
import { localeOf } from '@/lib/i18n/server';
import { withLocale } from '@/lib/i18n/scope';

// text (explanations, labels) in the caller's language, as on the pages
export const GET = (req: NextRequest) => withLocale(localeOf(req), () => handle(req));

async function handle(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const p = params(req);
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d)) && new Date(d).toISOString().startsWith(d);
  if ((p.from && !valid(p.from)) || (p.to && !valid(p.to)) || (p.from && p.to && p.from > p.to)) {
    return fail(400, 'invalid_filter', 'Use a valid calendar date range in YYYY-MM-DD format.');
  }
  const { forecastDetail, ...view } = getOverview(p);
  const { run } = getMeta();
  return Response.json({ ...view, forecast_origin: forecastDetail.origin, run_id: run.run_id,
    as_of: run.as_of, batch_status: run.batch_status });
}
