import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LiveDashboard } from '@/components/live-dashboard';
import { PageHeader } from '@/components/ui';
import { MethodNote } from '@/components/visuals';
import { can, canSee, currentUser } from '@/lib/session';
import { getT } from '@/lib/i18n/server';
import { fmtPct } from '@/lib/format';
import { liveEvidence } from '@/lib/live-evidence';
import { getOverview } from '@/lib/api';

// the guided example: a selected synthetic day, not typical performance (see the method note)
const GUIDED = '2026-10-15';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.live') };
}

async function Workspace() {
  const user = await currentUser();
  if (!user || !canSee(user, '/live')) notFound();
  const t = await getT(), e = liveEvidence();
  // that day's transactions in the archive's own run: the replay's unmodified day, to compare with the replayed total
  let original: number | null = null;
  try { original = getOverview({ from: GUIDED, to: GUIDED }, null).kpis.events.value; } catch { /* archive run unavailable */ }
  return <>
    <LiveDashboard control={can(user, 'replay')} guided={{ date: GUIDED, preset: 'backlog', original }} />
    <MethodNote label={t('live.aboutTitle')}>
      <p>{t('live.aboutLayers')}</p>
      {e && <p>{t('live.aboutPerf', { hit: e.detected, n: e.applicable, pct: fmtPct(e.detected / e.applicable, 1), delay: e.medianDelay ?? '—', notes: e.notifications, days: e.days })}</p>}
      <p>{t('live.aboutDemo')}</p>
      <p>{t('live.aboutLimits')}</p>
    </MethodNote>
  </>;
}

export default async function LivePage() {
  const t = await getT();
  return <>
    <PageHeader title={t('nav.live')} />
    <Suspense fallback={<p className="muted">{t('live.loading')}</p>}><Workspace /></Suspense>
  </>;
}
