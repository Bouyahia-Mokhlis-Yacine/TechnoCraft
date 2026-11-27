import type { Metadata } from 'next';
import { Suspense } from 'react';
import Image from 'next/image';
import { ArrowRight, Eye, ShieldCheck, UserRoundCheck, UsersRound, Activity, Lightbulb, UserCheck } from 'lucide-react';
import { signIn } from '../actions';
import { ROLES, type Role } from '@/lib/session';

export const metadata: Metadata = { title: 'Sign in' };
const ICONS: Record<Role, typeof Eye> = { analyst: UserRoundCheck, supervisor: UsersRound, reader: Eye, admin: ShieldCheck };

type SP = Promise<Record<string, string | undefined>>;

export default function LoginPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<main className="login" />}><Login searchParams={searchParams} /></Suspense>;
}

async function Login({ searchParams }: { searchParams: SP }) {
  const { next } = await searchParams;
  return (
    <main className="login">
      <section className="login-hero m-rise">
        <span className="spot-logo"><Image src="/brand/satim-logo.png" alt="SATIM" width={110} height={34} /></span>
        <h1>Payment Anomaly Intelligence</h1>
        <p className="sr-only">Watch merchants’ payment activity, see what is unusual and why, and coordinate who acts first.</p>
        <ol className="login-flow" aria-hidden>
          <li className="m-rise" style={{ '--i': 1 } as React.CSSProperties}><Activity /><b>Watch</b><small>every merchant, daily</small></li>
          <li className="m-rise" style={{ '--i': 2 } as React.CSSProperties}><Lightbulb /><b>Explain</b><small>observed vs usual</small></li>
          <li className="m-rise" style={{ '--i': 3 } as React.CSSProperties}><UserCheck /><b>Act</b><small>who checks what</small></li>
        </ol>
      </section>
      <form action={signIn} className="login-card panel m-rise" style={{ '--i': 1 } as React.CSSProperties}>
        <h2>Sign in</h2>
        <p className="muted">Pick a demo role</p>
        <input type="hidden" name="next" value={next ?? '/'} />
        <div className="role-grid" role="radiogroup" aria-label="Account">
          {(Object.keys(ROLES) as Role[]).map((r, i) => {
            const Icon = ICONS[r];
            return (
              <label key={r} className="role-option">
                <input type="radio" name="role" value={r} defaultChecked={i === 0} />
                <span className="tile tile-brand tile-md"><Icon /></span>
                <span><b>{ROLES[r].name}</b><small>{ROLES[r].title}</small></span>
              </label>
            );
          })}
        </div>
        <button className="btn btn-primary btn-block" type="submit">Continue <ArrowRight /></button>
      </form>
    </main>
  );
}
