import { Suspense } from 'react';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { MethodNote } from '@/components/visuals';
import { LearningWorkspace } from '@/components/learning';
import { can, canSee, currentUser } from '@/lib/session';
import { scoredDates } from '@/lib/learning';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.learning') };
}

async function Workspace() {
  await connection();
  const user = await currentUser();
  if (!user || !canSee(user, '/learning')) notFound();
  const t = await getT();
  // the same mapping as engine/learning_bridge.py (the bridge decides; this only chooses which controls to show)
  const role = can(user, 'supervise') ? 'supervisor' : can(user, 'label') ? 'reviewer' : null;
  return <>
    <LearningWorkspace role={role} dates={scoredDates()} />
    <MethodNote label={t('cl.aboutTitle')}><p>{t('cl.about')}</p></MethodNote>
  </>;
}

export default async function LearningPage() {
  const t = await getT();
  return <>
    <PageHeader title={t('nav.learning')} />
    <Suspense fallback={<p className="muted">{t('common.loading')}</p>}><Workspace /></Suspense>
  </>;
}
