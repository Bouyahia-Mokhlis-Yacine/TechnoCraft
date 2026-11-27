'use client';
// Selecting parts of a page for the assistant: highlighted text gets a small "Ask about this"
// button, and pick mode lets the user click a chart bar, a table row, a card or a panel. Each
// selection is described with what the model needs: its panel, visible text, chart values, the
// table row mapped to its column names, and the in-app links (merchant / incident ids) inside it.
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Selection } from '@/lib/selection';
import { makeT, type Key } from '@/lib/i18n';

// client component: the page locale (set by the provider)
const tr = (key: string, vars?: Record<string, string>) => makeT()(key as Key, vars);

// nearest meaningful thing under the pointer, from the most specific to the whole panel
const PICKABLE = '[data-tip], tr, .kpi, .ref-row, .mix-row, .hc, .sig, .inc-chip, .m-tile, .mx-cell, .pr, .ns-step, .hyp, li, .story, svg, .panel, article';
const clean = (s: string | null | undefined, max = 900) => (s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, max);

function panelTitle(el: Element): string | undefined {
  const panel = el.closest('.panel, .story, article, section');
  if (!panel) return undefined;
  const h = panel.querySelector('h2, h3, .panel-head b');
  if (h?.textContent?.trim()) return clean(h.textContent, 80);
  return panel.classList.contains('story') ? tr('pick.summary') : undefined;
}

function links(el: Element): string[] {
  const own = el.closest('a[href]')?.getAttribute('href');
  const inner = [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
  return [...new Set([own ?? '', ...inner].filter((h) => h.startsWith('/') && !h.startsWith('/api')))].slice(0, 6);
}

/** Describe an element picked on the page. */
export function describeElement(target: Element): Selection {
  const el = target.closest(PICKABLE) ?? target;
  const tipEl = el.closest('[data-tip]');
  const tip = tipEl ? clean(tipEl.getAttribute('data-tip'), 300) : undefined;
  // only the element's own date (a chart bar): a whole panel holds many bars and is not about one day
  const date = el.closest('[data-date]')?.getAttribute('data-date') ?? undefined;
  const panel = panelTitle(el);
  const text = clean(el instanceof HTMLElement ? el.innerText : el.getAttribute('aria-label') ?? el.textContent);
  if (el.tagName === 'TR') {
    const heads = [...(el.closest('table')?.querySelectorAll('thead th') ?? [])].map((th) => clean(th.textContent, 40));
    const cells = [...el.children].map((td) => clean((td as HTMLElement).innerText, 120));
    const table = Object.fromEntries(cells.map((c, i) => [heads[i] || `column ${i + 1}`, c]).filter(([, v]) => v));
    return { kind: 'table row', label: `${tr('pick.row')} ${cells.filter(Boolean).slice(0, 2).join(' · ').slice(0, 48)}`, panel, table, links: links(el) };
  }
  if (tip) return { kind: 'chart element', label: `${panel ?? tr('pick.chart')} : ${tip.split('\n')[0]}`.slice(0, 60), panel, tip, date, links: links(el) };
  if (el.tagName.toLowerCase() === 'svg') return { kind: 'chart', label: `${tr('pick.chart')} ${panel ?? ''}`.slice(0, 60), panel, text: clean(el.getAttribute('aria-label') ?? text, 600), links: links(el) };
  if (el.classList.contains('kpi')) return { kind: 'card', label: `${tr('pick.card')} ${text.split('\n').slice(0, 2).join(' ').slice(0, 44)}`, panel, text, links: links(el) };
  if (el.matches('.panel, article, .story')) return { kind: 'panel', label: `${tr('pick.panel')} ${panel ?? text.split('\n')[0]}`.slice(0, 60), panel, text, date, links: links(el) };
  return { kind: 'element', label: `${panel ? `${panel}: ` : ''}${text.split('\n')[0]}`.slice(0, 60), panel, text, date, links: links(el) };
}

/** Highlighted text inside the page (not inside the assistant). */
function textSelection(): { sel: Selection; rect: DOMRect } | null {
  const s = window.getSelection();
  const text = s?.toString().trim() ?? '';
  if (!s || s.rangeCount === 0 || text.length < 2) return null;
  const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement;
  if (!node || !node.closest('#content') || node.closest('.dock')) return null;
  const rect = s.getRangeAt(0).getBoundingClientRect();
  const panel = panelTitle(node);
  const flat = text.replace(/\s+/g, ' ');
  return { sel: { kind: 'text', label: `“${flat.slice(0, 40)}${flat.length > 40 ? '…' : ''}”`, panel, text: text.slice(0, 900), links: links(node) }, rect };
}

/** Floating "Ask about this" button next to highlighted text. */
export function AskSelection({ onAsk }: { onAsk: (s: Selection) => void }) {
  const [cur, setCur] = useState<{ sel: Selection; x: number; y: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const t = textSelection();
      setCur(t ? { sel: t.sel, x: Math.min(window.innerWidth - 150, t.rect.right), y: Math.max(8, t.rect.top - 44) } : null);
    };
    const onUp = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.ask-sel')) setTimeout(update, 0); };
    const hide = () => setCur(null);
    const onKey = (e: KeyboardEvent) => { if (e.shiftKey || e.key === 'Escape') setTimeout(update, 0); };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onKey);
    window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('mouseup', onUp); document.removeEventListener('keyup', onKey); window.removeEventListener('scroll', hide, true); };
  }, []);
  if (!cur) return null;
  return (
    <button type="button" className="ask-sel" style={{ left: cur.x, top: cur.y }}
      onMouseDown={(e) => e.preventDefault()} // keep the text selected while clicking
      onClick={() => { onAsk(cur.sel); window.getSelection()?.removeAllRanges(); setCur(null); }}>
      <Sparkles aria-hidden />{tr('pick.ask')}
    </button>
  );
}

/** Pick mode: outline what is under the pointer; a click attaches it, Esc cancels. */
export function PickOverlay({ onPick, onCancel }: { onPick: (s: Selection) => void; onCancel: () => void }) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; label: string } | null>(null);
  useEffect(() => {
    document.body.classList.add('picking');
    const inPage = (t: EventTarget | null) => t instanceof Element && !!t.closest('#content') && !t.closest('.dock');
    const move = (e: PointerEvent) => {
      if (!inPage(e.target)) { setBox(null); return; }
      const el = (e.target as Element).closest(PICKABLE);
      if (!el) { setBox(null); return; }
      const r = el.getBoundingClientRect(), d = describeElement(el);
      setBox({ x: r.left, y: r.top, w: r.width, h: r.height, label: d.label });
    };
    const click = (e: MouseEvent) => {
      if (!inPage(e.target)) return;
      e.preventDefault(); e.stopPropagation();          // pick, don't follow links or open charts
      onPick(describeElement(e.target as Element));
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.body.classList.remove('picking');
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onPick, onCancel]);
  return (
    <>
      <div className="pick-banner" role="status">{tr('pick.banner')} <kbd>Esc</kbd> {tr('pick.cancel')}</div>
      {box && <div className="pick-box" style={{ left: box.x - 3, top: box.y - 3, width: box.w + 6, height: box.h + 6 }}><span>{box.label}</span></div>}
    </>
  );
}
