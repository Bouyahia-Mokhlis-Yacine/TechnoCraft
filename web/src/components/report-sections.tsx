// Renders the sections of a report the assistant composed (lib/custom-report.ts), with the same
// building blocks as the standard briefs so screen and PDF look alike.
import Link from 'next/link';
import type { BuiltSection } from '@/lib/custom-report';
import { ForecastBars, PairBars } from '@/components/charts';
import { SeverityBadge } from '@/components/ui';
import { fmtInt, na } from '@/lib/format';
import { makeT, type Key, type Vars } from '@/lib/i18n';

// server component: the request locale was set by the page
const tr = (key: string, vars?: Vars) => makeT()(key as Key, vars);

/** Paragraphs and "- " bullets from the model's text. */
function Prose({ body }: { body: string }) {
  const blocks = body.replace(/\\n/g, "\n").split(/\n\s*\n/);
  return <>{blocks.map((b, i) => {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.every((l) => /^[-•*]\s/.test(l))
      ? <ul key={i} className="report-notes" dir="auto">{lines.map((l, j) => <li key={j} dir="auto">{l.replace(/^[-•*]\s+/, '')}</li>)}</ul>
      : <p key={i} className="report-prose" dir="auto">{lines.join(' ')}</p>;
  })}</>;
}

const LEVEL: Record<string, string> = { ok: 'hc-ok', watch: 'hc-watch', issue: 'hc-issue', unknown: 'hc-unknown' };

export function ReportSection({ s }: { s: BuiltSection }) {
  const head = s.title ? <h3 dir="auto">{s.title}{'scope' in s && s.scope ? <small className="muted"> · {s.scope}</small> : null}</h3> : null;
  const note = s.note ? <p className="report-prose muted" dir="auto">{s.note}</p> : null;
  switch (s.kind) {
    case 'text': return <section className="report-sec">{head}<Prose body={s.body} /></section>;
    case 'kpis': return <section className="report-sec">{head}<div className="report-kpis">{s.cards.map((c) => <div key={c.label}><span>{c.label}</span><b>{c.value}</b><small>{c.note}</small></div>)}</div>{note}</section>;
    case 'activity': return <section className="report-sec">{head}{s.tooLong ? <p className="muted">{tr('rs.tooLong')}</p> : s.points.length ? <PairBars points={s.points} height={230} label={tr('rs.dailyTx', { scope: s.scope })} /> : <p className="muted">{tr('rs.noData')}</p>}{!s.expected && <p className="muted">{tr('rs.noExpected')}</p>}{note}</section>;
    case 'channel_mix': return <section className="report-sec">{head}<table className="stats alerts-table"><thead><tr><th>{tr('f.channel')}</th><th className="r">{tr('ov.transactions')}</th><th className="r">{tr('rs.share')}</th><th className="r">{tr('rs.change')}</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="r num">{fmtInt(r.value)}</td><td className="r num">{r.share}</td><td className="r num">{r.change ?? '—'}</td></tr>)}</tbody></table>{note}</section>;
    case 'alerts': return (
      <section className="report-sec">{head}
        {s.rows.length ? <>
          <table className="stats alerts-table"><thead><tr><th>{tr('al.day')}</th><th>{tr('f.merchant')}</th><th>{tr('f.symptom')}</th><th>{tr('f.severity')}</th><th>{tr('al.obsExp')}</th><th className="r">{tr('al.score')}</th><th>{tr('inc.incident')}</th></tr></thead>
            <tbody>{s.rows.map((r) => <tr key={r.id}><td className="num nowrap">{r.day}</td><td className="nowrap"><Link href={`/alerts/${r.id}`}>{r.merchant}</Link></td><td>{r.symptom}</td><td><SeverityBadge severity={r.severity} /></td><td className="num">{r.vs}</td><td className="r num nowrap">{r.score}</td><td className="nowrap"><Link href={`/incidents/${r.incident}`}>{r.incident}</Link></td></tr>)}</tbody></table>
          {s.total > s.rows.length && <p className="muted">{tr('rs.showing', { k: s.rows.length, n: s.total })}</p>}
          {s.explain && <ul className="report-notes">{s.rows.map((r) => <li key={r.id}><b>{r.merchant} · {r.day}</b> {r.explanation} <span className="muted">{tr('rep.nextCheck', { check: r.check })}</span></li>)}</ul>}
        </> : <p className="muted">{tr('rep.noAlert')}</p>}{note}
      </section>);
    case 'incidents': return <section className="report-sec">{head}{s.rows.length ? <table className="stats alerts-table"><thead><tr><th className="r">{tr('inc.rank')}</th><th>{tr('inc.incident')}</th><th>{tr('f.merchant')}</th><th>{tr('f.symptom')}</th><th>{tr('f.severity')}</th><th>{tr('rs.stateReview')}</th><th>{tr('inc.period')}</th><th className="r">{tr('inc.exposure')}</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.id}><td className="r num">{r.rank ?? '—'}</td><td className="nowrap"><Link href={`/incidents/${r.id}`}>{r.id}</Link></td><td className="nowrap">{r.merchant}</td><td>{r.symptom}</td><td><SeverityBadge severity={r.severity} /></td><td>{r.state} · {r.review}</td><td className="num">{r.period}</td><td className="r num nowrap">{r.exposure}</td></tr>)}</tbody></table> : <p className="muted">{tr('rs.noIncident')}</p>}{note}</section>;
    case 'incident': return (
      <section className="report-sec">{head ?? <h3>{tr('inc.incident')} {s.id}</h3>}
        <dl className="report-dl">{Object.entries(s.head).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        {s.timeline.length > 0 && <PairBars points={s.timeline} height={200} label={tr('rs.around', { id: s.id })} />}
        <h4>{tr('rs.causes')}</h4>
        <ul className="report-notes">{s.causes.map((c) => <li key={c.title}><b>{c.title}.</b> {c.for.length ? `${tr('incd.for')} : ${c.for.join(' ; ')}. ` : ''}{c.against.length ? `${tr('incd.against')} : ${c.against.join(' ; ')}. ` : ''}<span className="muted">{tr('incd.wouldConfirm')} : {c.missing.join(', ')}.</span></li>)}</ul>
        <h4>{tr('al.nextCheck')} · {s.owner}</h4>
        <ol className="report-notes">{s.steps.map((x) => <li key={x}>{x}</li>)}</ol>{note}
      </section>);
    case 'merchant': return (
      <section className="report-sec">{head && <h3>{s.title.includes(s.id) ? s.title : `${s.title} · ${s.id}`} <small className="muted">· {s.category} · {tr('rs.health', { v: s.score ?? na() })}</small></h3>}
        <div className="report-kpis">{s.kpis.map((k) => <div key={k.label}><span>{k.label}</span><b>{k.value}</b></div>)}</div>
        <div className="health-chips">{s.health.map((h) => <span key={h.label} className={`hc ${LEVEL[h.level] ?? ''}`}><i aria-hidden />{h.label}<small>{h.detail}</small></span>)}</div>
        {s.series.length > 0 && <PairBars points={s.series} height={200} label={tr('rs.last30', { id: s.id })} />}{note}
      </section>);
    case 'compare': return <section className="report-sec">{head}<table className="stats alerts-table"><thead><tr><th>{tr('f.merchant')}</th><th>{tr('f.category')}</th><th className="r">{tr('rs.txExpected')}</th><th className="r">{tr('status.Declined')}</th><th className="r">{tr('mer.health')}</th><th>{tr('ov.openIncidents')}</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.merchant}><td className="nowrap"><Link href={`/merchants/${r.merchant}`}>{r.merchant}</Link></td><td>{r.category}</td><td className="r num">{fmtInt(r.tx)} / {fmtInt(r.expected)}</td><td className="r num">{r.declined} ({r.rate})</td><td className="r num">{r.health ?? '—'}</td><td className="nowrap">{r.open}</td></tr>)}</tbody></table>{note}</section>;
    case 'top_declines': case 'shortfall': return <section className="report-sec">{head}{s.rows.length ? <table className="stats alerts-table"><thead><tr><th>{tr('f.merchant')}</th><th>{tr('f.category')}</th><th className="r">{tr('al.observed')}</th><th className="r">{tr('ov.expected')}</th><th className="r">{tr('rs.gap')}</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.merchant}><td className="nowrap"><Link href={`/merchants/${r.merchant}`}>{r.merchant}</Link></td><td>{r.category}</td><td className="r num">{r.observed}</td><td className="r num">{r.expected}</td><td className="r num">{r.gap}</td></tr>)}</tbody></table> : <p className="muted">{tr('rs.noneStands')}</p>}{note}</section>;
    case 'forecast': return <section className="report-sec">{head}{s.points.length ? <div style={{ maxWidth: 560 }}><ForecastBars points={s.points} height={180} /></div> : <p className="muted">{tr('rs.noForecast')}</p>}<p className="muted">{s.backtest} · {tr('rs.advisoryOnly')}</p>{note}</section>;
    case 'network_signals': return (
      <section className="report-sec">{head}
        {s.advisories.length + s.clusters.length ? <div className="ref-rows">
          {s.advisories.map((a) => <div key={a.id} className="ref-row"><span className="ref-label">{a.channel} : {tr('rs.highDeclines')}<small>{tr('rs.advisoryRow', { day: a.day, id: a.id, n: a.merchants })}</small></span><span className="muted num">{tr('ove.value', { obs: a.rate, exp: a.expected })}</span></div>)}
          {s.clusters.map((c, i) => <div key={i} className="ref-row"><span className="ref-label">{c.kind} · {c.channel}<small>{tr('rs.clusterRow', { day: c.day, n: c.merchants, rr: c.rr, p: c.p })}</small></span><span className="muted num">{tr('ove.value', { obs: c.observed, exp: c.expected })}</span></div>)}
        </div> : <p className="muted">{tr('rs.noSignal')}</p>}{note}
      </section>);
    case 'engine_quality': return <section className="report-sec">{head}<dl className="report-dl">{s.rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>{note}</section>;
    case 'simulation': return <section className="report-sec">{head}<p className="report-prose"><b>{tr('rs.scenario')}</b> {s.scenario}</p><dl className="report-dl">{s.rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>{note}</section>;
  }
}
