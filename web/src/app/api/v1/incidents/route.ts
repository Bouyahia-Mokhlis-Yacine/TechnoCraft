// GET /api/v1/incidents: ranked incident list with review state and priority factors.
import type { NextRequest } from 'next/server';
import { listIncidents } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';
import { snapshot } from '@/lib/snapshot';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const run = snapshot();
  return Response.json({ run_id: run.run.run_id,
    incidents: listIncidents(params(req)).map((i) => ({ ...i, latest: undefined })),
    collective_priority: run.priority_queue.filter((i) => i.kind === 'collective_advisory') });
}
