"""Evaluation primitives for external datasets, independent of SATIM serving."""

from time import process_time

import numpy as np
from scipy import stats
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.neighbors import LocalOutlierFactor
from sklearn.preprocessing import RobustScaler
from sklearn.svm import OneClassSVM

from src.detection.calibration import RankCalibration
from src.detection.sequential import calibrated_threshold

SEED = 2711


def cutoff(scores, budget):
    threshold = calibrated_threshold(RankCalibration.fit(scores), budget)
    return float('inf') if threshold is None else threshold


def runs(mask, contiguous):
    """Return inclusive starts and exclusive ends, splitting at missing slots."""
    mask = np.asarray(mask, dtype=bool)
    contiguous = np.asarray(contiguous, dtype=bool)
    if not len(mask):
        return np.empty((0, 2), dtype=int)
    starts = np.flatnonzero(mask & ~(np.r_[False, mask[:-1]] & contiguous))
    ends = np.flatnonzero(mask & ~(np.r_[mask[1:], False] & np.r_[contiguous[1:], False])) + 1
    return np.column_stack((starts, ends))


def episode_matches(truth, predicted):
    """Match ordered disjoint runs one to one using first causal overlap."""
    ti = ai = 0
    matches = []
    while ti < len(truth) and ai < len(predicted):
        ts, te = truth[ti]
        ps, pe = predicted[ai]
        if pe <= ts:
            ai += 1
        elif te <= ps:
            ti += 1
        else:
            matches.append((ti, ai, max(ts, ps)))
            ai += 1
            ti += 1
    duplicates = 0
    if len(truth) and len(predicted):
        first_overlap = np.searchsorted(truth[:, 1], predicted[:, 0], side='right')
        overlaps = (first_overlap < len(truth)) & (
            truth[np.minimum(first_overlap, len(truth) - 1), 0] < predicted[:, 1])
        duplicates = int(overlaps.sum() - len(matches))
    return matches, duplicates


def directional_cusum(increments, contiguous, persistence):
    """Page recursion via reflected cumulative sums, restarting after gaps."""
    increments = np.asarray(increments, float)
    contiguous = np.asarray(contiguous, dtype=bool)
    if not len(contiguous):
        return np.empty(0), np.empty(0)
    breaks = np.r_[0, np.flatnonzero(~contiguous[1:]) + 1, len(contiguous)]
    raw = np.zeros(len(contiguous))
    confirmed = raw.copy()
    for left, right in zip(breaks[:-1], breaks[1:]):
        values = increments[left:right]
        cumulative = np.cumsum(values, axis=0)
        reflected = cumulative - np.minimum.accumulate(np.minimum(cumulative, 0), axis=0)
        raw[left:right] = reflected.max(axis=1)
        eligible = values > 0
        for lag in range(1, persistence):
            eligible[lag:] &= values[:-lag] > 0
        eligible[:persistence - 1] = False
        confirmed[left:right] = np.where(eligible, reflected, 0).max(axis=1)
    return raw, confirmed


def incident_dispatch(flags, quiet, contiguous, recovery):
    """Emit one notification on activation and rearm after consecutive quiet slots."""
    notifications = np.zeros(len(flags), dtype=bool)
    boundaries = np.r_[0, np.flatnonzero(~contiguous[1:]) + 1, len(flags)]
    for left, right in zip(boundaries[:-1], boundaries[1:]):
        local = quiet[left:right]
        quiet_runs = runs(local, np.r_[False, np.ones(len(local) - 1, dtype=bool)])
        ends = quiet_runs[:, 0] + recovery
        ready = ends[ends <= quiet_runs[:, 1]]
        candidates = np.flatnonzero(flags[left:right])
        if len(candidates):
            epochs = np.searchsorted(ready, candidates, side='right')
            notifications[left + candidates[np.r_[True, np.diff(epochs) > 0]]] = True
    return notifications


def conventional(fit, score, *, pca=False):
    """Same features for all challengers, with bounded chronological fit samples."""
    fit = fit[np.linspace(0, len(fit) - 1, min(2048, len(fit)), dtype=int)]
    scaler = RobustScaler().fit(fit)
    fit = np.clip(scaler.transform(fit), -1000, 1000)
    score = np.clip(scaler.transform(score), -1000, 1000)
    models = {
        'Isolation Forest': IsolationForest(n_estimators=64, max_samples=256, random_state=SEED),
        'LOF': LocalOutlierFactor(n_neighbors=min(20, len(fit) - 1), novelty=True),
        'One-Class SVM': OneClassSVM(nu=.02),
    }
    outputs = {}
    cpu = {}
    for name, model in models.items():
        started = process_time()
        model.fit(fit)
        outputs[name] = -model.score_samples(score)
        cpu[name] = process_time() - started
    if pca:
        started = process_time()
        model = PCA(n_components=1).fit(fit)
        outputs['PCA'] = np.mean((score - model.inverse_transform(model.transform(score)))**2, axis=1)
        cpu['PCA'] = process_time() - started
    return outputs, cpu


def sample_crps(samples, observed):
    """Empirical CRPS in O(n log n), computed along the final axis."""
    samples = np.sort(samples, axis=-1)
    n = samples.shape[-1]
    weights = (2 * np.arange(n) + 1 - n) / n**2
    return np.abs(samples - np.asarray(observed)[..., None]).mean(axis=-1) - samples @ weights


def forecast_metrics(y, point, log_density, lo, hi, pit, crps):
    y, point, pit = map(np.asarray, (y, point, pit))
    return {
        'NLL': -np.mean(log_density), 'MAE': np.mean(np.abs(y - point)),
        'RMSE': np.sqrt(np.mean((y - point)**2)), 'CRPS': np.mean(crps),
        'coverage90': np.mean((y >= lo) & (y <= hi)),
        'PIT_D': stats.kstest(pit, 'uniform').statistic,
        'PIT_lower_1pct': np.mean(pit < .01), 'PIT_upper_1pct': np.mean(pit > .99),
    }


def paired_block_interval(delta, width, draws=1000):
    delta = np.asarray(delta)
    if len(delta) < 3 * width:
        return [np.nan, np.nan]
    rng = np.random.default_rng(SEED)
    starts = rng.integers(0, len(delta) - width + 1, (draws, int(np.ceil(len(delta) / width))))
    indices = (starts[..., None] + np.arange(width)).reshape(draws, -1)[:, :len(delta)]
    return np.quantile(delta[indices].mean(axis=1), [.025, .975]).tolist()
