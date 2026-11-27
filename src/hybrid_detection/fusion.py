"""Calibrated hybrid evidence fusion policies (C1–C5) and incident-lifecycle gating."""

from dataclasses import dataclass
from math import inf, nextafter

import numpy as np
import pandas as pd
from scipy.stats import kendalltau, spearmanr

from src.detection.calibration import RankCalibration
from src.detection.sequential import calibrated_threshold


@dataclass(frozen=True)
class EmpiricalCalibrator:
    """Inclusive empirical rank calibration with continuous upper-tail extension above max."""
    sorted_scores: tuple
    median: float
    mad: float

    @classmethod
    def fit(cls, scores):
        arr = np.sort(np.asarray(list(scores), dtype=float))
        if len(arr) == 0 or not np.isfinite(arr).all():
            raise ValueError('Calibrator requires finite calibration scores.')
        med = float(np.median(arr))
        mad = max(1e-6, float(np.median(np.abs(arr - med))) * 1.4826)
        return cls(tuple(float(x) for x in arr), med, mad)

    def tail_rank(self, scores):
        arr = np.asarray(scores, dtype=float)
        n = len(self.sorted_scores)
        below = np.searchsorted(self.sorted_scores, arr, side='left')
        return (1.0 + n - below) / (1.0 + n)

    def continuous_neglog10_rank(self, scores):
        """Convert scores to -log10(rank), extending smoothly above calibration maximum."""
        arr = np.asarray(scores, dtype=float)
        ranks = self.tail_rank(arr)
        base = -np.log10(ranks)
        top = self.sorted_scores[-1]
        excess = np.maximum(0.0, arr - top) / self.mad
        return base + np.log1p(excess)


def reliability_weight(features, *, min_days=14.0, min_tx=5.0):
    """Interpretable uncertainty weight w in [0.25, 1.0] from support, exposure & completeness."""
    days = np.expm1(features['support_log_days'].to_numpy())
    tx = np.expm1(features['count_obs_log'].to_numpy())
    miss = features['missing_amount_frac'].to_numpy()
    w_sup = np.clip(days / min_days, 0.35, 1.0)
    w_exp = np.clip(tx / min_tx, 0.50, 1.0)
    w_amt = 1.0 - 0.35 * np.clip(miss, 0.0, 1.0)
    return np.clip(w_sup * w_exp * w_amt, 0.25, 1.0)


@dataclass(frozen=True)
class FusionPolicy:
    name: str
    method: str
    v2_anchor: float
    ml_median: float
    ml_scale: float
    v2_calibrator: EmpiricalCalibrator
    ml_calibrator: EmpiricalCalibrator
    joint_calibrator: RankCalibration
    threshold: float
    ordinary_alerts: int
    cutoff_rule: str
    ml_weight: float = 1.0
    persistence_gate: bool = False

    def _ml_norm(self, ml):
        return np.maximum(0.0, (ml - self.ml_median) / self.ml_scale)

    def score(self, v2_scores, ml_scores, features=None):
        v2 = np.asarray(v2_scores, dtype=float)
        ml = np.asarray(ml_scores, dtype=float)
        if self.method == 'ml_only':
            return ml
        if self.method == 'joint_max':
            return np.maximum(v2 / self.v2_anchor, self.ml_weight * self._ml_norm(ml))
        if self.method == 'rank_max':
            r_v2 = self.v2_calibrator.continuous_neglog10_rank(v2)
            r_ml = self.ml_calibrator.continuous_neglog10_rank(ml)
            return np.maximum(r_v2, self.ml_weight * r_ml)
        if self.method == 'rank_fisher':
            r_v2 = self.v2_calibrator.continuous_neglog10_rank(v2)
            r_ml = self.ml_calibrator.continuous_neglog10_rank(ml)
            return r_v2 + self.ml_weight * r_ml
        if self.method == 'complementary_max':
            return np.maximum(v2 / self.v2_anchor, self.ml_weight * self._ml_norm(ml))
        if self.method == 'uncertainty_aware':
            if features is None:
                raise ValueError('Uncertainty-aware fusion requires feature matrix.')
            w = reliability_weight(features)
            return np.maximum(v2 / self.v2_anchor, w * self.ml_weight * self._ml_norm(ml))
        raise ValueError(f'Unknown fusion method {self.method!r}.')


def apply_persistence_lifecycle(index, raw_scores, v2_flags, threshold, *, confirm_days=2, quiet_days=2):
    """Apply lightweight V2-compatible hysteresis on ML-triggered excursions while preserving V2 flags."""
    df = pd.DataFrame({'score': raw_scores, 'v2_flag': v2_flags}, index=index).sort_index()
    alerts = pd.Series(False, index=df.index)
    for _, grp in df.groupby(level='merchant_id', sort=False):
        ordered = grp.sort_index()
        active = False
        streak = 0
        quiet = 0
        prev_day = None
        for key, row in ordered.iterrows():
            day = key[0]
            if prev_day is not None and (day - prev_day).days != 1:
                streak = 0
                quiet = 0
                active = False
            sc = float(row['score'])
            v2_on = bool(row['v2_flag'])
            if v2_on:
                alerts.loc[key] = True
                active = True
                quiet = 0
                streak += 1
            elif sc >= threshold:
                streak += 1
                quiet = 0
                if active or streak >= confirm_days or sc >= 1.35 * threshold:
                    active = True
                    alerts.loc[key] = True
            else:
                streak = 0
                if active:
                    quiet += 1
                    if quiet >= quiet_days:
                        active = False
                        quiet = 0
            prev_day = day
    return alerts.reindex(index)


def fit_fusion_policies(
    cal_v2, cal_ml, cal_feat, bur_v2, bur_ml, bur_feat, v1_cfg, v2_cfg, *, budget_override=None
):
    """Fit and jointly calibrate C1–C5 fusion candidates on ordinary data only."""
    budget = v1_cfg['alerts']['max_ordinary_alerts_per_merchant_week'] if budget_override is None else budget_override
    v2_arr = np.asarray(cal_v2, dtype=float)
    ml_arr = np.asarray(cal_ml, dtype=float)
    bur_ml_arr = np.asarray(bur_ml, dtype=float)

    v2_cal = EmpiricalCalibrator.fit(v2_arr)
    ml_cal = EmpiricalCalibrator.fit(ml_arr)
    v2_anchor = max(1e-6, float(np.quantile(v2_arr, 0.99)))
    ml_med = float(np.median(ml_arr))
    ml_q99 = float(np.quantile(ml_arr, 0.99))
    ml_scale = max(1e-6, ml_q99 - ml_med)

    dep_spearman = float(spearmanr(v2_arr, ml_arr).statistic)
    dep_kendall = float(kendalltau(v2_arr, ml_arr).statistic)

    specs = [
        ('C1_ml_only', 'ml_only', 1.0, False),
        ('C2_joint_max', 'joint_max', 1.0, False),
        ('C3_rank_max', 'rank_max', 1.0, False),
        ('C3_rank_fisher', 'rank_fisher', 1.0, False),
        ('C4_complementary_085', 'complementary_max', 0.85, False),
        ('C4_complementary_managed', 'complementary_max', 0.85, True),
        ('C5_uncertainty_aware', 'uncertainty_aware', 1.0, False),
    ]

    policies = {}
    v2_th = v2_cfg['frozen']['policies'][f"{v2_cfg['primary_bank']}/managed"]['threshold']
    bur_v2_flags = np.asarray(bur_v2, dtype=float) >= v2_th

    for name, method, ml_w, persist in specs:
        proto = FusionPolicy(
            name=name,
            method=method,
            v2_anchor=v2_anchor,
            ml_median=ml_med,
            ml_scale=ml_scale,
            v2_calibrator=v2_cal,
            ml_calibrator=ml_cal,
            joint_calibrator=RankCalibration.fit([0.0]),
            threshold=inf,
            ordinary_alerts=0,
            cutoff_rule='unselected',
            ml_weight=ml_w,
            persistence_gate=persist,
        )
        c_scores = proto.score(v2_arr, ml_arr, cal_feat)
        b_scores = proto.score(bur_v2, bur_ml_arr, bur_feat)
        joint_rank = RankCalibration.fit(c_scores)

        options = []
        for alpha in v2_cfg['candidate_tail_ranks']:
            th = calibrated_threshold(joint_rank, alpha)
            if th is not None:
                options.append((float(th), f'rank {alpha:g}'))
        top = joint_rank.scores[-1]
        span = max(1e-9, top - float(np.median(joint_rank.scores)))
        for factor in v2_cfg['above_max_multipliers']:
            options.append((nextafter(top + (factor - 1) * span, inf), f'upper span x {factor:g}'))

        chosen_th, chosen_alerts, chosen_rule = inf, 0, 'disabled'
        for val, rule in sorted(options, key=lambda item: item[0]):
            if persist:
                flags = apply_persistence_lifecycle(bur_feat.index, b_scores, bur_v2_flags, val)
                alerts = int(flags.sum())
            else:
                alerts = int(np.count_nonzero(b_scores >= val))
            if 7.0 * alerts / len(b_scores) <= budget:
                chosen_th, chosen_alerts, chosen_rule = float(val), alerts, rule
                break

        policies[name] = FusionPolicy(
            name=name,
            method=method,
            v2_anchor=v2_anchor,
            ml_median=ml_med,
            ml_scale=ml_scale,
            v2_calibrator=v2_cal,
            ml_calibrator=ml_cal,
            joint_calibrator=joint_rank,
            threshold=chosen_th,
            ordinary_alerts=chosen_alerts,
            cutoff_rule=chosen_rule,
            ml_weight=ml_w,
            persistence_gate=persist,
        )

    diagnostics = {
        'spearman_v2_ml_cal': dep_spearman,
        'kendall_v2_ml_cal': dep_kendall,
        'v2_anchor_q99': v2_anchor,
        'ml_median': ml_med,
        'ml_scale_q99_minus_med': ml_scale,
    }
    return policies, diagnostics
