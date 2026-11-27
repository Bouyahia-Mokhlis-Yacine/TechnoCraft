'use client';
// "Customize KPIs" on the Overview: each account picks its own cards, the chart under each, and can
// define a KPI by formula over the named measures. Formulas are checked as they are typed (same
// parser as the server) and again by the server when saved.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { CHARTS, DEFAULT_KPIS, FORMATS, GOOD, MAX_KPIS, MEASURES, parse, type KpiCard, type Measure } from '@/lib/formula';

export function KpiEditor({ initial }: { initial: KpiCard[] }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const formulas = useRef<(HTMLInputElement | null)[]>([]);
  const [cards, setCards] = useState(initial);
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = () => { setCards(initial); setError(null); dialog.current?.showModal(); };
  const set = (i: number, patch: Partial<KpiCard>) => setCards((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, by: number) => setCards((cs) => { const n = [...cs], [c] = n.splice(i, 1); n.splice(i + by, 0, c); return n; });
  const add = () => { setCards((cs) => [...cs, { id: `k-${Date.now().toString(36)}`, label: 'New KPI', formula: '', format: 'int', chart: 'line', good: 'up' }]); setFocus(cards.length); };
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
      if (!res.ok) { setError((await res.json()).error?.message ?? 'Could not save.'); return; }
      dialog.current?.close();
      router.refresh();
    } catch { setError('Could not reach the server.'); } finally { setSaving(false); }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={open}><SlidersHorizontal aria-hidden />Customize KPIs</button>
      <dialog ref={dialog} className="kpi-dialog" aria-labelledby="kpi-dialog-title">
        <div className="kpi-dialog-head">
          <h2 id="kpi-dialog-title">Your KPIs</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}><X /></button>
        </div>
        <p className="muted">Pick what you track and how it is drawn. Not in the list? Write its formula from the measures below, e.g. <code>declined / transactions</code> or <code>accepted_value / days</code>. Overview filters apply to every card.</p>

        <ol className="kpi-edit-list">
          {cards.map((c, i) => {
            const p = checks[i];
            return (
              <li key={c.id} className={i === focus ? 'is-focus' : undefined} onFocusCapture={() => setFocus(i)}>
                <div className="kpi-edit-row">
                  <label className="field grow">Name<input value={c.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} /></label>
                  <label className="field grow2">Formula
                    <input ref={(el) => { formulas.current[i] = el; }} value={c.formula} spellCheck={false} aria-invalid={!p.ok} aria-describedby={`kpi-err-${c.id}`}
                      onChange={(e) => set(i, { formula: e.target.value })} placeholder="e.g. declined / transactions" />
                  </label>
                  <div className="kpi-edit-tools">
                    <button type="button" className="icon-btn" aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></button>
                    <button type="button" className="icon-btn" aria-label={`Move ${c.label} down`} disabled={i === cards.length - 1} onClick={() => move(i, 1)}><ArrowDown /></button>
                    <button type="button" className="icon-btn" aria-label={`Remove ${c.label}`} disabled={cards.length === 1} onClick={() => { setCards((cs) => cs.filter((_, j) => j !== i)); setFocus(0); }}><Trash2 /></button>
                  </div>
                </div>
                <div className="kpi-edit-row">
                  <label className="field">Shown as<select value={c.format} onChange={(e) => set(i, { format: e.target.value as KpiCard['format'] })}>{Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                  <label className="field">Chart<select value={c.chart} onChange={(e) => set(i, { chart: e.target.value as KpiCard['chart'] })}>{Object.entries(CHARTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                  <label className="field">Change colour<select value={c.good} onChange={(e) => set(i, { good: e.target.value as KpiCard['good'] })}>{Object.entries(GOOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                </div>
                <p id={`kpi-err-${c.id}`} className={p.ok ? 'kpi-edit-ok' : 'err'} role={p.ok ? undefined : 'alert'}>
                  {p.ok ? `Uses: ${p.uses.map((m) => MEASURES[m].label.toLowerCase()).join(', ') || 'numbers only'}${c.format === 'pct' ? ' · a ratio like 0.05 shows as 5 %' : ''}` : p.error}
                </p>
              </li>
            );
          })}
        </ol>

        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={add} disabled={cards.length >= MAX_KPIS}><Plus aria-hidden />Add KPI</button>
          <button type="button" className="btn btn-ghost" onClick={() => setCards(DEFAULT_KPIS)}>Reset to the default six</button>
        </div>

        <details className="kpi-measures" open>
          <summary>Measures (click one to insert it in the formula you are editing)</summary>
          <ul>
            {(Object.keys(MEASURES) as Measure[]).map((m) => (
              <li key={m}><button type="button" onClick={() => insert(m)}><code>{m}</code></button><span>{MEASURES[m].help}</span></li>
            ))}
          </ul>
          <p className="muted">Combine them with + − × ÷ and parentheses. A card shows “—” when a measure has no value (for example no prior period) or a division by zero.</p>
        </details>

        {error && <p className="err" role="alert">{error}</p>}
        <div className="kpi-dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </dialog>
    </>
  );
}
