'use client';
// Chart interactivity: a cursor tooltip for any element carrying data-tip (server-rendered charts
// stay server components), and a pie whose slices and legend rows highlight each other.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';

/** Wrap a chart: elements with data-tip="line1\nline2" get a tooltip that follows the cursor. */
export function ChartTip({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ lines: string[]; x: number; y: number; flip: boolean } | null>(null);
  const move = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest('[data-tip]');
    const box = ref.current?.getBoundingClientRect();
    if (!el || !box) { if (tip) setTip(null); return; }
    const x = e.clientX - box.left, y = e.clientY - box.top;
    setTip({ lines: (el.getAttribute('data-tip') ?? '').split('\n'), x, y, flip: x > box.width - 200 });
  };
  return (
    <div ref={ref} className="chart-wrap" onMouseMove={move} onMouseLeave={() => setTip(null)}>
      {children}
      {tip && (
        <div className={`chart-tip${tip.flip ? ' flip' : ''}`} style={{ left: tip.x, top: tip.y }} role="status">
          <b>{tip.lines[0]}</b>
          {tip.lines.slice(1).map((l) => <span key={l}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

/** `selected` false dims a slice that is outside the current filter; `toggleHref` adds or removes it
 *  from a multiple selection (Ctrl / ⌘ / Shift-click, or the tick box on its legend row). */
type Slice = { label: string; value: number; color: string; href?: string; detail?: string; extra?: React.ReactNode; selected?: boolean; toggleHref?: string };

/** Pie + legend that highlight each other; a slice or row with href drills down on click, and with
 *  `clearHref` a button clears the selection. */
export function InteractivePie({ rows, size = 230, clearHref, clearLabel = 'Show all' }: { rows: Slice[]; size?: number; clearHref?: string; clearLabel?: string }) {
  const router = useRouter();
  const [on, setOn] = useState<number | null>(null);
  const total = rows.reduce((s, r) => s + r.value, 0) || 1, r = size / 2 - 10, c = size / 2;
  const starts = rows.map((_, i) => -Math.PI / 2 + (rows.slice(0, i).reduce((s, x) => s + x.value, 0) / total) * Math.PI * 2);
  const push = (h: string) => router.push(h, { scroll: false });
  const go = (i: number, e?: React.MouseEvent | React.KeyboardEvent) => {
    const x = rows[i], multi = !!e && (e.ctrlKey || e.metaKey || e.shiftKey);
    if (multi && x.toggleHref) push(x.toggleHref); else if (x.href) push(x.href);
  };
  const filtered = rows.some((x) => x.selected === false);
  const picked = rows.filter((x) => x.selected !== false);
  const share = picked.reduce((s, x) => s + x.value, 0) / total;
  const cur = on === null ? null : rows[on];
  return (
    <>
      <div className="pie-wrap">
        {clearHref && <button type="button" className="pie-clear" onClick={() => push(clearHref)}>{clearLabel}<X aria-hidden /></button>}
        <svg className="pie m-pop" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={rows.map((x) => `${x.label} ${Math.round((x.value / total) * 100)} %`).join(', ')} onMouseLeave={() => setOn(null)}>
          {rows.map((s, i) => {
            const a0 = starts[i], a1 = a0 + (s.value / total) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0, mid = (a0 + a1) / 2;
            const d = rows.length === 1 ? `M${c},${c - r} A${r},${r} 0 1 1 ${c - 0.01},${c - r} Z`
              : `M${c},${c} L${c + r * Math.cos(a0)},${c + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)} Z`;
            const pop = on === i ? `translate(${Math.cos(mid) * 8}px, ${Math.sin(mid) * 8}px)` : undefined;
            return (
              <path key={s.label} d={d} fill={s.color} className={`slice${on !== null && on !== i ? ' dim' : ''}${s.selected === false ? ' off' : ''}${s.href ? ' link' : ''}`} style={{ transform: pop }}
                onMouseEnter={() => setOn(i)} onClick={(e) => go(i, e)} aria-label={`${s.label}: ${s.value}${s.selected === false ? ' (not selected)' : ''}`}>
                {s.toggleHref && <title>{`${s.label}\nClick: only this · Ctrl / ⌘ / Shift-click: add or remove`}</title>}
              </path>
            );
          })}
        </svg>
        {cur ? <div className="pie-center" aria-hidden><b>{Math.round((cur.value / total) * 100)} %</b><span>{cur.label.split(' (')[0]}</span></div>
          : filtered && <div className="pie-center" aria-hidden><b>{Math.round(share * 100)} %</b><span>{picked.length === 1 ? picked[0].label.split(' (')[0] : `${picked.length} selected`}</span></div>}
      </div>
      <div className="mix-rows" onMouseLeave={() => setOn(null)}>
        {rows.map((s, i) => (
          <div key={s.label} className={`mix-row${on === i ? ' on' : ''}${on !== null && on !== i ? ' dim' : ''}${s.selected === false ? ' off' : ''}${s.href ? ' link' : ''}${s.toggleHref ? ' multi' : ''}`} onMouseEnter={() => setOn(i)} onClick={(e) => go(i, e)}
            role={s.href ? 'link' : undefined} tabIndex={s.href ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') go(i, e); }}>
            <span>
              {s.toggleHref && (
                <button type="button" role="checkbox" aria-checked={filtered && s.selected !== false} className="mix-check" title={filtered && s.selected !== false ? `Remove ${s.label} from the selection` : `Add ${s.label} to the selection`}
                  onClick={(e) => { e.stopPropagation(); push(s.toggleHref!); }} onKeyDown={(e) => e.stopPropagation()}><Check aria-hidden /></button>
              )}
              <i className="dot" style={{ background: s.color }} />{s.label}
            </span>
            <span className="num">{s.detail ?? s.value}</span>
            {s.extra ?? <span />}
          </div>
        ))}
      </div>
    </>
  );
}
