// One report the assistant composed, as a document: header, sections, footer. Used by the report
// page, its PDF and the live preview shown in the conversation.
import { ReportSection } from '@/components/report-sections';
import { buildReport, reportMeta, specAt, type StoredReport } from '@/lib/custom-report';
import { fmtDate } from '@/lib/format';

export function ReportDocument({ r, version }: { r: StoredReport; version?: number }) {
  const spec = specAt(r, version), meta = reportMeta(), sections = buildReport(spec), v = version && version < (r.version ?? 1) ? version : r.version ?? 1;
  return (
    <article className="panel report m-rise">
      <header className="report-head">
        <div><span className="muted">SATIM · Payment Anomaly Intelligence</span><h2 dir="auto">{spec.title}</h2>{spec.subtitle && <p dir="auto">{spec.subtitle}</p>}</div>
        <dl><dt>Engine run</dt><dd>{meta.run} ({meta.version})</dd><dt>Data as of</dt><dd>{fmtDate(meta.asOf)} · batch {meta.batch}</dd><dt>Prepared</dt><dd>{fmtDate((r.updated ?? r.created).slice(0, 10))} by the assistant · version {v}</dd></dl>
      </header>
      {sections.map((s, i) => <ReportSection key={i} s={s} />)}
      <p className="report-foot">Figures computed by engine {meta.version} from run {meta.run}{r.run_id !== meta.run ? ` (prepared on run ${r.run_id}; figures shown are from the current run)` : ''} · causes not confirmed · exposure is an estimate, not a loss · no card data.</p>
    </article>
  );
}
