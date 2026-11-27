"""Exposure-conditioned merchant-channel evidence from a frozen eligible history."""

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import binom

from src.data.preprocessing import KEYS, category_map
from .references import CHANNEL_NAMES, Reference, fit_reference


OUTCOMES = ('declines', 'cancellations')
COUNT_FIELDS = ('count', 'declined', 'cancelled')


@dataclass(frozen=True)
class ChannelReference:
    base: Reference
    support: pd.DataFrame
    categories: pd.Series


def fit_channel_reference(eligible_days, events, as_of, version):
    """Fit only explicitly admitted complete keys. Scoring never refreshes this snapshot."""
    base = fit_reference(eligible_days, events, as_of, version)
    history = eligible_days.loc[eligible_days.date.lt(base.as_of)].sort_values(KEYS)
    support = history.groupby('merchant_id')[[f'{c}_count' for c in CHANNEL_NAMES]].sum()
    past = events[['merchant_id', 'date', 'merchant_category']].merge(history[KEYS], on=KEYS)
    return ChannelReference(base, support, category_map(past))


@dataclass(frozen=True)
class ChannelDay:
    date: pd.Timestamp
    reference_version: str
    evidence: pd.DataFrame


def score_channels(days, day, batch, reference, *, roster):
    """Use the declared roster to distinguish a closed zero from a missing observation."""
    day = pd.Timestamp(day).normalize()
    base = reference.base
    if base.as_of > day or base.last_date >= day:
        raise ValueError('Channel scoring requires a strictly prior reference.')
    if batch.availability(day) != 'complete':
        return None
    current = days.loc[days.date.eq(day)].set_index('merchant_id').sort_index()
    if not current.index.is_unique:
        raise ValueError('Channel scoring requires unique merchant-day observations.')
    if current.empty or set(current.index) != set(roster):
        return None
    fields = [f'{channel}_{field}' for channel in CHANNEL_NAMES for field in COUNT_FIELDS]
    values = current[fields].to_numpy(dtype=float, na_value=np.nan)
    if not np.isfinite(values).all():
        return None
    if (values < 0).any() or (values != np.floor(values)).any() or (values[:, 1::3] + values[:, 2::3]
                                                                  > values[:, ::3]).any():
        raise ValueError('Invalid merchant-channel count or exposure.')

    weekday = base.weekday.get(day.weekday(), 1.)
    historical_days = current.index.to_series().map({m: t[0] for m, t in base.totals.items()}).fillna(0)
    historical_exposure = current.index.to_series().map({m: t[2] for m, t in base.totals.items()})
    category = reference.categories.reindex(current.index)
    frames = []
    for channel in CHANNEL_NAMES:
        count, declined, cancelled = (f'{channel}_{field}' for field in COUNT_FIELDS)
        prior_count = reference.support[count].reindex(current.index, fill_value=0)
        frame = pd.DataFrame({'channel': channel, 'category': category, 'exposure': current[count],
                              'history_days': historical_days, 'history_exposure': prior_count,
                              'expected_activity': weekday * prior_count / historical_exposure})
        source = 'channel' if reference.support[count].sum() > 0 else 'global'
        frame['rate_reference'] = np.where(prior_count.gt(0), 'merchant_channel', source)
        for outcome, column in zip(OUTCOMES, (declined, cancelled)):
            channel_rate, local = base.channels[outcome][channel]
            probability = current.index.to_series().map(local).where(prior_count.gt(0)).fillna(channel_rate)
            frame[outcome] = current[column]
            frame[f'{outcome}_probability'] = probability
            frame[f'{outcome}_expected'] = frame.exposure * probability
            tail = binom.logsf(frame[outcome] - 1, frame.exposure, probability)
            # Cap underflow at the smallest positive normal probability for portable scores.
            frame[f'{outcome}_score'] = np.where(
                frame.exposure.gt(0), -np.maximum(tail, np.log(np.finfo(float).tiny)) / np.log(10), np.nan)
        frames.append(frame.reset_index())
    return ChannelDay(day, base.version, pd.concat(frames, ignore_index=True))


def merchant_channel_max(scored, minimum_exposure):
    """Joint score across known channels and both outcomes for each merchant-day."""
    if scored is None:
        return None
    evidence = scored.evidence
    eligible = evidence.exposure.ge(minimum_exposure) & evidence.channel.ne('unknown')
    peak = evidence.loc[eligible, [f'{name}_score' for name in OUTCOMES]].max(axis=1)
    return peak.groupby(evidence.merchant_id).max().reindex(evidence.merchant_id.unique())
