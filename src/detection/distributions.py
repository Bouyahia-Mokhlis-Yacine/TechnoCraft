"""Predictive tails and fitted laws for SATIM merchant-day evidence."""

from dataclasses import dataclass
from hashlib import blake2b
from itertools import count
import json
import math

import numpy as np
from scipy import stats

LOG_TWO = math.log(2)
LOG_TEN = math.log(10)
LOG_ZERO = math.log(np.nextafter(0., 1.))


def evidence_score(log_p):
    """Keep impossible events finite while retaining subnormal finite log tails."""
    return -float(LOG_ZERO if log_p == -np.inf else log_p) / LOG_TEN


def two_sided(log_lower, log_upper):
    return min(0., LOG_TWO + min(log_lower, log_upper))


def discrete_log_tail(law, observed, *, upper):
    """Use SciPy's inclusive tail, recovering log mass if its CDF underflows."""
    value = law.logsf(observed - 1) if upper else law.logcdf(observed)
    if np.isfinite(value):
        return float(value)
    boundary = float(law.logpmf(observed))
    if not np.isfinite(boundary):
        return boundary
    total = boundary
    step = 1 if upper else -1
    for point in count(observed + step, step):
        term = float(law.logpmf(point))
        if term < total - 40:
            return total
        total = float(np.logaddexp(total, term))


def corrected_variance(values, sampling_error, floor):
    variance = values.var(ddof=1) if len(values) > 1 else 0.
    return max(floor, variance - sampling_error)


def gamma_prior(totals):
    """Totals contain one transaction count and adjusted exposure per merchant."""
    center = max(1e-6, totals.transaction_count.sum() / totals.exposure.sum())
    rate = totals.transaction_count / totals.exposure
    between = corrected_variance(rate, (rate / totals.exposure).mean(), 1e-6 * center**2)
    shape = min(1e6, center**2 / between)
    return shape, shape / center


def binomial_prior(totals, column):
    active = totals.loc[totals.transaction_count.gt(0)]
    n = active.transaction_count
    # A Jeffreys interior estimate keeps the predictive law usable for all-zero/all-one history.
    center = active[column].sum() / n.sum() if len(n) else .5
    if len(n) and center in (0., 1.):
        center = (active[column].sum() + .5) / (n.sum() + 1.)
    sampling = (center * (1 - center) / n).mean() if len(n) else 0.
    between = corrected_variance(active[column] / n, sampling, 1e-9)
    return float(center), float(np.clip(center * (1 - center) / between - 1, 2, 1e6))


@dataclass(frozen=True)
class AmountPool:
    center: float | None
    anchors: dict
    strength: float
    positive_residuals: np.ndarray
    local_positive: dict
    counts: dict
    zero_rate: float
    local_zero_rates: dict

    def anchor(self, merchant):
        return self.anchors.get(merchant, self.center)


def fit_amount_pool(events):
    values = events.loc[events.amount.notna(), ['merchant_id', 'amount']]
    positive = values.loc[values.amount.gt(0)].assign(log_amount=lambda x: np.log(x.amount))
    counts = values.groupby('merchant_id').size().to_dict()
    zeros = values.amount.eq(0)
    local_zeros = zeros.groupby(values.merchant_id).mean().to_dict()
    zero_rate = float(zeros.mean()) if len(values) else 0.
    if positive.empty:
        return AmountPool(None, {}, 1., np.array([]), {}, counts, zero_rate, local_zeros)
    summary = positive.groupby('merchant_id').log_amount.agg(['median', 'size'])
    center = float(positive.log_amount.median())
    scale = max(.01, 1.4826 * float(stats.median_abs_deviation(positive.log_amount)))
    sampling = np.pi / 2 * scale**2
    strength = sampling / corrected_variance(summary['median'], (sampling / summary['size']).mean(), 1e-6)
    anchor = (summary['size'] * summary['median'] + strength * center) / (summary['size'] + strength)
    residual = positive.log_amount - positive.merchant_id.map(anchor)
    by_merchant = residual.groupby(positive.merchant_id).agg(list)
    return AmountPool(center, anchor.to_dict(), strength, np.sort(residual.to_numpy()),
                      {key: np.sort(values) for key, values in by_merchant.items()},
                      counts, zero_rate, local_zeros)


def fit_log_student_t(pool):
    residuals = pool.positive_residuals
    if len(residuals) < 3 or np.ptp(residuals) < 1e-10:
        return None
    degrees, location, scale = stats.t.fit(residuals)
    return stats.t(degrees, loc=location, scale=max(1e-8, scale))


def conditional_draws(pool, merchant, date, metric, exposure, draws, seed):
    """Preserve eligible reference zeros and mix local and global residual distributions."""
    if not exposure or not pool.counts:
        raise ValueError('Simulation requires positive exposure and a nonempty pool.')
    if pool.center is None:
        return np.zeros(draws)

    key = json.dumps([seed, str(merchant), str(date.date()), metric]).encode()
    rng = np.random.default_rng(int.from_bytes(blake2b(key, digest_size=16).digest(), 'little'))
    local = pool.local_positive.get(merchant)
    support = pool.counts.get(merchant, 0)
    weight = support / (support + pool.strength)
    anchor = pool.anchor(merchant)
    local_zero = pool.local_zero_rates.get(merchant, 0.)
    results = np.empty(draws)
    chunk_size = max(1, min(draws, 262144 // exposure))
    reduce = np.median if metric == 'median_ticket' else np.sum
    for start in range(0, draws, chunk_size):
        stop = min(draws, start + chunk_size)
        size = (stop - start, exposure)
        use_local = rng.random(size) < weight
        zero = rng.random(size) < np.where(use_local, local_zero, pool.zero_rate)
        residual = rng.choice(pool.positive_residuals, size)
        if local is not None:
            residual = np.where(use_local, rng.choice(local, size), residual)
        results[start:stop] = reduce(np.where(zero, 0., np.exp(anchor + residual)), axis=1)
    return results

