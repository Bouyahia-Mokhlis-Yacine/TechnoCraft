"""Specialized detector functions and the structured SATIM scoring entry point."""

import numpy as np
import pandas as pd
from scipy import stats

from .calibration import PRIMARY, fuse
from .distributions import conditional_draws, discrete_log_tail, evidence_score, two_sided
from .explanations import explain
from .references import AMOUNTS, OUTCOMES

ALL_METRICS = (*PRIMARY, 'attempted_value', 'accepted_value')


def _record(observed=None, expected=None, interval=None, exposure=None, log_p=None,
            method=None, reason=None, interval_coverage=None):
    relative = None if observed is None or not expected else float((observed - expected) / expected)
    return {'observed': observed, 'expected': expected, 'interval': interval,
            'interval_coverage': interval_coverage, 'relative_deviation': relative,
            'exposure': exposure, 'method': method, 'reason': reason,
            'tail_probability': None if log_p is None else float(np.exp(log_p)),
            'score': None if log_p is None else evidence_score(log_p)}


def _limits(law, coverage):
    return tuple(float(x) for x in law.ppf(((1 - coverage) / 2, (1 + coverage) / 2)))


def count_evidence(row, reference, config):
    days, y, exposure, _, _ = reference.totals.get(row.merchant_id, (0, 0, 0., 0, 0))
    weekday = reference.weekday.get(row.date.weekday(), 1.)
    if days >= config['established_days']:
        law = stats.poisson(weekday * y / exposure)
        method = 'weekday_merchant_poisson'
    else:
        a, b = reference.gamma
        rate = b + exposure
        law = stats.nbinom(a + y, rate / (rate + weekday))
        method = 'global_gamma_poisson'
    observed = int(row.transaction_count)
    lower, upper = (discrete_log_tail(law, observed, upper=side) for side in (False, True))
    coverage = config['interval_coverage']
    result = _record(observed, float(law.mean()), _limits(law, coverage), log_p=two_sided(lower, upper),
                     method=method, interval_coverage=coverage)
    result['lower_tail_probability'] = float(np.exp(lower))
    result['upper_tail_probability'] = float(np.exp(upper))
    result['interruption_score'] = evidence_score(lower)
    return result


def outcome_evidence(row, reference, metric, coverage):
    exposure = int(row.transaction_count)
    observed = int(getattr(row, OUTCOMES[metric]))
    if not exposure:
        return _record(observed=observed, exposure=0, reason='no retained events')
    index = 3 if metric == 'declines' else 4
    total = reference.totals.get(row.merchant_id, (0, 0, 0., 0, 0))
    center, strength = reference.outcomes[metric]
    p = (total[index] + strength * center) / (total[1] + strength)
    law = stats.binom(exposure, p)
    result = _record(observed, float(law.mean()), _limits(law, coverage), exposure,
                     discrete_log_tail(law, observed, upper=True), 'empirical_bayes_binomial',
                     interval_coverage=coverage)
    result['expected_rate'] = float(p)
    result['observed_rate'] = observed / exposure
    return result


def amount_evidence(row, reference, metric, config):
    if metric == 'median_ticket':
        observed, exposure = row.amount_median, int(row.valid_amount_count)
        eligible = int(row.transaction_count)
    elif metric == 'attempted_value':
        observed, exposure = row.attempted_amount, int(row.valid_attempted_amount_count)
        eligible = int(row.transaction_count - row.refunded_count)
    else:
        observed, exposure = row.accepted_amount, int(row.valid_accepted_amount_count)
        eligible = int(row.accepted_count)

    if not eligible and metric != 'median_ticket':
        result = _record(0., 0., (0., 0.), 0, reason='no qualifying events')
    elif not exposure:
        reason = 'no qualifying events' if not eligible else 'all qualifying amounts missing or invalid'
        result = _record(exposure=0, reason=reason)
    else:
        pool = reference.pools[metric]
        if not pool.counts:
            result = _record(observed=float(observed), exposure=exposure, reason='no eligible historical amounts')
        else:
            draws = conditional_draws(pool, row.merchant_id, row.date, metric, exposure,
                                      config['resampling_draws'], config['seed'])
            lo, hi = ((1 - config['interval_coverage']) / 2, (1 + config['interval_coverage']) / 2)
            # A log/exp round trip can place tied monetary values a few ULPs apart.
            tolerance = abs(observed) * 1e-12
            lower = (1 + np.count_nonzero(draws <= observed + tolerance)) / (len(draws) + 1)
            upper = (1 + np.count_nonzero(draws >= observed - tolerance)) / (len(draws) + 1)
            point = np.median(draws) if metric == 'median_ticket' else np.mean(draws)
            result = _record(float(observed), float(point), tuple(float(x) for x in np.quantile(draws, (lo, hi))),
                             exposure, two_sided(np.log(lower), np.log(upper)), 'conditional_empirical',
                             interval_coverage=config['interval_coverage'])
            result.update(lower_tail_probability=lower, upper_tail_probability=upper)
            if config.get('capture_reference_sd', False):
                result['reference_sd'] = float(np.std(draws, ddof=1))
    result['eligible_events'] = eligible
    result['missing_or_invalid_amounts'] = eligible - exposure
    return result


def positive_ticket_evidence(amounts, merchant, reference, coverage):
    """Return per-positive-ticket evidence with no amount-scale moment assumptions."""
    pool = reference.pools['median_ticket']
    values = np.asarray(amounts, dtype=float)
    positive = np.isfinite(values) & (values > 0)
    values = values[positive]
    if len(values) == 0 or reference.log_t is None:
        return []
    anchor = pool.anchor(merchant)
    log_t = reference.log_t
    interval = tuple(float(np.exp(anchor + x)) for x in _limits(log_t, coverage))
    median = float(np.exp(anchor + log_t.median()))
    centered = np.log(values) - anchor
    lower, upper = log_t.logcdf(centered), log_t.logsf(centered)
    return [_record(float(value), median, interval, log_p=two_sided(lo, hi),
                    method='pooled_log_student_t', interval_coverage=coverage)
            for value, lo, hi in zip(values, lower, upper)]


def channel_evidence(row, reference):
    output = {}
    for metric, status in zip(OUTCOMES, ('declined', 'cancelled')):
        values = {}
        for channel, (peer, local) in reference.channels[metric].items():
            exposure = int(getattr(row, f'{channel}_count'))
            if exposure:
                p = local.get(row.merchant_id, peer)
                actual = int(getattr(row, f'{channel}_{status}'))
                expected, variance = exposure * p, exposure * p * (1 - p)
                values[channel] = {'exposure': exposure, 'observed': actual, 'expected': expected,
                                   'variance': variance}
        output[metric] = values
    return output


def score_day(days, events, day, batch, reference, config, *, calibration=None, alpha=None):
    """Score only the requested calendar date. Labels are outside this interface."""
    day = pd.Timestamp(day).normalize()
    if reference.as_of > day or reference.last_date >= day:
        raise ValueError('The snapshot is not strictly prior to this forecast.')
    if reference.model_version != config['version']:
        raise ValueError('Reference model version does not match configuration.')
    availability = batch.availability(day)
    rows = days.loc[days.date.eq(day)].sort_values('merchant_id')
    if rows.merchant_id.duplicated().any():
        raise ValueError('Expected one roster row per merchant-day.')
    positive = {}
    if availability == 'complete':
        current = events.loc[events.date.eq(day) & events.amount.gt(0)].sort_values('amount')
        positive = dict(tuple(current.groupby('merchant_id').amount))
    results = []
    for row in rows.itertuples(index=False):
        support = reference.support(row.merchant_id)
        limits = []
        channels, ticket_detail = {}, None
        coverage = config['interval_coverage']
        if availability == 'complete':
            detectors = {'transaction_count': count_evidence(row, reference, config)}
            detectors.update({metric: outcome_evidence(row, reference, metric, coverage) for metric in OUTCOMES})
            detectors.update({metric: amount_evidence(row, reference, metric, config) for metric in AMOUNTS})
            channels = channel_evidence(row, reference)
            tickets = positive_ticket_evidence(positive.get(row.merchant_id, []), row.merchant_id,
                                               reference, coverage)
            ticket_detail = max(tickets, key=lambda x: x['score'], default=None)
            if support['eligible_days'] < config['established_days']:
                limits.append('Sparse merchant history. The count forecast uses global prior pooling.')
            if not support['positive_tickets']:
                limits.append('No merchant positive-ticket history. Ticket forecasts fall back to peer data when available.')
            if 0 < row.transaction_count <= config['low_exposure']:
                limits.append('Low transaction exposure limits the resolution of failure-count tails.')
            if row.valid_amount_count < row.transaction_count:
                limits.append('Some amounts are missing or invalid. Amount evidence conditions on valid exposure.')
            if row.unknown_status_count:
                limits.append('Unknown statuses remain in the retained-event denominator.')
            if row.transaction_count == 0:
                limits.append('Zero retained activity on a closed roster day. Feed health is unverified.')
        else:
            detectors = {metric: _record(reason=availability + ' batch') for metric in ALL_METRICS}
            limits.append('Availability prevents scoring and reference admission.')
        raw, dominant = fuse(detectors)
        rank = calibration.rank(raw) if calibration is not None else None
        symptom, explanation = explain(dominant, detectors.get(dominant), availability)
        descriptive = None
        if availability == 'complete' and not support['positive_tickets'] and pd.notna(row.merchant_category):
            descriptive = reference.category_medians.get(row.merchant_category)
        results.append({
            'merchant_id': row.merchant_id, 'date': day.date().isoformat(),
            'is_anomaly': int(rank is not None and alpha is not None and rank <= alpha),
            'anomaly_score': raw, 'calibrated_tail_rank': rank,
            'calibrated_unusualness': None if rank is None else 1 - rank,
            'dominant_symptom': symptom, 'dominant_detector': dominant, 'detectors': detectors,
            'positive_ticket_example': ticket_detail, 'channel_evidence': channels,
            'descriptive_category_ticket_median': descriptive, 'support': support,
            'reference_version': reference.version, 'reference_last_date': reference.last_date.date().isoformat(),
            'reference_history_merchant_days': reference.history_rows, 'data_availability': availability,
            'confidence_limitations': limits, 'explanation': explanation,
        })
    return results

