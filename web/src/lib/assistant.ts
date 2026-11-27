// "Ask the Dashboard" (SRS FR-45–47): a local, read-only assistant. Every answer is built from the
// engine snapshot through an allowlist of queries below; nothing leaves the machine, no free-form
// query reaches the data, and nothing can change a flag, score or review.
import { getOverview, listAdvisories, listTransactions, merchantHealth, rankedIncidents, type Ranked } from './api';
import { addDays, model, PLAYBOOK, type Anomaly } from './model';
import { incidentHypotheses } from './insights';
import { fmtCompactDzd, fmtInt, fmtNum, fmtPct } from './format';

export type Lang = 'en' | 'fr';
export interface Reply {
  lang: Lang; intent: string; text: string[]; table?: { head: string[]; rows: string[][] };
  evidence: { label: string; href: string }[]; scope: string; refused?: 'prohibited' | 'card_data' | 'write' | 'unsupported'; suggestions: string[];
  /** who wrote the text: the local language model (numbers checked against the tool results) or the rules */
  source?: 'model' | 'rules';
  /** a report the assistant composed or changed in this answer (previewed under it) */
  report?: { id: string; version: number; title: string };
  /** language model: answered / configured but unreachable / not configured (unknown for guarded refusals) */
  model?: 'online' | 'offline' | 'off';
}

const MAX_ROWS = 6;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ── language ── */
const FR = /\b(pourquoi|quel(le)?s?|commercant|semaine|aujourd|hier|combien|prevision|canal|canaux|incidents? (non|ouverts)|refus|baisse|chute|donne|montre|est-ce|que dois|sante|resume|exposition|demain)\b/;
const DARIJA = /\b(wach|chhal|3lach|kifach|kayn|dyal|lyoum|lbare7|semana|chno|achno|smahli)\b/;
export const detectLang = (q: string): Lang => (FR.test(norm(q)) || DARIJA.test(norm(q)) ? 'fr' : 'en');

const T = {
  en: {
    scope: (what: string, from: string, to: string, run: string) => `Scope: ${what} · ${from} – ${to} · engine run ${run}`,
    refuseIntent: 'I only describe operational activity: volumes, amounts, declines and interruptions. I can’t judge intent or legality, and I don’t label merchants that way.',
    refuseCard: 'Card numbers are never available to the assistant or anywhere in this platform, masked or not.',
    refuseWrite: 'I’m read-only: I can’t acknowledge, assign, close or change anything. Open the incident page to act; your role decides what you can do there.',
    unsupported: 'I can’t answer that from the platform’s computed data. Here is what I can answer:',
    cause: 'The technical cause is not confirmed by this platform. To confirm it you would need gateway reason codes, terminal or switch logs, and the merchant’s operating status for that day.',
  },
  fr: {
    scope: (what: string, from: string, to: string, run: string) => `Périmètre : ${what} · ${from} – ${to} · exécution moteur ${run}`,
    refuseIntent: 'Je décris uniquement l’activité opérationnelle : volumes, montants, refus et interruptions. Je ne juge ni l’intention ni la légalité, et je ne qualifie pas les commerçants ainsi.',
    refuseCard: 'Les numéros de carte ne sont jamais accessibles à l’assistant ni ailleurs dans la plateforme, masqués ou non.',
    refuseWrite: 'Je suis en lecture seule : je ne peux ni acquitter, ni assigner, ni clôturer. Ouvrez la page de l’incident pour agir ; votre rôle détermine vos droits.',
    unsupported: 'Je ne peux pas répondre à cela à partir des données calculées. Voici ce que je sais faire :',
    cause: 'La cause technique n’est pas confirmée par la plateforme. Il faudrait les codes de refus de la passerelle, les journaux du terminal ou du switch, et l’état d’ouverture du commerçant ce jour-là.',
  },
};
const SUGGEST: Record<Lang, string[]> = {
  en: ['Which merchants had the largest activity shortfall this week?', 'Show the status and exposure of unresolved incidents', 'Which channels show concurrent abnormal behaviour?', 'Why was MER-6434 flagged?', 'Network summary for yesterday', 'Forecast for the next 7 days'],
  fr: ['Quels commerçants ont la plus forte baisse d’activité cette semaine ?', 'Statut et exposition des incidents non résolus', 'Quels canaux montrent un comportement anormal simultané ?', 'Pourquoi MER-6434 a-t-il été signalé ?', 'Résumé du réseau pour hier', 'Prévision pour les 7 prochains jours'],
};

/* ── dates and entities ── */
const fmtD = (iso: string, lang: Lang) => new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const MONTHS: Record<string, string> = { sep: '09', sept: '09', september: '09', septembre: '09', oct: '10', october: '10', octobre: '10', nov: '11', november: '11', novembre: '11' };

function period(q: string, asOf: string, first: string) {
  const n = norm(q);
  const iso = n.match(/\b(2026-\d{2}-\d{2})\b/)?.[1];
  const dm = n.match(/\b(\d{1,2})\s*(sep|sept|september|septembre|oct|october|octobre|nov|november|novembre)\b/);
  const day = iso ?? (dm ? `2026-${MONTHS[dm[2]]}-${dm[1].padStart(2, '0')}` : null);
  if (day && day >= first && day <= asOf) return { from: day, to: day, label: 'day' };
  if (/\b(today|aujourd|lyoum)\b/.test(n)) return { from: asOf, to: asOf, label: 'day' };
  if (/\b(yesterday|hier|lbare7)\b/.test(n)) return { from: addDays(asOf, -1), to: addDays(asOf, -1), label: 'day' };
  if (/(last week|semaine derniere|previous week)/.test(n)) return { from: addDays(asOf, -13), to: addDays(asOf, -7), label: 'week' };
  if (/(this month|ce mois|30 days|30 jours)/.test(n)) return { from: addDays(asOf, -29), to: asOf, label: 'month' };
  return { from: addDays(asOf, -6), to: asOf, label: 'week' };
}
const merchantIn = (q: string) => { const m = norm(q).match(/\bmer[-\s]?(\d{4})\b/); return m ? `MER-${m[1]}` : null; };
const CHANNELS: [RegExp, string][] = [
  [/e-?commerce|\bcib\b|edahabia|en ligne|online/, 'E-commerce (CIB / Edahabia)'], [/\b(pos|tpe|terminal)\b/, 'TPE / POS Terminal'],
  [/mobile|\bapp\b|application/, 'Mobile App'], [/contactless|\bnfc\b|sans contact/, 'Contactless / NFC'], [/transfer|virement/, 'Bank Transfer / Virement'],
];
const channelIn = (q: string) => CHANNELS.find(([r]) => r.test(norm(q)))?.[1] ?? null;

/* ── guards (run before any data access) ── */
export const PROHIBITED = /(fraud|fraude|fraudul|suspicious|suspect|scam|arnaque|escroq|criminal|crimin|illegal|illegal|launder|blanchi|stolen|\bvol(e|eur)?\b|احتيال|ghach|chefra)/;
const CARD = /(card number|card numbers|بطاق|كارت|\bpan\b|masked|numero de carte|numeros de carte|carte bancaire|\bcvv\b|\bbin\b)/;
const WRITE = /^(please\s+)?(close|assign|acknowledge|escalate|delete|remove|reopen|update|change|set|mark|ferme|fermer|cloture|assigne|assigner|acquitte|supprime|modifie|marque)\b/;
const CAUSE = /(what caused|root cause|cause of|why did .* fail|origine|cause de|qu.est-ce qui a cause|a cause)/;

/* ── French rendering of the engine evidence ── */
const TYPE_FR: Record<string, string> = { INTERRUPTION: 'Interruption d’activité', DROP_VOLUME: 'Baisse d’activité', ATYPICAL_SURGE: 'Hausse de volume', SPIKE_AMOUNT: 'Pic de montants', SPIKE_DECLINED: 'Pic de refus', NETWORK_DECLINES: 'Incident de refus réseau', CANCEL_SPIKE: 'Pic d’annulations' };
const CHECK_FR: Record<string, [string, string]> = {
  INTERRUPTION: ['Analyste + enquêteur technique', 'vérifier le filigrane d’ingestion, les horaires d’ouverture du commerçant et la connectivité terminal / passerelle.'],
  DROP_VOLUME: ['Analyste opérations', 'vérifier la complétude du flux et l’état d’ouverture du commerçant, puis l’acceptation sur son canal principal.'],
  ATYPICAL_SURGE: ['Analyste opérations', 'confirmer avec la banque acquéreuse si un événement explique le volume ; surveiller la capacité.'],
  SPIKE_AMOUNT: ['Analyste opérations', 'examiner la distribution des montants valides, l’activité de la catégorie et l’intégrité des données.'],
  SPIKE_DECLINED: ['Enquêteur technique', 'comparer les statuts par canal ; demander les codes de refus et les journaux de la passerelle.'],
  NETWORK_DECLINES: ['Enquêteur technique', 'traiter dans le cadre de l’avis réseau : demander codes de refus et journaux pour le canal.'],
  CANCEL_SPIKE: ['Analyste opérations', 'examiner le mix d’annulations et les comportements de relance / reprise.'],
};
function explainFr(a: Anomaly): string[] {
  const day = fmtD(a.date, 'fr'), u = (v: number | null) => (v === null ? 'n/d' : a.unit === 'DZD' ? `${fmtInt(v)} DZD` : a.unit === 'ratio' ? fmtPct(v, 1) : fmtInt(v));
  const head = a.unit === 'tx'
    ? `${a.merchant} a enregistré ${fmtInt(a.observed)} transactions le ${day}, contre ${u(a.expected)} attendues${a.lo !== null ? ` (plage normale ${a.lo}–${a.hi})` : ''}.`
    : a.unit === 'DZD' ? `Le paiement typique de ${a.merchant} le ${day} était de ${u(a.observed)}, contre ${u(a.expected)} attendu.`
    : `Le ${a.type === 'CANCEL_SPIKE' ? 'taux d’annulation' : 'taux de refus'} de ${a.merchant} a atteint ${u(a.observed)} le ${day}, contre ${u(a.expected)} attendu.`;
  const [owner, check] = CHECK_FR[a.type];
  return [`${TYPE_FR[a.type]} · gravité ${a.severity}, score ${a.score.toFixed(1).replace('.', ',')}.`, head, `Vérification suggérée (${owner}) : ${check}`];
}

/* ── intents ── */
type Ctx = { q: string; n: string; lang: Lang; from: string; to: string; merchant: string | null; channel: string | null; run: string };

function explainMerchant(c: Ctx, out: Reply) {
  const m = model(), id = c.merchant!;
  if (!m.byMerchant.has(id)) { out.text.push(c.lang === 'fr' ? `Je ne trouve pas ${id} dans cette exécution.` : `${id} is not in this run.`); return; }
  const flagged = m.anomalies.filter((a) => a.merchant === id && a.date <= c.to);
  const inRange = flagged.filter((a) => a.date >= c.from);
  const a: Anomaly | undefined = (inRange.length ? inRange : flagged).at(-1);
  if (!a) {
    out.text.push(c.lang === 'fr' ? `${id} n’a aucun jour signalé jusqu’au ${fmtD(c.to, 'fr')}.` : `${id} has no flagged day up to ${fmtD(c.to, 'en')}.`);
  } else {
    if (!inRange.length) out.text.push(c.lang === 'fr' ? `Aucun signalement dans la période ; le plus récent date du ${fmtD(a.date, 'fr')} :` : `Nothing flagged in that period; the latest flag is from ${fmtD(a.date, 'en')}:`);
    if (c.lang === 'fr') out.text.push(...explainFr(a));
    else {
      out.text.push(a.explanation);
      if (a.reasons.length) out.text.push(`Evidence: ${a.reasons.slice(0, 3).join(' · ')}.`);
      out.text.push(`Suggested check (${a.owner}): ${a.check}`);
    }
    out.text.push(T[c.lang].cause);
    out.evidence.push({ label: `${a.merchant} · ${a.date}`, href: `/alerts/${a.id}` }, { label: a.incidentId, href: `/incidents/${a.incidentId}` });
  }
  out.evidence.push({ label: `${id} history`, href: `/merchants/${id}` });
}

function health(c: Ctx, out: Reply) {
  const id = c.merchant!;
  if (!model().byMerchant.has(id)) { out.text.push(c.lang === 'fr' ? `Je ne trouve pas ${id}.` : `${id} is not in this run.`); return; }
  out.text.push(c.lang === 'fr' ? `Santé de ${id} sur les 7 derniers jours (composantes, pas de note globale) :` : `${id} health over the last 7 days (components, no single score):`);
  out.table = { head: c.lang === 'fr' ? ['Composante', 'État', 'Détail'] : ['Component', 'Level', 'Detail'], rows: merchantHealth(id).map((h) => [h.label, h.level, h.detail]) };
  out.evidence.push({ label: `${id}`, href: `/merchants/${id}` }, { label: 'Health brief', href: `/reports?type=merchant&merchant=${id}` });
}

function shortfall(c: Ctx, out: Reply) {
  const m = model();
  const rows = [...m.byMerchant.entries()].map(([id, ds]) => {
    const w = ds.filter((d) => d.date >= c.from && d.date <= c.to && d.expected_n_adj !== null);
    const exp = w.reduce((s, d) => s + (d.expected_n_adj ?? 0), 0), obs = w.reduce((s, d) => s + d.n, 0);
    return { id, exp, obs, gap: exp - obs };
  }).filter((r) => r.exp > 0 && r.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, MAX_ROWS);
  if (!rows.length) { out.text.push(c.lang === 'fr' ? 'Aucun commerçant n’est sous son niveau attendu sur la période.' : 'No merchant is below its expected level over the period.'); return; }
  const top = rows[0];
  out.text.push(c.lang === 'fr'
    ? `Plus forte baisse : ${top.id}, ${fmtInt(top.obs)} transactions contre ${fmtInt(top.exp)} attendues (−${fmtInt(top.gap)}, ${fmtPct(top.gap / top.exp, 0)}).`
    : `Largest shortfall: ${top.id}, ${fmtInt(top.obs)} transactions against ${fmtInt(top.exp)} expected (−${fmtInt(top.gap)}, ${fmtPct(top.gap / top.exp, 0)}).`);
  out.table = { head: c.lang === 'fr' ? ['Commerçant', 'Observé', 'Attendu', 'Écart'] : ['Merchant', 'Observed', 'Expected', 'Shortfall'], rows: rows.map((r) => [r.id, fmtInt(r.obs), fmtInt(r.exp), `−${fmtInt(r.gap)} (${fmtPct(r.gap / r.exp, 0)})`]) };
  out.text.push(c.lang === 'fr' ? 'Attendu = référence du moteur V2 (médiane des 28 jours précédents, même type de jour). Un écart n’est une alerte que si le moteur l’a signalé.' : 'Expected = the V2 engine’s reference (median of the previous 28 days of the same day type). A shortfall is only an alert if the engine flagged it.');
  for (const r of rows.slice(0, 3)) out.evidence.push({ label: r.id, href: `/merchants/${r.id}` });
}

function declines(c: Ctx, out: Reply) {
  const m = model();
  const rows = [...m.byMerchant.entries()].map(([id, ds]) => {
    const w = ds.filter((d) => d.date >= c.from && d.date <= c.to);
    const n = w.reduce((s, d) => s + d.n, 0), k = w.reduce((s, d) => s + d.n_dec, 0), e = w.reduce((s, d) => s + (d.expected_dec_rate ?? 0) * d.n, 0);
    return { id, n, k, e, excess: k - e };
  }).filter((r) => r.n >= 10 && r.excess > 0).sort((a, b) => b.excess - a.excess).slice(0, MAX_ROWS);
  if (!rows.length) { out.text.push(c.lang === 'fr' ? 'Aucun excès de refus sur la période.' : 'No merchant has excess declines over the period.'); return; }
  out.text.push(c.lang === 'fr' ? `Commerçants avec le plus de refus au-delà de l’attendu (au moins 10 transactions) :` : `Merchants with the most declines above their expected rate (at least 10 transactions):`);
  out.table = { head: c.lang === 'fr' ? ['Commerçant', 'Refusées', 'Taux', 'Attendu'] : ['Merchant', 'Declined', 'Rate', 'Expected'], rows: rows.map((r) => [r.id, `${r.k} / ${r.n}`, fmtPct(r.k / r.n, 1), `≈ ${fmtInt(r.e)} (${fmtPct(r.e / r.n, 1)})`]) };
  for (const r of rows.slice(0, 3)) out.evidence.push({ label: r.id, href: `/merchants/${r.id}` });
}

function channels(c: Ctx, out: Reply) {
  const ads = listAdvisories().filter((a) => a.date >= c.from && a.date <= c.to && (!c.channel || a.channel === c.channel));
  const ov = getOverview({ from: c.from, to: c.to });
  if (ads.length) {
    for (const a of ads) {
      const aff = a.members.filter((m) => m.affected).length;
      const symptom = a.symptom.replaceAll('_', ' ');
      out.text.push(c.lang === 'fr'
        ? [fmtD(a.date, 'fr'), a.channel, symptom, fmtInt(a.observed) + ' observés / ' + fmtNum(a.expected, 1) + ' attendus', aff + ' commerçants corroborés', 'avis V3'].join(' · ')
        : [fmtD(a.date, 'en'), a.channel, symptom, fmtInt(a.observed) + ' observed / ' + fmtNum(a.expected, 1) + ' expected', aff + ' merchants corroborated', 'V3 advisory'].join(' · '));
      out.evidence.push({ label: a.id, href: `/intelligence/${a.id}` });
    }
  } else out.text.push(c.lang === 'fr' ? 'Aucun comportement anormal simultané par canal détecté sur la période.' : 'No concurrent abnormal channel behaviour was detected in the period.');
  if (ov.trend.length <= 31) out.table = { head: c.lang === 'fr' ? ['Canal', 'Transactions', 'vs période précédente'] : ['Channel', 'Transactions', 'vs prior period'], rows: ov.channels.slice(0, MAX_ROWS).map((ch) => [ch.label, fmtInt(ch.value), ch.prior ? `${ch.value >= ch.prior ? '+' : '−'}${Math.abs(Math.round((ch.value / ch.prior - 1) * 100))} %` : 'N/A']) };
  out.evidence.push({ label: 'Intelligence', href: '/intelligence' });
}

function incidents(c: Ctx, out: Reply) {
  const open: Ranked[] = rankedIncidents().filter((i) => i.open && (!c.merchant || i.merchant === c.merchant));
  if (!open.length) { out.text.push(c.lang === 'fr' ? 'Aucun incident ouvert.' : 'There is no open incident.'); return; }
  const exp = open.some((i) => i.valueExposure === null) ? null : open.reduce((s, i) => s + (i.valueExposure ?? 0), 0);
  out.text.push(c.lang === 'fr'
    ? `${open.length} incident(s) ouvert(s), exposition estimée ${fmtCompactDzd(exp)} (estimation, pas une perte constatée). Classés par priorité :`
    : `${open.length} open incident(s), estimated exposure ${fmtCompactDzd(exp)} (an estimate, not a measured loss). Ranked by priority:`);
  out.table = {
    head: c.lang === 'fr' ? ['#', 'Incident', 'Commerçant', 'Gravité', 'État', 'Responsable', 'Exposition'] : ['#', 'Incident', 'Merchant', 'Severity', 'State', 'Owner', 'Exposure'],
    rows: open.slice(0, MAX_ROWS).map((i) => [String(i.rank), i.id, i.merchant, i.severity, `${i.lifecycle} · ${i.review.status}`, i.review.owner ?? '—', `${fmtInt(i.affectedEvents)} tx · ${fmtCompactDzd(i.valueExposure)}`]),
  };
  for (const i of open.slice(0, 3)) out.evidence.push({ label: i.id, href: `/incidents/${i.id}` });
}

function forecast(c: Ctx, out: Reply) {
  const f = model().snap.forecast;
  const pts = c.merchant ? f.merchants[c.merchant] : f.network;
  if (!pts) { out.text.push(c.lang === 'fr' ? `Pas de prévision pour ${c.merchant}.` : `No forecast for ${c.merchant}.`); return; }
  out.text.push(c.lang === 'fr'
    ? `Prévision indicative ${c.merchant ? `pour ${c.merchant}` : 'du réseau'} à partir du ${fmtD(f.origin, 'fr')}, intervalle à 80 %. Rétro-test : erreur moyenne ${fmtInt(f.backtest.mae_model)} contre ${fmtInt(f.backtest.mae_seasonal_naive)} pour la référence naïve, couverture ${fmtPct(f.backtest.interval_coverage, 0)}.`
    : `Advisory forecast ${c.merchant ? `for ${c.merchant}` : 'for the network'} from ${fmtD(f.origin, 'en')}, 80 % interval. Backtest: mean error ${fmtInt(f.backtest.mae_model)} vs ${fmtInt(f.backtest.mae_seasonal_naive)} for the seasonal-naive benchmark, coverage ${fmtPct(f.backtest.interval_coverage, 0)}.`);
  out.table = { head: c.lang === 'fr' ? ['Jour', 'Transactions · intervalle', 'Valeur acceptée', 'Refus'] : ['Day', 'Transactions · interval', 'Accepted value', 'Rejections'],
    rows: f.detail.days.map((day) => {
      const x = c.merchant ? day.merchants[c.merchant] : day.network;
      const count = x.transactions;
      return [fmtD(day.date, c.lang), count ? fmtInt(count.mean) + ' · ' + count.intervals['80'].join('–') : 'n/a',
        fmtCompactDzd(x.accepted_value?.mean ?? null), fmtNum(x.rejections?.mean ?? null)];
    }) };
  out.evidence.push({ label: c.merchant ?? 'Overview', href: c.merchant ? `/merchants/${c.merchant}` : '/' });
}

function summary(c: Ctx, out: Reply) {
  const ov = getOverview({ from: c.from, to: c.to, channel: c.channel ?? undefined, merchant: c.merchant ?? undefined }), k = ov.kpis;
  const vs = (v: number | null, p: number | null) => (v === null || p === null || p === 0 ? 'N/A' : `${v >= p ? '+' : '−'}${Math.abs(Math.round((v / p - 1) * 100))} %`);
  out.text.push(c.lang === 'fr'
    ? `${fmtInt(k.events.value)} transactions (${vs(k.events.value, k.events.prior)} vs période précédente), ${fmtCompactDzd(k.acceptedValue.value)} acceptés, taux de refus ${k.declineRate.value === null ? 'N/A' : fmtPct(k.declineRate.value, 1)}. ${k.affectedMerchants.value} commerçant(s) signalé(s), ${k.openIncidents.value} incident(s) ouvert(s).`
    : `${fmtInt(k.events.value)} transactions (${vs(k.events.value, k.events.prior)} vs the prior period), ${fmtCompactDzd(k.acceptedValue.value)} accepted, decline rate ${k.declineRate.value === null ? 'N/A' : fmtPct(k.declineRate.value, 1)}. ${k.affectedMerchants.value} merchant(s) flagged, ${k.openIncidents.value} open incident(s).`);
  out.table = { head: c.lang === 'fr' ? ['Indicateur', 'Valeur', 'Période précédente'] : ['Indicator', 'Value', 'Prior period'], rows: [
    [c.lang === 'fr' ? 'Transactions' : 'Transactions', fmtInt(k.events.value), k.events.prior === null ? 'N/A' : fmtInt(k.events.prior)],
    [c.lang === 'fr' ? 'Valeur acceptée' : 'Accepted value', fmtCompactDzd(k.acceptedValue.value), k.acceptedValue.prior === null ? 'N/A' : fmtCompactDzd(k.acceptedValue.prior)],
    [c.lang === 'fr' ? 'Taux de refus' : 'Decline rate', k.declineRate.value === null ? 'N/A' : fmtPct(k.declineRate.value, 1), k.declineRate.prior === null ? 'N/A' : fmtPct(k.declineRate.prior, 1)],
  ] };
  out.evidence.push({ label: c.lang === 'fr' ? 'Vue d’ensemble filtrée' : 'Filtered overview', href: `/?${new URLSearchParams({ from: c.from, to: c.to, ...(c.channel ? { channel: c.channel } : {}), ...(c.merchant ? { merchant: c.merchant } : {}) })}` });
}

function cause(c: Ctx, out: Reply) {
  // no date named: look across the whole run, so a past network event is found
  if (c.channel || /(outage|panne|channel|canal|network|reseau)/.test(c.n)) {
    if (c.from !== c.to) c.from = model().snap.run.first_date; // scope line then shows the real range
    channels(c, out);
  }
  else if (c.merchant) { explainMerchant(c, out); hypothesesFor(c, out); }
  else incidents(c, out);
}

/** Ranked, rule-based hypotheses for the merchant's latest incident: evidence, never a confirmed cause. */
function hypothesesFor(c: Ctx, out: Reply) {
  const inc = rankedIncidents().filter((i) => i.merchant === c.merchant).sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!inc) return;
  const hs = incidentHypotheses(inc).slice(0, 2);
  if (!hs.length) return;
  out.text.push(c.lang === 'fr' ? `Hypothèses classées pour ${inc.id} (aucune confirmée) :` : `Ranked hypotheses for ${inc.id} (none confirmed):`);
  hs.forEach((h, i) => out.text.push(`${i + 1}. ${h.title}${h.for.length ? ` · ${c.lang === 'fr' ? 'pour' : 'for'}: ${h.for.join('; ')}` : ''}${h.against.length ? ` · ${c.lang === 'fr' ? 'contre' : 'against'}: ${h.against.join('; ')}` : ''}`));
  out.evidence.push({ label: c.lang === 'fr' ? `Causes possibles · ${inc.id}` : `Possible causes · ${inc.id}`, href: `/incidents/${inc.id}` });
}

function nextCheck(c: Ctx, out: Reply) {
  const inc = rankedIncidents().filter((i) => i.open && (!c.merchant || i.merchant === c.merchant)).slice(0, 3);
  if (!inc.length) { out.text.push(c.lang === 'fr' ? 'Rien d’ouvert à vérifier.' : 'Nothing open to check.'); return; }
  for (const i of inc) {
    out.text.push(c.lang === 'fr' ? `${i.id} (${i.merchant}) · ${CHECK_FR[i.type][0]} : ${CHECK_FR[i.type][1]}` : `${i.id} (${i.merchant}) · ${PLAYBOOK[i.type].owner}: ${PLAYBOOK[i.type].check}`);
    out.evidence.push({ label: i.id, href: `/incidents/${i.id}` });
  }
  out.text.push(T[c.lang].cause);
}

function hybrid(c: Ctx, out: Reply) {
  const hybrid = model().snap.hybrid;
  if (!hybrid) { out.text.push('V4 advisory evidence is unavailable for this run.'); return; }
  const rows = hybrid.rows.filter((r) => (c.merchant ? r.merchant_id === c.merchant : r.investigation_candidate)
    && r.date >= c.from && r.date <= c.to).sort((a, b) => b.v4_advisory_score - a.v4_advisory_score);
  out.text.push(c.lang === 'fr' ? 'Classement consultatif V4. Le rang décrit la rareté historique du score ML.' :
    'V4 advisory ranking. The ordinary tail rank describes the rarity of Isolation Forest evidence.');
  if (!rows.length) out.text.push(c.lang === 'fr' ? 'Aucun résultat pour ce périmètre.' : 'No matching evidence in this period.');
  out.table = { head: ['Merchant', 'Date', 'Fusion score', 'Ordinary ML tail rank', 'Candidate'],
    rows: rows.slice(0, MAX_ROWS).map((r) => [r.merchant_id, r.date, fmtNum(r.v4_advisory_score, 3), fmtPct(r.v4_ordinary_rank, 2), r.investigation_candidate ? 'Yes' : '—']) };
  out.evidence.push({ label: 'V4 investigation evidence', href: '/intelligence#ml-candidates' });
}

function domain(c: Ctx, out: Reply) {
  const rule = model().snap.domain_rules.contactless;
  const scope = { from: c.from, to: c.to, merchant: c.merchant ?? undefined };
  const breaches = listTransactions({ ...scope, contactless: 'breach' }, 1).total;
  const known = breaches + listTransactions({ ...scope, contactless: 'within' }, 1).total;
  out.text.push(c.lang === 'fr'
    ? fmtInt(breaches) + ' paiements sans contact sur ' + fmtInt(known) + ' montants valides dépassent ' + fmtInt(rule.limit_dzd) + ' DZD. La fréquence élevée reflète les données synthétiques.'
    : fmtInt(breaches) + ' of ' + fmtInt(known) + ' contactless events with valid amounts exceed ' + fmtInt(rule.limit_dzd) + ' DZD. ' + rule.limitation);
  out.evidence.push({ label: 'Contactless evidence', href: '/transactions?' + new URLSearchParams({
    from: c.from, to: c.to, contactless: 'breach', ...(c.merchant ? { merchant: c.merchant } : {}),
  }) });
}

function quality(c: Ctx, out: Reply) {
  const r = model().snap.run;
  const rows = [['Retained events', r.cleaning.retained_events], ['Exact duplicates', r.cleaning.exact_duplicate],
    ['Negative amounts excluded from monetary metrics', r.cleaning.negative_amount], ['Missing amounts', r.cleaning.missing_amount]] as const;
  out.text.push((c.lang === 'fr' ? 'Archive disponible au ' : 'Archive data through ') + r.as_of + ' · ' + r.batch_status + ' · ' + r.preprocessing_version + '.');
  out.table = { head: ['Archive quality audit', 'Rows'], rows: rows.map(([label, n]) => [label, fmtInt(n)]) };
  out.evidence.push({ label: 'Data audit', href: '/data' });
}

function impact(c: Ctx, out: Reply) {
  const id = c.q.match(/MER-\d{4}:\d{4}-\d{2}-\d{2}/i)?.[0]?.toUpperCase();
  const rows = rankedIncidents().filter((i) => id ? i.id === id : (!c.merchant || i.merchant === c.merchant) && i.onset <= c.to && i.end >= c.from);
  out.text.push(c.lang === 'fr' ? 'Estimation de l’activité brute potentiellement affectée.' : 'Estimated gross payment activity affected by the observed incidents.');
  if (!rows.length) out.text.push(c.lang === 'fr' ? 'Aucun incident correspondant.' : 'No matching incident.');
  out.table = { head: ['Incident', 'Expected transactions', 'Observed transactions', 'Value shortfall', 'Excess rejections'],
    rows: rows.slice(0, MAX_ROWS).map((i) => {
      const x = i.evidence.impact.cumulative;
      return [i.id, fmtInt(x.transactions.expected ?? null), fmtInt(x.transactions.observed),
        fmtCompactDzd(x.accepted_value.shortfall ?? null), fmtInt(x.rejections.excess ?? null)];
    }) };
  out.evidence.push(...rows.slice(0, MAX_ROWS).map((i) => ({ label: i.id, href: '/incidents/' + i.id })));
}

const INTENTS: { name: string; test: (c: Ctx) => boolean; run: (c: Ctx, o: Reply) => void; what: (c: Ctx) => string }[] = [
  { name: 'help', test: (c) => /^(help|aide|\?)$|what can you|que (peux|sais)-tu|que pouvez/.test(c.n), run: () => {}, what: () => 'help' },
  { name: 'hybrid', test: (c) => /\b(v4|ml|isolation forest|investigation candidate)\b/.test(c.n), run: hybrid, what: (c) => c.merchant ?? 'V4 advisory' },
  { name: 'domain', test: (c) => /(contactless|nfc|sans contact)/.test(c.n) && /(limit|breach|violation|seuil|plafond)/.test(c.n), run: domain, what: (c) => c.merchant ?? 'contactless channel' },
  { name: 'quality', test: (c) => /(data quality|data audit|negative amount|missing amount|qualite des donnees)/.test(c.n), run: quality, what: () => 'whole archive' },
  { name: 'impact', test: (c) => /(business impact|payment impact|gross affected|value shortfall|impact economique)/.test(c.n), run: impact, what: (c) => c.merchant ?? 'incident impact' },
  { name: 'cause', test: (c) => CAUSE.test(c.n), run: cause, what: (c) => c.channel ?? c.merchant ?? 'network' },
  { name: 'explain', test: (c) => !!c.merchant && /(why|pourquoi|3lach|flag|signal|explain|expliqu)/.test(c.n), run: explainMerchant, what: (c) => c.merchant! },
  { name: 'summary', test: (c) => /(summary|resume|overview|recap|bilan)/.test(c.n), run: summary, what: () => 'network' },
  { name: 'health', test: (c) => !!c.merchant && /(health|sante|status of mer|etat de)/.test(c.n), run: health, what: (c) => c.merchant! },
  { name: 'next_check', test: (c) => /(what should|que dois|next step|prochaine etape|verifi|check first|who acts|qui agit)/.test(c.n), run: nextCheck, what: (c) => c.merchant ?? 'open incidents' },
  { name: 'incidents', test: (c) => /(incident|unresolved|non resolu|ouvert|open alert|exposure|exposition|queue|priorit)/.test(c.n), run: incidents, what: (c) => c.merchant ?? 'open incidents' },
  { name: 'forecast', test: (c) => /(forecast|next (7|seven) days|next week|prevision|prochains jours|demain|tomorrow)/.test(c.n), run: forecast, what: (c) => c.merchant ?? 'network' },
  { name: 'channels', test: (c) => /(channel|canal|canaux|concurrent|simultan|network.?wide|reseau|advisor|avis)/.test(c.n), run: channels, what: (c) => c.channel ?? 'all channels' },
  { name: 'declines', test: (c) => !c.merchant && /(declin|refus|rejet|reject)/.test(c.n), run: declines, what: () => 'all merchants' },
  { name: 'shortfall', test: (c) => /(shortfall|drop|largest .*activity|lowest|baisse|chute|manque|moins d.activite|tah)/.test(c.n), run: shortfall, what: () => 'all merchants' },
  { name: 'merchant', test: (c) => !!c.merchant, run: explainMerchant, what: (c) => c.merchant! },
  { name: 'kpis', test: (c) => /(summary|resume|overview|how many|combien|chhal|transactions|value|valeur|taux|rate|today|yesterday|hier|aujourd|week|semaine)/.test(c.n), run: summary, what: () => 'network' },
];

/** `lang` forces the reply language (the model's tools ask in English but show the user's language). */
export function answer(question: string, force?: Lang): Reply {
  const q = question.trim().slice(0, 500), n = norm(q), lang = force ?? detectLang(q);
  const m = model(), run = m.snap.run;
  const w = period(q, run.as_of, run.first_date);
  const base: Reply = { lang, intent: 'unsupported', text: [], evidence: [], scope: '', suggestions: SUGGEST[lang].slice(0, 3) };
  if (PROHIBITED.test(n)) return { ...base, intent: 'refused', refused: 'prohibited', text: [T[lang].refuseIntent], suggestions: SUGGEST[lang].slice(0, 3) };
  if (CARD.test(n)) return { ...base, intent: 'refused', refused: 'card_data', text: [T[lang].refuseCard] };
  if (WRITE.test(n)) return { ...base, intent: 'refused', refused: 'write', text: [T[lang].refuseWrite], evidence: [{ label: lang === 'fr' ? 'Incidents' : 'Incidents', href: '/incidents' }] };
  const c: Ctx = { q, n, lang, ...w, merchant: merchantIn(q), channel: channelIn(q), run: run.run_id };
  const intent = INTENTS.find((i) => i.test(c));
  if (!intent || intent.name === 'help') {
    return { ...base, intent: intent?.name ?? 'unsupported', refused: intent ? undefined : 'unsupported', text: [intent ? (lang === 'fr' ? 'Je réponds à partir des métriques calculées par le moteur, avec les preuves. Par exemple :' : 'I answer from the engine’s computed metrics, with the evidence. For example:') : T[lang].unsupported], suggestions: SUGGEST[lang] };
  }
  const out: Reply = { ...base, intent: intent.name, suggestions: SUGGEST[lang].filter((s) => !s.toLowerCase().startsWith(q.toLowerCase().slice(0, 12))).slice(0, 3) };
  intent.run(c, out);
  if (CAUSE.test(n) && !out.text.includes(T[lang].cause)) out.text.push(T[lang].cause);
  out.scope = T[lang].scope(intent.what(c), fmtD(c.from, lang), fmtD(c.to, lang), run.run_id);
  return out;
}
