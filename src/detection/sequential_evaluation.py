"""Ordinary-only calibration and locked development replay for SATIM v2."""

from dataclasses import dataclass
from pathlib import Path
import json

import pandas as pd
from sklearn.metrics import average_precision_score

from .calibration import RankCalibration
from .detectors import score_day
from .evaluation import Episode, _episodes, _load_range, _origins, load_config, match_episodes
from .incidents import IncidentMonitor
from .references import Batch, ReferencePolicy, closed_day_reviews, fit_reference
from .sequential import CountTrack, Fusion, RateBank, calibrated_threshold


MODELS = {'v1': 'V1 probabilistic', 'cusum': 'Standalone CUSUM',
          'combined': 'V1 + CUSUM', 'managed': 'V1 + CUSUM + incident state'}
CONFIG_FILE = Path('config/probabilistic_detection.v2.json')


def _versioned_reference(days, events, origin, v1):
    ledger = closed_day_reviews(days, Batch('complete', days.date.max()), 'clear',
                                'Ordinary training seed under offline closure assumption',
                                reviewed_on=days.date.max())
    return ReferencePolicy('frozen', origin).snapshot(days, events, origin, v1['version'], reviewed=ledger)


def _trace(days, events, origins, reference, v1, banks):
    tracks = {}
    for day in origins:
        batch = Batch('complete', day)
        for daily in score_day(days, events, day, batch, reference, v1):
            merchant = daily['merchant_id']
            evidence = {}
            for name, bank in banks.items():
                key = (merchant, name)
                track = tracks.get(key, CountTrack())
                tracks[key], evidence[name] = track.step(day, batch, daily, reference, bank)
            yield day, daily, evidence


@dataclass
class Ordinary:
    days: pd.DataFrame
    events: pd.DataFrame
    frozen: dict
    sweep: pd.DataFrame


def calibrate(root, v1, v2):
    dates = v1['development']
    start, burden, boundary = (pd.Timestamp(dates[key]) for key in
                               ('calibration_start', 'burden_start', 'reserved_start'))
    prior_end = (boundary - pd.Timedelta(days=1)).date().isoformat()
    days, events = _load_range(root, end=prior_end)
    banks = {name: RateBank(tuple(ratios)) for name, ratios in v2['ratio_banks'].items()}
    cal_days = _origins(start, burden)
    cal_reference = fit_reference(days, events, start, v1['version'])
    cal = list(_trace(days, events, cal_days, cal_reference, v1, banks))
    expanding = [daily['anomaly_score'] for day in cal_days
                 for daily in score_day(days, events, day, Batch('complete', day),
                                        fit_reference(days, events, day, v1['version']), v1)]
    v1_rank = RankCalibration.fit(expanding)
    v1_alpha = v1['alerts']['selected_tail_ranks']['Probabilistic']
    v1_threshold = calibrated_threshold(v1_rank, v1_alpha)
    burden_reference = fit_reference(days, events, burden, v1['version'])
    ordinary = list(_trace(days, events, _origins(burden, boundary), burden_reference, v1, banks))
    exposure = len(ordinary)
    budget = v1['alerts']['max_ordinary_alerts_per_merchant_week']

    anchor = v2['fusion_anchor_tail_rank']
    instant_scale = calibrated_threshold(RankCalibration.fit(row['anomaly_score'] for _, row, _ in cal), anchor)
    selected = {'v1': {'alpha': v1_alpha, 'threshold': v1_threshold,
                       'ordinary_alerts': sum(row['anomaly_score'] >= v1_threshold for _, row, _ in ordinary)}}
    fusion_specs, sweep = {}, []
    for name in banks:
        sequential_scale = calibrated_threshold(
            RankCalibration.fit(evidence[name].peak(0)[0] for _, _, evidence in cal if evidence[name]), anchor)
        fusion = Fusion(instant_scale, sequential_scale, v2['persistence_days'])
        fusion_specs[name] = {'instant_scale': instant_scale, 'sequential_scale': sequential_scale,
                              'persistence': fusion.persistence}
        cal_scores = [fusion.scores(row, evidence[name]) for _, row, evidence in cal]
        burden_scores = [fusion.scores(row, evidence[name]) for _, row, evidence in ordinary]
        for model in ('cusum', 'combined', 'managed'):
            ranks = RankCalibration.fit(row[model] for row in cal_scores)
            options = []
            for alpha in v2['candidate_tail_ranks']:
                threshold = calibrated_threshold(ranks, alpha)
                alerts = sum(threshold is not None and row[model] is not None and row[model] >= threshold
                             for row in burden_scores)
                option = {'alpha': alpha, 'threshold': threshold, 'ordinary_alerts': alerts}
                rate = 7 * alerts / exposure
                sweep.append({'bank': name, 'model': model, **option, 'ordinary_alerts_per_week': rate})
                if threshold is not None and rate <= budget:
                    options.append(option)
            if not options:
                for multiplier in v2['above_max_multipliers']:
                    threshold = ranks.scores[-1] * multiplier
                    alerts = sum(row[model] is not None and row[model] >= threshold for row in burden_scores)
                    rate = 7 * alerts / exposure
                    option = {'alpha': None, 'threshold': threshold, 'ordinary_alerts': alerts,
                              'above_max_multiplier': multiplier}
                    sweep.append({'bank': name, 'model': model, **option, 'ordinary_alerts_per_week': rate})
                    if rate <= budget:
                        options.append(option)
            selected[f'{name}/{model}'] = min(options, key=lambda x: x['threshold'],
                                              default={'alpha': None, 'threshold': None, 'ordinary_alerts': 0})
    frozen = {'calibration_merchant_days': len(cal), 'burden_merchant_days': exposure,
              'ordinary_last_date': prior_end, 'budget_per_merchant_week': budget, 'fusion': fusion_specs,
              'policies': selected}
    return Ordinary(days, events, frozen, pd.DataFrame(sweep))


def load_configs(root):
    return (load_config(root / 'config/probabilistic_detection.v1.json'),
            json.loads((root / CONFIG_FILE).read_text(encoding='utf-8')))


def terminal_replay(root, v1, v2, ordinary):
    if v2 != json.loads((root / CONFIG_FILE).read_text(encoding='utf-8')) or v2['frozen'] != ordinary.frozen:
        raise ValueError('Write and verify the ordinary-only v2 configuration before terminal replay.')
    start, end = (v1['development'][key] for key in ('reserved_start', 'reserved_end'))
    reference = _versioned_reference(ordinary.days, ordinary.events, start, v1)
    days, events = _load_range(root, start, end)
    origins = pd.date_range(start, end)
    if set(days.date) != set(origins):
        raise ValueError('The terminal replay requires every calendar date of the block.')

    name = v2['primary_bank']
    monitor = IncidentMonitor.from_config(v2)
    thresholds = {key: ordinary.frozen['policies'][key if key == 'v1' else f'{name}/{key}']['threshold']
                  for key in MODELS}
    states, rows = {}, []
    for day in origins:
        states, results = monitor.step_day(day, Batch('complete', day), days, events, reference,
                                           {reference.version: reference}, states, v1)
        for merchant, (result, _) in results.items():
            scores = result.scores or dict.fromkeys(MODELS)
            alerts = {f'{key}_alert': thresholds[key] is not None and scores[key] is not None
                      and scores[key] >= thresholds[key] for key in ('v1', 'cusum', 'combined')}
            rows.append({'date': day, 'merchant_id': merchant, **scores, **alerts, 'managed_alert': result.alert,
                         'phase': states[merchant].incident.phase.value, 'incident_id': result.incident_id,
                         'reference_version': result.reference_version})

    truth = pd.read_csv(root / 'y_train_labels.csv', parse_dates=['date'])
    truth = truth.loc[truth.date.between(start, end)]
    replay = pd.DataFrame(rows).merge(truth, on=['merchant_id', 'date'], how='outer',
                                      validate='one_to_one', indicator=True)
    if not replay.pop('_merge').eq('both').all():
        raise ValueError('Predictions and official merchant-day labels differ.')
    return replay


def _episode_summary(truth, alerts):
    matches = match_episodes(truth, alerts)
    delays = pd.Series([delay for _, delay in matches.values()], dtype=float)
    matched_alerts = {index for index, _ in matches.values()}
    duplicates = sum(i not in matched_alerts and any(
        episode.merchant == truth[index].merchant and set(episode.dates).intersection(truth[index].dates)
        for index in matches) for i, episode in enumerate(alerts))
    drop = [index for index, episode in enumerate(truth) if episode.kind == 'DROP_VOLUME']
    return {'matched': len(matches), 'alert_episodes': len(alerts),
            'episode_precision': len(matches) / len(alerts) if alerts else 0.,
            'episode_recall': len(matches) / len(truth),
            'median_delay': delays.median(), 'max_delay': delays.max(),
            'mean_delay': delays.mean(), 'duplicate_episodes': duplicates,
            'drop_episodes': sum(index in matches for index in drop)}


def metrics(replay, v1, ordinary, bank):
    daily, episodes = [], []
    positives = replay.loc[replay.is_anomaly.eq(1)]
    truth = _episodes(positives, gap=0, labelled=True)
    for key, model in MODELS.items():
        flagged = replay.loc[replay[f'{key}_alert']]
        tp = int(flagged.is_anomaly.sum())
        fp = len(flagged) - tp
        policy = ordinary.frozen['policies'][key if key == 'v1' else f'{bank}/{key}']
        ordinary_fp = policy['ordinary_alerts']
        daily.append({'model': model, 'TP': tp, 'FP': fp,
                      'precision': tp / len(flagged) if len(flagged) else 0.,
                      'recall': tp / len(positives), 'F1': 2 * tp / (len(positives) + len(flagged)),
                      'AP': average_precision_score(replay.is_anomaly, replay[key].fillna(0.)),
                      'drop_days': int(flagged.anomaly_type.eq('DROP_VOLUME').sum()),
                      'ordinary_FP': ordinary_fp,
                      'ordinary_FP_per_week': 7 * ordinary_fp / ordinary.frozen['burden_merchant_days'],
                      'terminal_FP_per_week': 7 * fp / len(replay)})
        gap = v1['episodes']['alert_max_gap_days']
        runs = _episodes(flagged, gap=gap, labelled=False)
        episodes.append({'model': model, 'grouping': 'daily runs', **_episode_summary(truth, runs)})
        if key == 'managed':
            if flagged.incident_id.isna().any():
                raise ValueError('Every managed alert must belong to an incident.')
            groups = [Episode(rows.merchant_id.iloc[0], 'alert', tuple(sorted(rows.date)))
                      for _, rows in flagged.groupby('incident_id', sort=True)]
            episodes.append({'model': model, 'grouping': 'incident IDs', **_episode_summary(truth, groups)})
    return pd.DataFrame(daily).set_index('model'), pd.DataFrame(episodes).set_index(['model', 'grouping'])
