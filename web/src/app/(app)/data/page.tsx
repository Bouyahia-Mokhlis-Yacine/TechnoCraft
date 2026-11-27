import { DataSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getMeta } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum } from '@/lib/format';
import { readAll } from '@/lib/reviews';
import { can, currentUser } from '@/lib/session';
import { nameOf } from '@/lib/accounts';
import { PageHeader } from '@/components/ui';
import { HitDots, MethodNote, Pipeline } from '@/components/visuals';

export const metadata: Metadata = { title: 'Data & runs' };
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function DataPage() {
  return <Suspense fallback={<DataSkeleton />}><Data /></Suspense>;
}

async function Data() {
  const user = await currentUser();
  const { run: r } = getMeta();
  const v = r.validation, c = r.cleaning;
  const audit = can(user, 'audit') ? readAll().slice(-40).reverse() : null;
  return (
    <>
      <PageHeader title="Data & runs" />
      <section className="panel m-rise">
        <div className="panel-head"><div><h2>Cleaning</h2><p>Before scoring</p></div></div>
        <Pipeline start={{ label: 'rows received', value: c.raw_rows }} end={{ label: 'rows scored', value: c.retained_events }} steps={[
          { label: 'exact duplicates', value: c.exact_duplicate, kind: 'removed' },
          { label: 'unparseable dates', value: c.invalid_timestamp, kind: 'removed' },
          { label: 'negative amounts excluded from value', value: c.negative_amount, kind: 'kept' },
          { label: 'missing categories', value: c.missing_category, kind: 'fixed' },
          { label: 'channels → Unknown', value: c.missing_channel, kind: 'fixed' },
          { label: 'no amount, kept for counts', value: c.missing_amount, kind: 'kept' },
        ]} />
      </section>
      <div className="ov">
        <div className="stack">
          <section className="panel m-rise">
            <div className="panel-head"><div><h2>Historical competition replay</h2></div><span className="chip ok">Batch {r.batch_status}</span></div>
            <table className="stats"><tbody>
              <tr><td>Run ID</td><td className="r"><b>{r.run_id}</b></td></tr>
              <tr><td>Generated (Algiers)</td><td className="r">{new Date(r.generated_at).toLocaleString('en-GB', { timeZone: 'Africa/Algiers' })}</td></tr>
              <tr><td>Data through</td><td className="r">{fmtDate(r.as_of)}</td></tr>
              <tr><td>Model / preprocessing</td><td className="r">{r.policy.version} / {r.preprocessing_version}</td></tr>
              <tr><td>Pinned reference</td><td className="r">{r.reference_version} · through {fmtDate(r.reference_last_date)}</td></tr>
              <tr><td>Frozen managed cutoff</td><td className="r">{fmtNum(r.policy.high, 6)}</td></tr>
              <tr><td>Sealed score parity</td><td className="r">{r.parity.sealed ? 'Verified against the archive' : 'Preview · archive digest differs'}</td></tr>
              <tr><td>Replayed merchant-days</td><td className="r">{r.parity.development_rows} development · {r.parity.official_rows} official template</td></tr>
              <tr><td>Advisory models</td><td className="r">{r.models.v3 ?? 'Collective Detection disabled'} · {r.models.v4 ?? 'Hybrid ML disabled'}</td></tr>
              <tr><td>Training period ends</td><td className="r">{fmtDate(r.train_end)}</td></tr>
              <tr><td>Flagged merchant-days</td><td className="r">{fmtInt(r.flagged_days)}</td></tr>
              <tr><td>Public holidays</td><td className="r">{r.holidays.filter((h) => h >= r.first_date && h <= r.as_of).map(fmtDate).join(', ') || 'none in range'}</td></tr>
            </tbody></table>
            <MethodNote label="Reproduce this run">Run <code>python -m engine.export</code> from the repository root. Each run records its own generation time. Public holidays are marked as calendar context.</MethodNote>
          </section>
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Validation</h2><p>{v.scope}</p></div></div>
            <HitDots hit={v.tp} miss={v.fn} falsePos={v.fp} />
            <div className="mini-kpis">
              <div><b>{fmtNum(v.precision, 2)}</b><span>precision</span></div>
              <div><b>{fmtNum(v.recall, 2)}</b><span>recall</span></div>
              <div><b>{fmtNum(v.f1, 2)}</b><span>F1</span></div>
              <div><b>{v.pred_episodes}/{v.true_episodes}</b><span>episodes</span></div>
            </div>
            <MethodNote>Average precision {fmtNum(v.ap, 2)} in the reserved development block; episode precision {fmtNum(v.episode_precision, 2)}, recall {fmtNum(v.episode_recall, 2)}.</MethodNote>
          </section>
          <section className="panel m-rise">
            <div className="panel-head"><div><h2>Data-quality limitations</h2></div></div>
            <ul className="reasons">
              <li>{fmtInt(c.contactless_limit_events)} retained contactless transactions exceed 2,500 DZD. The unusually high rate reflects synthetic data generation. Original amounts are preserved.</li>
              <li>{fmtInt(c.negative_amount)} negative amounts are excluded from monetary metrics. Their events remain in activity and outcome counts.</li>
              <li>New merchants use a pooled Gamma–Poisson reference. Sparse evidence widens the uncertainty.</li>
              <li>Feed completeness is assumed for supplied competition roster days. Service telemetry is unavailable.</li>
              <li>Forecasts assume conditional independence across merchants and exclude shared shocks.</li>
            </ul>
          </section>
          {audit && (
            <section className="panel m-rise" style={css({ '--i': 2 })}>
              <div className="panel-head"><div><h2>Audit ledger</h2><p>Last 40 events · append-only</p></div></div>
              {audit.length ? <ol className="history">{audit.map((e) => <li key={e.event_id}><b>{e.action}</b> · {e.target} by {nameOf(e.actor)} · {new Date(e.ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{e.reason && e.action !== 'export' && <q>{e.reason}</q>}</li>)}</ol> : <p className="muted">No event yet.</p>}
            </section>
          )}
        </div>
        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Digests</h2><p>SHA-256 · {Object.keys({ ...r.inputs, ...r.configurations }).length} files</p></div></div>
            <MethodNote label="Show file digests"><table className="stats digests"><tbody>{Object.entries({ ...r.inputs, ...r.configurations }).map(([f, h]) => <tr key={f}><td>{f}</td><td className="r"><code>{h.slice(0, 16)}</code></td></tr>)}</tbody></table></MethodNote>
          </section>
        </div>
      </div>
    </>
  );
}
