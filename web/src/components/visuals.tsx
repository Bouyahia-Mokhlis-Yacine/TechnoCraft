// Visual-first building blocks: each one replaces a sentence with a picture of the same numbers.
// Every value comes from the caller (engine data); nothing here invents or rounds a figure it shows.
import Link from 'next/link';
import { ArrowRight, CircleHelp, Cog, UserRound, Wrench } from 'lucide-react';
import type { Severity } from '@/lib/api';
import { fmtInt, fmtNum, fmtPct, na } from '@/lib/format';
import { makeT, type Key, type Vars } from '@/lib/i18n';

// server components: the request locale was set by the page (getT)
const tr = (key: string, vars?: Vars) => makeT()(key as Key, vars);

const css = (o: Record<string, string | number>) => o as React.CSSProperties;
type Unit = 'tx' | 'ratio' | 'DZD';

/** Short value for gauges: 18, 3,5 %, 37 k DZD */
export function fmtShort(v: number | null, unit: Unit) {
  if (v === null) return na();
  if (unit === 'ratio') return fmtPct(v, v < 0.1 ? 1 : 0);
  if (unit === 'DZD') return v >= 1e6 ? `${fmtNum(v / 1e6, 1)}\u00a0M\u00a0DZD` : v >= 1e4 ? `${fmtInt(v / 1e3)}\u00a0k\u00a0DZD` : `${fmtInt(v)}\u00a0DZD`;
  return fmtInt(v);
}

/**
 * Observed vs expected on one line: the normal range is a band, the expected level a tick,
 * the observed value a dot coloured by severity. Far from the tick = far from normal.
 */
export function Gauge({ observed, expected, lo = null, hi = null, unit, severity = 'normal', size = 'sm', label, tone = 'surface' }: {
  observed: number | null; expected: number | null; lo?: number | null; hi?: number | null; unit: Unit;
  severity?: Severity | 'normal'; size?: 'sm' | 'lg'; label: string; tone?: 'surface' | 'hero';
}) {
  if (observed === null) return <span className="muted">{tr('vis.unavailable')}</span>;
  const max = Math.max(observed, expected ?? 0, hi ?? 0) * 1.15 || 1;
  const pc = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div className={`gauge gauge-${size} gauge-${tone} sev-${severity}`} role="img" aria-label={label} title={label}>
      {size === 'lg' && <span className="g-obs-label num" style={{ left: pc(observed) }}>{fmtShort(observed, unit)}</span>}
      <div className="g-track">
        {lo !== null && hi !== null && <span className="g-band" style={{ left: pc(lo), width: `calc(${pc(hi)} - ${pc(lo)})` }} />}
        {expected !== null && <span className="g-exp" style={{ left: pc(expected) }} />}
        <span className="g-dot m-pop" style={{ left: pc(observed) }} />
      </div>
      {size === 'lg' && expected !== null && (
        <span className="g-exp-label num" style={{ left: pc(expected) }}>
          expected {fmtShort(expected, unit)}{lo !== null && hi !== null ? <small> · normal {fmtShort(lo, unit)}–{fmtShort(hi, unit)}</small> : null}
        </span>
      )}
    </div>
  );
}

/** Table cell: tiny gauge plus "0 / 18". */
export function GaugeCell(p: { observed: number | null; expected: number | null; lo?: number | null; hi?: number | null; unit: Unit; severity?: Severity | 'normal'; label: string }) {
  if (p.expected === null) return <span className="gauge-cell num"><b>{fmtShort(p.observed, p.unit)}</b></span>;
  return (
    <span className="gauge-cell">
      <Gauge {...p} size="sm" />
      <span className="num"><b>{fmtShort(p.observed, p.unit)}</b><span className="muted"> / {fmtShort(p.expected, p.unit)}</span></span>
    </span>
  );
}

const OWNER_ICON: Record<string, typeof UserRound> = { 'Operations analyst': UserRound, 'Technical investigator': Wrench, 'technical investigator': Wrench, 'Analyste d’exploitation': UserRound, 'Enquêteur technique': Wrench, 'enquêteur technique': Wrench };

/** Who acts and the checks in order. The cause stays unconfirmed. */
export function NextSteps({ owner, steps, href }: { owner: string; steps: string[]; href?: { to: string; label: string } }) {
  const owners = owner.split(' + ');
  return (
    <div className="next-steps">
      <div className="ns-owners">{owners.map((o) => { const I = OWNER_ICON[o] ?? Cog; return <span key={o} className="ns-owner"><I aria-hidden />{o[0].toUpperCase() + o.slice(1)}</span>; })}</div>
      <ol className="ns-list">{steps.map((s, i) => <li key={s} className="m-rise" style={css({ '--i': i })}><span className="ns-n">{i + 1}</span>{s}</li>)}</ol>
      <p className="ns-foot"><CircleHelp aria-hidden />{tr('vis.causeUnconfirmed')}{href && <> · <Link href={href.to}>{href.label} <ArrowRight aria-hidden /></Link></>}</p>
    </div>
  );
}

/** Priority as a stacked bar: each factor's weighted points, summing to the score. */
export function PriorityStack({ total, parts }: { total: number; parts: { key: string; label: string; weight: number; value: number; detail: string }[] }) {
  const pts = parts.map((p) => ({ ...p, pts: 100 * p.weight * p.value }));
  return (
    <div className="prio-stack">
      <div className="ps-row"><b className="ps-total num">{total}<small>/100</small></b>
      <div className="ps-bar" role="img" aria-label={tr('vis.priorityAria', { total, parts: pts.map((p) => tr('vis.ptsOf', { label: p.label, pts: fmtNum(p.pts, 0), of: fmtNum(p.weight * 100, 1) })).join(', ') })}>
        {pts.map((p, i) => <span key={p.key} className={`ps-seg ps-${p.key} m-grow-x`} style={css({ width: `${p.pts}%`, '--i': i })} title={tr('vis.ptsOfTitle', { label: p.label, pts: fmtNum(p.pts, 0), of: fmtNum(p.weight * 100, 1) })} />)}
      </div></div>
      <ul className="ps-legend">
        {pts.map((p) => (
          <li key={p.key}>
            <i className={`ps-sw ps-${p.key}`} aria-hidden />
            <span><b>{p.label}</b><small>{p.detail}</small></span>
            <span className="num ps-pts"><b>{fmtNum(p.pts, 0)}</b><small>/{fmtNum(p.weight * 100, 1)}</small></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One tile per merchant: fill height = share declined; ring = flagged. */
export function MerchantTiles({ items }: { items: { id: string; k: number; n: number; affected: boolean; flagged: boolean }[] }) {
  return (
    <>
      <div className="m-tiles">
        {items.map((m, i) => {
          const r = m.n ? m.k / m.n : 0;
          const state = m.flagged ? 'flagged' : m.affected ? 'affected' : 'normal';
          return (
            <Link key={m.id} href={`/merchants/${m.id}`} className={`m-tile t-${state} m-pop`} style={css({ '--fill': `${r * 100}%`, '--delay': `${Math.min(i, 24) * 20}ms` })}
              aria-label={`${m.id} : ${tr('vis.declinedOf', { k: m.k, n: m.n })}${m.flagged ? `, ${tr('vis.flagged').toLowerCase()}` : m.affected ? `, ${tr('vis.corroborated').toLowerCase()}` : ''}`} title={`${m.id} · ${tr('vis.declinedOf', { k: m.k, n: m.n })}`}>
              <span className="mt-fill" /><span className="mt-id">{m.id.replace('MER-', '')}</span><span className="mt-r num">{m.k}/{m.n}</span>
            </Link>
          );
        })}
      </div>
      <div className="legend m-tiles-legend">
        <span><i className="lg-flagged" />{tr('vis.flagged')}</span><span><i className="lg-affected" />{tr('vis.corroborated')}</span><span><i className="lg-normal" />{tr('sev.normal')}</span><span><i className="lg-fill" />{tr('vis.fill')}</span>
      </div>
    </>
  );
}

/** Rates side by side on one scale (this channel vs expected vs the rest). */
export function RateBars({ rows, tone = 'surface' }: { rows: { label: string; value: number | null; hot?: boolean }[]; tone?: 'surface' | 'hero' }) {
  const max = Math.max(...rows.map((r) => r.value ?? 0), 0.0001);
  return (
    <div className={`rate-bars rb-${tone}`}>
      {rows.map((r, i) => (
        <div key={r.label} className={`rb${r.hot ? ' hot' : ''}`}>
          <span className="rb-label">{r.label}</span>
          <span className="rb-track"><span className="rb-fill m-grow-x" style={css({ width: `${((r.value ?? 0) / max) * 100}%`, '--i': i })} /></span>
          <b className="num">{fmtShort(r.value, 'ratio')}</b>
        </div>
      ))}
    </div>
  );
}

/** A left-to-right pipeline: start count, the changes, end count. */
export function Pipeline({ start, end, steps }: { start: { label: string; value: number }; end: { label: string; value: number }; steps: { label: string; value: number; kind: 'removed' | 'fixed' | 'kept' }[] }) {
  return (
    <div className="pipeline">
      <div className="pl-end"><b className="num">{fmtInt(start.value)}</b><small>{start.label}</small></div>
      <ol className="pl-steps">
        {steps.filter((s) => s.value > 0).map((s, i) => (
          <li key={s.label} className={`pl-${s.kind} m-rise`} style={css({ '--i': i })}>
            <b className="num">{s.kind === 'removed' ? '−' : ''}{fmtInt(s.value)}</b><small>{s.label}</small>
          </li>
        ))}
      </ol>
      <div className="pl-end pl-out"><b className="num">{fmtInt(end.value)}</b><small>{end.label}</small></div>
    </div>
  );
}

/** Caught / missed / false as unit dots, one per labelled day. */
export function HitDots({ hit, miss, falsePos }: { hit: number; miss: number; falsePos: number }) {
  const dots = [...Array(hit).fill('hit'), ...Array(miss).fill('miss'), ...Array(falsePos).fill('false')];
  return (
    <div className="hit-dots">
      <div className="hd-grid" role="img" aria-label={tr('vis.hitDots', { hit, miss, fp: falsePos })}>
        {dots.map((d, i) => <i key={i} className={`hd hd-${d} m-pop`} style={css({ '--delay': `${Math.min(i, 30) * 18}ms` })} />)}
      </div>
      <div className="legend"><span><i className="lg-hit" />{tr('vis.caught', { n: hit })}</span><span><i className="lg-miss" />{tr('vis.missed', { n: miss })}</span><span><i className="lg-false" />{tr('vis.falseAlerts', { n: falsePos })}</span></div>
    </div>
  );
}

/** Small "i" disclosure for method notes: shown on demand, not by default. */
export function MethodNote({ children, label }: { children: React.ReactNode; label?: string }) {
  label ??= tr('common.howComputed');
  return <details className="method"><summary><CircleHelp aria-hidden />{label}</summary><div className="method-body">{children}</div></details>;
}

const CF_LABEL: Record<string, string> = {
  s_drop: 'Transactions that day', s_surge: 'Transactions that day', s_drop_sustained: 'Transactions over 3 days', s_surge_sustained: 'Transactions over 3 days',
  s_decline: 'Declines', s_cancel: 'Cancellations', s_decline_channel: 'Declines on one channel', s_incident: 'Declines on the incident channel', s_amount: 'Typical payment',
};
type CF = { signal: string; op: '>=' | '<='; bound: number; observed: number; unit: 'tx' | 'count' | 'DZD'; of?: number; channel?: string; scope: string };

/** What would have been normal: the normal zone of each signal that fired, and the observed value. */
export function Counterfactuals({ items, severity, threshold }: { items: CF[]; severity: Severity; threshold: number }) {
  return (
    <div className="cf-rows">
      {items.map((c, i) => {
        const max = Math.max(c.observed, c.bound, 1) * 1.2;
        const pc = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
        const unit = c.unit === 'DZD' ? 'DZD' : c.unit === 'tx' ? 'tx' : c.signal.includes('cancel') ? 'cancellations' : 'declines';
        const v = (x: number) => (c.unit === 'DZD' ? fmtShort(x, 'DZD') : fmtInt(x));
        const gap = Math.abs(c.observed - c.bound);
        const need = c.unit === 'DZD' ? `${c.op === '<=' ? 'at most' : 'at least'} ${v(c.bound)}`
          : c.op === '>=' ? `${fmtInt(gap)} more ${c.unit === 'tx' ? 'transactions' : unit}` : `${fmtInt(gap)} fewer ${c.unit === 'tx' ? 'transactions' : unit}`;
        const label = `${CF_LABEL[c.signal] ?? c.signal}${c.channel ? ` · ${c.channel}` : ''}: observed ${v(c.observed)}${c.of ? ` of ${fmtInt(c.of)}` : ''}; normal ${c.op === '>=' ? 'from' : 'up to'} ${v(c.bound)}`;
        return (
          <div key={i} className="cf-row">
            <div className="cf-head"><b>{CF_LABEL[c.signal] ?? c.signal}</b>{c.channel && <small>{c.channel}</small>}</div>
            <div className={`cf-track sev-${severity}`} role="img" aria-label={label} title={label}>
              <span className="cf-zone" style={c.op === '>=' ? { left: pc(c.bound), right: 0 } : { left: 0, width: pc(c.bound) }} />
              <span className="cf-bound" style={{ left: pc(c.bound) }} />
              <span className="cf-dot m-pop" style={{ left: pc(c.observed) }} />
            </div>
            <div className="cf-text num">
              <span><b>{v(c.observed)}</b>{c.of ? <small> of {fmtInt(c.of)}</small> : null} {c.unit !== 'DZD' && unit}</span>
              <span className="cf-need">normal {c.op === '>=' ? '≥' : '≤'} {v(c.bound)} · <b>{need}</b></span>
            </div>
          </div>
        );
      })}
      <p className="ns-foot"><CircleHelp aria-hidden />{tr('vis.bounds', { threshold })}</p>
    </div>
  );
}

/** Health score: one number plus the share each component contributes. */
export function HealthMeter({ score, parts, coverage }: { score: number | null; coverage: number; parts: { label: string; level: 'ok' | 'watch' | 'issue' | 'unknown'; detail: string; share: number; weight: number }[] }) {
  return (
    <div className="hm">
      <div className="hm-top">
        <b className={`hm-score num hm-${score === null ? 'unknown' : score >= 80 ? 'ok' : score >= 50 ? 'watch' : 'issue'}`}>{score ?? '—'}<small>/100</small></b>
        <div className="hm-bar" role="img" aria-label={tr('vis.healthAria', { score: score ?? tr('health.unknown'), parts: parts.map((p) => `${p.label} : ${tr(`health.${p.level}`)}`).join(', ') })}>
          {parts.map((p, i) => <span key={p.label} className={`hm-seg hm-${p.level} m-grow-x`} style={css({ flexGrow: p.weight, '--i': i })} title={`${p.label} : ${tr(`health.${p.level}`)} · ${p.detail}`} />)}
        </div>
      </div>
      {coverage < 0.999 && <p className="ns-foot"><CircleHelp aria-hidden />{tr('vis.coverage', { pct: fmtPct(coverage, 0) })}</p>}
      <MethodNote>
        {tr('vis.hmRule')}
        <ul className="hm-criteria">{parts.map((p) => <li key={p.label}><b>{p.label}</b> · {tr('vis.hmWeight', { w: fmtPct(p.weight, 0) })} · {tr(`health.${p.level}`)}{p.level === 'unknown' ? ` (${tr('vis.hmExcluded')})` : ''}</li>)}</ul>
      </MethodNote>
    </div>
  );
}
