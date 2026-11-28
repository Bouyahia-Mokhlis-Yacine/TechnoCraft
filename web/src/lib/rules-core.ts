// Company rules: structured, validated conditions over figures the engine already computes (merchant-days and
// cleaned transactions of a run snapshot). Deterministic and side-effect free: evaluating a rule never changes a
// prediction, score, incident or dataset, and nothing user-supplied is ever executed (whitelisted indicators,
// operators and numbers only). No Node or app imports: the browser builder reads the same definitions, and
// `node src/lib/rules.test.ts` checks it directly. Storage is in rules-store.ts.

export type Granularity = 'transaction' | 'merchant_day';
export type ScopeKind = 'network' | 'merchant' | 'category' | 'channel';
export type Op = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type RuleAction = 'evidence' | 'alert' | 'investigate' | 'priority';
export type Status = 'draft' | 'active' | 'disabled' | 'archived';
export interface Condition { indicator: string; op: Op; value: number; value2?: number }
export interface Rule {
  id: string; version: number; name: string; description: string; justification: string;
  scope: { kind: ScopeKind; value?: string }; granularity: Granularity;
  conditions: Condition[]; combinator: 'all' | 'any'; persistence_days: number;
  severity: Severity; action: RuleAction; recommendation: string; effective_from: string; status: Status;
  created_by: string; created_at: string; updated_by: string; updated_at: string;
  activated_by?: string; activated_at?: string; reason?: string;
}

/** Indicators the backend computes, per granularity: unit, and whether a channel scope can split it. */
export const INDICATORS: Record<string, { granularity: Granularity; unit: 'DZD' | '%' | 'count' | 'hours'; channel: boolean }> = {
  amount: { granularity: 'transaction', unit: 'DZD', channel: true },
  transactions: { granularity: 'merchant_day', unit: 'count', channel: true },
  decline_rate: { granularity: 'merchant_day', unit: '%', channel: true },
  cancellation_rate: { granularity: 'merchant_day', unit: '%', channel: false },
  accepted_value: { granularity: 'merchant_day', unit: 'DZD', channel: false },
  median_ticket: { granularity: 'merchant_day', unit: 'DZD', channel: false },
  activity_vs_expected: { granularity: 'merchant_day', unit: '%', channel: false },
  idle_hours: { granularity: 'merchant_day', unit: 'hours', channel: false },
};
export const OPS: Op[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'between'];
const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const ACTIONS: RuleAction[] = ['evidence', 'alert', 'investigate', 'priority'];
const SCOPES: ScopeKind[] = ['network', 'merchant', 'category', 'channel'];

export const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** The editable part of a rule, checked field by field; returns the clean draft or the list of problems. */
export function validateDraft(raw: unknown): { ok: true; draft: Omit<Rule, 'id' | 'version' | 'status' | 'created_by' | 'created_at' | 'updated_by' | 'updated_at'> } | { ok: false; errors: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, errors: string[] = [];
  const name = text(r.name, 80);
  if (!name) errors.push('name_required');
  const granularity = r.granularity === 'transaction' ? 'transaction' : r.granularity === 'merchant_day' ? 'merchant_day' : null;
  if (!granularity) errors.push('granularity');
  const s = (r.scope && typeof r.scope === 'object' ? r.scope : {}) as Record<string, unknown>;
  const kind = SCOPES.includes(s.kind as ScopeKind) ? (s.kind as ScopeKind) : null;
  const value = text(s.value, 64);
  if (!kind) errors.push('scope');
  else if (kind !== 'network' && !value) errors.push('scope_value');
  const list = Array.isArray(r.conditions) ? r.conditions.slice(0, 6) : [];
  if (!list.length) errors.push('conditions_required');
  const conditions: Condition[] = [];
  list.forEach((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const ind = typeof o.indicator === 'string' ? INDICATORS[o.indicator] : undefined;
    const op = OPS.includes(o.op as Op) ? (o.op as Op) : null;
    const v = num(o.value), v2 = num(o.value2);
    if (!ind) { errors.push(`condition_${i + 1}_indicator`); return; }
    if (granularity && ind.granularity !== granularity) errors.push(`condition_${i + 1}_granularity`);
    if (kind === 'channel' && !ind.channel) errors.push(`condition_${i + 1}_channel_scope`);
    if (!op) errors.push(`condition_${i + 1}_operator`);
    if (v === null) errors.push(`condition_${i + 1}_value`);
    if (op === 'between' && (v2 === null || (v !== null && v2 < v))) errors.push(`condition_${i + 1}_range`);
    if (op && v !== null) conditions.push({ indicator: o.indicator as string, op, value: v, ...(op === 'between' && v2 !== null ? { value2: v2 } : {}) });
  });
  const persistence = Math.max(1, Math.min(14, Math.round(num(r.persistence_days) ?? 1)));
  if (granularity === 'transaction' && persistence > 1) errors.push('persistence_transaction');
  const severity = SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : null;
  if (!severity) errors.push('severity');
  const action = ACTIONS.includes(r.action as RuleAction) ? (r.action as RuleAction) : null;
  if (!action) errors.push('action');
  const effective = typeof r.effective_from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.effective_from) ? r.effective_from : null;
  if (!effective) errors.push('effective_from');
  if (errors.length) return { ok: false, errors };
  return { ok: true, draft: { name, description: text(r.description, 400), justification: text(r.justification, 400),
    scope: kind === 'network' ? { kind: kind! } : { kind: kind!, value }, granularity: granularity!, conditions,
    combinator: r.combinator === 'any' ? 'any' : 'all', persistence_days: persistence, severity: severity!, action: action!,
    recommendation: text(r.recommendation, 300), effective_from: effective! } };
}

/* ── evaluation ─────────────────────────────────────────────────────────── */

export interface DayRow { merchant_id: string; date: string; category: string; n: number; n_dec: number; n_can: number; value: number | null;
  ticket: number | null; expected_n: number | null; warming_up: boolean; hours: number[]; channels: Record<string, [number, number]>; is_anomaly: 0 | 1 | null }
export interface TxData { merchants: string[]; ts: string[]; merchant: number[]; category: string[]; channel: string[]; status: string[]; amount: (number | null)[] }
export interface Match { merchant: string; date: string; channel?: string; time?: string; observed: Record<string, number | null>; matched: string[]; ai_alert: boolean }
export interface Evaluation { evaluated: number; matched: Match[]; insufficient: number; incomplete: number; merchants: string[]; channels: string[]; overlap: number; additional: number; last: string | null }

/** Longest run of hours without a transaction between the day's first and last transaction (24 for a day with none). */
export function idleHours(hours: number[]): number {
  const first = hours.findIndex((h) => h > 0);
  if (first < 0) return 24;
  const last = hours.length - 1 - [...hours].reverse().findIndex((h) => h > 0);
  let best = 0, run = 0;
  for (let i = first; i <= last; i++) { run = hours[i] > 0 ? 0 : run + 1; best = Math.max(best, run); }
  return best;
}

/** One merchant-day indicator, or null when it cannot be computed (zero denominator, no reference, unknown value). */
function dayValue(ind: string, d: DayRow, channel?: string): number | null {
  const [n, dec] = channel ? d.channels[channel] ?? [0, 0] : [d.n, d.n_dec];
  switch (ind) {
    case 'transactions': return n;
    case 'decline_rate': return n ? (dec / n) * 100 : null;
    case 'cancellation_rate': return d.n ? (d.n_can / d.n) * 100 : null;
    case 'accepted_value': return d.value;
    case 'median_ticket': return d.ticket;
    case 'activity_vs_expected': return d.warming_up || !d.expected_n ? null : ((d.n - d.expected_n) / d.expected_n) * 100;
    case 'idle_hours': return d.hours?.length === 24 ? idleHours(d.hours) : null;
    default: return null;
  }
}
const test = (c: Condition, v: number) => (c.op === 'gt' ? v > c.value : c.op === 'gte' ? v >= c.value : c.op === 'lt' ? v < c.value
  : c.op === 'lte' ? v <= c.value : c.op === 'eq' ? Math.abs(v - c.value) < 1e-9 : v >= c.value && v <= (c.value2 ?? c.value));
const CHANNEL_OF: Record<string, string> = { 'Contactless / NFC': 'nfc', 'E-commerce (CIB / Edahabia)': 'ecommerce', 'TPE / POS Terminal': 'pos', 'Mobile App': 'mobile', 'Bank Transfer / Virement': 'transfer' };

/** Conditions combined with AND (all) or OR (any). An unknown value never matches; it counts as insufficient data. */
function combine(rule: Pick<Rule, 'conditions' | 'combinator'>, value: (ind: string) => number | null) {
  const observed: Record<string, number | null> = {}, matched: string[] = [];
  let missing = 0;
  for (const c of rule.conditions) {
    const v = value(c.indicator);
    observed[c.indicator] = v === null ? null : Math.round(v * 100) / 100;
    if (v === null) missing++;
    else if (test(c, v)) matched.push(c.indicator);
  }
  const hit = rule.combinator === 'all' ? matched.length === rule.conditions.length : matched.length > 0;
  return { hit, observed, matched, insufficient: !hit && missing > 0 };
}

/**
 * Evaluate a rule on a run's merchant-days and transactions. `incompleteDate`: a day the batch may not cover fully
 * (partial batch, last day): skipped and counted. Matches carry whether the same merchant-day is an AI alert, so the
 * two are linked rather than investigated twice.
 */
export function evaluate(rule: Pick<Rule, 'scope' | 'granularity' | 'conditions' | 'combinator' | 'persistence_days' | 'effective_from'>,
  days: DayRow[], tx: TxData | null, incompleteDate: string | null = null): Evaluation {
  const inScope = (merchant: string, category: string) => rule.scope.kind === 'network' || rule.scope.kind === 'channel'
    || (rule.scope.kind === 'merchant' && merchant === rule.scope.value) || (rule.scope.kind === 'category' && category === rule.scope.value);
  const ai = new Map(days.map((d) => [`${d.merchant_id}|${d.date}`, d.is_anomaly === 1]));
  const channel = rule.scope.kind === 'channel' ? rule.scope.value : undefined;
  let evaluated = 0, insufficient = 0, incomplete = 0;
  const matched: Match[] = [];
  if (rule.granularity === 'transaction') {
    for (let i = 0; tx && i < tx.ts.length; i++) {
      const date = tx.ts[i].slice(0, 10), merchant = tx.merchants[tx.merchant[i]], ch = CHANNEL_OF[tx.channel[i]] ?? tx.channel[i];
      if (date < rule.effective_from || !inScope(merchant, tx.category[i]) || (channel && ch !== channel)) continue;
      if (date === incompleteDate) { incomplete++; continue; }
      evaluated++;
      const r = combine(rule, (ind) => (ind === 'amount' ? tx.amount[i] : null));
      if (r.insufficient) insufficient++;
      if (r.hit) matched.push({ merchant, date, channel: ch, time: tx.ts[i], observed: r.observed, matched: r.matched, ai_alert: !!ai.get(`${merchant}|${date}`) });
    }
  } else {
    const runs = new Map<string, number>();   // consecutive matching days per merchant (persistence)
    for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date) || a.merchant_id.localeCompare(b.merchant_id))) {
      if (d.date < rule.effective_from || !inScope(d.merchant_id, d.category)) continue;
      if (d.date === incompleteDate) { incomplete++; continue; }
      evaluated++;
      const r = combine(rule, (ind) => dayValue(ind, d, channel));
      if (r.insufficient) insufficient++;
      const streak = r.hit ? (runs.get(d.merchant_id) ?? 0) + 1 : 0;
      runs.set(d.merchant_id, streak);
      if (r.hit && streak >= rule.persistence_days) matched.push({ merchant: d.merchant_id, date: d.date, ...(channel ? { channel } : {}), observed: r.observed, matched: r.matched, ai_alert: d.is_anomaly === 1 });
    }
  }
  const keys = new Set(matched.map((m) => `${m.merchant}|${m.date}`)), overlapKeys = new Set(matched.filter((m) => m.ai_alert).map((m) => `${m.merchant}|${m.date}`));
  return { evaluated, matched, insufficient, incomplete, merchants: [...new Set(matched.map((m) => m.merchant))].sort(),
    channels: [...new Set(matched.map((m) => m.channel).filter((c): c is string => !!c))].sort(),
    overlap: overlapKeys.size, additional: keys.size - overlapKeys.size, last: matched.reduce<string | null>((a, m) => (!a || m.date > a ? m.date : a), null) };
}
