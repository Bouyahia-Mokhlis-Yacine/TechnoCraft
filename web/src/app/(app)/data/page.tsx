import { Download } from 'lucide-react';
import { DataSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getMeta } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum, fmtPct, fmtStamp } from '@/lib/format';
import { readAll } from '@/lib/reviews';
import { can, currentUser } from '@/lib/session';
import { nameOf } from '@/lib/accounts';
import { selectedIds } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { PageHeader } from '@/components/ui';
import { HitDots, MethodNote, Pipeline } from '@/components/visuals';
import { DataCollections } from '@/components/collections';
import { collectionsPayload } from '@/app/api/v1/collections/shared';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.data') };
}
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function DataPage() {
  return <Suspense fallback={<DataSkeleton />}><Data /></Suspense>;
}

async function Data() {
  const user = await currentUser();
  const t = await getT();
  const meta = getMeta(), { run: r } = meta;
  const v = r.validation, c = r.cleaning;
  const audit = can(user, 'audit') ? readAll().slice(-40).reverse() : null;
  const collections = collectionsPayload(await selectedIds());
  return (
    <>
      <PageHeader title={t('nav.data')}>
        {/* the official submission: the full 711-row template, frozen schema, only from a sealed run */}
        {can(user, 'export') && (r.parity.sealed
          ? <a className="btn btn-secondary" href="/api/v1/export/predictions" download><Download aria-hidden />{t('data.officialCsv')}</a>
          : <span className="muted" title={t('data.sealedOnlyTitle')}>{t('data.sealedOnly')}</span>)}
      </PageHeader>
      <DataCollections initial={collections} canManage={can(user, 'import')} canExport={can(user, 'export')}
        official={{ runId: meta.run.run_id, sealed: meta.run.parity.sealed, first: meta.firstDate, last: meta.asOf, flagged: meta.run.flagged_days }} />
      <h2 className="section-h">{t('data.officialHeading')}</h2>
      <section className="panel m-rise">
        <div className="panel-head"><div><h2>{t('data.cleaning')}</h2><p>{t('data.beforeScoring')}</p></div></div>
        <Pipeline start={{ label: t('data.rowsReceived'), value: c.raw_rows }} end={{ label: t('data.rowsScored'), value: c.retained_events }} steps={[
          { label: t('data.stepDuplicates'), value: c.exact_duplicate, kind: 'removed' },
          { label: t('data.stepDates'), value: c.invalid_timestamp, kind: 'removed' },
          { label: t('data.stepNegative'), value: c.negative_amount, kind: 'kept' },
          { label: t('data.stepCategories'), value: c.missing_category, kind: 'fixed' },
          { label: t('data.stepChannels'), value: c.missing_channel, kind: 'fixed' },
          { label: t('data.stepNoAmount'), value: c.missing_amount, kind: 'kept' },
        ]} />
      </section>
      <div className="ov">
        <div className="stack">
          <section className="panel m-rise">
            <div className="panel-head"><div><h2>{t('data.replay')}</h2></div><span className="chip ok">{t('data.batch', { status: t(`batch.${r.batch_status}` as 'batch.complete') })}</span></div>
            <table className="stats"><tbody>
              <tr><td>{t('data.runId')}</td><td className="r"><b>{r.run_id}</b></td></tr>
              <tr><td>{t('data.generated')}</td><td className="r">{fmtStamp(r.generated_at)}</td></tr>
              <tr><td>{t('data.through')}</td><td className="r">{fmtDate(r.as_of)}</td></tr>
              <tr><td>{t('data.model')}</td><td className="r">{r.policy.version} / {r.preprocessing_version}</td></tr>
              <tr><td>{t('data.reference')}</td><td className="r">{t('data.referenceValue', { version: r.reference_version, date: fmtDate(r.reference_last_date) })}</td></tr>
              <tr><td>{t('data.cutoff')}</td><td className="r">{fmtNum(r.policy.high, 6)}</td></tr>
              <tr><td>{t('data.parity')}</td><td className="r">{r.parity.sealed ? t('data.parityOk') : t('data.parityPreview')}</td></tr>
              <tr><td>{t('data.replayed')}</td><td className="r">{t('data.replayedValue', { dev: r.parity.development_rows, off: r.parity.official_rows })}</td></tr>
              <tr><td>{t('data.advisory')}</td><td className="r">{r.models.v3 ?? t('data.v3off')} · {r.models.v4 ?? t('data.v4off')}</td></tr>
              <tr><td>{t('data.trainEnd')}</td><td className="r">{fmtDate(r.train_end)}</td></tr>
              <tr><td>{t('data.flagged')}</td><td className="r">{fmtInt(r.flagged_days)}</td></tr>
              <tr><td>{t('data.holidays')}</td><td className="r">{r.holidays.filter((h) => h >= r.first_date && h <= r.as_of).map((h) => fmtDate(h)).join(', ') || t('data.noHoliday')}</td></tr>
            </tbody></table>
            <MethodNote label={t('data.reproduce')}>{t('data.reproduceBody')}</MethodNote>
          </section>
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('data.validation')}</h2><p>{v.scope}</p></div></div>
            <HitDots hit={v.tp} miss={v.fn} falsePos={v.fp} />
            <div className="mini-kpis">
              <div><b>{fmtNum(v.precision, 2)}</b><span>{t('data.precision')}</span></div>
              <div><b>{fmtNum(v.recall, 2)}</b><span>{t('data.recall')}</span></div>
              <div><b>{fmtNum(v.f1, 2)}</b><span>F1</span></div>
            </div>
            {(() => {
              // episode counts derived from the evaluation's own precision and recall (no hard-coded values)
              const detected = Math.round(v.episode_recall * v.true_episodes), falsePos = v.pred_episodes - Math.round(v.episode_precision * v.pred_episodes);
              return <>
                <div className="mini-kpis">
                  <div><b>{detected}/{v.true_episodes}</b><span>{t('data.epDetected')}</span></div>
                  <div><b>{fmtPct(v.episode_precision, 1)}</b><span>{t('data.epPrecision')}</span></div>
                  <div><b>{fmtPct(v.episode_recall, 1)}</b><span>{t('data.epRecall')}</span></div>
                  <div><b>{falsePos}</b><span>{t('data.epFalse')}</span></div>
                </div>
                <p className="ns-foot">{t('data.missedSplit', { fn: v.fn, days: v.tp + v.fn, eps: v.true_episodes - detected, true: v.true_episodes })}</p>
              </>;
            })()}
            <MethodNote>{t('data.validationNote', { ap: fmtNum(v.ap, 2), ep: fmtNum(v.episode_precision, 2), er: fmtNum(v.episode_recall, 2) })}</MethodNote>
          </section>
          <section className="panel m-rise">
            <div className="panel-head"><div><h2>{t('data.limits')}</h2></div></div>
            <ul className="reasons">
              <li>{t('data.limitContactless', { n: c.contactless_limit_events })}</li>
              <li>{t('data.limitNegative', { n: c.negative_amount })}</li>
              <li>{t('data.limitNew')}</li>
              <li>{t('data.limitFeed')}</li>
              <li>{t('data.limitForecast')}</li>
            </ul>
          </section>
          {audit && (
            <section className="panel m-rise" style={css({ '--i': 2 })}>
              <div className="panel-head"><div><h2>{t('data.audit')}</h2><p>{t('data.auditSub')}</p></div></div>
              {audit.length ? <ol className="history">{audit.map((e) => <li key={e.event_id}><b>{t(`rev.action.${e.action}` as 'rev.action.close')}</b> · {e.target} · {t('data.by', { name: nameOf(e.actor) })} · {fmtStamp(e.ts)}{e.reason && e.action !== 'export' && <q>{e.reason}</q>}</li>)}</ol> : <p className="muted">{t('data.noEvent')}</p>}
            </section>
          )}
        </div>
        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>{t('data.digests')}</h2><p>{t('data.digestsSub', { n: Object.keys({ ...r.inputs, ...r.configurations }).length })}</p></div></div>
            <MethodNote label={t('data.showDigests')}><table className="stats digests"><tbody>{Object.entries({ ...r.inputs, ...r.configurations }).map(([f, h]) => <tr key={f}><td>{f}</td><td className="r"><code>{h.slice(0, 16)}</code></td></tr>)}</tbody></table></MethodNote>
          </section>
        </div>
      </div>
    </>
  );
}
