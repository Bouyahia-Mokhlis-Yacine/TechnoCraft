'use client';
// Client side of the translations: the provider (given the locale by the server layout), useT(), and
// the FR / EN switch. Switching writes the `pai_lang` cookie and refreshes the server render in place,
// so the page, its query (filters, date range, run) and the collection selection (cookie) are kept.
import { createContext, useContext, useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setClientLocale } from '@/lib/format';
import { LANG_COOKIE, htmlLang, makeT, type Locale, type T } from '@/lib/i18n';

const LocaleContext = createContext<Locale>('fr');

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  if (typeof window !== 'undefined') setClientLocale(locale);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useT(): T {
  const l = useContext(LocaleContext);
  return useMemo(() => makeT(l), [l]);
}

function persistLocale(l: Locale) {
  document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=${365 * 86400}; samesite=lax`;
  document.documentElement.lang = htmlLang(l);
  setClientLocale(l);
}

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const t = useT(), router = useRouter();
  const [pending, start] = useTransition();
  const choose = (l: Locale) => {
    if (l === t.locale) return;
    persistLocale(l);
    start(() => router.refresh());
  };
  return (
    <div className={`lang-switch${pending ? ' is-pending' : ''} ${className}`} role="group" aria-label={t('lang.label')}>
      {(['fr', 'en'] as Locale[]).map((l) => (
        <button key={l} type="button" lang={htmlLang(l)} aria-pressed={t.locale === l} onClick={() => choose(l)}
          title={l === 'fr' ? 'Français' : 'English'} aria-label={l === 'fr' ? 'Français' : 'English'}>{l.toUpperCase()}</button>
      ))}
    </div>
  );
}
