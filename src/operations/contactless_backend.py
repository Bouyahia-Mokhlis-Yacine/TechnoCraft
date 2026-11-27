"""Archived, rejected research-only contactless correction adapter (opt-in only; disabled by default)."""

from copy import deepcopy

import pandas as pd

from src.data.aggregation import merchant_days
from src.data.contactless_correction import VERSION, corrected_events, load_frozen_candidate
from src.data.mentor_rules import prepare_candidate
from src.data.preprocessing import KEYS
from src.detection.collective_evaluation import load_v3
from src.detection.sequential_evaluation import load_configs

from .backend import OperationsBackend, Scope


class ContactlessBackend(OperationsBackend):
    score_field = 'candidate_score'
    dispatch_label = 'contactless candidate'

    def __init__(self, *args, mapping, **kwargs):
        self.mapping = mapping
        super().__init__(*args, **kwargs)

    def official_v2_predictions(self, scope, start, end):
        raise ValueError('Official predictions require the archived_v2 amount policy.')

    def monetary_lineage(self, scope, date, merchant):
        self._merchants(scope, merchant)
        date, _ = self._period(date, date)
        nfc = self._events.loc[self._events.merchant_id.eq(merchant) & self._events.date.eq(date)
                               & self._events.channel.eq('nfc')]
        source = pd.to_numeric(nfc.original_amount, errors='coerce').where(nfc.amount.notna())
        nfc = nfc.assign(sign_corrected=source.abs())
        attempted = nfc.loc[nfc.transaction_status.ne('Refunded')]
        return {'version': VERSION, 'method': self.mapping.method, 'limit_dzd': self.mapping.limit,
                'last_fit_date': self.mapping.last_date, 'assessable_nfc': int(nfc.amount.count()),
                'changed_nfc': int((nfc.amount.notna() & nfc.amount.ne(nfc.sign_corrected)).sum()),
                'source_over_limit_nfc': int(nfc.sign_corrected.gt(self.mapping.limit).sum()),
                'sign_corrected_nfc_attempted_dzd': float(attempted.sign_corrected.sum()),
                'mapped_nfc_attempted_dzd': float(attempted.amount.sum())}

    def explanation(self, scope, date, merchant):
        result = super().explanation(scope, date, merchant)
        if result:
            result['amount_policy'] = self.monetary_lineage(scope, date, merchant)
        return result

    def _incident_item(self, date, record, merchants):
        item = super()._incident_item(date, record, merchants)
        item['evidence']['amount_policy'] = self.monetary_lineage(
            Scope(merchants), item['evidence']['date'], item['merchants'][0])
        return item


def training_contactless_backend(root, **options):
    mapping, detector = load_frozen_candidate(root)
    v1, v2 = load_configs(root)
    if detector['base'] != v2['version'] or detector['reference_epoch'] != v1['development']['reserved_start']:
        raise ValueError('The frozen candidate does not match its archived base.')
    raw = pd.read_csv(root / 'X_train_transactions.csv', dtype={'masked_pan': 'string'})
    roster = pd.read_csv(root / 'y_train_labels.csv', usecols=KEYS)
    _, events, _ = prepare_candidate(raw, roster)
    # Convert the prior reference tape to the same scale as future observations.
    events = corrected_events(events, mapping)
    days = merchant_days(events, roster, pd.Series(dtype='string'))
    v1 = dict(v1, version=VERSION)
    v2 = deepcopy(v2)
    primary = v2['primary_bank']
    v2['frozen']['policies'][f'{primary}/managed']['threshold'] = detector['threshold']
    v2['version'] = VERSION
    return ContactlessBackend(days, events, days, detector['reference_epoch'], days.date.max(), v1, v2, load_v3(root),
                              mapping=mapping, **options)
