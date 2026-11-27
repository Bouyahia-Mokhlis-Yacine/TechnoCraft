"""Chronological training replay, locked development evaluation and episode metrics."""

from dataclasses import dataclass
import json

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment
from sklearn.metrics import average_precision_score, confusion_matrix

from src.data.preprocessing import KEYS
from .baselines import baseline_scores, fit_isolation_forest, residual_features
from .calibration import RankCalibration
from .detectors import score_day
from .references import Batch, ReferencePolicy, closed_day_reviews, fit_reference, prepare_observations

MODELS = ('Probabilistic', 'Robust MAD', 'Isolation Forest')


def load_config(path):
    config = json.loads(path.read_text(encoding='utf-8'))
    dates = [pd.Timestamp(config['development'][key]) for key in
             ('if_feature_start', 'calibration_start', 'burden_start', 'reserved_start', 'reserved_end')]
    if any(a >= b for a, b in zip(dates, dates[1:])):
        raise ValueError('Development dates must be in strictly chronological order.')
    if config['reference']['reserved']['freeze_on'] != config['development']['reserved_start']:
        raise ValueError('The reserved snapshot must freeze at the start of the block.')
    return config


def _load_range(root, start=None, end=None):
    roster = pd.read_csv(root / 'y_train_labels.csv', usecols=KEYS)
    start, end = start or roster.date.min(), end or roster.date.max()
    roster = roster.loc[roster.date.between(start, end)]
    chunks = pd.read_csv(root / 'X_train_transactions.csv', dtype={'masked_pan': 'string'}, chunksize=4096)
    raw = pd.concat([chunk.loc[chunk.transaction_date.str.slice(0, 10).between(start, end)]
                     for chunk in chunks], ignore_index=True)
    return prepare_observations(raw, roster)


def _origins(start, end):
    return pd.date_range(start, pd.Timestamp(end) - pd.Timedelta(days=1))


def _scores(days, events, day, reference, config, forest, *, calibration=None, alpha=None):
    current = days.loc[days.date.eq(day)].sort_values('merchant_id')
    features = residual_features(days.loc[days.date.lt(reference.as_of)], current, reference, config)
    robust, isolation = baseline_scores(features, forest)
    details = score_day(days, events, day, Batch('complete', day), reference, config,
                        calibration=calibration, alpha=alpha)
    frame = pd.DataFrame({
        'merchant_id': current.merchant_id.to_numpy(), 'date': day,
        'Probabilistic': [row['anomaly_score'] for row in details],
        'Robust MAD': robust, 'Isolation Forest': isolation,
        'symptom': [row['dominant_symptom'] for row in details],
        'component': [row['dominant_detector'] for row in details],
        'exposure': current.transaction_count.to_numpy(),
        'valid_amounts': current.valid_amount_count.to_numpy(),
        'support_days': [row['support']['eligible_days'] for row in details],
    })
    return frame, details


def select_thresholds(burden, calibrators, config):
    rows, selected = [], {}
    policy = config['alerts']
    for model, calibrator in calibrators.items():
        ranks = burden[model].map(calibrator.rank)
        allowed = []
        for threshold in policy['candidate_tail_ranks']:
            flags = ranks.le(threshold)
            alerts = int(flags.sum())
            week = 7 * alerts / len(flags)
            if week <= policy['max_ordinary_alerts_per_merchant_week']:
                allowed.append(threshold)
            rows.append({'model': model, 'tail_rank': threshold, 'alerts': alerts,
                         'merchant_days': len(flags), 'alerts_per_merchant_week': week,
                         'peak_daily_alerts': int(flags.groupby(burden.date).sum().max())})
        selected[model] = max(allowed, default=None)
    return pd.DataFrame(rows), selected


@dataclass
class Development:
    days: pd.DataFrame
    events: pd.DataFrame
    calibrators: dict
    forest: object
    burden: pd.DataFrame
    threshold_sweep: pd.DataFrame
    selected: dict


def ordinary_replay(root, config):
    dates = config['development']
    boundary = pd.Timestamp(dates['reserved_start'])
    days, events = _load_range(root, end=(boundary - pd.Timedelta(days=1)).date().isoformat())
    fit = lambda date: fit_reference(days, events, date, config['version'])
    features = []
    for day in _origins(dates['if_feature_start'], dates['calibration_start']):
        ref = fit(day)
        features.append(residual_features(days.loc[days.date.lt(day)], days.loc[days.date.eq(day)], ref, config))
    forest = fit_isolation_forest(pd.concat(features), config)

    calibration_rows = [_scores(days, events, day, fit(day), config, forest)[0]
                        for day in _origins(dates['calibration_start'], dates['burden_start'])]
    scores = pd.concat(calibration_rows, ignore_index=True)
    calibrators = {model: RankCalibration.fit(scores[model]) for model in MODELS}

    reference = fit(dates['burden_start'])
    burden = pd.concat([_scores(days, events, day, reference, config, forest)[0]
                        for day in _origins(dates['burden_start'], boundary)], ignore_index=True)
    sweep, selected = select_thresholds(burden, calibrators, config)
    return Development(days, events, calibrators, forest, burden, sweep, selected)


def cold_start_diagnostics(development, config):
    """Hold merchants out of the predictive reference on ordinary replay dates."""
    days, events = development.days, development.events
    settings = config['development']
    cutoff = pd.Timestamp(settings['burden_start'])
    prior = days.loc[days.date.lt(cutoff)]
    merchants = sorted(prior.merchant_id.unique())
    n = min(len(merchants), settings['cold_start_merchants'])
    sample = [merchants[index] for index in np.linspace(0, len(merchants) - 1, n, dtype=int)]
    calibrator = development.calibrators['Probabilistic']
    rows = []
    for offset, merchant in enumerate(sample):
        day = cutoff + pd.Timedelta(days=offset)
        actual = days.loc[days.date.eq(day) & days.merchant_id.eq(merchant)]
        own = prior.loc[prior.merchant_id.eq(merchant)].sort_values('date')
        for support in settings['cold_start_support_days']:
            reduced = pd.concat([prior.loc[prior.merchant_id.ne(merchant)], own.tail(support)])
            ref = fit_reference(reduced, events, cutoff, config['version'])
            result, = score_day(actual, events, day, Batch('complete', day), ref, config,
                                calibration=calibrator, alpha=development.selected['Probabilistic'])
            count = result['detectors']['transaction_count']
            lo, hi = count['interval']
            rows.append({'merchant_id': merchant, 'support_days': result['support']['eligible_days'],
                         'date': day, 'count_method': count['method'],
                         'count_absolute_error': abs(count['observed'] - count['expected']),
                         'count_interval_hit': lo <= count['observed'] <= hi,
                         'amount_global_fallback': result['support']['positive_tickets'] == 0,
                         'rank': result['calibrated_tail_rank'], 'alert': result['is_anomaly']})
    return pd.DataFrame(rows)


def reserved_replay(root, config, development):
    """Run the locked eight-day replay before joining any retrospective labels."""
    thresholds = config['alerts']['selected_tail_ranks']
    if thresholds is None or thresholds != development.selected:
        raise ValueError('Freeze the ordinary-day threshold selection before reserved evaluation.')
    start, stop = (config['development'][key] for key in ('reserved_start', 'reserved_end'))
    days, events = _load_range(root, start, stop)
    boundary = pd.Timestamp(start)
    ordinary = development.days
    reviews = closed_day_reviews(ordinary, Batch('complete', ordinary.date.max()), 'clear',
                                 'Initial ordinary training seed under the offline closure assumption',
                                 reviewed_on=ordinary.date.max())
    policy = ReferencePolicy(**config['reference']['reserved'])
    reference = policy.snapshot(ordinary, development.events, boundary, config['version'], reviewed=reviews)
    scoring_days = pd.concat([ordinary, days], ignore_index=True)
    frames, explanations = [], []
    origins = pd.date_range(start, stop)
    if set(days.date) != set(origins):
        raise ValueError('Reserved data must include every calendar day of the frozen block.')
    for day in origins:
        frame, details = _scores(scoring_days, events, day, reference, config, development.forest,
                                 calibration=development.calibrators['Probabilistic'],
                                 alpha=thresholds['Probabilistic'])
        frame['Probabilistic rank'] = [result['calibrated_tail_rank'] for result in details]
        frame['Probabilistic alert'] = [bool(result['is_anomaly']) for result in details]
        for model, calibrator in development.calibrators.items():
            if model == 'Probabilistic':
                continue
            rank = frame[model].map(calibrator.rank)
            frame[model + ' rank'] = rank
            threshold = thresholds[model]
            frame[model + ' alert'] = rank.le(threshold) if threshold is not None else False
        frames.append(frame)
        explanations.extend(details)

    truth = pd.read_csv(root / 'y_train_labels.csv', parse_dates=['date']).loc[
        lambda frame: frame.date.between(start, stop)]
    replay = pd.concat(frames, ignore_index=True).merge(truth, on=KEYS, validate='one_to_one', how='outer',
                                                       indicator=True)
    if not replay.pop('_merge').eq('both').all():
        raise ValueError('Predictions and official merchant-day labels differ.')
    return replay, explanations


def daily_metrics(replay):
    truth = replay.is_anomaly
    rows = []
    for model in MODELS:
        alert = replay[model + ' alert']
        tn, fp, fn, tp = (int(x) for x in confusion_matrix(truth, alert, labels=[0, 1]).ravel())
        rows.append({'model': model, 'precision': tp / (tp + fp) if tp + fp else 0.,
                     'recall': tp / (tp + fn) if tp + fn else 0.,
                     'F1': 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.,
                     'AP': average_precision_score(truth, replay[model]),
                     'FPR': fp / (fp + tn) if fp + tn else np.nan,
                     'TN': tn, 'FP': fp, 'FN': fn, 'TP': tp,
                     'false_alerts_per_merchant_week': 7 * fp / len(replay),
                     'false_alerts_per_normal_merchant_week': 7 * fp / (fp + tn) if fp + tn else np.nan})
    return pd.DataFrame(rows).set_index('model')


@dataclass(frozen=True)
class Episode:
    merchant: str
    kind: str
    dates: tuple


def _episodes(frame, *, gap, labelled):
    grouping = 'merchant_id'
    if labelled:
        grouping = ['merchant_id', 'anomaly_type']
    episodes = []
    for key, rows in frame.groupby(grouping, sort=True):
        merchant, kind = key if labelled else (key, 'alert')
        dates = rows.date.sort_values()
        runs = dates.diff().dt.days.gt(gap + 1).cumsum()
        episodes.extend(Episode(merchant, kind, tuple(run)) for _, run in dates.groupby(runs))
    return episodes


def match_episodes(truth, alerts):
    if not truth or not alerts:
        return {}
    # Cardinality dominates overlap, which dominates delay. Only positive weights can match.
    min_pair_count = min(len(truth), len(alerts))
    span = (max(e.dates[-1] for e in truth) - min(e.dates[0] for e in truth)).days + 1
    overlap_weight = min_pair_count * span + 1
    match_weight = overlap_weight * (min_pair_count * span + 1)
    weight = np.zeros((len(truth), len(alerts)), dtype=np.int64)
    delays = {}
    for ti, actual in enumerate(truth):
        actual_days = set(actual.dates)
        for ai, predicted in enumerate(alerts):
            if actual.merchant != predicted.merchant:
                continue
            overlap = actual_days.intersection(predicted.dates)
            if overlap:
                delay = (min(overlap) - actual.dates[0]).days
                weight[ti, ai] = match_weight + len(overlap) * overlap_weight - delay
                delays[ti, ai] = delay
    rows, cols = linear_sum_assignment(weight, maximize=True)
    return {ti: (ai, delays[ti, ai]) for ti, ai in zip(rows, cols) if weight[ti, ai]}


def episode_metrics(replay, config):
    truth = _episodes(replay.loc[replay.is_anomaly.eq(1)], gap=0, labelled=True)
    summary, detail = [], []
    for model in MODELS:
        alerts = _episodes(replay.loc[replay[model + ' alert']],
                           gap=config['episodes']['alert_max_gap_days'], labelled=False)
        matches = match_episodes(truth, alerts)
        delays = [delay for _, delay in matches.values()]
        precision = len(matches) / len(alerts) if alerts else 0.
        summary.append({'model': model, 'matched': len(matches), 'alert_episodes': len(alerts),
                        'true_episodes': len(truth), 'precision': precision,
                        'recall': len(matches) / len(truth) if truth else 0.,
                        'median_delay_days': np.median(delays) if delays else np.nan,
                        'max_delay_days': max(delays, default=np.nan),
                        'meets_local_precision_gate': precision >= config['episodes']['required_precision']})
        for index, episode in enumerate(truth):
            delay = matches[index][1] if index in matches else np.nan
            detail.append({'model': model, 'merchant_id': episode.merchant, 'type': episode.kind,
                           'start': episode.dates[0].date(), 'end': episode.dates[-1].date(), 'delay_days': delay})
    return pd.DataFrame(summary).set_index('model'), pd.DataFrame(detail)


def by_anomaly_type(replay, episode_detail):
    positive = replay.loc[replay.is_anomaly.eq(1)]
    results = []
    for model in MODELS:
        detail = episode_detail.loc[episode_detail.model.eq(model)]
        for kind, rows in positive.groupby('anomaly_type'):
            episodes = detail.loc[detail.type.eq(kind), 'delay_days']
            alerts = int(rows[model + ' alert'].sum())
            results.append({'model': model, 'type': kind, 'positive_days': len(rows), 'detected_days': alerts,
                            'day_recall': alerts / len(rows), 'matched_episodes': episodes.count(),
                            'true_episodes': len(episodes), 'median_delay_days': episodes.median() if episodes.count()
                            else np.nan})
    return pd.DataFrame(results)

