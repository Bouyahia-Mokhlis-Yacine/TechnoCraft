import { Suspense } from 'react';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { getMeta } from '@/lib/api';
import { can, currentUser } from '@/lib/session';
import { resolveViewOrNull } from '@/lib/dataset';
import { listImports } from '@/lib/imports';
import { listRules } from '@/lib/rules-store';
import { activeResults, rulesDir } from '@/lib/rules';
import { shownName } from '@/lib/collection-name';
import { getT } from '@/lib/i18n/server';
import { PageHeader } from '@/components/ui';
import { RulesWorkspace } from '@/components/rules';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.rules') };
}

async function Rules() {
  await connection();
  const [user, t, view] = await Promise.all([currentUser(), getT(), resolveViewOrNull()]);
  // active rules run on operational runs only: the archive run is the competition submission
  const run = view?.kind === 'collections' ? view.runId : null;
  const results = Object.fromEntries(activeResults(run).map(({ rule, result }) => [rule.id, { ...result, matched: result.matched.slice(0, 8), total: result.matched.length }]));
  const meta = getMeta(null);
  const datasets = [{ run: 'archive', label: t('rules.archiveDataset') }, ...listImports().filter((r) => r.state === 'succeeded' && r.result).slice(0, 20).map((r) => ({
    run: r.run_id, label: `${(r.selection ?? []).map((s) => shownName(s.name, t('ds.satimName'))).join(' + ') || r.collection_name || r.run_id} · ${r.result!.first_date} – ${r.result!.last_date}` }))];
  return <RulesWorkspace initial={listRules(rulesDir())} canEdit={can(user, 'rules')} results={results}
    viewLabel={run ? (view!.combined ? t('ds.combined', { n: view!.ids.length }) : shownName(view!.names[0] ?? '', t('ds.satimName'))) : null}
    datasets={datasets} merchants={meta.merchants} categories={meta.categories} today={new Date().toISOString().slice(0, 10)} />;
}

export default async function RulesPage() {
  const t = await getT();
  return <>
    <PageHeader title={t('nav.rules')} />
    <p className="muted">{t('rules.intro')}</p>
    <Suspense fallback={<p className="muted">{t('common.loading')}</p>}><Rules /></Suspense>
  </>;
}
