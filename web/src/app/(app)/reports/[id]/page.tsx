import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { AutoPrint, PrintButton } from '@/components/client';
import { ReportDocument } from '@/components/report-document';
import { UndoReport } from '@/components/report-actions';
import { ReportsSkeleton } from '@/components/skeletons';
import { getReport } from '@/lib/custom-report';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Report' };
type P = Promise<{ id: string }>;

export default function CustomReportPage({ params }: { params: P }) {
  return <Suspense fallback={<ReportsSkeleton />}><CustomReport params={params} /></Suspense>;
}

async function CustomReport({ params }: { params: P }) {
  const { id } = await params;
  const user = await currentUser();
  const r = user ? getReport(user.id, id) : null;
  if (!r) notFound();
  return (
    <>
      <AutoPrint />
      <div className="no-print">
        <PageHeader title={r.spec.title} crumbs={<><Link href="/reports">Reports</Link><span>/</span><span>Prepared by the assistant</span></>}>
          <span className="chip" title="Ask the assistant (bottom right) to change this report">Version {r.version ?? 1}</span>
          {(r.history?.length ?? 0) > 0 && <UndoReport id={r.id} />}
          <a className="btn btn-secondary" href={`/api/v1/reports/pdf?id=${r.id}`}><Download aria-hidden />Download PDF</a><PrintButton />
        </PageHeader>
      </div>
      <ReportDocument r={r} />
    </>
  );
}
