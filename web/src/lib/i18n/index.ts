// Shared translation core (server and client). Dictionaries are flat: `en` is the reference and `fr`
// must define every key (TypeScript checks it). Plural forms use `<key>_one` / `<key>_other`, picked
// with Intl.PluralRules from the `n` value (French counts 0 and 1 as singular). `{name}` placeholders
// are filled from `vars`; numbers are formatted in the locale ("3 333").
import { currentLocale, fmtInt, type Locale } from '../format';
import { en } from './en';
import { fr } from './fr';

export type { Locale };
export const LOCALES: Locale[] = ['fr', 'en'];
export const LANG_COOKIE = 'pai_lang';
export const htmlLang = (l: Locale) => (l === 'fr' ? 'fr-DZ' : 'en');
export const parseLocale = (v: string | undefined | null): Locale => (v === 'en' ? 'en' : 'fr');

type EnKey = keyof typeof en;
type PluralBase<K> = K extends `${infer B}_one` ? B : never;
export type Key = EnKey | PluralBase<EnKey>;
export type Vars = Record<string, string | number | null | undefined>;
export type T = ((key: Key, vars?: Vars) => string) & { locale: Locale };

const DICTS: Record<Locale, Record<string, string>> = { en, fr };
const rules = { fr: new Intl.PluralRules('fr'), en: new Intl.PluralRules('en') };

export function translate(locale: Locale, key: Key, vars?: Vars): string {
  const d = DICTS[locale];
  let k: string = key;
  if (vars && typeof vars.n === 'number' && !(key in d)) {
    const cat = rules[locale].select(vars.n);
    k = `${key}_${cat}` in d ? `${key}_${cat}` : `${key}_other`;
  }
  const s = d[k] ?? DICTS.en[k] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? m : typeof v === 'number' ? fmtInt(v, locale) : v;
  });
}

export function makeT(locale?: Locale): T {
  const l = currentLocale(locale);
  return Object.assign((key: Key, vars?: Vars) => translate(l, key, vars), { locale: l });
}

/** Operator message from the backend: a stable code with values, translated here; the English text is the fallback. */
export interface Msg { code: string; values?: Record<string, string | number | boolean | null>; text: string }
export function msgText(t: T, m: Msg | string): string {
  if (typeof m === 'string') return m;
  const key = `msg.${m.code}` as Key;
  const s = translate(t.locale, key, m.values as Vars);
  return s === key ? m.text : s;
}
