import Link from 'next/link';
import { Suspense } from 'react';
import { ChevronLeft, ChevronRight, Download, SearchX, type LucideIcon } from 'lucide-react';
import { signOut } from '@/app/actions';
import { type AnomalyType, type Lifecycle, type Ranked, type ReviewStatus, type Severity } from '@/lib/api';
import { LIFECYCLE, REVIEW, SEVERITIES, TYPES, observedVsExpected } from '@/lib/labels';
import { fmtDay } from '@/lib/format';
import { currentUser, ROLES } from '@/lib/session';
import { BackButton, HeaderActions } from './client';

export function SeverityBadge({ severity, beat = false }: { severity: Severity | 'normal'; beat?: boolean }) {
  const { label, icon: Icon } = SEVERITIES[severity];
  void Icon; void beat; // calm: a dot and the word, no icon box
  return <span className={`badge sev-${severity}`}><i className="sev-dot" aria-hidden />{label}</span>;
}
export const LifecycleChip = ({ l }: { l: Lifecycle }) => <span className={`chip life-${l}`}><i className="dot" />{LIFECYCLE[l]}</span>;
export const ReviewChip = ({ s, escalated }: { s: ReviewStatus; escalated?: boolean }) => <span className={`chip review-${s}`}>{REVIEW[s]}{escalated ? ' · escalated' : ''}</span>;

export function IconTile({ icon: Icon, tone = 'plain', size = 'md' }: { icon: LucideIcon; tone?: 'plain' | 'hero' | 'brand'; size?: 'sm' | 'md' }) {
  return <span className={`tile tile-${tone} tile-${size}`} aria-hidden><Icon /></span>;
}

export function TypeLabel({ type, tile = false }: { type: AnomalyType; tile?: boolean }) {
  const { label, icon: Icon } = TYPES[type];
  void tile; // plain inline icon everywhere: no coloured tiles in lists
  return <span className="type"><Icon aria-hidden />{label}</span>;
}

/** Pill delta coloured by meaning, not by sign. */
export function Delta({ text, tone }: { text: string; tone: 'good' | 'bad' | 'flat' }) {
  return <span className={`pill pill-${tone}`}>{text}</span>;
}

async function Account() {
  const user = await currentUser();
  return <HeaderActions roleName={user ? ROLES[user.role].name : null} signOut={signOut} />;
}

export function PageHeader({ title, crumbs, children }: { title: React.ReactNode; crumbs?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="page-header m-rise">
      <div className="page-title">
        {crumbs && <nav className="crumbs" aria-label="Breadcrumb">{crumbs}</nav>}
        <div className="title-row"><BackButton /><h1>{title}</h1></div>
      </div>
      <div className="row">
        {children}
        <Suspense fallback={<div className="header-actions" />}><Account /></Suspense>
      </div>
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty m-fade"><SearchX aria-hidden /><b>{title}</b>{children && <span className="muted">{children}</span>}</div>;
}

/** Ranked queue row. The whole row is the link to the incident. */
export function IncidentRow({ i, idx }: { i: Ranked; idx: number }) {
  const { label } = TYPES[i.type];
  return (
    <Link href={`/incidents/${i.id}`} className={`queue-row sev-${i.severity} m-rise`} style={{ '--i': Math.min(idx, 7) } as React.CSSProperties}>
      <span className="rank" title="Priority rank">{i.rank ?? '–'}</span>
      <span className="q-main">
        <b>{label} · {i.merchant}</b>
        <span className="muted">{i.category} · {i.lifecycle === 'active' ? (i.days > 1 ? `ongoing for ${i.days} days` : 'today') : i.days > 1 ? `${fmtDay(i.onset)} → ${fmtDay(i.end)}` : fmtDay(i.end)} · {i.review.owner ?? 'unassigned'}</span>
      </span>
      <span className="q-num num">{observedVsExpected(i.latest)}</span>
      <span className="q-prio" title="Priority score (0–100)"><b>{i.priority}</b><small>priority</small></span>
      <SeverityBadge severity={i.severity} />
      <ChevronRight aria-hidden className="chev" />
    </Link>
  );
}

export function Pager({ page, pageSize, total, params, path }: { page: number; pageSize: number; total: number; params: Record<string, string>; path: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (p: number) => `${path}?${new URLSearchParams({ ...params, page: String(p) })}`;
  return (
    <nav className="pager" aria-label="Pagination">
      {page > 1 ? <Link className="icon-btn" href={href(page - 1)} aria-label="Previous page"><ChevronLeft /></Link> : <span className="icon-btn is-disabled" aria-hidden><ChevronLeft /></span>}
      <span className="muted">Page {page} of {pages}</span>
      {page < pages ? <Link className="icon-btn" href={href(page + 1)} aria-label="Next page"><ChevronRight /></Link> : <span className="icon-btn is-disabled" aria-hidden><ChevronRight /></span>}
    </nav>
  );
}

/** Sanitized CSV of the current filter scope (logged on the server). */
export function ExportLink({ kind, params, label = 'Export CSV' }: { kind: 'transactions' | 'anomalies' | 'incidents'; params: Record<string, string>; label?: string }) {
  const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'page'));
  return <a className="btn btn-secondary" href={`/api/v1/export/${kind}?${new URLSearchParams(rest)}`} download><Download />{label}</a>;
}

export function flat(sp: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) { const s = Array.isArray(v) ? v[0] : v; if (s) out[k] = s; }
  return out;
}
