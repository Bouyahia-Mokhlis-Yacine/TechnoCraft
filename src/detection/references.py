"""As-of reference fitting and explicit admission of reviewed merchant-days."""

from dataclasses import dataclass
from hashlib import blake2b

import numpy as np
import pandas as pd

from src.data.aggregation import merchant_days
from src.data.preprocessing import CHANNELS, KEYS, category_map, clean_transactions
from .distributions import binomial_prior, fit_amount_pool, fit_log_student_t, gamma_prior

CHANNEL_NAMES = (*CHANNELS.values(), 'unknown')
OUTCOMES = {'declines': 'declined_count', 'cancellations': 'cancelled_count'}
AMOUNTS = ('median_ticket', 'attempted_value', 'accepted_value')


def prepare_observations(raw, roster):
    """Reuse the shared cleaning and calendar aggregation without future category imputation."""
    no_categories = pd.Series(dtype='string')
    events, _ = clean_transactions(raw, no_categories)
    return merchant_days(events, roster[KEYS], no_categories), events


@dataclass(frozen=True)
class Batch:
    status: str
    closed_through: pd.Timestamp | None = None

    def availability(self, day):
        if self.status not in {'complete', 'incomplete', 'unavailable'}:
            raise ValueError('Unknown batch status.')
        if self.status == 'complete':
            if pd.isna(self.closed_through) or pd.Timestamp(self.closed_through) < day:
                return 'incomplete'
        return self.status


@dataclass(frozen=True)
class Reference:
    version: str
    model_version: str
    as_of: pd.Timestamp
    last_date: pd.Timestamp
    history_rows: int
    weekday: dict
    totals: dict
    gamma: tuple
    outcomes: dict
    channels: dict
    pools: dict
    log_t: object
    category_medians: dict

    def support(self, merchant):
        days, transactions, exposure, _, _ = self.totals.get(merchant, (0, 0, 0., 0, 0))
        return {'eligible_days': int(days), 'count_exposure': float(exposure),
                'outcome_opportunities': int(transactions),
                'positive_tickets': len(self.pools['median_ticket'].local_positive.get(merchant, ())),
                'valid_tickets': {metric: int(pool.counts.get(merchant, 0))
                                  for metric, pool in self.pools.items()}}


def _channel_rates(history, totals, center, strength, status):
    forecasts = {}
    for channel in CHANNEL_NAMES:
        n, y = f'{channel}_count', f'{channel}_{status}'
        channel_rate = (history[y].sum() + strength * center) / (history[n].sum() + strength)
        local = ((totals[y] + strength * channel_rate) / (totals[n] + strength)).to_dict()
        forecasts[channel] = (float(channel_rate), local)
    return forecasts


def fit_reference(days, events, as_of, model_version):
    """Fit only supplied eligible keys strictly before the forecast date."""
    as_of = pd.Timestamp(as_of).normalize()
    prior = days.loc[days.date.lt(as_of)].sort_values(['date', 'merchant_id'])
    if prior.empty:
        raise ValueError('A reference requires at least one complete, eligible prior merchant-day.')
    if prior.duplicated(KEYS).any():
        raise ValueError('Reference contains duplicate merchant-days.')
    event_columns = KEYS + ['amount', 'transaction_status', 'channel', 'merchant_category']
    past = (events.loc[events.date.lt(as_of), event_columns].merge(prior[KEYS], on=KEYS, validate='many_to_one')
            .sort_values(event_columns, ignore_index=True))
    channels = [f'{c}_{s}' for c in CHANNEL_NAMES for s in ('count', 'declined', 'cancelled')]
    fields = ['transaction_count', *OUTCOMES.values(), *channels]
    fingerprint = blake2b(digest_size=12)
    fingerprint.update(pd.util.hash_pandas_object(prior[KEYS + fields], index=False).values.tobytes())
    fingerprint.update(pd.util.hash_pandas_object(past, index=False).values.tobytes())
    if prior.transaction_count.mean() > 0:
        observed_weekday = prior.groupby(prior.date.dt.weekday).transaction_count.mean()
        weekday = (observed_weekday / prior.transaction_count.mean()).clip(lower=1e-6).to_dict()
    else:
        weekday = {}
    expose = prior.date.dt.weekday.map(weekday).fillna(1.)
    totals = prior.assign(exposure=expose).groupby('merchant_id')[fields + ['exposure']].sum()
    totals['days'] = prior.groupby('merchant_id').size()
    priors = {label: binomial_prior(totals, column) for label, column in OUTCOMES.items()}
    attribution = {label: _channel_rates(prior, totals, *priors[label], status)
                   for label, status in zip(OUTCOMES, ('declined', 'cancelled'))}

    pools = {
        'median_ticket': fit_amount_pool(past),
        'attempted_value': fit_amount_pool(past.loc[past.transaction_status.ne('Refunded')]),
        'accepted_value': fit_amount_pool(past.loc[past.transaction_status.eq('Accepted')]),
    }
    stable_category = past.merchant_id.map(category_map(past))
    category_medians = past.loc[past.amount.gt(0), 'amount'].groupby(stable_category).median().to_dict()
    merchant_columns = ['days', 'transaction_count', 'exposure', *OUTCOMES.values()]
    return Reference(
        f'{model_version}-{fingerprint.hexdigest()}', model_version, as_of, prior.date.max(), len(prior), weekday,
        dict(zip(totals.index, totals[merchant_columns].itertuples(index=False, name=None))),
        gamma_prior(totals), priors, attribution, pools, fit_log_student_t(pools['median_ticket']),
        category_medians,
    )


@dataclass(frozen=True)
class Review:
    merchant_id: str
    day: pd.Timestamp
    reviewed_on: pd.Timestamp
    decision: str
    reason: str


@dataclass(frozen=True)
class ReferencePolicy:
    mode: str
    freeze_on: pd.Timestamp | None = None

    def __post_init__(self):
        if self.mode not in {'frozen', 'reviewed'}:
            raise ValueError('Reference policy must be frozen or reviewed.')
        if self.mode == 'frozen' and self.freeze_on is None:
            raise ValueError('Frozen policy requires a freeze date.')

    def snapshot(self, days, events, forecast_day, model_version, *, reviewed=()):
        """Select the latest dated decision known before each origin.

        Training seed admissions and explicit operational clearances use the same
        ledger. Pending/quarantined dates and feed gaps remain outside the peer
        and merchant references. Rebuild from the stored ledger and batch states.
        """
        origin = pd.Timestamp(forecast_day).normalize()
        if self.mode == 'frozen':
            origin = min(origin, pd.Timestamp(self.freeze_on).normalize())
        decisions = {}
        for review in sorted(reviewed, key=lambda item: item.reviewed_on):
            if not review.reason.strip() or review.decision not in {'clear', 'quarantine'}:
                raise ValueError('A review requires an explicit decision and reason.')
            if review.reviewed_on.normalize() < review.day.normalize():
                raise ValueError('A review cannot precede its merchant-day.')
            if review.reviewed_on.normalize() >= origin:
                continue
            key = (review.merchant_id, review.day.normalize())
            if key in decisions and decisions[key].reviewed_on == review.reviewed_on:
                raise ValueError('Conflicting reviews share a timestamp and merchant-day.')
            decisions[key] = review
        keys = [key for key, item in decisions.items() if item.decision == 'clear']
        admitted = days.loc[pd.MultiIndex.from_frame(days[KEYS]).isin(keys)]
        return fit_reference(admitted, events, origin, model_version)


def closed_day_reviews(days, batch, decision, reason, *, reviewed_on):
    """Create auditable admission decisions from a closed batch and operational review.

    To quarantine an incident spanning multiple dates, leave those dates pending or
    record quarantine decisions for all affected keys until review clears them.
    """
    if not all(batch.availability(day) == 'complete' for day in days.date.unique()):
        raise ValueError('Reviews require complete merchant-day batches.')
    return [Review(merchant, date, pd.Timestamp(reviewed_on), decision, reason)
            for merchant, date in days[KEYS].itertuples(index=False, name=None)]

