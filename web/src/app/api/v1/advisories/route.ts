// GET /api/v1/advisories: collective channel advisories (advisory-only, never official flags).
import type { NextRequest } from 'next/server';
import { listAdvisories } from '@/lib/api';
import { fail, userOf } from '@/lib/http';
import { snapshot } from '@/lib/snapshot';
import { localeOf } from '@/lib/i18n/server';
import { withLocale } from '@/lib/i18n/scope';

// text (explanations, labels) in the caller's language, as on the pages
export const GET = (req: NextRequest) => withLocale(localeOf(req), () => handle(req));

async function handle(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const s = snapshot();
  return Response.json({ run_id: s.run.run_id, models: s.run.models, advisories: listAdvisories(),
    hybrid: s.hybrid ? { ...s.hybrid, rows: s.hybrid.rows.filter((r) => r.investigation_candidate) } : null });
}
