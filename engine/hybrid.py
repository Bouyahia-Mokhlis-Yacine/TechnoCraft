"""Reproduce the selected V4 challenger on its archived ordinary fitting windows."""

import json
from dataclasses import replace
from time import perf_counter

import pandas as pd

from src.detection.benchmark_features import keyed
from src.detection.calibration import RankCalibration
from src.detection.incidents import IncidentMonitor
from src.detection.sequential import calibrated_threshold
from src.hybrid_detection.explainability import explain_v4_row
from src.hybrid_detection.features import build_feature_epoch
from src.hybrid_detection.fusion import EmpiricalCalibrator, FusionPolicy
from src.hybrid_detection.models import fit_ml_model

from .replay import ROOT


def build_hybrid(ordinary, ordinary_events, current, events, official, backend, configs):
    start = perf_counter()
    config = json.loads((ROOT / 'config/hybrid_detection.v4.json').read_text(encoding='utf-8'))
    settings = config['selected_challenger']
    cutoffs = config['chronological_cutoffs']
    fit_at, cal_at, burden_at = (pd.Timestamp(cutoffs[k]) for k in
                                ('ml_fit_start', 'calibration_start', 'burden_start'))
    fit_epoch = build_feature_epoch(ordinary, ordinary_events,
                                    ordinary.loc[ordinary.date.ge(fit_at) & ordinary.date.lt(cal_at)],
                                    fit_at, *configs)
    calibration = build_feature_epoch(ordinary, ordinary_events,
                                      ordinary.loc[ordinary.date.ge(cal_at) & ordinary.date.lt(burden_at)],
                                      cal_at, *configs)
    epoch = build_feature_epoch(ordinary, events, current, current.date.min(), *configs)
    feature_seconds = perf_counter() - start

    fit, cal, features = (block.matrix(settings['feature_set']) for block in (fit_epoch, calibration, epoch))
    if features.shape[1] != config['feature_sets']['H3']['count']:
        raise ValueError('The selected challenger requires 62 H3 features.')
    model = fit_ml_model(settings['ml_family'], fit, settings['ml_params'], seed=config['seed'])
    cal_ml = model.score(cal)
    cal_v2 = calibration.h1['v2_managed_score']
    v2_cal, ml_cal = EmpiricalCalibrator.fit(cal_v2), EmpiricalCalibrator.fit(cal_ml)
    fusion = FusionPolicy(
        name='C3_rank_fisher', method=settings['fusion_method'],
        v2_anchor=1., ml_median=0., ml_scale=1., v2_calibrator=v2_cal, ml_calibrator=ml_cal,
        joint_calibrator=RankCalibration.fit([0.]), threshold=float('inf'),
        ordinary_alerts=settings['development_ordinary_alerts_385'],
        cutoff_rule=settings['calibration_cutoff_rule'],
    )
    rank = RankCalibration.fit(fusion.score(cal_v2, cal_ml, cal))
    method, alpha = settings['calibration_cutoff_rule'].split()
    threshold = calibrated_threshold(rank, float(alpha))
    if method != 'rank' or threshold is None:
        raise ValueError('The archived V4 rank threshold is unavailable.')
    fusion = replace(fusion, joint_calibrator=rank, threshold=threshold)

    before_inference = perf_counter()
    ordered = keyed(official.assign(date=pd.to_datetime(official.date))).reindex(features.index)
    if ordered.anomaly_score.isna().any() or len(ordered) != len(official):
        raise ValueError('V4 features do not align with the official merchant-day roster.')
    ml_scores = model.score(features)
    ranks = ml_cal.tail_rank(ml_scores)
    scores = fusion.score(ordered.anomaly_score, ml_scores, features)
    inference_seconds = perf_counter() - before_inference
    fit_medians = fit.median()
    fit_std = fit.std()
    fit_scales = fit_std.where(fit_std.gt(1e-6), 1.)
    v2_threshold = IncidentMonitor.from_config(configs[1]).threshold
    output = []
    detail_start = perf_counter()
    for key, ml_score, ml_rank, score, v2_score, v2_flag in zip(
        features.index, ml_scores, ranks, scores, ordered.anomaly_score, ordered.is_anomaly,
    ):
        day, merchant = key
        flagged = score >= threshold
        row = {'merchant_id': merchant, 'date': day.date().isoformat(), 'v4_advisory_score': float(score),
               'v4_ordinary_rank': float(ml_rank), 'ml_score': float(ml_score),
               'investigation_candidate': bool(flagged and not v2_flag)}
        if flagged or v2_flag:
            row['evidence'] = explain_v4_row(
                key, features.loc[key], fit_medians, fit_scales, backend.daily_evidence[key],
                epoch.channel_details[key], model, v2_score, v2_threshold,
                ml_score, ml_rank, score, threshold, bool(v2_flag), bool(flagged),
            )
        output.append(row)
    return {'version': config['version'], 'challenger': settings['name'], 'feature_count': features.shape[1],
            'candidate_boundary': threshold, 'rows': output,
            'performance': {'feature_seconds': feature_seconds, 'fit_ms': model.fit_ms,
                            'inference_seconds': inference_seconds, 'explanation_seconds': perf_counter() - detail_start}}
