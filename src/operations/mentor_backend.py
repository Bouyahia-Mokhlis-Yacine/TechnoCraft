"""Opt-in domain-scoped operations over the existing V2-style lifecycle and V3 advisory."""

from functools import lru_cache
from typing import TypedDict

import pandas as pd

from src.data.aggregation import merchant_days
from src.data.mentor_rules import COUNTS, merchant_day_evidence, prepare_candidate, reference_events, transaction_evidence
from src.data.preprocessing import KEYS
from src.detection.mentor_candidate import domain_promotions, load_candidate, statistical_configuration
from src.detection.sequential_evaluation import load_configs
from src.detection.collective_evaluation import load_v3

from .backend import OperationsBackend, Scope, _iso
from .forecasting import fit_forecast


ACTION = 'Verify the payment method, configured limit and recorded authorization outcome with transaction telemetry.'


class DomainSummary(TypedDict):
    correction_count: int
    contactless_count: int
    contactless_assessable_count: int
    contactless_unknown_amount_count: int
    payment_method_unknown_count: int
    violation_count: int
    accepted_violations: int
    rejected_violations: int
    declined_violations: int
    cancelled_violations: int
    refunded_violations: int
    unknown_outcome_violations: int
    violation_value_dzd: float
    maximum_violation_dzd: float | None
    excess_dzd: float
    violation_rate: float | None


class CandidateDecision(TypedDict):
    merchant_id: str
    date: str
    candidate_version: str
    statistical_score: float
    statistical_alert: bool
    domain_rule_alert: bool
    domain_promoted: bool
    hybrid_alert: bool


def summarize_domain(rows) -> DomainSummary:
    counts = {key: int(rows[key].sum()) for key in COUNTS}
    seen = counts['contactless_assessable_count']
    return {**counts, 'violation_value_dzd': float(rows.violation_value_dzd.sum()),
            'maximum_violation_dzd': float(rows.maximum_violation_dzd.max()) if counts['violation_count'] else None,
            'excess_dzd': float(rows.excess_dzd.sum()), 'violation_rate': counts['violation_count'] / seen if seen else None}


class CandidateBackend(OperationsBackend):
    def __init__(self, days, events, eligible_days, epoch, closed_through, v1, v2, v3, *, candidate, **options):
        if not events.contactless_limit_dzd.eq(candidate.contactless_limit_dzd).all():
            raise ValueError('The prepared transaction evidence must use the candidate contactless limit.')
        self.candidate = candidate
        self._domain = merchant_day_evidence(events, days)
        selected = self._domain.loc[domain_promotions(self._domain, candidate.merchant_day_policy)]
        self._promotions = {date: frozenset(rows.merchant_id) for date, rows in selected.groupby('date')}
        self._stat_threshold = v2['frozen']['policies'][f"{v2['primary_bank']}/managed"]['threshold']
        super().__init__(days, events, eligible_days, epoch, closed_through, v1, v2, v3, **options)

    def _detection_reference_events(self):
        return reference_events(self._events, self.candidate.cleaned_reference)

    def _domain_alerts(self, date):
        return self._promotions.get(date, ())

    def _statistical(self, prediction):
        return prediction is not None and self._stat_threshold is not None and (
            prediction['anomaly_score'] >= self._stat_threshold)

    def official_v2_predictions(self, scope, start, end):
        raise ValueError('Use the frozen OperationsBackend instance for official V2 predictions.')

    def candidate_predictions(self, scope: Scope, start, end) -> list[CandidateDecision]:
        merchants = self._merchants(scope)
        start, end = self._period(start, end)
        domain = self._domain.set_index(KEYS)
        return [
            {'merchant_id': merchant, 'date': _iso(date), 'candidate_version': self.candidate.version,
             'statistical_score': row['anomaly_score'], 'statistical_alert': self._statistical(row),
             'domain_rule_alert': bool(domain.at[(merchant, date), 'violation_count']),
             'domain_promoted': merchant in self._domain_alerts(date), 'hybrid_alert': bool(row['is_anomaly'])}
            for date, rows in self._predictions.items() if start <= date <= end
            for merchant, row in rows.items() if merchant in merchants]

    def domain_activity(self, scope, start, end, *, merchant=None, channel=None):
        self.activity(scope, start, end, merchant=merchant, channel=channel)
        start, end = self._period(start, end)
        merchants = self._merchants(scope, merchant)
        rows = self._domain.loc[self._domain.date.between(start, end) & self._domain.merchant_id.isin(merchants)]
        if channel:
            events = self._events.loc[self._events.date.between(start, end) & self._events.merchant_id.isin(merchants)
                                      & self._events.channel.eq(channel)]
            rows = merchant_day_evidence(events, rows)
        return {**summarize_domain(rows), 'start': _iso(start), 'end': _iso(end), 'payment_channel': channel,
                'limit_dzd': self.candidate.contactless_limit_dzd,
                'violation_merchants': sorted(rows.loc[rows.violation_count.gt(0), 'merchant_id'].unique()),
                'by_merchant_day': [{'merchant_id': m, 'date': _iso(date), **summarize_domain(day)}
                                    for (m, date), day in rows.loc[rows.violation_count.gt(0) | rows.correction_count.gt(0)]
                                    .groupby(KEYS)]}

    def domain_transaction(self, scope, date, merchant, source_row):
        self.activity(scope, date, date, merchant=merchant)
        date, _ = self._period(date, date)
        rows = self._events.loc[self._events.date.eq(date) & self._events.merchant_id.eq(merchant)
                                & self._events.source_row.eq(source_row)]
        if len(rows) != 1:
            raise ValueError('Transaction evidence is unavailable in the authorized merchant-day.')
        return transaction_evidence(next(rows.itertuples()))

    def domain_violations(self, scope, date, merchant):
        self.activity(scope, date, date, merchant=merchant)
        date, _ = self._period(date, date)
        rows = self._events.loc[self._events.date.eq(date) & self._events.merchant_id.eq(merchant)
                                & self._events.is_contactless_violation.fillna(False)]
        return [transaction_evidence(row) for row in rows.itertuples()]

    def amount_corrections(self, scope, date, merchant):
        self.activity(scope, date, date, merchant=merchant)
        date, _ = self._period(date, date)
        rows = self._events.loc[self._events.date.eq(date) & self._events.merchant_id.eq(merchant)
                                & self._events.amount_corrected]
        return [transaction_evidence(row) for row in rows.itertuples()]

    def domain_collective(self, scope, start, end, *, merchant=None, channel=None):
        rows = self.domain_activity(scope, start, end, merchant=merchant, channel=channel)['by_merchant_day']
        positive = pd.DataFrame([row for row in rows if row['violation_count']])
        if positive.empty:
            return []
        return [{'date': date, 'channel': 'nfc', 'merchants': sorted(group.merchant_id),
                 'violation_count': int(group.violation_count.sum()), 'symptom': 'shared_contactless_violation',
                 'explanation': 'Multiple merchants recorded contactless limit violations on the same date. '
                                'A common technical cause requires independent telemetry.'}
                for date, group in positive.groupby('date') if len(group) >= 2]

    def explanation(self, scope, date, merchant):
        base = super().explanation(scope, date, merchant)
        key, _ = self._period(date, date)
        domain = self.domain_activity(scope, date, date, merchant=merchant)
        rule = bool(domain['violation_count'])
        prediction = self._predictions.get(key, {}).get(merchant)
        statistical = self._statistical(prediction)
        if not (base or rule or domain['correction_count']):
            return None
        details = self.domain_violations(scope, date, merchant) if rule else []
        data = base or {'merchant_id': merchant, 'date': _iso(date), 'incident_id': None,
                        'observed_expected': None, 'indicator': None}
        stat_prose = data.get('explanation', '').replace('the V2 alert', 'the candidate statistical alert')
        prose = [stat_prose] if statistical else []
        if rule:
            prose += [f"{domain['violation_count']} contactless limit violation(s). {details[0]['explanation']}"]
        if domain['correction_count']:
            prose += [f"{domain['correction_count']} recorded negative amount(s) received sign correction."]
        data.pop('official_v2_score', None)
        data.update(detection_method=('both' if statistical and rule else 'statistical' if statistical else
                                      'domain_rule' if rule else None),
                    statistical_alert=statistical, domain_rule_alert=rule,
                    statistical_score=prediction['anomaly_score'] if prediction else None,
                    is_anomaly=bool(prediction and prediction['is_anomaly']), domain_promoted=merchant in self._domain_alerts(key),
                    domain=domain, transactions=details,
                    amount_corrections=(self.amount_corrections(scope, date, merchant) if domain['correction_count'] else []),
                    explanation=' '.join(prose),
                    recommended_action=ACTION if rule else 'Review the reported indicator and its historical reference.')
        if not statistical:
            data['observed_expected'] = None
            data['indicator'] = 'contactless_limit' if rule else None
            data['signal_source'] = 'domain_rule' if rule else 'data_quality'
            data['count_cusum'] = None
        return data

    @lru_cache(maxsize=16)
    def _reference(self, origin, merchants):
        eligible = self._eligible.loc[self._eligible.merchant_id.isin(merchants)]
        events = reference_events(self._events, self.candidate.cleaned_reference)
        if self.candidate.cleaned_reference:
            events = events.merge(eligible[KEYS], on=KEYS, validate='many_to_one')
            eligible = merchant_days(events, eligible[KEYS], pd.Series(dtype='string'))
        return fit_forecast(eligible, events, origin)

    def _incident_item(self, date, record, merchants):
        item = super()._incident_item(date, record, merchants)
        scope = Scope(merchants)
        merchant = item['merchants'][0]
        domain = self.domain_activity(scope, item['start'], item['last_alert'], merchant=merchant)
        reasons = [self.explanation(scope, row['date'], merchant)
                   for row in self.candidate_predictions(Scope(frozenset({merchant})), item['start'], item['last_alert'])
                   if row['hybrid_alert'] or row['domain_rule_alert']]
        item['statistical_score_today'] = item.pop('official_v2_score_today')
        item['detection_evidence'] = reasons
        item['evidence'] = reasons[0] if reasons else item['evidence']
        item['domain'] = domain
        item['impact'] = {**item['impact'], 'violation_value_dzd': domain['violation_value_dzd'],
                          'contactless_excess_dzd': domain['excess_dzd'], 'confirmed_economic_loss_dzd': None}
        if domain['violation_count']:
            item['collective_context'].extend(r for r in self.domain_collective(scope, date, date)
                                             if merchant in r['merchants'])
        if reasons and all(not reason['statistical_alert'] for reason in reasons):
            item['symptom'] = 'contactless_limit'
        return item

    def domain_review(self, scope, date):
        """Show domain evidence even under the advisory policy, with transparent provisional ordering."""
        rows = self.domain_activity(scope, date, date)['by_merchant_day']
        review = []
        _, end = self._period(date, date)
        for row in rows:
            if not row['violation_count']:
                continue
            merchant = row['merchant_id']
            observed = set(self._domain.loc[self._domain.merchant_id.eq(merchant) & self._domain.date.le(end)
                                           & self._domain.violation_count.gt(0), 'date'])
            streak, day = 0, end
            while day in observed:
                streak += 1
                day -= pd.Timedelta(days=1)
            explanation = self.explanation(scope, date, merchant)
            review.append({**row, 'consecutive_violation_days': streak, 'incident_id': explanation['incident_id'],
                           'detection_method': explanation['detection_method'], 'first_action': ACTION})
        return sorted(review, key=lambda row: (-row['accepted_violations'], -row['violation_count'],
                                               -row['consecutive_violation_days'], -row['violation_value_dzd'],
                                               row['merchant_id']))


def training_candidate_backend(root, *, candidate=None, **options):
    candidate = candidate or load_candidate(root)
    frozen_v1, frozen_v2 = load_configs(root)
    raw = pd.read_csv(root / 'X_train_transactions.csv', dtype={'masked_pan': 'string'})
    roster = pd.read_csv(root / 'y_train_labels.csv', usecols=KEYS)
    days, events, _ = prepare_candidate(raw, roster, limit=candidate.contactless_limit_dzd)
    v1, v2 = statistical_configuration(days, events, frozen_v1, frozen_v2, candidate)
    epoch = pd.Timestamp(v1['development']['reserved_start'])
    return CandidateBackend(days, events, days.loc[days.date.lt(epoch)], epoch, days.date.max(), v1, v2,
                            load_v3(root), candidate=candidate, **options)
