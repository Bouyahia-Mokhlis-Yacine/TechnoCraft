import 'server-only';
// Forecast vintages: every published run's 7-day forecast (from the compound frequency–outcome–severity
// engine), kept as an immutable record with its creation time, origin, targets, model and reference
// versions and predictive intervals. A vintage is compared only with observations that arrived later,
// in complete imported batches; nothing is ever forecast retrospectively. MAE and empirical interval
// coverage are plain counting over those pairs.
import fs from 'node:fs';
import path from 'node:path';
import { runsDir, snapshot } from './snapshot';
import { listImports } from './imports';

type Interval = { mean: number; intervals: Record<'80' | '90' | '95', [number, number]> };
type Metrics = Partial<Record<'transactions' | 'accepted_value' | 'rejections', Interval>>;
export interface Vintage {
  id: string; source: 'official' | 'import'; source_run: string; created_at: string; recorded_at: string;
  origin: string; last_reference_date: string; model: string; model_version: string; reference_version: string;
  targets: { date: string; horizon: number; merchants: Record<string, Metrics> }[];
}
const METRICS = ['transactions', 'accepted_value', 'rejections'] as const;
const dir = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'forecast-vintages');
const file = (id: string) => path.join(dir(), `${id}.json`);

/** Record a run's forecast once; an existing vintage is never rewritten. */
function record(run: string | null): Vintage | null {
  const snap = snapshot(run), r = snap.run, d = snap.forecast?.detail as { days?: { date: string; horizon: number; merchants?: Record<string, Metrics> }[]; model?: string; origin?: string } | undefined;
  if (!d?.days?.length || !d.origin) return null;
  const v: Vintage = {
    id: r.run_id, source: run ? 'import' : 'official', source_run: r.run_id, created_at: r.generated_at, recorded_at: new Date().toISOString(),
    origin: d.origin, last_reference_date: snap.forecast.last_reference_date, model: d.model ?? snap.forecast.method,
    model_version: r.models?.v2 ?? r.policy.version, reference_version: r.reference_version,
    targets: d.days.map((x) => ({ date: x.date, horizon: x.horizon, merchants: x.merchants ?? {} })),
  };
  fs.mkdirSync(dir(), { recursive: true });
  try { fs.writeFileSync(file(v.id), JSON.stringify(v), { flag: 'wx', mode: 0o600 }); } catch { /* already recorded: keep the first */ }
  return JSON.parse(fs.readFileSync(file(v.id), 'utf8'));
}

/** All vintages: the official run's and every succeeded import's (recorded on first sight, then immutable). */
export function vintages(): Vintage[] {
  const out = new Map<string, Vintage>();
  const read = (id: string) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')) as Vintage; } catch { return null; } };
  const official = snapshot(null).run.run_id;
  out.set(official, read(official) ?? record(null)!);
  for (const s of listImports()) if (s.kind === 'import' && s.state === 'succeeded') {
    try { const v = read(s.run_id) ?? record(s.run_id); if (v) out.set(v.id, v); } catch { /* snapshot unavailable */ }
  }
  return [...out.values()].filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export interface Pair { merchant: string; date: string; horizon: number; metric: typeof METRICS[number]; forecast: number; lo80: number; hi80: number; lo90: number; hi90: number; actual: number; run: string }
export interface Evaluation { vintage: Vintage; pairs: Pair[]; summary: Record<string, { n: number; mae: number | null; cover80: number | null; cover90: number | null }> }

/** Later, complete observations for each vintage target (the latest such run wins for a merchant-day). */
export function evaluate(v: Vintage): Evaluation {
  const actual = new Map<string, { n: number; value: number | null; dec: number; run: string; at: string }>();
  for (const s of listImports()) {
    if (s.kind !== 'import' || s.state !== 'succeeded') continue;
    let snap; try { snap = snapshot(s.run_id); } catch { continue; }
    // only observations recorded after the forecast, from complete batches (absent days of a partial batch are unknown)
    if (snap.run.generated_at <= v.created_at || snap.run.batch_status !== 'complete') continue;
    for (const d of snap.merchant_days) {
      const k = `${d.merchant_id}|${d.date}`, prev = actual.get(k);
      if (!prev || prev.at < snap.run.generated_at) actual.set(k, { n: d.n, value: d.value, dec: d.n_dec, run: s.run_id, at: snap.run.generated_at });
    }
  }
  const pairs: Pair[] = [];
  for (const t of v.targets) for (const [m, metrics] of Object.entries(t.merchants)) {
    const a = actual.get(`${m}|${t.date}`);
    if (!a) continue;
    for (const metric of METRICS) {
      const f = metrics[metric], y = metric === 'transactions' ? a.n : metric === 'rejections' ? a.dec : a.value;
      if (!f || y === null || y === undefined) continue;   // an unknown accepted value is left out, never zero
      pairs.push({ merchant: m, date: t.date, horizon: t.horizon, metric, forecast: f.mean, lo80: f.intervals['80'][0], hi80: f.intervals['80'][1],
        lo90: f.intervals['90'][0], hi90: f.intervals['90'][1], actual: y, run: a.run });
    }
  }
  const summary = Object.fromEntries(METRICS.map((metric) => {
    const p = pairs.filter((x) => x.metric === metric), n = p.length;
    return [metric, { n, mae: n ? p.reduce((s, x) => s + Math.abs(x.actual - x.forecast), 0) / n : null,
      cover80: n ? p.filter((x) => x.actual >= x.lo80 && x.actual <= x.hi80).length / n : null,
      cover90: n ? p.filter((x) => x.actual >= x.lo90 && x.actual <= x.hi90).length / n : null }];
  }));
  return { vintage: v, pairs, summary };
}
