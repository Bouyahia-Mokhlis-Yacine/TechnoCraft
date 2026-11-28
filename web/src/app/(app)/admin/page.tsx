import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ACTIONS, MIN_PASSWORD, PAGES, listAccounts, type ActionKey, type PageKey, type User } from '@/lib/accounts';
import { currentUser } from '@/lib/session';
import { PageHeader } from '@/components/ui';
import { create, remove, resetOwnPassword, resetPassword, update } from './actions';
import { makeT, type Key, type T } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.accounts') };
}
const pageName = (t: T, k: PageKey) => t((k === 'simulate' ? 'nav.simulator' : `nav.${k}`) as Key);
const actionName = (t: T, k: ActionKey) => t(`acct.action.${k}` as Key);
const actionHelp = (t: T, k: ActionKey) => t(`acct.help.${k}` as Key);
/** Account errors arrive as English sentences from lib/accounts: shown in the operator's language. */
const ERRORS: [RegExp, Key][] = [[/^Username: 3/, 'acct.err.username'], [/^The username “(.+)” is taken/, 'acct.err.taken'], [/^Give the account a display name/, 'acct.err.name'],
  [/^Passwords need at least (\d+)/, 'acct.err.password'], [/^Tick at least one page/, 'acct.err.pages'], [/^Account not found/, 'acct.err.notFound'],
  [/^The administrator always sees/, 'acct.err.adminPages'], [/^The administrator account cannot/, 'acct.err.adminDelete'], [/^Tick “confirm” to delete (.+)\./, 'acct.err.confirm']];
const errorText = (t: T, e: string) => { for (const [re, k] of ERRORS) { const m = e.match(re); if (m) return t(k, { v: m[1] ?? '' }); } return e; };
type SP = Promise<Record<string, string | undefined>>;

export default function AdminPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={null}><Admin searchParams={searchParams} /></Suspense>;
}

/** Page and action ticks, shared by the create and edit forms. */
function Access({ pages, actions }: { pages: PageKey[]; actions: ActionKey[] }) {
  const t = makeT();
  return (
    <>
      <fieldset className="checks">
        <legend>{t('acct.pages')}</legend>
        {(Object.keys(PAGES) as PageKey[]).map((k) => (
          <label key={k}><input type="checkbox" name="pages" value={k} defaultChecked={pages.includes(k)} />{pageName(t, k)}</label>
        ))}
      </fieldset>
      <fieldset className="checks">
        <legend>{t('acct.actions')}</legend>
        {(Object.keys(ACTIONS) as ActionKey[]).map((k) => (
          <label key={k} title={actionHelp(t, k)}><input type="checkbox" name="actions" value={k} defaultChecked={actions.includes(k)} />{actionName(t, k)}<small>{actionHelp(t, k)}</small></label>
        ))}
      </fieldset>
    </>
  );
}

function AccountItem({ a, me }: { a: User; me: string }) {
  const t = makeT();
  const summary = a.admin ? t('acct.adminSummary') : `${a.pages.map((k) => pageName(t, k)).join(', ')} · ${a.actions.length ? a.actions.map((k) => actionName(t, k)).join(', ') : t('acct.readOnly')}`;
  return (
    <details className="panel acct">
      <summary>
        <span><b>{a.name}</b> <small className="muted">{a.id}{a.id === me ? ` · ${t('acct.you')}` : ''}</small></span>
        <small className="muted">{summary}</small>
      </summary>
      <div className="acct-body">
        {!a.admin && (
          <form action={update} className="acct-form">
            <input type="hidden" name="id" value={a.id} />
            <label className="field">{t('acct.displayName')}<input name="name" defaultValue={a.name} maxLength={60} /></label>
            <Access pages={a.pages} actions={a.actions} />
            <div><button className="btn btn-primary" type="submit">{t('acct.saveAccess')}</button></div>
          </form>
        )}
        <form action={a.id === me ? resetOwnPassword : resetPassword} className="acct-row">
          <input type="hidden" name="id" value={a.id} />
          <label className="field">{a.id === me ? t('acct.newPassword') : t('acct.setPassword')}<input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required /></label>
          <button className="btn btn-secondary" type="submit">{a.id === me ? t('acct.changeMine') : t('acct.reset')}</button>
        </form>
        {!a.admin && (
          <form action={remove} className="acct-row">
            <input type="hidden" name="id" value={a.id} />
            <label className="check-inline"><input type="checkbox" name="confirm" value="yes" required />{t('acct.confirmDelete', { id: a.id })}</label>
            <button className="btn btn-danger" type="submit">{t('acct.delete')}</button>
          </form>
        )}
      </div>
    </details>
  );
}

async function Admin({ searchParams }: { searchParams: SP }) {
  const [user, { done, error, id }] = await Promise.all([currentUser(), searchParams]);
  if (!user?.admin) redirect('/');
  const t = await getT();
  const accounts = listAccounts();
  const doneText = done ? t(`acct.done.${done}` as Key, { id: id ?? '' }) : null;
  return (
    <>
      <PageHeader title={t('nav.accounts')} />
      {(done || error) && <p className={error ? 'err' : 'ok-note'} role={error ? 'alert' : 'status'}>{error ? errorText(t, error) : doneText}</p>}

      <section className="panel m-rise">
        <div className="panel-head"><div><h2>{t('acct.new')}</h2><p>{t('acct.newSub')}</p></div></div>
        <form action={create} className="acct-form">
          <div className="acct-row">
            <label className="field">{t('login.username')}<input name="id" autoComplete="off" pattern="[a-z0-9][a-z0-9._\-]{2,31}" title={t('acct.usernameHint')} required /></label>
            <label className="field">{t('acct.displayName')}<input name="name" maxLength={60} required /></label>
            <label className="field">{t('login.password')}<input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required /></label>
          </div>
          <Access pages={['overview', 'incidents', 'alerts', 'merchants']} actions={['review']} />
          <div><button className="btn btn-primary" type="submit">{t('acct.create')}</button></div>
        </form>
      </section>

      <section className="stack m-rise" style={{ '--i': 1 } as React.CSSProperties} aria-label={t('nav.accounts')}>
        {accounts.map((a) => <AccountItem key={a.id} a={a} me={user.id} />)}
      </section>
    </>
  );
}
