// GET /api/v1/advisories: collective channel advisories (advisory-only, never official flags).
import type { NextRequest } from 'next/server';
import { listAdvisories } from '@/lib/api';
import { fail, userOf } from '@/lib/http';
import { snapshot } from '@/lib/snapshot';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const s = snapshot();
  return Response.json({ run_id: s.run.run_id, models: s.run.models, advisories: listAdvisories(),
    hybrid: s.hybrid ? { ...s.hybrid, rows: s.hybrid.rows.filter((r) => r.investigation_candidate) } : null });
}
