import { SimulatorSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { simulatorBaseline, valueCurve } from '@/lib/insights';
import { ReviewCost, WhatIf } from '@/components/simulator';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Simulator' };

export default function SimulatePage() {
  return <Suspense fallback={<SimulatorSkeleton />}><Simulate /></Suspense>;
}

async function Simulate() {
  const base = simulatorBaseline(), v = valueCurve();
  return (
    <>
      <PageHeader title="Simulator" />
      <section className="panel m-rise">
        <div className="panel-head"><div><h2>What if a disruption hits?</h2><p>Real volumes, your scenario, the engine’s own tests</p></div></div>
        <WhatIf base={base} />
      </section>
      <section className="panel m-rise" style={{ '--i': 1 } as React.CSSProperties}>
        <div className="panel-head"><div><h2>Review cost vs missed anomalies</h2><p>Where to set the alert threshold, given your costs</p></div></div>
        <ReviewCost curve={v.curve} policy={v.policy} trainEnd={v.trainEnd} />
      </section>
    </>
  );
}
