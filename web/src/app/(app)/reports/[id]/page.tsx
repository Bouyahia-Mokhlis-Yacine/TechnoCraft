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
import { getT } from '@/lib/i18n/server';
import { resolveView } from '@/lib/dataset';
import { ViewBanner } from '@/components/dataset';
import { connection } from 'next/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('rep.report') };
}
type P = Promise<{ id: string }>;

type SP = Promise<{ run?: string }>;
export default function CustomReportPage({ params, searchParams }: { params: P; searchParams: SP }) {
  return <Suspense fallback={<ReportsSkeleton />}><CustomReport params={params} searchParams={searchParams} /></Suspense>;
}

async function CustomReport({ params, searchParams }: { params: P; searchParams: SP }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  const view = await resolveView((await searchParams).run);   // figures from the operator's dataset
  const user = await currentUser();
  const r = user ? getReport(user.id, id) : null;
  if (!r) notFound();
  return (
    <>
      <AutoPrint />
      <div className="no-print">
        <PageHeader title={r.spec.title} crumbs={<><Link href="/reports">{t('nav.reports')}</Link><span>/</span><span>{t('rep.prepared')}</span></>}>
          <span className="chip" title={t('rep.versionTitle')}>{t('rep.version', { n: r.version ?? 1 })}</span>
          {(r.history?.length ?? 0) > 0 && <UndoReport id={r.id} />}
          <a className="btn btn-secondary" href={`/api/v1/reports/pdf?id=${r.id}`}><Download aria-hidden />{t('rep.pdf')}</a><PrintButton />
        </PageHeader>
      </div>
      <div className="no-print"><ViewBanner view={view} path={`/reports/${r.id}`} /></div>
      <ReportDocument r={r} />
    </>
  );
}
