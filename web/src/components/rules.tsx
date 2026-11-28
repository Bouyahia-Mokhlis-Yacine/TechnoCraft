'use client';
// Custom rules workspace: list (search, status filter), visual builder, preview on a historical dataset,
// activation with reason and confirmation, duplicate, disable, archive, version history and rollback.
// Company-rule results are shown apart from AI alerts and linked to them when both concern the same merchant-day.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Copy, History, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useT } from './i18n';
import { INDICATORS, OPS, type Condition, type Evaluation, type Rule } from '@/lib/rules-core';
import type { T } from '@/lib/i18n';

type Results = Record<string, Evaluation & { total: number }>;
type Draft = Pick<Rule, 'name' | 'description' | 'justification' | 'scope' | 'granularity' | 'conditions' | 'combinator' | 'persistence_days' | 'severity' | 'action' | 'recommendation' | 'effective_from'> & { id?: string };
const CHANNELS = ['nfc', 'pos', 'ecommerce', 'mobile', 'transfer'];
const tk = (t: T, k: string, v?: Record<string, string | number>) => t(k as Parameters<T>[0], v);

async function post(body: unknown) {
  const res = await fetch('/api/v1/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

export function RulesWorkspace({ initial, canEdit, results, viewLabel, datasets, merchants, categories, today }: {
  initial: Rule[]; canEdit: boolean; results: Results; viewLabel: string | null; datasets: { run: string; label: string }[];
  merchants: string[]; categories: string[]; today: string;
}) {
  const t = useT(), router = useRouter();
  const [rules, setRules] = useState(initial);
  const [q, setQ] = useState(''), [status, setStatus] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: 'active' | 'archived' | 'rollback'; version?: number } | null>(null);
  const [reason, setReason] = useState(''), [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState<{ id: string; rows: (Rule & { event: string })[] } | null>(null);
  const shown = useMemo(() => rules.filter((r) => (!status ? r.status !== 'archived' : r.status === status) && (!q || `${r.name} ${r.description}`.toLowerCase().includes(q.toLowerCase()))), [rules, q, status]);

  const err = (data: { error?: { code?: string; message?: string } } | null) => (data?.error?.message ?? '').split(',').map((c) => tk(t, `rules.err.${c}`) === `rules.err.${c}` ? c : tk(t, `rules.err.${c}`)).join(' · ');
  const reload = async () => { const r = await fetch('/api/v1/rules'); if (r.ok) setRules((await r.json()).rules); router.refresh(); };
  const act = async (body: Record<string, unknown>, ok: string) => {
    const r = await post(body);
    setNote(r.ok ? { ok: true, text: ok } : { ok: false, text: err(r.data) || t('rules.failed') });
    if (r.ok) { setPending(null); setReason(''); setConfirm(false); await reload(); }
    return r.ok;
  };
  const blank = (): Draft => ({ name: '', description: '', justification: '', scope: { kind: 'network' }, granularity: 'merchant_day', conditions: [{ indicator: 'decline_rate', op: 'gt', value: 20 }],
    combinator: 'all', persistence_days: 1, severity: 'medium', action: 'evidence', recommendation: '', effective_from: today });

  return (
    <div className="stack">
      {note && <p className={note.ok ? 'ok-note' : 'err'} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
      {draft ? <Builder t={t} draft={draft} setDraft={setDraft} datasets={datasets} merchants={merchants} categories={categories}
        onCancel={() => setDraft(null)} onSave={async () => { if (await act({ op: 'save', id: draft.id, rule: draft }, t('rules.saved'))) setDraft(null); }} err={err} /> : (
        <section className="panel">
          <div className="panel-head"><div><h2>{t('rules.listTitle')}</h2><p>{viewLabel ? t('rules.onView', { label: viewLabel }) : t('rules.onArchive')}</p></div>
            {canEdit && <button type="button" className="btn btn-primary" onClick={() => setDraft(blank())}><Plus aria-hidden />{t('rules.new')}</button>}</div>
          <div className="row cl-actions">
            <label className="field grow">{t('rules.search')}<input value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <label className="field">{t('col.status')}<select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('rules.notArchived')}</option>{['draft', 'active', 'disabled', 'archived'].map((s) => <option key={s} value={s}>{tk(t, `rules.status.${s}`)}</option>)}</select></label>
          </div>
          {shown.length ? <div className="table-scroll"><table className="data">
            <thead><tr><th>{t('rules.name')}</th><th>{t('col.status')}</th><th>{t('rules.scope')}</th><th className="r">{t('rules.matches')}</th><th>{t('rules.last')}</th><th className="r"><span className="sr-only">{t('col.actions')}</span></th></tr></thead>
            <tbody>{shown.map((r) => { const res = results[r.id]; return (
              <tr key={r.id}>
                <td><b>{r.name}</b> <span className="chip">{t('rules.companyRule')}</span><small className="muted block">v{r.version} · {tk(t, `rules.action.${r.action}`)} · {tk(t, `sev.${r.severity}`)}</small></td>
                <td>{tk(t, `rules.status.${r.status}`)}</td>
                <td><small>{tk(t, `rules.gran.${r.granularity}`)} · {tk(t, `rules.scope.${r.scope.kind}`)}{r.scope.value ? ` ${r.scope.value}` : ''}</small></td>
                <td className="r num">{res ? res.total : '—'}</td>
                <td className="num">{res?.last ?? '—'}</td>
                <td className="r"><div className="row rule-actions">
                  {canEdit && r.status !== 'archived' && <button type="button" className="icon-btn" title={t('rules.edit')} aria-label={t('rules.edit')} onClick={() => setDraft({ ...r })}><Pencil aria-hidden /></button>}
                  {canEdit && <button type="button" className="icon-btn" title={t('rules.duplicate')} aria-label={t('rules.duplicate')} onClick={() => act({ op: 'duplicate', id: r.id }, t('rules.duplicated'))}><Copy aria-hidden /></button>}
                  <button type="button" className="icon-btn" title={t('rules.history')} aria-label={t('rules.history')} onClick={async () => { const h = await fetch(`/api/v1/rules?id=${r.id}`); if (h.ok) setHistory({ id: r.id, rows: (await h.json()).history }); }}><History aria-hidden /></button>
                  {canEdit && (r.status === 'draft' || r.status === 'disabled') && <button type="button" className="btn btn-secondary" onClick={() => { setPending({ id: r.id, kind: 'active' }); setReason(''); setConfirm(false); }}><Play aria-hidden />{t('rules.activate')}</button>}
                  {canEdit && r.status === 'active' && <button type="button" className="btn btn-secondary" onClick={() => act({ op: 'status', id: r.id, status: 'disabled' }, t('rules.disabled'))}>{t('rules.disable')}</button>}
                  {canEdit && r.status !== 'archived' && <button type="button" className="icon-btn" title={t('rules.archive')} aria-label={t('rules.archive')} onClick={() => { setPending({ id: r.id, kind: 'archived' }); setReason(''); }}><Trash2 aria-hidden /></button>}
                </div></td>
              </tr>); })}</tbody>
          </table></div> : <p className="muted">{rules.length ? t('rules.noMatch') : t('rules.empty')}</p>}
          {pending && <div className="rule-confirm" role="group" aria-label={t('rules.confirmTitle')}>
            <label className="field grow">{t('cl.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
            {pending.kind === 'active' && <label className="check-inline"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />{t('rules.confirmActivate')}</label>}
            <button type="button" className="btn btn-primary" disabled={!reason.trim() || (pending.kind === 'active' && !confirm)}
              onClick={() => pending.kind === 'rollback' ? act({ op: 'rollback', id: pending.id, version: pending.version, reason }, t('rules.rolledBack'))
                : act({ op: 'status', id: pending.id, status: pending.kind, reason, confirm }, pending.kind === 'active' ? t('rules.activated') : t('rules.archived'))}>
              {pending.kind === 'active' ? t('rules.activate') : pending.kind === 'archived' ? t('rules.archive') : t('rules.rollback')}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>{t('common.cancel')}</button>
          </div>}
          {history && <div className="rule-history"><h3>{t('rules.history')}</h3><ol className="history">{[...history.rows].reverse().map((h, i) => (
            <li key={i}><b>v{h.version}</b> · {h.event} · {h.updated_by} · {h.updated_at.slice(0, 16).replace('T', ' ')}{h.reason ? <q>{h.reason}</q> : null}
              {canEdit && !h.event.startsWith('rollback') && h.event !== 'active' && h.event !== 'disabled' && h.event !== 'archived' && <button type="button" className="link-btn" onClick={() => { setPending({ id: history.id, kind: 'rollback', version: h.version }); setReason(''); }}>{t('rules.rollbackTo', { v: h.version })}</button>}</li>))}</ol></div>}
        </section>
      )}
      {!draft && <ActiveResults t={t} rules={rules} results={results} viewLabel={viewLabel} />}
    </div>
  );
}

function Builder({ t, draft, setDraft, datasets, merchants, categories, onCancel, onSave, err }: {
  t: T; draft: Draft; setDraft: (d: Draft) => void; datasets: { run: string; label: string }[]; merchants: string[]; categories: string[];
  onCancel: () => void; onSave: () => void; err: (d: { error?: { message?: string } } | null) => string;
}) {
  const [run, setRun] = useState(datasets[0]?.run ?? 'archive');
  const [preview, setPreview] = useState<(Evaluation & { matches: number; sample: Evaluation['matched'] }) | null>(null);
  const [perr, setPerr] = useState('');
  const set = (p: Partial<Draft>) => { setDraft({ ...draft, ...p }); setPreview(null); };
  const indicators = Object.entries(INDICATORS).filter(([, v]) => v.granularity === draft.granularity && (draft.scope.kind !== 'channel' || v.channel)).map(([k]) => k);
  const cond = (i: number, p: Partial<Condition>) => set({ conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const scopeValues = draft.scope.kind === 'merchant' ? merchants : draft.scope.kind === 'category' ? categories : draft.scope.kind === 'channel' ? CHANNELS : [];
  return (
    <section className="panel rule-builder" aria-labelledby="rb-h">
      <div className="panel-head"><div><h2 id="rb-h">{draft.id ? t('rules.editTitle') : t('rules.newTitle')}</h2><p>{t('rules.builderSub')}</p></div></div>
      <div className="rule-grid">
        <label className="field">{t('rules.name')}<input value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="field">{t('rules.effective')}<input type="date" value={draft.effective_from} onChange={(e) => set({ effective_from: e.target.value })} /></label>
        <label className="field span2">{t('rules.description')}<input value={draft.description} maxLength={400} onChange={(e) => set({ description: e.target.value })} /></label>
        <label className="field span2">{t('rules.justification')}<input value={draft.justification} maxLength={400} onChange={(e) => set({ justification: e.target.value })} /></label>
        <label className="field">{t('rules.granularity')}<select value={draft.granularity} onChange={(e) => { const g = e.target.value as Draft['granularity']; const first = Object.entries(INDICATORS).find(([, v]) => v.granularity === g)![0]; set({ granularity: g, persistence_days: 1, conditions: [{ indicator: first, op: 'gt', value: 0 }] }); }}>
          <option value="merchant_day">{t('rules.gran.merchant_day')}</option><option value="transaction">{t('rules.gran.transaction')}</option></select></label>
        <label className="field">{t('rules.scope')}<select value={draft.scope.kind} onChange={(e) => set({ scope: { kind: e.target.value as Draft['scope']['kind'] } })}>
          {['network', 'merchant', 'category', 'channel'].map((k) => <option key={k} value={k}>{tk(t, `rules.scope.${k}`)}</option>)}</select></label>
        {draft.scope.kind !== 'network' && <label className="field">{tk(t, `rules.scope.${draft.scope.kind}`)}<select value={draft.scope.value ?? ''} onChange={(e) => set({ scope: { ...draft.scope, value: e.target.value } })}>
          <option value="">{t('rules.choose')}</option>{scopeValues.map((v) => <option key={v} value={v}>{draft.scope.kind === 'channel' ? tk(t, `rules.ch.${v}`) : v}</option>)}</select></label>}
        <label className="field">{t('rules.combinator')}<select value={draft.combinator} onChange={(e) => set({ combinator: e.target.value as Draft['combinator'] })}>
          <option value="all">{t('rules.all')}</option><option value="any">{t('rules.any')}</option></select></label>
      </div>
      <fieldset className="rule-conds"><legend>{t('rules.conditions')}</legend>
        {draft.conditions.map((c, i) => (
          <div className="row rule-cond" key={i}>
            <label className="field">{t('rules.indicator')}<select value={c.indicator} onChange={(e) => cond(i, { indicator: e.target.value })}>
              {indicators.map((k) => <option key={k} value={k}>{tk(t, `rules.ind.${k}`)}</option>)}</select></label>
            <label className="field">{t('rules.operator')}<select value={c.op} onChange={(e) => cond(i, { op: e.target.value as Condition['op'] })}>
              {OPS.map((o) => <option key={o} value={o}>{tk(t, `rules.op.${o}`)}</option>)}</select></label>
            <label className="field">{t('rules.threshold')} ({INDICATORS[c.indicator]?.unit ?? ''})<input type="number" step="any" value={c.value} onChange={(e) => cond(i, { value: Number(e.target.value) })} /></label>
            {c.op === 'between' && <label className="field">{t('rules.and')}<input type="number" step="any" value={c.value2 ?? ''} onChange={(e) => cond(i, { value2: Number(e.target.value) })} /></label>}
            {draft.conditions.length > 1 && <button type="button" className="btn btn-ghost" onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}>{t('rules.remove')}</button>}
          </div>))}
        {draft.conditions.length < 6 && <button type="button" className="btn btn-ghost" onClick={() => set({ conditions: [...draft.conditions, { indicator: indicators[0], op: 'gt', value: 0 }] })}><Plus aria-hidden />{t('rules.addCondition')}</button>}
      </fieldset>
      <div className="rule-grid">
        {draft.granularity === 'merchant_day' && <label className="field">{t('rules.persistence')}<input type="number" min={1} max={14} value={draft.persistence_days} onChange={(e) => set({ persistence_days: Number(e.target.value) })} /></label>}
        <label className="field">{t('f.severity')}<select value={draft.severity} onChange={(e) => set({ severity: e.target.value as Draft['severity'] })}>
          {['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{tk(t, `sev.${s}`)}</option>)}</select></label>
        <label className="field">{t('rules.actionLabel')}<select value={draft.action} onChange={(e) => set({ action: e.target.value as Draft['action'] })}>
          {['evidence', 'alert', 'investigate', 'priority'].map((a) => <option key={a} value={a}>{tk(t, `rules.action.${a}`)}</option>)}</select></label>
        <label className="field span2">{t('rules.recommendation')}<input value={draft.recommendation} maxLength={300} onChange={(e) => set({ recommendation: e.target.value })} /></label>
      </div>
      <div className="row cl-actions">
        <label className="field grow">{t('rules.dataset')}<select value={run} onChange={(e) => { setRun(e.target.value); setPreview(null); }}>{datasets.map((d) => <option key={d.run} value={d.run}>{d.label}</option>)}</select></label>
        <button type="button" className="btn btn-secondary" onClick={async () => { setPerr(''); const r = await post({ op: 'preview', rule: draft, run }); if (r.ok) setPreview(r.data); else setPerr(err(r.data) || t('rules.failed')); }}>{t('rules.preview')}</button>
      </div>
      {perr && <p className="err" role="alert">{perr}</p>}
      {preview && <Preview t={t} p={preview} />}
      <div className="row cl-actions"><button type="button" className="btn btn-primary" onClick={onSave}>{t('rules.saveDraft')}</button><button type="button" className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button></div>
      <p className="muted small">{t('rules.saveNote')}</p>
    </section>
  );
}

function Preview({ t, p }: { t: T; p: Evaluation & { matches: number; sample: Evaluation['matched'] } }) {
  const pct = p.evaluated ? ((p.matches / p.evaluated) * 100).toFixed(2) : '0';
  return (
    <div className="rule-preview" role="status">
      <dl className="import-facts">
        <div><dt>{t('rules.pEvaluated')}</dt><dd>{p.evaluated}</dd></div>
        <div><dt>{t('rules.pMatches')}</dt><dd>{p.matches} ({pct} %)</dd></div>
        <div><dt>{t('rules.pMerchants')}</dt><dd>{p.merchants.length}{p.merchants.length ? ` · ${p.merchants.slice(0, 6).join(', ')}` : ''}</dd></div>
        <div><dt>{t('rules.pOverlap')}</dt><dd>{p.overlap}</dd></div>
        <div className="hl"><dt>{t('rules.pAdditional')}</dt><dd>{p.additional}</dd></div>
        <div><dt>{t('rules.pCoverage')}</dt><dd>{t('rules.pCoverageVal', { insufficient: p.insufficient, incomplete: p.incomplete })}</dd></div>
      </dl>
      {p.channels.length > 0 && <p className="muted small">{t('rules.pChannels')} {p.channels.map((c) => tk(t, `rules.ch.${c}`)).join(', ')}</p>}
      <p className="muted small">{t('rules.pWorkload', { n: p.additional })}</p>
      {(p.insufficient > 0 || p.incomplete > 0) && <p className="muted small">{t('rules.pInsufficient')}</p>}
      {p.sample.length > 0 && <MatchList t={t} rows={p.sample} />}
    </div>
  );
}

function MatchList({ t, rows }: { t: T; rows: Evaluation['matched'] }) {
  return (
    <ul className="rule-matches">{rows.map((m, i) => (
      <li key={i}><b>{m.merchant}</b> · {m.time ?? m.date}{m.channel ? ` · ${tk(t, `rules.ch.${m.channel}`)}` : ''} · {Object.entries(m.observed).map(([k, v]) => `${tk(t, `rules.ind.${k}`)} ${v ?? '—'}`).join(' · ')}
        {m.ai_alert ? <> · <Link href={`/alerts?merchant=${m.merchant}&from=${m.date}&to=${m.date}`}>{t('rules.alsoAi')}</Link></> : null}</li>))}</ul>
  );
}

function ActiveResults({ t, rules, results, viewLabel }: { t: T; rules: Rule[]; results: Results; viewLabel: string | null }) {
  const active = rules.filter((r) => r.status === 'active');
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{t('rules.resultsTitle')}</h2><p>{viewLabel ? t('rules.onView', { label: viewLabel }) : t('rules.onArchive')}</p></div></div>
      {!viewLabel ? <p className="muted">{t('rules.archiveNote')}</p> : !active.length ? <p className="muted">{t('rules.noActive')}</p> : active.map((r) => { const res = results[r.id]; return (
        <article key={r.id} className="rule-result">
          <h3>{r.name} <small className="muted">v{r.version}</small> <span className="chip">{t('rules.companyRule')}</span></h3>
          <p className="small">{r.conditions.map((c) => `${tk(t, `rules.ind.${c.indicator}`)} ${tk(t, `rules.op.${c.op}`)} ${c.value}${c.op === 'between' ? `–${c.value2}` : ''} ${INDICATORS[c.indicator]?.unit ?? ''}`).join(r.combinator === 'all' ? ` ${t('rules.and')} ` : ` ${t('rules.or')} `)}
            · {tk(t, `sev.${r.severity}`)} · {tk(t, `rules.action.${r.action}`)}{r.recommendation ? ` · ${r.recommendation}` : ''}</p>
          {res && res.total ? <><p className="muted small">{t('rules.resultLine', { n: res.total, overlap: res.overlap, extra: res.additional })}</p><MatchList t={t} rows={res.matched} /></> : <p className="muted small">{t('rules.noMatchRun')}</p>}
        </article>); })}
      <p className="muted small">{t('rules.notProof')}</p>
    </section>
  );
}
