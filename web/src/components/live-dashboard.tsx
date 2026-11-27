'use client';

import { useEffect, useRef, useState } from 'react';
import { Activity, Clock3, Pause, Play, Radio, RotateCcw, SkipForward, Square } from 'lucide-react';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import type { ReplayPoint, ReplaySnapshot, ReplayWarning, Scope } from '@/lib/live-types';
import styles from './live-dashboard.module.css';

const scopeKinds = { network: 'Network', channel: 'Channel', merchant: 'Merchant', category: 'Merchant category' };
const channels: Record<string, string> = {
  all: 'Payment network', pos: 'POS terminals', ecommerce: 'E-commerce',
  mobile: 'Mobile app', nfc: 'Contactless', transfer: 'Bank transfer', unknown: 'Unknown channel',
};
const scopeLabel = ([kind, name]: Scope) => kind === 'channel' || kind === 'network' ? channels[name] ?? name : name;
const stamp = (time?: string | null) => time?.replace('T', ' ').slice(0, 19) || '—';
const minute = (time: string) => time.slice(11, 16);
const metric = (n?: number | null, formatter: (n: number) => string = fmtInt) => n == null ? '—' : formatter(n);
const fmtExpected = (n: number) => fmtNum(n, 1);
const isCollective = (w: ReplayWarning) => w.kind === 'Collective advisory';

async function request(params: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ReplaySnapshot> {
  const response = await fetch(`/api/v1/live?${params}`, {
    cache: 'no-store', signal, method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? 'Replay update failed.');
  return data;
}

function Chart({ title, points, mode, warnings = [] }: {
  title: string; points: ReplayPoint[]; mode: 'interval' | 'cumulative' | 'rejections' | 'accepted';
  warnings?: ReplayWarning[];
}) {
  if (!points.length) return null;
  const chart = {
    interval: { primary: 'observed', secondary: 'expected', unit: 'transactions' },
    cumulative: { primary: 'cumulative', secondary: 'cumulative_expected', unit: 'transactions' },
    rejections: { primary: 'rejections', secondary: 'cancellations', unit: 'attempts' },
    accepted: { primary: 'accepted_value', secondary: null, unit: 'DZD' },
  }[mode] as { primary: keyof ReplayPoint; secondary: keyof ReplayPoint | null; unit: string };
  const max = Math.max(1, ...points.map(p => Math.max(Number(p[chart.primary]),
    chart.secondary ? Number(p[chart.secondary]) : 0, mode === 'interval' ? p.upper : 0)));
  const x = (i: number) => 58 + (i / Math.max(1, points.length - 1)) * 555;
  const y = (n: number) => 153 - (n / max) * 122;
  function path(key: keyof ReplayPoint, reset = false) {
    return points.map((p, i) => {
      const gap = i === 0 || !points[i - 1].complete ||
        (reset && points[i - 1].time.slice(11, 16) === '00:00');
      return p.complete ? `${gap ? 'M' : 'L'} ${x(i)} ${y(Number(p[key]))}` : '';
    }).join(' ');
  }
  const band = [...points.map((p, i) => `${x(i)},${y(p.upper)}`),
    ...points.map((p, i) => `${x(i)},${y(p.lower)}`).reverse()].join(' ');
  const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const markers = warnings.flatMap(w => [
    { time: w.opened, id: w.id, text: w.symptom, recovery: false },
    ...w.timeline.filter(t => t.state === 'Resolved').map(t => ({ time: t.time, id: w.id, text: 'Resolved', recovery: true })),
  ]);
  return <figure className={styles.chart}>
    <figcaption><strong>{title}</strong><span>{chart.unit}</span></figcaption>
    <svg viewBox="0 0 630 184" role="img" aria-label={title}>
      {[0, .5, 1].map(f => <g key={f}>
        <line x1={58} x2={613} y1={y(f * max)} y2={y(f * max)} className={styles.gridline} />
        <text x={51} y={y(f * max) + 4} textAnchor="end">{mode === 'accepted' ? fmtInt(f * max) : fmtExpected(f * max)}</text>
      </g>)}
      {mode === 'interval' && points.length > 1 && <polygon points={band} className={styles.band} />}
      {mode === 'interval' && markers.map(m => {
        const index = points.findIndex(p => p.time === m.time);
        return index < 0 ? null : <line key={`${m.id}-${m.time}-${m.recovery}`} x1={x(index)} x2={x(index)}
          y1={26} y2={153} className={m.recovery ? styles.recovery : styles.marker}><title>{m.text}</title></line>;
      })}
      {chart.secondary && <path d={path(chart.secondary, mode === 'cumulative')} className={styles.secondary} />}
      <path d={path(chart.primary, mode === 'cumulative')} className={styles.primary} />
      {points.length === 1 && <circle cx={x(0)} cy={y(Number(points[0][chart.primary]))} r={4} className={styles.dot} />}
      {ticks.map(i => <text key={i} x={x(i)} y={174} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
        {minute(points[i].time)}
      </text>)}
    </svg>
    {chart.secondary && <div className={styles.legend}>
      <span><i />{mode === 'rejections' ? 'Rejected' : 'Observed'}</span>
      <span><i />{mode === 'rejections' ? 'Cancelled' : 'Expected'}</span>
      {mode === 'interval' && <span><i />90% model interval</span>}
    </div>}
  </figure>;
}

function Warnings({ title, values }: { title: string; values: ReplayWarning[] }) {
  return <section className="panel">
    <div className="panel-head"><div><h2>{title}</h2><p>{values.filter(w => w.state !== 'Resolved').length} active</p></div></div>
    {values.length ? <div className={styles.warningList}>{values.map(w => <details key={w.id}>
      <summary><span><strong>{w.symptom}</strong><small>{scopeLabel(w.scope)} · {stamp(w.opened)}</small></span>
        <span className="chip">{w.state}</span></summary>
      <div className={styles.detail}>
        <p>{w.explanation}</p>
        <p className="muted">{stamp(w.from)} to {stamp(w.through)} · Evidence score {fmtExpected(w.score)}
          {w.reference_days !== undefined && ` · ${w.reference_days} prior dates`}</p>
        {w.cusum && <p>Directional CUSUM ↓ {fmtExpected(w.cusum[0])} · ↑ {fmtExpected(w.cusum[1])}</p>}
        {w.merchants && <p><strong>Selected merchants</strong> {w.merchants.join(', ')}. Individually corroborated {w.corroborated?.join(', ') || 'none'}.</p>}
        <p>{w.action} {w.limitation}</p>
        <ol className={styles.timeline} aria-label="Warning timeline">{w.timeline.map((step, i) =>
          <li key={i}><time>{stamp(step.time)}</time> {step.state}</li>)}</ol>
      </div>
    </details>)}</div> : <p className={styles.empty}>No warnings in this replay yet.</p>}
  </section>;
}

export function LiveDashboard({ control }: { control: boolean }) {
  const [state, setState] = useState<ReplaySnapshot>();
  const [error, setError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ start: '', end: '', speed: 600, preset: 'ordinary' });
  const [scope, setScope] = useState<Scope>(['network', 'all']);
  const [limit, setLimit] = useState(288);
  const revision = useRef(0);
  const mutating = useRef(false);
  const params = new URLSearchParams({ kind: scope[0], name: scope[1], limit: String(limit) }).toString();

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const at = revision.current;
      try {
        if (!mutating.current) {
          const value = await request(params, undefined, controller.signal);
          if (!controller.signal.aborted && at === revision.current && !mutating.current) {
            setState(value);
            setError('');
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && at === revision.current) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [params]);

  async function command(action: string, value?: number) {
    if (mutating.current) return;
    mutating.current = true;
    revision.current++;
    setBusy(true);
    setCommandError('');
    try {
      const data = action === 'start'
        ? { action, ...form, start: form.start || state?.default_date, end: form.end || form.start || state?.default_date }
        : { action, speed: value };
      setState(await request(params, data));
      setError('');
    } catch (e) {
      setCommandError((e as Error).message);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }

  const points = state?.points ?? [];
  const point = points.at(-1);
  const warnings = state?.warnings ?? [];
  const current = state?.scope ?? scope;
  const visibleWarnings = warnings.filter(w => current[0] === 'network' ||
    (w.scope[0] === current[0] && w.scope[1] === current[1]) ||
    (current[0] === 'merchant' && w.merchants?.includes(current[1])));
  const unstarted = !state || ['idle', 'finished', 'stopped', 'failed'].includes(state.status);
  const metrics = state?.summary;
  const selectedOptions = (state?.scopes ?? [['network', 'all']]).filter(s => s[0] === scope[0]);

  return <div className={styles.workspace}>
    <section className={`panel ${styles.control}`}>
      <div className="panel-head"><div><h2>Simulated Live Monitoring — Historical Replay</h2>
        <p>Training archive · Archive-local clock · No production feed connected</p></div>
        <span className="chip"><Radio size={14} /> {state?.status ?? 'Connecting'}</span></div>
      <div className={styles.controls}>
        <label>Start date<input aria-label="Start date" type="date" min={state?.min_date} max={state?.max_date}
          value={unstarted ? form.start || state?.default_date || '' : state?.start || ''}
          disabled={!control || !unstarted || busy}
          onChange={e => setForm({ ...form, start: e.target.value })} /></label>
        <label>End date<input aria-label="End date" type="date" min={form.start || state?.min_date} max={state?.max_date}
          value={unstarted ? form.end || form.start || state?.default_date || '' : state?.end || ''}
          disabled={!control || !unstarted || busy}
          onChange={e => setForm({ ...form, end: e.target.value })} /></label>
        <label>Scenario<select value={unstarted ? form.preset : state?.preset} disabled={!control || !unstarted || busy}
          onChange={e => setForm({ ...form, preset: e.target.value })}>
          {Object.entries(state?.presets ?? {}).map(([key, name]) => <option value={key} key={key}>{name}</option>)}
        </select></label>
        <label>Playback speed<select value={unstarted ? form.speed : state?.speed} disabled={!control || busy}
          onChange={e => {
            const speed = Number(e.target.value);
            setForm({ ...form, speed });
            if (!unstarted) void command('speed', speed);
          }}>
          {(state?.speeds ?? [600]).map(speed => <option value={speed} key={speed}>{speed}×</option>)}
        </select></label>
      </div>
      {control ? <div className={styles.buttons}>
        <button className="btn btn-primary" disabled={busy || !state || !unstarted} onClick={() => command('start')}><Play />Start</button>
        {state?.status === 'running'
          ? <button className="btn btn-secondary" disabled={busy} onClick={() => command('pause')}><Pause />Pause</button>
          : <button className="btn btn-secondary" disabled={busy || state?.status !== 'paused'} onClick={() => command('resume')}><Play />Resume</button>}
        <button className="btn btn-secondary" disabled={busy || state?.status !== 'paused'} onClick={() => command('step')}><SkipForward />Step forward</button>
        <button className="btn btn-secondary" disabled={busy || unstarted} onClick={() => command('stop')}><Square />Stop</button>
        <button className="btn btn-secondary" disabled={busy || !state || state.status === 'idle'} onClick={() => command('reset')}><RotateCcw />Reset</button>
      </div> : <p className={styles.empty}>This account has read access. Replay controls require a separate permission.</p>}
      <div className={styles.clock}>
        <span><Clock3 size={15} /> <strong>Simulated time</strong> {stamp(state?.clock)}</span>
        <progress aria-label="Simulation progress" value={state?.progress ?? 0} max={1} />
        <span>{fmtPct(state?.progress ?? 0)}</span>
      </div>
      <p className={styles.feed}><Activity size={15} />{state?.feed ?? 'Waiting for replay'}
        {state?.watermark && ` · Watermark ${stamp(state.watermark)}`}</p>
      {error && <p className={styles.error} role="status">{error} Reconnecting automatically.</p>}
      {commandError && <p className={styles.error} role="alert">{commandError}</p>}
      {state?.status === 'failed' && <p className={styles.error} role="alert">Replay stopped while finalizing an interval. Review the local service log.</p>}
    </section>
    {state?.truth && <details className={`panel ${styles.truth}`}><summary>Synthetic scenario truth</summary>
      <p>{stamp(state.truth.onset)} to {stamp(state.truth.end)} · {state.truth.channel ? scopeLabel(['channel', state.truth.channel]) : 'Training archive scope'}
        {state.truth.merchants.length ? ` · ${state.truth.merchants.join(', ')}` : ''} · {state.truth.changed_events} changed events
        {state.truth.same_day_backlog && ' · Same-day backlog'}</p></details>}
    {state?.scopes && <>
      <section className="panel">
        <div className="panel-head"><div><h2>Live activity</h2><p>{scopeLabel(current)} · Finalized five-minute intervals</p></div></div>
        <div className={styles.controls}>
          <label>Scope<select value={scope[0]} onChange={e => {
            const kind = e.target.value;
            setScope((state.scopes ?? []).find(s => s[0] === kind) ?? ['network', 'all']);
          }}>{Object.entries(scopeKinds).filter(([key]) => state.scopes?.some(s => s[0] === key))
            .map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>Selection<select value={scope[1]} onChange={e => setScope([scope[0], e.target.value])}>
            {selectedOptions.map(key => <option value={key[1]} key={key[1]}>{scopeLabel(key)}</option>)}</select></label>
          <label>Window<select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={3}>Last 15 minutes</option><option value={12}>Last hour</option>
            <option value={72}>Last six hours</option><option value={288}>Current day</option></select></label>
        </div>
        <dl className={styles.metrics}>
          {[
            ['Received today', metric(point?.cumulative)], ['Expected this interval', metric(point?.expected, fmtExpected)],
            ['Current transactions/min', metric(metrics?.transactions_per_minute, fmtExpected)],
            ['Accepted value today', metric(point?.daily_value, fmtCompactDzd)],
            ['Rejection rate today', metric(metrics?.daily_rejection_rate, fmtPct)],
            ['Active early warnings', metric(metrics?.active_individual)], ['Active collective advisories', metric(metrics?.active_collective)],
            ['Affected merchants', metric(metrics?.affected_merchants)], ['Affected channels', metric(metrics?.affected_channels)],
            ['Last event', stamp(state.last_event)], ['Minutes since last event', metric(metrics?.minutes_since_event, fmtExpected)],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <div className={styles.charts}>
          <Chart title="Observed and expected activity" points={points} mode="interval" warnings={visibleWarnings} />
          <Chart title="Cumulative activity" points={points} mode="cumulative" />
          <Chart title="Rejections and cancellations" points={points} mode="rejections" />
          <Chart title="Accepted payment value" points={points} mode="accepted" />
        </div>
        {!points.length && <p className={styles.empty}>The first chart point appears after one finalized interval.</p>}
        <p className={styles.feed}>Reference {state.reference_days} prior dates · {fmtInt(state.reference_events ?? 0)} prior events
          {state.monitoring && ` · Directional CUSUM ↓ ${fmtExpected(state.monitoring.downward_cusum)} · ↑ ${fmtExpected(state.monitoring.upward_cusum)}`}</p>
        <p className={styles.feed}>Sparse scopes accumulate expected events before evaluating an activity window. Median accepted ticket
          {' '}{state.median_ticket == null ? '—' : fmtCompactDzd(state.median_ticket)} · Prior median
          {' '}{state.reference_median_ticket == null ? '—' : fmtCompactDzd(state.reference_median_ticket)}</p>
        {state.minimum_amount_tail != null && <p className={styles.feed}>Smallest merchant-relative amount tail this interval
          {' '}{fmtPct(state.minimum_amount_tail)} · Descriptive amount evidence</p>}
      </section>
      <div className={styles.duo}>
        <Warnings title="Intraday early warnings" values={visibleWarnings.filter(w => !isCollective(w))} />
        <Warnings title="Collective advisories" values={visibleWarnings.filter(isCollective)} />
      </div>
      <div className={styles.duo}>
        <section className="panel"><div className="panel-head"><div><h2>Transaction domain evidence</h2>
          <p>Recent contactless rule observations</p></div></div>
          <ul className={styles.list}>{(state.domain ?? []).slice(0, 10).map((d, i) =>
            <li key={i}>{stamp(d.time)} · {d.merchant} · {fmtCompactDzd(d.amount)} · {d.rule}</li>)}</ul>
          {!state.domain?.length && <p className={styles.empty}>No rule observations yet.</p>}
        </section>
        <section className="panel"><div className="panel-head"><div><h2>Simulated daily closure</h2>
          <p>Frozen merchant-day detector · Isolated replay results</p></div></div>
          <ul className={styles.list}>{(state.daily ?? []).map(d => <li key={d.date}>
            <strong>{d.date}</strong> · {d.status} · {d.scored} scored · {d.flagged.length} daily flags
            {d.flagged.length > 0 && <small>{d.flagged.map(m => m.merchant).join(', ')}</small>}
          </li>)}</ul>
          {!state.daily?.length && <p className={styles.empty}>Results appear when the simulated day closes.</p>}
        </section>
      </div>
    </>}
  </div>;
}
