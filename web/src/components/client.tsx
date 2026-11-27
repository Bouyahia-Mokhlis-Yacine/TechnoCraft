'use client';
// Interactive islands. Everything else renders on the server.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, Database, FileText, LayoutGrid, LogOut, PanelLeftClose, PanelLeftOpen, Printer, Radar, Receipt, Siren, Sparkles, Store, SunMoon, TriangleAlert, SlidersHorizontal, ChevronLeft, UsersRound } from 'lucide-react';
import { countUp, toggleTheme } from '@design/motion.js';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct, type Locale } from '@/lib/format';
import { useT, LanguageSwitch } from './i18n';

const FORMAT = { int: (n: number, l: Locale) => fmtInt(n, l), num: (n: number, l: Locale) => fmtNum(n, 2, l), dzd: (n: number, l: Locale) => fmtCompactDzd(n, l), pct: (n: number, l: Locale) => fmtPct(n, 1, l) };

/** KPI figure that counts up once. The server HTML already holds the final value. */
export function CountUp({ value, kind }: { value: number; kind: keyof typeof FORMAT }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { locale } = useT();
  useEffect(() => { if (ref.current) countUp(ref.current, value, (n: number) => FORMAT[kind](n, locale)); }, [value, kind, locale]);
  return <span ref={ref} className="kpi-value">{FORMAT[kind](value, locale)}</span>;
}

const SECTIONS = [
  { title: 'nav.monitor', items: [
    { href: '/', label: 'nav.overview', icon: LayoutGrid, badge: false },
    { href: '/live', label: 'nav.live', icon: Activity, badge: false },
    { href: '/incidents', label: 'nav.incidents', icon: Siren, badge: true },
    { href: '/alerts', label: 'nav.alerts', icon: TriangleAlert, badge: false },
  ] },
  { title: 'nav.investigate', items: [
    { href: '/intelligence', label: 'nav.intelligence', icon: Radar, badge: false },
    { href: '/merchants', label: 'nav.merchants', icon: Store, badge: false },
    { href: '/transactions', label: 'nav.transactions', icon: Receipt, badge: false },
    { href: '/assistant', label: 'nav.assistant', icon: Sparkles, badge: false },
    { href: '/simulate', label: 'nav.simulator', icon: SlidersHorizontal, badge: false },
  ] },
  { title: 'nav.report', items: [
    { href: '/reports', label: 'nav.reports', icon: FileText, badge: false },
    { href: '/data', label: 'nav.data', icon: Database, badge: false },
  ] },
] as const;
const ADMIN_SECTION = { title: 'nav.admin', items: [{ href: '/admin', label: 'nav.accounts', icon: UsersRound, badge: false }] } as const;

/** Sidebar: the pill glides to the active item (shared-element motion, 450ms ease-out). */
/** Only the pages the account was given; the administrator also gets Accounts. */
export function NavLinks({ incidents, allow, admin }: { incidents: number; allow: string[]; admin: boolean }) {
  const path = usePathname(), t = useT();
  const sections = [...SECTIONS, ...(admin ? [ADMIN_SECTION] : [])].map((s) => ({ ...s, items: (s.items as readonly { href: string; label: string; icon: typeof Database; badge: boolean }[]).filter((n) => admin || allow.includes(n.href)) })).filter((s) => s.items.length);
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
    <nav className="nav" aria-label={t('nav.main')}>
      {top !== null && <span className="nav-pill" style={{ transform: `translateY(${top}px)` }} />}
      {sections.map((s) => (
        <div key={s.title} className="nav-group">
          <span className="nav-title">{t(s.title)}</span>
          {s.items.map((n) => {
            const idx = ++i;
            return (
              <Link key={n.href} href={n.href} ref={(el) => { refs.current[idx] = el; }} className={`nav-item${idx === active ? ' is-active' : ''}`} aria-current={idx === active ? 'page' : undefined}>
                <n.icon aria-hidden /><span>{t(n.label as Parameters<typeof t>[0])}</span>
                {n.badge && incidents > 0 && <span className="nav-badge" aria-label={t('nav.openN', { n: incidents })}>{incidents}</span>}
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
  return <nav className="nav" />;
}

/** Round icon buttons + the signed-in role, top right of every page. */
export function HeaderActions({ roleName, signOut, dataset }: { roleName: string | null; signOut: () => Promise<void>; dataset?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="header-actions">
      {dataset}
      <span className="who">{roleName ?? t('head.signedOut')}</span>
      <LanguageSwitch />
      <button className="icon-btn" aria-label={t('head.theme')} title={t('head.themeShort')} onClick={(e) => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('theme', next); } catch { /* private mode: theme just won't persist */ }
        toggleTheme(e.currentTarget);
      }}><SunMoon /></button>
      <form action={signOut}><button className="icon-btn" aria-label={t('head.signOut')} title={t('head.signOut')}><LogOut /></button></form>
    </div>
  );
}

/** Folds the sidebar to an icon rail. The choice is saved and applied before first paint (root layout script). */
export function SidebarToggle() {
  const t = useT();
  const folded = useSyncExternalStore(
    (cb) => { window.addEventListener('sidebar', cb); return () => window.removeEventListener('sidebar', cb); },
    () => document.documentElement.dataset.sidebar === 'folded', () => false);
  const flip = () => {
    const next = !folded;
    document.documentElement.dataset.sidebar = next ? 'folded' : 'open';
    try { localStorage.setItem('sidebar', next ? 'folded' : 'open'); } catch { /* private mode: not remembered */ }
    window.dispatchEvent(new Event('sidebar'));
  };
  return <button type="button" className="side-toggle" onClick={flip} aria-label={folded ? t('side.expand') : t('side.collapse')} aria-expanded={!folded} title={folded ? t('side.expandShort') : t('side.collapseShort')}>{folded ? <PanelLeftOpen /> : <PanelLeftClose />}</button>;
}

/** GET filter form: any change updates the URL; empty fields are dropped. */
export function FilterForm({ children }: { children: React.ReactNode }) {
  const router = useRouter(), path = usePathname(), t = useT();
  // fields use defaultValue: rebuild the form whenever the URL changes (a chart click, Back, a link)
  // so every field shows the filter actually applied
  const search = useSearchParams(), current = search.toString();
  // an imported run (?run=<id>) is the page's scope, not a filter: kept on submit and on Reset
  const run = search.get('run');
  const [pending, start] = useTransition();
  const submit = (form: HTMLFormElement) => {
    const qs = new URLSearchParams(run ? { run } : {});
    for (const [k, v] of new FormData(form)) if (typeof v === 'string' && v.trim()) qs.set(k, v.trim());
    start(() => router.push(qs.size ? `${path}?${qs}` : path, { scroll: false }));
  };
  return (
    <form key={current} className={`filters panel${pending ? ' is-pending' : ''}`} role="search" aria-label={t('filters.label')}
      onChange={(e) => { const el = e.target as unknown as HTMLInputElement; if (el.closest('.dr-pop')) return; if (el.tagName === 'SELECT' || el.type === 'date') submit(e.currentTarget); }}
      onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
      {children}
      <Link className="btn btn-ghost filters-reset" href={run ? `${path}?run=${run}` : path} scroll={false}>{t('common.reset')}</Link>
    </form>
  );
}

const OWNERS = ['L1 operations', 'Technical investigator', 'Acquiring bank liaison', 'Network team'];
const OWNER_KEY: Record<string, string> = { 'L1 operations': 'owner.l1', 'Technical investigator': 'owner.tech', 'Acquiring bank liaison': 'owner.bank', 'Network team': 'owner.network' };

/** Review actions for one incident (FR-29). Only the actions the role may take are offered; the server re-checks. */
export function ReviewPanel({ id, version, status, allowed }: { id: string; version: number; status: string; allowed: string[] }) {
  const router = useRouter(), t = useT();
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState(OWNERS[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const offer = [
    { a: 'acknowledge', label: t('rev.acknowledge'), show: status === 'new' },
    { a: 'assign', label: t('rev.assign'), show: status !== 'closed' },
    { a: 'escalate', label: t('rev.escalate'), show: status !== 'closed' },
    { a: 'comment', label: t('rev.comment'), show: true },
    { a: 'close', label: t('rev.close'), show: status !== 'closed' },
    { a: 'reopen', label: t('rev.reopen'), show: status === 'closed' },
  ].filter((o) => o.show && allowed.includes(o.a));
  if (!offer.length) return <p className="muted">{t('rev.readOnly')}</p>;
  const needsReason = action === 'close' || action === 'escalate' || action === 'comment';
  const send = (a: string) => start(async () => {
    setError(null);
    const res = await fetch(`/api/v1/incidents/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: a, reason, owner: a === 'assign' ? owner : undefined, version }) });
    if (!res.ok) { const e = (await res.json()).error; setError(e?.code === 'stale_version' ? t('rev.conflict') : e?.message ?? t('rev.failed')); return; }
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
          {action === 'assign' && <label className="field">{t('rev.owner')}<select value={owner} onChange={(e) => setOwner(e.target.value)}>{OWNERS.map((o) => <option key={o} value={o}>{t(OWNER_KEY[o] as Parameters<typeof t>[0])}</option>)}</select></label>}
          <label className="field">{needsReason ? t('rev.reasonRequired') : t('rev.noteOptional')}<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required={needsReason} placeholder={action === 'close' ? t('rev.closePlaceholder') : t('rev.notePlaceholder')} /></label>
          <div className="row"><button className="btn btn-primary" disabled={pending} type="submit">{pending ? t('common.saving') : t(`rev.confirm.${action}` as Parameters<typeof t>[0])}</button><button type="button" className="btn btn-ghost" onClick={() => setAction(null)}>{t('common.cancel')}</button></div>
        </form>
      )}
      {error && <p className="err m-shake" role="alert">{error}</p>}
    </div>
  );
}

export function PrintButton() {
  const t = useT();
  return <button className="btn btn-primary no-print" onClick={() => window.print()}><Printer />{t('common.print')}</button>;
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
  const router = useRouter(), pathname = usePathname(), t = useT();
  const parts = pathname.split('/').filter(Boolean);
  const parent = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '';
  const target = useSyncExternalStore(subscribeNav, () => (parent ? readLast()[parent] ?? parent : ''), () => parent);
  if (!target) return null;
  return (
    <button type="button" className="back-btn" onClick={() => router.push(target, { transitionTypes: ['nav-back'] })} aria-label={t('common.upLevel')} title={t('common.upLevel')}>
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
