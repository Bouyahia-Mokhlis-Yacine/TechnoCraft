// KPI formulas: named measures computed from the engine data, combined with + − × ÷ and
// parentheses. Parsed into a small tree and evaluated; no user text is ever run as code.
// Shared by the server (values) and the editor (live validation). No imports: tested with plain node.

export const MEASURES = {
  transactions: { label: 'Transactions', unit: 'int', help: 'All payment events in the period' },
  accepted: { label: 'Accepted', unit: 'int', help: 'Events with status Accepted' },
  declined: { label: 'Declined', unit: 'int', help: 'Events with status Declined' },
  cancelled: { label: 'Cancelled', unit: 'int', help: 'Events with status Cancelled' },
  refunded: { label: 'Refunded', unit: 'int', help: 'Events with status Refunded' },
  accepted_value: { label: 'Accepted value', unit: 'dzd', help: 'Sum of accepted amounts (DZD)' },
  attempted_value: { label: 'Attempted value', unit: 'dzd', help: 'Sum of all non-refund amounts (DZD)' },
  alerts: { label: 'Alerts', unit: 'int', help: 'Official engine alerts (flagged merchant-days)' },
  merchants_flagged: { label: 'Merchants with alerts', unit: 'int', help: 'Distinct merchants with at least one alert' },
  open_incidents: { label: 'Open incidents', unit: 'int', help: 'Incidents open now (no history: no trend or prior period)' },
  critical_incidents: { label: 'Critical incidents', unit: 'int', help: 'Open incidents of critical severity, now' },
  affected_transactions: { label: 'Affected transactions', unit: 'int', help: 'Estimated transaction shortfall of open incidents (engine impact model), now' },
  affected_value: { label: 'Gross affected activity', unit: 'dzd', help: 'Estimated gross payment activity affected by open incidents (DZD, engine impact model; not a confirmed loss), now' },
  days: { label: 'Days', unit: 'int', help: 'Number of days in the period (for daily averages)' },
} as const;
export type Measure = keyof typeof MEASURES;
export type Values = Partial<Record<Measure, number | null>>;

type Node = { k: 'num'; v: number } | { k: 'var'; name: Measure } | { k: 'neg'; a: Node } | { k: 'op'; op: '+' | '-' | '*' | '/'; a: Node; b: Node };
export type Parsed = { ok: true; tree: Node; uses: Measure[] } | { ok: false; error: string };

export const MAX_FORMULA = 200;

export function parse(src: string): Parsed {
  if (!src.trim()) return { ok: false, error: 'Write a formula, e.g. declined / transactions' };
  if (src.length > MAX_FORMULA) return { ok: false, error: `Keep formulas under ${MAX_FORMULA} characters` };
  const toks: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?|[a-z_][a-z0-9_]*|[-+*/()×÷])/gy;
  let m: RegExpExecArray | null, at = 0;
  while (at < src.length && (m = re.exec(src))) { toks.push(m[1] === '×' ? '*' : m[1] === '÷' ? '/' : m[1]); at = re.lastIndex; }
  if (src.slice(at).trim()) return { ok: false, error: `Unexpected “${src.slice(at).trim()[0]}”: use measure names, numbers, + − × ÷ and ( )` };
  const uses = new Set<Measure>();
  let i = 0;
  const fail = (msg: string): never => { throw new Error(msg); };
  const factor = (): Node => {
    const t = toks[i++];
    if (t === undefined) return fail('The formula ends too early');
    if (t === '-') return { k: 'neg', a: factor() };
    if (t === '(') { const e = expr(); if (toks[i++] !== ')') fail('A “(” is not closed'); return e; }
    if (/^\d/.test(t)) return { k: 'num', v: Number(t) };
    if (/^[a-z_]/.test(t)) {
      if (!(t in MEASURES)) fail(`Unknown measure “${t}”`);
      uses.add(t as Measure);
      return { k: 'var', name: t as Measure };
    }
    return fail(`Unexpected “${t}”`);
  };
  const term = (): Node => {
    let n = factor();
    while (toks[i] === '*' || toks[i] === '/') { const op = toks[i++] as '*' | '/'; n = { k: 'op', op, a: n, b: factor() }; }
    return n;
  };
  const expr = (): Node => {
    let n = term();
    while (toks[i] === '+' || toks[i] === '-') { const op = toks[i++] as '+' | '-'; n = { k: 'op', op, a: n, b: term() }; }
    return n;
  };
  try {
    const tree = expr();
    if (i < toks.length) fail(toks[i] === ')' ? 'A “)” has no matching “(”' : `Unexpected “${toks[i]}”`);
    return { ok: true, tree, uses: [...uses] };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** null when a measure is unavailable (e.g. no prior period) or a division by zero. */
export function evaluate(tree: Node, v: Values): number | null {
  switch (tree.k) {
    case 'num': return tree.v;
    case 'var': return v[tree.name] ?? null;
    case 'neg': { const a = evaluate(tree.a, v); return a === null ? null : -a; }
    case 'op': {
      const a = evaluate(tree.a, v), b = evaluate(tree.b, v);
      if (a === null || b === null) return null;
      if (tree.op === '/') return b === 0 ? null : a / b;
      return tree.op === '+' ? a + b : tree.op === '-' ? a - b : a * b;
    }
  }
}

/* ── KPI cards ───────────────────────────────────────────────────────── */
export const FORMATS = { int: 'Whole number', num: 'Decimal', dzd: 'Amount (DZD)', pct: 'Percent' } as const;
export const CHARTS = { number: 'Number only', line: 'Line', area: 'Area', bars: 'Bars' } as const;
export const GOOD = { up: 'Up is good', down: 'Down is good', none: 'Neutral' } as const;
export interface KpiCard { id: string; label: string; formula: string; format: keyof typeof FORMATS; chart: keyof typeof CHARTS; good: keyof typeof GOOD }
export const MAX_KPIS = 12;

/** One-click cards for the editor: the indicators the network dashboard is expected to offer. */
export const SUGGESTED_KPIS: Omit<KpiCard, 'id'>[] = [
  { label: 'Acceptance rate', formula: 'accepted / transactions', format: 'pct', chart: 'line', good: 'up' },
  { label: 'Rejection rate', formula: 'declined / transactions', format: 'pct', chart: 'line', good: 'down' },
  { label: 'Cancellation rate', formula: 'cancelled / transactions', format: 'pct', chart: 'line', good: 'down' },
  { label: 'Refund rate', formula: 'refunded / transactions', format: 'pct', chart: 'line', good: 'down' },
  { label: 'Official anomalies', formula: 'alerts', format: 'int', chart: 'bars', good: 'down' },
  { label: 'Critical incidents', formula: 'critical_incidents', format: 'int', chart: 'number', good: 'down' },
  { label: 'Gross affected activity', formula: 'affected_value', format: 'dzd', chart: 'number', good: 'down' },
  { label: 'Average ticket', formula: 'accepted_value / accepted', format: 'dzd', chart: 'line', good: 'none' },
  { label: 'Transactions per day', formula: 'transactions / days', format: 'num', chart: 'line', good: 'up' },
];

export const DEFAULT_KPIS: KpiCard[] = [
  { id: 'transactions', label: 'Transactions', formula: 'transactions', format: 'int', chart: 'number', good: 'up' },
  { id: 'accepted-value', label: 'Accepted value', formula: 'accepted_value', format: 'dzd', chart: 'number', good: 'up' },
  { id: 'attempted-value', label: 'Attempted value', formula: 'attempted_value', format: 'dzd', chart: 'number', good: 'up' },
  { id: 'decline-rate', label: 'Decline rate', formula: 'declined / transactions', format: 'pct', chart: 'number', good: 'down' },
  { id: 'merchants-flagged', label: 'Merchants with alerts', formula: 'merchants_flagged', format: 'int', chart: 'number', good: 'down' },
  { id: 'open-incidents', label: 'Open incidents', formula: 'open_incidents', format: 'int', chart: 'number', good: 'down' },
];

/** Validate cards sent by a client: the trust boundary for saved dashboards. */
export function checkKpis(raw: unknown): { ok: true; kpis: KpiCard[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_KPIS) return { ok: false, error: `Keep between 1 and ${MAX_KPIS} KPIs.` };
  const out: KpiCard[] = [], ids = new Set<string>();
  for (const c of raw as Record<string, unknown>[]) {
    const label = typeof c?.label === 'string' ? c.label.trim().slice(0, 40) : '';
    const formula = typeof c?.formula === 'string' ? c.formula.trim() : '';
    const id = typeof c?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(c.id) ? c.id : '';
    if (!label || !id || ids.has(id)) return { ok: false, error: 'Every KPI needs a name.' };
    const p = parse(formula);
    if (!p.ok) return { ok: false, error: `${label}: ${p.error}` };
    if (!((c.format as string) in FORMATS) || !((c.chart as string) in CHARTS) || !((c.good as string) in GOOD)) return { ok: false, error: `${label}: invalid option.` };
    ids.add(id);
    out.push({ id, label, formula, format: c.format as KpiCard['format'], chart: c.chart as KpiCard['chart'], good: c.good as KpiCard['good'] });
  }
  return { ok: true, kpis: out };
}
