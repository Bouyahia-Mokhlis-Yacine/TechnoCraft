"""Describe statistical symptoms with the observed and predictive context."""

LABELS = {
    'transaction_count': 'Transaction count',
    'median_ticket': 'Daily median ticket',
    'declines': 'Decline count',
    'cancellations': 'Cancellation count',
}


def explain(key, evidence, availability):
    if availability != 'complete':
        return availability + ' batch', 'The batch was not confirmed closed. Merchant activity is unassessed.'
    if key is None:
        return 'Insufficient evidence', 'No primary signal had enough observations and reference support.'
    observed, expected = evidence['observed'], evidence['expected']
    lower, upper = evidence['interval']
    if evidence['score'] == 0:
        symptom = 'No unusual primary signal'
    elif key == 'transaction_count':
        if observed == 0 and expected > 0:
            symptom = 'Possible activity interruption'
        else:
            symptom = 'Activity shortfall' if observed < expected else 'Activity surge'
    elif key == 'median_ticket':
        symptom = 'Smaller tickets' if observed < expected else 'Larger tickets'
    else:
        symptom = 'Elevated declines' if key == 'declines' else 'Elevated cancellations'
    interval = f'{100 * evidence["interval_coverage"]:g}% predictive interval {lower:,.4g} to {upper:,.4g}'
    opportunities = f' across {evidence["exposure"]} retained events' if key in ('declines', 'cancellations') else ''
    return symptom, (f'{LABELS[key]} was {observed:,.4g}{opportunities}, compared with an expected '
                     f'{expected:,.4g} ({interval}). '
                     'The evidence describes the observed symptom. Technical cause remains unverified.')

