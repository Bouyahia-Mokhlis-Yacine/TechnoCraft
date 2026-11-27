"""Candidate-only amount normalization and contactless evidence."""

from math import isfinite

import numpy as np
import pandas as pd

from .aggregation import merchant_days, ratio
from .preprocessing import CHANNELS, KEYS, clean_text, clean_transactions


CONTACTLESS = next(label for label, key in CHANNELS.items() if key == 'nfc')
DEFAULT_LIMIT_DZD = 2500
REASON = 'contactless_amount_exceeds_permitted_limit'
REJECTED = ('Declined', 'Cancelled')
COUNTS = ('correction_count', 'contactless_count', 'contactless_assessable_count',
          'contactless_unknown_amount_count', 'payment_method_unknown_count', 'violation_count',
          'accepted_violations', 'declined_violations', 'cancelled_violations', 'rejected_violations',
          'refunded_violations', 'unknown_outcome_violations')


def apply_mentor_rules(events, limit=DEFAULT_LIMIT_DZD):
    """Recompute from original evidence when invoked repeatedly on the same events."""
    if not isfinite(limit) or limit <= 0:
        raise ValueError('The contactless limit must be positive and finite.')
    out = events.copy()
    if 'original_amount' not in out:
        out['original_amount'] = out['amount']
    raw = out.original_amount
    numeric = pd.to_numeric(raw, errors='coerce').astype(float)
    numeric = numeric.where(np.isfinite(numeric))
    out['amount_corrected'] = numeric.lt(0)
    out['missing_amount'] = raw.isna()
    out['invalid_amount'] = raw.notna() & numeric.isna()
    out['nonfinite_or_nonnumeric_amount'] = out.invalid_amount
    out['negative_amount'] = out.amount_corrected
    out['zero_amount'] = numeric.eq(0)
    out['amount'] = numeric.abs()
    method = clean_text(out.payment_channel)
    out['is_contactless'] = method.eq(CONTACTLESS).where(method.isin(CHANNELS)).astype('boolean')
    applicable = out.is_contactless.eq(True).fillna(False)
    assessable = applicable & out.amount.notna()
    violation = pd.Series(pd.NA, index=out.index, dtype='boolean')
    violation.loc[out.is_contactless.eq(False).fillna(False)] = False
    violation.loc[assessable] = out.loc[assessable, 'amount'].gt(limit)
    out['is_contactless_violation'] = violation
    flagged = violation.fillna(False)
    out['contactless_limit_dzd'] = float(limit)
    out['contactless_excess_dzd'] = (out.amount - limit).where(flagged)
    out['domain_reason'] = pd.Series(REASON, index=out.index, dtype='string').where(flagged)
    out['rule_assessment'] = np.select(
        [flagged.to_numpy(bool), assessable.to_numpy(bool), out.is_contactless.isna(), applicable.to_numpy(bool)],
        ['violation', 'within_limit', 'unknown_payment_method', 'unknown_contactless_amount'],
        default='not_applicable')
    return out


def prepare_candidate(raw, roster, *, limit=DEFAULT_LIMIT_DZD, reference_categories=None):
    raw = raw.reset_index(drop=True)
    categories = pd.Series(dtype='string') if reference_categories is None else reference_categories
    events, quality = clean_transactions(raw, categories)
    events['original_amount'] = raw.loc[events.index, 'amount']
    events['source_row'] = events.index + 1  # One-based data row, excluding the CSV header.
    events['recorded_transaction_status'] = raw.loc[events.index, 'transaction_status']
    events = apply_mentor_rules(events, limit)
    days = merchant_days(events, roster, categories)
    return days, events, quality


def merchant_day_evidence(events, calendar):
    flagged = events.is_contactless_violation.fillna(False)
    nfc = events.is_contactless.fillna(False)
    status = events.transaction_status
    records = events[KEYS].assign(
        correction_count=events.amount_corrected, contactless_count=nfc,
        contactless_assessable_count=nfc & events.amount.notna(),
        contactless_unknown_amount_count=nfc & events.amount.isna(),
        payment_method_unknown_count=events.is_contactless.isna(), violation_count=flagged,
        accepted_violations=flagged & status.eq('Accepted'), declined_violations=flagged & status.eq('Declined'),
        cancelled_violations=flagged & status.eq('Cancelled'), rejected_violations=flagged & status.isin(REJECTED),
        refunded_violations=flagged & status.eq('Refunded'), unknown_outcome_violations=flagged & status.eq('Unknown'),
        violation_value_dzd=events.amount.where(flagged), excess_dzd=events.contactless_excess_dzd)
    groups = records.groupby(KEYS)
    evidence = groups[list(COUNTS) + ['violation_value_dzd', 'excess_dzd']].sum()
    evidence['maximum_violation_dzd'] = groups.violation_value_dzd.max()
    out = calendar[KEYS].merge(evidence.reset_index(), on=KEYS, how='left', validate='one_to_one')
    out[list(COUNTS)] = out[list(COUNTS)].fillna(0).astype(int)
    out[['violation_value_dzd', 'excess_dzd']] = out[['violation_value_dzd', 'excess_dzd']].fillna(0.)
    out['violation_rate'] = ratio(out.violation_count, out.contactless_assessable_count)
    return out


def reference_events(events, cleaned):
    """Hold out violating severities while retaining count, outcome and category inputs."""
    if not cleaned:
        return events
    return events.assign(amount=events.amount.mask(events.is_contactless_violation.fillna(False)))


def transaction_evidence(row):
    original = row.original_amount
    original = original.item() if isinstance(original, np.generic) else original
    if isinstance(original, float) and not isfinite(original) and not pd.isna(original):
        original = str(original)
    corrected = float(row.amount) if pd.notna(row.amount) else None
    reason = row.domain_reason if pd.notna(row.domain_reason) else None
    limit = float(row.contactless_limit_dzd)
    excess = float(row.contactless_excess_dzd) if reason else None
    explanation = None
    if reason:
        explanation = (f'Contactless payment of {corrected:,.2f} DZD exceeded the mentor-confirmed '
                       f'limit of {limit:,.2f} DZD by {excess:,.2f} DZD. '
                       'The transaction was flagged by the domain rule independently of statistical evidence.')
        if row.amount_corrected:
            explanation += f' The recorded amount was {float(original):,.2f} DZD before sign correction.'
    return {'source_row': int(row.source_row), 'merchant_id': row.merchant_id,
            'date': row.date.date().isoformat(), 'transaction_time': row.transaction_date.isoformat(),
            'payment_method': row.payment_channel if pd.notna(row.payment_channel) else None, 'channel': row.channel,
            'outcome': row.transaction_status,
            'recorded_outcome': (row.recorded_transaction_status if pd.notna(row.recorded_transaction_status)
                                 else None), 'original_amount': original if pd.notna(original) else None,
            'corrected_amount_dzd': corrected, 'amount_corrected': bool(row.amount_corrected),
            'assessment': row.rule_assessment, 'reason': reason, 'permitted_contactless_amount_dzd': limit,
            'excess_dzd': excess, 'explanation': explanation}
