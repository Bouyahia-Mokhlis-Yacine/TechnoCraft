"""Read-only diagnosis and chronological extensions to the frozen V3 scan."""

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import poisson

from src.detection.calibration import RankCalibration
from src.detection.collective import network_advisories, scan_day


ONE_DAY = pd.Timedelta(days=1)


def network_scan(scored, v1, v3):
    return scan_day(scored, established_days=v1['established_days'],
                    minimum_exposure=v3['channel']['minimum_exposure'],
                    odds_ratios=v3['collective']['rejection_odds_ratios'])


def signature(scan):
    return scan.channel, scan.category, scan.symptom


def merchant_ids(scan):
    return frozenset(member.merchant_id for member in scan.members)


def overlap(left, right):
    return len(left & right) / len(left | right) if left or right else 0.


@dataclass(frozen=True)
class Candidate:
    score: float
    merchants: frozenset
    channel: str
    symptom: str


def temporal_candidates(network, previous):
    """Discount one prior closed day's evidence by subset overlap and time."""
    if network is None:
        return []
    comparable = (previous is not None and network.date - previous.date == ONE_DAY
                  and network.reference_version == previous.reference_version)
    prior = {signature(scan): scan for scan in previous.scans} if comparable else {}
    candidates = []
    for scan in network.scans:
        members = merchant_ids(scan)
        earlier = prior.get(signature(scan))
        carry = (.5 * overlap(members, merchant_ids(earlier)) * earlier.log_likelihood_ratio
                 if earlier is not None else 0.)
        candidates.append(Candidate(scan.log_likelihood_ratio + carry, members, scan.channel, scan.symptom))
    return candidates


def group_candidates(scored, v1, v3, similarities):
    """Benchmark simultaneous tails and two fixed prior-dependency groupings."""
    alternatives = {name: [] for name in ('simultaneous', 'similarity', 'graph')}
    if scored is None:
        return alternatives
    local = v3['collective']['local_tail']
    for channel, rows in scored.evidence.groupby('channel', sort=True):
        if channel == 'unknown':
            continue
        activity = rows.loc[rows.history_days.ge(v1['established_days']) & rows.expected_activity.gt(0)]
        rejected = rows.loc[rows.exposure.ge(v3['channel']['minimum_exposure'])]
        tails = {
            'activity_drop': pd.Series(poisson.cdf(activity.exposure, activity.expected_activity),
                                       index=activity.merchant_id),
            'activity_surge': pd.Series(poisson.sf(activity.exposure - 1, activity.expected_activity),
                                        index=activity.merchant_id),
            'rejection_increase': pd.Series(10. ** -rejected.declines_score.to_numpy(), index=rejected.merchant_id),
        }
        for symptom, probabilities in tails.items():
            flagged = frozenset(probabilities.index[probabilities.le(local)])
            if len(flagged) < 2:
                continue
            strength = -np.log(np.maximum(probabilities, np.finfo(float).tiny))
            alternatives['simultaneous'].append(Candidate(float(len(flagged)), flagged, channel, symptom))
            # Dependency estimates apply to count residuals. The rejection baseline
            # is identical across these variants because its null conditions on exposure.
            edges = similarities.get(channel, ()) if symptom != 'rejection_increase' else ()
            pairs = [(a, b) for a, b in edges if a in flagged and b in flagged]
            if symptom == 'rejection_increase':
                for method in ('similarity', 'graph'):
                    alternatives[method].append(
                        Candidate(float(strength.loc[sorted(flagged)].sum()), flagged, channel, symptom))
                continue
            for a, b in pairs:
                alternatives['similarity'].append(Candidate(float(strength[a] + strength[b]),
                                                            frozenset((a, b)), channel, symptom))
            for members in connected_groups(pairs):
                alternatives['graph'].append(Candidate(float(strength.loc[sorted(members)].sum()),
                                                       members, channel, symptom))
    return alternatives


def connected_groups(pairs):
    neighbors = {}
    for a, b in pairs:
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    remaining = set(neighbors)
    while remaining:
        members, pending = set(), [min(remaining)]
        while pending:
            merchant = pending.pop()
            if merchant not in members:
                members.add(merchant)
                pending.extend(neighbors[merchant] - members)
        remaining.difference_update(members)
        yield frozenset(members)


def residual_dependencies(days, origin, reference, *, minimum_history=14, correlation=.4, shrinkage=10):
    """Estimate positively correlated count residuals using only pre-origin rows."""
    prior = days.loc[days.date.lt(origin)]
    weekday = prior.date.dt.weekday.map(reference.base.weekday).fillna(1.)
    exposure = prior.merchant_id.map({m: t[2] for m, t in reference.base.totals.items()})
    edges = {}
    for column in reference.support.columns:
        channel = column.removesuffix('_count')
        if channel == 'unknown':
            continue
        expected = weekday * prior.merchant_id.map(reference.support[column]) / exposure
        residual = ((prior[column] - expected) / np.sqrt(expected.clip(lower=1.))).where(expected.ge(1.))
        matrix = prior.assign(residual=residual).pivot(index='date', columns='merchant_id', values='residual')
        present = matrix.notna().astype(int)
        paired = present.T @ present
        shrunk = matrix.corr(min_periods=minimum_history) * paired / (paired + shrinkage)
        edges[channel] = [(a, b) for i, a in enumerate(shrunk.index) for b in shrunk.columns[i + 1:]
                          if shrunk.at[a, b] >= correlation]
    return edges


def hypotheses(scan, corroborated):
    if scan.symptom == 'rejection_increase':
        first = ('Shared channel authorization degradation', 'Compare channel service and response-code telemetry.')
    elif scan.symptom == 'activity_drop':
        first = ('Shared channel availability degradation', 'Check service uptime and channel ingestion counters.')
    else:
        first = ('Shared demand shift or processing backlog', 'Compare intraday volume and processing timestamps.')
    return [
        {'rank': 1, 'hypothesis': first[0], 'check': first[1],
         'support': f'{len(corroborated)} merchants meet the nominal local evidence cutoff.',
         'counterevidence': f'{len(scan.members) - len(corroborated)} selected merchants lack local corroboration.'},
        {'rank': 2, 'hypothesis': 'Observation or composition change',
         'check': 'Check feed completeness, known merchant schedules and channel mix.',
         'support': 'The grouping uses retained events and observed calendar dates.',
         'counterevidence': 'Independent feed, service and merchant schedule telemetry is unavailable.'},
    ]


def diagnose(network, previous, categories, v3, *, history=()):
    """Enrich the frozen advisory with current evidence and observed warning duration."""
    policy = v3['collective']
    ranks = RankCalibration.fit(v3['frozen']['collective_sorted_date_maxima'])
    warnings = network_advisories(network, ranks, local_tail=policy['local_tail'],
                                  minimum_attributed=policy['minimum_attributed'])
    if not warnings:
        return []
    temporal = dict(zip((signature(scan) for scan in network.scans), temporal_candidates(network, previous)))
    output = []
    for warning in warnings:
        scan = warning.scan
        members = merchant_ids(scan)
        start = network.date
        preceding_members = members
        for entry in reversed(history):
            prior_members = frozenset(entry['merchants'])
            if (entry['signature'] == signature(scan) and pd.Timestamp(entry['date']) == start - ONE_DAY
                    and overlap(prior_members, preceding_members) >= .5
                    and entry['reference_version'] == network.reference_version):
                start = pd.Timestamp(entry['date'])
                preceding_members = prior_members
        output.append({
            'mode': 'advisory', 'confirmed_cause': None,
            'date': network.date.date().isoformat(), 'start': start.date().isoformat(),
            'duration_days': int((network.date - start).days + 1),
            'signature': signature(scan), 'channel': scan.channel, 'symptom': scan.symptom,
            'categories': sorted({categories[m] for m in members if m in categories}),
            'merchants': sorted(members), 'corroborated_merchants': list(warning.attributed_merchants),
            'observed': scan.observed, 'expected': scan.expected, 'exposure': scan.exposure,
            'potential_activity_shortfall': scan.activity_shortfall, 'excess_rejections': scan.excess_declines,
            'activity_increase': max(0., scan.observed - scan.expected) if scan.symptom == 'activity_surge' else None,
            'collective_log_likelihood_ratio': scan.log_likelihood_ratio,
            'calibration_date_tail_rank': warning.fleet_tail_rank,
            'overlap_weighted_two_day_score': temporal[signature(scan)].score,
            'reference_version': network.reference_version,
            'local_evidence': [dict(merchant_id=m.merchant_id, observed=m.observed, expected=m.expected,
                                    exposure=m.exposure, history_exposure=m.history_exposure,
                                    reference_source=m.reference_source, nominal_tail=m.tail) for m in scan.members],
            'hypotheses': hypotheses(scan, tuple(m.merchant_id for m in scan.members if m.tail <= policy['local_tail'])),
        })
    return sorted(output, key=lambda row: (-row['collective_log_likelihood_ratio'], row['signature'][0],
                                           row['signature'][1] or '', row['signature'][2]))
