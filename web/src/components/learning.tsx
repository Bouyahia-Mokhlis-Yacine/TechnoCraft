'use client';
// Controlled learning workspace: every action is one call to /api/v1/learning (LearningService through the
// server bridge). The service enforces roles, self-approval, quarantine and the promotion gate; this page
// only shows its results and its refusals.
import { useCallback, useEffect, useState } from 'react';
import { useT } from './i18n';
import type { T } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';

type Json = Record<string, unknown>;
const LABELS = ['confirmed_anomaly', 'verified_normal', 'legitimate_change', 'data_quality_issue', 'insufficient_evidence'] as const;

async function call(method: string, args: Json = {}): Promise<{ ok: boolean; data: unknown; message?: string }> {
  const res = await fetch('/api/v1/learning', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
  let body: { ok?: unknown; error?: { message?: string } } = {};
  try { body = await res.json(); } catch { /* empty */ }
  return res.ok ? { ok: true, data: body.ok } : { ok: false, data: null, message: body.error?.message };
}
/** A service code in the interface language when a translation exists; otherwise the code itself. */
const tc = (t: T, prefix: string, v: unknown) => { if (v === null || v === undefined) return '—'; const k = `${prefix}.${String(v)}`; const s = t(k as never); return s === k ? String(v) : s; };
const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : typeof v === 'boolean' ? (v ? '✓' : '—') : String(v));

export function LearningWorkspace({ role, dates }: { role: 'supervisor' | 'reviewer' | null; dates: string[] }) {
  const t = useT();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const report = (r: { ok: boolean; message?: string }, ok: string) => setNote(r.ok ? { ok: true, text: ok } : { ok: false, text: r.message || t('cl.failed') });
  if (!role) return <p className="muted panel">{t('cl.noRole')}</p>;
  return (
    <div className="stack learning">
      {note && <p className={note.ok ? 'ok-note' : 'err'} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
      <Registry t={t} supervisor={role === 'supervisor'} report={report} />
      <Queue t={t} supervisor={role === 'supervisor'} dates={dates} report={report} />
      {role === 'supervisor' && <Jobs t={t} dates={dates} report={report} />}
      <Drift t={t} report={report} />
    </div>
  );
}

type Report = (r: { ok: boolean; message?: string }, ok: string) => void;

function Registry({ t, supervisor, report }: { t: T; supervisor: boolean; report: Report }) {
  const [reg, setReg] = useState<{ models: Json[]; approval_history: Json[] } | null>(null);
  const [stats, setStats] = useState<Json | null>(null);
  const [reason, setReason] = useState('');
  const load = useCallback(async () => {
    const [r, s] = await Promise.all([call('model_registry'), call('feedback_statistics')]);
    if (r.ok) setReg(r.data as never); if (s.ok) setStats(s.data as Json);
  }, []);
  useEffect(() => { const first = setTimeout(load, 0), id = setInterval(load, 8000); return () => { clearTimeout(first); clearInterval(id); }; }, [load]);
  const active = reg?.models.find((m) => m.state === 'active');
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{t('cl.registry')}</h2><p>{active ? t('cl.activeModel', { id: String(active.model_id ?? active.id) }) : t('cl.noModel')}</p></div></div>
      {reg && reg.models.length > 0 && <div className="table-scroll"><table className="data"><thead><tr><th>{t('cl.model')}</th><th>{t('col.status')}</th><th>{t('rh.reference')}</th><th>{t('cl.integrity')}</th><th>{t('cl.created')}</th></tr></thead>
        <tbody>{reg.models.map((m) => <tr key={String(m.model_id ?? m.id)}><td className="num">{fmt(m.model_id ?? m.id)}</td><td>{fmt(m.state)}</td><td className="num">{fmt((m.metadata as Json | undefined)?.reference_version)}</td><td>{fmt((m.training_integrity as Json | undefined)?.status ?? m.training_integrity)}</td><td className="num">{fmt((m.metadata as Json | undefined)?.calibration_end)}</td></tr>)}</tbody></table></div>}
      {reg && !reg.models.length && <ol className="cl-start">{[1, 2, 3, 4].map((n) => <li key={n}>{t(`cl.start${n}` as never)}</li>)}</ol>}
      {stats && <p className="muted small">{t('cl.targeted')} {t('cl.stats', { n: Number(stats.total ?? 0) })} · {Object.entries((stats.current_labels as Json) ?? {}).map(([k, v]) => `${t(`cl.label.${k}` as never)} ${v}`).join(' · ')}</p>}
      {supervisor && <div className="row cl-actions">
        <label className="field grow">{t('cl.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
        {reg && !reg.models.length && <button type="button" className="btn btn-primary" disabled={!reason.trim()} onClick={async () => { report(await call('initialize_baseline', { reason }), t('cl.baselineStarted')); }}>{t('cl.initialize')}</button>}
        {active && <button type="button" className="btn btn-secondary" disabled={!reason.trim()} onClick={async () => { const r = await call('rollback', { expected_active: active.model_id ?? active.id, reason }); report(r, t('cl.rolledBack')); void load(); }}>{t('cl.rollback')}</button>}
      </div>}
    </section>
  );
}

function Queue({ t, supervisor, dates, report }: { t: T; supervisor: boolean; dates: string[]; report: Report }) {
  const [day, setDay] = useState(dates[0] ?? '');
  const [rows, setRows] = useState<Json[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!day) return;
    const r = await call('review_queue', { observation_day: day });
    setRows(r.ok ? (r.data as Json[]) : []); setError(r.ok ? '' : r.message ?? '');
  }, [day]);
  useEffect(() => { const first = setTimeout(load, 0); return () => clearTimeout(first); }, [load]);
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{t('cl.queue')}</h2><p>{t('cl.queueSub')}</p></div></div>
      {dates.length ? <label className="field">{t('cl.day')}<select value={day} onChange={(e) => setDay(e.target.value)}>{dates.map((d) => <option key={d}>{d}</option>)}</select></label> : <p className="muted">{t('cl.noDates')}</p>}
      {error && <p className="err">{error}</p>}
      {rows && !rows.length && !error && <p className="muted">{t('cl.emptyQueue')}</p>}
      <ol className="cl-queue">{rows?.map((r) => <QueueItem key={`${r.merchant_id}${r.date}`} t={t} row={r} supervisor={supervisor} report={report} onDone={load} />)}</ol>
    </section>
  );
}

function QueueItem({ t, row, supervisor, report, onDone }: { t: T; row: Json; supervisor: boolean; report: Report; onDone: () => void }) {
  const [label, setLabel] = useState<string>('verified_normal');
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<Json[] | null>(null);
  const [reason, setReason] = useState('');
  const ev = (row.model_evidence ?? {}) as Json;
  const num = (v: unknown) => (typeof v === 'number' ? fmtNum(v, 3, t.locale) : '—');
  const key = { merchant_id: row.merchant_id, observation_day: row.date };
  const loadHistory = async () => { const r = await call('feedback_history', key); setHistory(r.ok ? (r.data as Json[]) : []); };
  const latest = history?.at(-1);
  return (
    <li className="cl-item">
      <div className="cl-item-head"><b>{String(row.merchant_id)}</b> · {String(row.date)} · {tc(t, 'ind', row.symptom)} · <span className="muted">{t('cl.reasonSel', { r: (Array.isArray(row.selection_reason) ? row.selection_reason : [row.selection_reason]).map((r) => tc(t, 'cl.sel', r)).join(', ') })}{row.selection_probability != null ? ` · p = ${fmtNum(Number(row.selection_probability), 3, t.locale)}` : ''}</span></div>
      <p className="muted small">{t('cl.evidence', { seq: num(ev.sequential_score), seqT: num(ev.sequential_threshold), hyb: num(ev.hybrid_score), phase: tc(t, 'cl.phase', ev.phase), ref: fmt(ev.reference_version) })}</p>
      <div className="row cl-actions">
        <label className="field">{t('cl.label')}<select value={label} onChange={(e) => setLabel(e.target.value)}>{LABELS.map((l) => <option key={l} value={l}>{t(`cl.label.${l}` as never)}</option>)}</select></label>
        <label className="field grow">{t('cl.notes')}<input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></label>
        <button type="button" className="btn btn-primary" disabled={!notes.trim()} onClick={async () => {
          const r = await call('submit_feedback', { ...key, label, notes, observation_revision: row.observation_revision, expected_revision: Number(latest?.revision ?? 0) });
          report(r, t('cl.submitted')); if (r.ok) { void loadHistory(); onDone(); }
        }}>{t('cl.submit')}</button>
        <button type="button" className="btn btn-ghost" onClick={loadHistory}>{t('cl.history')}</button>
      </div>
      {history && <ul className="cl-history">{history.map((h) => <li key={String(h.revision)}>#{fmt(h.revision)} · {t(`cl.label.${h.label}` as never)} · {fmt(h.reviewer)} · {fmt(h.approval ?? h.status)}</li>)}</ul>}
      {supervisor && latest && (latest.approval ?? latest.status) === 'pending' && <div className="row cl-actions">
        <label className="field grow">{t('cl.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
        {(['approved', 'rejected'] as const).map((d) => <button key={d} type="button" className={`btn ${d === 'approved' ? 'btn-primary' : 'btn-secondary'}`} disabled={!reason.trim()} onClick={async () => {
          const r = await call('decide_feedback', { ...key, revision: latest.revision, decision: d, reason }); report(r, t(d === 'approved' ? 'cl.approved' : 'cl.rejected')); if (r.ok) void loadHistory();
        }}>{t(d === 'approved' ? 'cl.approve' : 'cl.reject')}</button>)}
      </div>}
    </li>
  );
}

function Jobs({ t, dates, report }: { t: T; dates: string[]; report: Report }) {
  const [plan, setPlan] = useState({ fit_start: '', calibration_start: '', calibration_end: '', eval_start: '', eval_end: '', refit_isolation_forest: true });
  const [job, setJob] = useState('');
  // the API has no job listing: the jobs registered from this browser are offered as choices
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => { const id = setTimeout(() => { try { setKnown(JSON.parse(localStorage.getItem('pai-cl-jobs') ?? '[]')); } catch { /* storage off */ } }, 0); return () => clearTimeout(id); }, []);
  const remember = (id: string) => setKnown((k) => { const next = [id, ...k.filter((x) => x !== id)].slice(0, 10); try { localStorage.setItem('pai-cl-jobs', JSON.stringify(next)); } catch { /* storage off */ } return next; });
  // a suggested split of the days with observations: half to fit, a quarter to calibrate, the last quarter to evaluate
  const suggest = () => {
    const d = [...dates].sort(), n = d.length;
    if (n < 8) return;
    const a = Math.floor(n / 2), b = Math.floor((n * 3) / 4);
    setPlan((x) => ({ ...x, fit_start: d[0], calibration_start: d[a], calibration_end: d[b - 1], eval_start: d[b], eval_end: d[n - 1] }));
  };
  const [status, setStatus] = useState<Json | null>(null);
  const [cmp, setCmp] = useState<Json | null>(null);
  const [shadowDay, setShadowDay] = useState(dates.at(-1) ?? '');
  const [reason, setReason] = useState('');
  const refresh = async () => { if (!job) return; const s = await call('learning_job_status', { job_id: job }); if (s.ok) setStatus(s.data as Json); else report(s, ''); };
  const dateField = (k: keyof typeof plan) => <label key={k} className="field">{t(`cl.plan.${k}` as never)}<input type="date" value={String(plan[k])} onChange={(e) => setPlan({ ...plan, [k]: e.target.value })} /></label>;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{t('cl.jobs')}</h2><p>{t('cl.jobsSub')}</p></div></div>
      <div className="row cl-actions">{(['fit_start', 'calibration_start', 'calibration_end', 'eval_start', 'eval_end'] as const).map(dateField)}
        <label className="check-inline"><input type="checkbox" checked={plan.refit_isolation_forest} onChange={(e) => setPlan({ ...plan, refit_isolation_forest: e.target.checked })} />{t('cl.refit')}</label>
        <button type="button" className="btn btn-primary" onClick={async () => { const r = await call('start_learning_job', { plan }); report(r, t('cl.jobQueued')); if (r.ok) { const id = String((r.data as Json).job_id); setJob(id); remember(id); } }}>{t('cl.startJob')}</button>
        <button type="button" className="btn btn-ghost" disabled={dates.length < 8} title={dates.length < 8 ? t('cl.suggestTooFew') : undefined} onClick={suggest}>{t('cl.suggest')}</button></div>
      <p className="muted small">{t('cl.suggestNote')}</p>
      <div className="row cl-actions">
        <label className="field">{t('cl.job')}<input value={job} list="cl-known-jobs" onChange={(e) => setJob(e.target.value.trim())} /></label>
        <datalist id="cl-known-jobs">{known.map((k) => <option key={k} value={k} />)}</datalist>
        <button type="button" className="btn btn-secondary" disabled={!job} onClick={async () => report(await call('run_learning_job', { job_id: job }), t('cl.jobRunning'))}>{t('cl.runJob')}</button>
        <button type="button" className="btn btn-ghost" disabled={!job} onClick={refresh}>{t('cl.status')}</button>
        <button type="button" className="btn btn-ghost" disabled={!job} onClick={async () => report(await call('cancel_learning_job', { job_id: job }), t('cl.cancelled'))}>{t('common.cancel')}</button>
      </div>
      {status && <p className="small">{t('cl.jobState', { state: fmt(status.state), detail: fmt(status.detail ?? '') })}</p>}
      <div className="row cl-actions">
        <label className="field">{t('cl.day')}<select value={shadowDay} onChange={(e) => setShadowDay(e.target.value)}>{[...dates].reverse().map((d) => <option key={d}>{d}</option>)}</select></label>
        <button type="button" className="btn btn-secondary" disabled={!job || !shadowDay} onClick={async () => { const r = await call('shadow_batch', { job_id: job, observation_day: shadowDay }); report(r, t('cl.shadowed', { day: shadowDay, prospective: r.ok && (r.data as Json).prospective ? t('common.yes') : t('common.no') })); }}>{t('cl.shadow')}</button>
        <button type="button" className="btn btn-secondary" disabled={!job} onClick={async () => { const r = await call('model_comparison', { job_id: job }); if (r.ok) setCmp(r.data as Json); else report(r, ''); }}>{t('cl.compare')}</button>
      </div>
      {cmp && <div className="cl-cmp">
        <p><b>{cmp.eligible_for_promotion ? t('cl.eligible') : t('cl.notEligible')}</b> · {t('cl.datesScored', { n: Number(cmp.dates_scored ?? 0), of: Number(cmp.expected_dates ?? 0) })}</p>
        {Array.isArray(cmp.blockers) && cmp.blockers.length > 0 && <p><b>{t('cl.blockersTitle')}</b> <span className="muted">{t('cl.blockersNote')}</span></p>}
        {Array.isArray(cmp.blockers) && cmp.blockers.length > 0 && <ul className="err">{(cmp.blockers as unknown[]).map((b, i) => <li key={i}>{String(b)}</li>)}</ul>}
        {cmp.recommendation != null && <p className="muted small">{String(cmp.recommendation)}</p>}
        <div className="row cl-actions">
          <label className="field grow">{t('cl.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
          <button type="button" className="btn btn-primary" disabled={!cmp.eligible_for_promotion || !reason.trim()} onClick={async () => report(await call('decide_model', { job_id: job, decision: 'activate', reason }), t('cl.activated'))}>{t('cl.activate')}</button>
          <button type="button" className="btn btn-secondary" disabled={!reason.trim()} onClick={async () => report(await call('decide_model', { job_id: job, decision: 'reject', reason }), t('cl.rejectedModel'))}>{t('cl.rejectModel')}</button>
        </div>
      </div>}
    </section>
  );
}

function Drift({ t, report }: { t: T; report: Report }) {
  const [w, setW] = useState({ baseline_start: '', baseline_end: '', recent_start: '', recent_end: '' });
  const [res, setRes] = useState<Json | null>(null);
  const shift = (res?.distribution_shift ?? {}) as Record<string, Json>;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{t('cl.drift')}</h2><p>{t('cl.driftSub')}</p></div></div>
      <div className="row cl-actions">{(Object.keys(w) as (keyof typeof w)[]).map((k) => <label key={k} className="field">{t(`cl.w.${k}` as never)}<input type="date" value={w[k]} onChange={(e) => setW({ ...w, [k]: e.target.value })} /></label>)}
        <button type="button" className="btn btn-secondary" disabled={Object.values(w).some((v) => !v)} onClick={async () => { const r = await call('drift_report', w); if (r.ok) setRes(r.data as Json); else report(r, ''); }}>{t('cl.runDrift')}</button></div>
      {res && <div className="table-scroll"><table className="data"><thead><tr><th>{t('cl.signal')}</th><th>{t('cl.metric')}</th><th className="r">{t('cl.distance')}</th><th className="r">{t('cl.matched')}</th><th>{t('col.status')}</th></tr></thead>
        <tbody>{Object.entries(shift).map(([k, s]) => <tr key={k}><td>{k}</td><td>{fmt(s.metric)}</td><td className="r num">{fmt(s.distance)}</td><td className="r num">{fmt(s.matched_rows)}</td><td>{fmt(s.status)}</td></tr>)}</tbody></table></div>}
    </section>
  );
}
