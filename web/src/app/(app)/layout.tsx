import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { ArrowRight, Database } from 'lucide-react';
import { NavFallback, NavLinks, NavTracker, SidebarToggle } from '@/components/client';
import { AssistantDock } from '@/components/assistant-dock';
import { getMeta, openIncidentCount, rankedIncidents } from '@/lib/api';
import { fmtDay } from '@/lib/format';
import { TYPES } from '@/lib/labels';
import { PAGES } from '@/lib/accounts';
import { currentUser } from '@/lib/session';

/** The sidebar menu: only the account's pages. */
async function UserNav() {
  const user = await currentUser();
  return <NavLinks incidents={openIncidentCount()} allow={user ? user.pages.map((k) => PAGES[k].path) : []} admin={!!user?.admin} />;
}

/** Shown only when the account can open what it links to (assistant, incidents, data). */
async function IfPage({ page, children }: { page: keyof typeof PAGES; children: React.ReactNode }) {
  const user = await currentUser();
  return user && (user.admin || user.pages.includes(page)) ? children : null;
}

/** Top of the queue: reads the review ledger, so it renders per request. */
async function Spotlight() {
  await connection();
  const top = rankedIncidents().find((i) => i.open);
  if (!top) return <><b>All clear</b><p>No open incident right now.</p></>;
  return (
    <>
      <b>{top.severity === 'critical' ? 'Critical now' : 'Top of the queue'}</b>
      <p>{TYPES[top.type].label} at {top.merchant}{top.days > 1 ? `, ${top.days} days running` : ''} · priority {top.priority}.</p>
      <Link className="btn btn-light btn-block" href={`/incidents/${top.id}`}>Open incident <ArrowRight /></Link>
    </>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const meta = getMeta();
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

          <Suspense fallback={<NavFallback />}><UserNav /></Suspense>

          <Suspense fallback={null}><IfPage page="incidents">
            <div className="spot"><Spotlight /></div>
          </IfPage></Suspense>

          {/* Data status (FR-11, FR-20): which run, how fresh, complete or not. Lives in the sidebar foot. */}
          <Suspense fallback={null}><IfPage page="data">
            <Link href="/data" className="side-status" title="Run details and data audit">
              <Database aria-hidden />
              <span>
                <b>Run {meta.run.run_id}</b>
                <small>Engine {meta.run.policy.version} · as of {fmtDay(meta.asOf)}</small>
              </span>
              <i className={`status-dot ${meta.run.batch_status === 'complete' ? 'ok' : 'warn'}`} aria-label={`Batch ${meta.run.batch_status}`} />
            </Link>
          </IfPage></Suspense>
        </aside>
        <main id="content" className="content">
          {children}
        </main>
      </div>
      <Suspense fallback={null}><IfPage page="assistant"><AssistantDock /></IfPage></Suspense>
    </>
  );
}
