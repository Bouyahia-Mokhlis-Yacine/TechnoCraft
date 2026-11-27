// GET /api/v1/health: service health and the run it serves (no data).
import { connection } from 'next/server';
import { snapshot } from '@/lib/snapshot';

export async function GET() {
  await connection(); // checked per request, never prerendered
  try {
    const r = snapshot().run;
    return Response.json({ status: 'ok', schema_version: 2, run_id: r.run_id, as_of: r.as_of,
      generated_at: r.generated_at, batch_status: r.batch_status, data_status: r.data_status,
      sealed_parity: r.parity.sealed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable', error: { code: 'no_run', message: 'No engine run exported yet.' } }, { status: 503 });
  }
}
