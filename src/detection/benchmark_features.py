"""Prior-only benchmark features, with statistical evidence isolated in C."""

from dataclasses import dataclass
from types import SimpleNamespace

import numpy as np
import pandas as pd

from src.data.preprocessing import KEYS
from .baselines import residual_features
from .channel import ChannelReference, merchant_channel_max, score_channels
from .detectors import ALL_METRICS, score_day
from .references import Batch, CHANNEL_NAMES, fit_reference
from .sequential import CountTrack, RateBank

LEVELS = ('transaction_count', 'accepted_amount', 'attempted_amount', 'amount_median', 'amount_mean')
RATES = ('decline_rate', 'cancellation_rate')
KEY_INDEX = ['date', 'merchant_id']


def keyed(days):
    return (days.assign(merchant_id=days.merchant_id.astype('string'))
            .set_index(KEY_INDEX, verify_integrity=True).sort_index())


def basic(days):
    rows = keyed(days)
    levels = np.log1p(rows[list(LEVELS) + ['declined_count', 'cancelled_count']])
    # Drop one channel-share column, which is determined by the others at nonzero exposure.
    shares = [f'{name}_share' for name in CHANNEL_NAMES if name != 'pos']
    angle = 2 * np.pi * rows.index.get_level_values('date').weekday / 7
    return levels.join(rows[[*RATES, *shares]]).assign(weekday_sin=np.sin(angle), weekday_cos=np.cos(angle))


def recent_local(prior, origin, current, days):
    recent = prior.loc[prior.date.ge(origin - pd.Timedelta(days=days))]
    logged = np.log1p(recent[list(LEVELS + RATES)]).assign(merchant_id=recent.merchant_id)
    return logged, logged.groupby('merchant_id').median().reindex(current.merchant_id).set_axis(current.index)


def context(history, current, cutoff, config):
    """Conventional descriptive references. History is admitted only before cutoff."""
    if current.date.min() < cutoff:
        raise ValueError('Context cutoff is after a score date.')
    prior = history.loc[history.date.lt(cutoff)].sort_values(KEY_INDEX)
    mean_count = prior.transaction_count.mean()
    weekdays = ((prior.groupby(prior.date.dt.weekday).transaction_count.mean() / mean_count).to_dict()
                if mean_count > 0 else {})
    residual = residual_features(prior, current, SimpleNamespace(weekday=weekdays), config)
    result = residual.add_prefix('robust_')
    logged, local = recent_local(prior, cutoff, current, 28)
    expected = local.fillna(logged.drop(columns='merchant_id').median())
    logged_now = np.log1p(current[list(LEVELS + RATES)])
    for name in LEVELS:
        result[f'expected_{name}'] = expected[name]
        result[f'delta_{name}'] = logged_now[name] - expected[name]
    for name in RATES:
        result[f'delta_{name}'] = current[name] - np.expm1(expected[name])
    last = logged.groupby('merchant_id').tail(1).set_index('merchant_id')
    _, short = recent_local(prior, cutoff, current, 7)
    for name in ('transaction_count', 'amount_median'):
        result[f'last_{name}'] = current.merchant_id.map(last[name])
        result[f'rolling_7d_{name}'] = short[name]
    days_seen = current.merchant_id.map(prior.groupby('merchant_id').size()).fillna(0)
    result['sparse_history'] = days_seen.lt(config['established_days']).astype(float)
    result['no_history'] = days_seen.eq(0).astype(float)
    result['no_valid_amount'] = current.valid_amount_count.eq(0).astype(float)
    result['missing_amount_fraction'] = (1 - current.valid_amount_count / current.transaction_count.where(
        current.transaction_count.gt(0)))
    return keyed(result.join(current[KEYS]))


@dataclass
class Intelligence:
    rows: pd.DataFrame
    daily: dict
    reference: object


def intelligence(history, events, current, cutoff, config, *, channel_minimum):
    """Cache label-free instantaneous and channel evidence for different replay paths."""
    reference = fit_reference(history, events, cutoff, config['version'])
    prior = history.loc[history.date.lt(cutoff)]
    exposure = prior.groupby('merchant_id')[[f'{name}_count' for name in CHANNEL_NAMES]].sum()
    # The merchant-channel maximum does not use category strata.
    channels = ChannelReference(reference, exposure, pd.Series(dtype=object))
    rows, daily = [], {}
    for day, group in current.groupby('date', sort=True):
        batch = Batch('complete', day)
        details = score_day(group, events, day, batch, reference, config)
        maximum = merchant_channel_max(score_channels(group, day, batch, channels,
                                                      roster=group.merchant_id), channel_minimum)
        for item in details:
            merchant = item['merchant_id']
            daily[day, merchant] = item
            components = {f'v1_{name}': item['detectors'][name]['score'] for name in ALL_METRICS}
            rows.append({'date': day, 'merchant_id': merchant, **components,
                         'v1_interruption': item['detectors']['transaction_count']['interruption_score'],
                         'channel_evidence': maximum.loc[merchant]})
    return Intelligence(keyed(pd.DataFrame(rows)).astype(float), daily, reference)


def sequential(cache, index, bank: RateBank, persistence):
    """Replay only selected keys. Reset each merchant's state at a withheld date."""
    tracks = {}
    values = []
    for day, merchant in index.sort_values():
        track = tracks.get(merchant, CountTrack())
        if track.last_day is not None and (day - track.last_day).days != 1:
            track = CountTrack()
        reference = cache[day].reference
        tracks[merchant], evidence = track.step(day, Batch('complete', day),
                                                cache[day].daily[day, merchant], reference, bank)
        row = {'date': day, 'merchant_id': merchant}
        for name, downward in (('drop', True), ('surge', False)):
            arms = [(value, streak) for ratio, value, streak in
                    zip(evidence.ratios, evidence.values, evidence.streaks) if (ratio < 1) == downward] \
                   if evidence else []
            row[f'cusum_{name}'] = max((value for value, _ in arms), default=0.)
            row[f'cusum_{name}_persistent'] = max((value for value, streak in arms if streak >= persistence),
                                                  default=0.)
        values.append(row)
    return keyed(pd.DataFrame(values)).reindex(index)
