import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { ArrowRight, Database } from 'lucide-react';
import { NavFallback, NavLinks, NavTracker, SidebarToggle } from '@/components/client';
import { AssistantDock } from '@/components/assistant-dock';
import { getMeta, openIncidentCount, rankedIncidents } from '@/lib/api';
import { fmtDay } from '@/lib/format';
import { TYPES } from '@/lib/labels';
import { PAGES } from '@/lib/accounts';
import { currentUser } from '@/lib/session';

/** Shown only when the account can open what it links to (assistant, incidents, data). */
async function IfPage({ page, children }: { page: keyof typeof PAGES; children: React.ReactNode }) {
  const user = await currentUser();
  return user && (user.admin || user.pages.includes(page)) ? children : null;
}

/** Top of the queue: reads the review ledger, so it renders per request. */
async function Spotlight() {
  await connection();
  let top: ReturnType<typeof rankedIncidents>[number] | undefined;
  try { top = rankedIncidents().find((i) => i.open); } catch { return <b>Run unavailable</b>; }
  if (!top) return <><b>All clear</b><p>No open incident at the data cutoff.</p></>;
  return (
    <>
      <b>{top.severity === 'critical' ? 'Critical now' : 'Top of the queue'}</b>
      <p>{TYPES[top.type].label} at {top.merchant}{top.days > 1 ? `, ${top.days} days running` : ''} · priority {top.priority}.</p>
      <Link className="btn btn-light btn-block" href={`/incidents/${top.id}`}>Open incident <ArrowRight /></Link>
    </>
  );
}

/** The sidebar menu, read per request so a newly published run updates the badge. */
async function RunNavigation() {
  await connection();
  let count: number | undefined;
  try { count = openIncidentCount(); } catch { return <NavFallback />; }
  // only the account's pages (the administrator also gets Accounts)
  const user = await currentUser();
  return <NavLinks incidents={count} allow={user ? user.pages.map((k) => PAGES[k].path) : []} admin={!!user?.admin} />;
}

async function RunStatus() {
  await connection();
  let meta: ReturnType<typeof getMeta>;
  try { meta = getMeta(); } catch { return <span className="side-status">Run unavailable</span>; }
  return (
    <Link href="/data" className="side-status" title="Run details and data audit">
      <Database aria-hidden />
      <span><b>{meta.run.parity.sealed ? 'Competition archive' : 'Unsealed replay preview'}</b>
        <small>Data through {fmtDay(meta.asOf)} · batch {meta.run.batch_status}</small></span>
    </Link>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><AuthorizedApp>{children}</AuthorizedApp></Suspense>;
}

async function AuthorizedApp({ children }: { children: React.ReactNode }) {
  if (!await currentUser()) redirect('/login');
  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <Suspense fallback={null}><NavTracker /></Suspense>
      <div className="app">
        <aside className="sidebar" style={{ viewTransitionName: 'sidebar' }}>
          <div className="side-head">
          <Link href="/" className="brand" aria-label="SATIM Anomaly Intelligence, overview">
            <span className="brand-tile">
              <Image src="/brand/satim-emblem.png" alt="" width={40} height={40} priority />
            </span>
            <span className="brand-name"><b className="brand-satim">SATIM</b><span>Anomaly Intelligence</span></span>
          </Link>
          <SidebarToggle />
          </div>

          <Suspense fallback={<NavFallback />}><RunNavigation /></Suspense>

          <Suspense fallback={null}><IfPage page="incidents">
            <div className="spot"><Spotlight /></div>
          </IfPage></Suspense>

          {/* Data status (FR-11, FR-20): which run, how fresh, complete or not. Lives in the sidebar foot. */}
          <Suspense fallback={null}><IfPage page="data"><RunStatus /></IfPage></Suspense>
        </aside>
        <main id="content" className="content">
          {children}
        </main>
      </div>
      <Suspense fallback={null}><IfPage page="assistant"><AssistantDock /></IfPage></Suspense>
    </>
  );
}
