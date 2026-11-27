'use client';

import { useEffect, useRef, useState } from 'react';
import { Activity, Clock3, Pause, Play, Radio, RotateCcw, SkipForward, Square } from 'lucide-react';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import type { Key, T } from '@/lib/i18n';
import { useT } from './i18n';
import type { ReplayPoint, ReplaySnapshot, ReplayWarning, Scope } from '@/lib/live-types';
import styles from './live-dashboard.module.css';

const scopeKinds = ['network', 'channel', 'merchant', 'category'] as const;
/** A value from the replay service (status, state, symptom…) in the interface language; unknown values pass through. */
const tv = (t: T, prefix: string, v?: string | null) => { if (!v) return ''; const k = `${prefix}.${v}` as Key, s = t(k); return s === k ? v : s; };
const scopeLabel = (t: T, [kind, name]: Scope) => kind === 'channel' || kind === 'network' ? tv(t, 'live.ch', name) : name;
const stamp = (time?: string | null) => time?.replace('T', ' ').slice(0, 19) || '—';
const minute = (time: string) => time.slice(11, 16);
const metric = (n: number | null | undefined, formatter: (n: number) => string) => n == null ? '—' : formatter(n);
const isCollective = (w: ReplayWarning) => w.kind === 'Collective advisory';

async function request(params: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ReplaySnapshot> {
  const response = await fetch(`/api/v1/live?${params}`, {
    cache: 'no-store', signal, method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? '');
  return data;
}

function Chart({ title, points, mode, warnings = [], t }: {
  title: string; t: T; points: ReplayPoint[]; mode: 'interval' | 'cumulative' | 'rejections' | 'accepted';
  warnings?: ReplayWarning[];
}) {
  if (!points.length) return null;
  const chart = {
    interval: { primary: 'observed', secondary: 'expected', unit: t('live.unitTx') },
    cumulative: { primary: 'cumulative', secondary: 'cumulative_expected', unit: t('live.unitTx') },
    rejections: { primary: 'rejections', secondary: 'cancellations', unit: t('live.unitAttempts') },
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
    { time: w.opened, id: w.id, text: tv(t, 'live.symptom', w.symptom), recovery: false },
    ...w.timeline.filter(s => s.state === 'Resolved').map(s => ({ time: s.time, id: w.id, text: tv(t, 'live.state', 'Resolved'), recovery: true })),
  ]);
  return <figure className={styles.chart}>
    <figcaption><strong>{title}</strong><span>{chart.unit}</span></figcaption>
    <svg viewBox="0 0 630 184" role="img" aria-label={title}>
      {[0, .5, 1].map(f => <g key={f}>
        <line x1={58} x2={613} y1={y(f * max)} y2={y(f * max)} className={styles.gridline} />
        <text x={51} y={y(f * max) + 4} textAnchor="end">{mode === 'accepted' ? fmtInt(f * max, t.locale) : fmtNum(f * max, 1, t.locale)}</text>
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
      <span><i />{mode === 'rejections' ? t('live.rejected') : t('live.observed')}</span>
      <span><i />{mode === 'rejections' ? t('live.cancelled') : t('live.expected')}</span>
      {mode === 'interval' && <span><i />{t('live.interval90')}</span>}
    </div>}
  </figure>;
}

function Warnings({ title, values }: { title: string; values: ReplayWarning[] }) {
  const t = useT();
  return <section className="panel">
    <div className="panel-head"><div><h2>{title}</h2><p>{t('live.activeN', { n: values.filter(w => w.state !== 'Resolved').length })}</p></div></div>
    {values.length ? <div className={styles.warningList}>{values.map(w => <details key={w.id}>
      <summary><span><strong>{tv(t, 'live.symptom', w.symptom)}</strong><small>{scopeLabel(t, w.scope)} · {stamp(w.opened)}</small></span>
        <span className="chip">{tv(t, 'live.state', w.state)}</span></summary>
      <div className={styles.detail}>
        <p lang="en">{w.explanation}</p>
        <p className="muted">{t('live.fromTo', { from: stamp(w.from), to: stamp(w.through) })} · {t('live.score', { v: fmtNum(w.score, 1, t.locale) })}
          {w.reference_days !== undefined && ` · ${t('live.priorDates', { n: w.reference_days })}`}</p>
        {w.cusum && <p>{t('live.cusum')} ↓ {fmtNum(w.cusum[0], 1, t.locale)} · ↑ {fmtNum(w.cusum[1], 1, t.locale)}</p>}
        {w.merchants && <p><strong>{t('intel.selected')}</strong> {w.merchants.join(', ')}. {t('live.corroborated', { list: w.corroborated?.join(', ') || t('common.none').toLowerCase() })}</p>}
        <p lang="en">{w.action} {w.limitation}</p>
        <ol className={styles.timeline} aria-label={t('live.timeline')}>{w.timeline.map((step, i) =>
          <li key={i}><time>{stamp(step.time)}</time> {tv(t, 'live.state', step.state)}</li>)}</ol>
      </div>
    </details>)}</div> : <p className={styles.empty}>{t('live.noWarnings')}</p>}
  </section>;
}

export function LiveDashboard({ control }: { control: boolean }) {
  const t = useT();
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
      <div className="panel-head"><div><h2>{t('live.title')}</h2>
        <p>{t('live.sub')}</p></div>
        <span className="chip"><Radio size={14} /> {state ? tv(t, 'live.status', state.status) : t('live.connecting')}</span></div>
      <div className={styles.controls}>
        <label>{t('live.start')}<input type="date" min={state?.min_date} max={state?.max_date}
          value={unstarted ? form.start || state?.default_date || '' : state?.start || ''}
          disabled={!control || !unstarted || busy}
          onChange={e => setForm({ ...form, start: e.target.value })} /></label>
        <label>{t('live.end')}<input type="date" min={form.start || state?.min_date} max={state?.max_date}
          value={unstarted ? form.end || form.start || state?.default_date || '' : state?.end || ''}
          disabled={!control || !unstarted || busy}
          onChange={e => setForm({ ...form, end: e.target.value })} /></label>
        <label>{t('live.scenario')}<select value={unstarted ? form.preset : state?.preset} disabled={!control || !unstarted || busy}
          onChange={e => setForm({ ...form, preset: e.target.value })}>
          {Object.entries(state?.presets ?? {}).map(([key, name]) => <option value={key} key={key}>{tv(t, 'live.preset', key) === key ? name : tv(t, 'live.preset', key)}</option>)}
        </select></label>
        <label>{t('live.speed')}<select value={unstarted ? form.speed : state?.speed} disabled={!control || busy}
          onChange={e => {
            const speed = Number(e.target.value);
            setForm({ ...form, speed });
            if (!unstarted) void command('speed', speed);
          }}>
          {(state?.speeds ?? [600]).map(speed => <option value={speed} key={speed}>{speed}×</option>)}
        </select></label>
      </div>
      {control ? <div className={styles.buttons}>
        <button className="btn btn-primary" disabled={busy || !state || !unstarted} onClick={() => command('start')}><Play />{t('live.btnStart')}</button>
        {state?.status === 'running'
          ? <button className="btn btn-secondary" disabled={busy} onClick={() => command('pause')}><Pause />{t('live.btnPause')}</button>
          : <button className="btn btn-secondary" disabled={busy || state?.status !== 'paused'} onClick={() => command('resume')}><Play />{t('live.btnResume')}</button>}
        <button className="btn btn-secondary" disabled={busy || state?.status !== 'paused'} onClick={() => command('step')}><SkipForward />{t('live.btnStep')}</button>
        <button className="btn btn-secondary" disabled={busy || unstarted} onClick={() => command('stop')}><Square />{t('live.btnStop')}</button>
        <button className="btn btn-secondary" disabled={busy || !state || state.status === 'idle'} onClick={() => command('reset')}><RotateCcw />{t('common.reset')}</button>
      </div> : <p className={styles.empty}>{t('live.readOnly')}</p>}
      <div className={styles.clock}>
        <span><Clock3 size={15} /> <strong>{t('live.simTime')}</strong> {stamp(state?.clock)}</span>
        <progress aria-label={t('live.progress')} value={state?.progress ?? 0} max={1} />
        <span>{fmtPct(state?.progress ?? 0, 1, t.locale)}</span>
      </div>
      <p className={styles.feed}><Activity size={15} /><span lang={state?.feed ? 'en' : undefined}>{state?.feed ?? t('live.waiting')}</span>
        {state?.watermark && ` · ${t('live.watermark', { at: stamp(state.watermark) })}`}</p>
      {error && <p className={styles.error} role="status">{error || t('live.unavailable')} {t('live.reconnecting')}</p>}
      {commandError && <p className={styles.error} role="alert">{commandError || t('live.commandFailed')}</p>}
      {state?.status === 'failed' && <p className={styles.error} role="alert">{t('live.failed')}</p>}
    </section>
    {state?.truth && <details className={`panel ${styles.truth}`}><summary>{t('live.truth')}</summary>
      <p>{t('live.fromTo', { from: stamp(state.truth.onset), to: stamp(state.truth.end) })} · {state.truth.channel ? scopeLabel(t, ['channel', state.truth.channel]) : t('live.archiveScope')}
        {state.truth.merchants.length ? ` · ${state.truth.merchants.join(', ')}` : ''} · {t('live.changed', { n: state.truth.changed_events })}
        {state.truth.same_day_backlog && ` · ${t('live.backlog')}`}</p></details>}
    {state?.scopes && <>
      <section className="panel">
        <div className="panel-head"><div><h2>{t('live.activity')}</h2><p>{scopeLabel(t, current)} · {t('live.intervals')}</p></div></div>
        <div className={styles.controls}>
          <label>{t('live.scope')}<select value={scope[0]} onChange={e => {
            const kind = e.target.value;
            setScope((state.scopes ?? []).find(s => s[0] === kind) ?? ['network', 'all']);
          }}>{scopeKinds.filter((key) => state.scopes?.some(s => s[0] === key))
            .map((key) => <option key={key} value={key}>{t(`live.kind.${key}` as Key)}</option>)}</select></label>
          <label>{t('live.selection')}<select value={scope[1]} onChange={e => setScope([scope[0], e.target.value])}>
            {selectedOptions.map(key => <option value={key[1]} key={key[1]}>{scopeLabel(t, key)}</option>)}</select></label>
          <label>{t('live.window')}<select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={3}>{t('live.w15')}</option><option value={12}>{t('live.w60')}</option>
            <option value={72}>{t('live.w6h')}</option><option value={288}>{t('live.wDay')}</option></select></label>
        </div>
        <dl className={styles.metrics}>
          {[
            [t('live.mReceived'), metric(point?.cumulative, (n) => fmtInt(n, t.locale))], [t('live.mExpected'), metric(point?.expected, (n) => fmtNum(n, 1, t.locale))],
            [t('live.mRate'), metric(metrics?.transactions_per_minute, (n) => fmtNum(n, 1, t.locale))],
            [t('live.mValue'), metric(point?.daily_value, (n) => fmtCompactDzd(n, t.locale))],
            [t('live.mRej'), metric(metrics?.daily_rejection_rate, (n) => fmtPct(n, 1, t.locale))],
            [t('live.mWarn'), metric(metrics?.active_individual, (n) => fmtInt(n, t.locale))], [t('live.mColl'), metric(metrics?.active_collective, (n) => fmtInt(n, t.locale))],
            [t('live.mMerchants'), metric(metrics?.affected_merchants, (n) => fmtInt(n, t.locale))], [t('live.mChannels'), metric(metrics?.affected_channels, (n) => fmtInt(n, t.locale))],
            [t('live.mLast'), stamp(state.last_event)], [t('live.mSince'), metric(metrics?.minutes_since_event, (n) => fmtNum(n, 1, t.locale))],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <div className={styles.charts}>
          <Chart t={t} title={t('live.cInterval')} points={points} mode="interval" warnings={visibleWarnings} />
          <Chart t={t} title={t('live.cCumulative')} points={points} mode="cumulative" />
          <Chart t={t} title={t('live.cRej')} points={points} mode="rejections" />
          <Chart t={t} title={t('live.cValue')} points={points} mode="accepted" />
        </div>
        {!points.length && <p className={styles.empty}>{t('live.firstPoint')}</p>}
        <p className={styles.feed}>{t('live.reference', { days: state.reference_days ?? 0, events: fmtInt(state.reference_events ?? 0, t.locale) })}
          {state.monitoring && ` · ${t('live.cusum')} ↓ ${fmtNum(state.monitoring.downward_cusum, 1, t.locale)} · ↑ ${fmtNum(state.monitoring.upward_cusum, 1, t.locale)}`}</p>
        <p className={styles.feed}>{t('live.sparse')} {t('live.ticket', { now: state.median_ticket == null ? '—' : fmtCompactDzd(state.median_ticket, t.locale), prior: state.reference_median_ticket == null ? '—' : fmtCompactDzd(state.reference_median_ticket, t.locale) })}</p>
        {state.minimum_amount_tail != null && <p className={styles.feed}>{t('live.amountTail', { v: fmtPct(state.minimum_amount_tail, 1, t.locale) })}</p>}
      </section>
      <div className={styles.duo}>
        <Warnings title={t('live.early')} values={visibleWarnings.filter(w => !isCollective(w))} />
        <Warnings title={t('live.collective')} values={visibleWarnings.filter(isCollective)} />
      </div>
      <div className={styles.duo}>
        <section className="panel"><div className="panel-head"><div><h2>{t('live.domain')}</h2>
          <p>{t('live.domainSub')}</p></div></div>
          <ul className={styles.list}>{(state.domain ?? []).slice(0, 10).map((d, i) =>
            <li key={i}>{stamp(d.time)} · {d.merchant} · {fmtCompactDzd(d.amount, t.locale)} · {d.rule}</li>)}</ul>
          {!state.domain?.length && <p className={styles.empty}>{t('live.noDomain')}</p>}
        </section>
        <section className="panel"><div className="panel-head"><div><h2>{t('live.closure')}</h2>
          <p>{t('live.closureSub')}</p></div></div>
          <ul className={styles.list}>{(state.daily ?? []).map(d => <li key={d.date}>
            <strong>{d.date}</strong> · {tv(t, 'live.status', d.status)} · {t('live.scored', { n: d.scored })} · {t('live.dailyFlags', { n: d.flagged.length })}
            {d.flagged.length > 0 && <small>{d.flagged.map(m => m.merchant).join(', ')}</small>}
          </li>)}</ul>
          {!state.daily?.length && <p className={styles.empty}>{t('live.noClosure')}</p>}
        </section>
      </div>
    </>}
  </div>;
}
