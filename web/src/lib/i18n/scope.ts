// Route handlers (API) have no React request cache: run their work in a locale scope so the shared
// formatters and labels (lib/format.ts, lib/labels.ts, model text getters) use the caller's language.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Locale } from '../format';

const g = globalThis as { __paiLocale?: AsyncLocalStorage<Locale> };
const store = (g.__paiLocale ??= new AsyncLocalStorage<Locale>());

export const withLocale = <R,>(l: Locale, fn: () => R): R => store.run(l, fn);
