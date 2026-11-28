'use client';
// Keeps every dropdown and popover inside the viewport: when one opens (details toggle, click, hover,
// focus), it is shifted sideways by the overflow through the CSS `translate` property (--pop-dx),
// so near a screen edge it slides in instead of being cut off. Mounted once in the app layout.
import { useEffect } from 'react';

export const POPOVERS = '.dataset-pop, .row-menu-pop, .dr-pop, .info-pop';
const MARGIN = 8;

export function PopoverGuard() {
  useEffect(() => {
    let frame = 0;
    const fit = () => {
      for (const el of document.querySelectorAll<HTMLElement>(POPOVERS)) {
        // closed popovers are never touched: a style written before hydration would not match the server HTML
        if (!el.checkVisibility({ visibilityProperty: true })) { if (el.style.getPropertyValue('--pop-dx')) el.style.removeProperty('--pop-dx'); continue; }
        el.style.removeProperty('--pop-dx');
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        const dx = r.left < MARGIN ? MARGIN - r.left : r.right > innerWidth - MARGIN ? Math.max(MARGIN - r.left, innerWidth - MARGIN - r.right) : 0;
        if (dx) el.style.setProperty('--pop-dx', `${Math.round(dx)}px`);
      }
    };
    const run = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    const events = ['toggle', 'click', 'focusin', 'pointerover', 'resize'] as const;
    for (const e of events) (e === 'resize' ? window : document).addEventListener(e, run, true);
    return () => { cancelAnimationFrame(frame); for (const e of events) (e === 'resize' ? window : document).removeEventListener(e, run, true); };
  }, []);
  return null;
}
