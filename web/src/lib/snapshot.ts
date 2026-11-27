// Reads the run snapshot written by the Python V2 engine (`python -m engine.export`).
// The snapshot is the only data source: every number on screen comes from it (SRS FR-01, FR-13).
import fs from 'node:fs';
import path from 'node:path';

export interface MerchantDay {
  merchant_id: string; date: string; category: string;
  n: number; n_acc: number; n_dec: number; n_can: number; n_ref: number; value: number; ticket: number | null;
  expected_n: number | null; expected_n_adj: number | null; expected_lo: number | null; expected_hi: number | null;
  holiday: boolean; holiday_factor: number; history_days: number; warming_up: boolean;
  expected_dec_rate: number | null; expected_can_rate: number | null; expected_ticket: number | null;
  s_drop: number; s_surge: number; s_drop_sustained: number; s_surge_sustained: number; s_decline: number;
  s_decline_channel: number; s_cancel: number; s_amount: number; s_incident: number; incident_channel: string | null;
  anomaly_score: number; main_signal: string; is_anomaly: 0 | 1;
  hours: number[]; channels: Record<string, [number, number]>;
  counterfactual?: Counterfactual[];
  cold_start?: { expected: number; category_ref: number; own_days: number; score: number; signal: 'drop' | 'surge'; would_alert: boolean };
}

/** Bound at which a signal that fired would have stayed below the alert threshold (engine/collective.py). */
export interface Counterfactual { signal: string; op: '>=' | '<='; bound: number; observed: number; unit: 'tx' | 'count' | 'DZD'; of?: number; channel?: string; scope: 'day' | '3 days' }

export interface Cluster {
  id: string; kind: 'declines' | 'activity'; date: string; channel: string | null; cohort: number;
  members: string[]; observed: number; expected: number; relative_risk: number; score: number; p_value: number;
}

export interface AdvisoryRaw {
  id: string; date: string; channel: string; symptom: string; n: number; n_dec: number;
  observed_rate: number; expected_rate: number; score: number; threshold: number;
  members: { merchant_id: string; n: number; n_dec: number; affected: boolean; flagged: boolean }[];
}

export interface ForecastPoint { date: string; expected: number; lo: number; hi: number }

export interface Snapshot {
  run: {
    run_id: string; as_of: string; first_date: string; train_end: string; batch_status: string; dispersion: number;
    policy: { version: string; high: number; low: number; window_days: number; min_history: number };
    inputs: Record<string, string>; code: Record<string, string>; holidays: string[];
    cleaning: Record<string, number>; validation: Record<string, number>; flagged_days: number;
    calibration?: { lo: number; hi: number; n: number; positives: number; rate: number | null }[];
    value_curve?: { threshold: number; tp: number; fp: number; fn: number; flagged: number }[];
  };
  merchant_days: MerchantDay[];
  advisories: AdvisoryRaw[];
  collective?: { method: string; reps: number; alpha: number; units_scanned: number; clusters: Cluster[] };
  forecast: {
    as_of: string; method: string; network: ForecastPoint[]; merchants: Record<string, ForecastPoint[]>;
    backtest: { origins: number; horizon_days: number; mae_model: number; mae_seasonal_naive: number; interval_coverage: number; nominal_coverage: number };
  };
  transactions: { merchants: string[]; ts: string[]; merchant: number[]; category: string[]; channel: string[]; status: string[]; amount: (number | null)[] };
}

export const runsDir = () => process.env.RUNS_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..', 'runs');

let cache: { id: string; snap: Snapshot } | null = null;

/** Latest exported run. Re-reads only when runs/latest.json points to a new run. */
export function snapshot(): Snapshot {
  const dir = runsDir();
  let latest: { run_id: string; path: string };
  try {
    latest = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, 'latest.json'), 'utf8'));
  } catch {
    throw new Error(`No engine run found in ${dir}. Run "python -m engine.export" from the repository root first.`);
  }
  if (cache?.id !== latest.run_id) {
    cache = { id: latest.run_id, snap: JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, latest.path), 'utf8')) };
  }
  return cache.snap;
}
