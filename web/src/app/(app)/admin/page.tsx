import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ACTIONS, MIN_PASSWORD, PAGES, listAccounts, type ActionKey, type PageKey, type User } from '@/lib/accounts';
import { currentUser } from '@/lib/session';
import { PageHeader } from '@/components/ui';
import { create, remove, resetOwnPassword, resetPassword, update } from './actions';

export const metadata: Metadata = { title: 'Accounts' };
type SP = Promise<Record<string, string | undefined>>;

export default function AdminPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<PageHeader title="Accounts" />}><Admin searchParams={searchParams} /></Suspense>;
}

/** Page and action ticks, shared by the create and edit forms. */
function Access({ pages, actions }: { pages: PageKey[]; actions: ActionKey[] }) {
  return (
    <>
      <fieldset className="checks">
        <legend>Pages they can see</legend>
        {(Object.keys(PAGES) as PageKey[]).map((k) => (
          <label key={k}><input type="checkbox" name="pages" value={k} defaultChecked={pages.includes(k)} />{PAGES[k].label}</label>
        ))}
      </fieldset>
      <fieldset className="checks">
        <legend>What they can do</legend>
        {(Object.keys(ACTIONS) as ActionKey[]).map((k) => (
          <label key={k} title={ACTIONS[k].help}><input type="checkbox" name="actions" value={k} defaultChecked={actions.includes(k)} />{ACTIONS[k].label}<small>{ACTIONS[k].help}</small></label>
        ))}
      </fieldset>
    </>
  );
}

function AccountItem({ a, me }: { a: User; me: string }) {
  const summary = a.admin ? 'Every page · every action · accounts and audit' : `${a.pages.map((k) => PAGES[k].label).join(', ')} · ${a.actions.length ? a.actions.map((k) => ACTIONS[k].label).join(', ') : 'read only'}`;
  return (
    <details className="panel acct">
      <summary>
        <span><b>{a.name}</b> <small className="muted">{a.id}{a.id === me ? ' · you' : ''}</small></span>
        <small className="muted">{summary}</small>
      </summary>
      <div className="acct-body">
        {!a.admin && (
          <form action={update} className="acct-form">
            <input type="hidden" name="id" value={a.id} />
            <label className="field">Display name<input name="name" defaultValue={a.name} maxLength={60} /></label>
            <Access pages={a.pages} actions={a.actions} />
            <div><button className="btn btn-primary" type="submit">Save access</button></div>
          </form>
        )}
        <form action={a.id === me ? resetOwnPassword : resetPassword} className="acct-row">
          <input type="hidden" name="id" value={a.id} />
          <label className="field">{a.id === me ? 'New password' : 'Set a new password'}<input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required /></label>
          <button className="btn btn-secondary" type="submit">{a.id === me ? 'Change my password' : 'Reset password'}</button>
        </form>
        {!a.admin && (
          <form action={remove} className="acct-row">
            <input type="hidden" name="id" value={a.id} />
            <label className="check-inline"><input type="checkbox" name="confirm" value="yes" required />Confirm: delete {a.id} permanently</label>
            <button className="btn btn-danger" type="submit">Delete account</button>
          </form>
        )}
      </div>
    </details>
  );
}

async function Admin({ searchParams }: { searchParams: SP }) {
  const [user, { done, error }] = await Promise.all([currentUser(), searchParams]);
  if (!user?.admin) redirect('/');
  const accounts = listAccounts();
  return (
    <>
      <PageHeader title="Accounts" />
      {(done || error) && <p className={error ? 'err' : 'ok-note'} role={error ? 'alert' : 'status'}>{error ?? done}</p>}

      <section className="panel m-rise">
        <div className="panel-head"><div><h2>New account</h2><p>Choose the pages it sees and what it can do. You can change both later.</p></div></div>
        <form action={create} className="acct-form">
          <div className="acct-row">
            <label className="field">Username<input name="id" autoComplete="off" pattern="[a-z0-9][a-z0-9._\-]{2,31}" title="3–32 lowercase letters, digits, dot, dash or underscore" required /></label>
            <label className="field">Display name<input name="name" maxLength={60} required /></label>
            <label className="field">Password<input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required /></label>
          </div>
          <Access pages={['overview', 'incidents', 'alerts', 'merchants']} actions={['review']} />
          <div><button className="btn btn-primary" type="submit">Create account</button></div>
        </form>
      </section>

      <section className="stack m-rise" style={{ '--i': 1 } as React.CSSProperties} aria-label="Accounts">
        {accounts.map((a) => <AccountItem key={a.id} a={a} me={user.id} />)}
      </section>
    </>
  );
}
