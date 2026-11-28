// Self-check for the platform guide: node src/lib/ui-guide.test.ts
import assert from 'node:assert/strict';
import { dropStepNumbers, guideAnswer, guidePage, guideResult } from './ui-guide.ts';

// step numbers of a list are not figures; a lone count at the end of a sentence stays
assert.equal(dropStepNumbers('1. Click Import 2. Choose a file 3. Apply'), ' Click Import  Choose a file  Apply');
assert.equal(dropStepNumbers('MER-6434 had 4. Others had fewer.'), 'MER-6434 had 4. Others had fewer.');
assert.equal(dropStepNumbers('Decline rate 2.9 % and 1. Then'), 'Decline rate 2.9 % and 1. Then');

assert.equal(guidePage('/')?.key, 'overview');
assert.equal(guidePage('/incidents/INC-6434-1111')?.key, 'incident');
assert.equal(guidePage('/alerts?severity=high')?.key, 'alerts');
assert.equal(guidePage('/nowhere'), null);

// a selected control is found by its on-screen name, in French too
const ack = guideAnswer('What does this do?', [{ kind: 'control', label: 'Control: Acknowledge', control: { role: 'button', name: 'Acknowledge' } }], '/incidents/INC-1', 'en');
assert.match(ack!.text[0], /^Acknowledge: Marks a new incident as seen/);
const kpi = guideAnswer('', [{ kind: 'control', label: 'Commande : Personnaliser les indicateurs', control: { role: 'button', name: 'Personnaliser les indicateurs' } }], '/', 'fr');
assert.match(kpi!.text[0], /KPI editor/);

// how-to questions reach the right task
assert.match(guideAnswer('How do I import new transactions?', [], '/data', 'en')!.text[0], /^Import new transactions/);
assert.match(guideAnswer('How do I review an incident?', [], '/incidents/INC-1', 'en')!.text[0], /^Review an incident/);
assert.match(guideAnswer('Where can I see which dataset I am looking at?', [], '/', 'en')!.text[0], /dataset/i);

// the tool: no arguments = current page + list of pages; a link only to another page
const here = guideResult('{}', '/merchants', 'en');
assert.equal((here.result as { current_page: { page: string } }).current_page.page, 'Merchants');
assert.deepEqual(guideResult('{"page":"data"}', '/', 'en').display?.evidence, [{ label: 'Open Data & runs', href: '/data' }]);
console.log('ui-guide: all checks passed');
