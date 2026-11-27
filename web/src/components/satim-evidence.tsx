import { fmtDate, fmtDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import type { HybridRow, IncidentEvidence, Snapshot } from '@/lib/snapshot';

export const symptomLabel = (symptom: string) => ({
  rejection_increase: 'Excess rejections', activity_drop: 'Activity shortfall',
  activity_surge: 'Activity surge', cancellation_increase: 'Excess cancellations',
  monetary_shift: 'Ticket-size shift',
})[symptom] ?? symptom.replaceAll('_', ' ');

export function HybridEvidence({ row, nested = false }: { row: HybridRow; nested?: boolean }) {
  const evidence = row.evidence;
  const groups = Object.entries(evidence?.group_attributions_heuristic ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return <section className={nested ? undefined : 'panel m-rise'}>
    {!nested && <div className="panel-head"><div><h2>Hybrid ML advisory evidence</h2><p>Isolation Forest H3 · 62 features</p></div></div>}
    <p>Fusion score {fmtNum(row.v4_advisory_score, 3)} · ML score {fmtNum(row.ml_score, 3)} · ordinary ML tail rank {fmtPct(row.v4_ordinary_rank, 2)}</p>
    {evidence && <ul className="reasons">
      <li>Evidence source {evidence.decision_source}</li>
      {groups.slice(0, 3).map(([name, value]) => <li key={name}>{name.replaceAll('_', ' ')} · score change {fmtNum(value, 4)}</li>)}
      {evidence.channel_evidence.map((c) => <li key={c.channel}>{c.channel}: {c.declines} declines from {c.exposure} events, vs {fmtNum(c.declines_expected, 1)} expected</li>)}
      {evidence.top_abnormal_features.map((f) => <li key={f.feature}>{f.feature.replaceAll('_', ' ')} · {fmtNum(f.value, 2)} vs ordinary median {fmtNum(f.ordinary_median, 2)}</li>)}
      <li>Feature perturbations show model associations. Confirm causes with independent evidence.</li>
    </ul>}
  </section>;
}

export function ImpactEvidence({ record }: { record: IncidentEvidence }) {
  const impact = record.impact, cumulative = impact.cumulative;
  const rows = [
    { label: 'Transactions', metric: cumulative.transactions, format: fmtInt },
    { label: 'Accepted payment value', metric: cumulative.accepted_value, format: fmtDzd },
    { label: 'Rejections at observed exposure', metric: cumulative.rejections, format: fmtInt },
  ];
  return <section className="panel m-rise">
    <div className="panel-head"><div><h2>Estimated business impact</h2><p>{impact.observed_days} observed days over {impact.duration_days} calendar days</p></div></div>
    <table className="stats"><thead><tr><th>Indicator</th><th>Observed</th><th>Expected</th><th>Estimated gap</th></tr></thead><tbody>
      {rows.map(({ label, metric, format }) => {
        const interval = (metric.signed_gap ?? metric.signed_excess)?.intervals['80'];
        return <tr key={label}><th scope="row">{label}</th><td>{format(metric.observed)}</td>
          <td>{format(metric.expected_at_observed_exposure ?? metric.expected ?? null)}</td>
          <td>{format(metric.shortfall ?? metric.excess ?? null)}{interval && <small className="muted"> · 80% signed range {format(interval[0])} to {format(interval[1])}</small>}</td></tr>;
      })}
    </tbody></table>
    <p className="ns-foot">Gross payment activity estimate. Realized economic loss and SATIM revenue are separate quantities.</p>
    <details className="how">
      <summary>Illustrative cost assumptions</summary>
      <ul className="reasons">{record.cost_scenarios.map((c) => <li key={c.scenario}>{c.scenario.replaceAll('_', ' ')} · review {fmtDzd(c.review_cost)} · conditional missed-incident cost {fmtDzd(c.conditional_missed_incident_cost)}</li>)}</ul>
      <p className="ns-foot">Scenario assumptions require SATIM confirmation.</p>
    </details>
  </section>;
}

export function ForecastEvidence({ forecast, merchant }: { forecast: Snapshot['forecast']; merchant?: string }) {
  const entries = forecast.detail.days.map((d) => ({ date: d.date, metrics: merchant ? d.merchants[merchant] : d.network }));
  if (!entries.some((d) => d.metrics)) return null;
  return <details className="how">
    <summary>Accepted value and rejection forecasts</summary>
    <p>Origin {fmtDate(forecast.origin)} · historical reference through {fmtDate(forecast.last_reference_date)} · seven days</p>
    <table className="stats"><thead><tr><th>Day</th><th>Accepted value · 80% range</th><th>Rejections · 80% range</th></tr></thead><tbody>
      {entries.map(({ date, metrics }) => <tr key={date}><th scope="row">{fmtDate(date)}</th>
        {(['accepted_value', 'rejections'] as const).map((m) => {
          const value = metrics?.[m], f = m === 'accepted_value' ? fmtDzd : fmtInt;
          return <td key={m}>{value ? <>{f(value.mean)} <small>({f(value.intervals['80'][0])}–{f(value.intervals['80'][1])})</small></> : 'n/a'}</td>;
        })}
      </tr>)}
    </tbody></table>
    <p>{forecast.detail.limitations.join(' ')}</p>
  </details>;
}
