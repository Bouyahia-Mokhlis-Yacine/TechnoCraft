// The report alone (no app shell), for the live preview in the assistant. `?v=` shows an earlier
// version, so each answer keeps showing the report as it was then.
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ReportDocument } from '@/components/report-document';
import { getReport } from '@/lib/custom-report';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Report preview' };
type P = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function EmbedReport({ params, searchParams }: { params: P; searchParams: SP }) {
  return <Suspense fallback={<div className="embed-report" />}><Doc params={params} searchParams={searchParams} /></Suspense>;
}

async function Doc({ params, searchParams }: { params: P; searchParams: SP }) {
  const [{ id }, sp, user] = await Promise.all([params, searchParams, currentUser()]);
  const r = user ? getReport(user.role, id) : null;
  if (!r) notFound();
  const v = Number(sp.v) || undefined;
  return <div className="embed-report"><ReportDocument r={r} version={v} /></div>;
}
