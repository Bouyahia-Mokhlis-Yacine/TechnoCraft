'use client';
// Undo the last change the assistant made to a report.
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';

export function UndoReport({ id, onDone }: { id: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="btn btn-ghost" disabled={pending} title="Back to the previous version"
      onClick={() => start(async () => { const r = await fetch(`/api/v1/reports/${id}/undo`, { method: 'POST' }); if (r.ok) { onDone?.(); router.refresh(); } })}>
      <Undo2 aria-hidden />Undo
    </button>
  );
}
