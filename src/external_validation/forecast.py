"""Prior-only calendar count laws and observation-scale forecast diagnostics."""

import numpy as np
from scipy import stats
from sklearn.linear_model import PoissonRegressor

from .common import forecast_metrics, sample_crps


def count_reference(x_train, counts, x_test):
    counts = np.asarray(counts)
    # Normalize solver tolerance via an exposure offset while retaining the raw count scale.
    level = max(counts.mean(), 1e-6)
    model = PoissonRegressor(alpha=.001, max_iter=300, tol=1e-8).fit(x_train, counts / level)
    mean_fit = np.maximum(1e-6, model.predict(x_train) * level)
    mean = np.maximum(1e-6, model.predict(x_test) * level)
    dispersion = np.mean((counts - mean_fit)**2 / mean_fit)
    alpha = max(1e-10, np.sum((counts - mean_fit)**2 - mean_fit) / np.sum(mean_fit**2))
    return mean_fit, mean, dispersion, alpha


def nb_law(mean, alpha):
    return stats.nbinom(1 / alpha, 1 / (1 + alpha * mean))


def discrete_diagnostics(law, observed, u, rng, draws=512):
    observed = np.asarray(observed, dtype=int)
    pit = law.cdf(observed - 1) + u * law.pmf(observed)
    samples = law.rvs(size=(draws, len(observed)), random_state=rng).T
    lo, hi = law.ppf(.05), law.ppf(.95)
    return forecast_metrics(observed, law.mean(), law.logpmf(observed), lo, hi, pit,
                            sample_crps(samples, observed))


def discrete_score(law, observed):
    observed = np.asarray(observed)
    logp = np.log(2) + np.minimum(law.logcdf(observed), law.logsf(observed - 1))
    return -np.maximum(np.log(np.nextafter(0., 1.)), np.minimum(0., logp)) / np.log(10)
