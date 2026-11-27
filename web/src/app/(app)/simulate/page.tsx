import { connection } from 'next/server';
import { SimulatorSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { simulatorBaseline, valueCurve } from '@/lib/insights';
import { ReviewCost, WhatIf } from '@/components/simulator';
import { PageHeader } from '@/components/ui';
import { getT } from '@/lib/i18n/server';
import { ViewBanner } from '@/components/dataset';
import { resolveView } from '@/lib/dataset';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.simulator') };
}

export default function SimulatePage() {
  return <Suspense fallback={<SimulatorSkeleton />}><Simulate /></Suspense>;
}

async function Simulate() {
  await connection();
  const t = await getT();
  const view = await resolveView();   // the simulator's baseline is the operator's dataset
  const base = simulatorBaseline(), v = valueCurve();
  return (
    <>
      <PageHeader title={t('nav.simulator')} />
      <ViewBanner view={view} path="/simulate" />
      <section className="panel m-rise">
        <div className="panel-head"><div><h2>{t('sim.whatIf')}</h2><p>{t('sim.whatIfSub')}</p></div></div>
        <WhatIf base={base} />
      </section>
      <section className="panel m-rise" style={{ '--i': 1 } as React.CSSProperties}>
        <div className="panel-head"><div><h2>{t('sim.costTitle')}</h2><p>{t('sim.costSub')}</p></div></div>
        <ReviewCost curve={v.curve} policy={v.policy} trainEnd={v.trainEnd} />
      </section>
    </>
  );
}
