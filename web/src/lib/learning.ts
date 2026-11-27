import 'server-only';
// Continuous learning: the web side of src/continuous_learning.LearningService, reached through
// engine/learning_bridge.py. The server passes only the signed-in account id; the bridge re-reads the
// account store and maps it to reviewer or supervisor itself. Long jobs (fitting, baseline packaging) run in
// a detached process; their state is read back through learning_job_status / model_registry.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env, python, ROOT } from './imports';
import { runsDir } from './snapshot';

export type LearningResult = { ok: unknown } | { error: { status: number; code: string; message: string } };
export const READ = ['review_queue', 'feedback_history', 'feedback_statistics', 'training_eligibility', 'drift_report',
  'operational_predictions', 'forecast', 'learning_job_status', 'model_comparison', 'model_registry'] as const;
export const WRITE = ['submit_feedback', 'decide_feedback', 'initialize_baseline', 'start_learning_job', 'run_learning_job',
  'cancel_learning_job', 'shadow_batch', 'decide_model', 'rollback'] as const;
const BACKGROUND = new Set(['run_learning_job', 'initialize_baseline']);

export function learning(actor: string, method: string, args: Record<string, unknown>): Promise<LearningResult> {
  const input = JSON.stringify({ actor, method, args });
  if (BACKGROUND.has(method)) {
    const logDir = path.join(/*turbopackIgnore: true*/ runsDir(), 'continuous_learning');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(logDir, 'worker.log'), 'a', 0o600);
    const child = spawn(python(), ['-m', 'engine.learning_bridge'], { cwd: ROOT, env: env(), detached: true, stdio: ['pipe', log, log] });
    child.stdin?.end(input);
    child.unref();
    return Promise.resolve({ ok: { started: method } });
  }
  return new Promise((resolve) => {
    const child = execFile(python(), ['-m', 'engine.learning_bridge'], { cwd: ROOT, env: env(), timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        try { resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '')); }
        catch { resolve({ error: { status: 500, code: 'learning_failed', message: err ? 'The learning service failed.' : 'Unreadable learning response.' } }); }
      });
    child.stdin?.end(input);
  });
}

/** Dates scored by the operational model (from the ledger), newest first, for the review queue picker. */
export function scoredDates(): string[] {
  const dir = path.join(/*turbopackIgnore: true*/ runsDir(), 'imports');
  const dates = new Set<string>();
  try {
    for (const id of fs.readdirSync(dir)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, id, 'status.json'), 'utf8'));
        if (s.result?.learning?.state === 'scored' && s.result.first_date) {
          for (let d = new Date(`${s.result.first_date}T00:00:00Z`); d.toISOString().slice(0, 10) <= s.result.last_date; d.setUTCDate(d.getUTCDate() + 1)) dates.add(d.toISOString().slice(0, 10));
        }
      } catch { /* not a run */ }
    }
  } catch { /* no imports yet */ }
  return [...dates].sort().reverse();
}
