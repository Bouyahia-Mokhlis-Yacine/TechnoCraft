// Overview → "Needs attention": the one incident to act on now, from the existing ranking and review ledger.
// Supervisors (manage) get critical and unassigned cases first; analysts get cases already assigned, then the
// top of the queue. Respects the page's merchant filter and the account's pages. Cause never confirmed here.
import Link from 'next/link';
import { ArrowRight, CircleCheck } from 'lucide-react';
import { rankedIncidents } from '@/lib/api';
import { PLAYBOOK } from '@/lib/model';
import { observedVsExpected, TYPES } from '@/lib/labels';
import { can, canSee } from '@/lib/session';
import type { User } from '@/lib/accounts';
import { fmtDay } from '@/lib/format';
import { getT } from '@/lib/i18n/server';
import { LifecycleChip, ReviewChip, SeverityBadge } from './ui';

export async function NeedsAttention({ run, user, merchant, reviews, keep }: { run: string | null; user: User | null; merchant?: string; reviews: boolean; keep: (href: string) => string }) {
  const t = await getT();
  const open = rankedIncidents(run).filter((i) => i.open && (!merchant || i.merchant === merchant));
  const supervisor = can(user, 'manage');
  const pick = supervisor
    ? open.find((i) => i.severity === 'critical' && !i.review.owner) ?? open.find((i) => !i.review.owner) ?? open[0]
    : open.find((i) => i.review.status === 'assigned') ?? open[0];
  const linkable = !!user && canSee(user, '/incidents');
  if (!pick) {
    return (
      <section className="panel attention is-calm m-rise" aria-labelledby="att-h">
        <CircleCheck aria-hidden className="attention-ico" />
        <div><h2 id="att-h">{t('att.calmTitle')}</h2><p className="muted">{merchant ? t('att.calmMerchant', { merchant }) : t('att.calmBody')}</p></div>
      </section>
    );
  }
  const why = supervisor && pick.severity === 'critical' && !pick.review.owner ? t('att.whyCriticalFree')
    : supervisor && !pick.review.owner ? t('att.whyUnassigned') : !supervisor && pick.review.status === 'assigned' ? t('att.whyAssigned') : t('att.whyTop');
  const pb = PLAYBOOK[pick.type], a = pick.latest;
  return (
    <section className={`panel attention sev-${pick.severity} m-rise`} aria-labelledby="att-h">
      <div className="attention-main">
        <p className="attention-kicker"><b id="att-h">{t('att.title')}</b><span className="muted"> · {why}{open.length > 1 ? ` · ${t('att.others', { n: open.length - 1 })}` : ''}</span></p>
        <h2 className="attention-what">{t('att.what', { type: TYPES[pick.type].label, merchant: pick.merchant })}</h2>
        <div className="row attention-chips"><SeverityBadge severity={pick.severity} /><LifecycleChip l={pick.lifecycle} />{reviews && <ReviewChip s={pick.review.status} escalated={pick.review.escalated} />}</div>
        <dl className="attention-facts">
          <div><dt>{t('att.observed')}</dt><dd>{observedVsExpected(a)} <span className="muted">· {fmtDay(a.date)}</span></dd></div>
          <div><dt>{pick.review.owner ? t('att.owner') : t('att.role')}</dt><dd>{pick.review.owner ?? pb.owner}</dd></div>
          <div><dt>{t('att.first')}</dt><dd>{pb.steps[0]}</dd></div>
        </dl>
        <p className="muted small">{t('att.unconfirmed')}</p>
      </div>
      {linkable && <Link className="btn btn-primary attention-cta" href={keep(`/incidents/${pick.id}`)}>{t('side.openIncident')} <ArrowRight aria-hidden /></Link>}
    </section>
  );
}

/** Open incidents per severity as compact links to the filtered queue (replaces the bubble chart). */
export async function SeverityCounts({ mix, keep }: { mix: { severity: string; value: number }[]; keep: (href: string) => string }) {
  const t = await getT();
  const order = ['critical', 'high', 'medium', 'low'];
  return (
    <ul className="sev-counts">
      {order.map((s) => { const n = mix.find((x) => x.severity === s)?.value ?? 0; return (
        <li key={s}>{n ? <Link className={`sev-count sev-${s}`} href={keep(`/incidents?severity=${s}`)}><b>{n}</b><span>{t(`sev.${s}` as 'sev.critical')}</span></Link>
          : <span className={`sev-count sev-${s} is-zero`}><b>0</b><span>{t(`sev.${s}` as 'sev.critical')}</span></span>}</li>
      ); })}
    </ul>
  );
}
