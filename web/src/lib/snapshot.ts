// Reads the run snapshot written by the Python V2 engine (`python -m engine.export`).
// The snapshot is the only data source: every number on screen comes from it (SRS FR-01, FR-13).
import fs from 'node:fs';
import path from 'node:path';

export interface MerchantDay {
  merchant_id: string; date: string; category: string;
  n: number; n_acc: number; n_dec: number; n_can: number; n_ref: number; value: number | null; ticket: number | null;
  valid_accepted_amount_count: number; unknown_status_count: number;
  expected_n: number | null; expected_n_adj: number | null; expected_lo: number | null; expected_hi: number | null;
  holiday: boolean; holiday_factor: number; history_days: number; warming_up: boolean;
  expected_dec_rate: number | null; expected_can_rate: number | null; expected_ticket: number | null;
  s_drop: number; s_surge: number; s_drop_sustained: number; s_surge_sustained: number; s_decline: number;
  s_decline_channel: number; s_cancel: number; s_amount: number; s_incident: number; incident_channel: string | null;
  anomaly_score: number | null; main_signal: string; is_anomaly: 0 | 1 | null;
  explanation: Explanation | null;
  lifecycle: { phase: string; incident_id: string | null; observation_on: string | null; quiet_days: number; reference_hold: boolean } | null;
  reference: string | null;
  detectors: Record<string, MetricEvidence>;
  hours: number[]; channels: Record<string, [number, number]>;
  counterfactual?: Counterfactual[];
  cold_start?: { expected: number; category_ref: number; own_days: number; score: number; signal: 'drop' | 'surge'; would_alert: boolean };
}

export interface MetricEvidence {
  observed: number | null; expected: number | null; interval: [number, number] | null;
  relative_deviation: number | null; method: string | null; reason: string | null; score: number | null;
  exposure: number | null; interval_coverage: number | null;
}

export interface Explanation {
  merchant_id: string; date: string; indicator: string; symptom: string; incident_id: string;
  explanation: string; limitations: string[]; observed_expected: MetricEvidence;
  signal_source: string; count_cusum: { direction: string | null; minimum_streak: number; log_likelihood_ratio: number };
  reference_version: string; reference_last_date: string; reference_support: { eligible_days: number };
  first_action: string; responsible_role: string;
}

export interface ForecastMetric { mean: number; intervals: Record<string, [number, number]> }
export interface ImpactMetric {
  observed: number | null; expected?: number | null; expected_at_observed_exposure?: number;
  shortfall?: number | null; excess?: number; signed_gap?: ForecastMetric | null; signed_excess?: ForecastMetric;
}
export interface Impact {
  duration_days: number; observed_days: number;
  cumulative: { transactions: ImpactMetric; accepted_value: ImpactMetric; rejections: ImpactMetric };
  limitations: string[];
}
export interface IncidentEvidence {
  id: string; kind: string; merchants: string[]; start: string; last_alert: string; as_of: string;
  duration_days: number; recovery_status: 'active_incident' | 'recovering' | 'resolved'; recovery_quiet_days: number;
  comparable_score: number; affected_transactions: number | null; potential_value: number | null;
  rank: number; priority_utility: number; criticality: string; first_action: string; responsible_role: string;
  evidence: Explanation; impact: Impact;
  priority_explanation: { method: string; leading_mcda_factors: string[]; criteria: Record<string, number>; weights: Record<string, number>; preference_status: string };
  cost_scenarios: { scenario: string; review_cost: number; conditional_missed_incident_cost: number | null; evidence_class: string }[];
}
export interface HybridRow {
  merchant_id: string; date: string; v4_advisory_score: number; v4_ordinary_rank: number; ml_score: number;
  investigation_candidate: boolean;
  evidence?: {
    summary: string; decision_source: string; attribution_disclaimer: string;
    channel_evidence: { channel: string; exposure: number; declines: number; declines_expected: number; cancellations: number }[];
    group_attributions_heuristic: Record<string, number>;
    top_abnormal_features: { feature: string; value: number; ordinary_median: number; std_dev: number }[];
  };
}

/** Bound at which a signal that fired would have stayed below the alert threshold (engine/collective.py). */
export interface Counterfactual { signal: string; op: '>=' | '<='; bound: number; observed: number; unit: 'tx' | 'count' | 'DZD'; of?: number; channel?: string; scope: 'day' | '3 days' }

export interface Cluster {
  id: string; kind: 'declines' | 'activity'; date: string; channel: string | null; cohort: number;
  members: string[]; observed: number; expected: number; relative_risk: number; score: number; p_value: number;
}

export interface AdvisoryRaw {
  id: string; date: string; channel: string; symptom: string; n: number; n_dec: number;
  category: string | null; start: string; duration_days: number; observed: number; expected: number; exposure: number;
  observed_rate: number | null; expected_rate: number | null; score: number; threshold: number;
  excess_rejections: number | null; potential_activity_shortfall: number | null; activity_increase: number | null;
  hypotheses: { hypothesis: string; check: string; support: string; counterevidence: string }[];
  calibration_date_tail_rank: number; reference_version: string;
  members: { merchant_id: string; n: number; n_dec: number; affected: boolean; flagged: boolean;
    observed: number; expected: number; exposure: number; reference_source: string }[];
}

export interface ForecastPoint { date: string; expected: number; lo: number; hi: number }

export interface Snapshot {
  schema_version: 2;
  run: {
    run_id: string; generated_at: string; as_of: string; first_date: string; train_end: string; batch_status: string;
    data_status: string; preprocessing_version: string; reference_version: string; reference_last_date: string;
    models: Record<string, string | null>; parity: { development_rows: number; official_rows: number; official_sha256: string;
      development_sha256: string; sealed: boolean; expected_official_sha256: string; expected_development_sha256: string };
    policy: { version: string; high: number; low: number | null; window_days: number; min_history: number; recovery_days: number };
    inputs: Record<string, string>; configurations: Record<string, string>; holidays: string[];
    cleaning: Record<string, number>; validation: { tp: number; fp: number; fn: number; tn: number; rows: number; f1: number;
      precision: number; recall: number; ap: number; scope: string; true_episodes: number; pred_episodes: number;
      episode_precision: number; episode_recall: number }; flagged_days: number;
    calibration?: { lo: number; hi: number; n: number; positives: number; rate: number | null }[];
    value_curve?: { threshold: number; tp: number; fp: number; fn: number; flagged: number }[];
  };
  merchant_days: MerchantDay[];
  official_predictions: { merchant_id: string; date: string; is_anomaly: 0 | 1; anomaly_score: number }[];
  incidents: IncidentEvidence[];
  priority_queue: { id: string; kind: string; rank: number; priority_utility: number; responsible_role: string; first_action: string }[];
  advisories: AdvisoryRaw[];
  domain_rules: { contactless: { limit_dzd: number; limitation: string; events: number } };
  hybrid: { version: string; challenger: string; feature_count: number; rows: HybridRow[] } | null;
  collective?: { method: string; reps: number; alpha: number; units_scanned: number; clusters: Cluster[] };
  forecast: {
    as_of: string; origin: string; last_reference_date: string; method: string; network: ForecastPoint[]; merchants: Record<string, ForecastPoint[]>;
    backtest: { origins: number; horizon_days: number; mae_model: number | null; mae_seasonal_naive: number | null; interval_coverage: number | null; nominal_coverage: number };
    detail: { limitations: string[]; days: { date: string; horizon: number; network: ForecastMetrics; merchants: Record<string, ForecastMetrics> }[] };
  };
  transactions: { merchants: string[]; ts: string[]; merchant: number[]; category: string[]; channel: string[]; status: string[];
    amount: (number | null)[]; source_row: string[]; quality: string[][]; contactless_limit: boolean[] };
}
export type ForecastMetrics = Record<'transactions' | 'accepted_value' | 'rejections', ForecastMetric | null>;

export const runsDir = () => process.env.RUNS_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..', 'runs');

let cache: { directory: string; id: string; snap: Snapshot } | null = null;

const imported = new Map<string, Snapshot>();
/** An operator-imported run (runs/imports/<id>/snapshot.json): read-only, never the dashboard's run. */
function importedSnapshot(run: string): Snapshot {
  if (!/^[a-f0-9]{16}$/.test(run)) throw new Error('Unknown run.');
  const hit = imported.get(run);
  if (hit) return hit;
  const file = path.join(/*turbopackIgnore: true*/ runsDir(), 'imports', run, 'snapshot.json');
  let snap: Snapshot;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Imported run ${run} is not available.`); }
  if (snap.schema_version !== 2 || snap.run.run_id !== run || snap.run.data_status !== 'imported_batch') throw new Error('The imported run failed schema validation.');
  if (imported.size >= 4) imported.delete(imported.keys().next().value!);
  imported.set(run, snap);
  return snap;
}

/** The official run (latest exported), or an imported run when `run` names one. Re-reads only when runs/latest.json points to a new run. */
export function snapshot(run?: string | null): Snapshot {
  if (run) return importedSnapshot(run);
  const dir = runsDir();
  let latest: { run_id: string; path: string; schema_version: number };
  try {
    latest = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, 'latest.json'), 'utf8'));
  } catch {
    throw new Error(`No engine run found in ${dir}. Run "python -m engine.export" from the repository root first.`);
  }
  if (latest.schema_version !== 2 || !/^[a-f0-9]{16}$/.test(latest.run_id) || latest.path !== `${latest.run_id}/snapshot.json`) {
    throw new Error('Unsupported SATIM run. Generate a fresh snapshot with python -m engine.export.');
  }
  if (cache?.id !== latest.run_id || cache.directory !== dir) {
    const snap: Snapshot = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, latest.path), 'utf8'));
    if (snap.schema_version !== 2 || snap.run.run_id !== latest.run_id || snap.official_predictions?.length !== 711) {
      throw new Error('The exported SATIM snapshot failed schema validation.');
    }
    cache = { directory: dir, id: latest.run_id, snap };
  }
  return cache.snap;
}
