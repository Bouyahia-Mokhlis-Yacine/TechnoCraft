"""Load official transactions and retain observation-level quality indicators."""

import numpy as np
import pandas as pd

KEYS = ['merchant_id', 'date']
STATUSES = ('Accepted', 'Declined', 'Cancelled', 'Refunded')
CHANNELS = {
    'E-commerce (CIB / Edahabia)': 'ecommerce',
    'TPE / POS Terminal': 'pos',
    'Mobile App': 'mobile',
    'Contactless / NFC': 'nfc',
    'Bank Transfer / Virement': 'transfer',
}
TIMESTAMP = '%Y-%m-%d %H:%M:%S'


def load_inputs(root):
    return {
        name: pd.read_csv(root / filename, dtype={'masked_pan': 'string'})
        for name, filename in {
            'Train transactions': 'X_train_transactions.csv',
            'Train labels': 'y_train_labels.csv',
            'Test transactions': 'X_test_transactions.csv',
            'Test template': 'y_pred_template.csv',
        }.items()
    }


def clean_text(series):
    return series.astype('string').str.strip().replace('', pd.NA)


def calendar_keys(raw):
    calendar = pd.DataFrame({'merchant_id': clean_text(raw['merchant_id']),
                             'date': pd.to_datetime(raw['date'], format='%Y-%m-%d', errors='coerce')})
    if calendar.isna().any().any() or calendar.duplicated().any():
        raise ValueError('Calendar requires unique, complete merchant-day keys.')
    return calendar


def category_map(raw):
    """Map merchants with exactly one observed category in the supplied reference."""
    categories = pd.DataFrame({column: clean_text(raw[column])
                               for column in ('merchant_id', 'merchant_category')}).dropna()
    distinct = categories.drop_duplicates()
    return distinct.loc[~distinct['merchant_id'].duplicated(keep=False)].set_index(
        'merchant_id')['merchant_category']


def quality_flags(raw):
    """No card values leave this audit. Full-row and repeat flags use them transiently."""
    stamp = pd.to_datetime(raw['transaction_date'], format=TIMESTAMP, errors='coerce')
    amount = pd.to_numeric(raw['amount'], errors='coerce')
    merchant = clean_text(raw['merchant_id'])
    category = clean_text(raw['merchant_category'])
    channel = clean_text(raw['payment_channel'])
    status = clean_text(raw['transaction_status'])
    whitespace = pd.DataFrame({c: raw[c].astype('string').ne(raw[c].astype('string').str.strip())
                               for c in raw.select_dtypes(include=['object', 'string'])}).fillna(False)
    exact = raw.duplicated()
    unique = ~exact
    same_business_fields = raw.loc[unique].drop(columns='masked_pan').duplicated(keep=False)
    # Minute bucket is a candidate signature. The official data have no transaction ID.
    minute_signature = pd.DataFrame({'merchant': merchant, 'card': raw['masked_pan'],
                                     'minute': stamp.dt.floor('min'), 'amount': amount,
                                     'channel': channel, 'status': status})
    near = minute_signature.loc[unique].duplicated(keep=False).reindex(raw.index, fill_value=False)
    same_card_second = minute_signature.assign(minute=stamp)[['merchant', 'card', 'minute']]
    repeat_stamp = same_card_second.loc[unique].duplicated(keep=False).reindex(raw.index, fill_value=False)
    reference = category_map(raw)
    observed_categories = pd.DataFrame({'merchant': merchant, 'category': category}).dropna()
    conflicts = observed_categories.groupby('merchant')['category'].nunique().loc[lambda s: s.gt(1)].index
    return pd.DataFrame({
        'exact_duplicate': exact,
        'minute_repeat_candidate': near,
        'same_second_card_candidate': repeat_stamp,
        'same_business_fields_candidate': same_business_fields.reindex(raw.index, fill_value=False),
        'missing_merchant': merchant.isna(),
        'invalid_timestamp': stamp.isna(),
        'midnight_timestamp': stamp.dt.hour.eq(0) & stamp.dt.minute.eq(0) & stamp.dt.second.eq(0),
        'missing_amount': raw['amount'].isna(),
        'nonfinite_or_nonnumeric_amount': ~np.isfinite(amount) & raw['amount'].notna(),
        'negative_amount': amount.lt(0),
        'zero_amount': amount.eq(0),
        'missing_channel': channel.isna(),
        'unknown_channel': channel.notna() & ~channel.isin(CHANNELS),
        'missing_category': category.isna(),
        'recoverable_category_in_split': category.isna() & merchant.map(reference).notna(),
        'conflicting_merchant_category': merchant.isin(conflicts),
        'missing_status': status.isna(),
        'unknown_status': status.notna() & ~status.isin(STATUSES),
        'missing_card_field': clean_text(raw['masked_pan']).isna(),
        'whitespace': whitespace.any(axis=1),
    })


def clean_transactions(raw, reference_categories, *, deduplicate=True):
    """Return card-free events and an audit of the input rows.

    Missing categories use only the supplied reference. For deployment, construct it
    from prior training or maintained merchant metadata. Valid observed categories
    remain usable for a new merchant on the day they are observed.
    """
    flags = quality_flags(raw)
    eligible = ~(flags['missing_merchant'] | flags['invalid_timestamp'])
    if deduplicate:
        eligible &= ~flags['exact_duplicate']
    events = raw.loc[eligible].drop(columns='masked_pan').copy()
    for column in ('merchant_id', 'merchant_category', 'payment_channel', 'transaction_status'):
        events[column] = clean_text(events[column])
    events['transaction_date'] = pd.to_datetime(events['transaction_date'], format=TIMESTAMP)
    events['date'] = events['transaction_date'].dt.normalize()
    events['hour'] = events['transaction_date'].dt.hour
    events['channel'] = events['payment_channel'].map(CHANNELS).fillna('unknown')
    events['transaction_status'] = events['transaction_status'].where(
        events['transaction_status'].isin(STATUSES), 'Unknown')
    prior_category = events['merchant_id'].map(reference_categories).astype('string')
    events['category_imputed'] = events['merchant_category'].isna() & prior_category.notna()
    events['merchant_category'] = events['merchant_category'].fillna(prior_category)
    events = events.join(flags.loc[eligible, ['missing_amount', 'missing_channel', 'missing_category',
                                             'negative_amount', 'zero_amount', 'nonfinite_or_nonnumeric_amount']])
    events['invalid_amount'] = events['negative_amount'] | events['nonfinite_or_nonnumeric_amount']
    events['amount'] = pd.to_numeric(events['amount'], errors='coerce').mask(events['invalid_amount'])
    return events, flags
