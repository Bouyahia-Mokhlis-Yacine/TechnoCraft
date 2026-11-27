'use client';
// Interactive islands. Everything else renders on the server.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, Database, FileText, LayoutGrid, LogOut, PanelLeftClose, PanelLeftOpen, Printer, Radar, Receipt, Siren, Sparkles, Store, SunMoon, TriangleAlert, SlidersHorizontal, ChevronLeft, UsersRound } from 'lucide-react';
import { countUp, toggleTheme } from '@design/motion.js';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';

const FORMAT = { int: fmtInt, num: (n: number) => fmtNum(n, 2), dzd: fmtCompactDzd, pct: (n: number) => fmtPct(n) };

/** KPI figure that counts up once. The server HTML already holds the final value. */
export function CountUp({ value, kind }: { value: number; kind: keyof typeof FORMAT }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (ref.current) countUp(ref.current, value, FORMAT[kind]); }, [value, kind]);
  return <span ref={ref} className="kpi-value">{FORMAT[kind](value)}</span>;
}

const SECTIONS = [
  { title: 'Monitor', items: [
    { href: '/', label: 'Overview', icon: LayoutGrid, badge: false },
    { href: '/live', label: 'Live Monitoring', icon: Activity, badge: false },
    { href: '/incidents', label: 'Incidents', icon: Siren, badge: true },
    { href: '/alerts', label: 'Alerts', icon: TriangleAlert, badge: false },
  ] },
  { title: 'Investigate', items: [
    { href: '/intelligence', label: 'Intelligence', icon: Radar, badge: false },
    { href: '/merchants', label: 'Merchants', icon: Store, badge: false },
    { href: '/transactions', label: 'Transactions', icon: Receipt, badge: false },
    { href: '/assistant', label: 'Assistant', icon: Sparkles, badge: false },
    { href: '/simulate', label: 'Simulator', icon: SlidersHorizontal, badge: false },
  ] },
  { title: 'Report', items: [
    { href: '/reports', label: 'Reports', icon: FileText, badge: false },
    { href: '/data', label: 'Data & runs', icon: Database, badge: false },
  ] },
];
const ADMIN_SECTION = { title: 'Admin', items: [{ href: '/admin', label: 'Accounts', icon: UsersRound, badge: false }] };

/** Sidebar: the pill glides to the active item (shared-element motion, 450ms ease-out). */
/** Only the pages the account was given; the administrator also gets Accounts. */
export function NavLinks({ incidents, allow, admin }: { incidents: number; allow: string[]; admin: boolean }) {
  const path = usePathname();
  const sections = [...SECTIONS, ...(admin ? [ADMIN_SECTION] : [])].map((s) => ({ ...s, items: s.items.filter((n) => admin || allow.includes(n.href)) })).filter((s) => s.items.length);
  const ALL = sections.flatMap((s) => s.items);
  const active = ALL.findIndex((n) => (n.href === '/' ? path === '/' : path.startsWith(n.href)));
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => { const el = refs.current[active]; setTop(el ? el.offsetTop : null); };
    measure();
    window.addEventListener('sidebar', measure); window.addEventListener('resize', measure);
    return () => { window.removeEventListener('sidebar', measure); window.removeEventListener('resize', measure); };
  }, [active]);
  let i = -1;
  return (
    <nav className="nav" aria-label="Main">
      {top !== null && <span className="nav-pill" style={{ transform: `translateY(${top}px)` }} />}
      {sections.map((s) => (
        <div key={s.title} className="nav-group">
          <span className="nav-title">{s.title}</span>
          {s.items.map((n) => {
            const idx = ++i;
            return (
              <Link key={n.href} href={n.href} ref={(el) => { refs.current[idx] = el; }} className={`nav-item${idx === active ? ' is-active' : ''}`} aria-current={idx === active ? 'page' : undefined}>
                <n.icon aria-hidden /><span>{n.label}</span>
                {n.badge && incidents > 0 && <span className="nav-badge" aria-label={`${incidents} open`}>{incidents}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** While the account loads: an empty rail, so no page the account cannot see ever flashes. */
export function NavFallback() {
  return <nav className="nav" aria-label="Main" />;
}

/** Round icon buttons + the signed-in role, top right of every page. */
export function HeaderActions({ roleName, signOut }: { roleName: string | null; signOut: () => Promise<void> }) {
  return (
    <div className="header-actions">
      <span className="who">{roleName ?? 'Signed out'}</span>
      <button className="icon-btn" aria-label="Switch light or dark theme" title="Theme" onClick={(e) => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('theme', next); } catch { /* private mode: theme just won't persist */ }
        toggleTheme(e.currentTarget);
      }}><SunMoon /></button>
      <form action={signOut}><button className="icon-btn" aria-label="Sign out" title="Sign out"><LogOut /></button></form>
    </div>
  );
}

/** Folds the sidebar to an icon rail. The choice is saved and applied before first paint (root layout script). */
export function SidebarToggle() {
  const folded = useSyncExternalStore(
    (cb) => { window.addEventListener('sidebar', cb); return () => window.removeEventListener('sidebar', cb); },
    () => document.documentElement.dataset.sidebar === 'folded', () => false);
  const flip = () => {
    const next = !folded;
    document.documentElement.dataset.sidebar = next ? 'folded' : 'open';
    try { localStorage.setItem('sidebar', next ? 'folded' : 'open'); } catch { /* private mode: not remembered */ }
    window.dispatchEvent(new Event('sidebar'));
  };
  return <button type="button" className="side-toggle" onClick={flip} aria-label={folded ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!folded} title={folded ? 'Expand' : 'Collapse'}>{folded ? <PanelLeftOpen /> : <PanelLeftClose />}</button>;
}

/** GET filter form: any change updates the URL; empty fields are dropped. */
export function FilterForm({ children }: { children: React.ReactNode }) {
  const router = useRouter(), path = usePathname();
  // fields use defaultValue: rebuild the form whenever the URL changes (a chart click, Back, a link)
  // so every field shows the filter actually applied
  const current = useSearchParams().toString();
  const [pending, start] = useTransition();
  const submit = (form: HTMLFormElement) => {
    const qs = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === 'string' && v.trim()) qs.set(k, v.trim());
    start(() => router.push(qs.size ? `${path}?${qs}` : path, { scroll: false }));
  };
  return (
    <form key={current} className={`filters panel${pending ? ' is-pending' : ''}`} role="search"
      onChange={(e) => { const el = e.target as unknown as HTMLInputElement; if (el.tagName === 'SELECT' || el.type === 'date') submit(e.currentTarget); }}
      onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
      {children}
      <Link className="btn btn-ghost" href={path} scroll={false}>Reset</Link>
    </form>
  );
}

const OWNERS = ['L1 operations', 'Technical investigator', 'Acquiring bank liaison', 'Network team'];

/** Review actions for one incident (FR-29). Only the actions the role may take are offered; the server re-checks. */
export function ReviewPanel({ id, version, status, allowed }: { id: string; version: number; status: string; allowed: string[] }) {
  const router = useRouter();
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState(OWNERS[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const offer = [
    { a: 'acknowledge', label: 'Acknowledge', show: status === 'new' },
    { a: 'assign', label: 'Assign', show: status !== 'closed' },
    { a: 'escalate', label: 'Escalate', show: status !== 'closed' },
    { a: 'comment', label: 'Comment', show: true },
    { a: 'close', label: 'Close', show: status !== 'closed' },
    { a: 'reopen', label: 'Reopen', show: status === 'closed' },
  ].filter((o) => o.show && allowed.includes(o.a));
  if (!offer.length) return <p className="muted">Your account can read this incident but not change it.</p>;
  const needsReason = action === 'close' || action === 'escalate' || action === 'comment';
  const send = (a: string) => start(async () => {
    setError(null);
    const res = await fetch(`/api/v1/incidents/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: a, reason, owner: a === 'assign' ? owner : undefined, version }) });
    if (!res.ok) { setError((await res.json()).error?.message ?? 'The action failed.'); return; }
    setAction(null); setReason(''); router.refresh();
  });
  return (
    <div className="review">
      <div className="row">
        {offer.map((o) => (
          <button key={o.a} className={`btn ${o.a === 'acknowledge' || o.a === 'assign' ? 'btn-primary' : 'btn-secondary'}${action === o.a ? ' is-on' : ''}`} disabled={pending}
            onClick={() => (o.a === 'acknowledge' || o.a === 'reopen' ? send(o.a) : setAction(action === o.a ? null : o.a))}>{o.label}</button>
        ))}
      </div>
      {action && action !== 'acknowledge' && (
        <form className="review-form m-slide-down" onSubmit={(e) => { e.preventDefault(); send(action); }}>
          {action === 'assign' && <label className="field">Owner<select value={owner} onChange={(e) => setOwner(e.target.value)}>{OWNERS.map((o) => <option key={o}>{o}</option>)}</select></label>}
          <label className="field">{needsReason ? 'Reason (required)' : 'Note (optional)'}<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required={needsReason} placeholder={action === 'close' ? 'e.g. Gateway team confirmed and fixed the issue' : 'What you checked or decided'} /></label>
          <div className="row"><button className="btn btn-primary" disabled={pending} type="submit">{pending ? 'Saving…' : `Confirm ${action}`}</button><button type="button" className="btn btn-ghost" onClick={() => setAction(null)}>Cancel</button></div>
        </form>
      )}
      {error && <p className="err m-shake" role="alert">{error}</p>}
    </div>
  );
}

export function PrintButton() {
  return <button className="btn btn-primary no-print" onClick={() => window.print()}><Printer />Print / save as PDF</button>;
}

/* ── in-app back navigation ──────────────────────────────────────────
   Back goes up one level in the hierarchy (detail page → its list), never through the visit history.
   Each page's last filters are remembered in this tab (sessionStorage), so going up reopens the list
   as it was left. Top-level pages have no parent and show no Back button. */
const NAV_KEY = 'pai-last';
const navListeners = new Set<() => void>();
const readLast = (): Record<string, string> => { try { return JSON.parse(sessionStorage.getItem(NAV_KEY) ?? '{}'); } catch { return {}; } };
const subscribeNav = (cb: () => void) => { navListeners.add(cb); return () => { navListeners.delete(cb); }; };

export function NavTracker() {
  const pathname = usePathname(), search = useSearchParams().toString();
  useEffect(() => {
    const last = readLast();
    last[pathname] = search ? `${pathname}?${search}` : pathname;
    sessionStorage.setItem(NAV_KEY, JSON.stringify(last));
    navListeners.forEach((l) => l());
  }, [pathname, search]);
  return null;
}

export function BackButton() {
  const router = useRouter(), pathname = usePathname();
  const parts = pathname.split('/').filter(Boolean);
  const parent = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '';
  const target = useSyncExternalStore(subscribeNav, () => (parent ? readLast()[parent] ?? parent : ''), () => parent);
  if (!target) return null;
  return (
    <button type="button" className="back-btn" onClick={() => router.push(target, { transitionTypes: ['nav-back'] })} aria-label="Up one level" title="Up one level">
      <ChevronLeft aria-hidden />
    </button>
  );
}


/** `?print=1` (a PDF download on a machine without a browser to render it): open the print dialog
 *  once the page has drawn, so the user can still "Save as PDF". */
export function AutoPrint() {
  const asked = useSearchParams().get('print') === '1';
  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => document.fonts.ready.then(() => {
      window.print();
      // drop ?print=1 afterwards (doing it first would re-render and cancel the timer)
      const url = new URL(window.location.href);
      url.searchParams.delete('print');
      window.history.replaceState(null, '', url);
    }), 600);
    return () => clearTimeout(t);
  }, [asked]);
  return null;
}

/** Table whose rows open their `data-href` when an ordinary cell (or its padding) is clicked. The
 *  link inside the row stays the keyboard and "open in new tab" route; controls keep their own clicks. */
export function ClickRows({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const target = (e: React.MouseEvent) => {
    const t = e.target as Element;
    if (t.closest('a, button, input, select, textarea, label, summary, [role="button"], [role="checkbox"]')) return null;
    if (window.getSelection()?.toString()) return null;              // selecting text, not opening
    return t.closest('tr[data-href]')?.getAttribute('data-href') ?? null;
  };
  return (
    <div className="click-rows"
      onClick={(e) => { const href = target(e); if (!href) return; if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noopener'); else router.push(href); }}
      onAuxClick={(e) => { if (e.button !== 1) return; const href = target(e); if (href) { e.preventDefault(); window.open(href, '_blank', 'noopener'); } }}>
      {children}
    </div>
  );
}
