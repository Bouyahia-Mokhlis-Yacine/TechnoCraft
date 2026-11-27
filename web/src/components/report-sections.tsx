// Renders the sections of a report the assistant composed (lib/custom-report.ts), with the same
// building blocks as the standard briefs so screen and PDF look alike.
import Link from 'next/link';
import type { BuiltSection } from '@/lib/custom-report';
import { ForecastBars, PairBars } from '@/components/charts';
import { SeverityBadge } from '@/components/ui';
import { fmtInt } from '@/lib/format';

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
    case 'activity': return <section className="report-sec">{head}{s.tooLong ? <p className="muted">More than 31 days: pick a shorter period to draw daily bars.</p> : s.points.length ? <PairBars points={s.points} height={230} label={`Daily transactions, ${s.scope}`} /> : <p className="muted">No data in this period.</p>}{!s.expected && <p className="muted">No expected level is drawn for a single channel.</p>}{note}</section>;
    case 'channel_mix': return <section className="report-sec">{head}<table className="stats alerts-table"><thead><tr><th>Channel</th><th className="r">Transactions</th><th className="r">Share</th><th className="r">Change</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="r num">{fmtInt(r.value)}</td><td className="r num">{r.share}</td><td className="r num">{r.change ?? '—'}</td></tr>)}</tbody></table>{note}</section>;
    case 'alerts': return (
      <section className="report-sec">{head}
        {s.rows.length ? <>
          <table className="stats alerts-table"><thead><tr><th>Day</th><th>Merchant</th><th>Symptom</th><th>Severity</th><th>Observed vs expected</th><th className="r">Score</th><th>Incident</th></tr></thead>
            <tbody>{s.rows.map((r) => <tr key={r.id}><td className="num nowrap">{r.day}</td><td className="nowrap"><Link href={`/alerts/${r.id}`}>{r.merchant}</Link></td><td>{r.symptom}</td><td><SeverityBadge severity={r.severity} /></td><td className="num">{r.vs}</td><td className="r num nowrap">{r.score}</td><td className="nowrap"><Link href={`/incidents/${r.incident}`}>{r.incident}</Link></td></tr>)}</tbody></table>
          {s.total > s.rows.length && <p className="muted">Showing the {s.rows.length} strongest of {s.total} alerts.</p>}
          {s.explain && <ul className="report-notes">{s.rows.map((r) => <li key={r.id}><b>{r.merchant} · {r.day}</b> {r.explanation} <span className="muted">Next check: {r.check}</span></li>)}</ul>}
        </> : <p className="muted">No alert in this scope.</p>}{note}
      </section>);
    case 'incidents': return <section className="report-sec">{head}{s.rows.length ? <table className="stats alerts-table"><thead><tr><th className="r">Rank</th><th>Incident</th><th>Merchant</th><th>Symptom</th><th>Severity</th><th>State · review</th><th>Period</th><th className="r">Exposure</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.id}><td className="r num">{r.rank ?? '—'}</td><td className="nowrap"><Link href={`/incidents/${r.id}`}>{r.id}</Link></td><td className="nowrap">{r.merchant}</td><td>{r.symptom}</td><td><SeverityBadge severity={r.severity} /></td><td>{r.state} · {r.review}</td><td className="num">{r.period}</td><td className="r num nowrap">{r.exposure}</td></tr>)}</tbody></table> : <p className="muted">No incident in this scope.</p>}{note}</section>;
    case 'incident': return (
      <section className="report-sec">{head ?? <h3>Incident {s.id}</h3>}
        <dl className="report-dl">{Object.entries(s.head).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        {s.timeline.length > 0 && <PairBars points={s.timeline} height={200} label={`Daily transactions around ${s.id}`} />}
        <h4>Possible causes (not confirmed)</h4>
        <ul className="report-notes">{s.causes.map((c) => <li key={c.title}><b>{c.title}.</b> {c.for.length ? `For: ${c.for.join('; ')}. ` : ''}{c.against.length ? `Against: ${c.against.join('; ')}. ` : ''}<span className="muted">Would confirm: {c.missing.join(', ')}.</span></li>)}</ul>
        <h4>Next check · {s.owner}</h4>
        <ol className="report-notes">{s.steps.map((x) => <li key={x}>{x}</li>)}</ol>{note}
      </section>);
    case 'merchant': return (
      <section className="report-sec">{head && <h3>{s.title.includes(s.id) ? s.title : `${s.title} · ${s.id}`} <small className="muted">· {s.category} · health {s.score ?? 'n/a'}/100</small></h3>}
        <div className="report-kpis">{s.kpis.map((k) => <div key={k.label}><span>{k.label}</span><b>{k.value}</b></div>)}</div>
        <div className="health-chips">{s.health.map((h) => <span key={h.label} className={`hc ${LEVEL[h.level] ?? ''}`}><i aria-hidden />{h.label}<small>{h.detail}</small></span>)}</div>
        {s.series.length > 0 && <PairBars points={s.series} height={200} label={`Daily transactions for ${s.id}, last 30 days`} />}{note}
      </section>);
    case 'compare': return <section className="report-sec">{head}<table className="stats alerts-table"><thead><tr><th>Merchant</th><th>Category</th><th className="r">Transactions / expected</th><th className="r">Declined</th><th className="r">Health</th><th>Open incidents</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.merchant}><td className="nowrap"><Link href={`/merchants/${r.merchant}`}>{r.merchant}</Link></td><td>{r.category}</td><td className="r num">{fmtInt(r.tx)} / {fmtInt(r.expected)}</td><td className="r num">{r.declined} ({r.rate})</td><td className="r num">{r.health ?? '—'}</td><td className="nowrap">{r.open}</td></tr>)}</tbody></table>{note}</section>;
    case 'top_declines': case 'shortfall': return <section className="report-sec">{head}{s.rows.length ? <table className="stats alerts-table"><thead><tr><th>Merchant</th><th>Category</th><th className="r">Observed</th><th className="r">Expected</th><th className="r">Gap</th></tr></thead><tbody>{s.rows.map((r) => <tr key={r.merchant}><td className="nowrap"><Link href={`/merchants/${r.merchant}`}>{r.merchant}</Link></td><td>{r.category}</td><td className="r num">{r.observed}</td><td className="r num">{r.expected}</td><td className="r num">{r.gap}</td></tr>)}</tbody></table> : <p className="muted">No merchant stands out in this period.</p>}{note}</section>;
    case 'forecast': return <section className="report-sec">{head}{s.points.length ? <div style={{ maxWidth: 560 }}><ForecastBars points={s.points} height={180} /></div> : <p className="muted">No forecast for this scope.</p>}<p className="muted">{s.backtest} · advisory, never used to flag.</p>{note}</section>;
    case 'network_signals': return (
      <section className="report-sec">{head}
        {s.advisories.length + s.clusters.length ? <div className="ref-rows">
          {s.advisories.map((a) => <div key={a.id} className="ref-row"><span className="ref-label">{a.channel}: high declines<small>{a.day} · advisory {a.id} · {a.merchants} merchants affected</small></span><span className="muted num">{a.rate} vs {a.expected} expected</span></div>)}
          {s.clusters.map((c, i) => <div key={i} className="ref-row"><span className="ref-label">{c.kind} · {c.channel}<small>{c.day} · {c.merchants} merchants · relative risk {c.rr} · p = {c.p}</small></span><span className="muted num">{c.observed} vs {c.expected} expected</span></div>)}
        </div> : <p className="muted">No network-wide signal in this period.</p>}{note}
      </section>);
    case 'engine_quality': return <section className="report-sec">{head}<dl className="report-dl">{s.rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>{note}</section>;
    case 'simulation': return <section className="report-sec">{head}<p className="report-prose"><b>Scenario (an assumption):</b> {s.scenario}</p><dl className="report-dl">{s.rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>{note}</section>;
  }
}
