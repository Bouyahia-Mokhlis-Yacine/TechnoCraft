// What-if simulation shared by the Simulator page and the assistant's simulate_disruption tool.
// Baselines come from the engine snapshot (insights.simulatorBaseline); the disruption is an
// assumption. The flag test is the engine's own: negative binomial for counts, binomial (Bonferroni
// over channels) for declines, and incident inheritance when a network advisory would open.
type Merchant = { id: string; category: string; expected: number[]; share: Record<string, number[]>[]; ticket: number; decRate: number; learning: boolean };
export type Baseline = { asOf: string; from: string; channels: string[]; categories: string[]; alpha: number; high: number; incidentMin: number; merchants: Merchant[] };
export type Curve = { threshold: number; tp: number; fp: number; fn: number; flagged: number }[];

/* ── distributions (log-space, exact sums; daily counts here are small) ── */
function lgamma(x: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const nbCdf = (n: number, mu: number, alpha: number) => {
  if (n < 0) return 0;
  const r = 1 / alpha, p = r / (r + mu); let s = 0;
  for (let k = 0; k <= n; k++) s += Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
  return Math.min(1, s);
};
const binomSf = (k: number, n: number, p: number) => { // P(X >= k)
  if (k <= 0) return 1; if (k > n) return 0; let s = 0;
  for (let j = k; j <= n; j++) s += Math.exp(lgamma(n + 1) - lgamma(j + 1) - lgamma(n - j + 1) + j * Math.log(p) + (n - j) * Math.log(1 - p));
  return Math.min(1, s);
};
const score = (p: number) => -Math.log10(Math.max(p, 1e-300));
export const fmt = (v: number, d = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
export const dzd = (v: number) => (v >= 1e6 ? `${fmt(v / 1e6, 1)} M DZD` : v >= 1e4 ? `${fmt(v / 1e3)} k DZD` : `${fmt(v)} DZD`);


export interface Scenario { mode: 'outage' | 'declines'; channel: string; category: string; weekend: number; start: number; hours: number; rate: number }
export interface SimResult { profile: number[]; affected: number; value: number; touched: number; flagged: string[]; advisory: boolean | null; cohort: number }

export function simulate(base: Baseline, { mode, channel, category, weekend, start, hours, rate }: Scenario): SimResult {
  const chans = channel ? [channel] : base.channels;
  const inWin = (h: number) => h >= start && h < start + hours;
  const ms = base.merchants.filter((m) => !m.learning && (!category || m.category === category) && m.expected[weekend] > 0);
  const profile = Array(24).fill(0);
  let affected = 0, value = 0, touched = 0, N = 0, K = 0, KE = 0;
  const flagged: string[] = [];
  const inherit: string[] = []; // affected on the channel (p < 0.01): flagged if a network advisory opens
  for (const m of ms) {
    const E = m.expected[weekend], sh = m.share[weekend];
    for (let h = 0; h < 24; h++) for (const c of chans) profile[h] += E * (sh[c]?.[h] ?? 0);
    const a = chans.reduce((s, c) => s + E * (sh[c] ?? []).reduce((x, v, h) => x + (inWin(h) ? v : 0), 0), 0);
    if (a < 0.05) continue;
    touched++;
    if (mode === 'outage') {
      affected += a; value += a * m.ticket;
      const n = Math.max(0, Math.round(E - a));
      if (score(nbCdf(n, Math.max(E, 0.5), base.alpha)) >= base.high) flagged.push(m.id);
    } else {
      const extra = a * Math.max(0, rate / 100 - m.decRate);
      affected += extra; value += extra * m.ticket;
      let hit = false;
      for (const c of chans) {
        const nc = Math.round(E * (sh[c] ?? []).reduce((x, v) => x + v, 0));
        const ac = E * (sh[c] ?? []).reduce((x, v, h) => x + (inWin(h) ? v : 0), 0);
        if (nc < 1) continue;
        const kc = Math.min(nc, Math.round(nc * m.decRate + ac * Math.max(0, rate / 100 - m.decRate)));
        N += nc; K += kc; KE += nc * m.decRate;
        const pRaw = binomSf(kc, nc, m.decRate);
        if (score(Math.min(1, base.channels.length * pRaw)) >= base.high) hit = true;
        else if (pRaw < 0.01 && kc > 0) inherit.push(m.id);
      }
      if (hit) flagged.push(m.id);
    }
  }
  const advisory = mode === 'declines' && channel && N > 0 ? score(binomSf(K, N, KE / N)) >= base.incidentMin : null;
  // engine rule (detect._channel_decline_score): during a network incident, affected merchants inherit its score
  if (advisory) for (const id of inherit) if (!flagged.includes(id)) flagged.push(id);
  return { profile, affected, value, touched, flagged, advisory, cohort: ms.length };
}
