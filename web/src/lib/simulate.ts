// Deterministic scenario arithmetic on the exported forecast and historical channel mix.
import { intlLocale, type Locale } from './format';
type Merchant = { id: string; category: string; expected: number[]; share: Record<string, number[]>[];
  valuePerEvent: (number | null)[]; rejectionRate: (number | null)[] };
export type Baseline = { asOf: string; from: string; channels: string[]; categories: string[]; merchants: Merchant[] };
export type Curve = { threshold: number; tp: number; fp: number; fn: number; flagged: number }[];

export const fmt = (v: number, d = 0, l?: Locale) => new Intl.NumberFormat(intlLocale(l), { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
export const dzd = (v: number, l?: Locale) => (v >= 1e6 ? `${fmt(v / 1e6, 1, l)}\u00a0M\u00a0DZD` : v >= 1e4 ? `${fmt(v / 1e3, 0, l)}\u00a0k\u00a0DZD` : `${fmt(v, 0, l)}\u00a0DZD`);


export interface Scenario {
  mode: 'outage' | 'declines'; channel: string; category: string; weekend: number; start: number;
  hours: number; rate: number; activity?: number; amount?: number; days?: number;
}
export interface SimResult { profile: number[]; affected: number | null; value: number | null; touched: number; cohort: number }

export function simulate(base: Baseline, { mode, channel, category, weekend, start, hours, rate,
  activity = 100, amount = 100, days = 1 }: Scenario): SimResult {
  const channels = channel ? [channel] : base.channels;
  const roster = base.merchants.filter((m) => !category || m.category === category);
  const profile = Array<number>(24).fill(0);
  let affected = 0, value = 0, touched = 0;
  let missingValue = false, missingOutcome = false;
  for (const merchant of roster) {
    const expected = merchant.expected[weekend] * activity / 100;
    let windowEvents = 0;
    for (let hour = 0; hour < profile.length; hour++) {
      const hoursShare = channels.reduce((sum, c) => sum + (merchant.share[weekend]?.[c]?.[hour] ?? 0), 0);
      const events = expected * hoursShare;
      profile[hour] += events;
      if (hour >= start && hour < start + hours) windowEvents += events;
    }
    if (!windowEvents) continue;
    touched++;
    const rejection = merchant.rejectionRate[weekend];
    if (mode === 'declines' && rejection === null) {
      missingOutcome = true;
      continue;
    }
    const fraction = mode === 'outage' ? 1 : Math.max(0, rate / 100 - (rejection ?? 0));
    affected += windowEvents * fraction * days;
    const average = merchant.valuePerEvent[weekend];
    if (average === null && fraction > 0) missingValue = true;
    value += windowEvents * fraction * (average ?? 0) * amount / 100 * days;
  }
  return { profile, affected: missingOutcome ? null : affected,
    value: missingValue || missingOutcome ? null : value, touched, cohort: roster.length };
}
