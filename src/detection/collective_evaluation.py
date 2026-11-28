"""Ordinary-only V3 freeze and paired terminal development replay."""

from dataclasses import dataclass
import json
from pathlib import Path

import pandas as pd
from scipy.stats import binomtest
from sklearn.metrics import average_precision_score

from .calibration import RankCalibration
from .channel import fit_channel_reference, merchant_channel_max, score_channels
from .collective import network_advisories, scan_day
from .evaluation import _episodes, _load_range, _origins
from .incidents import IncidentMonitor
from .references import Batch
from .sequential import calibrated_threshold
from .sequential_evaluation import Ordinary, _episode_summary, _versioned_reference, terminal_replay


CONFIG_FILE = Path('config/probabilistic_detection.v3.json')
ABLATIONS = {
    'V2': (False, False),
    'V2 + channel': (True, False),
    'V2 + collective': (False, True),
    'V2 + both': (True, True),
}


def load_v3(root):
    return json.loads((root / CONFIG_FILE).read_text(encoding='utf-8'))


def _extension_replay(days, origins, reference, v1, v3):
    by_day = {date: rows for date, rows in days.groupby('date')}
    minimum_exposure = v3['channel']['minimum_exposure']
    channel_rows, network_days = [], []
    for day in origins:
        if day not in by_day:
            raise ValueError('Replay requires every declared calendar date.')
        rows = by_day[day]
        # Offline, the raw calendar is the authoritative roster; aggregation retains closed zero days.
        scored = score_channels(rows, day, Batch('complete', day), reference, roster=rows.merchant_id)
        if scored is None:
            raise ValueError('Replay requires a complete observation for each roster entry.')
        network_days.append(scan_day(scored, established_days=v1['established_days'],
                                     minimum_exposure=minimum_exposure,
                                     odds_ratios=v3['collective']['rejection_odds_ratios']))
        channel_rows.extend((day, merchant, score)
                            for merchant, score in merchant_channel_max(scored, minimum_exposure).items())
    return pd.DataFrame(channel_rows, columns=['date', 'merchant_id', 'channel_score']), network_days


def _v2_burden_flags(days, events, origins, v1, v2):
    reference = _versioned_reference(days.loc[days.date.lt(origins[0])], events, origins[0], v1)
    monitor = IncidentMonitor.from_config(v2)
    states, flags = {}, []
    for day in origins:
        states, results = monitor.step_day(day, Batch('complete', day), days, events, reference,
                                           {reference.version: reference}, states, v1)
        roster = days.loc[days.date.eq(day), 'merchant_id']
        flags.extend((day, merchant, results[merchant][0].alert) for merchant in roster)
    return pd.DataFrame(flags, columns=['date', 'merchant_id', 'managed_alert'])


def _advisories(network_days, ranks, v3):
    policy = v3['collective']
    return [(network.date, advisory) for network in network_days
            for advisory in network_advisories(network, ranks, local_tail=policy['local_tail'],
                                                minimum_attributed=policy['minimum_attributed'])]


@dataclass
class OrdinaryV3:
    baseline: Ordinary
    frozen: dict
    sweep: pd.DataFrame
    burden_advisories: list


def calibrate_v3(root, v1, v2, v3):
    settings = v1['development']
    start, burden, boundary = (pd.Timestamp(settings[key]) for key in
                               ('calibration_start', 'burden_start', 'reserved_start'))
    end = (boundary - pd.Timedelta(days=1)).date().isoformat()
    days, events = _load_range(root, end=end)

    def epoch(origin, stop):
        reference = fit_channel_reference(days, events, origin, v3['version'])
        return _extension_replay(days, _origins(origin, stop), reference, v1, v3)

    calibration, cal_network = epoch(start, burden)
    observed, burden_network = epoch(burden, boundary)
    paired = observed.merge(_v2_burden_flags(days, events, _origins(burden, boundary), v1, v2),
                            on=['date', 'merchant_id'], how='left', validate='one_to_one')
    bank = v2['primary_bank']
    v2_policy = v2['frozen']['policies'][f'{bank}/managed']
    if (paired.managed_alert.isna().any() or len(paired) != v2['frozen']['burden_merchant_days']
            or paired.managed_alert.sum() != v2_policy['ordinary_alerts']):
        raise ValueError('Paired ordinary replay differs from the frozen V2 workload.')

    scores = calibration.channel_score.dropna()
    channel_ranks = RankCalibration.fit(scores) if len(scores) else None
    date_ranks = RankCalibration.fit(row.maximum for row in cal_network)
    budget = v2['frozen']['budget_per_merchant_week']
    baseline_alerts = int(paired.managed_alert.sum())
    disabled = {'alpha': None, 'threshold': None, 'ordinary_alerts': baseline_alerts,
                'additional_ordinary_alerts': 0, 'above_max_multiplier': None}
    sweep = []

    def evaluate(alpha, threshold, multiplier=None):
        flags = paired.managed_alert if threshold is None else paired.managed_alert | paired.channel_score.ge(threshold)
        alerts = int(flags.sum())
        option = {'alpha': alpha, 'threshold': threshold, 'ordinary_alerts': alerts,
                  'additional_ordinary_alerts': alerts - baseline_alerts, 'above_max_multiplier': multiplier}
        rate = 7 * alerts / len(paired)
        sweep.append({**option, 'alerts_per_merchant_week': rate,
                      'peak_daily_alerts': int(flags.groupby(paired.date).sum().max())})
        if threshold is not None and threshold > 0 and rate <= budget:
            return option
        return None

    options = []
    if channel_ranks:
        options = [evaluate(alpha, calibrated_threshold(channel_ranks, alpha))
                   for alpha in v1['alerts']['candidate_tail_ranks']]
        if not any(options):
            options = [evaluate(None, channel_ranks.scores[-1] * multiplier, multiplier)
                       for multiplier in v2['above_max_multipliers']]
    selected = min((option for option in options if option), key=lambda option: option['threshold'], default=disabled)

    advisories = _advisories(burden_network, date_ranks, v3)
    warning_days = len({day for day, _ in advisories})
    interval = binomtest(warning_days, len(burden_network)).proportion_ci()
    frozen = {'ordinary_last_date': end, 'calibration_merchant_days': len(calibration),
              'channel_calibration_count': len(scores), 'burden_merchant_days': len(paired),
              'budget_per_merchant_week': budget, 'channel_policy': selected,
              'collective_sorted_date_maxima': list(date_ranks.scores),
              'ordinary_advisory_days': warning_days, 'ordinary_burden_dates': len(burden_network),
              'ordinary_advisory_day_interval_iid_95': [float(interval.low), float(interval.high)]}
    return OrdinaryV3(Ordinary(days, events, v2['frozen'], pd.DataFrame()), frozen, pd.DataFrame(sweep), advisories)


def replay_v3(root, v1, v2, v3, ordinary):
    if load_v3(root) != v3 or v3['frozen'] != ordinary.frozen:
        raise ValueError('Verify the frozen ordinary-only V3 configuration before terminal replay.')
    start, end = (v1['development'][key] for key in ('reserved_start', 'reserved_end'))
    base = ordinary.baseline
    reference = fit_channel_reference(base.days, base.events, start, v3['version'])
    v2_replay = terminal_replay(root, v1, v2, base)
    days, _ = _load_range(root, start, end)
    channels, network = _extension_replay(days, pd.date_range(start, end), reference, v1, v3)
    replay = v2_replay.merge(channels, on=['date', 'merchant_id'], how='outer', validate='one_to_one', indicator=True)
    if not replay.pop('_merge').eq('both').all():
        raise ValueError('V2 and V3 must evaluate identical merchant-days.')
    threshold = ordinary.frozen['channel_policy']['threshold']
    v2_threshold = v2['frozen']['policies'][f"{v2['primary_bank']}/managed"]['threshold']
    replay['base_score'] = replay.managed.fillna(0.) / v2_threshold
    replay['channel_alert'] = False
    replay['fused_score'] = replay.base_score
    if threshold is not None:
        replay['channel_alert'] = replay.channel_score.ge(threshold)
        replay['fused_score'] = replay.base_score.clip(lower=replay.channel_score.fillna(0.) / threshold)
    ranks = RankCalibration(tuple(ordinary.frozen['collective_sorted_date_maxima']))
    return replay, network, _advisories(network, ranks, v3)


def _attribution(replay, advisories):
    indexed = replay.set_index(['date', 'merchant_id'])
    truth = indexed.is_anomaly
    selected = {(day, member.merchant_id) for day, warning in advisories for member in warning.scan.members}
    attributed = {(day, merchant) for day, warning in advisories for merchant in warning.attributed_merchants}
    return {'warning_dates': len({day for day, _ in advisories}), 'warnings': len(advisories),
            'warnings_with_attribution': sum(bool(w.attributed_merchants) for _, w in advisories),
            'subset_merchant_days': len(selected), 'subset_positive_days': sum(truth.loc[key] for key in selected),
            'attributed_merchant_days': len(attributed),
            'attributed_positive_days': sum(truth.loc[key] for key in attributed),
            'attributed_off_v2_alerts': sum(not indexed.managed_alert.loc[key] for key in attributed),
            'attributed_positive_off_v2_alerts': sum(truth.loc[key] and not indexed.managed_alert.loc[key]
                                                    for key in attributed)}


def ablations(replay, advisories, v1, v2, ordinary):
    positives = replay.loc[replay.is_anomaly.eq(1)]
    truth = _episodes(positives, gap=0, labelled=True)
    v2_fp = int((replay.managed_alert & replay.is_anomaly.eq(0)).sum())
    base_burden = v2['frozen']['policies'][f"{v2['primary_bank']}/managed"]['ordinary_alerts']
    attribution = _attribution(replay, advisories)
    daily, episodes, affected = [], [], []
    for model, (channels, collective) in ABLATIONS.items():
        mask = replay.managed_alert | (channels & replay.channel_alert)
        flagged = replay.loc[mask]
        tp = int(flagged.is_anomaly.sum())
        fp = len(flagged) - tp
        burden = ordinary.frozen['channel_policy']['ordinary_alerts'] if channels else base_burden
        daily.append({'model': model, 'TP': tp, 'FP': fp, 'additional_FP': fp - v2_fp,
                      'precision': tp / len(flagged) if len(flagged) else 0., 'recall': tp / len(positives),
                      'F1': 2 * tp / (len(positives) + len(flagged)),
                      'AP': average_precision_score(replay.is_anomaly,
                                                    replay.fused_score if channels else replay.base_score),
                      'ordinary_alerts': burden,
                      'ordinary_alerts_per_merchant_week': 7 * burden / ordinary.frozen['burden_merchant_days'],
                      'terminal_false_alerts_per_merchant_week': 7 * fp / len(replay)})
        runs = _episodes(flagged, gap=v1['episodes']['alert_max_gap_days'], labelled=False)
        episodes.append({'model': model, **_episode_summary(truth, runs)})
        affected.append({'model': model, **(attribution if collective else dict.fromkeys(attribution, 0))})
    return tuple(pd.DataFrame(rows).set_index('model') for rows in (daily, episodes, affected))
