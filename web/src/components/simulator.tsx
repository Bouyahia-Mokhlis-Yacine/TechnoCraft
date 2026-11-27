'use client';
// What-if and review-cost simulators. All baselines come from the engine snapshot (passed in by the
// server page); the disruption and the costs are the user's assumptions. The flag test is the
// engine's own: negative binomial for counts, binomial (Bonferroni over channels) for declines.
import { useMemo, useState } from 'react';
import Link from 'next/link';

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

  const res = useMemo(() => simulate(base, { mode, channel, category, weekend, start, hours, rate }), [base, mode, channel, category, weekend, start, hours, rate]);

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
        <label className="field">Starts at<select value={start} onChange={(e) => setStart(Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
        <label className="field range"><span>Lasts <b>{hours} h</b></span><input type="range" min={1} max={24} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
        {mode === 'declines' && <label className="field range"><span>Declined <b>{rate} %</b></span><input type="range" min={5} max={100} step={5} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>}
      </div>

      <div className="sim-hours" role="img" aria-label={`Expected transactions per hour on the chosen channels; hours ${start} to ${start + hours} disrupted`}>
        {res.profile.map((v, h) => (
          <div key={h} className={`sh${h >= start && h < start + hours ? ' hit' : ''}`} title={`${String(h).padStart(2, '0')}:00 · about ${fmt(v, 1)} transactions`}>
            <span style={{ height: `${(v / max) * 100}%` }} />{h % 3 === 0 && <small>{String(h).padStart(2, '0')}</small>}
          </div>
        ))}
      </div>

      <div className="mini-kpis sim-kpis">
        <div><b>{fmt(res.affected)}</b><span>{mode === 'outage' ? 'transactions lost' : 'extra declines'}</span></div>
        <div><b>{dzd(res.value)}</b><span>value at risk (estimate)</span></div>
        <div><b>{res.touched}<small>/{res.cohort}</small></b><span>merchants touched</span></div>
        <div className={res.flagged.length ? 'warn' : ''}><b>{res.flagged.length}</b><span>the engine would flag</span></div>
      </div>
      {res.advisory !== null && <p className={`sim-adv${res.advisory ? ' on' : ''}`}>{res.advisory ? `A network advisory on ${channel} would open (channel test ≥ ${base.incidentMin}).` : `Not enough for a network advisory on ${channel}.`}</p>}
      {res.flagged.length > 0 && <div className="cluster-members">{res.flagged.map((id) => <Link key={id} href={`/merchants/${id}`} className="inc-chip"><b>{id}</b></Link>)}</div>}
      {mode === 'outage' && channel && res.flagged.length === 0 && res.affected > 0 && <p className="ns-foot">The count test looks at each merchant’s whole day across channels, so an outage on one channel is diluted by the others.</p>}
      <p className="ns-foot">Baseline: each merchant’s same-day-type median and hourly mix over {base.from} – {base.asOf}. Value uses each merchant’s median accepted payment. The disruption itself is an assumption.</p>
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
