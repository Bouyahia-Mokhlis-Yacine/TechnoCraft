'use client';
// A native disclosure (<details>/<summary>: Enter and Space work, the open state is announced) that
// starts collapsed and remembers whether this browser left it open. The content stays mounted.
import { useEffect, useRef } from 'react';

export function RememberedDetails({ storageKey, summary, className = '', children }: { storageKey: string; summary: React.ReactNode; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    try { if (localStorage.getItem(storageKey) === 'open' && ref.current) ref.current.open = true; } catch { /* storage off: stays collapsed */ }
  }, [storageKey]);
  const remember = () => { try { localStorage.setItem(storageKey, ref.current?.open ? 'open' : 'closed'); } catch { /* storage off */ } };
  return (
    <details ref={ref} className={`remembered ${className}`} onToggle={remember}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
