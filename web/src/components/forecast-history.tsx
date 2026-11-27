// Forecast history (Data & runs): each run's forecast vintage next to what was observed afterwards.
// Server component; figures come from lib/forecast-vintages (immutable vintages, later complete batches).
import { evaluate, vintages, type Pair } from '@/lib/forecast-vintages';
import { fmtCompactDzd, fmtDate, fmtNum, fmtPct, fmtRange, fmtStamp } from '@/lib/format';
import { getT } from '@/lib/i18n/server';
import type { T } from '@/lib/i18n';
import { MethodNote } from './visuals';

export async function ForecastHistory() {
  const t = await getT(), l = t.locale;
  const rows = vintages().map(evaluate);
  const shown = rows.find((r) => r.pairs.some((p) => p.metric === 'transactions'));
  const fmt = (metric: string, v: number | null) => (v === null ? '—' : metric === 'accepted_value' ? fmtCompactDzd(v, l) : fmtNum(v, 1, l));
  return (
    <section className="panel m-rise forecast-history">
      <div className="panel-head"><div><h2>{t('fh.title')}</h2><p>{t('fh.sub')}</p></div></div>
      <div className="table-scroll"><table className="data">
        <thead><tr><th>{t('fh.vintage')}</th><th>{t('fh.origin')}</th><th>{t('fh.model')}</th><th className="r">{t('fh.pairs')}</th>
          {(['transactions', 'accepted_value', 'rejections'] as const).map((m) => <th key={m} className="r">{t(`fh.m.${m}`)}<small className="block muted">{t('fh.maeCover')}</small></th>)}</tr></thead>
        <tbody>{rows.map(({ vintage: v, summary }) => (
          <tr key={v.id}>
            <td><b className="num">{v.id}</b><small className="block muted">{t(v.source === 'official' ? 'fh.official' : 'fh.import')} · {fmtStamp(v.created_at, l)}</small></td>
            <td className="num">{fmtDate(v.origin)}<small className="block muted">{fmtRange(v.targets[0].date, v.targets.at(-1)!.date, l)}</small></td>
            <td><small>{v.model}<span className="block muted">{v.model_version} · {t('rh.reference')} {v.reference_version.split('-').pop()}</span></small></td>
            <td className="r num">{summary.transactions.n}</td>
            {(['transactions', 'accepted_value', 'rejections'] as const).map((m) => <td key={m} className="r num">{summary[m].n ? <>{fmt(m, summary[m].mae)}<small className="block muted">{fmtPct(summary[m].cover80, 0, l)} · {fmtPct(summary[m].cover90, 0, l)}</small></> : '—'}</td>)}
          </tr>
        ))}</tbody>
      </table></div>
      {shown ? <Chart t={t} pairs={shown.pairs.filter((p) => p.metric === 'transactions')} id={shown.vintage.id} /> : <p className="muted">{t('fh.none')}</p>}
      <MethodNote>{t('fh.method')}</MethodNote>
    </section>
  );
}

/** Forecast mean with its 80 % interval (bar) and the actual value (dot), per merchant-day, in date order. */
function Chart({ t, pairs, id }: { t: T; pairs: Pair[]; id: string }) {
  const ps = [...pairs].sort((a, b) => a.date.localeCompare(b.date) || a.merchant.localeCompare(b.merchant)).slice(0, 70);
  const max = Math.max(1, ...ps.map((p) => Math.max(p.hi80, p.actual))), W = 900, H = 200, L = 36, B = 22;
  const x = (i: number) => L + (i + 0.5) * ((W - L) / ps.length), y = (v: number) => H - B - (v / max) * (H - B - 8);
  const inside = ps.filter((p) => p.actual >= p.lo80 && p.actual <= p.hi80).length;
  return (
    <figure className="fh-chart">
      <figcaption>{t('fh.chart', { id, n: ps.length, inside })}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('fh.chartAria', { n: ps.length, inside })}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W} y1={y(f * max)} y2={y(f * max)} className="fh-grid" /><text x={L - 6} y={y(f * max) + 4} textAnchor="end">{Math.round(f * max)}</text></g>)}
        {ps.map((p, i) => {
          const ok = p.actual >= p.lo80 && p.actual <= p.hi80;
          return <g key={`${p.merchant}${p.date}`}>
            <title>{`${p.merchant} · ${p.date} · ${t('fh.tip', { f: fmtNum(p.forecast, 1, t.locale), lo: p.lo80, hi: p.hi80, a: p.actual })}`}</title>
            <line x1={x(i)} x2={x(i)} y1={y(p.lo80)} y2={y(p.hi80)} className="fh-band" />
            <line x1={x(i) - 3} x2={x(i) + 3} y1={y(p.forecast)} y2={y(p.forecast)} className="fh-mean" />
            <circle cx={x(i)} cy={y(p.actual)} r={2.6} className={ok ? 'fh-in' : 'fh-out'} />
          </g>;
        })}
      </svg>
      <div className="legend"><span><i className="fh-l-band" />{t('fh.band')}</span><span><i className="fh-l-mean" />{t('fh.mean')}</span><span><i className="fh-l-in" />{t('fh.inside')}</span><span><i className="fh-l-out" />{t('fh.outside')}</span></div>
    </figure>
  );
}
