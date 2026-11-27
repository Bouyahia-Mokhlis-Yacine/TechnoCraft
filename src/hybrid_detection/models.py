"""Conventional ML challengers, covariance conditioning diagnostics, and lightweight autoencoder."""

from dataclasses import dataclass
from math import inf, nextafter
from pickle import dumps
from time import perf_counter

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, clone
from sklearn.covariance import EllipticEnvelope, LedoitWolf
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.neighbors import LocalOutlierFactor
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import RobustScaler, StandardScaler
from sklearn.svm import OneClassSVM

from src.detection.calibration import RankCalibration
from src.detection.sequential import calibrated_threshold


class ReconstructionScorer(BaseEstimator):
    """Batch reconstruction MSE scorer, optionally combining retained-space Mahalanobis distance."""

    def __init__(self, estimator, *, neural=False, combine_mahalanobis=False):
        self.estimator = estimator
        self.neural = neural
        self.combine_mahalanobis = combine_mahalanobis

    def fit(self, x, y=None):
        if self.neural:
            self.estimator.fit(x, x)
        else:
            self.estimator.fit(x)
            if self.combine_mahalanobis:
                z = self.estimator.transform(x)
                var = np.maximum(self.estimator.explained_variance_, 1e-6)
                t2 = np.sum((z ** 2) / var, axis=1)
                recon = np.mean((x - self.estimator.inverse_transform(z)) ** 2, axis=1)
                self._t2_scale = max(float(np.median(t2)), 1e-6)
                self._q_scale = max(float(np.median(recon)), 1e-6)
        return self

    def predict(self, x):
        if self.neural:
            decoded = self.estimator.predict(x)
            return np.mean(np.square(x - decoded), axis=1)
        z = self.estimator.transform(x)
        decoded = self.estimator.inverse_transform(z)
        recon = np.mean(np.square(x - decoded), axis=1)
        if not self.combine_mahalanobis:
            return recon
        var = np.maximum(self.estimator.explained_variance_, 1e-6)
        t2 = np.sum((z ** 2) / var, axis=1)
        return 0.5 * (recon / self._q_scale) + 0.5 * (t2 / self._t2_scale)


class MahalanobisShrinkageScorer(BaseEstimator):
    """Ledoit-Wolf regularized Mahalanobis distance diagnostic for high-dimensional residuals."""

    def fit(self, x, y=None):
        self.lw_ = LedoitWolf().fit(x)
        return self

    def score_samples(self, x):
        # Return negative squared Mahalanobis distance so higher = more normal (sklearn convention).
        return -self.lw_.mahalanobis(x)


def predefined_grids():
    """Compact, predefined hyperparameter grids selected strictly on ordinary data."""
    return {
        'One-Class SVM': [
            {'scaler': 'standard', 'nu': 0.01, 'gamma': 'scale'},
            {'scaler': 'standard', 'nu': 0.03, 'gamma': 'scale'},
            {'scaler': 'standard', 'nu': 0.05, 'gamma': 'scale'},
            {'scaler': 'standard', 'nu': 0.03, 'gamma': 0.05},
            {'scaler': 'standard', 'nu': 0.03, 'gamma': 0.01},
            {'scaler': 'robust', 'nu': 0.03, 'gamma': 'scale'},
        ],
        'Local Outlier Factor': [
            {'scaler': 'standard', 'n_neighbors': 10, 'metric': 'minkowski'},
            {'scaler': 'standard', 'n_neighbors': 20, 'metric': 'minkowski'},
            {'scaler': 'standard', 'n_neighbors': 35, 'metric': 'minkowski'},
            {'scaler': 'robust', 'n_neighbors': 20, 'metric': 'minkowski'},
        ],
        'Isolation Forest': [
            {'scaler': 'standard', 'n_estimators': 128, 'max_samples': 'auto', 'max_features': 1.0},
            {'scaler': 'standard', 'n_estimators': 256, 'max_samples': 'auto', 'max_features': 1.0},
            {'scaler': 'standard', 'n_estimators': 256, 'max_samples': 128, 'max_features': 0.7},
        ],
        'Elliptic Envelope': [
            {'scaler': 'standard', 'pca_var': 0.80, 'support_fraction': 0.85},
            {'scaler': 'standard', 'pca_var': 0.90, 'support_fraction': 0.85},
            {'scaler': 'standard', 'pca_var': 0.80, 'support_fraction': 0.95},
        ],
        'PCA reconstruction': [
            {'scaler': 'standard', 'n_components': 0.75, 'combine_mahalanobis': False},
            {'scaler': 'standard', 'n_components': 0.85, 'combine_mahalanobis': False},
            {'scaler': 'standard', 'n_components': 0.85, 'combine_mahalanobis': True},
        ],
        'Autoencoder': [
            {'scaler': 'standard', 'width': 4, 'alpha': 0.05},
            {'scaler': 'standard', 'width': 6, 'alpha': 0.05},
        ],
    }


def _make_pipeline_and_model(family, params, seed):
    scaler_cls = RobustScaler if params.get('scaler', 'standard') == 'robust' else StandardScaler
    steps = [
        ('impute', SimpleImputer(strategy='median', keep_empty_features=True)),
        ('scale', scaler_cls()),
    ]
    if family == 'One-Class SVM':
        model = OneClassSVM(kernel='rbf', nu=params['nu'], gamma=params['gamma'])
    elif family == 'Local Outlier Factor':
        model = LocalOutlierFactor(n_neighbors=params['n_neighbors'], metric=params['metric'], novelty=True, n_jobs=1)
    elif family == 'Isolation Forest':
        model = IsolationForest(
            n_estimators=params['n_estimators'],
            max_samples=params['max_samples'],
            max_features=params['max_features'],
            random_state=seed,
            n_jobs=1,
        )
    elif family == 'Elliptic Envelope':
        steps.append(('pca', PCA(n_components=params['pca_var'], svd_solver='full')))
        model = EllipticEnvelope(support_fraction=params['support_fraction'], random_state=seed)
    elif family == 'PCA reconstruction':
        model = ReconstructionScorer(
            PCA(n_components=params['n_components'], svd_solver='full'),
            neural=False,
            combine_mahalanobis=params['combine_mahalanobis'],
        )
    elif family == 'Autoencoder':
        w = params['width']
        model = ReconstructionScorer(
            MLPRegressor(
                hidden_layer_sizes=(16, w, 16),
                activation='tanh',
                solver='adam',
                alpha=params['alpha'],
                learning_rate_init=0.005,
                max_iter=1,
                random_state=seed,
            ),
            neural=True,
        )
    elif family == 'Shrinkage Mahalanobis':
        model = MahalanobisShrinkageScorer()
    else:
        raise ValueError(f'Unknown model family {family!r}.')
    return Pipeline(steps), model


@dataclass
class FittedML:
    family: str
    params: dict
    preprocessing: Pipeline
    model: object
    fit_ms: float
    kib: float
    feature_names: tuple

    def score(self, frame):
        x = self.preprocessing.transform(frame[list(self.feature_names)])
        # Clip extreme scaled outliers only for numerical safety in RBF/linear algebra.
        x = np.clip(x, -50.0, 50.0) if self.params.get('scaler') == 'robust' else x
        if isinstance(self.model, ReconstructionScorer):
            raw = self.model.predict(x)
        else:
            raw = -self.model.score_samples(x)
        return np.asarray(raw, dtype=float)


def fit_ml_model(family, features, params, seed=710):
    if not all(pd.api.types.is_numeric_dtype(dt) for dt in features.dtypes):
        raise ValueError('ML models accept numeric features only.')
    t0 = perf_counter()
    preprocessing, model = _make_pipeline_and_model(family, params, seed)

    if family == 'Autoencoder':
        dates = features.index.get_level_values('date')
        uniq = dates.unique().sort_values()
        if len(uniq) >= 4:
            val_mask = dates.isin(uniq[-2:])
            inner = clone(preprocessing)
            x_tr = inner.fit_transform(features.loc[~val_mask])
            x_va = inner.transform(features.loc[val_mask])
            trial = clone(model.estimator)
            best, best_ep = inf, 1
            for ep in range(1, 301):
                trial.partial_fit(x_tr, x_tr)
                loss = float(np.mean(np.square(x_va - trial.predict(x_va))))
                if loss < best - 1e-4:
                    best, best_ep = loss, ep
                if ep - best_ep >= 20:
                    break
        else:
            best_ep = 50
        x = preprocessing.fit_transform(features)
        for _ in range(best_ep):
            model.estimator.partial_fit(x, x)
        model.fit(x) if False else None
    else:
        x = preprocessing.fit_transform(features)
        if params.get('scaler') == 'robust':
            x = np.clip(x, -50.0, 50.0)
        model.fit(x)

    fit_ms = 1000.0 * (perf_counter() - t0)
    kib = len(dumps((preprocessing, model))) / 1024.0
    return FittedML(family, dict(params), preprocessing, model, fit_ms, kib, tuple(features.columns))


def covariance_conditioning(features, pca_vars=(0.80, 0.90)):
    """Diagnose covariance conditioning of raw vs PCA-reduced ordinary fit features."""
    x = StandardScaler().fit_transform(SimpleImputer(strategy='median').fit_transform(features))
    cov_raw = np.cov(x, rowvar=False)
    eig_raw = np.linalg.eigvalsh(cov_raw)
    pos_eig = eig_raw[eig_raw > 1e-12]
    cond_raw = float(eig_raw.max() / pos_eig.min()) if len(pos_eig) else inf
    rank_raw = int(np.sum(eig_raw > 1e-8))
    lw = LedoitWolf().fit(x)
    eig_lw = np.linalg.eigvalsh(lw.covariance_)
    out = {
        'n': int(x.shape[0]),
        'p': int(x.shape[1]),
        'n_over_p': float(x.shape[0] / max(1, x.shape[1])),
        'raw_rank': rank_raw,
        'raw_cond': cond_raw,
        'lw_cond': float(eig_lw.max() / max(eig_lw.min(), 1e-12)),
    }
    for var in pca_vars:
        pca = PCA(n_components=var, svd_solver='full').fit(x)
        z = pca.transform(x)
        cov_z = np.cov(z, rowvar=False)
        eig_z = np.linalg.eigvalsh(cov_z) if z.shape[1] > 1 else np.array([float(cov_z)])
        out[f'pca_{int(var*100)}_k'] = int(z.shape[1])
        out[f'pca_{int(var*100)}_cond'] = float(eig_z.max() / max(eig_z.min(), 1e-12))
    return out


@dataclass(frozen=True)
class WorkloadCutoff:
    value: float
    ordinary_alerts: int
    rule: str


def select_workload_cutoff(cal_scores, burden_scores, v1_cfg, v2_cfg):
    """Select threshold on ordinary calibration + burden under the 0.07/week budget."""
    rank = RankCalibration.fit(cal_scores)
    budget = v1_cfg['alerts']['max_ordinary_alerts_per_merchant_week']
    options = []
    for alpha in v2_cfg['candidate_tail_ranks']:
        th = calibrated_threshold(rank, alpha)
        if th is not None:
            options.append((th, f'rank {alpha:g}'))
    top = rank.scores[-1]
    span = max(1e-9, top - float(np.median(rank.scores)))
    fallback = [(nextafter(top + (factor - 1) * span, inf), f'upper span x {factor:g}')
                for factor in v2_cfg['above_max_multipliers']]
    for val, rule in sorted(options) + fallback:
        alerts = int(np.count_nonzero(np.asarray(burden_scores) >= val))
        if 7.0 * alerts / len(burden_scores) <= budget:
            return WorkloadCutoff(float(val), alerts, rule)
    return WorkloadCutoff(inf, 0, 'disabled')


def matched_workload_cutoff(burden_scores, target_alerts):
    """Find cutoff yielding <= target_alerts on the ordinary burden set for matched-burden comparison."""
    s = np.sort(np.asarray(burden_scores, dtype=float))
    if target_alerts <= 0:
        return nextafter(float(s[-1]), inf)
    if target_alerts >= len(s):
        return -inf
    return float(s[-target_alerts])
