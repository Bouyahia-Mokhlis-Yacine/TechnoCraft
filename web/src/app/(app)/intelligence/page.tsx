import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { listAdvisories } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { model } from '@/lib/model';
import { HybridEvidence, symptomLabel } from '@/components/satim-evidence';
import { MethodNote } from '@/components/visuals';
import { EmptyState, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Intelligence' };

export default function IntelligencePage() {
  return <Suspense fallback={<PageHeader title="Network intelligence" />}><Intelligence /></Suspense>;
}

async function Intelligence() {
  await connection();
  const snapshot = model().snap;
  const advisories = [...listAdvisories()].sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  const candidates = snapshot.hybrid?.rows.filter((r) => r.investigation_candidate)
    .sort((a, b) => b.v4_advisory_score - a.v4_advisory_score) ?? [];
  return <>
    <PageHeader title="Network intelligence" />
    <h2 className="section-h">V3 collective advisories</h2>
    {advisories.map((a) => (
      <Link key={a.id} href={'/intelligence/' + encodeURIComponent(a.id)} className="panel advisory-card">
        <div className="adv-main">
          <span className="muted">{fmtDate(a.date)} · {a.category ?? 'All categories'}</span>
          <h2>{a.channel} · {symptomLabel(a.symptom)}</h2>
          <p>{fmtInt(a.observed)} observed vs {fmtNum(a.expected, 1)} expected · {a.members.filter((m) => m.affected).length} of {a.members.length} merchants corroborated</p>
        </div>
        <div className="adv-score"><b>{fmtNum(a.score, 1)}</b><small>collective likelihood score</small></div>
        <ArrowRight className="chev" aria-hidden />
      </Link>
    ))}
    {!advisories.length && <EmptyState title={snapshot.run.models.v3 ? 'No collective advisory in this run' : 'V3 advisory module disabled'} />}
    <MethodNote>V3 scans merchant subsets by payment channel and category. Scores use frozen ordinary date-max calibration. Merchant corroboration provides local context. Shared technical causes require independent evidence.</MethodNote>
    <h2 id="ml-candidates" className="section-h">V4 ML investigation candidates<small>Advisory ranking · separate from official V2 alerts</small></h2>
    {candidates.map((row) => (
      <details key={row.merchant_id + row.date} className="panel cluster">
        <summary><b>{row.merchant_id}</b> · {fmtDate(row.date)} · score {fmtNum(row.v4_advisory_score, 3)} · ordinary ML tail rank {fmtPct(row.v4_ordinary_rank, 2)}</summary>
        <HybridEvidence row={row} nested />
        <Link href={'/merchants/' + row.merchant_id}>Open merchant</Link>
      </details>
    ))}
    {!candidates.length && <EmptyState title={snapshot.hybrid ? 'No ML candidate in this run' : 'V4 advisory module disabled'} />}
    <MethodNote>V4 combines the official V2 score with Isolation Forest evidence from 62 features. Its ordinary tail rank describes historical rarity. Use it to order investigations alongside the official anomaly list.</MethodNote>
  </>;
}
