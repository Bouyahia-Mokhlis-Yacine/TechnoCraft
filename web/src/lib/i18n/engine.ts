// Localised engine evidence. The snapshot carries English sentences next to the structured evidence;
// alert explanations are regenerated here from that evidence (indicator, observed, expected,
// interval, exposure, signal source), so every number is the engine's. The engine's fixed operator
// texts (first actions, responsible roles, limitations, hypotheses) map one to one; any text not
// listed is shown as the engine wrote it.
import type { Explanation } from '../snapshot';
import { currentLocale, fmtDzd, fmtInt, fmtNum, type Locale } from '../format';

const num = (v: number | null | undefined, l: Locale) => (v === null || v === undefined ? '—' : Math.abs(v) < 10 && !Number.isInteger(v) ? fmtNum(v, 1, l) : fmtInt(v, l));

/** The alert explanation in the operator's language, from the engine's evidence. */
export function explanationText(e: Explanation, locale?: Locale): string {
  const l = currentLocale(locale), fr = l === 'fr';
  const oe = e.observed_expected as Explanation['observed_expected'] & { exposure?: number | null; interval_coverage?: number | null };
  const money = e.indicator === 'median_ticket';
  const v = (x: number | null | undefined) => (money ? (x === null || x === undefined ? '—' : fmtDzd(x, l)) : num(x, l));
  const cov = oe.interval_coverage ? `${Math.round(oe.interval_coverage * 100)}${fr ? ' %' : '%'}` : '';
  const interval = oe.interval
    ? fr ? ` (intervalle prédictif à ${cov} : ${v(oe.interval[0])} à ${v(oe.interval[1])})` : ` (${cov} predictive interval ${v(oe.interval[0])} to ${v(oe.interval[1])})`
    : '';
  const persistent = e.signal_source === 'persistent_count';
  const dir = e.count_cusum?.direction === 'surge' || e.symptom === 'activity_surge' ? 'surge' : 'drop';
  const obs = v(oe.observed), exp = v(oe.expected), exposure = num(oe.exposure ?? null, l);
  let first: string;
  if (fr) {
    first = e.indicator === 'declines' ? `Paiements refusés : ${obs} sur ${exposure} transactions retenues, pour ${exp} attendus${interval}.`
      : e.indicator === 'cancellations' ? `Paiements annulés : ${obs} sur ${exposure} transactions retenues, pour ${exp} attendus${interval}.`
      : money ? `Ticket médian du jour : ${obs}, pour ${exp} attendu${interval}.`
      : `Nombre de transactions : ${obs}, pour ${exp} attendues${persistent ? '' : interval}.`;
    if (persistent) first += dir === 'surge' ? ' Une hausse persistante du nombre de transactions a déclenché l’alerte.' : ' Une baisse persistante du nombre de transactions a déclenché l’alerte.';
    return `${first} Les éléments décrivent le symptôme observé. Cause à confirmer.`;
  }
  first = e.indicator === 'declines' ? `Decline count was ${obs} across ${exposure} retained events, compared with an expected ${exp}${interval}.`
    : e.indicator === 'cancellations' ? `Cancellation count was ${obs} across ${exposure} retained events, compared with an expected ${exp}${interval}.`
    : money ? `Daily median ticket was ${obs} compared with an expected ${exp}${interval}.`
    : `Transaction count was ${obs} compared with an expected ${exp}${persistent ? '' : interval}.`;
  if (persistent) first += ` Persistent count ${dir} evidence drove the alert.`;
  return `${first} The evidence describes the observed symptom. Technical cause remains unverified.`;
}

const FR: Record<string, string> = {
  // first actions
  'Check closed-feed coverage and service availability, then review merchant activity.': 'Vérifier la couverture du flux clôturé et la disponibilité du service, puis examiner l’activité du commerçant.',
  'Compare channel rejection denominators and request response-code telemetry.': 'Comparer les refus par canal sur la même base et demander les codes de réponse de l’autorisation.',
  'Review channel volume and recent processing timestamps.': 'Examiner le volume par canal et les horodatages de traitement récents.',
  'Verify accepted amount coverage and compare ticket distributions with the merchant.': 'Vérifier la couverture des montants acceptés et comparer la distribution des tickets avec le commerçant.',
  'Review the cited indicator, reference window and data completeness.': 'Examiner l’indicateur cité, la fenêtre de référence et la complétude des données.',
  // responsible roles
  'SATIM service operations': 'Exploitation des services SATIM', 'SATIM authorization operations': 'Exploitation de l’autorisation SATIM',
  'SATIM monitoring analyst': 'Analyste de supervision SATIM', 'Acquiring-bank analyst': 'Analyste de la banque acquéreuse',
  // limitations
  'Low transaction exposure limits the resolution of failure-count tails.': 'Le faible nombre de transactions limite la précision sur les comptes extrêmes d’échecs.',
  'Zero retained activity on a closed roster day. Feed health is unverified.': 'Aucune activité retenue sur un jour clôturé du périmètre. L’état du flux n’est pas vérifié.',
  'Some amounts are missing or invalid. Amount evidence conditions on valid exposure.': 'Certains montants sont manquants ou invalides. Les éléments sur les montants ne portent que sur les montants valides.',
  'Gross payment activity, realized economic loss and SATIM revenue are distinct quantities.': 'L’activité de paiement brute, la perte économique réalisée et le revenu de SATIM sont des grandeurs distinctes.',
  'Count, rejection and value indicators describe overlapping activity. Report them separately.': 'Les indicateurs de volume, de refus et de montant décrivent une activité qui se recoupe : présentez-les séparément.',
  'Missing accepted amounts suppress the cumulative monetary gap.': 'Des montants acceptés manquants empêchent de calculer l’écart monétaire cumulé.',
  'Network intervals assume conditional independence across merchants.': 'Les intervalles du réseau supposent l’indépendance conditionnelle entre commerçants.',
  'Shared service shocks and holiday effects are outside the fitted reference.': 'Les chocs de service communs et les effets des jours fériés sont hors de la référence ajustée.',
  'Limit violations never make a merchant-day anomalous on their own.': 'Un dépassement de plafond ne rend jamais à lui seul un jour-commerçant anormal.',
  // triage and costs
  'provisional stakeholder assumptions': 'hypothèses provisoires des parties prenantes',
  'Illustrative, unverified business assumptions in common payment units': 'Hypothèses métier illustratives, non vérifiées, en unités de paiement courantes',
  // collective hypotheses
  'Observation or composition change': 'Changement d’observation ou de composition',
  'Shared channel authorization degradation': 'Dégradation commune de l’autorisation sur le canal',
  'Shared channel availability degradation': 'Dégradation commune de la disponibilité du canal',
  'Shared demand shift or processing backlog': 'Variation commune de la demande ou retard de traitement',
  'Check feed completeness, known merchant schedules and channel mix.': 'Vérifier la complétude du flux, les horaires connus des commerçants et la répartition par canal.',
  'Check service uptime and channel ingestion counters.': 'Vérifier la disponibilité du service et les compteurs d’ingestion du canal.',
  'Compare channel service and response-code telemetry.': 'Comparer la télémétrie du service du canal et les codes de réponse.',
  'Compare intraday volume and processing timestamps.': 'Comparer le volume intrajournalier et les horodatages de traitement.',
  'Independent feed, service and merchant schedule telemetry is unavailable.': 'Aucune télémétrie indépendante du flux, du service ou des horaires des commerçants n’est disponible.',
  'The grouping uses retained events and observed calendar dates.': 'Le regroupement utilise les transactions retenues et les dates calendaires observées.',
};
const FR_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(\d+) merchants meet the nominal local evidence cutoff\.$/, (m) => `${m[1]} commerçant(s) atteignent le seuil nominal de preuve locale.`],
  [/^(\d+) selected merchants lack local corroboration\.$/, (m) => `${m[1]} commerçant(s) sélectionné(s) sans corroboration locale.`],
];

/** An engine operator text in the operator's language (unchanged in English or when not listed). */
export function engineText(s: string | null | undefined, locale?: Locale): string {
  if (!s) return '';
  if (currentLocale(locale) !== 'fr') return s;
  if (FR[s]) return FR[s];
  for (const [re, f] of FR_PATTERNS) { const m = s.match(re); if (m) return f(m); }
  return s;
}
