import type { Metadata } from 'next';
import { Suspense } from 'react';
import Image from 'next/image';
import { ArrowRight, Activity, Lightbulb, UserCheck } from 'lucide-react';
import { signIn } from '../actions';

export const metadata: Metadata = { title: 'Sign in' };
const ERRORS: Record<string, string> = { invalid: 'Wrong username or password.', locked: 'Too many attempts. Wait a minute, then try again.' };

type SP = Promise<Record<string, string | undefined>>;

export default function LoginPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<main className="login" />}><Login searchParams={searchParams} /></Suspense>;
}

async function Login({ searchParams }: { searchParams: SP }) {
  const { next, error } = await searchParams;
  return (
    <main className="login">
      <section className="login-hero m-rise">
        <span className="spot-logo"><Image src="/brand/satim-logo.png" alt="SATIM, Société d’Automatisation des Transactions Interbancaires et de Monétique" width={417} height={127} priority /></span>
        <h1>Anomaly Intelligence</h1>
        <p className="sr-only">Watch merchants’ payment activity, see what is unusual and why, and coordinate who acts first.</p>
        <ol className="login-flow" aria-hidden>
          <li className="m-rise" style={{ '--i': 1 } as React.CSSProperties}><Activity /><b>Watch</b><small>every merchant, daily</small></li>
          <li className="m-rise" style={{ '--i': 2 } as React.CSSProperties}><Lightbulb /><b>Explain</b><small>observed vs usual</small></li>
          <li className="m-rise" style={{ '--i': 3 } as React.CSSProperties}><UserCheck /><b>Act</b><small>who checks what</small></li>
        </ol>
      </section>
      <form action={signIn} className="login-card panel m-rise" style={{ '--i': 1 } as React.CSSProperties}>
        <h2>Sign in</h2>
        <p className="muted">Accounts are created by your administrator.</p>
        {error && <p className="err" role="alert">{ERRORS[error] ?? ERRORS.invalid}</p>}
        <input type="hidden" name="next" value={next ?? ''} />
        <label className="field">Username<input name="username" autoComplete="username" required autoFocus /></label>
        <label className="field">Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="btn btn-primary btn-block" type="submit">Sign in <ArrowRight /></button>
      </form>
    </main>
  );
}
