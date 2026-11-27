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

          <Suspense fallback={<NavFallback />}><NavLinks incidents={openIncidentCount()} /></Suspense>

          <div className="spot">
            <span className="spot-logo"><Image src="/brand/satim-logo.png" alt="SATIM" width={92} height={28} /></span>
            <Suspense fallback={<b>Loading queue…</b>}><Spotlight /></Suspense>
          </div>

          {/* Data status (FR-11, FR-20): which run, how fresh, complete or not. Lives in the sidebar foot. */}
          <Link href="/data" className="side-status" title="Run details and data audit">
            <Database aria-hidden />
            <span>
              <b>Run {meta.run.run_id}</b>
              <small>Engine {meta.run.policy.version} · as of {fmtDay(meta.asOf)}</small>
            </span>
            <i className={`status-dot ${meta.run.batch_status === 'complete' ? 'ok' : 'warn'}`} aria-label={`Batch ${meta.run.batch_status}`} />
          </Link>
        </aside>
        <main id="content" className="content">
          {children}
        </main>
      </div>
      <Suspense fallback={null}><AssistantDock /></Suspense>
    </>
  );
}
