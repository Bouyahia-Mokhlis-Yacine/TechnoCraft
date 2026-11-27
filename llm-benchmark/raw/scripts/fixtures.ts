// Builds tool outputs from the real assistant functions, keyed by tool|merchant|period|channel.
import fs from 'node:fs';
import { answer } from './assistant.ts';
import { model } from './model.ts';
const m = model();
const third = [...new Set(m.anomalies.map((a) => a.merchant))].filter((x) => x !== 'MER-6434' && x !== 'MER-1494').at(-1)!;
const MERCH = ['MER-6434', 'MER-1494', third];
const PERIODS: Record<string, string> = { today: 'today', yesterday: 'yesterday', this_week: 'this week', last_week: 'last week', last_30_days: 'this month' };
const CH: Record<string, string> = { ecommerce: 'e-commerce', pos: 'POS', mobile: 'mobile app', nfc: 'contactless', transfer: 'bank transfer' };
const Q: Record<string, (a: any) => string> = {
  network_summary: (a) => `Network summary for ${PERIODS[a.period ?? 'this_week']}${a.channel ? ' on ' + CH[a.channel] : ''}${a.merchant ? ' for ' + a.merchant : ''}`,
  explain_merchant: (a) => `Why was ${a.merchant} flagged?`,
  merchant_health: (a) => `health of ${a.merchant}`,
  open_incidents: (a) => `Show unresolved incidents and exposure${a.merchant ? ' for ' + a.merchant : ''}`,
  forecast: (a) => `Forecast for the next 7 days${a.merchant ? ' for ' + a.merchant : ''}`,
  channel_activity: (a) => `Which channels show concurrent abnormal behaviour ${PERIODS[a.period ?? 'this_week']}${a.channel ? ' on ' + CH[a.channel] : ''}`,
  top_declines: (a) => `Which merchants have the most declines ${PERIODS[a.period ?? 'this_week']}`,
  activity_shortfall: (a) => `Which merchants had the largest activity shortfall ${PERIODS[a.period ?? 'this_week']}`,
  next_checks: (a) => `What should I check first${a.merchant ? ' for ' + a.merchant : ''}`,
};
const out: Record<string, unknown> = {};
const key = (t: string, a: any) => [t, a.merchant ?? '', a.period ?? '', a.channel ?? ''].join('|');
const add = (t: string, a: any) => { const r = answer(Q[t](a)); out[key(t, a)] = { text: r.text, table: r.table, scope: r.scope, evidence: r.evidence.map((e) => e.label), intent: r.intent }; };
for (const t of Object.keys(Q)) {
  const merchantTool = ['explain_merchant', 'merchant_health'].includes(t);
  if (merchantTool) { MERCH.forEach((x) => add(t, { merchant: x })); continue; }
  add(t, {});
  if (['open_incidents', 'forecast', 'next_checks', 'network_summary'].includes(t)) MERCH.forEach((x) => add(t, { merchant: x }));
  if (['network_summary', 'channel_activity', 'top_declines', 'activity_shortfall'].includes(t)) for (const p of Object.keys(PERIODS)) {
    add(t, { period: p });
    if (['network_summary', 'channel_activity'].includes(t)) for (const c of Object.keys(CH)) add(t, { period: p, channel: c });
  }
  if (t === 'channel_activity') for (const c of Object.keys(CH)) add(t, { channel: c });
}
fs.writeFileSync(process.argv[2], JSON.stringify({ merchants: MERCH, as_of: m.snap.run.as_of, run: m.snap.run.run_id, fixtures: out }));
console.log(Object.keys(out).length, 'fixtures; merchants', MERCH);
console.log(JSON.stringify(out['open_incidents||||']));
