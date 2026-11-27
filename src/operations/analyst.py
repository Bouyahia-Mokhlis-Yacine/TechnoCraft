"""Closed English/French intents with scoped, typed operations tools."""

from dataclasses import dataclass
import re
import unicodedata

import pandas as pd

from .backend import CHANNEL_KEYS


DATE = re.compile(r'(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)')
MERCHANT = re.compile(r'\bmer-\d+\b', re.IGNORECASE)
MERCHANT_TOKEN = re.compile(r'\bmer-[a-z0-9-]+\b')
SOURCE_ROW = re.compile(r'\b(?:source row|ligne source)\s+(\d+)\b')
DOMAIN_QUESTION = re.compile(r'\b(?:(?:contactless|nfc|sans contact).{0,45}(?:violations?|limits?|limite|plafond)|'
                             r'(?:violations?|exceeded|depass\w*).{0,45}(?:contactless|nfc|sans contact)|'
                             r'violating transactions|(?:negative|negatifs?)\s+(?:amounts?|montants?)|'
                             r'montants? negatifs?|domain rule|regle metier)\b')
CARD = re.compile(r'\b(?:masked.pan|pan|card numbers?|card identifiers?|cartes? bancaires?|numeros? de cartes?|'
                  r'carte masquee|fraud\w*)\b|(?<!\d)(?:\d[ -]?){12,19}(?!\d)|\*{3,}\d{2,}')
COMMAND = re.compile(r'\b(?:ignore|override|bypass|dump|sql|insert|delete|update|export|raw|credentials|'
                     r'instructions|supprime|contourne|exporte|brut|confidentiel|mot de passe)\b')
CAUSE = re.compile(r'\b(?:root cause|confirm\w*.{0,30}(?:outage|cause|panne)|cause (?:racine|exacte)|'
                   r'(?:who|what) caused|why did .{0,45} fail|definitiv\w* cause|qui a cause|responsable de la panne)\b')
INTENTS = {
    'procedure': r'\b(?:procedure\w*|playbook\w*|reference policy|protocole\w*)\b',
    'forecast': r'\b(?:forecast\w*|next week|next seven days|next 7 days|prevision\w*|semaine prochaine|a venir)\b',
    'collective': r'\b(?:collective|shared symptoms|similar symptoms|cross.merchant|collectif\w*|'
                  r'collective\w*|symptomes communs|plusieurs commercants)\b',
    'impact': r'\b(?:impact|affected activity|potential\w* affect\w*|shortfall|activite affectee|incidence)\b',
    'explanation': r'\b(?:why|flagged|explanation|pourquoi|signale\w*|explication)\b',
    'recommendations': r'\b(?:next action|first action|recommend\w*|prioritize|first step|'
                       r'premiere action|conseille\w*|recommand\w*|que faire)\b',
    'triage': r'\b(?:priorit\w*|triage|intervention|incident queue|file des incidents|urgents?)\b',
    'comparison': r'\b(?:compar\w*|versus| vs |difference|evolution|tendance)\b',
    'rejection': r'\b(?:unusual|unusually|atypique|inhabitu\w*|anormal\w*)\b',
    'channel': r'\b(?:channel\w*|canal|canaux)\b',
    'activity': r'\b(?:network|merchant|activity|transactions?|payment\w*|rejection\w*|'
                r'reseau|commercant\w*|activite|paiement\w*|rejet\w*|valeur)\b',
}
FR = re.compile(r'\b(?:quel\w*|pourquoi|combien|aujourd.hui|hier|reseau|activite|canal|canaux|'
                r'commercant\w*|prevision\w*|affectee|depuis|donne|montre|comparez|taux de|quels|'
                r'premiere|semaine|recommandations|avis|rejets|signale|paiements?)\b')
CHANNEL_ALIASES = {
    'ecommerce': r'\b(?:e.commerce|en ligne)\b', 'pos': r'\b(?:pos|tpe|terminal)\b',
    'mobile': r'\bmobile\b', 'nfc': r'\b(?:nfc|sans contact|contactless)\b',
    'transfer': r'\b(?:transfer\w*|virement\w*)\b', 'unknown': r'\b(?:unknown channel|canal inconnu)\b',
}
RELATIVE = {
    'yesterday': r'\b(?:yesterday|hier)\b', 'today': r'\b(?:today|aujourd.hui)\b',
    'week': r'\b(?:last (?:7|seven) days|(?:7|sept) derniers jours|past week)\b',
}
STRINGS = {
    'en': {
        'privacy': 'The read-only analyst answers scoped operational questions using aggregate evidence.',
        'unsupported_cause': 'Technical cause requires independent service or incident telemetry. Ask about observed symptoms.',
        'clarify': 'Specify one operational question, a merchant or channel where applicable, and a date or period.',
        'unavailable': 'The requested evidence is unavailable for the selected period or authorized scope.',
        'activity': '{count} retained transactions, {value:,.2f} observed accepted payment value and {rejected} rejections.',
        'partial': 'Accepted payment value coverage is incomplete.',
        'rate': 'The rejection rate was {rate:.2%} of retained transactions.',
        'no_rate': 'The rejection rate is unavailable at zero retained transactions.',
        'comparison': 'The preceding equal-length period had {count} retained transactions and {rejected} rejections.',
        'no_comparison': 'The preceding equal-length period has insufficient coverage.',
        'explanation': '{merchant} was flagged. {indicator}: {observed:,.3g} observed, {expected:,.3g} expected. Technical cause remains unverified.',
        'no_explanation': 'There is no V2 alert for this merchant on the selected day.',
        'no_queue': 'There are no matching incident entries on this closed day.',
        'triage': '{n} queue entries. First: {merchants}. {action}',
        'collective': '{n} collective advisories in the selected period. Shared technical cause remains unverified.',
        'collective_peak': 'The strongest was {channel} on {date}: {observed} observed versus {expected:,.1f} expected.',
        'rejection': '{observed} observed rejections against {expected:,.2f} expected at {count} retained transactions.',
        'upper_tail': 'The predictive upper-tail proportion is {tail:.1%} under the prior reference.',
        'impact': '{n} merchant incidents have usable monetary counterfactuals. The figures describe potentially affected gross payment activity.',
        'impact_peak': 'The largest estimated accepted-value shortfall is {value:,.2f} for {merchant}.',
        'forecast': 'Expected activity from {start} through {end} totals {count:,.1f} retained transactions. Daily predictive intervals are included.',
        'channels': '{n} channels have available scoped metrics. Evidence includes each rejection denominator.',
    },
    'fr': {
        'privacy': 'L’analyste en lecture seule répond aux questions opérationnelles autorisées à partir de données agrégées.',
        'unsupported_cause': 'Une cause technique exige des données indépendantes sur le service ou les incidents. Demandez les symptômes observés.',
        'clarify': 'Précisez une question opérationnelle, le commerçant ou le canal concerné, ainsi que la date ou la période.',
        'unavailable': 'Les données demandées sont indisponibles pour la période ou le périmètre autorisé.',
        'activity': '{count} transactions retenues, {value:,.2f} de paiements acceptés observés et {rejected} rejets.',
        'partial': 'La couverture des montants acceptés est incomplète.',
        'rate': 'Le taux de rejet était de {rate:.2%} des transactions retenues.',
        'no_rate': 'Le taux de rejet est indisponible en l’absence de transactions retenues.',
        'comparison': 'La période précédente de même durée comptait {count} transactions retenues et {rejected} rejets.',
        'no_comparison': 'La couverture de la période précédente est insuffisante.',
        'explanation': '{merchant} a été signalé. {indicator} : {observed:,.3g} observé, {expected:,.3g} attendu. La cause technique reste à vérifier.',
        'no_explanation': 'Aucun signalement V2 pour ce commerçant à cette date.',
        'no_queue': 'Aucun incident correspondant à cette date clôturée.',
        'triage': '{n} entrées dans la file. En tête : {merchants}. {action}',
        'collective': '{n} avis collectifs sur la période. La cause technique commune reste à vérifier.',
        'collective_peak': 'L’avis le plus marqué concerne {channel} le {date}, avec {observed} observés contre {expected:,.1f} attendus.',
        'rejection': '{observed} rejets observés contre {expected:,.2f} attendus sur {count} transactions retenues.',
        'upper_tail': 'La probabilité prédictive d’atteindre ou de dépasser cette valeur est de {tail:.1%} selon la référence.',
        'impact': '{n} incidents commerçants disposent d’une référence monétaire exploitable. Les montants décrivent une activité de paiement brute potentiellement affectée.',
        'impact_peak': 'Le plus grand écart estimé des paiements acceptés est de {value:,.2f} pour {merchant}.',
        'forecast': 'L’activité attendue du {start} au {end} totalise {count:,.1f} transactions retenues. Les intervalles de prévision figurent dans les données détaillées.',
        'channels': '{n} canaux disposent de mesures sur ce périmètre. Les données indiquent le dénominateur de chaque taux de rejet.',
    },
}
FRENCH_INDICATORS = {'transaction_count': 'nombre de transactions', 'declines': 'nombre de rejets',
                     'cancellations': 'nombre d’annulations', 'median_ticket': 'ticket médian'}
ENGLISH_INDICATORS = {'transaction_count': 'Transaction count', 'declines': 'Rejection count',
                      'cancellations': 'Cancellation count', 'median_ticket': 'Median payment amount'}
FRENCH_ACTIONS = {
    'activity_drop': 'Vérifier la couverture des données clôturées et la disponibilité du service.',
    'activity_surge': 'Examiner le volume du canal et les heures de traitement.',
    'rejection_increase': 'Comparer les dénominateurs et demander les codes de réponse.',
    'monetary_shift': 'Vérifier la couverture des montants acceptés et comparer les distributions.',
    'other': 'Consulter l’indicateur cité, sa référence et la couverture des données.',
    'recovery': 'Confirmer le retour à la normale par rapport à la référence et documenter le rétablissement.',
    'advisory': 'Valider la couverture des données et examiner les indices locaux avant de transmettre.',
}


def normalize(text):
    return ''.join(c for c in unicodedata.normalize('NFKD', text.lower()) if not unicodedata.combining(c))


@dataclass(frozen=True)
class Query:
    intent: str
    start: str
    end: str
    merchant: str | None
    channel: str | None


def _parse(normalized, as_of):
    matches = {intent for intent, pattern in INTENTS.items() if re.search(pattern, normalized)}
    if 'rejection' in matches and not re.search(r'\b(?:reject\w*|declin\w*|rejet\w*)\b', normalized):
        matches.remove('rejection')
    specific = matches - {'activity', 'channel', 'comparison', 'rejection'}
    source_row = SOURCE_ROW.search(normalized)
    if source_row and 'explanation' in matches:
        matches = specific = {'domain_transaction'}
    elif DOMAIN_QUESTION.search(normalized):
        matches = specific = ({'explanation'} if 'explanation' in matches or 'detected statistically' in normalized
                              else {'domain'})
    if specific == {'procedure', 'collective'}:
        specific = {'procedure'}
    if specific == {'triage', 'recommendations'}:
        specific = {'recommendations'}
    if len(specific) > 1 or not matches:
        raise ValueError('Ambiguous intent.')
    intent = next(iter(specific)) if specific else next(intent for intent in
        ('rejection', 'comparison', 'channel', 'activity') if intent in matches)
    merchants = set(MERCHANT.findall(normalized))
    if set(MERCHANT_TOKEN.findall(normalized)) != merchants:
        raise ValueError('Unknown merchant identifier format.')
    channels = {key for key, pattern in CHANNEL_ALIASES.items() if re.search(pattern, normalized)}
    absolute = DATE.findall(normalized)
    relative = {key for key, pattern in RELATIVE.items() if re.search(pattern, normalized)}
    if len(merchants) > 1 or len(channels) > 1 or len(absolute) > 2 or len(relative) > 1 or (absolute and relative):
        raise ValueError('Ambiguous scope.')
    merchant = next(iter(merchants), '').upper() or None
    channel = next(iter(channels), None)
    if absolute:
        start, end = pd.Timestamp(absolute[0]), pd.Timestamp(absolute[-1])
    elif relative == {'yesterday'}:
        start = end = as_of - pd.Timedelta(days=1)
    elif relative == {'week'}:
        start, end = as_of - pd.Timedelta(days=6), as_of
    elif intent == 'forecast':
        start = end = as_of + pd.Timedelta(days=1)
    else:
        start = end = as_of
    if start > end or (start != end and intent in
                       {'forecast', 'impact', 'triage', 'recommendations', 'explanation', 'rejection', 'domain_transaction'}):
        raise ValueError('This intent requires one date.')
    if channel and intent not in {'activity', 'channel', 'rejection', 'comparison', 'collective', 'procedure',
                                  'domain', 'domain_transaction', 'explanation'}:
        raise ValueError('This intent does not support a channel filter.')
    if intent in {'explanation', 'domain_transaction'} and merchant is None:
        raise ValueError('Explanation requires one merchant.')
    return Query(intent, start.date().isoformat(), end.date().isoformat(), merchant, channel)


def _activity_text(rows, strings):
    response = strings['activity'].format(count=rows['transactions'], value=rows['observed_accepted_value'],
                                          rejected=rows['rejections'])
    rate = rows['rejection_rate']
    response += ' ' + (strings['rate'].format(rate=rate) if rate is not None else strings['no_rate'])
    return response if rows['accepted_value_complete'] else f"{response} {strings['partial']}"


def evidence_answer(backend, scope, question, *, language=None):
    """Parse to a fixed tool map. No prompt text leaves this function or appears in its output."""
    if not isinstance(question, str):
        raise ValueError('Question must be a string.')
    n = normalize(question[:4096])
    lang = language if language in STRINGS else ('fr' if FR.search(n) else 'en')
    strings = STRINGS[lang]
    if CARD.search(n) or COMMAND.search(n) or len(question) > 4096:
        return {'status': 'refused', 'language': lang, 'answer': strings['privacy'], 'evidence': None}
    if CAUSE.search(n):
        return {'status': 'refused', 'language': lang, 'answer': strings['unsupported_cause'], 'evidence': None}
    try:
        query = _parse(n, backend.closed_through)
    except (ValueError, OverflowError):
        return {'status': 'clarify', 'language': lang, 'answer': strings['clarify'], 'evidence': None}
    try:
        evidence, answer = _resolve(backend, scope, query, strings, lang, n)
    except (ValueError, OverflowError):
        return {'status': 'unavailable', 'language': lang, 'answer': strings['unavailable'], 'evidence': None}
    end = evidence['days'][-1]['date'] if query.intent == 'forecast' else query.end
    return {'status': 'answered', 'language': lang, 'answer': answer, 'tool': query.intent,
            'query': vars(query), 'evidence': evidence,
            'reference': {'start': query.start, 'end': end, 'source': 'SATIM operations backend'}}


def _resolve(backend, scope, query, strings, lang, normalized):
    start, end, merchant, channel = query.start, query.end, query.merchant, query.channel
    intent = query.intent
    backend._merchants(scope, merchant)
    if intent in {'domain', 'domain_transaction'}:
        if not hasattr(backend, 'domain_activity'):
            raise ValueError('Domain evidence requires the candidate backend.')
        if intent == 'domain_transaction':
            data = backend.domain_transaction(scope, start, merchant, int(SOURCE_ROW.search(normalized)[1]))
            if channel and data['channel'] != channel:
                raise ValueError('Transaction evidence is outside the requested channel.')
            return data, data['explanation'] or (
                f"L’état de la règle pour cette transaction est {data['assessment']}." if lang == 'fr' else
                f"This transaction has rule assessment {data['assessment']}.")
        data = backend.domain_activity(scope, start, end, merchant=merchant, channel=channel)
        names = ', '.join(data['violation_merchants'])
        if lang == 'fr':
            answer = (f"{data['violation_count']} dépassement(s) sans contact pour {data['violation_value_dzd']:,.2f} DZD. "
                      f"{data['correction_count']} montant(s) négatif(s) corrigé(s).")
        else:
            answer = (f"{data['violation_count']} contactless violation(s) totaling {data['violation_value_dzd']:,.2f} DZD. "
                      f"{data['correction_count']} negative amount(s) corrected.")
        return data, f'{answer} {names}'.strip()
    if intent == 'procedure':
        from .procedures import find_procedure
        document = find_procedure(normalized, lang)
        if document is None:
            raise ValueError('No approved procedure matched the requested topic.')
        return document, document['excerpt']
    if intent == 'comparison':
        data = backend.comparison(scope, start, end, merchant=merchant, channel=channel)
        prior = data['previous_equal_period']
        text = (strings['comparison'].format(count=prior['transactions'], rejected=prior['rejections'])
                if prior else strings['no_comparison'])
        return data, f"{_activity_text(data['current'], strings)} {text}"
    if intent == 'channel' and channel is None:
        if start == end and re.search(r'\b(?:degradation|degraded|degrade\w*)\b', normalized):
            data = [backend.rejection_context(scope, start, merchant=merchant, channel=key)
                    for key in CHANNEL_KEYS if key != 'unknown']
            data.sort(key=lambda row: (row['upper_predictive_tail'] is None,
                                      row['upper_predictive_tail'] or 1., row['observed']['channel']))
        else:
            data = [backend.activity(scope, start, end, merchant=merchant, channel=key) for key in CHANNEL_KEYS]
        return data, strings['channels'].format(n=len(data))
    if intent in {'channel', 'activity'}:
        data = backend.activity(scope, start, end, merchant=merchant, channel=channel)
        return data, _activity_text(data, strings)
    if intent == 'rejection':
        data = backend.rejection_context(scope, start, merchant=merchant, channel=channel)
        observed = data['observed']
        text = strings['rejection'].format(observed=observed['rejections'], count=observed['transactions'],
                                            expected=data['expected_rejections_at_observed_exposure']['mean'])
        if data['upper_predictive_tail'] is not None:
            text += ' ' + strings['upper_tail'].format(tail=data['upper_predictive_tail'])
        return data, text
    if intent == 'explanation':
        if channel and (channel != 'nfc' or not hasattr(backend, 'domain_activity')):
            raise ValueError('This explanation does not support the requested channel.')
        data = backend.explanation(scope, start, merchant)
        if data is None:
            return None, strings['no_explanation']
        if 'detection_method' in data:
            method = data['detection_method']
            if lang == 'fr':
                label = {'both': 'statistique et règle métier', 'statistical': 'statistique',
                         'domain_rule': 'règle métier', None: 'correction de qualité des données'}[method]
                return data, f"Ce signal repose sur des éléments de type {label}. {data['explanation']}"
            return data, f"{data['explanation']} The evidence source is {(method or 'data quality').replace('_', ' ')}."
        indicator = FRENCH_INDICATORS if lang == 'fr' else ENGLISH_INDICATORS
        detail = data['observed_expected']
        if detail is None:
            return data, data['explanation'] if lang == 'en' else 'Le signalement V2 est disponible dans les données détaillées.'
        return data, strings['explanation'].format(merchant=merchant, indicator=indicator.get(data['indicator'], ''),
                                                    observed=detail['observed'], expected=detail['expected'])
    if intent == 'collective':
        data = [row for row in backend.advisories(scope, start, end)
                if (merchant is None or merchant in row['merchants']) and (channel is None or channel == row['channel'])]
        text = strings['collective'].format(n=len(data))
        if data:
            peak = max(data, key=lambda row: row['collective_log_likelihood_ratio'])
            text += ' ' + strings['collective_peak'].format(**peak)
        return data, text
    if intent == 'forecast':
        data = backend.forecast(scope, merchant=merchant, origin=start)
        return data, strings['forecast'].format(start=data['days'][0]['date'], end=data['days'][-1]['date'],
                                               count=sum(row['network']['transactions']['mean'] for row in data['days']))
    queue = [row for row in backend.queue(scope, start) if merchant is None or merchant in row['merchants']]
    if intent == 'impact':
        data = [row['impact'] for row in queue if row['impact'] is not None]
        pairs = [(row['cumulative']['accepted_value']['shortfall'], row['merchant_id']) for row in data
                 if row['cumulative']['accepted_value']['shortfall'] is not None]
        text = strings['impact'].format(n=len(pairs))
        if pairs:
            value, name = max(pairs)
            text += ' ' + strings['impact_peak'].format(value=value, merchant=name)
        return data, text
    if not queue:
        return queue, strings['no_queue']
    first = queue[0]
    action = first['first_action']
    if lang == 'fr':
        status = first['recovery_status']
        action = FRENCH_ACTIONS.get('recovery' if status in {'resolved', 'recovering'} else
                                   'advisory' if status == 'advisory' and first['data_reliability'] < .5 else
                                   first['symptom'], 'Vérifier le mode de paiement, le plafond et le résultat enregistré.')
    return queue, strings['triage'].format(n=len(queue), merchants=', '.join(first['merchants']), action=action)
