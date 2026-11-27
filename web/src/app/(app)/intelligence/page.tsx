import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { getMeta, listAdvisories } from '@/lib/api';
import { fmtDate, fmtNum, fmtPct } from '@/lib/format';
import { Gauge, MethodNote, RateBars } from '@/components/visuals';
import { listClusters } from '@/lib/insights';
import { EmptyState, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Intelligence' };

export default function IntelligencePage() {
  const ads = listAdvisories();
  const meta = getMeta();
  const scan = listClusters();
  return (
    <>
      <PageHeader title="Network intelligence" />
      {ads.length ? ads.map((a, i) => {
        const affected = a.members.filter((m) => m.affected).length;
        return (
          <Link key={a.id} href={`/intelligence/${a.id}`} className="panel advisory-card m-rise" style={{ '--i': i } as React.CSSProperties}>
            <div className="adv-main">
              <span className="muted">{fmtDate(a.date)}</span>
              <h2>{a.channel}: high declines</h2>
              <p>{fmtPct(a.observed_rate, 0)} declined vs {fmtPct(a.expected_rate, 1)} expected · {affected} of {a.members.length} merchants affected</p>
            </div>
            <div className="adv-score"><b>{fmtNum(a.score, 0)}</b><small>score · alert at {fmtNum(a.threshold, 0)}</small></div>
            <ArrowRight className="chev" aria-hidden />
          </Link>
        );
      }) : <EmptyState title="No network advisory in this run">No channel showed excess declines across merchants at the same time.</EmptyState>}
      {scan && (
        <>
          <h2 className="section-h">Collective anomalies<small>Groups of merchants abnormal together · subset scan of {scan.units_scanned} days and channel-days</small></h2>
          {scan.clusters.length ? scan.clusters.map((c, i) => (
            <details key={c.id} className="panel cluster m-rise" style={{ '--i': i } as React.CSSProperties}>
              <summary>
                <div className="adv-main">
                  <span className="muted">{fmtDate(c.date)}{c.advisory ? ` · also network advisory ${c.advisory}` : ' · not seen by the channel test'}</span>
                  <h2>{c.kind === 'declines' ? `${c.channel}: ${c.members.length} merchants with excess declines` : `${c.members.length} merchants with a joint activity drop`}</h2>
                  {c.kind === 'declines'
                    ? <RateBars rows={[{ label: 'Group', value: c.observed / Math.max(1, c.members.reduce((s, x) => s + (x.total ?? 0), 0)), hot: true }, { label: 'Expected', value: c.expected / Math.max(1, c.members.reduce((s, x) => s + (x.total ?? 0), 0)) }]} />
                    : <Gauge observed={c.observed} expected={c.expected} unit="tx" severity="high" label={`${c.observed} transactions vs ${fmtNum(c.expected, 0)} expected across the group`} />}
                </div>
                <div className="adv-score"><b>{fmtNum(c.observed, 0)}</b><small>vs {fmtNum(c.expected, 0)} expected · {c.members.length} of {c.cohort}</small></div>
              </summary>
              <div className="cluster-members">
                {c.members.map((mm) => (
                  <Link key={mm.id} href={`/merchants/${mm.id}`} className={`inc-chip${mm.flagged ? ' sev-critical' : ''}`} title={mm.flagged ? 'Officially flagged that day' : 'Not flagged on its own'}>
                    {mm.flagged && <i className="sev-dot" aria-hidden />}<b>{mm.id}</b>
                    <small className="num">{c.kind === 'declines' ? `${mm.observed}/${mm.total}` : `${mm.observed} vs ${fmtNum(mm.expected ?? 0, 0)}`}</small>
                  </Link>
                ))}
              </div>
              <p className="ns-foot">Relative risk ×{fmtNum(c.relative_risk, 2)} · p ≤ {fmtNum(c.p_value, 3)} ({scan.reps} simulations) · {c.members.filter((x) => x.flagged).length} of {c.members.length} also flagged on their own</p>
            </details>
          )) : <EmptyState title="No collective anomaly in this run" />}
        </>
      )}
      <MethodNote>The channel scan tests each channel’s network-wide decline count per day against its own prior 28 days (binomial, alert at score {ads[0]?.threshold ?? 6}). Run {meta.run.run_id}. Advisory only: it never changes an official flag. Without independent telemetry, causes stay hypotheses. Collective anomalies: expectation-based Poisson scan statistic over subsets of merchants, maximised exactly by sorting merchants by observed ÷ expected; significance by simulating each day under the engine’s own model; reported at p ≤ 0.001 with at least two merchants.</MethodNote>
    </>
  );
}
