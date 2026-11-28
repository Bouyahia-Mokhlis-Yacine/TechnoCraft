// Self-check for the KPI formula parser: node src/lib/formula.test.ts
import assert from 'node:assert/strict';
import { checkKpis, DEFAULT_KPIS, SUGGESTED_KPIS, evaluate, parse } from './formula.ts';

const v = { transactions: 200, declined: 10, accepted_value: 5000, days: 4, alerts: 0 };
const run = (f: string) => { const p = parse(f); assert.ok(p.ok, f); return evaluate(p.tree, v); };

assert.equal(run('declined / transactions'), 0.05);
assert.equal(run('declined / transactions * 100'), 5);           // left to right
assert.equal(run('transactions - declined * 2'), 180);           // precedence
assert.equal(run('(transactions - declined) * 2'), 380);
assert.equal(run('-declined + 3'), -7);
assert.equal(run('accepted_value ÷ days'), 1250);                // typed symbols
assert.equal(run('declined / alerts'), null);                    // division by zero
assert.equal(run('cancelled + 1'), null);                        // measure missing
for (const bad of ['', 'transactions +', '(declined', 'declined)', 'foo / 2', 'process.exit()', 'declined; 1', 'a'.repeat(300)]) assert.equal(parse(bad).ok, false, bad);
const u = parse('declined / transactions');
assert.deepEqual(u.ok ? u.uses : null, ['declined', 'transactions']);

assert.equal(parse('accepted_value + transactions').ok, false);                  // DZD + count
assert.equal(parse('accepted_value - affected_value').ok, true);                   // DZD - DZD
assert.equal(parse('accepted_value / accepted + 5').ok, true);                     // DZD per event + constant
assert.equal(parse('declined / transactions + accepted_value / attempted_value').ok, true);   // ratio + ratio
const mix = parse('open_incidents / merchants_flagged');
assert.ok(mix.ok && mix.mixesNow);                                                 // "now" state with a period measure
const pure = parse('critical_incidents / open_incidents');
assert.ok(pure.ok && !pure.mixesNow);

assert.ok(checkKpis(DEFAULT_KPIS).ok);
for (const [i, k] of SUGGESTED_KPIS.entries()) assert.ok(checkKpis([{ ...k, id: `s-${i}` }]).ok, k.formula);   // every suggestion is a valid formula
assert.equal(checkKpis([]).ok, false);
assert.equal(checkKpis([{ ...DEFAULT_KPIS[0], formula: 'oops(' }]).ok, false);
assert.equal(checkKpis([{ ...DEFAULT_KPIS[0], chart: 'pie3d' }]).ok, false);
assert.equal(checkKpis([DEFAULT_KPIS[0], DEFAULT_KPIS[0]]).ok, false);   // duplicate id
console.log('formula: all checks passed');
