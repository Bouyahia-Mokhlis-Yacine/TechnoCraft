"""Read-only integration with the existing V2 incident and V3 channel backend."""

from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import pandas as pd
from scipy.stats import betabinom

from src.data.preprocessing import CHANNELS, KEYS
from src.detection.channel import fit_channel_reference, score_channels
from src.detection.collective_evaluation import load_v3
from src.detection.distributions import binomial_prior
from src.detection.evaluation import _load_range
from src.detection.incidents import IncidentMonitor
from src.detection.references import Batch, fit_reference
from src.detection.sequential_evaluation import load_configs

from .collective import diagnose, network_scan, overlap
from .forecasting import fit_forecast, generator, seven_day_forecast, summarize
from .impact import incident_impact
from .triage import TriagePolicy, ranked_queue


CHANNEL_KEYS = (*CHANNELS.values(), 'unknown')
QUEUE_PHASES = {'active_incident', 'recovering', 'resolved'}


@dataclass(frozen=True)
class Scope:
    merchants: frozenset[str]


def _iso(date):
    return pd.Timestamp(date).date().isoformat()


def _symptom(daily):
    detector = daily['dominant_detector']
    if detector == 'transaction_count':
        evidence = daily['detectors'][detector]
        return 'activity_drop' if evidence['observed'] < evidence['expected'] else 'activity_surge'
    return {'declines': 'rejection_increase', 'median_ticket': 'monetary_shift',
            'cancellations': 'cancellation_increase'}.get(detector, 'other')


def _activity(days, events):
    retained = int(days.transaction_count.sum()) if events is None else len(events)
    accepted = (int(days.accepted_count.sum()) if events is None
                else int(events.transaction_status.eq('Accepted').sum()))
    rejected = (int(days.declined_count.sum()) if events is None
                else int(events.transaction_status.eq('Declined').sum()))
    valid = (int(days.valid_accepted_amount_count.sum()) if events is None
             else int((events.transaction_status.eq('Accepted') & events.amount.notna()).sum()))
    value = (days.accepted_amount.sum() if events is None
             else events.loc[events.transaction_status.eq('Accepted'), 'amount'].sum())
    return {'transactions': retained, 'accepted_transactions': accepted, 'rejections': rejected,
            'rejection_rate': rejected / retained if retained else None,
            'observed_accepted_value': float(value), 'accepted_value_complete': accepted == valid,
            'accepted_amount_coverage': valid / accepted if accepted else 1.,
            'unknown_status_events': (int(days.unknown_status_count.sum()) if events is None
                                      else int(events.transaction_status.eq('Unknown').sum()))}


class OperationsBackend:
    """Serve pinned snapshots. The platform supplies authenticated scope and closed roster dates."""

    score_field = 'official_v2_score'
    dispatch_label = 'V2'

    def __init__(self, days, events, eligible_days, epoch, closed_through, v1, v2, v3, *,
                 count_model='gamma_poisson', impact_model='gamma_poisson', draws=512,
                 enable_v3=True):
        if any('pan' in str(name).lower() for frame in (days, events, eligible_days) for name in frame.columns):
            raise ValueError('Operations requires card-free aggregated inputs and cleaned events.')
        self.closed_through = pd.Timestamp(closed_through).normalize()
        self.epoch = pd.Timestamp(epoch).normalize()
        if self.epoch > self.closed_through + pd.Timedelta(days=1):
            raise ValueError('The replay epoch must follow an available observation window.')
        self._days = days.loc[days.date.le(self.closed_through)].copy()
        self._events = events.loc[events.date.le(self.closed_through)].copy()
        self._eligible = eligible_days.loc[eligible_days.date.lt(self.epoch)].copy()
        if self._days.duplicated(KEYS).any():
            raise ValueError('The closed calendar requires unique merchant-day keys.')
        self._eligible = self._days.merge(self._eligible[KEYS], on=KEYS, validate='one_to_one')
        self.roster = frozenset(self._days.merchant_id)
        self._v1, self._v2, self._v3 = v1, v2, v3
        self._count_model, self._impact_model, self._draws = count_model, impact_model, draws
        self._enable_v3 = enable_v3
        self.daily_evidence, self.lifecycle = {}, {}
        self._incidents, self._collective, self._explanations, self._predictions = {}, {}, {}, {}
        self._replay()

    def _detection_reference_events(self):
        return self._events

    def _domain_alerts(self, date):
        return ()

    def _replay(self):
        base = fit_reference(self._eligible, self._detection_reference_events(), self.epoch, self._v1['version'])
        self.reference = base
        channel_ref = (fit_channel_reference(self._eligible, self._events, self.epoch, self._v3['version'])
                       if self._enable_v3 else None)
        monitor = IncidentMonitor.from_config(self._v2)
        states, open_records, prior_network, advisory_history = {}, {}, None, []
        for date in pd.date_range(self.epoch, self.closed_through):
            rows = self._days.loc[self._days.date.eq(date)]
            if rows.empty or rows.transaction_count.isna().any():
                states, _ = monitor.step_day(date, Batch('incomplete'), rows, self._events, base,
                                            {base.version: base}, states, self._v1)
                prior_network = None
                continue
            batch = Batch('complete', date)
            current = {}
            states, results = monitor.step_day(date, batch, rows, self._events, base, {base.version: base},
                                               states, self._v1, domain_alerts=self._domain_alerts(date),
                                               evidence_sink=current)
            for merchant, daily in current.items():
                state = states[merchant].incident
                self.daily_evidence[(date, merchant)] = daily
                self.lifecycle[(date, merchant)] = {
                    'phase': state.phase.value, 'incident_id': state.incident_id,
                    'observation_on': state.candidate_on, 'quiet_days': state.quiet,
                    'reference_hold': results[merchant][0].hold_for_review,
                }
            self._predictions[date] = {
                m: {'merchant_id': m, 'date': _iso(date), 'is_anomaly': int(result.alert),
                    'anomaly_score': result.scores['managed']}
                for m, (result, _) in results.items() if result.scores is not None
            }
            active = {m: (result, states[m].incident) for m, (result, _) in results.items()
                      if result.scores and states[m].incident.phase in QUEUE_PHASES}
            alerts = [m for m, (result, _) in active.items() if result.alert]
            for m in alerts:
                daily = current[m]
                result, state = active[m]
                detector = daily['dominant_detector']
                symptom, prose = _symptom(daily), daily['explanation']
                count_track = results[m][1]
                sequential, direction = count_track.peak(monitor.fusion.persistence) if count_track else (0., None)
                sequential_driven = sequential / monitor.fusion.sequential_scale > (
                    daily['anomaly_score'] / monitor.fusion.instant_scale)
                if sequential_driven:
                    detector = 'transaction_count'
                    symptom = f'activity_{direction}'
                    count = daily['detectors'][detector]
                    prose = (f"Transaction count was {count['observed']:,}, compared with an expected "
                             f"{count['expected']:,.3g}. Persistent count {direction} evidence drove the {self.dispatch_label} alert. "
                             "The evidence describes the observed symptom. Technical cause remains unverified.")
                self._explanations[(date, m)] = {
                    'date': _iso(date), 'merchant_id': m, 'incident_id': state.incident_id,
                    'is_anomaly': bool(result.alert), self.score_field: result.scores['managed'],
                    'score_threshold': monitor.threshold, 'symptom': symptom,
                    'indicator': detector, 'observed_expected': daily['detectors'].get(detector),
                    'signal_source': 'persistent_count' if sequential_driven else 'instantaneous',
                    'count_cusum': {'log_likelihood_ratio': sequential, 'direction': direction,
                                    'minimum_streak': monitor.fusion.persistence},
                    'explanation': prose, 'limitations': daily['confidence_limitations'],
                    'reference_version': base.version, 'reference_last_date': _iso(base.last_date),
                    'reference_support': daily['support'],
                    'channel_evidence': daily['channel_evidence'],
                }
            for m, (result, state) in active.items():
                if result.alert:
                    current_evidence = self._explanations[(date, m)]
                    first_evidence, peak, first, _ = open_records.get(
                        state.incident_id, (current_evidence, 0., date, date))
                    open_records[state.incident_id] = (first_evidence, max(peak, result.scores['managed']), first, date)
            self._incidents[date] = [(m, result, state, open_records[state.incident_id])
                                     for m, (result, state) in active.items() if state.incident_id in open_records]
            if channel_ref is not None:
                scored = score_channels(rows, date, batch, channel_ref, roster=rows.merchant_id)
                network = network_scan(scored, self._v1, self._v3)
                advisories = diagnose(network, prior_network, channel_ref.categories.to_dict(), self._v3,
                                      history=advisory_history)
                self._collective[date] = advisories
                advisory_history.extend(advisories)
                prior_network = network

    def incident_history(self, scope):
        """Return each model incident at its last observed lifecycle transition."""
        merchants = self._merchants(scope)
        latest = {}
        for date, records in self._incidents.items():
            for record in records:
                if record[0] in merchants:
                    latest[record[2].incident_id] = date, record
        items = [self._incident_item(date, record, merchants) for date, record in latest.values()]
        return ranked_queue(items, policy=TriagePolicy(evidence_anchor=IncidentMonitor.from_config(self._v2).threshold))

    def _merchants(self, scope, merchant=None):
        if not isinstance(scope, Scope) or not scope.merchants or not scope.merchants <= self.roster:
            raise ValueError('A nonempty authorized merchant scope is required.')
        if merchant is not None:
            if merchant not in scope.merchants:
                raise ValueError('Merchant is unavailable in the authorized scope.')
            return frozenset({merchant})
        return scope.merchants

    def _period(self, start, end):
        start, end = pd.Timestamp(start).normalize(), pd.Timestamp(end).normalize()
        if pd.isna(start) or pd.isna(end) or start > end or end > self.closed_through:
            raise ValueError('Choose a valid period through the last closed day.')
        return start, end

    def activity(self, scope, start, end, *, merchant=None, channel=None):
        merchants = self._merchants(scope, merchant)
        start, end = self._period(start, end)
        days = self._days.loc[self._days.date.between(start, end) & self._days.merchant_id.isin(merchants)]
        if set(days.date) != set(pd.date_range(start, end)) or days.transaction_count.isna().any():
            raise ValueError('The requested period has missing or unavailable scoped observations.')
        events = None
        if channel is not None:
            if channel not in CHANNEL_KEYS:
                raise ValueError('Unknown payment channel.')
            events = self._events.loc[self._events.date.between(start, end) & self._events.merchant_id.isin(merchants)
                                      & self._events.channel.eq(channel)]
        return {'start': _iso(start), 'end': _iso(end), 'merchant_id': merchant, 'channel': channel,
                'scope_merchant_count': len(merchants), 'merchant_days': len(days), **_activity(days, events),
                'source': 'Closed merchant-day aggregates' if events is None else 'Retained, cleaned channel events'}

    def comparison(self, scope, start, end, *, merchant=None, channel=None):
        start, end = self._period(start, end)
        current = self.activity(scope, start, end, merchant=merchant, channel=channel)
        length = end - start + pd.Timedelta(days=1)
        try:
            prior = self.activity(scope, start - length, start - pd.Timedelta(days=1),
                                  merchant=merchant, channel=channel)
        except ValueError:
            prior = None
        return {'current': current, 'previous_equal_period': prior}

    def rejection_context(self, scope, date, *, merchant=None, channel=None):
        merchants = self._merchants(scope, merchant)
        date, _ = self._period(date, date)
        observed = self.activity(scope, date, date, merchant=merchant, channel=channel)
        history = self._eligible.loc[self._eligible.date.lt(date) & self._eligible.merchant_id.isin(scope.merchants)]
        current = self._days.loc[self._days.date.eq(date) & self._days.merchant_id.isin(merchants)]
        if history.empty:
            raise ValueError('The requested date has no eligible prior baseline.')
        if channel is not None:
            count, rejected = f'{channel}_count', f'{channel}_declined'
        else:
            count, rejected = 'transaction_count', 'declined_count'
        totals = history.groupby('merchant_id')[[count, rejected]].sum().rename(
            columns={count: 'transaction_count', rejected: 'declined_count'})
        center, strength = binomial_prior(totals, 'declined_count')
        draws = np.zeros(self._draws)
        expected = 0.
        for m, exposure in current[['merchant_id', count]].itertuples(index=False, name=None):
            if not exposure:
                continue
            n, yes = totals.loc[m] if m in totals.index else (0, 0)
            law = betabinom(exposure, yes + center * strength, n - yes + (1 - center) * strength)
            draws += law.rvs(size=self._draws, random_state=generator(20261127, date, m, channel, 'rejections'))
            expected += float(law.mean())
        return {'observed': observed, 'expected_rejections_at_observed_exposure': summarize(draws, expected),
                'upper_predictive_tail': float((1 + (draws >= observed['rejections']).sum()) / (1 + len(draws)))
                if observed['transactions'] else None,
                'reference_last_date': _iso(history.date.max()), 'reference_merchant_days': len(history),
                'limitations': ['Conditional on retained activity. Cross-merchant dependence is outside this model.']}

    def explanation(self, scope, date, merchant):
        self._merchants(scope, merchant)
        date, _ = self._period(date, date)
        return deepcopy(self._explanations.get((date, merchant)))

    def predictions(self, scope, start, end):
        merchants = self._merchants(scope)
        start, end = self._period(start, end)
        return [row.copy() for date, rows in self._predictions.items() if start <= date <= end
                for merchant, row in rows.items() if merchant in merchants]

    def official_v2_predictions(self, scope, start, end):
        return self.predictions(scope, start, end)

    def advisories(self, scope, start, end):
        merchants = self._merchants(scope)
        start, end = self._period(start, end)
        return deepcopy([row for date, rows in self._collective.items() if start <= date <= end for row in rows
                         if set(row['merchants']) <= merchants])

    @lru_cache(maxsize=16)
    def _reference(self, origin, merchants):
        return fit_forecast(self._eligible.loc[self._eligible.merchant_id.isin(merchants)], self._events, origin)

    @lru_cache(maxsize=256)
    def _impact(self, merchant, start, end, merchants):
        data = self._days.loc[self._days.merchant_id.eq(merchant) & self._days.date.between(start, end)
                              & self._days.transaction_count.notna()]
        reference = self._reference(self.epoch, merchants)
        return incident_impact(reference, merchant, data, model=self._impact_model, draws=self._draws)

    def _incident_item(self, date, record, merchants):
        merchant, result, state, (explanation, peak, first, last) = record
        impact = self._impact(merchant, first, last, merchants)
        date_rows = self._days.loc[self._days.merchant_id.eq(merchant) & self._days.date.between(first, last)]
        channels = sorted(c for c in CHANNELS.values() if date_rows[f'{c}_count'].sum() > 0)
        cumulative = impact['cumulative']
        symptom = explanation['symptom']
        affected = (cumulative['rejections']['excess'] if symptom == 'rejection_increase'
                    else cumulative['transactions']['shortfall'] if symptom == 'activity_drop' else None)
        support = impact['reference']['history_days']
        coverage = impact['data_quality']['complete_accepted_value_days'] / impact['observed_days']
        closed_coverage = impact['observed_days'] / impact['duration_days']
        reliability = min(1., support / 14) * (.65 + .35 * coverage) * closed_coverage
        return {'id': state.incident_id, 'kind': 'merchant_incident', 'merchants': [merchant],
                'channels': channels, 'symptom': symptom, 'start': _iso(first), 'last_alert': _iso(last),
                'as_of': _iso(date), 'duration_days': impact['duration_days'],
                'recovery_status': state.phase.value, 'recovery_quiet_days': state.quiet,
                'is_anomaly_today': bool(result.alert), f'{self.score_field}_today': result.scores['managed'],
                'comparable_score': peak, 'affected_transactions': affected,
                'potential_value': cumulative['accepted_value']['shortfall'], 'data_reliability': reliability,
                'evidence': explanation, 'impact': impact, 'collective_context': []}

    def queue(self, scope, date, *, include_resolved=True, method='mcda', policy=None,
              assumed_actionable_probability=None):
        merchants = self._merchants(scope)
        date, _ = self._period(date, date)
        if date not in self._incidents:
            raise ValueError('Incident evidence is unavailable for the requested date.')
        items = [self._incident_item(date, row, merchants) for row in self._incidents[date]
                 if row[0] in merchants and (include_resolved or row[2].phase != 'resolved')]
        dispatched = []
        for row in self.advisories(scope, date, date):
            members = set(row['merchants'])
            if any(row['channel'] == prior['channel'] and row['symptom'] == prior['symptom']
                   and overlap(members, set(prior['merchants'])) >= .5 for prior in dispatched):
                continue
            dispatched.append(row)
            corroborated = set(row['corroborated_merchants'])
            matching = [item for item in items if item['kind'] == 'merchant_incident'
                        and item['merchants'][0] in corroborated and item['symptom'] == row['symptom']]
            for item in matching:
                item['collective_context'].append(row)
            if corroborated and corroborated <= {item['merchants'][0] for item in matching}:
                continue
            score = row['collective_log_likelihood_ratio']
            threshold = self._v3['frozen']['collective_sorted_date_maxima'][-1]
            v2_threshold = IncidentMonitor.from_config(self._v2).threshold
            # Scale advisory evidence by its own workload boundary. Keep the V2 score separately.
            items.append({'id': f"advisory:{row['start']}:{row['channel']}:{row['signature'][1] or '*'}:{row['symptom']}",
                          'kind': 'collective_advisory', 'merchants': row['merchants'], 'channels': [row['channel']],
                          'symptom': row['symptom'], 'start': row['start'], 'as_of': row['date'],
                          'duration_days': row['duration_days'], 'recovery_status': 'advisory',
                          'comparable_score': score / threshold * (v2_threshold or 1.),
                          'affected_transactions': (row['potential_activity_shortfall'] if row['symptom'] == 'activity_drop'
                                                    else row['excess_rejections']),
                          'potential_value': None, 'data_reliability': len(corroborated) / len(row['merchants']),
                          'evidence': row, 'impact': None})
        return ranked_queue(deepcopy(items), method=method, policy=policy or TriagePolicy(
            evidence_anchor=IncidentMonitor.from_config(self._v2).threshold or 1.),
            assumed_actionable_probability=assumed_actionable_probability)

    @lru_cache(maxsize=32)
    def _forecast(self, merchants, reference_scope, origin, multiplier):
        reference = self._reference(origin, reference_scope)
        return seven_day_forecast(reference, origin, merchants, model=self._count_model, draws=self._draws,
                                  incident_activity_multiplier=multiplier)

    def forecast(self, scope, *, merchant=None, origin=None, incident_activity_multiplier=None):
        merchants = self._merchants(scope, merchant)
        origin = self.closed_through + pd.Timedelta(days=1) if origin is None else pd.Timestamp(origin).normalize()
        if pd.isna(origin) or origin > self.closed_through + pd.Timedelta(days=1):
            raise ValueError('Forecast origin cannot skip beyond the available observation cutoff.')
        return deepcopy(self._forecast(merchants, scope.merchants, origin, incident_activity_multiplier))


def training_backend(root, *, amount_policy='archived_v2', draws=512,
                     count_model='gamma_poisson', impact_model='gamma_poisson'):
    """Offline platform demo with the official training roster and frozen prior epoch."""
    if amount_policy != 'archived_v2':
        raise ValueError(f'Unknown amount policy {amount_policy!r}.')
    v1, v2 = load_configs(root)
    v3 = load_v3(root)
    days, events = _load_range(root)
    return OperationsBackend(days, events, days, v1['development']['reserved_start'], days.date.max(),
                             v1, v2, v3, draws=draws, count_model=count_model, impact_model=impact_model)
