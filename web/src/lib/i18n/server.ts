// Server side of the translations: the operator's language comes from the `pai_lang` cookie
// (French when absent). getT() also sets the request locale used by the formatters.
import { cache } from 'react';
import { cookies } from 'next/headers';
import { setRequestLocale } from '../format';
import { LANG_COOKIE, makeT, parseLocale, type Locale, type T } from './index';

export const getLocale = cache(async (): Promise<Locale> => {
  const l = parseLocale((await cookies()).get(LANG_COOKIE)?.value);
  setRequestLocale(l);
  return l;
});

export async function getT(): Promise<T> {
  const l = await getLocale();
  setRequestLocale(l);
  return makeT(l);
}

/** Route handlers: the language of the request (cookie), without the render cache. */
export function localeOf(req: { cookies: { get(name: string): { value: string } | undefined } }): Locale {
  return parseLocale(req.cookies.get(LANG_COOKIE)?.value);
}
