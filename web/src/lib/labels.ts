import { Ban, Banknote, CircleAlert, CircleCheck, Info, Network, OctagonAlert, TrendingDown, TrendingUp, TriangleAlert, Undo2, Unplug, type LucideIcon } from 'lucide-react';
import type { AnomalyType, Lifecycle, ReviewStatus, Severity } from './api';
import { currentLocale, fmtDzd, fmtInt, fmtPct, na, type Locale } from './format';
import { translate, type Key } from './i18n';

// Operator-facing names in the operator's language. Raw engine codes, status codes, channel and
// category values stay unchanged in data, URLs, filters and exports; only their labels are translated.
// Labels read the request locale (server) or the page locale (browser) when they are read.
const tr = (key: Key, l?: Locale) => translate(currentLocale(l), key);

const TYPE_META: Record<AnomalyType, { icon: LucideIcon; signal: string }> = {
  INTERRUPTION: { icon: Unplug, signal: 'S4' }, DROP_VOLUME: { icon: TrendingDown, signal: 'S1' }, ATYPICAL_SURGE: { icon: TrendingUp, signal: 'S2' },
  SPIKE_AMOUNT: { icon: Banknote, signal: 'S2' }, SPIKE_DECLINED: { icon: Ban, signal: 'S3' }, NETWORK_DECLINES: { icon: Network, signal: 'S3' }, CANCEL_SPIKE: { icon: Undo2, signal: 'S5' },
};
export const TYPES = Object.fromEntries((Object.keys(TYPE_META) as AnomalyType[]).map((k) => [k, {
  ...TYPE_META[k], get label() { return tr(`type.${k}` as Key); },
}])) as Record<AnomalyType, { label: string; icon: LucideIcon; signal: string }>;
export const typeLabel = (k: AnomalyType, l?: Locale) => tr(`type.${k}` as Key, l);

const SEV_ICON: Record<Severity | 'normal', LucideIcon> = { critical: OctagonAlert, high: TriangleAlert, medium: CircleAlert, low: Info, normal: CircleCheck };
export const SEVERITIES = Object.fromEntries((Object.keys(SEV_ICON) as (Severity | 'normal')[]).map((k) => [k, {
  icon: SEV_ICON[k], get label() { return tr(`sev.${k}` as Key); },
}])) as Record<Severity | 'normal', { label: string; icon: LucideIcon }>;

const lazy = <K extends string>(keys: K[], prefix: string) =>
  Object.defineProperties({} as Record<K, string>, Object.fromEntries(keys.map((k) => [k, { enumerable: true, get: () => tr(`${prefix}.${k}` as Key) }])));
export const LIFECYCLE = lazy<Lifecycle>(['active', 'recovering', 'resolved'], 'life');
export const REVIEW = lazy<ReviewStatus>(['new', 'acknowledged', 'assigned', 'closed'], 'review');

/** A data value's label: the translation when one exists, else the value itself (unknown categories, merchant IDs). */
const valueLabel = (prefix: string, v: string, l?: Locale) => { const k = `${prefix}.${v}` as Key; const s = tr(k, l); return s === k ? v : s; };
export const statusLabel = (s: string, l?: Locale) => valueLabel('status', s, l);
export const channelLabel = (c: string, l?: Locale) => valueLabel('channel', c, l);
export const categoryLabel = (c: string, l?: Locale) => valueLabel('category', c, l);
export const qualityLabel = (q: string, l?: Locale) => valueLabel('quality', q, l);
export const criticalityLabel = (c: string, l?: Locale) => valueLabel('criticality', c, l);

export const CHANNEL_VAR: Record<string, string> = {
  'E-commerce (CIB / Edahabia)': 'var(--ch-ecommerce)',
  'TPE / POS Terminal': 'var(--ch-pos)',
  'Mobile App': 'var(--ch-mobile)',
  'Contactless / NFC': 'var(--ch-contactless)',
  'Bank Transfer / Virement': 'var(--ch-transfer)',
  Unknown: 'var(--ch-unknown)',
};
/** Text colour on each channel colour (labels drawn inside a slice). */
export const CHANNEL_INK: Record<string, string> = {
  'E-commerce (CIB / Edahabia)': 'var(--ch-ecommerce-ink)', 'TPE / POS Terminal': 'var(--ch-pos-ink)', 'Mobile App': 'var(--ch-mobile-ink)',
  'Contactless / NFC': 'var(--ch-contactless-ink)', 'Bank Transfer / Virement': 'var(--ch-transfer-ink)', Unknown: 'var(--ch-unknown-ink)',
};
export const STATUS_VAR: Record<string, string> = { Accepted: 'var(--st-accepted)', Declined: 'var(--st-declined)', Cancelled: 'var(--st-cancelled)', Refunded: 'var(--st-refunded)' };

export type Kind = 'int' | 'dzd' | 'pct';
export const fmtKind = (v: number, kind: Kind, l?: Locale) => (kind === 'dzd' ? fmtDzd(v, l) : kind === 'pct' ? fmtPct(v, 1, l) : fmtInt(v, l));

const fmtU = (v: number | null, u: 'tx' | 'ratio' | 'DZD', l?: Locale) => (v === null ? na(l) : u === 'DZD' ? fmtDzd(v, l) : u === 'ratio' ? fmtPct(v, 0, l) : fmtInt(v, l));
/** "12 tx vs 41 expected" / "12 tx pour 41 attendues" */
export function observedVsExpected(a: { observed: number | null; expected: number | null; unit: 'tx' | 'ratio' | 'DZD' }, l?: Locale) {
  const loc = currentLocale(l);
  return translate(loc, a.unit === 'tx' ? 'ove.tx' : 'ove.value', { obs: fmtU(a.observed, a.unit, loc), exp: fmtU(a.expected, a.unit, loc) });
}
