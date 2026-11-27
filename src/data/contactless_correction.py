"""Frozen, label-free amount correction on retained, card-free transactions."""

from dataclasses import asdict, dataclass
from hashlib import sha256
import json

import numpy as np
import pandas as pd
from scipy import optimize, special, stats

from .aggregation import merchant_days
from .mentor_rules import DEFAULT_LIMIT_DZD, prepare_candidate

VERSION = 'satim-contactless-correction-v1'
LAWS = ('lognormal', 'gamma', 'logstudent', 'weibull')
METHODS = ('clip', 'scale_max', 'scale_q99', 'rational', 'exponential', *LAWS, 'empirical')


def fit_law(name, amounts):
    if name == 'logstudent':
        return tuple(map(float, stats.t.fit(np.log(amounts))))
    distribution = {'lognormal': stats.lognorm, 'gamma': stats.gamma, 'weibull': stats.weibull_min}[name]
    return tuple(map(float, distribution.fit(amounts, floc=0)))


def law(name, params):
    return {'lognormal': stats.lognorm, 'gamma': stats.gamma,
            'weibull': stats.weibull_min, 'logstudent': stats.t}[name](*params)


def _smooth(name, x, c, limit):
    if name == 'rational':
        # This form avoids overflow of x+c when a future amount approaches float64 max.
        with np.errstate(over='ignore'):
            return limit / (1 + c / x)
    with np.errstate(over='ignore'):
        return -limit * np.expm1(-x / c)


@dataclass(frozen=True)
class AmountMapping:
    method: str
    limit: float
    fitted_before: str
    first_date: str
    last_date: str
    observations: int
    eligible_sha256: str
    parameters: tuple

    def to_dict(self):
        return dict(version=VERSION, **asdict(self))

    @classmethod
    def from_dict(cls, saved):
        fields = dict(saved)
        if fields.pop('version') != VERSION or fields['method'] not in METHODS:
            raise ValueError('Unrecognized contactless mapping.')
        if fields['method'] == 'empirical':
            fields['parameters'] = tuple(tuple(knot) for knot in fields['parameters'])
        else:
            fields['parameters'] = tuple(fields['parameters'])
        mapping = cls(**fields)
        if mapping.limit != DEFAULT_LIMIT_DZD or not mapping.first_date <= mapping.last_date < mapping.fitted_before:
            raise ValueError('Invalid limit or fitting chronology.')
        return mapping

    def transform_positive(self, amounts):
        x = np.asarray(amounts, dtype=float)
        if not np.all(np.isfinite(x) & (x > 0)):
            raise ValueError('Expected positive finite amounts.')
        limit = self.limit
        method = self.method
        if method == 'clip':
            mapped = np.minimum(x, limit)
        elif method in ('scale_max', 'scale_q99'):
            reference, = self.parameters
            mapped = limit * (np.minimum(x, reference) / reference)
        elif method in ('rational', 'exponential'):
            mapped = _smooth(method, x, self.parameters[0], limit)
        elif method == 'empirical':
            knots, positions, target_knots, target_positions = self.parameters
            x = np.log1p(x)
            p = np.interp(x, knots, positions)
            # Continue the source survival function above the last knot. Ties share a midrank.
            p = np.where(x > knots[-1], 1 - (1 - positions[-1]) * np.exp(-np.maximum(0., x - knots[-1])), p)
            mapped = np.interp(p, target_positions, target_knots)
        else:
            fitted = law(method, self.parameters)
            source = np.log(x) if method == 'logstudent' else x
            bound = np.log(limit) if method == 'logstudent' else limit
            # Use the complementary formula when the lower-tail probability is near one.
            p = np.exp(fitted.logcdf(source) + fitted.logcdf(bound))
            survival = fitted.sf(bound) + fitted.cdf(bound) * fitted.sf(source)
            native = np.where(p < .5, fitted.ppf(p), fitted.isf(survival))
            mapped = np.exp(native) if method == 'logstudent' else native
        if not np.isfinite(mapped).all():
            # A distribution CDF can underflow at subnormal positive magnitudes.
            if not np.all(np.isfinite(mapped) | np.isneginf(mapped)):
                raise FloatingPointError('Nonfinite contactless mapping result.')
        return np.clip(mapped, np.nextafter(0., 1.), limit)


def _midranks(x):
    knots, counts = np.unique(x, return_counts=True)
    positions = (counts.cumsum() - counts / 2) / len(x)
    return knots, positions


def fit_mapping(events, cutoff, method):
    """Fit from positive retained NFC observations strictly before the supplied date.

    The caller supplies eligible training events. No label columns are accessed.
    The training-fit digest uses source row, date and sign-corrected amount only.
    """
    if method not in METHODS:
        raise ValueError(f'Unknown mapping {method!r}.')
    cutoff = pd.Timestamp(cutoff).normalize()
    eligible = events.loc[events.date.lt(cutoff) & events.channel.eq('nfc') & events.amount.gt(0)
                          & np.isfinite(events.amount), ['source_row', 'date', 'amount']].sort_values('source_row')
    x = eligible.amount.to_numpy(dtype=float)
    limit = float(DEFAULT_LIMIT_DZD)
    if len(x) < 8 or np.unique(x).size < 3:
        raise ValueError('At least eight positive training observations and three distinct values are required.')
    compliant = x[x <= limit]
    params = ()
    if method.startswith('scale_'):
        params = (float(x.max() if method == 'scale_max' else np.quantile(x, .99)),)
    elif method in ('rational', 'exponential'):
        if not len(compliant):
            raise ValueError('Smooth calibration requires prior compliant amounts.')
        quantiles = np.quantile(x, [.10, .25, .5, .75, .90, .95])
        shape = np.log(quantiles[:-1] / quantiles[2])
        # Give the five central log quantile ratios and scale anchor equal group weight.
        anchor = float(np.quantile(compliant, .90))

        def loss(log_c):
            q = _smooth(method, quantiles, np.exp(log_c), limit)
            return np.mean((np.log(q[:-1] / q[2]) - shape)**2) + np.log(q[-1] / anchor)**2

        result = optimize.minimize_scalar(loss, bounds=(np.log(quantiles[2]) - 12, np.log(quantiles[2]) + 12),
                                          method='bounded', options={'xatol': 1e-10})
        if not result.success:
            raise ValueError('Smooth calibration failed.')
        params = (float(np.exp(result.x)),)
    elif method == 'empirical':
        source, positions = _midranks(np.log1p(x))
        target, target_positions = _midranks(compliant[compliant < limit])
        if len(target) < 3:
            raise ValueError('Empirical target requires at least three distinct interior values.')
        params = tuple(tuple(v.tolist()) for v in (np.r_[0., source], np.r_[0., positions],
                                                   np.r_[0., target, limit], np.r_[0., target_positions, 1.]))
    elif method in LAWS:
        params = fit_law(method, x)
    digest = sha256(eligible.to_csv(index=False, float_format='%.17g', lineterminator='\n').encode()).hexdigest()
    return AmountMapping(method, limit, cutoff.date().isoformat(), str(eligible.date.min().date()),
                         str(eligible.date.max().date()), len(x), digest, params)


def corrected_events(events, mapping):
    """Map sign-corrected retained rows, keeping source-rule evidence in the separate audit."""
    result = events.copy()
    source = pd.to_numeric(result.original_amount, errors='coerce').abs()
    applicable = result.channel.eq('nfc') & source.gt(0) & np.isfinite(source)
    result.loc[applicable, 'amount'] = mapping.transform_positive(source.loc[applicable])
    # Candidate serving consumes corrected amounts. Domain rules on source values are audit-only.
    result.loc[result.is_contactless_violation.fillna(False), 'rule_assessment'] = 'within_limit'
    result['is_contactless_violation'] = result.is_contactless_violation.mask(applicable, False)
    result['contactless_excess_dzd'] = result.contactless_excess_dzd.mask(applicable)
    result['domain_reason'] = result.domain_reason.mask(applicable)
    return result


def prepare_corrected(raw, roster, mapping, *, reference_categories=None):
    """Prepare a subsequent batch using an already frozen prior-only mapping."""
    _, events, quality = prepare_candidate(raw, roster, reference_categories=reference_categories)
    if not events.empty and events.date.min() < pd.Timestamp(mapping.fitted_before):
        raise ValueError('Incoming events precede the frozen mapping epoch.')
    events = corrected_events(events, mapping)
    categories = pd.Series(dtype='string') if reference_categories is None else reference_categories
    return merchant_days(events, roster, categories), events, quality


def load_frozen_candidate(root):
    config = json.loads((root / 'config/contactless_correction.v1.json').read_text(encoding='utf-8'))
    if config['version'] != VERSION or config['official_test_authorized'] is not False:
        raise ValueError('Expected the research-only contactless policy.')
    artifact = root / config['frozen_candidate']
    saved = json.loads(artifact.read_text(encoding='utf-8'))
    mapping = AmountMapping.from_dict(saved['mapping'])
    if (mapping.method != config['selected_method'] or mapping.fitted_before != config['fit_cutoff']
            or mapping.limit != config['limit_dzd'] or config['threshold_policy'] != 'prior_only_workload'):
        raise ValueError('Frozen contactless configuration and mapping disagree.')
    return mapping, saved['detector']
