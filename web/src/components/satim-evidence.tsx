import { fmtDate, fmtDzd, fmtInt, fmtNum, fmtPct, na } from '@/lib/format';
import { makeT, type Key, type Vars } from '@/lib/i18n';
import { engineText } from '@/lib/i18n/engine';

const tr = (key: string, vars?: Vars) => makeT()(key as Key, vars);
import type { HybridRow, IncidentEvidence, Snapshot } from '@/lib/snapshot';

export const symptomLabel = (symptom: string) => { const k = `symptom.${symptom}`, s = tr(k); return s === k ? symptom.replaceAll('_', ' ') : s; };

export function HybridEvidence({ row, nested = false }: { row: HybridRow; nested?: boolean }) {
  const evidence = row.evidence;
  const groups = Object.entries(evidence?.group_attributions_heuristic ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return <section className={nested ? undefined : 'panel m-rise'}>
    {!nested && <div className="panel-head"><div><h2>{tr('hy.title')}</h2><p>{tr('hy.sub')}</p></div></div>}
    <p>{tr('hy.scores', { fusion: fmtNum(row.v4_advisory_score, 3), ml: fmtNum(row.ml_score, 3), rank: fmtPct(row.v4_ordinary_rank, 2) })}</p>
    {evidence && <ul className="reasons">
      <li>{tr('hy.source', { source: evidence.decision_source })}</li>
      {groups.slice(0, 3).map(([name, value]) => <li key={name}>{name.replaceAll('_', ' ')} · {tr('hy.scoreChange', { v: fmtNum(value, 4) })}</li>)}
      {evidence.channel_evidence.map((c) => <li key={c.channel}>{tr('hy.channel', { channel: c.channel, dec: c.declines, n: c.exposure, exp: fmtNum(c.declines_expected, 1) })}</li>)}
      {evidence.top_abnormal_features.map((f) => <li key={f.feature}>{f.feature.replaceAll('_', ' ')} · {tr('hy.feature', { v: fmtNum(f.value, 2), med: fmtNum(f.ordinary_median, 2) })}</li>)}
      <li>{tr('hy.caveat')}</li>
    </ul>}
  </section>;
}

export function ImpactEvidence({ record }: { record: IncidentEvidence }) {
  const impact = record.impact, cumulative = impact.cumulative;
  const rows = [
    { label: tr('imp2.tx'), metric: cumulative.transactions, format: (v: number | null) => fmtInt(v) },
    { label: tr('imp2.value'), metric: cumulative.accepted_value, format: (v: number | null) => fmtDzd(v) },
    { label: tr('imp2.rej'), metric: cumulative.rejections, format: (v: number | null) => fmtInt(v) },
  ];
  return <section className="panel m-rise">
    <div className="panel-head"><div><h2>{tr('imp2.title')}</h2><p>{tr('imp2.sub', { obs: impact.observed_days, n: impact.duration_days })}</p></div></div>
    <table className="stats"><thead><tr><th>{tr('imp2.indicator')}</th><th>{tr('al.observed')}</th><th>{tr('ov.expected')}</th><th>{tr('imp2.gap')}</th></tr></thead><tbody>
      {rows.map(({ label, metric, format }) => {
        const interval = (metric.signed_gap ?? metric.signed_excess)?.intervals['80'];
        return <tr key={label}><th scope="row">{label}</th><td>{format(metric.observed)}</td>
          <td>{format(metric.expected_at_observed_exposure ?? metric.expected ?? null)}</td>
          <td>{format(metric.shortfall ?? metric.excess ?? null)}{interval && <small className="muted"> · {tr('imp2.range', { lo: format(interval[0]), hi: format(interval[1]) })}</small>}</td></tr>;
      })}
    </tbody></table>
    <p className="ns-foot">{tr('imp2.foot')}</p>
    <details className="how">
      <summary>{tr('imp2.costs')}</summary>
      <ul className="reasons">{record.cost_scenarios.map((c) => <li key={c.scenario}>{tr(`scenario.${c.scenario}`)} · {tr('imp2.review', { v: fmtDzd(c.review_cost) })} · {tr('imp2.missed', { v: fmtDzd(c.conditional_missed_incident_cost) })}</li>)}</ul>
      <p className="ns-foot">{tr('imp2.confirm')}</p>
    </details>
  </section>;
}

export function ForecastEvidence({ forecast, merchant }: { forecast: Snapshot['forecast']; merchant?: string }) {
  const entries = forecast.detail.days.map((d) => ({ date: d.date, metrics: merchant ? d.merchants[merchant] : d.network }));
  if (!entries.some((d) => d.metrics)) return null;
  return <details className="how">
    <summary>{tr('fc.title')}</summary>
    <p>{tr('fc.origin', { origin: fmtDate(forecast.origin), ref: fmtDate(forecast.last_reference_date) })}</p>
    <table className="stats"><thead><tr><th>{tr('al.day')}</th><th>{tr('fc.value')}</th><th>{tr('fc.rej')}</th></tr></thead><tbody>
      {entries.map(({ date, metrics }) => <tr key={date}><th scope="row">{fmtDate(date)}</th>
        {(['accepted_value', 'rejections'] as const).map((m) => {
          const value = metrics?.[m], f = (v: number) => (m === 'accepted_value' ? fmtDzd(v) : fmtInt(v));
          return <td key={m}>{value ? <>{f(value.mean)} <small>({f(value.intervals['80'][0])}–{f(value.intervals['80'][1])})</small></> : na()}</td>;
        })}
      </tr>)}
    </tbody></table>
    <p>{forecast.detail.limitations.map((x) => engineText(x)).join(' ')}</p>
  </details>;
}
