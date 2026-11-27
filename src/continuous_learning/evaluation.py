"""Paired evaluation with predeclared chronological windows and prospective labels."""

from collections import defaultdict
from datetime import date

import numpy as np
import pandas as pd

from engine.metrics import episodes, evaluate

from .feedback import trusted
from .store import NORMAL


def alert(ev):
    return bool(ev['sequential_flag'] or ev['hybrid_flag'])


def metrics(rows, role):
    def summarize(frame):
        return {name: value.item() if isinstance(value, np.generic) else value
                for name, value in evaluate(frame).items()}

    counts = defaultdict(list)
    labelled = []
    all_alerts = 0
    for row in rows:
        evidence = row[role]
        pred = alert(evidence)
        all_alerts += pred
        for metric, error in evidence['forecasts'].items():
            counts[metric].append(error)
        if row['label'] is not None:
            labelled.append({'merchant_id': row['merchant'], 'date': pd.Timestamp(row['day']),
                              'pred': pred, 'is_anomaly': row['label'] == 'confirmed_anomaly',
                              'anomaly_score': max(evidence['sequential_score'] / evidence['sequential_threshold'],
                                                   evidence['hybrid_score'] / evidence['hybrid_threshold']),
                              'legitimate_change': row['label'] == 'legitimate_change'})
    output = {'all_alerts': all_alerts, 'alerts_per_1000': 1000 * all_alerts / len(rows) if rows else None,
              'reviewed_rows': len(labelled), 'forecast': {}}
    for name, values in counts.items():
        errors = np.array([r['error'] for r in values])
        output['forecast'][name] = {'n': len(values), 'mae': float(np.abs(errors).mean()),
                                    'rmse': float(np.sqrt(np.mean(errors ** 2))),
                                    'coverage_90': float(np.mean([r['covered_90'] for r in values]))}
    if not labelled:
        return output
    frame = pd.DataFrame(labelled)
    output['reviewed_anomalies'] = int(frame.is_anomaly.sum())
    output['reviewed_normal'] = int((~frame.is_anomaly).sum())
    normal = frame.loc[~frame.is_anomaly]
    changes = frame.loc[frame.legitimate_change]
    output['reviewed_false_alerts_per_1000'] = float(1000 * normal.pred.mean()) if len(normal) else None
    output['legitimate_change_false_alerts_per_1000'] = float(1000 * changes.pred.mean()) if len(changes) else None
    if not frame.is_anomaly.any() or normal.empty:
        positives = int(frame.is_anomaly.sum())
        alerts = int(frame.pred.sum())
        hits = int((frame.pred & frame.is_anomaly).sum())
        output.update(precision=hits / alerts if alerts else None,
                      recall=hits / positives if positives else None,
                      f1=2 * hits / (alerts + positives) if alerts + positives else None)
        return output
    output.update(summarize(frame))
    output['average_precision'] = output.pop('pr_auc')
    delays, persistent_days = [], []
    persistent_hits = []
    for incident in episodes(frame, 'is_anomaly').itertuples(index=False):
        sightings = frame.loc[frame.merchant_id.eq(incident.merchant_id) &
                              frame.date.between(incident.start, incident.end)]
        first = sightings.loc[sightings.pred, 'date'].min()
        length = (incident.end - incident.start).days + 1
        delays.append(length if pd.isna(first) else (first - incident.start).days)
        if length >= 2:
            persistent_hits.append(bool(sightings.pred.any()))
            persistent_days.extend(sightings.pred.tolist())
    output['mean_delay_days_misses_charged_episode_length'] = float(np.mean(delays))
    output['persistent_episodes'] = len(persistent_hits)
    output['persistent_episode_recall'] = float(np.mean(persistent_hits)) if persistent_hits else None
    output['persistent_anomaly_day_recall'] = float(np.mean(persistent_days)) if persistent_days else None
    return output


def compare(packets, observations, labels, plan, policy):
    rows, changed, by_day = [], [], defaultdict(set)
    timings = {'champion': 0., 'challenger': 0.}
    for key in observations:
        by_day[key[1]].add(key[0])
    score_days = set()
    prospective = True
    label_manifest = []
    for packet in packets:
        stamp = packet['date']
        score_days.add(stamp)
        prospective &= packet['prospective']
        if by_day[stamp] != {row['merchant'] for row in packet['rows']}:
            changed.append(stamp)
        for role in timings:
            timings[role] += packet['scoring_seconds'][role]
        for row in packet['rows']:
            key = row['merchant'], stamp
            obs = observations.get(key)
            label = labels.get(key)
            if obs is None or obs['digest'] != row['digest'] or obs['revision'] != row['revision']:
                changed.append(stamp)
                continue
            usable = (trusted(label, obs) and label['label'] in NORMAL | {'confirmed_anomaly'}
                      and label['first_reviewed_at'] > packet['scored_at'])
            if usable:
                label_manifest.append([*key, label['revision'], label['approval']])
            rows.append({**row, 'day': stamp, 'label': label['label'] if usable else None})
    champion, challenger = (metrics(rows, role) for role in ('champion', 'challenger'))
    expected_days = (date.fromisoformat(plan['eval_end']) - date.fromisoformat(plan['eval_start'])).days + 1
    blockers = []
    if not prospective or len(score_days) != expected_days or changed:
        blockers.append('incomplete_or_changed_prospective_window')
    if (len(rows) < policy['min_eval_rows'] or len(score_days) < policy['min_eval_dates']
            or champion['reviewed_rows'] != len(rows)
            or champion.get('reviewed_anomalies', 0) < policy['min_eval_anomalies']
            or champion.get('reviewed_normal', 0) < policy['min_eval_normal']
            or champion.get('true_episodes', 0) < policy['min_eval_episodes']
            or champion.get('persistent_episodes', 0) < policy['min_persistent_episodes']):
        blockers.append('insufficient_independent_reviewed_support')
    if not blockers:
        for name in ('recall', 'episode_recall', 'persistent_episode_recall', 'persistent_anomaly_day_recall'):
            if champion.get(name) is not None and (challenger.get(name) is None or challenger[name] < champion[name]):
                blockers.append(f'{name}_regression')
        false_alert_delta = challenger['reviewed_false_alerts_per_1000'] - champion['reviewed_false_alerts_per_1000']
        if false_alert_delta > policy['max_false_alert_increase_per_1000']:
            blockers.append('false_alert_workload_regression')
        delay = 'mean_delay_days_misses_charged_episode_length'
        if challenger[delay] - champion[delay] > policy['max_detection_delay_increase_days']:
            blockers.append('detection_delay_regression')
    return {'eligible_for_promotion': not blockers, 'blockers': blockers, 'champion': champion,
            'challenger': challenger, 'dates_scored': len(score_days), 'expected_dates': expected_days,
            'scoring_seconds': timings, 'label_manifest': label_manifest,
            'estimand': 'Paired reviewed window. No population inference from targeted labels.',
            'recommendation': 'Supervisor review required.'}

