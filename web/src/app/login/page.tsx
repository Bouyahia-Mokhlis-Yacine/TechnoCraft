import type { Metadata } from 'next';
import { Suspense } from 'react';
import Image from 'next/image';
import { ArrowRight, Activity, Lightbulb, UserCheck } from 'lucide-react';
import { signIn } from '../actions';
import { getLocale, getT } from '@/lib/i18n/server';
import { I18nProvider, LanguageSwitch } from '@/components/i18n';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('login.title') };
}

type SP = Promise<Record<string, string | undefined>>;

export default function LoginPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<main className="login" />}><Login searchParams={searchParams} /></Suspense>;
}

async function Login({ searchParams }: { searchParams: SP }) {
  const { next, error } = await searchParams;
  const t = await getT(), locale = await getLocale();
  return (
    <I18nProvider locale={locale}>
    <main className="login">
      <LanguageSwitch className="login-lang" />
      <section className="login-hero m-rise">
        <span className="spot-logo"><Image src="/brand/satim-logo.png" alt={t('login.logoAlt')} width={417} height={127} priority /></span>
        <h1>Anomaly Intelligence</h1>
        <p className="sr-only">{t('login.intro')}</p>
        <ol className="login-flow" aria-hidden>
          <li className="m-rise" style={{ '--i': 1 } as React.CSSProperties}><Activity /><b>{t('login.watch')}</b><small>{t('login.watchSub')}</small></li>
          <li className="m-rise" style={{ '--i': 2 } as React.CSSProperties}><Lightbulb /><b>{t('login.explain')}</b><small>{t('login.explainSub')}</small></li>
          <li className="m-rise" style={{ '--i': 3 } as React.CSSProperties}><UserCheck /><b>{t('login.act')}</b><small>{t('login.actSub')}</small></li>
        </ol>
      </section>
      <form action={signIn} className="login-card panel m-rise" style={{ '--i': 1 } as React.CSSProperties}>
        <h2>{t('login.title')}</h2>
        <p className="muted">{t('login.byAdmin')}</p>
        {error && <p className="err" role="alert">{error === 'locked' ? t('login.locked') : t('login.invalid')}</p>}
        <input type="hidden" name="next" value={next ?? ''} />
        <label className="field">{t('login.username')}<input name="username" autoComplete="username" required autoFocus /></label>
        <label className="field">{t('login.password')}<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="btn btn-primary btn-block" type="submit">{t('login.submit')} <ArrowRight /></button>
      </form>
    </main>
    </I18nProvider>
  );
}
