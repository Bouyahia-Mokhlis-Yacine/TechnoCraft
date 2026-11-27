'use client';
// What-if and review-cost simulators. All baselines come from the engine snapshot (passed in by the
// server page). Scenario controls feed deterministic planning arithmetic.
import { useMemo, useState } from 'react';

import { dzd as dzdL, fmt as fmtL, simulate, type Baseline, type Curve } from '@/lib/simulate';
import { na } from '@/lib/format';
import { categoryLabel, channelLabel } from '@/lib/labels';
import { useT } from './i18n';
export type { Baseline };

export function WhatIf({ base }: { base: Baseline }) {
  const t = useT(), l = t.locale;
  const fmt = (v: number, d = 0) => fmtL(v, d, l), dzd = (v: number) => dzdL(v, l);
  const [mode, setMode] = useState<'outage' | 'declines'>('outage');
  const [channel, setChannel] = useState(base.channels[0] ?? '');
  const [category, setCategory] = useState('');
  const [weekend, setWeekend] = useState(0);
  const [start, setStart] = useState(10);
  const [hours, setHours] = useState(3);
  const [rate, setRate] = useState(40);
  const [activity, setActivity] = useState(100);
  const [amount, setAmount] = useState(100);
  const [days, setDays] = useState(1);

  const res = useMemo(() => simulate(base, { mode, channel, category, weekend, start, hours, rate, activity, amount, days }), [base, mode, channel, category, weekend, start, hours, rate, activity, amount, days]);

  const max = Math.max(...res.profile, 0.001);
  return (
    <div className="sim">
      <div className="sim-controls">
        <div className="seg" role="radiogroup" aria-label={t('sim.disruption')}>
          <button type="button" className={mode === 'outage' ? 'on' : ''} onClick={() => setMode('outage')} aria-pressed={mode === 'outage'}>{t('sim.outage')}</button>
          <button type="button" className={mode === 'declines' ? 'on' : ''} onClick={() => setMode('declines')} aria-pressed={mode === 'declines'}>{t('sim.declineSurge')}</button>
        </div>
        <label className="field">{t('f.channel')}<select value={channel} onChange={(e) => setChannel(e.target.value)}>{mode === 'outage' && <option value="">{t('f.allChannels')}</option>}{base.channels.map((c) => <option key={c} value={c}>{channelLabel(c, l)}</option>)}</select></label>
        <label className="field">{t('f.category')}<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">{t('common.all')}</option>{base.categories.map((c) => <option key={c} value={c}>{categoryLabel(c, l)}</option>)}</select></label>
        <label className="field">{t('al.day')}<select value={weekend} onChange={(e) => setWeekend(Number(e.target.value))}><option value={0}>{t('sim.weekday')}</option><option value={1}>{t('sim.weekend')}</option></select></label>
        <label className="field">{t('sim.startsAt')}<select value={start} onChange={(e) => { const hour = Number(e.target.value); setStart(hour); setHours(Math.min(hours, 24 - hour)); }}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
        <label className="field range"><span>{t('sim.lasts')} <b>{hours} h</b></span><input type="range" min={1} max={24 - start} value={Math.min(hours, 24 - start)} onChange={(e) => setHours(Number(e.target.value))} /></label>
        {mode === 'declines' && <label className="field range"><span>{t('sim.declined')} <b>{rate} %</b></span><input type="range" min={5} max={100} step={5} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>}
        <label className="field range"><span>{t('sim.activity')} <b>{activity} %</b></span><input type="range" min={0} max={200} step={5} value={activity} onChange={(e) => setActivity(Number(e.target.value))} /></label>
        <label className="field range"><span>{t('sim.value')} <b>{amount} %</b></span><input type="range" min={0} max={200} step={5} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
        <label className="field">{t('sim.duration')}<input type="number" min={1} max={7} value={days} onChange={(e) => setDays(Math.min(7, Math.max(1, Number(e.target.value))))} /></label>
      </div>

      <div className="sim-hours" role="img" aria-label={t('sim.hoursAria', { a: start, b: start + hours })}>
        {res.profile.map((v, h) => (
          <div key={h} className={`sh${h >= start && h < start + hours ? ' hit' : ''}`} title={`${String(h).padStart(2, '0')}:00 · ${t('chart.about', { n: fmt(v, 1) })}`}>
            <span style={{ height: `${(v / max) * 100}%` }} />{h % 3 === 0 && <small>{String(h).padStart(2, '0')}</small>}
          </div>
        ))}
      </div>

      <div className="mini-kpis sim-kpis">
        <div><b>{res.affected === null ? na(l) : fmt(res.affected)}</b><span>{mode === 'outage' ? t('sim.lost') : t('sim.extraDeclines')}</span></div>
        <div><b>{res.value === null ? na(l) : dzd(res.value)}</b><span>{t('sim.grossValue')}</span></div>
        <div><b>{res.touched}<small>/{res.cohort}</small></b><span>{t('sim.touched')}</span></div>
      </div>
      <p className="ns-foot">{t('sim.foot', { from: base.from, to: base.asOf })}</p>
    </div>
  );
}

export function ReviewCost({ curve, policy, trainEnd }: { curve: Curve; policy: number; trainEnd: string }) {
  const t = useT(), l = t.locale;
  const fmt = (v: number, d = 0) => fmtL(v, d, l), dzd = (v: number) => dzdL(v, l);
  const [review, setReview] = useState(2000);
  const [missed, setMissed] = useState(50000);
  const rows = curve.map((c) => ({ ...c, cost: (c.tp + c.fp) * review + c.fn * missed }));
  const best = rows.reduce((b, r) => (r.cost < b.cost ? r : b), rows[0]);
  const max = Math.max(...rows.map((r) => r.cost), 1);
  if (!rows.length) return <p className="muted">{t('sim.noCurve')}</p>;
  return (
    <div className="sim">
      <div className="sim-controls">
        <label className="field">{t('sim.reviewCost')}<input type="number" min={0} step={500} value={review} onChange={(e) => setReview(Math.max(0, Number(e.target.value)))} /></label>
        <label className="field">{t('sim.missedCost')}<input type="number" min={0} step={5000} value={missed} onChange={(e) => setMissed(Math.max(0, Number(e.target.value)))} /></label>
      </div>
      <p className="ns-foot">{t('sim.costFoot', { date: trainEnd })}</p>
      <div className="cost-bars" role="img" aria-label={rows.map((r) => t('sim.thresholdCost', { th: fmt(r.threshold, 2), cost: dzd(r.cost) })).join('; ')}>
        {rows.map((r) => (
          <div key={r.threshold} className={`cb${r.threshold === best.threshold ? ' best' : ''}${r.threshold === policy ? ' policy' : ''}`} title={t('sim.thresholdTip', { th: fmt(r.threshold, 2), tp: r.tp, fp: r.fp, fn: r.fn, cost: dzd(r.cost) })}>
            <span className="cb-col"><span style={{ height: `${(r.cost / max) * 100}%` }} /></span>
            <small className="num">{fmt(r.threshold, 1)}</small>
          </div>
        ))}
      </div>
      <div className="mini-kpis">
        <div><b>{fmt(best.threshold, 1)}</b><span>{t('sim.cheapest')}</span></div>
        <div><b>{dzd(best.cost)}</b><span>{t('sim.costThere')}</span></div>
        <div><b>{dzd(rows.find((r) => r.threshold === policy)?.cost ?? 0)}</b><span>{t('sim.costPolicy', { p: fmt(policy, 2) })}</span></div>
        <div><b>{best.tp}/{best.tp + best.fn}</b><span>{t('sim.caughtFalse', { n: best.fp })}</span></div>
      </div>
    </div>
  );
}
