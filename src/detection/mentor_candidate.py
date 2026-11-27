"""Versioned candidate configuration, workload calibration and fusion policies."""

from copy import deepcopy
from dataclasses import dataclass
import json

import pandas as pd

from src.data.mentor_rules import DEFAULT_LIMIT_DZD, reference_events

from .calibration import RankCalibration
from .references import fit_reference
from .sequential import Fusion, RateBank, calibrated_threshold
from .sequential_evaluation import _trace


@dataclass(frozen=True)
class Candidate:
    version: str = 'satim-mentor-domain-v1'
    base: str = 'satim-probabilistic-v2'
    contactless_limit_dzd: float = DEFAULT_LIMIT_DZD
    limit_source: str = 'SATIM mentor confirmation'
    merchant_day_policy: str = 'advisory'
    cleaned_reference: bool = False
    synthetic_seed: int = 71027


def load_candidate(root):
    return Candidate(**json.loads((root / 'config/mentor_domain_rules.v1.json').read_text(encoding='utf-8')))


def domain_promotions(days, policy):
    if policy == 'advisory':
        return pd.Series(False, index=days.index)
    if policy == 'any':
        return days.violation_count.gt(0)
    if policy == 'repeated_accepted':
        return days.accepted_violations.ge(2)
    raise ValueError(f'Unknown merchant-day policy {policy!r}.')


def statistical_configuration(days, events, v1, v2, candidate):
    """Fit only the changed instantaneous scale and final managed workload cutoff."""
    if candidate.base != v2['version']:
        raise ValueError('The candidate requires its configured V2 base.')
    dates = v1['development']
    start, burden, boundary = (pd.Timestamp(dates[key]) for key in
                               ('calibration_start', 'burden_start', 'reserved_start'))
    history = days.loc[days.date.lt(boundary)]
    fitting_events = reference_events(events.loc[events.date.lt(boundary)], candidate.cleaned_reference)
    candidate_v1 = dict(v1, version=candidate.version)
    name = v2['primary_bank']
    bank = RateBank(tuple(v2['ratio_banks'][name]))

    def traces(first, end):
        reference = fit_reference(history, fitting_events, first, candidate.version)
        dates = pd.date_range(first, end, inclusive='left')
        return list(_trace(history, events.loc[events.date.lt(end)], dates, reference, candidate_v1, {name: bank}))

    cal, ordinary = traces(start, burden), traces(burden, boundary)
    instantaneous = RankCalibration.fit(daily['anomaly_score'] for _, daily, _ in cal)
    instant_scale = calibrated_threshold(instantaneous, v2['fusion_anchor_tail_rank'])
    archived_fusion = v2['frozen']['fusion'][name]
    fusion = Fusion(instant_scale, archived_fusion['sequential_scale'], archived_fusion['persistence'])

    def managed(rows):
        return [fusion.scores(daily, tracks[name])['managed'] for _, daily, tracks in rows]

    ranks = RankCalibration.fit(managed(cal))
    burden_scores = managed(ordinary)
    budget = v2['frozen']['budget_per_merchant_week']
    options = [(calibrated_threshold(ranks, alpha), {'alpha': alpha}) for alpha in v2['candidate_tail_ranks']]
    options.extend((ranks.scores[-1] * mult, {'alpha': None, 'above_max_multiplier': mult})
                   for mult in v2['above_max_multipliers'])
    eligible = []
    for threshold, meta in options:
        if threshold is not None:
            alerts = sum(score >= threshold for score in burden_scores)
            if 7 * alerts / len(ordinary) <= budget:
                eligible.append(dict(meta, threshold=threshold, ordinary_alerts=alerts))
    rank_options = [row for row in eligible if row['alpha'] is not None]
    chosen = min(rank_options or eligible, key=lambda row: row['threshold'],
                 default={'threshold': None, 'alpha': None, 'ordinary_alerts': 0})
    config = deepcopy(v2)
    config['version'] = candidate.version
    config['frozen']['fusion'][name]['instant_scale'] = float(instant_scale)
    config['frozen']['policies'][f'{name}/managed'] = chosen
    return candidate_v1, config
