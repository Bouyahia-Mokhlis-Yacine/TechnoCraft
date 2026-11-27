// GET /api/v1/reports/pdf?type=daily|weekly|merchant|alerts&date=&merchant=&from=&to=&severity=&channel= : the Reports page brief as a
// PDF (FR-48), printed server-side from the same page. Logged in the audit ledger like CSV exports.
import type { NextRequest } from 'next/server';
import { getIncident, getMeta } from '@/lib/api';
import { fail, params, userOf } from '@/lib/http';
import { briefQuery, renderBriefPdf, renderReportPdf, type BriefParams } from '@/lib/pdf';
import { getReport } from '@/lib/custom-report';
import { appendEvent } from '@/lib/reviews';
import { can, COOKIE } from '@/lib/session';
import { resolveView } from '@/lib/dataset';
import { withRun } from '@/lib/run-scope';

// the brief is printed from the dataset the operator is viewing (run pinned in the printed URL), in their language
export async function GET(req: NextRequest) {
  const view = await resolveView(req.nextUrl.searchParams.get('run'));
  return withRun(view.runId, () => handle(req, view.runId));
}

async function handle(req: NextRequest, run: string | null) {
  const user = userOf(req);
  const lang = req.cookies.get('pai_lang')?.value, pin = run ? `?run=${run}` : '';
  if (!user) return fail(401, 'unauthenticated', 'Sign in to download reports.');
  if (!can(user, 'export')) return fail(403, 'forbidden', 'Your account cannot export.');
  const p = params(req), meta = getMeta();
  // a report the assistant composed: /reports/<id>, only for its owner
  if (p.id) {
    const r = getReport(user.id, p.id);
    if (!r) return fail(404, 'not_found', 'Report not found.');
    let doc: Buffer;
    try { doc = await renderReportPdf(process.env.PDF_ORIGIN ?? req.nextUrl.origin, req.cookies.get(COOKIE)!.value, `/reports/${r.id}${pin}`, lang); } catch (e) {
      console.warn('[reports] PDF engine unavailable:', e instanceof Error ? e.message.split('\n')[0] : e);
      return Response.redirect(new URL(`/reports/${r.id}?print=1`, req.nextUrl.origin), 303); // no browser here: the print dialog instead
    }
    appendEvent({ actor: user.id, action: 'export', target: 'export:report-pdf', run_id: meta.run.run_id, reason: `id=${r.id}`, prior: 'new', next: 'new', escalated: false, version: 0 });
    const slug = r.spec.title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
    return new Response(new Uint8Array(doc), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="pai-${slug}-${meta.run.run_id}.pdf"`, 'cache-control': 'no-store' } });
  }
  const type = p.type === 'weekly' || p.type === 'merchant' || p.type === 'alerts' || p.type === 'incident' ? p.type : 'daily';
  const day = (d?: string) => (d && d >= meta.firstDate && d <= meta.asOf ? d : undefined);
  if (type === 'incident' && (!p.incident || !getIncident(p.incident))) return fail(404, 'not_found', 'Unknown incident.');
  const brief: BriefParams = type === 'incident' ? { type, incident: p.incident } : type === 'merchant'
    ? { type, merchant: meta.merchants.includes(p.merchant) ? p.merchant : meta.merchants[0] }
    : type === 'alerts'
      ? { type, from: day(p.from), to: day(p.to), severity: ['critical', 'high', 'medium', 'low'].includes(p.severity) ? p.severity : undefined, merchant: meta.merchants.includes(p.merchant) ? p.merchant : undefined, channel: p.channel && p.channel.split(',').every((c) => meta.channels.includes(c)) ? p.channel : undefined }
      : { type, date: day(p.date) ?? meta.asOf };
  let pdf: Buffer;
  try {
    pdf = await renderBriefPdf(process.env.PDF_ORIGIN ?? req.nextUrl.origin, req.cookies.get(COOKIE)!.value, { ...brief, ...(run ? { run } : {}) }, lang);
  } catch (e) {
    // no browser on this machine: open the brief with the print dialog ("Save as PDF") instead
    console.warn('[reports] PDF engine unavailable, opening the print dialog instead:', e instanceof Error ? e.message.split('\n')[0] : e);
    return Response.redirect(new URL(`/reports?${briefQuery(brief)}&print=1`, req.nextUrl.origin), 303);
  }
  appendEvent({ actor: user.id, action: 'export', target: `export:report-pdf`, run_id: meta.run.run_id, reason: briefQuery(brief), prior: 'new', next: 'new', escalated: false, version: 0 });
  const name = `pai-${type}-brief-${type === 'alerts' ? `${brief.from ?? 'week'}-${brief.to ?? meta.asOf}` : brief.merchant ?? brief.date ?? brief.incident?.replaceAll(':', '-')}-${meta.run.run_id}.pdf`;
  return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
}
