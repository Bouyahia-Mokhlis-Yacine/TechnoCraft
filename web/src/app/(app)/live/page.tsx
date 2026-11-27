import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LiveDashboard } from '@/components/live-dashboard';
import { PageHeader } from '@/components/ui';
import { can, canSee, currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Live Monitoring' };

async function Workspace() {
  const user = await currentUser();
  if (!user || !canSee(user, '/live')) notFound();
  return <LiveDashboard control={can(user, 'replay')} />;
}

export default function LivePage() {
  return <>
    <PageHeader title="Live Monitoring" />
    <Suspense fallback={<p className="muted">Loading replay workspace…</p>}><Workspace /></Suspense>
  </>;
}
