// Display formatting (DESIGN_RULES §7). Pure functions: safe on server and client.

const nf = (digits = 0) => new Intl.NumberFormat('fr-DZ', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtInt = (n: number) => nf(0).format(Math.round(n));
export const fmtDzd = (n: number) => `${fmtInt(n)} DZD`;
export const fmtCompactDzd = (n: number) =>
  n >= 1e6 ? `${nf(1).format(n / 1e6)} M DZD` : n >= 1e4 ? `${nf(0).format(n / 1e3)} k DZD` : fmtDzd(n);
/** x is a ratio (0.062 → "6,2 %") */
export const fmtPct = (x: number, digits = 1) => `${nf(digits).format(x * 100)} %`;
export const fmtNum = (n: number, digits = 1) => nf(digits).format(n);

/** Signed relative change, "−71 %" / "+12 %"; ratio "×2,4" when above +100 %. */
export function fmtDelta(observed: number, usual: number): string {
  if (!usual) return observed ? 'new activity' : '—';
  const r = observed / usual;
  if (r >= 2) return `×${nf(1).format(r)}`;
  const pct = Math.round((r - 1) * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)} %`;
}

const utc = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
/** "Thu 13 Nov 2026" */
export const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(utc(iso)).replace(',', '');
/** "13 Nov" */
export const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(utc(iso));
export const weekdayName = (iso: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(utc(iso));
