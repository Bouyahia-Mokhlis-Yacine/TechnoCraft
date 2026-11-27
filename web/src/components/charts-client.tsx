'use client';
// Chart interactivity: a cursor tooltip for any element carrying data-tip (server-rendered charts
// stay server components), and a pie whose slices and legend rows highlight each other.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { fmtPct } from '@/lib/format';
import type { T } from '@/lib/i18n';
import { useT } from './i18n';

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
type Slice = { label: string; value: number; color: string; ink?: string; href?: string; detail?: string; extra?: React.ReactNode; selected?: boolean; toggleHref?: string };

/** Pie + legend that highlight each other; a slice or row with href drills down on click, and with
 *  `clearHref` a button clears the selection. */
export function InteractivePie({ rows, size = 230, clearHref, clearLabel }: { rows: Slice[]; size?: number; clearHref?: string; clearLabel?: string }) {
  const router = useRouter(), t = useT();
  clearLabel ??= t('pie.showAll');
  const [on, setOn] = useState<number | null>(null);
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const push = (h: string) => router.push(h, { scroll: false });
  const go = (i: number, e?: React.MouseEvent | React.KeyboardEvent) => {
    const x = rows[i], multi = !!e && (e.ctrlKey || e.metaKey || e.shiftKey);
    if (multi && x.toggleHref) push(x.toggleHref); else if (x.href) push(x.href);
  };
  const filtered = rows.some((x) => x.selected === false);
  return (
    <>
      <div className="pie-wrap xpie-wrap">
        {clearHref && <button type="button" className="pie-clear" onClick={() => push(clearHref)}>{clearLabel}<X aria-hidden /></button>}
        <ExplodedPie rows={rows} size={size} total={total} on={on} setOn={setOn} go={go} t={t} />
      </div>
      <div className="mix-rows" onMouseLeave={() => setOn(null)}>
        {rows.map((s, i) => (
          <div key={s.label} className={`mix-row${on === i ? ' on' : ''}${on !== null && on !== i ? ' dim' : ''}${s.selected === false ? ' off' : ''}${s.href ? ' link' : ''}${s.toggleHref ? ' multi' : ''}`} onMouseEnter={() => setOn(i)} onClick={(e) => go(i, e)}
            role={s.href ? 'link' : undefined} tabIndex={s.href ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') go(i, e); }}>
            <span>
              {s.toggleHref && (
                <button type="button" role="checkbox" aria-checked={filtered && s.selected !== false} className="mix-check" title={filtered && s.selected !== false ? t('pie.remove', { label: s.label }) : t('pie.add', { label: s.label })}
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

/* ── Exploded pie: wedges separated by an even gap, softly rounded corners, the share printed
   inside the larger slices. Angles stay proportional to the counts; slices too small for a label
   show their value in the legend and on hover. The hovered slice moves out a little. */
const TAU = Math.PI * 2;
function wedge(cx: number, cy: number, R: number, a0: number, a1: number, gap: number, corner: number): string {
  const f = (n: number) => n.toFixed(2), d = a1 - a0;
  if (d >= TAU - 1e-6) return `M${f(cx - R)},${f(cy)} A${f(R)},${f(R)} 0 1 1 ${f(cx + R)},${f(cy)} A${f(R)},${f(R)} 0 1 1 ${f(cx - R)},${f(cy)} Z`;
  const half = gap / 2, mid = (a0 + a1) / 2;
  // both straight edges move in by half the gap: their meeting point slides out along the bisector
  const apexDist = d < Math.PI ? half / Math.sin(d / 2) : half;
  const ax = cx + apexDist * Math.cos(mid), ay = cy + apexDist * Math.sin(mid);
  const delta = Math.asin(Math.min(1, half / R)), s0 = a0 + delta, s1 = a1 - delta;
  if (s1 <= s0) return '';
  const P = (t: number) => [cx + R * Math.cos(t), cy + R * Math.sin(t)] as const;
  const [p0x, p0y] = P(s0), [p1x, p1y] = P(s1);
  const len0 = Math.hypot(p0x - ax, p0y - ay), len1 = Math.hypot(p1x - ax, p1y - ay);
  const r = Math.max(0, Math.min(corner, len0 / 3, len1 / 3, ((s1 - s0) * R) / 3));
  const u0 = [(p0x - ax) / len0, (p0y - ay) / len0], u1 = [(p1x - ax) / len1, (p1y - ay) / len1];
  const [c0x, c0y] = P(s0 + r / R), [c1x, c1y] = P(s1 - r / R);
  const large = s1 - s0 - (2 * r) / R > Math.PI ? 1 : 0;
  return [
    `M${f(ax + u0[0] * r)},${f(ay + u0[1] * r)}`,
    `L${f(p0x - u0[0] * r)},${f(p0y - u0[1] * r)}`, `Q${f(p0x)},${f(p0y)} ${f(c0x)},${f(c0y)}`,
    `A${f(R)},${f(R)} 0 ${large} 1 ${f(c1x)},${f(c1y)}`,
    `Q${f(p1x)},${f(p1y)} ${f(p1x - u1[0] * r)},${f(p1y - u1[1] * r)}`,
    `L${f(ax + u1[0] * r)},${f(ay + u1[1] * r)}`, `Q${f(ax)},${f(ay)} ${f(ax + u0[0] * r)},${f(ay + u0[1] * r)}`, 'Z',
  ].join(' ');
}

function ExplodedPie({ rows, size, total, on, setOn, go, t }: {
  t: T;
  rows: Slice[]; size: number; total: number; on: number | null; setOn: (i: number | null) => void; go: (i: number, e?: React.MouseEvent) => void;
}) {
  const R = size / 2 - 10, c = size / 2, gap = Math.max(4, size * 0.026), corner = size * 0.04;
  const before = (i: number) => rows.slice(0, i).reduce((s, x) => s + x.value, 0) / total;
  const slices = rows.map((r, i) => {
    const a0 = -Math.PI / 2 + before(i) * TAU, a1 = -Math.PI / 2 + before(i + 1) * TAU;
    return { r, i, a0, a1, mid: (a0 + a1) / 2, share: r.value / total };
  }).filter((x) => x.r.value > 0);
  const single = slices.length === 1;
  return (
    <svg className="pie xpie m-pop" viewBox={`0 0 ${size} ${size}`} role="img" onMouseLeave={() => setOn(null)}
      aria-label={rows.map((x) => `${x.label} ${fmtPct(x.value / total, 0, t.locale)}`).join(', ')}>
      {slices.map(({ r, i, a0, a1, mid, share }) => {
        const out = on === i ? size * 0.025 : 0, dx = Math.cos(mid) * out, dy = Math.sin(mid) * out;
        // a label only where it fits: big enough share and arc
        const fits = single || (share >= 0.07 && (a1 - a0) * R * 0.62 > size * 0.11);
        const lr = single ? 0 : R * (share > 0.3 ? 0.56 : 0.64);
        return (
          <g key={r.label} className={`xslice${on !== null && on !== i ? ' dim' : ''}${r.selected === false ? ' off' : ''}${r.href ? ' link' : ''}`}
            style={{ transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)` }} onMouseEnter={() => setOn(i)} onClick={(e) => go(i, e)}>
            <title>{`${r.label} : ${r.detail ?? r.value}${r.toggleHref ? `\n${t('pie.howTo')}` : ''}`}</title>
            <path d={wedge(c, c, R, a0, a1, single ? 0 : gap, corner)} style={{ fill: r.color }} />
            {fits && (
              <text x={(c + lr * Math.cos(mid)).toFixed(2)} y={(c + lr * Math.sin(mid)).toFixed(2)} textAnchor="middle" dominantBaseline="central"
                style={{ fill: r.ink ?? '#fff', fontSize: size * (share > 0.25 ? 0.085 : 0.068) }} className="xpct">{fmtPct(share, 0, t.locale)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
