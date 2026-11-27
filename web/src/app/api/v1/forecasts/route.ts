// GET /api/v1/forecasts?merchant=: 7-day advisory forecast with interval and backtest.
import type { NextRequest } from 'next/server';
import { fail, params, userOf } from '@/lib/http';
import { model } from '@/lib/model';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const f = model().snap.forecast, m = params(req).merchant;
  if (m && !f.merchants[m]) return fail(404, 'not_found', 'Unknown merchant.');
  return Response.json({ as_of: f.as_of, origin: f.origin, last_reference_date: f.last_reference_date,
    method: f.method, advisory: true, backtest: f.backtest, points: m ? f.merchants[m] : f.network,
    limitations: f.detail.limitations,
    metrics: f.detail.days.map((d) => ({ date: d.date, horizon: d.horizon, ...(m ? d.merchants[m] : d.network) })) });
}
