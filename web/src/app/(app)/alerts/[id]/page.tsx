import { AlertSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Receipt } from 'lucide-react';
import { getAnomaly } from '@/lib/api';
import { fmtDate, fmtDelta, fmtInt, fmtNum, fmtRange } from '@/lib/format';
import { CHANNEL_VAR, TYPES, channelLabel, fmtKind } from '@/lib/labels';
import { AreaChart, HourBars, ProgressRows } from '@/components/charts';
import { Gauge, GaugeCell, NextSteps, fmtShort } from '@/components/visuals';
import { HybridEvidence } from '@/components/satim-evidence';
import { resolveView, keepRun } from '@/lib/dataset';
import { getT } from '@/lib/i18n/server';
import { ViewBanner, ViewPending } from '@/components/dataset';
import { LifecycleChip, PageHeader, SeverityBadge } from '@/components/ui';
import { Balanced } from '@/components/balanced';

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
/** A Transactions page URL with the page's own parameter names (merchant, from, to, channel, status, run). */
const txHref = (q: Record<string, string | null | undefined>) => `/transactions?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]))}`;
const css = (o: Record<string, string | number>) => o as React.CSSProperties;
const STAT_KEY: Record<string, string> = { transactions: 'al.statTx', rejection: 'al.statRej', cancellation: 'al.statCan', ticket: 'al.statTicket', value: 'al.statValue' };

export default function AlertPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  return <Suspense fallback={<AlertSkeleton />}><Alert params={params} searchParams={searchParams} /></Suspense>;
}

async function Alert({ params, searchParams }: { params: Params; searchParams: SP }) {
  const sp = await searchParams;
  const t = await getT();
  const view = await resolveView(typeof sp.run === 'string' ? sp.run : null);
  if (view.kind === 'collections' && !view.runId) return <><PageHeader title={t('al.title')} /><ViewPending view={view} /></>;
  const run = view.runId;
  let data: ReturnType<typeof getAnomaly> = null;
  try { data = getAnomaly(decodeURIComponent((await params).id), run); } catch { notFound(); }
  if (!data) notFound();
  const { anomaly: a, day, series, stats, channels, hours, incident, advisory, policy, runId, hybrid } = data;
  const ind = a.evidence.indicator;   // the engine's indicator (transaction_count, declines, cancellations, median_ticket)
  const kind = a.unit === 'DZD' ? 'dzd' : a.unit === 'ratio' ? 'pct' : 'int';
  const chMax = Math.max(...channels.flatMap((c) => [c.observed, c.usual]), 1);
  const diff = a.expected === null || a.observed === null ? t('ov.na') : a.unit === 'ratio' ? `${a.observed >= a.expected ? '+' : '−'}${fmtNum(Math.abs(a.observed - a.expected) * 100, 0)} pts` : fmtDelta(a.observed, a.expected);
  // links to transactions carry the analysis itself (run), so the same records come back after a refresh or a change of selection
  const pin = view.kind === 'collections' ? run : null;
  const scope = { merchant: a.merchant, channel: day.incident_channel, run: pin };
  const indicatorCap = a.indicator[0].toUpperCase() + a.indicator.slice(1);

  return (
    <>
      <PageHeader
        crumbs={<><Link transitionTypes={['nav-back']} href={keepRun('/alerts', view)}>{t('nav.alerts')}</Link><span>/</span><Link transitionTypes={['nav-back']} href={keepRun(`/merchants/${a.merchant}`, view)}>{a.merchant}</Link><span>/</span><span>{fmtDate(a.date)}</span></>}
        title={t('al.title')}
      >
        <Link className="btn btn-primary" href={keepRun(`/incidents/${a.incidentId}`, view)}>{t('al.openIncident')} <ArrowRight /></Link>
      </PageHeader>
      <ViewBanner view={view} path={`/alerts/${a.id}`} />

      <Balanced className="detail-grid">
        <div className="stack">
          <section className={`story sev-${a.severity} m-rise`}>
            <div className="row"><SeverityBadge severity={a.severity} /><span className="meta">{TYPES[a.type].label}</span>{incident && <LifecycleChip l={incident.lifecycle} />}</div>
            <h1>{a.merchant} · {fmtDate(a.date)}</h1>
            <p>{a.explanation}</p>
            <div className="compare" aria-hidden><b>{fmtShort(a.observed, a.unit)}</b><span className="unit">{a.unit === 'tx' ? t('unit.txShort') : a.indicator}</span><span className="delta num">{diff}</span></div>
            <Gauge tone="hero" size="lg" observed={a.observed} expected={a.expected} lo={a.lo} hi={a.hi} unit={a.unit} severity={a.severity} label={a.explanation} />
          </section>

          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('al.evidence')}</h2></div></div>
            <ul className="reasons">{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </section>

          {/* the transactions behind the evidence: same merchant, the evidence dates, the channel when the alert is channel-specific */}
          <section className="panel m-rise tx-for-alert" style={css({ '--i': 2 })} aria-labelledby="tx-alert-h">
            <div className="panel-head"><div><h2 id="tx-alert-h">{t('al.txTitle')}</h2>
              <p>{day.incident_channel ? `${channelLabel(day.incident_channel)} · ` : ''}{a.merchant} · {t('al.alertDay', { date: fmtDate(a.date) })}</p></div></div>
            <p className="tx-scope">
              {day.n === 0
                ? t('al.txNone', { merchant: a.merchant, date: fmtDate(a.date) })
                : ind === 'declines' || ind === 'cancellations'
                  ? t(ind === 'declines' ? 'al.txDeclined' : 'al.txCancelled', { k: fmtInt(ind === 'declines' ? day.n_dec : day.n_can), n: day.n })
                  : t('al.txDay', { n: day.n, acc: fmtInt(day.n_acc), dec: fmtInt(day.n_dec) })}
            </p>
            <div className="row">
              <Link className="btn btn-secondary" href={txHref({ ...scope, from: a.date, to: a.date })}><Receipt aria-hidden />{t('al.viewTx')}</Link>
              {ind === 'declines' && day.n_dec > 0 && <Link className="btn btn-ghost" href={txHref({ ...scope, from: a.date, to: a.date, status: 'Declined' })}>{t('al.declinedOnly')}</Link>}
              {ind === 'cancellations' && day.n_can > 0 && <Link className="btn btn-ghost" href={txHref({ ...scope, from: a.date, to: a.date, status: 'Cancelled' })}>{t('al.cancelledOnly')}</Link>}
              {incident && incident.days > 1 && (
                <Link className="btn btn-ghost" href={txHref({ ...scope, from: incident.onset, to: incident.end })}>
                  {t('al.incidentPeriod', { range: fmtRange(incident.onset, incident.end), n: incident.days })}
                </Link>
              )}
            </div>
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>{t('al.nextCheck')}</h2></div></div>
            <NextSteps owner={a.owner} steps={[a.check, ...a.steps]} href={advisory ? { to: `/intelligence/${advisory.id}`, label: t('al.advisoryLink', { n: advisory.members.filter((m) => m.affected).length }) } : undefined} />
          </section>

          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head tight"><div><h2>{t('al.thatDay')}</h2></div></div>
            <div className="ref-rows">
              {stats.map((s) => {
                const unit = s.kind === 'pct' ? 'ratio' as const : s.kind === 'dzd' ? 'DZD' as const : 'tx' as const;
                const hl = s.key === (ind === 'declines' ? 'rejection' : ind === 'cancellations' ? 'cancellation' : ind === 'median_ticket' ? 'ticket' : 'transactions');
                const label = t(STAT_KEY[s.key] as 'al.statTx');
                const note = s.key === 'transactions' ? (day.expected_lo !== null ? t('al.noteRange', { lo: fmtInt(day.expected_lo), hi: fmtInt(day.expected_hi) }) : '')
                  : s.key === 'rejection' ? t('al.noteOf', { k: fmtInt(day.n_dec), n: fmtInt(day.n) }) : s.key === 'cancellation' ? t('al.noteOf', { k: fmtInt(day.n_can), n: fmtInt(day.n) })
                  : s.key === 'ticket' ? t('al.noteAccepted', { n: day.n_acc }) : '';
                return (
                  <div key={s.key} className={`ref-row${hl ? ' hl' : ''}`}>
                    <span className="ref-label">{label}{note && <small>{note}</small>}</span>
                    {s.observed === null ? <span className="muted num">{t('common.noData')}</span>
                      : <GaugeCell observed={s.observed} expected={s.usual ?? null} lo={s.key === 'transactions' ? day.expected_lo : null} hi={s.key === 'transactions' ? day.expected_hi : null} unit={unit} severity={hl ? a.severity : 'normal'} label={s.usual != null ? t('al.gaugeVs', { label, obs: fmtKind(s.observed, s.kind), exp: fmtKind(s.usual, s.kind) }) : `${label} : ${fmtKind(s.observed, s.kind)}`} />}
                  </div>
                );
              })}
            </div>
            <details className="how">
              <summary>{t('al.howTitle')}</summary>
              <ul>
                <li>{t('al.how1')}</li>
                <li>{t('al.how2', { score: fmtNum(a.score, 4), cutoff: fmtNum(policy.high, 4) })}</li>
                <li>{t('al.how3', { ref: a.evidence.reference_version, n: a.historyDays, run: runId })}</li>
                <li>{t('al.how4')}</li>
              </ul>
            </details>
          </section>
        </div>

        <div className="stack">
          {hybrid && <HybridEvidence row={hybrid} />}
          <section className="panel m-rise" style={css({ '--i': 1 })}>
            <div className="panel-head"><div><h2>{t('al.perDay', { indicator: indicatorCap })}</h2><p>{t('al.window')}</p></div></div>
            <AreaChart points={series} kind={kind} highlight={a.date} label={t('al.chartLabel', { indicator: a.indicator, merchant: a.merchant, date: fmtDate(a.date) })} />
            <div className="legend below"><span><i />{t('al.observed')}</span><span><i className="line" />{t('ov.expected')}</span><span><i style={{ background: 'var(--sev-high)' }} />{t('al.otherFlagged')}</span></div>
          </section>
          <section className="panel m-rise" style={css({ '--i': 2 })}>
            <div className="panel-head"><div><h2>{t('al.channelsDay')}</h2><p>{t('al.channelsSub')}</p></div></div>
            <ProgressRows rows={channels.map((c) => ({ label: channelLabel(c.label), value: c.observed, max: chMax, mark: c.usual, color: CHANNEL_VAR[c.label] ?? 'var(--ch-unknown)', right: t(c.declined ? 'al.channelRightDec' : 'al.channelRight', { obs: fmtInt(c.observed), usual: fmtNum(c.usual, 0), dec: fmtInt(c.declined) }) }))} />
          </section>
          <section className="panel m-rise" style={css({ '--i': 3 })}>
            <div className="panel-head"><div><h2>{t('al.hours')}</h2><p>{t('al.hoursSub')}</p></div></div>
            <HourBars rows={hours} />
          </section>
        </div>
      </Balanced>
    </>
  );
}
