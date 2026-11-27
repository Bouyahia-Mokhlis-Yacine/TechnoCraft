import { AdvisorySkeleton } from '@/components/skeletons';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowRight, CircleHelp, ThumbsDown, ThumbsUp } from 'lucide-react';
import { getAdvisory } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { model } from '@/lib/model';
import { CHANNEL_VAR } from '@/lib/labels';
import { Gauge, MerchantTiles, RateBars } from '@/components/visuals';
import { symptomLabel } from '@/components/satim-evidence';
import { PageHeader } from '@/components/ui';

type Params = Promise<{ id: string }>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

export default function AdvisoryPage({ params }: { params: Params }) {
  return <Suspense fallback={<AdvisorySkeleton />}><AdvisoryView params={params} /></Suspense>;
}

async function AdvisoryView({ params }: { params: Params }) {
  const data = getAdvisory(decodeURIComponent((await params).id));
  if (!data) notFound();
  const { advisory: a, otherRate, hypotheses, incidents } = data;
  const decline = a.symptom === 'rejection_increase';
  const affected = a.excess_rejections ?? a.potential_activity_shortfall ?? a.activity_increase;
  const members = [...a.members].sort((x, y) => Number(y.affected) - Number(x.affected) || y.n_dec / Math.max(1, y.n) - x.n_dec / Math.max(1, x.n));
  // merchant × channel decline matrix that day (FR-33)
  const days = model().byMerchant;
  const chans = [...new Set([a.channel, ...a.otherChannels.map((c) => c.channel)])];
  const matrix = members.slice(0, 18).map((mm) => ({ id: mm.merchant_id, cells: chans.map((c) => days.get(mm.merchant_id)?.find((d) => d.date === a.date)?.channels[c] ?? null) }));

  return (
    <>
      <PageHeader crumbs={<><Link transitionTypes={['nav-back']} href="/intelligence">Intelligence</Link><span>/</span><span>{a.id}</span></>}
        title={`${a.channel} · ${symptomLabel(a.symptom)}`} />

      <div className="detail-grid">
        <div className="stack">
          <section className="story m-rise">
            <span className="meta">Collective Detection advisory · {fmtDate(a.date)} · {a.category ?? 'All categories'}</span>
            <p>{fmtInt(a.observed)} observed vs {fmtNum(a.expected, 1)} expected · {fmtInt(affected)} estimated affected events</p>
            {decline ? <RateBars tone="hero" rows={[{ label: 'Selected merchants', value: a.observed_rate, hot: true },
              { label: 'Expected', value: a.expected_rate }, { label: 'Other channels', value: otherRate }]} /> :
              <Gauge tone="hero" observed={a.observed} expected={a.expected} unit="tx" label={symptomLabel(a.symptom)} />}
            <p>Likelihood score {fmtNum(a.score, 2)} · ordinary date tail rank {fmtPct(a.calibration_date_tail_rank, 2)} · scope since {fmtDate(a.start)}</p>
            <div className="figures small">
              <div><b>{a.members.length}</b><span>merchants</span></div>
              <div><b>{a.members.filter((m) => m.affected).length}</b><span>corroborated</span></div>
              <div><b>{a.members.filter((m) => m.flagged).length}</b><span>flagged</span></div>
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Hypotheses</h2><p>None confirmed</p></div></div>
            <div className="hypotheses">
              {hypotheses.map((h) => (
                <article key={h.title} className="hypo">
                  <h3>{h.title}</h3>
                  <ul>
                    {h.for.map((x) => <li key={x}><ThumbsUp aria-label="For" />{x}</li>)}
                    {h.against.map((x) => <li key={x}><ThumbsDown aria-label="Against" />{x}</li>)}
                    {h.missing.map((x) => <li key={x} className="muted"><CircleHelp aria-label="Missing" />{x}</li>)}
                  </ul>
                  <p className="hypo-next"><ArrowRight aria-hidden />{h.next}</p>
                </article>
              ))}
            </div>
          </section>

          {incidents.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 2 })}>
              <div className="panel-head"><div><h2>Linked incidents</h2><p>{incidents.length}</p></div></div>
              <div className="inc-chips">{incidents.map((i) => (
                <Link key={i.id} href={`/incidents/${i.id}`} className={`inc-chip sev-${i.severity} life-${i.lifecycle}`} title={`${i.id} · ${i.category} · ${i.lifecycle}`}>
                  <i className="sev-dot" aria-hidden /><b>{i.merchant}</b><small>{i.lifecycle}</small>
                </Link>
              ))}</div>
            </section>
          )}
        </div>

        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>Merchants on the channel</h2><p>That day</p></div></div>
            {decline && <MerchantTiles items={members.map((mm) => ({ id: mm.merchant_id, k: mm.n_dec, n: mm.n, affected: mm.affected, flagged: mm.flagged }))} />}
            <ul className="reasons">{members.map((mm) => <li key={mm.merchant_id}><Link href={'/merchants/' + mm.merchant_id}>{mm.merchant_id}</Link>
              {' · '}{fmtInt(mm.observed)} observed vs {fmtNum(mm.expected, 1)} expected{mm.affected ? ' · corroborated' : ''}{mm.flagged ? ' · official Sequential Detection alert' : ''}</li>)}</ul>
          </section>
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>Merchant × channel</h2><p>Declined / total · darker = more declines</p></div></div>
            <div className="matrix" style={css({ '--cols': chans.length })}>
              <span />{chans.map((c) => <span key={c} className="mx-head" title={c}><i className="dot" style={{ background: CHANNEL_VAR[c] ?? 'var(--ch-unknown)' }} />{c.split(' ')[0]}</span>)}
              {matrix.map((r) => [<span key={r.id} className="mx-row"><b>{r.id}</b></span>, ...r.cells.map((c, j) => (
                <span key={`${r.id}${j}`} className="mx-cell" style={css({ '--a': c && c[0] ? c[1] / c[0] : 0 })} title={c ? `${c[1]} declined of ${c[0]}` : 'no activity'}>{c ? `${c[1]}/${c[0]}` : '·'}</span>
              ))])}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
