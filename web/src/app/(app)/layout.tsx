import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { Database, Layers } from 'lucide-react';
import { NavFallback, NavLinks, NavTracker, SidebarToggle } from '@/components/client';
import { AssistantDock } from '@/components/assistant-dock';
import { PopoverGuard } from '@/components/popover-guard';
import { I18nProvider } from '@/components/i18n';
import { getMeta, openIncidentCount } from '@/lib/api';
import { resolveViewOrNull } from '@/lib/dataset';
import { shownName } from '@/lib/collection-name';
import { fmtRange } from '@/lib/format';
import { PAGES } from '@/lib/accounts';
import { currentUser } from '@/lib/session';
import { getLocale, getT } from '@/lib/i18n/server';

/** Shown only when the account can open what it links to (assistant, incidents, data). */
async function IfPage({ page, children }: { page: keyof typeof PAGES; children: React.ReactNode }) {
  const user = await currentUser();
  return user && (user.admin || user.pages.includes(page)) ? children : null;
}

/** The sidebar menu, read per request so a newly published run or a new selection updates the badge. */
async function RunNavigation() {
  await connection();
  let count: number | undefined;
  try { const v = await resolveViewOrNull(); count = v ? openIncidentCount(v.runId) : 0; } catch { return <NavFallback />; }
  // only the account's pages (the administrator also gets Accounts)
  const user = await currentUser();
  return <NavLinks incidents={count} allow={user ? user.pages.map((k) => PAGES[k].path) : []} admin={!!user?.admin} />;
}

async function RunStatus() {
  await connection();
  const t = await getT();
  let meta: ReturnType<typeof getMeta>, view: Awaited<ReturnType<typeof resolveViewOrNull>>;
  try { view = await resolveViewOrNull(); meta = getMeta(view?.runId ?? null); } catch { return <span className="side-status">{t('side.unavailable')}</span>; }
  if (!view) return <Link href="/data#collections" className="side-status" title={t('side.statusTitle')}><Database aria-hidden /><span><b>{t('ds.none')}</b><small>{t('ds.noneHint')}</small></span></Link>;
  const label = view.combined ? t('ds.combined', { n: view.ids.length }) : shownName(view.names[0] ?? '', t('ds.satimName'));
  return (
    <Link href="/data#collections" className="side-status" title={t('side.statusTitle')}>
      {view.combined ? <Layers aria-hidden /> : <Database aria-hidden />}
      <span><b>{label}</b><small>{fmtRange(meta.firstDate, meta.asOf)}</small></span>
    </Link>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><AuthorizedApp>{children}</AuthorizedApp></Suspense>;
}

async function AuthorizedApp({ children }: { children: React.ReactNode }) {
  if (!await currentUser()) redirect('/login');
  const locale = await getLocale();
  const t = await getT();
  return (
    <I18nProvider locale={locale}>
      <a className="skip" href="#content">{t('common.skip')}</a>
      <Suspense fallback={null}><NavTracker /></Suspense>
      <div className="app">
        <aside className="sidebar" style={{ viewTransitionName: 'sidebar' }}>
          <div className="side-head">
          <Link href="/" className="brand" aria-label={t('side.brandLabel')}>
            <span className="brand-tile">
              <Image src="/brand/satim-emblem.png" alt="" width={40} height={40} priority />
            </span>
            <span className="brand-name"><b className="brand-satim">SATIM</b><span>{t('brand.product')}</span></span>
          </Link>
          <SidebarToggle />
          </div>

          <Suspense fallback={<NavFallback />}><RunNavigation /></Suspense>

          {/* Data status (FR-11, FR-20): which dataset, how fresh, complete or not. Lives in the sidebar foot. */}
          <Suspense fallback={null}><IfPage page="data"><RunStatus /></IfPage></Suspense>
        </aside>
        <main id="content" className="content">
          {children}
        </main>
      </div>
      <Suspense fallback={null}><IfPage page="assistant"><AssistantDock /></IfPage></Suspense>
      <PopoverGuard />
    </I18nProvider>
  );
}
