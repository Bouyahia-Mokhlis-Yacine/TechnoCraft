"""Counterfactual operational exposure and explicitly assumed review economics."""

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .forecasting import generator, predictive_draws, summarize


def value_baseline(reference, merchant, day, *, weekday, draws, seed):
    """Empirical predictive baseline around the prior historical mean."""
    values = reference.weekday_values.get((merchant, day.weekday())) if weekday else None
    if values is None:
        values = reference.value_days.get(merchant, reference.fleet_values)
    if not len(values):
        return None, None
    rng = generator(seed, reference.origin, merchant, day, 'value_baseline', weekday)
    return rng.choice(values, draws), float(values.mean())


def _shortfall(distribution, expected, observed):
    if distribution is None or observed is None:
        return {'observed': observed, 'expected': expected, 'shortfall': None, 'signed_gap': None}
    return {'observed': observed, 'expected': float(expected),
            'shortfall': max(0., float(expected - observed)),
            'signed_gap': summarize(distribution - observed, expected - observed)}


def _measurements(observed, samples, means):
    complete_amounts = observed.valid_accepted_amount_count == observed.accepted_count
    acceptance_value = float(observed.accepted_amount) if complete_amounts else None
    return {
        'transactions': _shortfall(samples['transactions'], means['transactions'], int(observed.transaction_count)),
        'accepted_value': _shortfall(samples['accepted_value'], means['accepted_value'], acceptance_value),
        'rejections': _shortfall(samples['rejections'], means['rejections'], int(observed.declined_count)),
    }


def incident_impact(reference, merchant, observations, *, model='gamma_poisson', draws=512, seed=20261127):
    """Estimate a single merchant's episode against one prior, pinned counterfactual."""
    observations = observations.sort_values('date')
    dates = tuple(observations.date)
    if not dates or observations.merchant_id.ne(merchant).any() or observations.transaction_count.isna().any():
        raise ValueError('Impact requires complete observations for one merchant.')
    trajectory = predictive_draws(reference, merchant, dates, model=model, draws=draws, seed=seed)
    row = reference.totals.loc[merchant] if merchant in reference.totals.index else None
    rejection = reference.outcome_prior[1] + (row.declined_count if row is not None else 0)
    opportunities = reference.outcome_prior.sum() + (row.transaction_count if row is not None else 0)
    rejection_rate = rejection / opportunities
    reject_rng = generator(seed, reference.origin, merchant, 'conditional_rejections')
    posterior_rate = reject_rng.beta(rejection, opportunities - rejection, size=draws)
    conditional_counts = []
    details = []
    for record, (samples, means) in zip(observations.itertuples(index=False), trajectory):
        metrics = _measurements(record, samples, means)
        conditional_draws = generator(seed, reference.origin, merchant, record.date, 'rejection_exposure').binomial(
            record.transaction_count, posterior_rate)
        conditional_counts.append(conditional_draws)
        expected_at_exposure = float(record.transaction_count * rejection_rate)
        metrics['rejections'] = {'observed': int(record.declined_count), 'expected_unconditional': means['rejections'],
                                 'expected_at_observed_exposure': expected_at_exposure,
                                 'excess': max(0., float(record.declined_count - expected_at_exposure)),
                                 'signed_excess': summarize(record.declined_count - conditional_draws,
                                                            record.declined_count - expected_at_exposure)}
        details.append({'date': record.date.date().isoformat(), **metrics})
    cumulative = {}
    for metric in ('transactions', 'accepted_value'):
        outcomes = [item[metric]['observed'] for item in details]
        arrays = [item[0][metric] for item in trajectory]
        means = [item[1][metric] for item in trajectory]
        cumulative[metric] = _shortfall(
            np.sum(arrays, axis=0) if all(array is not None for array in arrays) else None,
            sum(means) if all(mean is not None for mean in means) else None,
            sum(outcomes) if all(outcome is not None for outcome in outcomes) else None)
    conditional = sum(item['rejections']['expected_at_observed_exposure'] for item in details)
    observed_rejections = int(observations.declined_count.sum())
    cumulative['rejections'] = {'observed': observed_rejections,
                                'expected_unconditional': sum(d['rejections']['expected_unconditional'] for d in details),
                                'expected_at_observed_exposure': conditional,
                                'excess': max(0., observed_rejections - conditional),
                                'signed_excess': summarize(observed_rejections - np.sum(conditional_counts, axis=0),
                                                           observed_rejections - conditional)}
    return {
        'merchant_id': merchant, 'start': dates[0].date().isoformat(), 'end': dates[-1].date().isoformat(),
        'duration_days': int((dates[-1] - dates[0]).days + 1), 'observed_days': len(dates),
        'interpretation': 'Potentially affected gross payment activity',
        'reference': reference.support(merchant), 'count_model': model, 'daily': details, 'cumulative': cumulative,
        'data_quality': {'complete_accepted_value_days': sum(d['accepted_value']['observed'] is not None for d in details),
                         'unknown_status_events': int(observations.unknown_status_count.sum())},
        'limitations': ['Gross payment activity, realized economic loss and SATIM revenue are distinct quantities.',
                        'Count, rejection and value indicators describe overlapping activity. Report them separately.',
                        'Missing accepted amounts suppress the cumulative monetary gap.'],
    }


@dataclass(frozen=True)
class CostScenario:
    name: str
    analyst_minutes: float
    analyst_hourly_cost: float
    missed_incident_fixed_cost: float
    recovery_proportion: float
    economic_exposure_rate: float
    relationship_risk_probability: float
    relationship_impact: float

    def __post_init__(self):
        rates = (self.recovery_proportion, self.economic_exposure_rate, self.relationship_risk_probability)
        costs = (self.analyst_minutes, self.analyst_hourly_cost, self.missed_incident_fixed_cost,
                 self.relationship_impact)
        if any(not np.isfinite(rate) or not 0 <= rate <= 1 for rate in rates) or any(
                not np.isfinite(cost) or cost < 0 for cost in costs):
            raise ValueError('Cost assumptions require nonnegative finite inputs and rates in [0, 1].')


DEFAULT_COSTS = (
    CostScenario('conservative', 10, 900, 0, .9, .002, 0., 0),
    CostScenario('central', 15, 1500, 500, .65, .008, .02, 10000),
    CostScenario('high_impact', 25, 2400, 1500, .35, .02, .08, 25000),
)


def expected_cost(potential_value, scenario, *, actionable_probability=None):
    """Operational scenario arithmetic. Probability is an optional external assumption."""
    if potential_value is not None and (not np.isfinite(potential_value) or potential_value < 0):
        raise ValueError('Potentially affected value must be finite and nonnegative.')
    if actionable_probability is not None and (
            not np.isfinite(actionable_probability) or not 0 <= actionable_probability <= 1):
        raise ValueError('An assumed probability must lie in [0, 1].')
    review = scenario.analyst_minutes * scenario.analyst_hourly_cost / 60
    fixed = scenario.missed_incident_fixed_cost + scenario.relationship_risk_probability * scenario.relationship_impact
    exposure = (None if potential_value is None else potential_value * (1 - scenario.recovery_proportion)
                * scenario.economic_exposure_rate)
    missed = None if exposure is None else fixed + exposure
    return {'scenario': scenario.name, 'assumptions': vars(scenario).copy(), 'review_cost': review,
            'conditional_missed_incident_cost': missed, 'assumed_actionable_probability': actionable_probability,
            'expected_cost_if_skipped': missed * actionable_probability
            if missed is not None and actionable_probability is not None else None,
            'break_even_actionable_probability': review / missed if missed and review <= missed else None,
            'evidence_class': 'Illustrative, unverified business assumptions in common payment units'}
