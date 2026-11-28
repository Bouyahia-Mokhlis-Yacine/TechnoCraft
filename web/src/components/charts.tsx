// Hand-drawn SVG charts in the "soft card" world: rounded bars, smooth areas with tag callouts,
// a separated pie, bubbles and progress rows. Motion comes from motion.css (grow, draw, pop).
import Link from 'next/link';
import type { Compare, SeriesPoint } from '@/lib/api';
import { fmtDay, fmtDelta, fmtInt, fmtNum, intlLocale, fmtPct } from '@/lib/format';
import { makeT, type Key, type Vars } from '@/lib/i18n';
import { fmtKind, type Kind } from '@/lib/labels';
import { ChartTip } from './charts-client';

const css = (o: Record<string, string | number>) => o as React.CSSProperties;

/** Axis label: 40K, 1,2 M, 6 % */
function axis(v: number, kind: Kind) {
  if (kind === 'pct') return `${fmtNum(v * 100, 0)} %`;
  if (v >= 1e6) return `${fmtNum(v / 1e6, 1)} M`;
  if (v >= 1e3) return `${fmtNum(v / 1e3, v >= 1e4 ? 0 : 1)}K`;
  return fmtInt(v);
}
/** Round the top of the scale to a readable step so gridlines land on clean numbers. */
function niceMax(v: number, kind: Kind) {
  if (kind === 'pct') return Math.max(0.05, Math.ceil(v * 20) / 20);
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return Math.ceil(v / p) * p;
}
const weekday = (iso: string) => new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
// server components: the request locale was set by the page (getT)
const tr = (key: string, vars?: Vars) => makeT()(key as Key, vars);

function Grid({ W, L, R, y, max, kind }: { W: number; L: number; R: number; y: (v: number) => number; max: number; kind: Kind }) {
  // pick a tick count that divides the scale into round numbers
  const ticks = kind === 'pct' ? 4 : [4, 3, 5, 2].find((t) => Number.isInteger(max / t)) ?? 4;
  return <>{Array.from({ length: ticks + 1 }, (_, i) => max * (i / ticks)).map((v) => (
    <g key={v}><line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text className="tick" x={L - 10} y={y(v) + 4} textAnchor="end">{axis(v, kind)}</text></g>
  ))}</>;
}

/** Paired rounded bars per day: usual (light) next to actual (dark), like a two-series report. */
export function PairBars({ points, height = 300, label, drill = false }: { points: (SeriesPoint & { anomalies?: number })[]; height?: number; label: string; drill?: boolean }) {
  const W = 760, H = height, L = 48, R = 8, T = 24, B = 40;
  const max = niceMax(Math.max(...points.flatMap((p) => [p.value, p.usual ?? 0])), 'int');
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const gw = (W - L - R) / points.length, bw = Math.min(16, gw * 0.3);
  return (
    <ChartTip>
    <svg className="chart interactive" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <Grid W={W} L={L} R={R} y={y} max={max} kind="int" />
      {points.map((p, i) => {
        const cx = L + gw * i + gw / 2;
        const tip = [`${weekday(p.date)} ${fmtDay(p.date)}`, tr('common.tx', { n: p.value }), ...(p.usual !== undefined ? [tr('chart.expected', { v: fmtInt(p.usual), d: fmtDelta(p.value, p.usual) })] : []), ...(p.anomalies ? [tr('chart.flaggedDays', { n: p.anomalies })] : []), ...(drill ? [p.anomalies ? tr('chart.clickAlerts') : tr('chart.clickTx')] : [])].join('\n');
        const bar = (v: number, x: number, cls: string, k: number) => (
          <rect className={`${cls} m-grow-up`} style={css({ '--i': i * 2 + k })} x={x} y={y(v)} width={bw} height={Math.max(0, y(0) - y(v))} />
        );
        const col = (
          <g key={p.date} className="col" data-tip={tip} data-date={p.date}>
            <rect className="hit" x={L + gw * i} y={T} width={gw} height={H - T - B} />
            {p.usual !== undefined && bar(p.usual, cx - bw - 3, 'bar-usual', 0)}
            {bar(p.value, cx + 3, 'bar-main', 1)}
            {!!p.anomalies && <g className="m-pop" style={css({ '--delay': `${600 + i * 30}ms` })}><circle className="count-dot" cx={cx + 3 + bw / 2} cy={y(p.value) - 14} r={9} /><text className="count-text" x={cx + 3 + bw / 2} y={y(p.value) - 10} textAnchor="middle">{p.anomalies}</text></g>}
            {p.holiday && <text className="holiday-label" x={cx} y={T - 8} textAnchor="middle">{tr('chart.holiday')}</text>}
            <text className="xlabel" x={cx} y={H - 20} textAnchor="middle">{weekday(p.date)}</text>
            <text className="xlabel sub" x={cx} y={H - 6} textAnchor="middle">{fmtDay(p.date)}</text>
          </g>
        );
        return drill ? <Link key={p.date} href={p.anomalies ? `/alerts?from=${p.date}&to=${p.date}` : `/transactions?from=${p.date}&to=${p.date}`}>{col}</Link> : col;
      })}
    </svg>
    </ChartTip>
  );
}

/** One rounded bar per day over the whole history; anomalous days take their severity colour and link to the alert. */
export function DayBars({ points, height = 280, width = 1100, label }: { points: SeriesPoint[]; height?: number; width?: number; label: string }) {
  const W = width, H = height, L = 48, R = 8, T = 22, B = 30;
  const max = niceMax(Math.max(...points.flatMap((p) => [p.value, p.hi ?? 0])), 'int');
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const gw = (W - L - R) / points.length, bw = Math.max(3, gw * 0.62);
  const usual = points.map((p, i) => (p.usual === undefined ? null : `${L + gw * i + gw / 2},${y(p.usual)}`)).filter(Boolean).join(' ');
  const step = Math.ceil(points.length / 8);
  return (
    <ChartTip>
    <svg className="chart interactive" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <Grid W={W} L={L} R={R} y={y} max={max} kind="int" />
      {points.map((p, i) => {
        const x = L + gw * i + (gw - bw) / 2;
        const tip = [`${weekday(p.date)} ${fmtDay(p.date)}${p.holiday ? ` · ${p.holiday}` : ''}`, tr('common.tx', { n: p.value }), ...(p.usual !== undefined ? [tr('chart.expected', { v: fmtInt(p.usual), d: fmtDelta(p.value, p.usual) })] : []), ...(p.severity ? [tr('chart.flaggedSev', { sev: tr(`sev.${p.severity}`) }), tr('chart.clickAlert')] : [])].join('\n');
        const col = (
          <g className="col" data-tip={tip} data-date={p.date}>
            <rect className="hit" x={L + gw * i} y={T} width={gw} height={H - T - B} />
            <rect className={`${p.severity ? `bar-sev sev-${p.severity}` : 'bar-main'} m-grow-up`} style={css({ '--i': Math.min(i, 60) * 0.4 })} x={x} y={y(Math.max(p.value, 0.15))} width={bw} height={Math.max(2, y(0) - y(p.value))} />
          </g>
        );
        return (
          <g key={p.date}>
            {p.anomalyId ? <Link href={`/alerts/${p.anomalyId}`}>{col}</Link> : col}
            {p.holiday && <text className="holiday-label" x={x + bw / 2} y={T - 8} textAnchor="middle">{p.holiday.split(' (')[0]}</text>}
            {(i % step === 0 || i === points.length - 1) && <text className="xlabel" x={x + bw / 2} y={H - 8} textAnchor="middle">{fmtDay(p.date)}</text>}
          </g>
        );
      })}
      {usual && <polyline className="usual m-fade" style={css({ '--delay': '500ms' })} points={usual} />}
    </svg>
    </ChartTip>
  );
}

/** Catmull-Rom → cubic Bézier, so the area reads as one smooth trend. */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i], pts[i], pts[i + 1], pts[i + 2] ?? pts[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Smooth area of one indicator with the usual line and tag callouts on anomalous days. */
export function AreaChart({ points, kind = 'int', highlight, height = 260, label }: { points: SeriesPoint[]; kind?: Kind; highlight?: string; height?: number; label: string }) {
  const W = 560, H = height, L = 48, R = 16, T = 40, B = 30;
  const max = niceMax(Math.max(...points.flatMap((p) => [p.value, p.hi ?? 0, p.usual ?? 0])) * 1.05, kind);
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - Math.min(v, max) / max) * (H - T - B);
  const pts = points.map((p, i) => [x(i), y(Math.max(0, p.value))] as [number, number]);
  const line = smooth(pts);
  const gid = `area-${kind}-${points[0]?.date}`;
  const usual = points.map((p, i) => (p.usual === undefined ? null : `${x(i)},${y(p.usual)}`)).filter(Boolean).join(' ');
  const step = Math.ceil(points.length / 5);
  const hi = points.findIndex((p) => p.date === highlight);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--chart-area-top)" /><stop offset="1" stopColor="var(--chart-area-top)" stopOpacity="0" /></linearGradient></defs>
      <Grid W={W} L={L} R={R} y={y} max={max} kind={kind} />
      <path className="m-fade" d={`${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${gid})`} />
      {usual && <polyline className="usual m-fade" style={css({ '--delay': '200ms' })} points={usual} />}
      <path className="series m-draw" style={css({ '--delay': '150ms' })} pathLength={1} d={line} />
      {points.map((p, i) => (i % step === 0 || i === points.length - 1) && <text key={p.date} className="xlabel" x={x(i)} y={H - 8} textAnchor="middle">{fmtDay(p.date)}</text>)}
      {points.map((p, i) => p.severity && i !== hi && (
        p.anomalyId
          ? <Link key={p.date} href={`/alerts/${p.anomalyId}`}><circle className={`pt sev-${p.severity} m-pop`} style={css({ '--delay': '900ms' })} cx={x(i)} cy={y(Math.max(0, p.value))} r={5}><title>{`${fmtDay(p.date)}: ${fmtKind(p.value, kind)}`}</title></circle></Link>
          : <circle key={p.date} className={`pt sev-${p.severity}`} cx={x(i)} cy={y(Math.max(0, p.value))} r={5} />
      ))}
      {hi >= 0 && (() => {
        const p = points[hi], cx = x(hi), cy = y(Math.max(0, p.value));
        const text = `${fmtKind(p.value, kind)} · usual ${fmtKind(p.usual ?? 0, kind)}`;
        const tw = text.length * 6.4 + 20, tx = Math.min(Math.max(cx - tw / 2, L), W - R - tw), ty = Math.max(4, cy - 40);
        return (
          <g className={`sev-${p.severity ?? 'low'}`}>
            <line className="tag-stem" x1={cx} x2={cx} y1={ty + 24} y2={cy} />
            <circle className="m-ring" style={css({ '--delay': '1000ms' })} cx={cx} cy={cy} r={7} />
            <circle className="pt m-pop" style={css({ '--delay': '950ms' })} cx={cx} cy={cy} r={7} />
            <g className="m-pop" style={css({ '--delay': '1050ms' })}><rect className="tag" x={tx} y={ty} width={tw} height={24} /><text className="tag-text" x={tx + tw / 2} y={ty + 16} textAnchor="middle">{text}</text></g>
          </g>
        );
      })()}
    </svg>
  );
}

/** Full pie with separated slices, read with its legend. */
export function Pie({ rows, size = 230 }: { rows: { label: string; value: number; color: string }[]; size?: number }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1, r = size / 2 - 4, c = size / 2;
  // start angle of each slice, computed up front (no mutation during render)
  const starts = rows.map((_, i) => -Math.PI / 2 + (rows.slice(0, i).reduce((s, x) => s + x.value, 0) / total) * Math.PI * 2);
  return (
    <svg className="pie m-pop" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={rows.map((x) => `${x.label} ${fmtPct(x.value / total, 0)}`).join(', ')}>
      {rows.map((s, i) => {
        const a0 = starts[i], a1 = a0 + (s.value / total) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0;
        const d = rows.length === 1 ? `M${c},${c - r} A${r},${r} 0 1 1 ${c - 0.01},${c - r} Z`
          : `M${c},${c} L${c + r * Math.cos(a0)},${c + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)} Z`;
        return <path key={s.label} d={d} fill={s.color} className="slice"><title>{`${s.label}: ${fmtInt(s.value)}`}</title></path>;
      })}
    </svg>
  );
}

/** Overlapping bubbles sized by count (alert mix). */
export function Bubbles({ items }: { items: { label: string; value: number; cls: string; href?: string }[] }) {
  const shown = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value).slice(0, 4);
  const max = Math.max(...shown.map((i) => i.value), 1);
  const spots = [[92, 104], [176, 62], [186, 150], [104, 186]];
  return (
    <ChartTip>
    <svg className="bubbles interactive" viewBox={`0 0 260 ${shown.length > 2 ? 240 : 200}`} role="img" aria-label={shown.map((i) => `${i.value} ${i.label}`).join(', ')}>
      {shown.map((b, i) => {
        const r = 30 + 44 * Math.sqrt(b.value / max) * (i === 0 ? 1 : 0.82);
        const g = (
          <g key={b.label} className={`bubble ${b.cls} m-pop`} style={css({ '--delay': `${i * 90}ms` })} data-tip={`${tr('chart.bubble', { n: b.value, sev: b.label.toLowerCase() })}${b.href ? `\n${tr('chart.clickThem')}` : ''}`}>
            <circle cx={spots[i][0]} cy={spots[i][1]} r={r} />
            <text x={spots[i][0]} y={spots[i][1] + 2} textAnchor="middle" className="b-num">{b.value}</text>
            <text x={spots[i][0]} y={spots[i][1] + 18} textAnchor="middle" className="b-lab">{b.label}</text>
          </g>
        );
        return b.href ? <Link key={b.label} href={b.href}>{g}</Link> : g;
      })}
    </svg>
    </ChartTip>
  );
}

/** Label, value on the right, rounded progress bar under it. */
export function ProgressRows({ rows }: { rows: { label: string; value: number; max: number; color?: string; right: React.ReactNode; mark?: number }[] }) {
  return (
    <div className="progress-rows">
      {rows.map((r, i) => (
        <div key={r.label} className="pr">
          <div className="pr-head"><span className="pr-label"><i className="dot" style={{ background: r.color ?? 'var(--primary)' }} />{r.label}</span><span className="pr-right num">{r.right}</span></div>
          <div className="pr-track">
            <span className="pr-fill m-grow-x" style={css({ width: `${Math.min(100, (r.value / (r.max || 1)) * 100)}%`, background: r.color ?? 'var(--primary)', '--i': i })} />
            {r.mark !== undefined && <span className="pr-mark" style={{ left: `${Math.min(100, (r.mark / (r.max || 1)) * 100)}%` }} title={tr('chart.usual')} />}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Sparkline({ values, delay = 0 }: { values: number[]; delay?: number }) {
  const max = Math.max(...values), min = Math.min(...values);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 120},${30 - ((v - min) / (max - min || 1)) * 26}`).join(' ');
  return <svg className="spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden><polyline className="m-draw" style={css({ '--delay': `${delay}ms` })} pathLength={1} points={pts} /></svg>;
}

/** The small chart on a KPI card: the formula's value per day. Gaps (no value that day) stay empty. */
export function KpiChart({ values, type, label }: { values: (number | null)[]; type: 'line' | 'area' | 'bars'; label: string }) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const max = Math.max(...nums, type === 'bars' ? 0 : -Infinity), min = type === 'bars' ? Math.min(0, ...nums) : Math.min(...nums);
  const W = 120, H = 32, y = (v: number) => H - 2 - ((v - min) / (max - min || 1)) * (H - 6), x = (i: number) => (i / Math.max(values.length - 1, 1)) * W;
  if (type === 'bars') {
    const bw = W / values.length;
    return (
      <svg className="kpi-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {values.map((v, i) => v === null ? null : <rect key={i} x={i * bw + bw * 0.15} width={bw * 0.7} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(0) - y(v)))} rx={Math.min(2, bw * 0.2)} />)}
      </svg>
    );
  }
  const pts = values.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  return (
    <svg className={`kpi-chart ${type}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {type === 'area' && <polygon points={`${pts} ${x(values.length - 1)},${H} 0,${H}`} />}
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 24 rounded hourly columns: that day (solid) over the usual profile (outline). */
export function HourBars({ rows }: { rows: Compare[] }) {
  const max = Math.max(...rows.flatMap((r) => [r.observed, r.usual]), 1);
  return (
    <div className="hours" role="img" aria-label={tr('chart.hoursLabel')}>
      {rows.map((r, i) => (
        <div key={r.label} className="hour" title={tr('chart.hourTip', { h: r.label, n: Math.round(r.observed), usual: fmtNum(r.usual, 1) })}>
          <span className="hour-usual" style={{ height: `${(r.usual / max) * 100}%` }} />
          <span className="hour-bar m-grow-up" style={css({ height: `${(r.observed / max) * 100}%`, '--i': i })} />
          {i % 3 === 0 && <span className="hour-label">{r.label}</span>}
        </div>
      ))}
    </div>
  );
}

/** Advisory forecast: expected count per day as a rounded bar, the 80 % interval as a whisker. */
export function ForecastBars({ points, height = 200 }: { points: { date: string; expected: number; lo: number; hi: number }[]; height?: number }) {
  const W = 420, H = height, L = 40, R = 8, T = 14, B = 34;
  const max = niceMax(Math.max(...points.map((p) => p.hi), 1), 'int');
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const gw = (W - L - R) / points.length, bw = Math.min(22, gw * 0.45);
  return (
    <ChartTip>
    <svg className="chart interactive" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('chart.forecastLabel', { n: points.length })}>
      <Grid W={W} L={L} R={R} y={y} max={max} kind="int" />
      {points.map((p, i) => {
        const cx = L + gw * i + gw / 2;
        return (
          <g key={p.date} className="col" data-date={p.date} data-tip={`${weekday(p.date)} ${fmtDay(p.date)}\n${tr('chart.about', { n: fmtInt(p.expected) })}\n${tr('chart.range80', { lo: fmtInt(p.lo), hi: fmtInt(p.hi) })}`}>
            <rect className="hit" x={L + gw * i} y={T} width={gw} height={H - T - B} />
            <rect className="bar-forecast m-grow-up" style={css({ '--i': i })} x={cx - bw / 2} y={y(p.expected)} width={bw} height={Math.max(0, y(0) - y(p.expected))} />
            <line className="whisker" x1={cx} x2={cx} y1={y(p.hi)} y2={y(p.lo)} />
            <line className="whisker" x1={cx - 5} x2={cx + 5} y1={y(p.hi)} y2={y(p.hi)} />
            <line className="whisker" x1={cx - 5} x2={cx + 5} y1={y(p.lo)} y2={y(p.lo)} />
            <text className="xlabel" x={cx} y={H - 18} textAnchor="middle">{weekday(p.date)}</text>
            <text className="xlabel sub" x={cx} y={H - 5} textAnchor="middle">{fmtDay(p.date)}</text>
          </g>
        );
      })}
    </svg>
    </ChartTip>
  );
}
