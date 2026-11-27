'use client';
// Two-column dashboard grid (.ov, .detail-grid) whose children are two .stack columns. Each card stays
// in its own column; cards at the end of the taller column that sit beside empty space move to the other
// column when it stays shorter, or span both columns, so unequal columns leave no large empty area.
// Same CSS grid (1px rows, cards span their own height); DOM and reading order are unchanged.
// One column: a side stack shown as a two-column grid (tablet) packs its cards by height; phones are unchanged.
import { useEffect, useRef } from 'react';

export function Balanced({ className, children }: { className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const layout = () => {
      const stacks = [...el.children].filter((c) => c.classList.contains('stack'));
      const cards = stacks.flatMap((s, col) => [...s.children].map((c) => ({ c: c as HTMLElement, col })));
      el.classList.remove('balanced');
      for (const s of stacks) s.classList.remove('packed');
      for (const { c } of cards) { c.style.gridColumn = ''; c.style.gridRowEnd = ''; }
      const gap = parseFloat(getComputedStyle(el).columnGap) || 16;
      const ncols = (g: Element) => getComputedStyle(g).gridTemplateColumns.split(' ').length;
      if (stacks.length !== 2 || ncols(el) < 2) {
        // one column (tablet): a stack laid out as a two-column grid packs its cards by height instead of by rows
        for (const s of stacks) {
          if (ncols(s) < 2) continue;
          const kids = [...s.children] as HTMLElement[], hs = kids.map((c) => c.getBoundingClientRect().height);
          s.classList.add('packed');
          kids.forEach((c, i) => { c.style.gridRowEnd = `span ${Math.ceil(hs[i] + gap)}`; });
        }
        return;
      }
      const h = cards.map(({ c }) => c.getBoundingClientRect().height);
      const target = cards.map(({ col }) => col), wide = cards.map(() => false);
      const end = (col: number) => cards.reduce((t, _, i) => (target[i] === col && !wide[i] ? t + h[i] + gap : t), 0);
      // the tail of the taller column, while it sits beside empty space: move a card across when the
      // other column stays shorter; otherwise let the last such card span both columns
      for (;;) {
        const tall = end(0) >= end(1) ? 0 : 1, short = 1 - tall;
        const i = cards.findLastIndex((_, j) => target[j] === tall && !wide[j]);
        if (i < 0) break;
        const top = end(tall) - h[i] - gap;
        if (top < end(short)) break;
        if (end(short) + h[i] + gap < end(tall)) target[i] = short;   // the taller end strictly drops, so the loop ends
        else { wide[i] = true; break; }
      }
      const place = cards.map((_, i) => ({ target: target[i], wide: wide[i] }));
      el.classList.add('balanced');
      cards.forEach(({ c }, i) => { c.style.gridColumn = place[i].wide ? '1 / -1' : String(place[i].target + 1); });
      // heights in the final column (a wider column can change a card's height), then each card spans its own height
      cards.forEach(({ c }) => { c.style.gridRowEnd = `span ${Math.ceil(c.getBoundingClientRect().height + gap)}`; });
    };
    const run = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    const ro = new ResizeObserver(run);
    ro.observe(el);
    for (const s of el.children) for (const c of s.children) ro.observe(c);
    const mo = new MutationObserver(() => { for (const s of el.children) for (const c of s.children) ro.observe(c); run(); });
    mo.observe(el, { childList: true, subtree: false });
    for (const s of el.children) mo.observe(s, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}
