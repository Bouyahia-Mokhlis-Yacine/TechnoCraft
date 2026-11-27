// Motion helpers. Framework-free ES module; call from React effects or plain JS.
// Every helper falls back to an instant update under prefers-reduced-motion.

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutExpo = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));

// Drive any JS-side animation: onFrame(progress 0→1, eased). Used for count-ups and chart morphs.
export function tween(duration, onFrame) {
  if (reducedMotion()) { onFrame(1); return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min((now - start) / duration, 1);
    onFrame(easeOutExpo(t));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Count a number up from 0. `format` turns the number into display text.
export function countUp(el, to, format = (n) => Math.round(n).toLocaleString('fr-DZ'), duration = 900) {
  tween(duration, (p) => { el.textContent = format(to * p); });
}

// Play an exit class, resolve when it ends (instantly under reduced motion), then the caller removes the element.
export function animateOut(el, cls) {
  return new Promise((done) => {
    if (reducedMotion()) { done(); return; }
    const end = (e) => { if (e.target === el) { el.removeEventListener('animationend', end); done(); } };
    el.addEventListener('animationend', end);
    el.classList.add(cls);
  });
}

// Run a DOM update as an animated View Transition. Elements inside `scope` with data-vt="unique-name"
// glide to their new place. Names are set only during the transition, so other transitions
// (e.g. the theme reveal) are not affected.
export function transition(update, scope) {
  const name = (on) => scope?.querySelectorAll('[data-vt]').forEach((el) => { el.style.viewTransitionName = on ? el.dataset.vt : ''; });
  if (!document.startViewTransition || reducedMotion()) { update(); return null; }
  name(true);
  const t = document.startViewTransition(() => { update(); name(true); });
  t.finished.finally(() => name(false));
  return t;
}

// Switch theme with a circular reveal growing from the clicked element.
export async function toggleTheme(fromEl) {
  const root = document.documentElement;
  const apply = () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; };
  const t = transition(apply);
  if (!t) return;
  const r = fromEl.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  await t.ready;
  root.animate(
    { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    { duration: 550, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
  );
}
