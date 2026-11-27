"""Small robust and Isolation Forest challengers using the same causal feature vectors."""

import numpy as np
import pandas as pd
from scipy.stats import median_abs_deviation
from sklearn.ensemble import IsolationForest

FEATURES = ('transaction_count', 'amount_median', 'declined_count', 'cancelled_count')


def _features(days, weekday):
    n = days.transaction_count
    multiplier = days.date.dt.weekday.map(weekday).fillna(1.)
    frame = pd.DataFrame({'transaction_count': np.log1p(n / multiplier),
                          'amount_median': np.log1p(days.amount_median)}, index=days.index)
    for status in FEATURES[2:]:
        frame[status] = np.arcsin(np.sqrt((days[status] + .375) / (n + .75))).where(n.gt(0))
    return frame


def residual_features(history, current, reference, config):
    """Prior-only merchant medians and MADs, with an ordinary pooled fallback."""
    past = _features(history, reference.weekday)
    now = _features(current, reference.weekday)
    merchant = history.merchant_id
    peer_center = past.median().fillna(0.)
    own_center = past.groupby(merchant).median()
    own_counts = past.groupby(merchant).count()
    centered = past.subtract(own_center.reindex(merchant).set_axis(past.index))
    robust_scale = lambda values: median_abs_deviation(values, scale='normal', nan_policy='omit')
    own_scale = past.groupby(merchant).agg(robust_scale)
    peer_scale = centered.apply(robust_scale)
    limits = config['baselines']
    floors = pd.Series(limits['robust_mad_floors'], index=FEATURES)
    local = own_counts.reindex(current.merchant_id).set_axis(current.index).ge(limits['robust_local_min_days'])
    center = own_center.reindex(current.merchant_id).set_axis(current.index).where(local).fillna(peer_center)
    scale = own_scale.reindex(current.merchant_id).set_axis(current.index).where(local).fillna(peer_scale)
    scale = scale.where(scale.gt(0)).fillna(peer_scale).fillna(floors).clip(lower=floors, axis=1)
    # Unobserved signals contribute a neutral residual, including outcomes at zero exposure.
    return ((now - center) / scale).fillna(0.)


def fit_isolation_forest(prior_features, config):
    return IsolationForest(n_estimators=config['baselines']['isolation_forest_trees'],
                           random_state=config['seed'], n_jobs=1).fit(prior_features)


def baseline_scores(features, isolation_forest):
    robust = np.column_stack((features.iloc[:, :2].abs(), features.iloc[:, 2:].clip(lower=0)))
    return robust.max(axis=1), -isolation_forest.score_samples(features)

