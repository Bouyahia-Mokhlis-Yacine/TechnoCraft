"""Prior-only count forecasts with empirical accepted-payment severity."""

from dataclasses import dataclass
from hashlib import blake2b

import numpy as np
import pandas as pd
from scipy import stats

from src.data.preprocessing import KEYS
from src.detection.distributions import binomial_prior, gamma_prior
from src.external_validation.forecast import nb_law


COUNT_MODELS = ('historical_mean', 'seasonal_naive', 'weekday_poisson',
                'negative_binomial', 'gamma_poisson', 'weekday_ewma')
LEVELS = (.8, .9, .95)
METRICS = ('transactions', 'accepted_value', 'rejections')


def generator(seed, *parts):
    key = repr((seed, *(str(part) for part in parts))).encode()
    return np.random.default_rng(int.from_bytes(blake2b(key, digest_size=16).digest(), 'little'))


def summarize(draws, mean=None, levels=LEVELS):
    if draws is None:
        return None
    return {'mean': float(np.mean(draws) if mean is None else mean),
            'intervals': {str(int(round(level * 100))): np.quantile(
                draws, [(1 - level) / 2, (1 + level) / 2]).tolist() for level in levels}}


def crps(draws, actual):
    ordered = np.sort(draws)
    n = len(ordered)
    return float(np.abs(ordered - actual).mean() - np.dot(2 * np.arange(n) + 1 - n, ordered) / n**2)


@dataclass(frozen=True)
class ForecastReference:
    origin: pd.Timestamp
    last_date: pd.Timestamp
    weekday: dict
    totals: pd.DataFrame
    gamma: tuple
    nb_alpha: float
    recent_rates: dict
    latest_weekday: dict
    outcome_prior: np.ndarray
    severity: dict
    fleet_severity: np.ndarray
    value_days: dict
    weekday_values: dict
    fleet_values: np.ndarray

    def count_law(self, merchant, day, model):
        day = pd.Timestamp(day)
        if day < self.origin or model not in COUNT_MODELS:
            raise ValueError('Count forecasts require a known model and a date on or after the origin.')
        row = self.totals.loc[merchant] if merchant in self.totals.index else None
        shape, rate = self.gamma
        local_n = row.transaction_count if row is not None else 0.
        local_e = row.exposure if row is not None else 0.
        week = self.weekday.get(day.weekday(), 1.)
        if row is None or model == 'gamma_poisson':
            return stats.nbinom(shape + local_n, (rate + local_e) / (rate + local_e + week))
        daily_rate = local_n / local_e
        weekday_mean = daily_rate * week
        if model == 'negative_binomial':
            return nb_law(max(1e-9, weekday_mean), self.nb_alpha)
        means = {'historical_mean': local_n / row.days,
                 'seasonal_naive': self.latest_weekday.get((merchant, day.weekday()), weekday_mean),
                 'weekday_poisson': weekday_mean, 'weekday_ewma': self.recent_rates[merchant] * week}
        return stats.poisson(means[model])

    def support(self, merchant):
        return {'history_days': int(self.totals.at[merchant, 'days']) if merchant in self.totals.index else 0,
                'accepted_severity_tickets': len(self.severity.get(merchant, ())),
                'forecast_origin': self.origin.date().isoformat(), 'last_reference_date': self.last_date.date().isoformat()}


def fit_forecast(days, events, origin):
    """Fit to explicitly eligible prior merchant-days and their retained transactions."""
    origin = pd.Timestamp(origin).normalize()
    prior = days.loc[days.date.lt(origin)].sort_values(['date', 'merchant_id'])
    if prior.empty or prior.duplicated(KEYS).any() or prior.transaction_count.isna().any():
        raise ValueError('Forecasts require unique, closed, eligible prior days.')
    fields = ['transaction_count', 'accepted_count', 'declined_count']
    center = prior.transaction_count.mean()
    weekday = ((prior.groupby(prior.date.dt.weekday).transaction_count.mean() / center)
               .clip(lower=1e-6).to_dict()) if center else {}
    exposure = prior.date.dt.weekday.map(weekday).fillna(1.)
    covered = prior.assign(exposure=exposure)
    totals = covered.groupby('merchant_id')[fields + ['exposure']].sum()
    totals['days'] = covered.groupby('merchant_id').size()
    fitted = covered.merchant_id.map(totals.transaction_count / totals.exposure) * exposure
    overdispersion = ((covered.transaction_count - fitted)**2 - covered.transaction_count).sum()
    alpha = max(1e-8, overdispersion / max(1., float((fitted**2).sum())))
    decay = np.exp2(-(origin - covered.date).dt.days / 7.)
    recent = covered.assign(y=covered.transaction_count * decay, e=exposure * decay)
    weighted = recent.groupby('merchant_id')[['y', 'e']].sum()
    latest = covered.assign(weekday=covered.date.dt.weekday).drop_duplicates(['merchant_id', 'weekday'], keep='last')

    acceptance, strength = binomial_prior(totals, 'accepted_count')
    opportunities = float(totals.transaction_count.sum())
    declined = float(totals.declined_count.sum())
    remaining = opportunities - float(totals.accepted_count.sum())
    decline_share = (declined + .5) / (remaining + 1.)
    outcome_prior = strength * np.array([acceptance, (1 - acceptance) * decline_share,
                                        (1 - acceptance) * (1 - decline_share)])
    tickets = (events.loc[events.date.lt(origin) & events.transaction_status.eq('Accepted') & events.amount.notna(),
                          KEYS + ['amount']].merge(prior[KEYS], on=KEYS, validate='many_to_one'))
    raw_values = prior.loc[prior.valid_accepted_amount_count.eq(prior.accepted_count)].copy()
    raw_values = raw_values.assign(weekday=raw_values.date.dt.weekday)
    return ForecastReference(
        origin, prior.date.max(), weekday, totals, gamma_prior(totals), alpha, (weighted.y / weighted.e).to_dict(),
        latest.set_index(['merchant_id', 'weekday']).transaction_count.to_dict(), outcome_prior,
        {key: np.sort(rows.amount.to_numpy()) for key, rows in tickets.groupby('merchant_id')},
        np.sort(tickets.amount.to_numpy()),
        {key: rows.accepted_amount.to_numpy() for key, rows in raw_values.groupby('merchant_id')},
        {key: rows.accepted_amount.to_numpy() for key, rows in raw_values.groupby(['merchant_id', 'weekday'])},
        raw_values.accepted_amount.to_numpy(),
    )


def severity_pool(reference, merchant, support=20):
    local = reference.severity.get(merchant, np.array([]))
    fleet = reference.fleet_severity
    if not len(fleet):
        return None
    weight = len(local) / (len(local) + support)
    mean = weight * float(local.mean()) + (1 - weight) * float(fleet.mean()) if len(local) else float(fleet.mean())
    return local, fleet, weight, mean


def severity_sums(pool, accepted, rng):
    if pool is None:
        return None
    local, fleet, weight, _ = pool
    result = np.zeros(len(accepted))
    # Keep temporary allocations bounded across draws. Samples are on the payment scale.
    for start in range(0, len(accepted), 64):
        counts = accepted[start:start + 64]
        positions = np.repeat(np.arange(len(counts)), counts)
        values = rng.choice(fleet, len(positions))
        if len(local):
            use_local = rng.random(len(positions)) < weight
            values[use_local] = rng.choice(local, int(use_local.sum()))
        result[start:start + len(counts)] = np.bincount(positions, weights=values, minlength=len(counts))
    return result


def predictive_draws(reference, merchant, dates, *, model='gamma_poisson', draws=512, seed=20261127,
                     activity_multiplier=1.):
    """Simulate one merchant's joint trajectory. Gamma and outcome draws persist across days."""
    dates = tuple(pd.Timestamp(date).normalize() for date in dates)
    if not dates or dates != tuple(sorted(set(dates))) or dates[0] < reference.origin:
        raise ValueError('Prediction dates must be unique, increasing and on or after the origin.')
    if draws < 64 or not np.isfinite(activity_multiplier) or not 0 <= activity_multiplier <= 1:
        raise ValueError('Use at least 64 draws and an activity multiplier in [0, 1].')
    latent_rng = generator(seed, reference.origin, merchant, model, 'latent')
    known = merchant in reference.totals.index
    row = reference.totals.loc[merchant] if known else None
    outcomes = reference.outcome_prior.copy()
    if known:
        outcomes += [row.accepted_count, row.declined_count, row.transaction_count - row.accepted_count - row.declined_count]
    outcome_rates = latent_rng.dirichlet(outcomes, size=draws)
    acceptance, rejection = (outcomes / outcomes.sum())[:2]
    shape, rate = reference.gamma
    if known:
        shape, rate = shape + row.transaction_count, rate + row.exposure
    rate_samples = latent_rng.gamma(shape, 1 / rate, size=draws) if model == 'gamma_poisson' or not known else None
    pool = severity_pool(reference, merchant)
    output = []
    for date in dates:
        rng = generator(seed, reference.origin, merchant, model, date)
        law = reference.count_law(merchant, date, model)
        if rate_samples is not None:
            weekly = reference.weekday.get(date.weekday(), 1.)
            n = rng.poisson(rate_samples * weekly * activity_multiplier)
        else:
            raw = law.rvs(size=draws, random_state=rng)
            n = rng.binomial(raw, activity_multiplier) if activity_multiplier < 1 else raw
        accepted = rng.binomial(n, outcome_rates[:, 0])
        rejected = rng.binomial(n - accepted, outcome_rates[:, 1] / (1 - outcome_rates[:, 0]))
        value = severity_sums(pool, accepted, rng)
        count_mean = float(law.mean()) * activity_multiplier
        output.append(({'transactions': n, 'accepted_value': value, 'rejections': rejected},
                       {'transactions': count_mean, 'accepted_value': count_mean * acceptance * pool[-1] if pool else None,
                        'rejections': count_mean * rejection}))
    return output


def seven_day_forecast(reference, origin, merchants, *, model='gamma_poisson', draws=512, seed=20261127,
                       incident_activity_multiplier=None):
    """Network totals sum aligned simulations conditional on fitted common parameters."""
    origin = pd.Timestamp(origin).normalize()
    roster = sorted(set(merchants))
    if origin < reference.origin or not roster:
        raise ValueError('A valid origin and nonempty authorized forecast roster are required.')
    dates = pd.date_range(origin, periods=7)
    multiplier = 1. if incident_activity_multiplier is None else incident_activity_multiplier
    simulations = {m: predictive_draws(reference, m, dates, model=model, draws=draws, seed=seed,
                                        activity_multiplier=multiplier) for m in roster}
    daily = []
    for i, date in enumerate(dates):
        series = {m: {metric: summarize(samples[metric], means[metric]) for metric in METRICS}
                  for m, trajectory in simulations.items() for samples, means in [trajectory[i]]}
        network = {}
        for metric in METRICS:
            arrays = [trajectory[i][0][metric] for trajectory in simulations.values()]
            means = [trajectory[i][1][metric] for trajectory in simulations.values()]
            network[metric] = summarize(np.sum(arrays, axis=0), sum(means)) if all(
                array is not None for array in arrays) else None
        daily.append({'date': date.date().isoformat(), 'horizon': i + 1, 'network': network, 'merchants': series})
    return {'origin': origin.date().isoformat(), 'reference_origin': reference.origin.date().isoformat(),
            'last_reference_date': reference.last_date.date().isoformat(), 'model': model, 'days': daily,
            'scenario': 'ordinary activity' if incident_activity_multiplier is None else 'conditional activity scenario',
            'assumed_activity_multiplier': incident_activity_multiplier, 'scope_merchant_count': len(roster),
            'support': {m: reference.support(m) for m in roster},
            'limitations': ['Network intervals assume conditional independence across merchants.',
                            'Shared service shocks and holiday effects are outside the fitted reference.']}
