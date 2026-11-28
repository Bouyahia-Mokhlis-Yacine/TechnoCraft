// Self-check for company rules: node src/lib/rules.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, idleHours, validateDraft, type DayRow, type TxData } from './rules-core.ts';
import { duplicateRule, listRules, rollbackRule, ruleHistory, saveRule, setStatus } from './rules-store.ts';

const hours = (on: number[]) => Array.from({ length: 24 }, (_, h) => (on.includes(h) ? 3 : 0));
const day = (o: Partial<DayRow>): DayRow => ({ merchant_id: 'MER-1', date: '2027-03-01', category: 'Retail', n: 40, n_dec: 2, n_can: 0, value: 50000, ticket: 1200,
  expected_n: 40, warming_up: false, hours: hours([9, 10, 11, 12]), channels: { pos: [30, 1], nfc: [10, 1] }, is_anomaly: 0, ...o });
const base = { scope: { kind: 'network' as const }, granularity: 'merchant_day' as const, combinator: 'all' as const, persistence_days: 1, effective_from: '2000-01-01' };

// validation: whitelisted indicators and operators only, granularity and scope consistency
assert.equal(validateDraft({}).ok, false);
const bad = validateDraft({ name: 'x', granularity: 'merchant_day', scope: { kind: 'channel', value: 'pos' }, conditions: [{ indicator: 'accepted_value', op: 'gt', value: 1 }, { indicator: 'eval("x")', op: 'gt', value: 1 }], severity: 'high', action: 'alert', effective_from: '2027-01-01' });
assert.equal(bad.ok, false);
assert.deepEqual(!bad.ok && bad.errors, ['condition_1_channel_scope', 'condition_2_indicator']);
assert.equal(validateDraft({ name: 'x', granularity: 'transaction', scope: { kind: 'network' }, conditions: [{ indicator: 'decline_rate', op: 'gt', value: 1 }], severity: 'high', action: 'alert', effective_from: '2027-01-01' }).ok, false);
assert.equal(validateDraft({ name: 'x', granularity: 'merchant_day', scope: { kind: 'network' }, conditions: [{ indicator: 'transactions', op: 'between', value: 5, value2: 1 }], severity: 'low', action: 'evidence', effective_from: '2027-01-01' }).ok, false);

// AND / OR: rejection rate over 20 % with at least 10 attempts
const days = [day({ merchant_id: 'MER-1', n: 50, n_dec: 15 }), day({ merchant_id: 'MER-2', n: 5, n_dec: 3 }), day({ merchant_id: 'MER-3', n: 50, n_dec: 2 })];
const conds = [{ indicator: 'decline_rate', op: 'gt' as const, value: 20 }, { indicator: 'transactions', op: 'gte' as const, value: 10 }];
assert.deepEqual(evaluate({ ...base, conditions: conds }, days, null).matched.map((m) => m.merchant), ['MER-1']);
assert.deepEqual(evaluate({ ...base, combinator: 'any', conditions: conds }, days, null).matched.map((m) => m.merchant), ['MER-1', 'MER-2', 'MER-3']);

// merchant and channel scope (channel-split counts)
assert.deepEqual(evaluate({ ...base, scope: { kind: 'merchant', value: 'MER-2' }, conditions: [conds[0]] }, days, null).matched.map((m) => m.merchant), ['MER-2']);
const nfc = evaluate({ ...base, scope: { kind: 'channel', value: 'nfc' }, conditions: [{ indicator: 'decline_rate', op: 'gte', value: 10 }] }, [day({ channels: { nfc: [10, 1], pos: [30, 0] } })], null);
assert.equal(nfc.matched.length, 1); assert.equal(nfc.matched[0].observed.decline_rate, 10);

// missing values and zero denominators never match; they count as insufficient data
const zero = evaluate({ ...base, conditions: [{ indicator: 'decline_rate', op: 'gt', value: 20 }] }, [day({ n: 0, n_dec: 0 })], null);
assert.equal(zero.matched.length, 0); assert.equal(zero.insufficient, 1);
const noRef = evaluate({ ...base, conditions: [{ indicator: 'activity_vs_expected', op: 'lt', value: -50 }] }, [day({ warming_up: true }), day({ merchant_id: 'MER-9', n: 10, expected_n: 40 })], null);
assert.deepEqual(noRef.matched.map((m) => m.merchant), ['MER-9']); assert.equal(noRef.insufficient, 1);

// incomplete observation window (last day of a partial batch) is skipped and counted
const inc = evaluate({ ...base, conditions: [{ indicator: 'transactions', op: 'gte', value: 0 }] }, [day({}), day({ date: '2027-03-02' })], null, '2027-03-02');
assert.equal(inc.evaluated, 1); assert.equal(inc.incomplete, 1);

// persistence: two consecutive matching days
const streak = [day({ date: '2027-03-01', n: 5 }), day({ date: '2027-03-02', n: 5 }), day({ date: '2027-03-03', n: 50 })];
assert.deepEqual(evaluate({ ...base, persistence_days: 2, conditions: [{ indicator: 'transactions', op: 'lt', value: 10 }] }, streak, null).matched.map((m) => m.date), ['2027-03-02']);

// intraday gap (hour resolution) and a day without transactions
assert.equal(idleHours(hours([8, 9, 12, 13])), 2); assert.equal(idleHours(hours([])), 24);

// transaction rule: contactless above 2,500 DZD; overlap with AI alerts is linked, not duplicated
const tx: TxData = { merchants: ['MER-1', 'MER-2'], ts: ['2027-03-01 10:00:00', '2027-03-01 11:00:00', '2027-03-01 12:00:00'], merchant: [0, 0, 1], category: ['Retail', 'Retail', 'Retail'],
  channel: ['Contactless / NFC', 'TPE / POS Terminal', 'Contactless / NFC'], status: ['Accepted', 'Accepted', 'Accepted'], amount: [3000, 9000, null] };
const ct = evaluate({ ...base, granularity: 'transaction', scope: { kind: 'channel', value: 'nfc' }, conditions: [{ indicator: 'amount', op: 'gt', value: 2500 }] }, [day({ is_anomaly: 1 })], tx);
assert.equal(ct.evaluated, 2); assert.equal(ct.matched.length, 1); assert.equal(ct.insufficient, 1); assert.equal(ct.matched[0].ai_alert, true); assert.equal(ct.overlap, 1); assert.equal(ct.additional, 0);

// storage: versions, activation reason, duplicate, rollback, archive
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
const draft = { name: 'Contactless limit', granularity: 'transaction', scope: { kind: 'channel', value: 'nfc' }, conditions: [{ indicator: 'amount', op: 'gt', value: 2500 }], severity: 'medium', action: 'evidence', effective_from: '2026-01-01' };
const r1 = saveRule(dir, draft, 'admin');
assert.equal(r1.version, 1); assert.equal(r1.status, 'draft');
assert.throws(() => setStatus(dir, r1.id, 'active', 'admin', ''), /reason_required/);
assert.equal(setStatus(dir, r1.id, 'active', 'admin', 'Card scheme limit').status, 'active');
const r2 = saveRule(dir, { ...draft, conditions: [{ indicator: 'amount', op: 'gt', value: 3000 }] }, 'admin', r1.id);
assert.equal(r2.version, 2); assert.equal(r2.status, 'draft');   // an edited active rule must be activated again
const r3 = rollbackRule(dir, r1.id, 1, 'admin', 'Back to the scheme limit');
assert.equal(r3.version, 3); assert.equal(r3.conditions[0].value, 2500); assert.equal(r3.status, 'draft');
assert.equal(ruleHistory(dir, r1.id).length, 4);
assert.equal(duplicateRule(dir, r1.id, 'admin').name, 'Contactless limit (copy)');
assert.equal(setStatus(dir, r1.id, 'archived', 'admin', 'Replaced').status, 'archived');
assert.throws(() => saveRule(dir, draft, 'admin', r1.id), /archived/);
assert.equal(listRules(dir).length, 2);
fs.rmSync(dir, { recursive: true, force: true });
console.log('rules: all checks passed');
