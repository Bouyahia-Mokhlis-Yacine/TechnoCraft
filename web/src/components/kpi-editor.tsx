'use client';
// "Customize KPIs" on the Overview: each account picks its own cards, the chart under each, and can
// define a KPI by formula over the named measures. Formulas are checked as they are typed (same
// parser as the server) and again by the server when saved.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, Pencil, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { CHARTS, DEFAULT_KPIS, FORMATS, GOOD, MAX_KPIS, MEASURES, SUGGESTED_KPIS, evaluate, kpiLabel, parse, type KpiCard, type Measure, type Parsed, type Values } from '@/lib/formula';
import { fmtDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { useT } from './i18n';
import type { Key } from '@/lib/i18n';

/** values: the measures for the Overview's current filters, for the live preview of each formula. */
export function KpiEditor({ initial, values }: { initial: KpiCard[]; values: Values }) {
  const router = useRouter(), t = useT();
  const tk = (k: string, v?: Record<string, string | number>) => t(k as Key, v);
  const dialog = useRef<HTMLDialogElement>(null);
  const formulas = useRef<(HTMLInputElement | null)[]>([]);
  const [cards, setCards] = useState(() => initial.map((c) => ({ ...c, label: kpiLabel(c, t as never) })));
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // built-in cards open with their name in the operator's language
  const open = () => { setCards(initial.map((c) => ({ ...c, label: kpiLabel(c, t as never) }))); setError(null); dialog.current?.showModal(); };
  const set = (i: number, patch: Partial<KpiCard>) => setCards((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, by: number) => setCards((cs) => { const n = [...cs], [c] = n.splice(i, 1); n.splice(i + by, 0, c); return n; });
  const add = (preset?: Omit<KpiCard, 'id'>) => { setCards((cs) => [...cs, { id: `k-${Date.now().toString(36)}`, ...(preset ? { ...preset, label: kpiLabel({ id: '', ...preset }, t as never) } : { label: tk('kpi.newKpi'), formula: '', format: 'int', chart: 'line', good: 'none' }) }]); setFocus(cards.length); };
  /** Clicking a measure inserts it at the cursor of the formula being edited. */
  const insert = (m: Measure) => {
    const el = formulas.current[focus], c = cards[focus];
    if (!c) return;
    const at = el?.selectionStart ?? c.formula.length, end = el?.selectionEnd ?? at;
    const before = c.formula.slice(0, at), after = c.formula.slice(end);
    const pad = (s: string) => (s && !/[\s(]$/.test(s) ? `${s} ` : s);
    set(focus, { formula: `${pad(before)}${m}${after && !/^[\s)]/.test(after) ? ' ' : ''}${after}` });
    requestAnimationFrame(() => el?.focus());
  };
  const checks = cards.map((c) => parse(c.formula));
  const valid = cards.length > 0 && checks.every((p) => p.ok) && cards.every((c) => c.label.trim());

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/v1/kpis', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kpis: cards }) });
      if (!res.ok) { setError((await res.json()).error?.message ?? tk('kpi.saveFailed')); return; }
      dialog.current?.close();
      router.refresh();
    } catch { setError(tk('kpi.unreachable')); } finally { setSaving(false); }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={open}><SlidersHorizontal aria-hidden />{tk('kpi.customize')}</button>
      <dialog ref={dialog} className="kpi-dialog" aria-labelledby="kpi-dialog-title">
        <div className="kpi-dialog-head">
          <h2 id="kpi-dialog-title">{tk('kpi.yours')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={() => dialog.current?.close()}><X /></button>
        </div>
        <p className="muted">{tk('kpi.intro1')} <code>declined / transactions</code> {tk('kpi.or')} <code>accepted_value / days</code>. {tk('kpi.intro2')}</p>

        <div className="kpi-suggest" role="group" aria-label={tk('kpi.suggested')}>
          <span className="muted">{tk('kpi.suggested')}</span>
          {SUGGESTED_KPIS.map((p) => {
            const used = cards.some((c) => c.formula === p.formula);
            return <button key={p.label} type="button" className="chip-btn" disabled={used || cards.length >= MAX_KPIS} aria-pressed={used} title={p.formula} onClick={() => add(p)}><Plus aria-hidden />{kpiLabel({ id: '', ...p }, t as never)}</button>;
          })}
        </div>

        <ol className="kpi-edit-list">
          {cards.map((c, i) => {
            const p = checks[i], open = i === focus;
            const preview = p.ok ? show(evaluate(p.tree, values), c.format, t.locale) : null;
            const tools = (
              <div className="kpi-edit-tools">
                <button type="button" className="icon-btn" aria-label={tk('kpi.up', { name: c.label })} disabled={i === 0} onClick={() => { move(i, -1); if (open) setFocus(i - 1); }}><ArrowUp /></button>
                <button type="button" className="icon-btn" aria-label={tk('kpi.down', { name: c.label })} disabled={i === cards.length - 1} onClick={() => { move(i, 1); if (open) setFocus(i + 1); }}><ArrowDown /></button>
                <button type="button" className="icon-btn" aria-label={tk('kpi.remove', { name: c.label })} disabled={cards.length === 1} onClick={() => { setCards((cs) => cs.filter((_, j) => j !== i)); setFocus(0); }}><Trash2 /></button>
              </div>
            );
            if (!open) return (
              <li key={c.id} className={`kpi-collapsed${p.ok ? '' : ' bad'}`}>
                <button type="button" className="kpi-collapsed-main" aria-expanded={false} onClick={() => setFocus(i)}>
                  <Pencil aria-hidden /><b>{c.label || tk('kpi.newKpi')}</b><code>{c.formula || '—'}</code>
                  <span className="num">{p.ok ? preview : tk('kpi.invalid')}</span>
                </button>
                {tools}
              </li>
            );
            return (
              <li key={c.id} className="is-focus" onFocusCapture={() => setFocus(i)}>
                <div className="kpi-edit-row">
                  <label className="field grow">{tk('kpi.name')}<input value={c.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} /></label>
                  {tools}
                  <ChevronDown aria-hidden className="kpi-open-ico" />
                </div>
                <div className="kpi-edit-row">
                  <label className="field grow2">{tk('kpi.formula')}
                    <input ref={(el) => { formulas.current[i] = el; }} value={c.formula} spellCheck={false} aria-invalid={!p.ok} aria-describedby={`kpi-err-${c.id}`}
                      onChange={(e) => set(i, { formula: e.target.value })} placeholder={tk('kpi.placeholder')} />
                  </label>
                  <label className="field grow">{tk('kpi.insert')}
                    <select value="" onChange={(e) => { if (e.target.value) insert(e.target.value as Measure); }}>
                      <option value="">{tk('kpi.choose')}</option>
                      {(Object.keys(MEASURES) as Measure[]).map((m) => <option key={m} value={m} title={tk(`measure.${m}.help`)}>{tk(`measure.${m}`)} · {m}</option>)}
                    </select>
                  </label>
                </div>
                <p id={`kpi-err-${c.id}`} className={p.ok ? 'kpi-edit-ok' : 'err'} role={p.ok ? 'status' : 'alert'}>
                  {p.ok ? <><b>{tk('kpi.preview', { v: preview ?? '' })}</b> · {tk('kpi.uses', { list: p.uses.map((m) => tk(`measure.${m}`).toLowerCase()).join(', ') || tk('kpi.numbersOnly') })}{c.format === 'pct' ? ` · ${tk('kpi.pctHint')}` : ''}</> : parseError(p, tk)}
                </p>
                {p.ok && p.mixesNow && <p className="kpi-warn" role="status"><AlertTriangle aria-hidden />{tk('kpi.warnNow')}</p>}
                <div className="kpi-edit-row">
                  <label className="field">{tk('kpi.shownAs')}<select value={c.format} onChange={(e) => set(i, { format: e.target.value as KpiCard['format'] })}>{Object.keys(FORMATS).map((k) => <option key={k} value={k}>{tk(`kpi.format.${k}`)}</option>)}</select></label>
                  <label className="field">{tk('kpi.chart')}<select value={c.chart} onChange={(e) => set(i, { chart: e.target.value as KpiCard['chart'] })}>{Object.keys(CHARTS).map((k) => <option key={k} value={k}>{tk(`kpi.chart.${k}`)}</option>)}</select></label>
                  <label className="field">{tk('kpi.good')}<select value={c.good} onChange={(e) => set(i, { good: e.target.value as KpiCard['good'] })}>{Object.keys(GOOD).map((k) => <option key={k} value={k}>{tk(`kpi.good.${k}`)}</option>)}</select></label>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={() => add()} disabled={cards.length >= MAX_KPIS}><Plus aria-hidden />{tk('kpi.add')}</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setCards(DEFAULT_KPIS.map((c) => ({ ...c, label: kpiLabel(c, t as never) }))); setFocus(0); }}>{tk('kpi.resetDefault')}</button>
        </div>

        <details className="kpi-measures">
          <summary>{tk('kpi.measures')}</summary>
          <ul>
            {(Object.keys(MEASURES) as Measure[]).map((m) => (
              <li key={m}><button type="button" onClick={() => insert(m)}><code>{m}</code></button><span>{tk(`measure.${m}.help`)}</span></li>
            ))}
          </ul>
          <p className="muted">{tk('kpi.combine')}</p>
        </details>

        {error && <p className="err" role="alert">{error}</p>}
        <div className="kpi-dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!valid || saving} onClick={save}>{saving ? t('common.saving') : t('common.save')}</button>
        </div>
      </dialog>
    </>
  );
}

/** The preview in the card's own display format. */
function show(v: number | null, format: KpiCard['format'], l: 'fr' | 'en') {
  if (v === null) return '—';
  return format === 'pct' ? fmtPct(v, 1, l) : format === 'dzd' ? fmtDzd(v, l) : format === 'num' ? fmtNum(v, 1, l) : fmtInt(v, l);
}

function parseError(p: Extract<Parsed, { ok: false }>, tk: (k: string, v?: Record<string, string | number>) => string) {
  const k = `kpi.err.${p.code}`, s = tk(k, { arg: p.arg ?? '' });
  return s === k ? p.error : s;
}
