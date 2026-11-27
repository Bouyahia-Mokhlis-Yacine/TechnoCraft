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
import { categoryLabel, channelLabel } from '@/lib/labels';
import { getT } from '@/lib/i18n/server';
import { ViewBanner } from '@/components/dataset';
import { keepRun, resolveView } from '@/lib/dataset';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.intelligence') };
}

type SP = Promise<{ tab?: string; run?: string }>;
export default function IntelligencePage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={null}><Intelligence searchParams={searchParams} /></Suspense>;
}

async function Intelligence({ searchParams }: { searchParams: SP }) {
  await connection();
  const sp = await searchParams, ml = sp.tab === 'ml';
  const t = await getT();
  // the active dataset: the official run, or an imported run (its own collective and Hybrid ML layers)
  const view = await resolveView(sp.run), run = view.runId;
  const snapshot = model(run).snap;
  const advisories = [...listAdvisories(run)].sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  const candidates = snapshot.hybrid?.rows.filter((r) => r.investigation_candidate)
    .sort((a, b) => b.v4_advisory_score - a.v4_advisory_score) ?? [];
  return <>
    <PageHeader title={t('intel.title')} />
    <ViewBanner view={view} path="/intelligence" />
    <nav className="seg intel-tabs" aria-label={t('intel.title')}>
      <Link href={keepRun('/intelligence', view)} aria-current={ml ? undefined : 'page'} className={ml ? '' : 'on'} scroll={false}>{t('ov.sigCollective')} <span className="num">{advisories.length}</span></Link>
      <Link href={keepRun('/intelligence?tab=ml', view)} aria-current={ml ? 'page' : undefined} className={ml ? 'on' : ''} scroll={false}>{t('ov.sigMl')} <span className="num">{candidates.length}</span></Link>
    </nav>
    {!ml ? <>
    {advisories.map((a) => (
      <Link key={a.id} href={keepRun('/intelligence/' + encodeURIComponent(a.id), view)} className="panel advisory-card">
        <div className="adv-main">
          <span className="muted">{fmtDate(a.date)} · {a.category ? categoryLabel(a.category) : t('f.allCategories')}</span>
          <h2>{channelLabel(a.channel)} · {symptomLabel(a.symptom)}</h2>
          <p>{t('intel.obsExp', { obs: fmtInt(a.observed), exp: fmtNum(a.expected, 1) })} · {t('intel.corroborated', { k: a.members.filter((m) => m.affected).length, n: a.members.length })}</p>
        </div>
        <div className="adv-score"><b>{fmtNum(a.score, 1)}</b><small>{t('intel.score')}</small></div>
        <ArrowRight className="chev" aria-hidden />
      </Link>
    ))}
    {!advisories.length && <EmptyState title={snapshot.run.models.v3 ? t('intel.noAdvisory') : t('intel.v3off')} />}
    <MethodNote>{t('intel.method1')}</MethodNote>
    </> : <>
    <p id="ml-candidates" className="muted">{t('intel.mlSub')}</p>
    {candidates.map((row) => (
      <details key={row.merchant_id + row.date} className="panel cluster">
        <summary><b>{row.merchant_id}</b> · {fmtDate(row.date)} · {t('intel.mlRow', { score: fmtNum(row.v4_advisory_score, 3), rank: fmtPct(row.v4_ordinary_rank, 2) })}</summary>
        <HybridEvidence row={row} nested />
        <Link href={'/merchants/' + row.merchant_id}>{t('intel.openMerchant')}</Link>
      </details>
    ))}
    {!candidates.length && <EmptyState title={snapshot.hybrid ? t('intel.noMl') : t('data.v4off')} />}
    <MethodNote>{t('intel.method2')}</MethodNote>
    </>}
  </>;
}
