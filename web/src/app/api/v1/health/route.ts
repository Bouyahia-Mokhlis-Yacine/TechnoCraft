// GET /api/v1/health: service health and the run it serves (no data).
import { connection } from 'next/server';
import { snapshot } from '@/lib/snapshot';

export async function GET() {
  await connection(); // checked per request, never prerendered
  try {
    const r = snapshot().run;
    return Response.json({ status: 'ok', run_id: r.run_id, as_of: r.as_of, batch_status: r.batch_status });
  } catch {
    return Response.json({ status: 'unavailable', error: { code: 'no_run', message: 'No engine run exported yet.' } }, { status: 503 });
  }
}
