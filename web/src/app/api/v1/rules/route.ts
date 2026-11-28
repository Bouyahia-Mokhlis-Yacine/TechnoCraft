// GET /api/v1/rules[?id=] → the rules (and one rule's revision history). Needs the Custom rules page.
// POST /api/v1/rules { op, … } → save | duplicate | status | rollback | preview. Needs the "rules" action
// (the administrator always has it); activation needs a reason and an explicit confirmation. Every change is
// recorded in the audit ledger. A preview reads a run and changes nothing.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { appendEvent } from '@/lib/reviews';
import { isRunId } from '@/lib/imports';
import { validateDraft, type Status } from '@/lib/rules-core';
import { duplicateRule, listRules, rollbackRule, RuleError, ruleHistory, saveRule, setStatus } from '@/lib/rules-store';
import { evaluateOn, rulesDir } from '@/lib/rules';

export async function GET(req: NextRequest) {
  if (!userOf(req)) return fail(401, 'unauthenticated', 'Sign in first.');
  const id = req.nextUrl.searchParams.get('id');
  return Response.json({ rules: listRules(rulesDir()), history: id ? ruleHistory(rulesDir(), id) : undefined });
}

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'rules')) return fail(403, 'forbidden', 'Your account cannot change company rules.');
  let b: { op?: unknown; id?: unknown; rule?: unknown; status?: unknown; reason?: unknown; version?: unknown; confirm?: unknown; run?: unknown };
  try { b = await req.json(); } catch { return fail(400, 'invalid_json', 'Body must be JSON.'); }
  const dir = rulesDir(), id = typeof b.id === 'string' ? b.id : undefined, reason = typeof b.reason === 'string' ? b.reason : '';
  const audit = (target: string, what: string) => appendEvent({ actor: user.id, action: 'rule', target: `rule:${target}`, run_id: 'rules', reason: `${what}${reason ? ` · ${reason}` : ''}`, prior: 'new', next: 'new', escalated: false, version: 0 });
  try {
    if (b.op === 'preview') {
      const v = validateDraft(b.rule);
      if (!v.ok) return fail(422, 'invalid_rule', v.errors.join(','));
      const run = b.run === 'archive' || b.run === null || b.run === undefined ? null : typeof b.run === 'string' && isRunId(b.run) ? b.run : undefined;
      if (run === undefined) return fail(422, 'invalid_run', 'Choose an analysed dataset.');
      // a preview tests the conditions on past data: the effective date only applies once the rule is active
      const r = evaluateOn({ ...v.draft, effective_from: '0000-01-01' }, run);
      return Response.json({ ...r, matched: undefined, matches: r.matched.length, sample: r.matched.slice(0, 12) });
    }
    if (b.op === 'save') { const r = saveRule(dir, b.rule, user.id, id); audit(r.id, `save v${r.version}`); return Response.json({ rule: r }); }
    if (b.op === 'duplicate' && id) { const r = duplicateRule(dir, id, user.id); audit(r.id, `duplicate of ${id}`); return Response.json({ rule: r }); }
    if (b.op === 'status' && id && ['active', 'disabled', 'archived'].includes(String(b.status))) {
      if (b.status === 'active' && b.confirm !== true) return fail(422, 'confirm_required', 'Confirm the activation.');
      const r = setStatus(dir, id, b.status as Status, user.id, reason); audit(id, `${b.status} v${r.version}`); return Response.json({ rule: r });
    }
    if (b.op === 'rollback' && id && typeof b.version === 'number') { const r = rollbackRule(dir, id, b.version, user.id, reason); audit(id, `rollback to v${b.version} as v${r.version}`); return Response.json({ rule: r }); }
    return fail(422, 'invalid_payload', 'Unknown operation.');
  } catch (e) {
    if (e instanceof RuleError) return fail(e.status, e.message.split(',')[0], e.message);
    throw e;
  }
}
