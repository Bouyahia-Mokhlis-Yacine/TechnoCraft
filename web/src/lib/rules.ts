// Company rules on the server: storage under runs/rules/ and evaluation on a run's snapshot (read only).
// Active rules apply to operational runs (imported or combined collections); the archive run, which is the
// competition submission, is only ever read for a preview and never changed.
import path from 'node:path';
import { runsDir, snapshot } from './snapshot';
import { evaluate, type DayRow, type Evaluation, type Rule, type TxData } from './rules-core';
import { listRules } from './rules-store';

export const rulesDir = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'rules');

/** A run's merchant-days and transactions as the evaluator reads them; the last day of a partial batch is incomplete. */
function data(run: string | null) {
  const s = snapshot(run);
  return { days: s.merchant_days as unknown as DayRow[], tx: s.transactions as TxData, incomplete: s.run.batch_status === 'complete' ? null : s.run.as_of };
}
export function evaluateOn(rule: Pick<Rule, 'scope' | 'granularity' | 'conditions' | 'combinator' | 'persistence_days' | 'effective_from'>, run: string | null): Evaluation {
  const d = data(run);
  return evaluate(rule, d.days, d.tx, d.incomplete);
}

/** The active rules' results on an operational run (none on the archive run). */
export function activeResults(run: string | null): { rule: Rule; result: Evaluation }[] {
  if (!run) return [];
  return listRules(rulesDir()).filter((r) => r.status === 'active').map((rule) => ({ rule, result: evaluateOn(rule, run) }));
}
