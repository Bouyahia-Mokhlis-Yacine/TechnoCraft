import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { ArrowRight, Database, Layers } from 'lucide-react';
import { NavFallback, NavLinks, NavTracker, SidebarToggle } from '@/components/client';
import { AssistantDock } from '@/components/assistant-dock';
import { PopoverGuard } from '@/components/popover-guard';
import { I18nProvider } from '@/components/i18n';
import { getMeta, openIncidentCount, rankedIncidents } from '@/lib/api';
import { resolveView } from '@/lib/dataset';
import { fmtDay, fmtRange } from '@/lib/format';
import { TYPES } from '@/lib/labels';
import { PAGES } from '@/lib/accounts';
import { currentUser } from '@/lib/session';
import { getLocale, getT } from '@/lib/i18n/server';

/** Shown only when the account can open what it links to (assistant, incidents, data). */
async function IfPage({ page, children }: { page: keyof typeof PAGES; children: React.ReactNode }) {
  const user = await currentUser();
  return user && (user.admin || user.pages.includes(page)) ? children : null;
}

/** Top of the queue of the active dataset: reads the review ledger, so it renders per request. */
async function Spotlight() {
  await connection();
  const t = await getT();
  let top: ReturnType<typeof rankedIncidents>[number] | undefined;
  try { const v = await resolveView(); top = rankedIncidents(v.runId).find((i) => i.open); } catch { return <b>{t('side.unavailable')}</b>; }
  if (!top) return <><b>{t('side.allClear')}</b><p>{t('side.allClearBody')}</p></>;
  return (
    <>
      <b>{top.severity === 'critical' ? t('side.critical') : t('side.top')}</b>
      <p>{t('side.topBody', { type: TYPES[top.type].label, merchant: top.merchant, days: top.days > 1 ? t('side.running', { n: top.days }) : '', priority: top.priority })}</p>
      <Link className="btn btn-light btn-block" href={`/incidents/${top.id}`}>{t('side.openIncident')} <ArrowRight /></Link>
    </>
  );
}

/** The sidebar menu, read per request so a newly published run or a new selection updates the badge. */
async function RunNavigation() {
  await connection();
  let count: number | undefined;
  try { count = openIncidentCount((await resolveView()).runId); } catch { return <NavFallback />; }
  // only the account's pages (the administrator also gets Accounts)
  const user = await currentUser();
  return <NavLinks incidents={count} allow={user ? user.pages.map((k) => PAGES[k].path) : []} admin={!!user?.admin} />;
}

async function RunStatus() {
  await connection();
  const t = await getT();
  let meta: ReturnType<typeof getMeta>, view: Awaited<ReturnType<typeof resolveView>>;
  try { view = await resolveView(); meta = getMeta(view.runId); } catch { return <span className="side-status">{t('side.unavailable')}</span>; }
  const imported = view.kind === 'collections';
  return (
    <Link href={imported ? '/data#collections' : '/data'} className="side-status" title={t('side.statusTitle')}>
      {imported ? <Layers aria-hidden /> : <Database aria-hidden />}
      <span><b>{imported ? (view.combined ? t('ds.combined', { n: view.ids.length }) : view.names[0]) : meta.run.parity.sealed ? t('side.archive') : t('side.preview')}</b>
        <small>{imported ? fmtRange(meta.firstDate, meta.asOf) : t('side.through', { date: fmtDay(meta.asOf), batch: t(`batch.${meta.run.batch_status}` as 'batch.complete') })}</small></span>
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

          <Suspense fallback={null}><IfPage page="incidents">
            <div className="spot"><Spotlight /></div>
          </IfPage></Suspense>

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
