import Image from 'next/image';
// One report the assistant composed, as a document: header, sections, footer. Used by the report
// page, its PDF and the live preview shown in the conversation.
import { ReportSection } from '@/components/report-sections';
import { buildReport, reportMeta, specAt, type StoredReport } from '@/lib/custom-report';
import { fmtDate } from '@/lib/format';
import { makeT } from '@/lib/i18n';

export function ReportDocument({ r, version }: { r: StoredReport; version?: number }) {
  const t = makeT();
  const spec = specAt(r, version), meta = reportMeta(), sections = buildReport(spec), v = version && version < (r.version ?? 1) ? version : r.version ?? 1;
  return (
    <article className="panel report m-rise">
      <header className="report-head">
        <div><span className="report-brand"><Image src="/brand/satim-emblem.png" alt="" width={22} height={22} /><b>SATIM</b> · Anomaly Intelligence</span><h2 dir="auto">{spec.title}</h2>{spec.subtitle && <p dir="auto">{spec.subtitle}</p>}</div>
        <dl><dt>{t('rep.engineRun')}</dt><dd>{meta.run} ({meta.version})</dd><dt>{t('rs.asOf')}</dt><dd>{fmtDate(meta.asOf)} · {t('data.batch', { status: meta.batch }).toLowerCase()}</dd><dt>{t('rs.prepared')}</dt><dd>{t('rs.preparedBy', { date: fmtDate((r.updated ?? r.created).slice(0, 10)), v })}</dd></dl>
      </header>
      {sections.map((s, i) => <ReportSection key={i} s={s} />)}
      <p className="report-foot">{t('rs.foot', { engine: meta.version, run: meta.run })}{r.run_id !== meta.run ? ` ${t('rs.otherRun', { run: r.run_id })}` : ''} · {t('rs.footTail')}</p>
    </article>
  );
}
