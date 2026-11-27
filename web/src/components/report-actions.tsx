'use client';
import { useT } from './i18n';
// Undo the last change the assistant made to a report.
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';

export function UndoReport({ id, onDone }: { id: string; onDone?: () => void }) {
  const router = useRouter(), t = useT();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="btn btn-ghost" disabled={pending} title={t('rep.undoTitle')}
      onClick={() => start(async () => { const r = await fetch(`/api/v1/reports/${id}/undo`, { method: 'POST' }); if (r.ok) { onDone?.(); router.refresh(); } })}>
      <Undo2 aria-hidden />{t('rep.undo')}
    </button>
  );
}
