import { AdvisorySkeleton } from '@/components/skeletons';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowRight, CircleHelp, ThumbsDown, ThumbsUp } from 'lucide-react';
import { getAdvisory } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum, fmtPct } from '@/lib/format';
import { model } from '@/lib/model';
import { CHANNEL_VAR, LIFECYCLE, categoryLabel, channelLabel } from '@/lib/labels';
import { engineText } from '@/lib/i18n/engine';
import { getT } from '@/lib/i18n/server';
import { OfficialOnly } from '@/components/dataset';
import { Gauge, MerchantTiles, RateBars } from '@/components/visuals';
import { symptomLabel } from '@/components/satim-evidence';
import { PageHeader } from '@/components/ui';
import { Balanced } from '@/components/balanced';
import { resolveView } from '@/lib/dataset';

type Params = Promise<{ id: string }>;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

type SP = Promise<{ run?: string }>;
export default function AdvisoryPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  return <Suspense fallback={<AdvisorySkeleton />}><AdvisoryView params={params} searchParams={searchParams} /></Suspense>;
}

async function AdvisoryView({ params, searchParams }: { params: Params; searchParams: SP }) {
  const t = await getT();
  const run = (await resolveView((await searchParams).run)).runId;
  const data = getAdvisory(decodeURIComponent((await params).id), run);
  if (!data) notFound();
  const { advisory: a, otherRate, hypotheses, incidents } = data;
  const decline = a.symptom === 'rejection_increase';
  const affected = a.excess_rejections ?? a.potential_activity_shortfall ?? a.activity_increase;
  const members = [...a.members].sort((x, y) => Number(y.affected) - Number(x.affected) || y.n_dec / Math.max(1, y.n) - x.n_dec / Math.max(1, x.n));
  // merchant × channel decline matrix that day (FR-33)
  const days = model(run).byMerchant;
  const chans = [...new Set([a.channel, ...a.otherChannels.map((c) => c.channel)])];
  const matrix = members.slice(0, 18).map((mm) => ({ id: mm.merchant_id, cells: chans.map((c) => days.get(mm.merchant_id)?.find((d) => d.date === a.date)?.channels[c] ?? null) }));

  return (
    <>
      <PageHeader crumbs={<><Link transitionTypes={['nav-back']} href="/intelligence">{t('nav.intelligence')}</Link><span>/</span><span>{a.id}</span></>}
        title={`${channelLabel(a.channel)} · ${symptomLabel(a.symptom)}`} />
      <OfficialOnly />

      <Balanced className="detail-grid">
        <div className="stack">
          <section className="story m-rise">
            <span className="meta">{t('intel.advisoryMeta', { date: fmtDate(a.date), cat: a.category ? categoryLabel(a.category) : t('f.allCategories') })}</span>
            <p>{t('intel.obsExp', { obs: fmtInt(a.observed), exp: fmtNum(a.expected, 1) })} · {t('intel.affected', { n: fmtInt(affected) })}</p>
            {decline ? <RateBars tone="hero" rows={[{ label: t('intel.selected'), value: a.observed_rate, hot: true },
              { label: t('ov.expected'), value: a.expected_rate }, { label: t('intel.otherChannels'), value: otherRate }]} /> :
              <Gauge tone="hero" observed={a.observed} expected={a.expected} unit="tx" label={symptomLabel(a.symptom)} />}
            <p>{t('intel.scoreLine', { score: fmtNum(a.score, 2), rank: fmtPct(a.calibration_date_tail_rank, 2), since: fmtDate(a.start) })}</p>
            <div className="figures small">
              <div><b>{a.members.length}</b><span>{t('intel.merchantsLower')}</span></div>
              <div><b>{a.members.filter((m) => m.affected).length}</b><span>{t('vis.corroborated').toLowerCase()}</span></div>
              <div><b>{a.members.filter((m) => m.flagged).length}</b><span>{t('vis.flagged').toLowerCase()}</span></div>
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('intel.hypotheses')}</h2><p>{t('intel.noneConfirmed')}</p></div></div>
            <div className="hypotheses">
              {hypotheses.map((h) => (
                <article key={h.title} className="hypo">
                  <h3>{engineText(h.title)}</h3>
                  <ul>
                    {h.for.map((x) => <li key={x}><ThumbsUp aria-label={t('incd.for')} />{engineText(x)}</li>)}
                    {h.against.map((x) => <li key={x}><ThumbsDown aria-label={t('incd.against')} />{engineText(x)}</li>)}
                    {h.missing.map((x) => <li key={x} className="muted"><CircleHelp aria-label={t('intel.missing')} />{engineText(x)}</li>)}
                  </ul>
                  <p className="hypo-next"><ArrowRight aria-hidden />{engineText(h.next)}</p>
                </article>
              ))}
            </div>
          </section>

          {incidents.length > 0 && (
            <section className="panel m-rise" style={css({ '--i': 2 })}>
              <div className="panel-head"><div><h2>{t('intel.linked')}</h2><p>{incidents.length}</p></div></div>
              <div className="inc-chips">{incidents.map((i) => (
                <Link key={i.id} href={`/incidents/${i.id}`} className={`inc-chip sev-${i.severity} life-${i.lifecycle}`} title={`${i.id} · ${categoryLabel(i.category)} · ${LIFECYCLE[i.lifecycle]}`}>
                  <i className="sev-dot" aria-hidden /><b>{i.merchant}</b><small>{LIFECYCLE[i.lifecycle]}</small>
                </Link>
              ))}</div>
            </section>
          )}
        </div>

        <div className="stack">
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('intel.onChannel')}</h2><p>{t('intel.thatDay')}</p></div></div>
            {decline && <MerchantTiles items={members.map((mm) => ({ id: mm.merchant_id, k: mm.n_dec, n: mm.n, affected: mm.affected, flagged: mm.flagged }))} />}
            <ul className="reasons">{members.map((mm) => <li key={mm.merchant_id}><Link href={'/merchants/' + mm.merchant_id}>{mm.merchant_id}</Link>
              {' · '}{t('intel.obsExp', { obs: fmtInt(mm.observed), exp: fmtNum(mm.expected, 1) })}{mm.affected ? ` · ${t('vis.corroborated').toLowerCase()}` : ''}{mm.flagged ? ` · ${t('intel.officialAlert')}` : ''}</li>)}</ul>
          </section>
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>{t('intel.matrix')}</h2><p>{t('intel.matrixSub')}</p></div></div>
            <div className="matrix" style={css({ '--cols': chans.length })}>
              <span />{chans.map((c) => <span key={c} className="mx-head" title={channelLabel(c)}><i className="dot" style={{ background: CHANNEL_VAR[c] ?? 'var(--ch-unknown)' }} />{channelLabel(c).split(' ')[0]}</span>)}
              {matrix.map((r) => [<span key={r.id} className="mx-row"><b>{r.id}</b></span>, ...r.cells.map((c, j) => (
                <span key={`${r.id}${j}`} className="mx-cell" style={css({ '--a': c && c[0] ? c[1] / c[0] : 0 })} title={c ? t('vis.declinedOf', { k: c[1], n: c[0] }) : t('intel.noActivity')}>{c ? `${c[1]}/${c[0]}` : '·'}</span>
              ))])}
            </div>
          </section>
        </div>
      </Balanced>
    </>
  );
}
