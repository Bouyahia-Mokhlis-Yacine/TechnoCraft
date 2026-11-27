// GET /api/v1/reports/pdf?type=daily|weekly|merchant|alerts&date=&merchant=&from=&to=&severity=&channel= : the Reports page brief as a
// PDF (FR-48), printed server-side from the same page. Logged in the audit ledger like CSV exports.
import type { NextRequest } from 'next/server';
import { getMeta } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';
import { briefQuery, renderBriefPdf, renderReportPdf, type BriefParams } from '@/lib/pdf';
import { getReport } from '@/lib/custom-report';
import { appendEvent } from '@/lib/reviews';
import { can, COOKIE } from '@/lib/session';

export async function GET(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to download reports.');
  if (!can(user.role, 'export')) return fail(403, 'forbidden', 'Your role cannot export.');
  const p = params(req), meta = getMeta();
  // a report the assistant composed: /reports/<id>, only for its owner
  if (p.id) {
    const r = getReport(user.role, p.id);
    if (!r) return fail(404, 'not_found', 'Report not found.');
    let doc: Buffer;
    try { doc = await renderReportPdf(process.env.PDF_ORIGIN ?? req.nextUrl.origin, req.cookies.get(COOKIE)!.value, `/reports/${r.id}`); } catch (e) {
      console.warn('[reports] PDF engine unavailable:', e instanceof Error ? e.message.split('\n')[0] : e);
      return fail(503, 'pdf_unavailable', 'PDF generation is unavailable on this machine. Open the report and use Print / save as PDF.');
    }
    appendEvent({ actor: user.role, action: 'export', target: 'export:report-pdf', run_id: meta.run.run_id, reason: `id=${r.id}`, prior: 'new', next: 'new', escalated: false, version: 0 });
    const slug = r.spec.title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
    return new Response(new Uint8Array(doc), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="pai-${slug}-${meta.run.run_id}.pdf"`, 'cache-control': 'no-store' } });
  }
  const type = p.type === 'weekly' || p.type === 'merchant' || p.type === 'alerts' ? p.type : 'daily';
  const day = (d?: string) => (d && d >= meta.firstDate && d <= meta.asOf ? d : undefined);
  const brief: BriefParams = type === 'merchant'
    ? { type, merchant: meta.merchants.includes(p.merchant) ? p.merchant : meta.merchants[0] }
    : type === 'alerts'
      ? { type, from: day(p.from), to: day(p.to), severity: ['critical', 'high', 'medium', 'low'].includes(p.severity) ? p.severity : undefined, merchant: meta.merchants.includes(p.merchant) ? p.merchant : undefined, channel: p.channel && p.channel.split(',').every((c) => meta.channels.includes(c)) ? p.channel : undefined }
      : { type, date: day(p.date) ?? meta.asOf };
  let pdf: Buffer;
  try {
    pdf = await renderBriefPdf(process.env.PDF_ORIGIN ?? req.nextUrl.origin, req.cookies.get(COOKIE)!.value, brief);
  } catch (e) {
    console.warn('[reports] PDF engine unavailable:', e instanceof Error ? e.message.split('\n')[0] : e);
    return fail(503, 'pdf_unavailable', 'PDF generation is unavailable on this machine. Open the report and use Print / save as PDF.');
  }
  appendEvent({ actor: user.role, action: 'export', target: `export:report-pdf`, run_id: meta.run.run_id, reason: briefQuery(brief), prior: 'new', next: 'new', escalated: false, version: 0 });
  const name = `pai-${type}-brief-${type === 'alerts' ? `${brief.from ?? 'week'}-${brief.to ?? meta.asOf}` : brief.merchant ?? brief.date}-${meta.run.run_id}.pdf`;
  return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
}
