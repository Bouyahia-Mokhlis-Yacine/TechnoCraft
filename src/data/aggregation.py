"""Calendar-first merchant-day indicators shared by analysis and later services."""

import numpy as np
import pandas as pd

from .preprocessing import CHANNELS, KEYS, STATUSES, calendar_keys


def ratio(numerator, denominator):
    return numerator.div(denominator.where(denominator.gt(0)))


def merchant_days(events, raw_calendar, reference_categories):
    calendar = calendar_keys(raw_calendar)
    if not events[KEYS].drop_duplicates().merge(calendar, how='left', on=KEYS,
                                                  indicator=True)['_merge'].eq('both').all():
        raise ValueError('Some usable transactions fall outside the supplied calendar.')
    work = events.assign(accepted_amount=events['amount'].where(events['transaction_status'].eq('Accepted')))
    # A recorded refund is a separate event without linkage to the original payment.
    work['attempted_amount'] = work['amount'].where(work['transaction_status'].ne('Refunded'))
    status_columns = dict(zip((*STATUSES, 'Unknown'),
                              ('accepted_count', 'declined_count', 'cancelled_count',
                               'refunded_count', 'unknown_status_count')))
    for status, column in status_columns.items():
        work[column] = work['transaction_status'].eq(status)
    grouped = work.groupby(KEYS)
    amounts = grouped['amount']
    daily = grouped.agg(transaction_count=('amount', 'size'), valid_amount_count=('amount', 'count'),
                        amount_mean=('amount', 'mean'), amount_median=('amount', 'median'),
                        amount_min=('amount', 'min'), amount_max=('amount', 'max'),
                        amount_std=('amount', 'std'), missing_amount_count=('missing_amount', 'sum'),
                        invalid_amount_count=('invalid_amount', 'sum'), zero_amount_count=('zero_amount', 'sum'),
                        missing_channel_count=('missing_channel', 'sum'),
                        missing_category_count=('missing_category', 'sum'),
                        imputed_category_count=('category_imputed', 'sum'))
    for q in (10, 25, 75, 90, 95):
        daily[f'amount_p{q}'] = amounts.quantile(q / 100)
    daily['amount_iqr'] = daily['amount_p75'] - daily['amount_p25']
    count_columns = list(daily.filter(regex='_count$').columns)
    for column in ('accepted_amount', 'attempted_amount'):
        daily[column] = grouped[column].sum(min_count=1)
        exposure = f'valid_{column}_count'
        daily[exposure] = grouped[column].count()
        count_columns.append(exposure)
    for column in status_columns.values():
        daily[column] = grouped[column].sum()
    count_columns.extend(status_columns.values())
    channels = list(CHANNELS.values()) + ['unknown']
    for channel in channels:
        channel_rows = work.loc[work['channel'].eq(channel)]
        by_channel = channel_rows.groupby(KEYS)
        daily[f'{channel}_count'] = by_channel.size().reindex(daily.index, fill_value=0)
        daily[f'{channel}_amount'] = by_channel['attempted_amount'].sum(min_count=1)
        daily[f'{channel}_declined'] = by_channel['declined_count'].sum().reindex(daily.index, fill_value=0)
        daily[f'{channel}_cancelled'] = by_channel['cancelled_count'].sum().reindex(daily.index, fill_value=0)
        count_columns.extend([f'{channel}_count', f'{channel}_declined', f'{channel}_cancelled'])
    observed_category = grouped['merchant_category'].agg(
        lambda values: values.dropna().iloc[0] if values.nunique() == 1 else pd.NA)
    daily['merchant_category'] = observed_category
    daily = calendar.merge(daily.reset_index(), on=KEYS, how='left', validate='one_to_one')
    daily[count_columns] = daily[count_columns].fillna(0).astype('int64')
    prior_category = daily['merchant_id'].map(reference_categories).astype('string')
    daily['merchant_category'] = daily['merchant_category'].fillna(prior_category)
    daily['has_activity'] = daily['transaction_count'].gt(0)
    daily['has_valid_amount'] = daily['valid_amount_count'].gt(0)
    daily['active_channels'] = daily[[f'{channel}_count' for channel in CHANNELS.values()]].gt(0).sum(axis=1)
    daily.loc[daily['accepted_count'].eq(0), 'accepted_amount'] = 0.0
    daily.loc[daily['transaction_count'].eq(daily['refunded_count']), 'attempted_amount'] = 0.0
    for status, rate in zip(STATUSES, ('acceptance', 'decline', 'cancellation', 'refund')):
        daily[f'{rate}_rate'] = ratio(daily[f'{status.lower()}_count'], daily['transaction_count'])
    for channel in channels:
        count = daily[f'{channel}_count']
        daily[f'{channel}_share'] = ratio(count, daily['transaction_count'])
        daily[f'{channel}_decline_rate'] = ratio(daily[f'{channel}_declined'], count)
        # No non-refund events for this channel implies zero attempted volume.
        attempted_keys = work.loc[work['channel'].eq(channel) & work['transaction_status'].ne('Refunded'), KEYS]
        has_attempt = pd.MultiIndex.from_frame(daily[KEYS]).isin(pd.MultiIndex.from_frame(attempted_keys))
        daily.loc[~has_attempt, f'{channel}_amount'] = 0.0
    validate_aggregation(daily, events, calendar, status_columns)
    return daily.sort_values(KEYS).reset_index(drop=True)


def validate_aggregation(daily, events, calendar, status_columns):
    pd.testing.assert_frame_equal(daily[KEYS].reset_index(drop=True), calendar.reset_index(drop=True))
    assert daily['transaction_count'].sum() == len(events)
    assert daily['valid_amount_count'].sum() == events['amount'].count()
    for status, column in status_columns.items():
        assert daily[column].sum() == events['transaction_status'].eq(status).sum()
    for channel in (*CHANNELS.values(), 'unknown'):
        assert daily[f'{channel}_count'].sum() == events['channel'].eq(channel).sum()
    accepted = events['transaction_status'].eq('Accepted')
    attempted = events['transaction_status'].ne('Refunded')
    np.testing.assert_allclose(daily['accepted_amount'].sum(), events.loc[accepted, 'amount'].sum())
    np.testing.assert_allclose(daily['attempted_amount'].sum(), events.loc[attempted, 'amount'].sum())
    np.testing.assert_allclose(daily[[f'{c}_amount' for c in (*CHANNELS.values(), 'unknown')]].sum().sum(),
                               daily['attempted_amount'].sum())
    inactive = daily.loc[~daily['has_activity']]
    assert inactive[['accepted_amount', 'attempted_amount']].eq(0).all().all()
    assert inactive[['amount_mean', 'amount_median', 'decline_rate', 'refund_rate']].isna().all().all()
