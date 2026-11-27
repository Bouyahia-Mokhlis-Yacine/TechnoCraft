import { DataSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getMeta } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum } from '@/lib/format';
import { readAll } from '@/lib/reviews';
import { ROLES, can, currentUser } from '@/lib/session';
import { PageHeader } from '@/components/ui';
import { HitDots, MethodNote, Pipeline } from '@/components/visuals';

export const metadata: Metadata = { title: 'Data & runs' };
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function DataPage() {
  return <Suspense fallback={<DataSkeleton />}><Data /></Suspense>;
}

async function Data() {
  const user = await currentUser();
  const r = getMeta().run;
  const v = r.validation, c = r.cleaning;
  const audit = can(user?.role, 'audit') ? readAll().slice(-40).reverse() : null;
  return (
    <>
      <PageHeader title="Data & runs" />
      <section className="panel m-rise">
        <div className="panel-head"><div><h2>Cleaning</h2><p>Before scoring</p></div></div>
        <Pipeline start={{ label: 'rows received', value: c.rows_raw }} end={{ label: 'rows scored', value: c.rows_clean }} steps={[
          { label: 'exact duplicates', value: c.exact_duplicates_removed, kind: 'removed' },
          { label: 'unparseable dates', value: c.unparseable_dates_removed, kind: 'removed' },
          { label: 'negative amounts sign-corrected', value: c.negative_amounts_sign_fixed, kind: 'fixed' },
          { label: 'categories filled', value: c.missing_category_filled, kind: 'fixed' },
          { label: 'channels → Unknown', value: c.missing_channel_set_unknown, kind: 'fixed' },
          { label: 'no amount, kept for counts', value: c.missing_amount_kept_for_counts, kind: 'kept' },
        ]} />
      </section>
      <div className="ov">
        <div className="stack">
          <section className="panel m-rise">
            <div className="panel-head"><div><h2>Current run</h2></div><span className="chip ok">Batch {r.batch_status}</span></div>
            <table className="stats"><tbody>
              <tr><td>Run ID</td><td className="r"><b>{r.run_id}</b></td></tr>
              <tr><td>Policy</td><td className="r">{r.policy.version} · opens at {r.policy.high}, continues at {r.policy.low} · {r.policy.window_days}-day reference · {r.policy.min_history} days history</td></tr>
              <tr><td>Dispersion α</td><td className="r">{fmtNum(r.dispersion, 4)}</td></tr>
              <tr><td>Training period ends</td><td className="r">{fmtDate(r.train_end)}</td></tr>
              <tr><td>Flagged merchant-days</td><td className="r">{fmtInt(r.flagged_days)}</td></tr>
              <tr><td>Public holidays</td><td className="r">{r.holidays.filter((h) => h >= r.first_date && h <= r.as_of).map(fmtDate).join(', ') || 'none in range'}</td></tr>
            </tbody></table>
            <MethodNote label="Reproduce this run">From the repository root: <code>.venv/bin/python -m engine.export</code> then <code>npm run build</code> in <code>web/</code>. Identical inputs give the same run ID; the same code path writes y_pred_anomalies.csv. Holidays: python-holidays (DZ). Dispersion is the negative binomial α for counts.</MethodNote>
          </section>
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Validation</h2><p>Training labels · one dot per labelled day</p></div></div>
            <HitDots hit={v.tp} miss={v.fn} falsePos={v.fp} />
            <div className="mini-kpis">
              <div><b>{fmtNum(v.precision, 2)}</b><span>precision</span></div>
              <div><b>{fmtNum(v.recall, 2)}</b><span>recall</span></div>
              <div><b>{fmtNum(v.f1, 2)}</b><span>F1</span></div>
              <div><b>{v.pred_episodes}/{v.true_episodes}</b><span>episodes</span></div>
            </div>
            <MethodNote>Measured on the training period, where the thresholds were chosen, so it is optimistic. PR-AUC {fmtNum(v.pr_auc, 2)}; episode precision {fmtNum(v.episode_precision, 2)}, recall {fmtNum(v.episode_recall, 2)}.</MethodNote>
          </section>
          {r.calibration && (
            <section className="panel m-rise" style={css({ '--i': 2 })}>
              <div className="panel-head"><div><h2>Calibration</h2><p>Share of labelled anomalies by score band · training period</p></div></div>
              <div className="cal-bars" role="img" aria-label={r.calibration.map((b) => `score ${b.lo} to ${b.hi}: ${b.positives} of ${b.n} labelled anomalies`).join('; ')}>
                {r.calibration.map((b, i) => (
                  <div key={b.lo} className={`cal${b.lo >= r.policy.high ? ' alert' : ''}`}>
                    <span className="cal-rate num">{b.rate === null ? '—' : `${Math.round(b.rate * 100)} %`}</span>
                    <span className="cal-col"><span className="cal-fill m-grow-up" style={css({ height: `${(b.rate ?? 0) * 100}%`, '--i': i })} /></span>
                    <span className="cal-band num">{b.lo}–{b.hi}</span>
                    <small className="num">{b.positives}/{b.n}</small>
                  </div>
                ))}
              </div>
              <p className="ns-foot">Bands at or above {r.policy.high} open an alert. A higher score means more unusual for that merchant, not a probability.</p>
            </section>
          )}
          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><h2>Known limitations</h2></div></div>
            <ul className="reasons">
              <li>Validated on the training labels only: the thresholds were chosen there, so these figures are optimistic.</li>
              <li>{v.tp + v.fn} labelled anomaly days in training: too few for tight error bars.</li>
              <li>Count alerts need {r.policy.min_history} days of a merchant’s own history; before that the category reference is advisory.</li>
              <li>Causes cannot be confirmed: gateway reason codes and switch logs are not in the data.</li>
              <li>Negative amounts are sign-corrected ({fmtInt(c.negative_amounts_sign_fixed)} rows); the SRS proposes excluding them.</li>
              <li>The network forecast interval is a normal approximation of the merchant sum, not a calibrated joint interval.</li>
              <li>The assistant is rule-based: it answers the question types it knows and refuses the rest.</li>
            </ul>
          </section>
          {audit && (
            <section className="panel m-rise" style={css({ '--i': 2 })}>
              <div className="panel-head"><div><h2>Audit ledger</h2><p>Last 40 events · append-only</p></div></div>
              {audit.length ? <ol className="history">{audit.map((e) => <li key={e.event_id}><b>{e.action}</b> · {e.target} by {ROLES[e.actor].name} · {new Date(e.ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{e.reason && e.action !== 'export' && <q>{e.reason}</q>}</li>)}</ol> : <p className="muted">No event yet.</p>}
            </section>
          )}
        </div>
        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Digests</h2><p>SHA-256 · {Object.keys({ ...r.inputs, ...r.code }).length} files</p></div></div>
            <MethodNote label="Show file digests"><table className="stats digests"><tbody>{Object.entries({ ...r.inputs, ...r.code }).map(([f, h]) => <tr key={f}><td>{f}</td><td className="r"><code>{h.slice(0, 16)}</code></td></tr>)}</tbody></table></MethodNote>
          </section>
        </div>
      </div>
    </>
  );
}
