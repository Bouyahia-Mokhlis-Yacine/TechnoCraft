'use client';
// One date-range control for the shared filter bar: a trigger showing "7 Nov – 13 Nov 2026" and a
// popover with presets and two months (one on phones). First click = start, second = end; Apply
// writes the hidden `from` / `to` fields the filter form already submits, Cancel restores the range.
// Dates stay ISO calendar strings (YYYY-MM-DD) throughout, both ends inclusive: no timezone shift.
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { fmtRange, intlLocale, type Locale } from '@/lib/format';
import { useT } from './i18n';

type Range = { from: string; to: string };
// Apply re-renders the filter form (it is keyed by the URL): the new control takes focus back once
let refocusAfterApply = false;
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(utc(s).getTime() + n * 864e5));
const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
const addMonths = (m: string, n: number) => { const d = utc(m); d.setUTCMonth(d.getUTCMonth() + n); return iso(d).slice(0, 7) + '-01'; };
const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
const fmt = (s: string, opts: Intl.DateTimeFormatOptions, l?: Locale) => utc(s).toLocaleDateString(intlLocale(l), { timeZone: 'UTC', ...opts });
/** French weeks start on Monday; the English grid keeps its Sunday start. */
const weekStart = (l: Locale) => (l === 'fr' ? 1 : 0);
/** Weekday initials in the locale, starting with the first day of the week (2026-11-01 is a Sunday). */
const weekDays = (l: Locale) => Array.from({ length: 7 }, (_, k) => fmt(addDays('2026-11-01', (k + weekStart(l)) % 7), { weekday: 'short' }, l).replace('.', '').slice(0, 2));

/** "14–20 nov. 2026" / "7–13 Nov 2026" (locale range formatting, both years when they differ). */
export function rangeLabel(r: Partial<Range>, empty: string, l?: Locale) {
  if (!r.from && !r.to) return empty;
  return fmtRange(r.from ?? r.to!, r.to ?? r.from!, l);
}

export function DateRange({ from, to, min, max, label, emptyLabel }: {
  from?: string; to?: string; min: string; max: string; label?: string; emptyLabel?: string;
}) {
  const t = useT(), l = t.locale;
  label ??= t('dr.period'); emptyLabel ??= t('dr.allDates');
  const WEEK = weekDays(l), ws = weekStart(l);
  // relative presets end on the latest date of the run, so a historical dataset opens on real data
  const presets: { key: string; label: string; range?: Range }[] = [
    { key: '7', label: t('dr.last', { n: 7 }), range: { from: addDays(max, -6) < min ? min : addDays(max, -6), to: max } },
    { key: '14', label: t('dr.last', { n: 14 }), range: { from: addDays(max, -13) < min ? min : addDays(max, -13), to: max } },
    { key: '30', label: t('dr.last', { n: 30 }), range: { from: addDays(max, -29) < min ? min : addDays(max, -29), to: max } },
    { key: 'all', label: t('dr.full'), range: { from: min, to: max } },
    { key: 'custom', label: t('dr.custom') },
  ];
  const applied: Partial<Range> = { from, to };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<Range>>(applied);
  const [view, setView] = useState(addMonths(monthStart(to ?? max), -1));   // left month; the right one holds the range end
  const [focus, setFocus] = useState(to ?? max);                // keyboard cursor
  const [hover, setHover] = useState<string | null>(null);
  const [alignRight, setAlignRight] = useState(false);   // open leftwards when the trigger sits near the right edge
  const wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const fromIn = useRef<HTMLInputElement>(null), toIn = useRef<HTMLInputElement>(null);
  const id = useId();

  const presetOf = (r: Partial<Range>) => presets.find((p) => p.range && p.range.from === r.from && p.range.to === r.to)?.key ?? (r.from ? 'custom' : '');
  const show = () => { const r = trigger.current?.getBoundingClientRect(); setAlignRight(!!r && r.left + 640 > window.innerWidth && r.right > 640); setDraft(applied); setView(addMonths(monthStart(applied.to ?? max), -1)); setFocus(applied.to ?? max); setOpen(true); };
  const close = (back = true) => { setOpen(false); setHover(null); if (back) trigger.current?.focus(); };
  const apply = () => {
    if (!draft.from) return;
    const r = { from: draft.from, to: draft.to ?? draft.from };
    fromIn.current!.value = r.from; toIn.current!.value = r.to;
    close();
    refocusAfterApply = true;
    fromIn.current!.form?.requestSubmit();
  };
  const pick = (d: string) => {
    if (d < min || d > max) return;
    // first click starts a new range; the second ends it (a click before the start restarts it)
    setDraft((r) => (!r.from || r.to || d < r.from ? { from: d, to: undefined } : { from: r.from, to: d }));
  };

  // the assistant's floating button would cover Apply on phones: hidden while the picker is open
  useEffect(() => { document.body.classList.toggle('dr-open', open); return () => document.body.classList.remove('dr-open'); }, [open]);
  useEffect(() => { if (refocusAfterApply) { refocusAfterApply = false; trigger.current?.focus(); } }, []);
  // close on an outside click; Escape anywhere in the popover
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  // keep keyboard focus on the cursor day
  useEffect(() => { if (open) wrap.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus({ preventScroll: true }); }, [open, focus, view]);

  const moveFocus = (d: string) => {
    const clamped = d < min ? min : d > max ? max : d;
    setFocus(clamped);
    // keep the cursor in a visible month (phones show only the right-hand month)
    const firstVisible = isPhone() ? addMonths(view, 1) : view;
    if (clamped < firstVisible || clamped >= addMonths(view, 2)) setView(addMonths(monthStart(clamped), -1));
  };
  const onGridKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); moveFocus(addDays(focus, step[e.key])); }
    else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); const m = utc(focus); m.setUTCMonth(m.getUTCMonth() + (e.key === 'PageUp' ? -1 : 1)); moveFocus(iso(m)); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const pos = (utc(focus).getUTCDay() - ws + 7) % 7; moveFocus(addDays(focus, e.key === 'Home' ? -pos : 6 - pos)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(focus); }
  };

  const end = draft.to ?? (draft.from && hover && hover > draft.from ? hover : undefined);
  const month = (start: string, i: number) => {
    const first = utc(start), lead = (first.getUTCDay() - ws + 7) % 7;
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, k) => addDays(start, k))];
    while (cells.length % 7) cells.push(null);
    return (
      <div className={`dr-month${i ? '' : ' dr-first'}`} key={start}>
        <div className="dr-month-head">
          {/* three slots: previous · month · next. Desktop: previous on the left month, next on the right one.
              Phones show only the right month, so its previous arrow appears there */}
          <button type="button" className={`dr-nav${i ? ' dr-phone' : ''}`} aria-label={t('dr.prevMonth')}
            onClick={() => setView(addMonths(view, -1))} disabled={addMonths(view, 1) <= monthStart(min)}><ChevronLeft /></button>
          <b id={`${id}-m${i}`}>{fmt(start, { month: 'long', year: 'numeric' }, l)}</b>
          <button type="button" className={`dr-nav${i ? '' : ' dr-hide'}`} aria-label={t('dr.nextMonth')} tabIndex={i ? 0 : -1} aria-hidden={i ? undefined : true}
            onClick={() => setView(addMonths(view, 1))} disabled={!i || addMonths(view, 1) >= monthStart(max)}><ChevronRight /></button>
        </div>
        <table className="dr-grid" role="grid" aria-labelledby={`${id}-m${i}`} onKeyDown={onGridKey}>
          <thead><tr>{WEEK.map((w) => <th key={w} scope="col" abbr={w}>{w}</th>)}</tr></thead>
          <tbody>{Array.from({ length: cells.length / 7 }, (_, r) => (
            <tr key={r}>{cells.slice(r * 7, r * 7 + 7).map((d, c) => {
              if (!d) return <td key={c} />;
              const out = d < min || d > max, isStart = d === draft.from, isEnd = d === end;
              const inside = !!(draft.from && end && d > draft.from && d < end);
              return (
                <td key={c} className={`${inside || ((isStart || isEnd) && draft.from && end && draft.from !== end) ? 'in' : ''}${isStart && end && end !== draft.from ? ' first' : ''}${isEnd && draft.from !== end ? ' last' : ''}`}>
                  <button type="button" data-day={d} tabIndex={d === focus ? 0 : -1} disabled={out}
                    className={`dr-day${isStart || isEnd ? ' edge' : ''}`} aria-pressed={isStart || isEnd}
                    aria-label={`${fmt(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, l)}${isStart ? `, ${t('dr.start')}` : ''}${isEnd ? `, ${t('dr.end')}` : ''}${out ? `, ${t('dr.noData')}` : ''}`}
                    onClick={() => { setFocus(d); pick(d); }} onMouseEnter={() => setHover(d)}>{Number(d.slice(8))}</button>
                </td>
              );
            })}</tr>
          ))}</tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="field dr" ref={wrap}>
      <span id={`${id}-l`}>{label}</span>
      <input ref={fromIn} type="hidden" name="from" defaultValue={from ?? ''} />
      <input ref={toIn} type="hidden" name="to" defaultValue={to ?? ''} />
      <button ref={trigger} type="button" className="dr-trigger" aria-haspopup="dialog" aria-expanded={open} aria-labelledby={`${id}-l ${id}-v`}
        onClick={() => (open ? close() : show())}>
        <span id={`${id}-v`}>{rangeLabel(applied, emptyLabel, l)}</span><ChevronDown aria-hidden />
      </button>
      {open && (
        <div className={`dr-pop${alignRight ? ' dr-right' : ''}`} role="dialog" aria-modal="false" aria-label={t('dr.choose')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <select className="dr-preset" aria-label={t('dr.preset')} value={presetOf(draft)} onChange={(e) => {
            const p = presets.find((x) => x.key === e.target.value);
            if (p?.range) { setDraft(p.range); setView(addMonths(monthStart(p.range.to), -1)); setFocus(p.range.to); }
          }}>
            {!presetOf(draft) && <option value="">{t('dr.choosePeriod')}</option>}
            {presets.map((p) => <option key={p.key} value={p.key} disabled={!p.range && presetOf(draft) !== 'custom'}>{p.label}</option>)}
          </select>
          <div className="dr-months">{month(view, 0)}{month(addMonths(view, 1), 1)}</div>
          <div className="dr-foot">
            <span className="dr-sel" aria-live="polite">{draft.from ? (draft.to ? rangeLabel(draft, '', l) : `${rangeLabel({ from: draft.from }, '', l)} – ${t('dr.pickEnd')}`) : t('dr.pickStart')}</span>
            <button type="button" className="btn btn-ghost" onClick={() => close()}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={apply} disabled={!draft.from}>{t('common.apply')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
