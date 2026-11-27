"""Operational artifacts built with the existing probabilistic, CUSUM and H3 models."""

from dataclasses import dataclass, replace
import json
import math
from time import perf_counter

import numpy as np
import pandas as pd

from engine.replay import CONFIGS, INPUTS, check_fingerprints, load_split
from src.data.preprocessing import KEYS
from src.detection.calibration import RankCalibration
from src.detection.channel import fit_channel_reference, score_channels
from src.detection.collective import network_advisories
from src.detection.incidents import IncidentMonitor
from src.detection.references import Batch, ReferencePolicy, Review
from src.detection.sequential import calibrated_threshold
from src.hybrid_detection.features import build_feature_epoch, fit_hierarchical_channel_model
from src.hybrid_detection.fusion import EmpiricalCalibrator, FusionPolicy
from src.hybrid_detection.models import fit_ml_model
from src.operations.collective import network_scan
from src.operations.forecasting import fit_forecast, predictive_draws, summarize

from .store import ROOT


@dataclass(frozen=True)
class Artifact:
    configs: tuple
    hierarchy: object
    channel: object
    forecast: object
    hourly_profiles: dict
    ml: object
    fusion: FusionPolicy
    sequential_calibration: RankCalibration
    collective_calibration: RankCalibration | None
    calibration_end: str
    forecast_draws: int

    @property
    def reference(self):
        return self.hierarchy.base_reference

    def hourly_profile(self, merchant, target):
        weekday = pd.Timestamp(target).weekday()
        return self.hourly_profiles.get((merchant, weekday), self.hourly_profiles.get((None, weekday)))


def configs():
    check_fingerprints(ROOT / 'config', CONFIGS)
    return tuple(json.loads((ROOT / 'config' / name).read_text(encoding='utf-8')) for name in CONFIGS)


def epoch(history, events, days, start, artifact_configs, hierarchy=None):
    return build_feature_epoch(history, events, days, start, *artifact_configs[:3], prior_hmodel=hierarchy)


def scans(days, channel, model_configs):
    v1, _, v3, _ = model_configs
    for stamp, group in days.groupby('date'):
        scored = score_channels(group, stamp, Batch('complete', stamp), channel, roster=group.merchant_id)
        yield stamp, network_scan(scored, v1, v3)


def profiles(events):
    counts = {}
    for (merchant, weekday), group in events.groupby(['merchant_id', events.date.dt.weekday]):
        daily_counts = np.bincount(group.hour.astype(int), minlength=24)
        counts[merchant, weekday] = daily_counts
        counts[None, weekday] = counts.get((None, weekday), np.zeros(24, dtype=int)) + daily_counts
    return {key: tuple((value / value.sum()).tolist()) for key, value in counts.items()}


def fit(history, fit_days, cal_days, events, origin, cal_end, draws, *, reviews=None, fixed_ml=None,
        archived_history=None):
    started = perf_counter()
    model_configs = configs()
    v1, v2, v3, v4 = model_configs
    settings = v4['selected_challenger']
    hierarchy = fit_hierarchical_channel_model(history, events, origin, v1)
    if reviews is not None:
        admission = ReferencePolicy('reviewed').snapshot(history, events, origin, v1['version'], reviewed=reviews)
        if hierarchy.base_reference.version != admission.version:
            raise ValueError('Reference admission and feature history disagree.')
    channel = fit_channel_reference(history, events, origin, v3['version'])
    calibration_start = cal_days.date.min()
    feature_history = history if archived_history is None else archived_history
    feature_hierarchy = hierarchy if archived_history is None else None
    cal = epoch(feature_history, events, cal_days, calibration_start, model_configs, feature_hierarchy)
    matrix = cal.matrix(settings['feature_set'])
    if matrix.shape[1] != 62:
        raise ValueError('The hybrid requires the existing 62 H3 features.')
    if fixed_ml is None:
        train = epoch(feature_history, events, fit_days, origin, model_configs, feature_hierarchy)
        ml = fit_ml_model(settings['ml_family'], train.matrix(settings['feature_set']), settings['ml_params'], v4['seed'])
    else:
        ml = fixed_ml
    statistical = cal.h1['v2_managed_score']
    ml_scores = ml.score(matrix)
    v2_rank = RankCalibration.fit(statistical)
    fusion = FusionPolicy('C3_rank_fisher', settings['fusion_method'], 1., 0., 1.,
                          EmpiricalCalibrator.fit(statistical), EmpiricalCalibrator.fit(ml_scores),
                          v2_rank, math.inf, 0, settings['calibration_cutoff_rule'])
    rank = RankCalibration.fit(fusion.score(statistical, ml_scores, matrix))
    alpha = float(settings['calibration_cutoff_rule'].split()[1])
    threshold = calibrated_threshold(rank, alpha)
    if threshold is None:
        raise ValueError('Insufficient calibration rank resolution.')
    fusion = replace(fusion, joint_calibrator=rank, threshold=threshold)
    maxima = [scan.maximum for _, scan in scans(cal_days, channel, model_configs) if scan is not None]
    if archived_history is not None:
        maxima = v3['frozen']['collective_sorted_date_maxima']
    finite_maxima = [score for score in maxima if score is not None and np.isfinite(score)]
    collective = RankCalibration.fit(finite_maxima) if finite_maxima else None
    past_events = events.merge(history[KEYS], on=KEYS, validate='many_to_one')
    artifact = Artifact(model_configs, hierarchy, channel, fit_forecast(history, past_events, origin),
                        profiles(past_events), ml, fusion, v2_rank, collective, cal_end, draws)
    details = {'reference_version': artifact.reference.version, 'channel_reference_version': channel.base.version,
               'feature_count': matrix.shape[1], 'configured_sequential_threshold': IncidentMonitor.from_config(v2).threshold,
               'candidate_sequential_threshold': calibrated_threshold(v2_rank, alpha),
               'hybrid_threshold': fusion.threshold, 'collective_calibration_dates': len(finite_maxima),
               'collective_supported': collective is not None,
               'fit_seconds': perf_counter() - started, 'isolation_forest_fit_ms': ml.fit_ms if fixed_ml is None else 0.,
               'estimator_kib': ml.kib, 'frozen_configurations': model_configs}
    return artifact, details


def bootstrap(draws):
    """Package the archived training-only operational baseline. No held-out file is opened."""
    check_fingerprints(ROOT, {name: INPUTS[name] for name in ('X_train_transactions.csv', 'y_train_labels.csv')})
    v1, _, v3, v4 = configs()
    roster = pd.read_csv(ROOT / 'y_train_labels.csv', usecols=KEYS)
    days, events, _ = load_split(ROOT, 'train', roster)
    boundary = pd.Timestamp(v1['development']['reserved_start'])
    ordinary = days.loc[days.date.lt(boundary)]
    events = events.loc[events.date.lt(boundary)]
    cuts = v4['chronological_cutoffs']
    fit_start, cal_start, cal_stop = (pd.Timestamp(cuts[name]) for name in
                                   ('ml_fit_start', 'calibration_start', 'burden_start'))
    fit_days = ordinary.loc[ordinary.date.ge(fit_start) & ordinary.date.lt(cal_start)]
    cal_days = ordinary.loc[ordinary.date.ge(cal_start) & ordinary.date.lt(cal_stop)]
    packaged, details = fit(ordinary.loc[ordinary.date.lt(fit_start)], fit_days, cal_days, events, fit_start,
                            (boundary - pd.Timedelta(days=1)).date().isoformat(), draws, archived_history=ordinary)
    base = fit_hierarchical_channel_model(ordinary, events, boundary, v1)
    channel = fit_channel_reference(ordinary, events, boundary, v3['version'])
    details.update(reference_version=base.base_reference.version, channel_reference_version=channel.base.version,
                   provenance='sealed_ordinary_training_archive', reference_last_day=ordinary.date.max().date().isoformat(),
                   fit_end=fit_days.date.max().date().isoformat(), calibration_end=cal_days.date.max().date().isoformat(),
                   dataset_fingerprints={name: INPUTS[name] for name in ('X_train_transactions.csv', 'y_train_labels.csv')})
    return replace(packaged, hierarchy=base, channel=channel, forecast=fit_forecast(ordinary, events, boundary),
                   hourly_profiles=profiles(events)), details


def _forecast_error(artifact, merchant, stamp, row):
    draws, means = predictive_draws(artifact.forecast, merchant, [stamp], draws=artifact.forecast_draws)[0]
    actuals = {'transactions': row.transaction_count, 'accepted_value': row.accepted_amount,
               'rejections': row.declined_count}
    output = {}
    for metric, actual in actuals.items():
        distribution = summarize(draws[metric], means[metric])
        if distribution is None or pd.isna(actual) or (metric == 'accepted_value' and
                                                       row.valid_accepted_amount_count != row.accepted_count):
            continue
        lo, hi = distribution['intervals']['90']
        error = float(actual - distribution['mean'])
        output[metric] = {'error': error, 'covered_90': bool(lo <= actual <= hi)}
    return output


def _outcome_residual(record):
    rate = record.get('expected_rate')
    if rate is None:
        return None
    variance = record['exposure'] * rate * (1. - rate)
    return float((record['observed'] - record['expected']) / np.sqrt(max(1., variance)))


def score(artifact, model_id, days, events, *, prior_states=None, snapshots=None, forecast_from=None, score_from=None):
    """Replay complete batches, preserving pinned incident snapshots when switching versions."""
    v1, v2, v3, _ = artifact.configs
    monitor = IncidentMonitor.from_config(v2)
    reference = artifact.reference
    snapshots = {**(snapshots or {}), reference.version: reference}
    states = dict(prior_states or {})
    features = epoch(days.iloc[:0], events, days, days.date.min(), artifact.configs, artifact.hierarchy)
    matrix = features.matrix('H3')
    ml_scores = artifact.ml.score(matrix)
    ml_ranks = dict(zip(matrix.index, artifact.fusion.ml_calibrator.tail_rank(ml_scores)))
    ml_scores = dict(zip(matrix.index, ml_scores))
    scored_days = days if score_from is None else days.loc[days.date.ge(pd.Timestamp(score_from))]
    scans_by_day = dict(scans(scored_days, artifact.channel, artifact.configs))
    result = {}
    for stamp, group in days.groupby('date', sort=True):
        date = stamp.date().isoformat()
        if score_from is not None and date < score_from:
            continue
        batch = Batch('complete', stamp)
        daily = {}
        states, readings = monitor.step_day(stamp, batch, group, events, reference, snapshots, states, v1,
                                           evidence_sink=daily)
        collective = {}
        if artifact.collective_calibration is not None:
            for advisory in network_advisories(scans_by_day[stamp], artifact.collective_calibration,
                                               local_tail=v3['collective']['local_tail'],
                                               minimum_attributed=v3['collective']['minimum_attributed']):
                for member in advisory.scan.members:
                    collective[member.merchant_id] = min(advisory.fleet_tail_rank, collective.get(member.merchant_id, 1.))
        for row in group.itertuples(index=False):
            merchant = row.merchant_id
            reading, _ = readings[merchant]
            state = states[merchant].incident
            key = (stamp, merchant)
            sequential = reading.scores['managed']
            hybrid = float(artifact.fusion.score([sequential], [ml_scores[key]])[0])
            detectors = daily[merchant]['detectors']
            count = detectors['transaction_count']
            expected = count['expected']
            forecasts = _forecast_error(artifact, merchant, stamp, row) if forecast_from is None or date >= forecast_from else {}
            count_forecast = forecasts.get('transactions', {})
            result[merchant, date] = {'model_version': model_id, 'reference_version': reading.reference_version,
                'phase': state.phase.value, 'reference_hold': reading.hold_for_review,
                'incident_id': state.incident_id or (f'{merchant}:{state.candidate_on}' if state.candidate_on else None),
                'symptom': daily[merchant]['dominant_detector'],
                'sequential_score': float(sequential), 'sequential_flag': bool(reading.alert),
                'sequential_threshold': monitor.threshold, 'hybrid_score': hybrid,
                'hybrid_flag': hybrid >= artifact.fusion.threshold, 'hybrid_threshold': artifact.fusion.threshold,
                'ml_tail_rank': float(ml_ranks[key]), 'hybrid_tail_rank': artifact.fusion.joint_calibrator.rank(hybrid),
                'collective': merchant in collective, 'collective_tail_rank': collective.get(merchant),
                'count_residual': None if expected is None else float((row.transaction_count - expected) / np.sqrt(max(1., expected))),
                'rejection_residual': _outcome_residual(detectors['declines']),
                'cancellation_residual': _outcome_residual(detectors['cancellations']),
                'forecast_error': count_forecast.get('error'), 'forecast_covered': count_forecast.get('covered_90'),
                'forecasts': forecasts}
    return result, states


def reviewed_reference(rows, eligible):
    keys = {(row['merchant'], row['day']) for row in rows}
    return [Review(obs['merchant'], pd.Timestamp(obs['day']), pd.Timestamp(label['decided_at'][:10]),
                   'clear', label['label'])
            for obs, label, reason in eligible if reason == 'eligible' and (obs['merchant'], obs['day']) in keys]

