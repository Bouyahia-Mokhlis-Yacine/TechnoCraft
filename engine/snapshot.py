"""Adapt card-free SATIM evidence to the versioned website snapshot."""

from collections import Counter

import numpy as np
import pandas as pd

from src.data.preprocessing import CHANNELS
from src.detection.incidents import IncidentMonitor
from src.operations.backend import Scope
from src.operations.triage import ACTIONS

from .replay import evidence

SCHEMA_VERSION = 2
CHANNEL_LABELS = {**{key: name for name, key in CHANNELS.items()}, 'unknown': 'Unknown'}
QUALITY_FLAGS = ('missing_amount', 'invalid_amount', 'negative_amount', 'zero_amount',
                 'missing_channel', 'unknown_channel', 'missing_category', 'category_imputed')
SIGNALS = {'transaction_count': 'count', 'declines': 'decline', 'cancellations': 'cancel',
           'median_ticket': 'amount'}


def clean(value):
    """JSON types only. Preserve every bit of the official score."""
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, pd.Timestamp):
        return value.date().isoformat()
    if isinstance(value, np.generic):
        return clean(value.item())
    if value is pd.NA or value is pd.NaT or (isinstance(value, float) and not np.isfinite(value)):
        return None
    return value


def forecast_view(forecast):
    def points(series, metric):
        return [{'date': day['date'], 'expected': stat['mean'], 'lo': stat['intervals']['80'][0],
                 'hi': stat['intervals']['80'][1]} for day in forecast['days']
                if (stat := series(day).get(metric)) is not None]

    backtest = evidence('forecast_backtest.json')
    by_model = {row['model']: row for row in backtest['network']
                if row.get('metric') == 'transactions'}
    model = by_model.get('gamma_poisson', {})
    naive = by_model.get('seasonal_naive', {})
    return {'as_of': (pd.Timestamp(forecast['origin']) - pd.Timedelta(days=1)).date().isoformat(),
            'origin': forecast['origin'], 'last_reference_date': forecast['last_reference_date'],
            'method': 'Compound Gamma–Poisson, historical outcomes and empirical accepted tickets',
            'network': points(lambda day: day['network'], 'transactions'),
            'merchants': {m: points(lambda day: day['merchants'][m], 'transactions')
                          for m in forecast['support']},
            'backtest': {'origins': len(backtest['origins']), 'horizon_days': 7,
                         'mae_model': model.get('mae'), 'mae_seasonal_naive': naive.get('mae'),
                         'interval_coverage': model.get('coverage80'), 'nominal_coverage': .8,
                         'evidence': backtest},
            'detail': forecast}


def transaction_view(events, ordinary_events):
    from src.data.preprocessing import category_map

    t = events.sort_values(['transaction_date', 'merchant_id', 'source_row']).copy()
    labels = category_map(ordinary_events)
    recovered = t.merchant_category.isna() & t.date.gt(ordinary_events.date.max()) & t.merchant_id.isin(labels.index)
    t.loc[recovered, 'merchant_category'] = t.loc[recovered, 'merchant_id'].map(labels)
    t.loc[recovered, 'category_imputed'] = True
    merchants = sorted(t.merchant_id.unique())
    indexes = {m: i for i, m in enumerate(merchants)}
    return {'merchants': merchants, 'ts': t.transaction_date.dt.strftime('%Y-%m-%d %H:%M:%S').tolist(),
            'merchant': t.merchant_id.map(indexes).tolist(), 'category': t.merchant_category.fillna('Unknown').tolist(),
            'channel': t.channel.map(CHANNEL_LABELS).tolist(), 'status': t.transaction_status.tolist(),
            'amount': t.amount.tolist(), 'source_row': t.source_row.tolist(),
            'quality': [[flag for flag, status in zip(QUALITY_FLAGS, row) if status]
                        for row in t[list(QUALITY_FLAGS)].itertuples(index=False, name=None)],
            'contactless_limit': t.contactless_limit.tolist()}


def advisory_view(backends, days, observations):
    official = {(r['merchant_id'], r['date']): r['is_anomaly'] for r in observations}
    indexed = days.set_index(['merchant_id', 'date'])
    advisories = []
    for backend in backends:
        scope = Scope(backend.roster)
        for row in backend.advisories(scope, backend.epoch, backend.closed_through):
            code, category, symptom = row['signature']
            date = row['date']
            members = []
            for local in row['local_evidence']:
                mid = local['merchant_id']
                observed = indexed.loc[mid, pd.Timestamp(date)]
                members.append({**local, 'n': int(observed[f'{code}_count']),
                                'n_dec': int(observed[f'{code}_declined']),
                                'affected': mid in row['corroborated_merchants'],
                                'flagged': bool(official.get((mid, date)))})
            exposure = row['exposure']
            advisories.append({**row, 'id': f"V3-{date}-{code}-{category or 'all'}-{symptom}",
                               'category': category, 'channel': CHANNEL_LABELS[code], 'members': members,
                               'n': sum(m['n'] for m in members), 'n_dec': sum(m['n_dec'] for m in members),
                               'observed_rate': row['observed'] / exposure if exposure and symptom == 'rejection_increase' else None,
                               'expected_rate': row['expected'] / exposure if exposure and symptom == 'rejection_increase' else None,
                               'score': row['collective_log_likelihood_ratio'],
                               'threshold': backend._v3['frozen']['collective_sorted_date_maxima'][-1]})
    return advisories


def incident_view(backends):
    records, queue = {}, []
    for backend in backends:
        scope = Scope(backend.roster)
        for row in backend.incident_history(scope):
            records[row['id']] = row
    official = backends[-1]
    queue = official.queue(Scope(official.roster), official.closed_through, include_resolved=False)
    for row in queue:
        if row['kind'] == 'merchant_incident':
            records[row['id']] = row
    return list(records.values()), queue


def merchant_view(days, events, prior, backends, official_holidays):
    probabilities = dict(prior)
    prediction, explanations, states = {}, {}, {}
    for backend in backends:
        probabilities.update(backend.daily_evidence)
        states.update(backend.lifecycle)
        for item in backend.official_v2_predictions(Scope(backend.roster), backend.epoch, backend.closed_through):
            key = (pd.Timestamp(item['date']), item['merchant_id'])
            prediction[key] = item
            if item['is_anomaly']:
                explanation = backend.explanation(Scope(backend.roster), *key)
                owner, action = ACTIONS.get(explanation['symptom'], ACTIONS['other'])
                explanations[key] = {**explanation, 'responsible_role': owner, 'first_action': action}
    hours = events.groupby(['date', 'merchant_id']).hour.agg(lambda h: np.bincount(h, minlength=24).tolist())
    categories = {}
    rows = []
    for day in days.sort_values(['date', 'merchant_id']).itertuples(index=False):
        key = (day.date, day.merchant_id)
        date = day.date.date().isoformat()
        if pd.notna(day.merchant_category):
            categories[day.merchant_id] = day.merchant_category
        category = categories.get(day.merchant_id, 'Unknown')
        item = probabilities.get(key, {})
        detectors = item.get('detectors', {})
        count = detectors.get('transaction_count', {})
        lo, hi = count.get('interval') or (None, None)
        history = item.get('support', {}).get('eligible_days', 0)
        signals = {}
        for detector, signal in SIGNALS.items():
            metric = detectors.get(detector, {})
            if metric.get('score') is None:
                continue
            if signal == 'count':
                signal = 'drop' if metric['observed'] < metric['expected'] else 'surge'
            signals[f's_{signal}'] = metric['score']
        main = SIGNALS.get(item.get('dominant_detector'), 'unavailable')
        if main == 'count':
            main = 'drop' if count['observed'] < count['expected'] else 'surge'
        explanation = explanations.get(key)
        if explanation and explanation['signal_source'] == 'persistent_count':
            main = explanation['count_cusum']['direction'] + '_sustained'
            signals[f's_{main}'] = explanation['count_cusum']['log_likelihood_ratio']
        accepted = day.accepted_amount if day.valid_accepted_amount_count == day.accepted_count else None
        rows.append({
            'merchant_id': day.merchant_id, 'date': date, 'category': category,
            'n': day.transaction_count, 'n_acc': day.accepted_count, 'n_dec': day.declined_count,
            'n_can': day.cancelled_count, 'n_ref': day.refunded_count, 'value': accepted,
            'valid_accepted_amount_count': day.valid_accepted_amount_count,
            'unknown_status_count': day.unknown_status_count, 'ticket': day.amount_median,
            'expected_n': count.get('expected'), 'expected_n_adj': count.get('expected'),
            'expected_lo': lo, 'expected_hi': hi, 'holiday': date in official_holidays, 'holiday_factor': 1,
            'history_days': history, 'warming_up': history < 14,
            'expected_dec_rate': detectors.get('declines', {}).get('expected_rate'),
            'expected_can_rate': detectors.get('cancellations', {}).get('expected_rate'),
            'expected_ticket': detectors.get('median_ticket', {}).get('expected'),
            **signals, 'incident_channel': None, 'main_signal': main,
            'anomaly_score': prediction.get(key, {}).get('anomaly_score'),
            'is_anomaly': prediction.get(key, {}).get('is_anomaly'),
            'explanation': explanation, 'lifecycle': states.get(key), 'reference': item.get('reference_version'),
            'detectors': detectors, 'reference_support': item.get('support'), 'availability': 'complete',
            'hours': hours.get(key, [0] * 24),
            'channels': {label: [getattr(day, f'{code}_count'), getattr(day, f'{code}_declined')]
                         for code, label in CHANNEL_LABELS.items() if getattr(day, f'{code}_count')},
        })
    return rows


def network_view(days, transactions):
    by_day = []
    for day, group in days.groupby('date'):
        accepted = int(group.accepted_count.sum())
        accepted_valid = int(group.valid_accepted_amount_count.sum())
        n = int(group.transaction_count.sum())
        by_day.append({'date': day.date().isoformat(), 'transactions': n,
                       'accepted_value': float(group.accepted_amount.sum()) if accepted == accepted_valid else None,
                       'known_accepted_value': float(group.accepted_amount.sum()), 'accepted': accepted,
                       'valid_accepted_amounts': accepted_valid,
                       'declined': int(group.declined_count.sum()), 'cancelled': int(group.cancelled_count.sum()),
                       'rejection_rate': float(group.declined_count.sum() / n) if n else None,
                       'cancellation_rate': float(group.cancelled_count.sum() / n) if n else None})
    return {'daily': by_day, 'channels': dict(Counter(transactions['channel']))}
