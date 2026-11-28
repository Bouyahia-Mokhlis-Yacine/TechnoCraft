"""Calendar-matched distribution diagnostics and a separate reviewed outcome summary."""

from datetime import date
import json

import holidays
import numpy as np
from scipy.spatial.distance import jensenshannon
from scipy.stats import wasserstein_distance

from .feedback import current_feedback, trusted
from .observations import CHANNEL_CODES, effective
from .store import NORMAL, Store, authorize, day

SCALAR = ('transaction_count', 'median_ticket', 'ticket_p90', 'rejection_rate', 'cancellation_rate',
          'count_residual', 'rejection_residual', 'cancellation_residual',
          'hybrid_score', 'alert_workload', 'forecast_error', 'predictive_coverage')
TIMES = tuple(range(24))
RATES = {'rejection_rate', 'cancellation_rate', 'alert_workload', 'predictive_coverage'}
MODEL_SIGNALS = {'count_residual', 'rejection_residual', 'cancellation_residual',
                 'hybrid_score', 'alert_workload', 'forecast_error', 'predictive_coverage'}
VECTORS = {'channel_composition': CHANNEL_CODES, 'hourly_profile': TIMES}


def signals(obs):
    body = json.loads(obs['payload'])
    ev = body['evidence']
    events = body['events']
    count = len(events)
    amounts = [event['amount'] for event in events if event['amount'] is not None]
    return {
        'transaction_count': count,
        'median_ticket': np.median(amounts) if amounts else None,
        'ticket_p90': np.quantile(amounts, .9) if amounts else None,
        'rejection_rate': sum(e['transaction_status'] == 'Declined' for e in events) / count if count else None,
        'cancellation_rate': sum(e['transaction_status'] == 'Cancelled' for e in events) / count if count else None,
        'count_residual': ev['count_residual'],
        'rejection_residual': ev.get('rejection_residual'),
        'cancellation_residual': ev.get('cancellation_residual'),
        'hybrid_score': ev['hybrid_score'],
        'alert_workload': int(ev['sequential_flag'] or ev['hybrid_flag']) if ev['sequential_score'] is not None else None,
        'forecast_error': ev['forecast_error'],
        'predictive_coverage': ev['forecast_covered'],
        'channel_composition': [sum(e['channel'] == c for e in events) for c in CHANNEL_CODES] if count else None,
        'hourly_profile': np.bincount([e['hour'] for e in events], minlength=24) if count else None,
    }


def statistic(name, baseline, recent):
    if name in VECTORS:
        return float(jensenshannon(np.sum(baseline, axis=0), np.sum(recent, axis=0), base=2))
    if name in RATES:
        return float(wasserstein_distance(baseline, recent))
    q25, q75 = np.quantile(baseline, [.25, .75])
    scale = max(q75 - q25, float(np.median(np.abs(baseline))) * .1, 1.)
    return float(wasserstein_distance(baseline, recent) / scale)


def diagnostics(baseline, recent, policy):
    calendar = holidays.country_holidays('DZ')
    windows = []
    for rows in (baseline, recent):
        strata = {}
        for obs in rows:
            stamp = date.fromisoformat(obs['day'])
            ev = json.loads(obs['payload'])['evidence']
            group = (obs['merchant'], stamp.weekday(), stamp in calendar)
            strata.setdefault(group, []).append((signals(obs), ev))
        windows.append(strata)
    results = {}
    minimum = policy['drift_min_rows_per_stratum']
    for name in (*SCALAR, *VECTORS):
        distances, weights = [], []
        matched = [0, 0]
        for group in sorted(windows[0].keys() & windows[1].keys()):
            # Model-derived signals are comparable only within a model/reference regime.
            packets = [window[group] for window in windows]
            regimes = {(ev['model_version'], ev['reference_version']) for packet in packets
                       for values, ev in packet if values[name] is not None}
            if name in MODEL_SIGNALS and len(regimes) != 1:
                continue
            x, y = ([values[name] for values, _ in packet if values[name] is not None] for packet in packets)
            if min(len(x), len(y)) < minimum:
                continue
            matched[0] += len(x)
            matched[1] += len(y)
            distances.append(statistic(name, x, y))
            weights.append(len(y))
        sufficient = (min(matched) >= policy['drift_min_rows_per_window'] and bool(recent)
                      and matched[1] / len(recent) >= policy['drift_min_calendar_match_fraction'])
        distance = float(np.average(distances, weights=weights)) if sufficient else None
        if name in VECTORS:
            metric, threshold = 'jensen_shannon_distance', policy['drift_js_distance_warning']
        elif name in RATES:
            metric, threshold = 'wasserstein', policy['drift_absolute_rate_warning']
        else:
            metric, threshold = 'scaled_wasserstein', policy['drift_scaled_wasserstein_warning']
        results[name] = {'distance': distance, 'metric': metric, 'matched_rows': matched, 'threshold': threshold,
                         'status': 'insufficient_support' if distance is None else
                         'investigate' if distance >= threshold else 'within_threshold'}
    return results


def reviewed_performance(rows, labels):
    reviewed = []
    for obs in rows:
        label = labels.get((obs['merchant'], obs['day']))
        ev = json.loads(obs['payload'])['evidence']
        if (trusted(label, obs) and label['label'] in NORMAL | {'confirmed_anomaly'}
                and ev['sequential_score'] is not None):
            reviewed.append((label['label'] == 'confirmed_anomaly', ev['sequential_flag'] or ev['hybrid_flag']))
    positives = sum(t for t, _ in reviewed)
    alerted = sum(p for _, p in reviewed)
    tp = sum(t and p for t, p in reviewed)
    return {'reviewed': len(reviewed), 'positives': positives, 'precision': tp / alerted if alerted else None,
            'recall': tp / positives if positives else None}


def report(store, actor, baseline_start, baseline_end, recent_start, recent_end, policy):
    authorize(actor)
    a, b, c, d = map(day, (baseline_start, baseline_end, recent_start, recent_end))
    if not a <= b < c <= d:
        raise ValueError('Drift windows must be ordered and disjoint.')
    with store.connect() as db:
        def window(start, end):
            return effective(db, Store.scoped(db.execute(
                'SELECT * FROM current_observation WHERE day BETWEEN ? AND ?', (start, end)), actor))
        baseline, recent = window(a, b), window(c, d)
        labels = current_feedback(db)
    return {'distribution_shift': diagnostics(baseline, recent, policy),
            'reviewed_performance': {'baseline': reviewed_performance(baseline, labels),
                                     'recent': reviewed_performance(recent, labels),
                                     'scope': 'Reviewed subset only. Review selection may differ by period.'},
            'policy': 'Investigate distribution warnings. Concept drift and retraining are not inferred.'}

