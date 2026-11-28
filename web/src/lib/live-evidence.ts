import 'server-only';
// Headline figures of the live-monitoring study, read from its published evaluation files
// (reports/live_monitoring/), so the workspace never states a number the study did not produce.
import fs from 'node:fs';
import path from 'node:path';

export interface LiveEvidence { detected: number; applicable: number; medianDelay: number | null; notifications: number; days: number }
const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), '..', 'reports', 'live_monitoring');
let cached: LiveEvidence | null | undefined;

export function liveEvidence(): LiveEvidence | null {
  if (cached !== undefined) return cached;
  try {
    const [head, ...lines] = fs.readFileSync(path.join(DIR, 'synthetic_cases.csv'), 'utf8').trim().split(/\r?\n/);
    const col = Object.fromEntries(head.split(',').map((c, i) => [c, i]));
    // the active policy is the "selected" method; its cases have no quoted commas
    const rows = lines.map((l) => l.split(',')).filter((r) => r[col.method] === 'selected' && r[col.applicable] === 'True');
    const delays = rows.filter((r) => r[col.hit] === 'True' && r[col.delay]).map((r) => Number(r[col.delay])).sort((a, b) => a - b);
    const mid = delays.length ? (delays[(delays.length - 1) >> 1] + delays[delays.length >> 1]) / 2 : null;
    const load = JSON.parse(fs.readFileSync(path.join(DIR, 'ordinary_workload.json'), 'utf8')).selected_lifecycle;
    cached = { detected: rows.filter((r) => r[col.hit] === 'True').length, applicable: rows.length, medianDelay: mid, notifications: load.all_notifications, days: load.days };
  } catch { cached = null; }
  return cached;
}
