// GET /api/v1/imports/template: the importer's CSV header (engine/import_batch.py REQUIRED + optional
// masked_pan, which is read only to tell exact duplicates apart) with one illustrative row.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const body = 'merchant_id,masked_pan,transaction_date,amount,payment_channel,transaction_status,merchant_category\r\n'
    + 'MER-0001,,2026-11-14 09:30:00,2500.00,TPE / POS Terminal,Accepted,Food & Dining\r\n';
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="satim-import-template.csv"' } });
}
