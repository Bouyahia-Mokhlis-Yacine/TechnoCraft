// The dataset a request reads: the run resolved for the operator (lib/dataset.ts resolveView), pinned
// for the whole request so every model() call inside it — reports, PDF briefs, simulator baselines,
// assistant tools — uses the same run. Server components pin it through React's per-request cache
// (resolveView calls pinRun); route handlers and background work run inside withRun (AsyncLocalStorage).
// undefined: nothing pinned (the official run). null: the official run, explicitly.
import { cache } from 'react';
import { AsyncLocalStorage } from 'node:async_hooks';

const request = cache((): { run: string | null | undefined } => ({ run: undefined }));
const g = globalThis as { __paiRun?: AsyncLocalStorage<string | null> };
const store = (g.__paiRun ??= new AsyncLocalStorage<string | null>());

export function pinRun(run: string | null) { try { request().run = run; } catch { /* outside a render */ } }
export const withRun = <R,>(run: string | null, fn: () => R): R => store.run(run, fn);
export function pinnedRun(): string | null | undefined {
  const scoped = store.getStore();
  if (scoped !== undefined) return scoped;
  try { return request().run; } catch { return undefined; }
}
