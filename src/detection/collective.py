"""Subset scans and advisory attribution for shared operational symptoms."""

from dataclasses import dataclass

import numpy as np
from scipy.special import xlogy
from scipy.stats import poisson


def poisson_scan(observed, expected, direction):
    """Exact directional Poisson scan with at least two members.

    Above size two, an optimum can include every positive contribution and
    omit nonpositive contributions at its fitted ratio. These sets are ratio
    prefixes. If the size constraint binds, the best pair need not be a prefix.
    """
    if direction not in {'drop', 'surge'}:
        raise ValueError('Expected drop or surge.')
    if len(observed) < 2:
        return (), 0., 1.
    sign = -1 if direction == 'surge' else 1
    order = np.argsort(sign * observed / expected, kind='stable')
    left, right = np.triu_indices(len(order), k=1)
    y = np.r_[np.cumsum(observed[order])[1:], observed[left] + observed[right]]
    e = np.r_[np.cumsum(expected[order])[1:], expected[left] + expected[right]]
    ratio = y / e
    valid = sign * (ratio - 1) < 0
    evidence = np.where(valid, xlogy(y, ratio) - y + e, 0.)
    best = int(np.argmax(evidence))
    if evidence[best] <= 0:
        return (), 0., 1.
    if best < len(order) - 1:
        members = order[:best + 2]
    else:
        pair = best - len(order) + 1
        members = (left[pair], right[pair])
    return tuple(sorted(members)), float(evidence[best]), float(ratio[best])


def rejection_scan(rejections, exposure, probability, odds_ratios):
    """Exact over the specified odds grid with merchant-specific null probabilities.

    At each fixed odds ratio the likelihood contributions are additive, so the
    best size-k subset is the k highest contributions. Search every valid prefix.
    """
    if len(rejections) < 2:
        return (), 0., 1.
    best = (), 0., 1.
    for odds in odds_ratios:
        contributions = rejections * np.log(odds) - exposure * np.log1p((odds - 1) * probability)
        order = np.argsort(-contributions, kind='stable')
        totals = contributions[order].cumsum()[1:]
        index = int(np.argmax(totals))
        if totals[index] > best[1]:
            best = tuple(sorted(order[:index + 2])), float(totals[index]), float(odds)
    return best


@dataclass(frozen=True)
class LocalEvidence:
    merchant_id: str
    observed: int
    expected: float
    exposure: int
    history_exposure: int
    reference_source: str
    tail: float


@dataclass(frozen=True)
class Scan:
    channel: str
    category: str | None
    symptom: str
    log_likelihood_ratio: float
    fitted_ratio: float
    observed: int
    expected: float
    exposure: int
    activity_shortfall: float | None
    excess_declines: float | None
    members: tuple[LocalEvidence, ...]


@dataclass(frozen=True)
class NetworkDay:
    date: object
    reference_version: str
    scans: tuple[Scan, ...]

    @property
    def maximum(self):
        return max((scan.log_likelihood_ratio for scan in self.scans), default=0.)


def scan_day(scored, *, established_days, minimum_exposure, odds_ratios):
    if scored is None:
        return None
    if not odds_ratios or any(not np.isfinite(value) or value <= 1 for value in odds_ratios):
        raise ValueError('Rejection scan requires finite odds ratios above one.')
    results = []
    known = scored.evidence.loc[scored.evidence.channel.ne('unknown')]
    for channel, rows in known.groupby('channel', sort=True):
        rows = rows.sort_values('merchant_id')
        cohorts = [(None, rows), *rows.groupby('category', sort=True, dropna=True)]
        for category, group in cohorts:
            mature = group.loc[group.history_days.ge(established_days) & group.expected_activity.gt(0)]
            observed, expected = mature.exposure.to_numpy(), mature.expected_activity.to_numpy()
            for direction in ('drop', 'surge'):
                indices, score, ratio = poisson_scan(observed, expected, direction)
                if indices:
                    selected = mature.iloc[list(indices)]
                    tails = (poisson.cdf(selected.exposure, selected.expected_activity) if direction == 'drop'
                             else poisson.sf(selected.exposure - 1, selected.expected_activity))
                    results.append(_scan(channel, category, f'activity_{direction}', score, ratio, selected,
                                         'exposure', 'expected_activity', tails))
            exposed = group.loc[group.exposure.ge(minimum_exposure)]
            indices, score, ratio = rejection_scan(exposed.declines.to_numpy(), exposed.exposure.to_numpy(),
                                                   exposed.declines_probability.to_numpy(), odds_ratios)
            if indices:
                selected = exposed.iloc[list(indices)]
                results.append(_scan(channel, category, 'rejection_increase', score, ratio, selected,
                                     'declines', 'declines_expected', 10. ** -selected.declines_score))
    return NetworkDay(scored.date, scored.reference_version, tuple(results))


def _scan(channel, category, symptom, score, ratio, selected, observed, expected, tails):
    members = tuple(LocalEvidence(row.merchant_id, int(getattr(row, observed)), float(getattr(row, expected)),
                                  int(row.exposure), int(row.history_exposure),
                                  row.rate_reference if symptom == 'rejection_increase' else 'weekday_merchant_channel',
                                  float(tail))
                    for row, tail in zip(selected.itertuples(index=False), tails))
    y, e = sum(member.observed for member in members), sum(member.expected for member in members)
    return Scan(channel, category, symptom, score, ratio, y, e, sum(m.exposure for m in members),
                max(0., e - y) if symptom == 'activity_drop' else None,
                max(0., y - e) if symptom == 'rejection_increase' else None, members)


@dataclass(frozen=True)
class Advisory:
    scan: Scan
    fleet_tail_rank: float
    attributed_merchants: tuple[str, ...]
    confirmed_cause: None = None


def network_advisories(network, date_calibration, *, local_tail, minimum_attributed):
    """Warn above the ordinary date maximum. Local evidence only supports advisory attribution."""
    if network is None:
        return ()
    advisories = []
    for scan in network.scans:
        if scan.log_likelihood_ratio <= date_calibration.scores[-1]:
            continue
        supported = tuple(member.merchant_id for member in scan.members if member.tail <= local_tail)
        advisories.append(Advisory(scan, date_calibration.rank(scan.log_likelihood_ratio),
                                   supported if len(supported) >= minimum_attributed else ()))
    return tuple(advisories)
