'use client';
// The assistant on every page: a round button in the corner opens a panel over the page. Questions
// carry the current page, so "explain this chart" is answered from that page's figures. The panel
// lives in the app layout, so the conversation follows the user from page to page; it is saved like
// any other and can be continued on the full assistant page. The panel can be dragged by its header;
// parts of the page (highlighted text, or anything picked with the crosshair) can be attached to a question.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Maximize2, Sparkles, SquarePen, X } from 'lucide-react';
import { Chat } from './chat';
import { useT } from './i18n';
import type { Key, T } from '@/lib/i18n';
import { AskSelection, PickOverlay } from './page-select';
import { MAX_SELECTIONS, type Selection } from '@/lib/selection';

const POS_KEY = 'pai-dock-pos';
type Pos = { x: number; y: number };
const clampPos = (p: Pos, el: HTMLElement | null): Pos => {
  const w = el?.offsetWidth ?? 380, h = el?.offsetHeight ?? 560, m = 8;
  return { x: Math.min(Math.max(m, p.x), window.innerWidth - w - m), y: Math.min(Math.max(m, p.y), window.innerHeight - h - m) };
};

/** Short name of the page, as the panel header shows it. */
function pageName(path: string, t: T): string {
  const [a, b] = path.split('/').filter(Boolean);
  if (!a) return t('ov.title');
  const names: Record<string, Key> = { incidents: 'nav.incidents', alerts: 'nav.alerts', merchants: 'nav.merchants', intelligence: 'intel.title', transactions: 'nav.transactions', reports: 'nav.reports', data: 'nav.data', simulate: 'nav.simulator', admin: 'nav.accounts' };
  if (!b) return names[a] ? t(names[a]) : a;
  if (a === 'alerts') return t('dock.alert', { id: decodeURIComponent(b).replace('_', ' · ') });
  if (a === 'reports') return t('rep.report');
  const kind: Record<string, Key> = { incidents: 'inc.incident', merchants: 'f.merchant', intelligence: 'dock.advisory' };
  return `${kind[a] ? t(kind[a]) : names[a] ? t(names[a]) : a} ${decodeURIComponent(b)}`;
}

/** Questions worth asking on each kind of page, in the interface language. */
function suggestionsFor(path: string, t: T): string[] {
  const [a, b] = path.split('/').filter(Boolean);
  const list = (key: string) => t(`dock.q.${key}` as Key).split(' | ');
  if (!a) return list('overview');
  if (b && a === 'merchants') return list('merchant');
  if (b && a === 'incidents') return list('incident');
  if (b && a === 'alerts') return list('alert');
  if (b && a === 'intelligence') return list('advisory');
  if (b && a === 'reports') return list('report');
  if (a === 'reports') return list('reports');
  if (a === 'data') return list('data');
  if (a === 'simulate') return list('simulate');
  if (a === 'intelligence') return list('intelligence');
  return list('list');
}

export function AssistantDock() {
  const path = usePathname(), search = useSearchParams().toString(), router = useRouter(), t = useT();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);            // bumps to start a new conversation
  const [convId, setConvId] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);        // null = bottom-right corner
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // selections and pick mode belong to the page they were made on: leaving it drops them
  const [att, setAtt] = useState<{ path: string; items: Selection[] }>({ path: '', items: [] });
  const [pickOn, setPickOn] = useState<string | null>(null);
  const attachments = att.path === path ? att.items : [];
  const picking = pickOn === path;
  const setAttachments = (f: (a: Selection[]) => Selection[]) => setAtt((cur) => ({ path, items: f(cur.path === path ? cur.items : []) }));
  const setPicking = (v: boolean | ((p: boolean) => boolean)) => setPickOn((cur) => ((typeof v === 'function' ? v(cur === path) : v) ? path : null));
  const posLoaded = useRef(false);

  function openPanel() {
    // where the user last left the panel (wide screens; it is full screen on phones)
    if (!posLoaded.current) {
      posLoaded.current = true;
      try { const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null'); if (p) setPos(clampPos(p, null)); } catch {}
    }
    setOpen(true);
  }
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p, panel.current) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const attach = useCallback((sel: Selection) => {
    setAtt((cur) => ({ path, items: [...(cur.path === path ? cur.items : []).filter((x) => x.label !== sel.label), sel].slice(-MAX_SELECTIONS) }));
    setPickOn(null); openPanel();
    setTimeout(() => panel.current?.querySelector('textarea')?.focus(), 50);
  }, [path]);
  const cancelPick = useCallback(() => setPickOn(null), []);

  function startDrag(e: React.PointerEvent) {
    if ((e.target as Element).closest('button, a') || window.matchMedia('(max-width: 640px)').matches || !panel.current) return;
    const r = panel.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function moveDrag(e: React.PointerEvent) {
    if (drag.current) setPos(clampPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, panel.current));
  }
  function endDrag() {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => { if (p) localStorage.setItem(POS_KEY, JSON.stringify(p)); return p; });
  }
  function resetPos() { setPos(null); localStorage.removeItem(POS_KEY); }

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('textarea')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.body.classList.contains('picking')) { setOpen(false); launcher.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (path === '/assistant') return null;                // the full assistant is already on screen
  const name = pageName(path, t);
  return (
    <div className="dock no-print" style={{ viewTransitionName: 'assistant-dock' }}>
      <button ref={launcher} type="button" className={`dock-launch${open ? ' hidden' : ''}`} onClick={openPanel} aria-label={t('dock.launch')} title={t('dock.launchShort')} aria-expanded={open}>
        <Sparkles aria-hidden />
      </button>
      <AskSelection onAsk={attach} />
      {picking && <PickOverlay onPick={attach} onCancel={cancelPick} />}
      <section ref={panel} className={`dock-panel${open ? ' open' : ''}${pos ? ' moved' : ''}${picking ? ' picking' : ''}`} role="dialog" aria-label={t('nav.assistant')} inert={!open}
        style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}>
        <header className="dock-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={resetPos} title={t('dock.drag')}>
          <span className="dock-title"><Sparkles aria-hidden /><span><b>{t('nav.assistant')}</b><small>{t('dock.on', { page: name })}</small></span></span>
          <button type="button" onClick={() => { setSession((n) => n + 1); setConvId(null); setAttachments(() => []); }} aria-label={t('chat.new')} title={t('chat.new')}><SquarePen aria-hidden /></button>
          <Link href={convId ? `/assistant?c=${convId}` : '/assistant'} onClick={() => setOpen(false)} aria-label={t('dock.openPage')} title={t('dock.openPage')}><Maximize2 aria-hidden /></Link>
          <button type="button" onClick={() => { setOpen(false); launcher.current?.focus(); }} aria-label={t('dock.close')} title={t('common.close')}><X aria-hidden /></button>
        </header>
        <Chat key={session} variant="dock" page={{ path, search }} onConversation={setConvId} emptyTitle={t('dock.emptyTitle')}
          examples={{ en: suggestionsFor(path, t), fr: suggestionsFor(path, t) }} conversations={[]} conversation={null}
          attachments={attachments} onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} onSent={() => setAttachments(() => [])}
          onPick={() => setPicking((v) => !v)} picking={picking}
          // the report on screen was just changed: show the new version in place
          onReply={(r) => { if (r.report && path === `/reports/${r.report.id}`) router.refresh(); }} />
      </section>
    </div>
  );
}
