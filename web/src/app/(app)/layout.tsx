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
import { currentUser } from '@/lib/session';

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

async function RunNavigation() {
  await connection();
  let count: number | undefined;
  try { count = openIncidentCount(); } catch { return <NavFallback />; }
  return <NavLinks incidents={count} />;
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
          <Link href="/" className="brand" aria-label="Payment Anomaly Intelligence, overview">
            <span className="brand-tile">
              <svg viewBox="0 0 32 32" aria-hidden shapeRendering="crispEdges">
                <path className="m-draw" pathLength={1} d="M4 19H9V15H12V21H15V10H19V19H28" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="square" />
                <rect className="m-pixel" style={{ '--delay': '700ms' } as React.CSSProperties} x="14" y="5" width="6" height="6" fill="#93b4dc" />
              </svg>
            </span>
            <span className="brand-name">Anomaly<br />Intelligence</span>
          </Link>
          <SidebarToggle />
          </div>

          <Suspense fallback={<NavFallback />}><RunNavigation /></Suspense>

          <div className="spot">
            <span className="spot-logo"><Image src="/brand/satim-logo.png" alt="SATIM" width={92} height={28} /></span>
            <Suspense fallback={<b>Loading queue…</b>}><Spotlight /></Suspense>
          </div>

          <Suspense fallback={null}><RunStatus /></Suspense>
        </aside>
        <main id="content" className="content">
          {children}
        </main>
      </div>
      <Suspense fallback={null}><AssistantDock /></Suspense>
    </>
  );
}
