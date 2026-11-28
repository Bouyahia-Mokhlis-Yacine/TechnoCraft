// Company rules storage (server only): runs/rules/rules.json holds the current version of every rule and
// runs/rules/history.jsonl every saved version and status change (append-only), for history and rollback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { text, validateDraft, type Rule, type Status } from './rules-core.ts';

/* ── storage: current versions + append-only revision log ──────────────── */

export class RuleError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const files = (dir: string) => ({ current: path.join(dir, 'rules.json'), log: path.join(dir, 'history.jsonl') });
export function listRules(dir: string): Rule[] {
  try { return (JSON.parse(fs.readFileSync(files(dir).current, 'utf8')) as { rules: Rule[] }).rules; } catch { return []; }
}
export function ruleHistory(dir: string, id: string): (Rule & { event: string })[] {
  try { return fs.readFileSync(files(dir).log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.id === id); } catch { return []; }
}
function write(dir: string, rules: Rule[], rule: Rule, event: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = files(dir), tmp = `${f.current}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f.current);
  fs.appendFileSync(f.log, `${JSON.stringify({ ...rule, event })}\n`, { mode: 0o600 });
}
const now = () => new Date().toISOString();

/** Create (no id) or edit a rule: every save is a new version; an edited active rule goes back to draft until re-activated. */
export function saveRule(dir: string, raw: unknown, actor: string, id?: string): Rule {
  const v = validateDraft(raw);
  if (!v.ok) throw new RuleError(422, v.errors.join(','));
  const rules = listRules(dir);
  const prior = id ? rules.find((r) => r.id === id) : undefined;
  if (id && !prior) throw new RuleError(404, 'rule_not_found');
  if (prior?.status === 'archived') throw new RuleError(409, 'archived');
  const at = now();
  const rule: Rule = prior
    ? { ...prior, ...v.draft, version: prior.version + 1, status: prior.status === 'active' ? 'draft' : prior.status, updated_by: actor, updated_at: at }
    : { id: `r${crypto.randomBytes(5).toString('hex')}`, version: 1, ...v.draft, status: 'draft', created_by: actor, created_at: at, updated_by: actor, updated_at: at };
  write(dir, prior ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule], rule, prior ? 'edit' : 'create');
  return rule;
}

/** Status changes. Activation needs a reason and the caller's confirmation (checked by the API). */
export function setStatus(dir: string, id: string, status: Status, actor: string, reason: string): Rule {
  const rules = listRules(dir), prior = rules.find((r) => r.id === id);
  if (!prior) throw new RuleError(404, 'rule_not_found');
  if (prior.status === 'archived' && status !== 'archived') throw new RuleError(409, 'archived');
  const why = text(reason, 300);
  if ((status === 'active' || status === 'archived') && !why) throw new RuleError(422, 'reason_required');
  const at = now();
  const rule: Rule = { ...prior, status, updated_by: actor, updated_at: at, reason: why || prior.reason,
    ...(status === 'active' ? { activated_by: actor, activated_at: at } : {}) };
  write(dir, rules.map((r) => (r.id === id ? rule : r)), rule, status);
  return rule;
}

/** Copy of a rule as a new draft. */
export function duplicateRule(dir: string, id: string, actor: string): Rule {
  const prior = listRules(dir).find((r) => r.id === id);
  if (!prior) throw new RuleError(404, 'rule_not_found');
  return saveRule(dir, { ...prior, name: `${prior.name} (copy)`.slice(0, 80) }, actor);
}

/** Bring back the content of an earlier version as a new version (as a draft: it must be activated again). */
export function rollbackRule(dir: string, id: string, version: number, actor: string, reason: string): Rule {
  const old = ruleHistory(dir, id).filter((r) => r.version === version).at(-1);
  if (!old) throw new RuleError(404, 'version_not_found');
  if (!text(reason, 300)) throw new RuleError(422, 'reason_required');
  const rules = listRules(dir), prior = rules.find((r) => r.id === id)!;
  if (prior.status === 'archived') throw new RuleError(409, 'archived');
  const at = now();
  const { event: _e, ...content } = old;
  void _e;
  const rule: Rule = { ...content, version: prior.version + 1, status: 'draft', created_by: prior.created_by, created_at: prior.created_at,
    updated_by: actor, updated_at: at, reason: text(reason, 300), activated_by: prior.activated_by, activated_at: prior.activated_at };
  write(dir, rules.map((r) => (r.id === id ? rule : r)), rule, `rollback:${version}`);
  return rule;
}
