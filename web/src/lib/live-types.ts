export type Scope = [kind: string, name: string];
export type ReplayPoint = {
  time: string; observed: number; expected: number; lower: number; upper: number;
  cumulative: number; cumulative_expected: number; rejections: number; cancellations: number;
  accepted_value: number; daily_value: number; daily_rejections: number; complete: boolean;
};
export type ReplayWarning = {
  id: string; scope: Scope; kind: string; symptom: string; opened: string; through: string;
  state: string; from: string; observed: number; expected: number; score: number; unit: string;
  explanation: string; signal: string; action: string; limitation: string; reference_days?: number;
  cusum?: number[]; merchants?: string[]; corroborated?: string[]; difference?: number;
  timeline: { time: string; state: string }[];
};
export type ReplaySnapshot = {
  mode: string; status: 'idle' | 'running' | 'paused' | 'stopped' | 'finished' | 'failed';
  min_date: string; max_date: string; default_date: string; speeds: number[]; presets: Record<string, string>;
  clock?: string; watermark?: string | null; speed?: number; start?: string; end?: string; preset?: string;
  scope?: Scope; scopes?: Scope[]; points?: ReplayPoint[]; progress?: number; feed?: string;
  summary?: { transactions_per_minute: number | null; daily_rejection_rate: number | null;
    minutes_since_event: number | null; active_individual: number; active_collective: number;
    affected_merchants: number; affected_channels: number };
  last_event?: string | null; reference_days?: number; reference_events?: number; median_ticket?: number | null;
  reference_median_ticket?: number | null;
  minimum_amount_tail?: number | null;
  monitoring?: { base_minutes: number; adaptive_expected_events: number; adaptive_max_minutes: number;
    downward_cusum: number; upward_cusum: number };
  warnings?: ReplayWarning[];
  domain?: { time: string; merchant: string; amount: number; rule: string }[];
  daily?: { date: string; status: string; scored: number; flagged: { merchant: string; score: number }[] }[];
  truth?: { onset: string; end: string; channel: string | null; merchants: string[];
    changed_events: number; same_day_backlog: boolean } | null;
};
