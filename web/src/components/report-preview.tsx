'use client';
// Live preview of a report the assistant composed, under its answer: the real report page (embed
// route) scaled to the conversation width and scrollable, at the version that answer produced.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, FileText, Maximize2 } from 'lucide-react';
import { useT } from './i18n';

const DOC_W = 860; // width the report is laid out at before scaling

export function ReportPreview({ report, compact = false }: { report: { id: string; version: number; title: string }; compact?: boolean }) {
  const t = useT();
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
        <FileText aria-hidden /><span><b dir="auto">{report.title}</b><small>{t('rep.version', { n: report.version })} · {t('rs.previewTag')}</small></span>
        <Link href={`/reports/${report.id}`} title={t('rep.open')} aria-label={t('rep.open')}><Maximize2 aria-hidden /></Link>
        <a href={`/api/v1/reports/pdf?id=${report.id}`} title={t('rep.pdf')} aria-label={t('rep.pdf')}><Download aria-hidden /></a>
      </div>
      <div ref={box} className="rp-frame" style={{ height }}>
        <iframe src={`/embed/reports/${report.id}?v=${report.version}`} title={t('rep.preview', { title: report.title })} loading="lazy"
          style={{ width: DOC_W, height: height / scale, transform: `scale(${scale})` }} />
      </div>
    </div>
  );
}
