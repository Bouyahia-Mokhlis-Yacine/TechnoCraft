import { Ban, Banknote, CircleAlert, CircleCheck, Info, Network, OctagonAlert, TrendingDown, TrendingUp, TriangleAlert, Undo2, Unplug, type LucideIcon } from 'lucide-react';
import type { AnomalyType, Lifecycle, ReviewStatus, Severity } from './api';
import { fmtDzd, fmtInt, fmtPct } from './format';

// Operator-facing names. Raw engine codes are never shown.
export const TYPES: Record<AnomalyType, { label: string; icon: LucideIcon; signal: string }> = {
  INTERRUPTION: { label: 'Activity interruption', icon: Unplug, signal: 'S4' },
  DROP_VOLUME: { label: 'Activity drop', icon: TrendingDown, signal: 'S1' },
  ATYPICAL_SURGE: { label: 'Volume surge', icon: TrendingUp, signal: 'S2' },
  SPIKE_AMOUNT: { label: 'Amount spike', icon: Banknote, signal: 'S2' },
  SPIKE_DECLINED: { label: 'Rejection spike', icon: Ban, signal: 'S3' },
  NETWORK_DECLINES: { label: 'Network rejection incident', icon: Network, signal: 'S3' },
  CANCEL_SPIKE: { label: 'Cancellation spike', icon: Undo2, signal: 'S5' },
};

export const SEVERITIES: Record<Severity | 'normal', { label: string; icon: LucideIcon }> = {
  critical: { label: 'Critical', icon: OctagonAlert },
  high: { label: 'High', icon: TriangleAlert },
  medium: { label: 'Medium', icon: CircleAlert },
  low: { label: 'Low', icon: Info },
  normal: { label: 'Normal', icon: CircleCheck },
};

export const LIFECYCLE: Record<Lifecycle, string> = { active: 'Active', recovering: 'Recovering', resolved: 'Resolved' };
export const REVIEW: Record<ReviewStatus, string> = { new: 'New', acknowledged: 'Acknowledged', assigned: 'Assigned', closed: 'Closed' };

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
export const fmtKind = (v: number, kind: Kind) => (kind === 'dzd' ? fmtDzd(v) : kind === 'pct' ? fmtPct(v) : fmtInt(v));

const fmtU = (v: number | null, u: 'tx' | 'ratio' | 'DZD') => (v === null ? 'n/a' : u === 'DZD' ? fmtDzd(v) : u === 'ratio' ? fmtPct(v, 0) : fmtInt(v));
/** "12 tx vs 41 expected" */
export function observedVsExpected(a: { observed: number | null; expected: number | null; unit: 'tx' | 'ratio' | 'DZD' }) {
  return a.unit === 'tx' ? `${fmtInt(a.observed)} tx vs ${a.expected === null ? 'n/a' : fmtInt(a.expected)} expected` : `${fmtU(a.observed, a.unit)} vs ${fmtU(a.expected, a.unit)} expected`;
}
