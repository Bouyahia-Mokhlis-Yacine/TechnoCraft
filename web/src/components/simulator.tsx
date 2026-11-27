'use client';
// What-if and review-cost simulators. All baselines come from the engine snapshot (passed in by the
// server page). Scenario controls feed deterministic planning arithmetic.
import { useMemo, useState } from 'react';

import { dzd, fmt, simulate, type Baseline, type Curve } from '@/lib/simulate';
export type { Baseline };

export function WhatIf({ base }: { base: Baseline }) {
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
        <div className="seg" role="radiogroup" aria-label="Disruption">
          <button type="button" className={mode === 'outage' ? 'on' : ''} onClick={() => setMode('outage')} aria-pressed={mode === 'outage'}>Outage</button>
          <button type="button" className={mode === 'declines' ? 'on' : ''} onClick={() => setMode('declines')} aria-pressed={mode === 'declines'}>Decline surge</button>
        </div>
        <label className="field">Channel<select value={channel} onChange={(e) => setChannel(e.target.value)}>{mode === 'outage' && <option value="">All channels</option>}{base.channels.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Category<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All</option>{base.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Day<select value={weekend} onChange={(e) => setWeekend(Number(e.target.value))}><option value={0}>Weekday</option><option value={1}>Friday–Saturday</option></select></label>
        <label className="field">Starts at<select value={start} onChange={(e) => { const hour = Number(e.target.value); setStart(hour); setHours(Math.min(hours, 24 - hour)); }}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
        <label className="field range"><span>Lasts <b>{hours} h</b></span><input type="range" min={1} max={24 - start} value={Math.min(hours, 24 - start)} onChange={(e) => setHours(Number(e.target.value))} /></label>
        {mode === 'declines' && <label className="field range"><span>Declined <b>{rate} %</b></span><input type="range" min={5} max={100} step={5} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>}
        <label className="field range"><span>Daily activity <b>{activity} %</b></span><input type="range" min={0} max={200} step={5} value={activity} onChange={(e) => setActivity(Number(e.target.value))} /></label>
        <label className="field range"><span>Payment value <b>{amount} %</b></span><input type="range" min={0} max={200} step={5} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
        <label className="field">Duration (days)<input type="number" min={1} max={7} value={days} onChange={(e) => setDays(Math.min(7, Math.max(1, Number(e.target.value))))} /></label>
      </div>

      <div className="sim-hours" role="img" aria-label={`Expected transactions per hour on the chosen channels; hours ${start} to ${start + hours} disrupted`}>
        {res.profile.map((v, h) => (
          <div key={h} className={`sh${h >= start && h < start + hours ? ' hit' : ''}`} title={`${String(h).padStart(2, '0')}:00 · about ${fmt(v, 1)} transactions`}>
            <span style={{ height: `${(v / max) * 100}%` }} />{h % 3 === 0 && <small>{String(h).padStart(2, '0')}</small>}
          </div>
        ))}
      </div>

      <div className="mini-kpis sim-kpis">
        <div><b>{res.affected === null ? 'n/a' : fmt(res.affected)}</b><span>{mode === 'outage' ? 'transactions lost' : 'extra declines'}</span></div>
        <div><b>{res.value === null ? 'n/a' : dzd(res.value)}</b><span>gross affected value estimate</span></div>
        <div><b>{res.touched}<small>/{res.cohort}</small></b><span>merchants touched</span></div>
      </div>
      <p className="ns-foot">Hypothetical planning estimate. The model forecast supplies volume, outcomes and payment value. Historical hourly channel shares cover {base.from} – {base.asOf}. Each day uses the same selected profile.</p>
    </div>
  );
}

export function ReviewCost({ curve, policy, trainEnd }: { curve: Curve; policy: number; trainEnd: string }) {
  const [review, setReview] = useState(2000);
  const [missed, setMissed] = useState(50000);
  const rows = curve.map((c) => ({ ...c, cost: (c.tp + c.fp) * review + c.fn * missed }));
  const best = rows.reduce((b, r) => (r.cost < b.cost ? r : b), rows[0]);
  const max = Math.max(...rows.map((r) => r.cost), 1);
  if (!rows.length) return <p className="muted">No validation curve in this run.</p>;
  return (
    <div className="sim">
      <div className="sim-controls">
        <label className="field">Cost of one analyst review (DZD)<input type="number" min={0} step={500} value={review} onChange={(e) => setReview(Math.max(0, Number(e.target.value)))} /></label>
        <label className="field">Cost of one missed anomaly day (DZD)<input type="number" min={0} step={5000} value={missed} onChange={(e) => setMissed(Math.max(0, Number(e.target.value)))} /></label>
      </div>
      <p className="ns-foot">Both costs are your assumptions (the defaults are only examples). Outcomes come from the labelled training period, up to {trainEnd}.</p>
      <div className="cost-bars" role="img" aria-label={rows.map((r) => `threshold ${r.threshold}: ${dzd(r.cost)}`).join('; ')}>
        {rows.map((r) => (
          <div key={r.threshold} className={`cb${r.threshold === best.threshold ? ' best' : ''}${r.threshold === policy ? ' policy' : ''}`} title={`Threshold ${r.threshold}: ${r.tp} caught, ${r.fp} false alerts, ${r.fn} missed · ${dzd(r.cost)}`}>
            <span className="cb-col"><span style={{ height: `${(r.cost / max) * 100}%` }} /></span>
            <small className="num">{fmt(r.threshold, 1)}</small>
          </div>
        ))}
      </div>
      <div className="mini-kpis">
        <div><b>{fmt(best.threshold, 1)}</b><span>cheapest threshold</span></div>
        <div><b>{dzd(best.cost)}</b><span>cost at that threshold</span></div>
        <div><b>{dzd(rows.find((r) => r.threshold === policy)?.cost ?? 0)}</b><span>cost at the current policy ({policy})</span></div>
        <div><b>{best.tp}/{best.tp + best.fn}</b><span>anomaly days caught · {best.fp} false alerts</span></div>
      </div>
    </div>
  );
}
