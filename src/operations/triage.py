"""Deterministic incident ordering with explicit, provisional utility weights."""

from dataclasses import dataclass, field
from math import isfinite

from .impact import DEFAULT_COSTS, expected_cost


PROFILES = {
    'balanced': {'evidence': .12, 'transactions': .13, 'value': .19, 'persistence': .08, 'breadth': .08,
                 'channels': .06, 'urgency': .15, 'reliability': .07, 'actionability': .07, 'recovery': .05},
    'service': {'evidence': .12, 'transactions': .21, 'value': .08, 'persistence': .10, 'breadth': .10,
                'channels': .07, 'urgency': .15, 'reliability': .07, 'actionability': .05, 'recovery': .03},
    'value': {'evidence': .10, 'transactions': .07, 'value': .35, 'persistence': .07, 'breadth': .06,
              'channels': .05, 'urgency': .12, 'reliability': .08, 'actionability': .05, 'recovery': .05},
}
ACTIVE = {'active_incident': 1., 'recovering': .45, 'resolved': 0., 'advisory': .65}


@dataclass(frozen=True)
class TriagePolicy:
    # Provisional decision anchors. Change these with the same business units as the inputs.
    transaction_anchor: float = 35.
    value_anchor: float = 100000.
    persistence_anchor: float = 3.
    breadth_anchor: float = 3.
    channel_anchor: float = 2.
    evidence_anchor: float = 1.432641416752573
    weights: dict = field(default_factory=lambda: PROFILES['balanced'].copy())

    def __post_init__(self):
        anchors = (self.transaction_anchor, self.value_anchor, self.persistence_anchor,
                   self.breadth_anchor, self.channel_anchor, self.evidence_anchor)
        if any(not isfinite(value) or value <= 0 for value in anchors):
            raise ValueError('Utility anchors must be finite and positive.')
        if self.weights.keys() != PROFILES['balanced'].keys() or any(
                not isfinite(value) or value < 0 for value in self.weights.values()) or not sum(self.weights.values()):
            raise ValueError('Use a finite nonnegative weight per criterion with a positive total.')


ACTIONS = {
    'contactless_limit': ('SATIM authorization operations', 'Verify payment method, configured limit and recorded outcome.'),
    'activity_drop': ('SATIM service operations', 'Check closed-feed coverage and service availability, then review merchant activity.'),
    'activity_surge': ('SATIM monitoring analyst', 'Review channel volume and recent processing timestamps.'),
    'rejection_increase': ('SATIM authorization operations', 'Compare channel rejection denominators and request response-code telemetry.'),
    'monetary_shift': ('Acquiring-bank analyst', 'Verify accepted amount coverage and compare ticket distributions with the merchant.'),
    'other': ('SATIM monitoring analyst', 'Review the cited indicator, reference window and data completeness.'),
}


def _utility(x, anchor):
    return x / (x + anchor) if x is not None and x > 0 else 0.


def criteria(item, policy):
    phase = item['recovery_status']
    severity = ACTIVE[phase]
    return {
        'evidence': _utility(item['comparable_score'], policy.evidence_anchor),
        'transactions': _utility(item.get('affected_transactions'), policy.transaction_anchor),
        'value': _utility(item.get('potential_value'), policy.value_anchor),
        'persistence': _utility(item['duration_days'], policy.persistence_anchor),
        'breadth': _utility(len(item['merchants']), policy.breadth_anchor),
        'channels': _utility(len(item['channels']), policy.channel_anchor),
        'urgency': severity * {'activity_drop': 1., 'rejection_increase': 1., 'activity_surge': .55,
                               'monetary_shift': .5}.get(item['symptom'], .45),
        'reliability': item['data_reliability'],
        'actionability': 1. if item['symptom'] in ACTIONS and item['symptom'] != 'other' else .45,
        'recovery': severity,
    }


def _pareto_layers(utilities):
    """Peel dominance fronts and preserve a deterministic tie order within each."""
    remaining = set(utilities)
    levels = {}
    layer = 0
    while remaining:
        front = set()
        for key in remaining:
            target = utilities[key]
            dominated = any(all(utilities[other][k] >= target[k] for k in target)
                            and any(utilities[other][k] > target[k] for k in target)
                            for other in remaining if other != key)
            if not dominated:
                front.add(key)
        levels.update(dict.fromkeys(front, layer))
        remaining -= front
        layer += 1
    return levels


def ranked_queue(items, *, policy=None, method='mcda', cost_scenarios=DEFAULT_COSTS,
                 assumed_actionable_probability=None):
    """Rank copied evidence. Active handling precedes resolved follow-through in MCDA."""
    if method not in {'score', 'impact', 'mcda', 'pareto', 'cost'}:
        raise ValueError('Unknown triage method.')
    if method == 'cost' and assumed_actionable_probability is None:
        raise ValueError('Expected-cost ranking requires an explicitly assumed probability.')
    policy = policy or TriagePolicy()
    items = sorted(items, key=lambda item: item['id'])
    utilities = {item['id']: criteria(item, policy) for item in items}
    if len(utilities) != len(items):
        raise ValueError('A triage queue requires unique incident IDs.')
    fronts = _pareto_layers(utilities) if method == 'pareto' else {}
    results = []
    for item in items:
        values = utilities[item['id']]
        factors = {name: value * policy.weights[name] for name, value in values.items()}
        utility = sum(factors.values()) / sum(policy.weights.values())
        costs = [expected_cost(item.get('potential_value'), scenario,
                               actionable_probability=assumed_actionable_probability) for scenario in cost_scenarios]
        monetary = item.get('potential_value')
        central = next((cost for cost in costs if cost['scenario'] == 'central'), None)
        net_cost = (central['expected_cost_if_skipped'] - central['review_cost']
                    if central and central['expected_cost_if_skipped'] is not None else 0.)
        ordering = {
            'score': (-item['comparable_score'],),
            'impact': (monetary is None, -(monetary or 0.), -values['transactions']),
            'mcda': (item['recovery_status'] == 'resolved', -utility),
            'pareto': (item['recovery_status'] == 'resolved', fronts.get(item['id'], 0), -utility),
            'cost': (-net_cost,),
        }[method]
        drivers = sorted(factors, key=lambda factor: (-factors[factor], factor))[:3]
        criticality = ('resolved' if item['recovery_status'] == 'resolved' else 'high'
                       if utility >= .55 else 'elevated' if utility >= .35 else 'routine')
        role, action = ACTIONS.get(item['symptom'], ACTIONS['other'])
        if item['recovery_status'] in {'recovering', 'resolved'}:
            action = 'Confirm normalization against the pinned reference and document the recovery.'
        if item['recovery_status'] == 'advisory' and item['data_reliability'] < .5:
            action = 'Validate the batch and inspect local corroboration before escalation.'
        results.append((ordering, {**item, 'criticality': criticality, 'priority_utility': utility,
                                   'priority_explanation': {'method': method, 'leading_mcda_factors': drivers,
                                                            'criteria': values, 'weights': policy.weights.copy(),
                                                            'preference_status': 'provisional stakeholder assumptions'},
                                   'responsible_role': role, 'first_action': action, 'cost_scenarios': costs}))
    results.sort(key=lambda pair: (pair[0], pair[1]['id']))
    return [{'rank': rank, **item} for rank, (_, item) in enumerate(results, start=1)]
