'use client';
// Live preview of a report the assistant composed, under its answer: the real report page (embed
// route) scaled to the conversation width and scrollable, at the version that answer produced.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, FileText, Maximize2 } from 'lucide-react';

const DOC_W = 860; // width the report is laid out at before scaling

export function ReportPreview({ report, compact = false }: { report: { id: string; version: number; title: string }; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const height = compact ? 280 : 420;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / DOC_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="rp m-fade">
      <div className="rp-head">
        <FileText aria-hidden /><span><b dir="auto">{report.title}</b><small>Version {report.version} · preview</small></span>
        <Link href={`/reports/${report.id}`} title="Open the report" aria-label="Open the report"><Maximize2 aria-hidden /></Link>
        <a href={`/api/v1/reports/pdf?id=${report.id}`} download title="Download PDF" aria-label="Download PDF"><Download aria-hidden /></a>
      </div>
      <div ref={box} className="rp-frame" style={{ height }}>
        <iframe src={`/embed/reports/${report.id}?v=${report.version}`} title={`Preview of ${report.title}`} loading="lazy"
          style={{ width: DOC_W, height: height / scale, transform: `scale(${scale})` }} />
      </div>
    </div>
  );
}
