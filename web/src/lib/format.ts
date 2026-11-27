// Display formatting (DESIGN_RULES §7). Pure functions: safe on server and client.
// The locale is the operator's language: French (fr-DZ) by default, English (en-GB) on request.
// Server components get it from the request (setRequestLocale, called by getT()); client components
// pass it explicitly (useT().locale), because the server render of a client component has no request store.
import { cache } from 'react';

export type Locale = 'fr' | 'en';
const requestLocale = cache((): { l: Locale | null } => ({ l: null }));
let clientLocale: Locale = 'fr';
/** Server: remember this request's locale (per request, through React's request cache). */
export function setRequestLocale(l: Locale) { try { requestLocale().l = l; } catch { /* outside a render */ } }
/** Browser: the page's locale (one operator per tab). */
export function setClientLocale(l: Locale) { clientLocale = l; }
/** Route handlers run outside React's request cache: lib/i18n/scope.ts runs them in an AsyncLocalStorage scope. */
const scoped = () => (globalThis as { __paiLocale?: { getStore(): Locale | undefined } }).__paiLocale?.getStore();
export function currentLocale(l?: Locale): Locale {
  if (l) return l;
  if (typeof window !== 'undefined') return clientLocale;
  let fromRender: Locale | null = null;
  try { fromRender = requestLocale().l; } catch { /* outside a render */ }
  return fromRender ?? scoped() ?? 'fr';
}
export const intlLocale = (l?: Locale) => (currentLocale(l) === 'fr' ? 'fr-DZ' : 'en-GB');

const nfCache = new Map<string, Intl.NumberFormat>();
const nf = (digits: number, l?: Locale) => {
  const key = `${intlLocale(l)}:${digits}`;
  let f = nfCache.get(key);
  if (!f) { f = new Intl.NumberFormat(intlLocale(l), { minimumFractionDigits: digits, maximumFractionDigits: digits }); nfCache.set(key, f); }
  return f;
};
export const na = (l?: Locale) => (currentLocale(l) === 'fr' ? 'n.d.' : 'n/a');

export const fmtInt = (n: number | null, l?: Locale) => n === null ? na(l) : nf(0, l).format(Math.round(n));
export const fmtDzd = (n: number | null, l?: Locale) => n === null ? na(l) : `${fmtInt(n, l)} DZD`;
export const fmtCompactDzd = (n: number | null, l?: Locale) =>
  n === null ? na(l) : n >= 1e6 ? `${nf(1, l).format(n / 1e6)} M DZD` : n >= 1e4 ? `${nf(0, l).format(n / 1e3)} k DZD` : fmtDzd(n, l);
/** x is a ratio (0.426 → "42,6 %" in French, "42.6%" in English) */
export const fmtPct = (x: number | null, digits = 1, l?: Locale) =>
  x === null ? na(l) : `${nf(digits, l).format(x * 100)}${currentLocale(l) === 'fr' ? ' %' : '%'}`;
export const fmtNum = (n: number | null, digits = 1, l?: Locale) => n === null ? na(l) : nf(digits, l).format(n);

/** Signed relative change, "−71 %" / "+12 %"; ratio "×2,4" when above +100 %. */
export function fmtDelta(observed: number, usual: number, l?: Locale): string {
  const fr = currentLocale(l) === 'fr';
  if (!usual) return observed ? (fr ? 'nouvelle activité' : 'new activity') : '—';
  const r = observed / usual;
  if (r >= 2) return `×${nf(1, l).format(r)}`;
  const pct = Math.round((r - 1) * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}${fr ? ' %' : '%'}`;
}

const utc = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const df = (o: Intl.DateTimeFormatOptions, l?: Locale) => new Intl.DateTimeFormat(intlLocale(l), { ...o, timeZone: 'UTC' });
/** "jeu. 13 nov. 2026" / "Thu 13 Nov 2026" */
export const fmtDate = (iso: string, l?: Locale) => df({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, l).format(utc(iso)).replace(',', '');
/** "13 nov." / "13 Nov" */
export const fmtDay = (iso: string, l?: Locale) => df({ day: 'numeric', month: 'short' }, l).format(utc(iso));
/** "13 nov. 2026" / "13 Nov 2026" */
export const fmtDayYear = (iso: string, l?: Locale) => df({ day: 'numeric', month: 'short', year: 'numeric' }, l).format(utc(iso));
/** "13 novembre 2026" / "13 November 2026" */
export const fmtLongDate = (iso: string, l?: Locale) => df({ day: 'numeric', month: 'long', year: 'numeric' }, l).format(utc(iso));
export const weekdayName = (iso: string, l?: Locale) => df({ weekday: 'long' }, l).format(utc(iso));
/** "14–20 nov. 2026", "28 oct. – 3 nov. 2026" (Intl range formatting) */
// ICU versions differ on the spaces around the dash (Node vs the browser), which breaks hydration:
// normalise to "14–20 nov. 2026" between two days and "28 oct. – 3 nov. 2026" otherwise.
export const fmtRange = (from: string, to: string, l?: Locale) =>
  from === to ? fmtDayYear(from, l) : df({ day: 'numeric', month: 'short', year: 'numeric' }, l).formatRange(utc(from), utc(to))
    .replace(/^(\d+)[\s\u2009\u202f]*–[\s\u2009\u202f]*(\d)/, '$1–$2').replace(/[\s\u2009\u202f]+–[\s\u2009\u202f]+/, ' – ');
/** A timestamp in Algiers time: "27 nov. 2026, 19:33" */
export const fmtStamp = (iso: string, l?: Locale) =>
  new Intl.DateTimeFormat(intlLocale(l), { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone: 'Africa/Algiers' }).format(new Date(iso));
