"""Future-batch import rules: overlap with the official history, sanitised quality counts, and the operational CSV."""
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import pandas as pd

from engine.import_batch import archive_history, inspect, operational_csv
from engine.replay import ROOT

SEALED = '4613fbe37e1dd6bf104119943753928733b30e82dca30e6efe07ccd7eaa6ddff'


def shifted(days, rows=400):
    """A synthetic future batch: official test-period rows moved forward in time (never used for any fitting)."""
    raw = pd.read_csv(ROOT / 'X_test_transactions.csv', dtype=str).head(rows)
    stamp = pd.to_datetime(raw.transaction_date) + pd.Timedelta(days=days)
    return raw.assign(transaction_date=stamp.dt.strftime('%Y-%m-%d %H:%M:%S'))


class ImportBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, frame, name='batch.csv'):
        path = self.dir / name
        frame.to_csv(path, index=False)
        return inspect(path, name)

    def test_future_batch_is_accepted_and_sanitised(self):
        result = self.check(shifted(30))
        self.assertTrue(result['ok'], result['errors'])
        self.assertIn('contactless_limit', result['counts'])
        self.assertEqual(result['counts']['new_merchants'], 0)
        text = repr(result)
        self.assertNotIn('masked_pan', text)
        self.assertNotRegex(text, r'\d{4} \d{2}\*\*')

    def test_dates_inside_the_official_history_are_rejected(self):
        _, last = archive_history()
        result = self.check(shifted(1))   # starts inside 25 Oct – 13 Nov, already scored by the official run
        self.assertFalse(result['ok'])
        self.assertIn('overlaps_official', [e['code'] for e in result['errors']])
        self.assertEqual(last.date().isoformat(), '2026-11-13')

    def test_new_merchants_and_empty_or_invalid_files(self):
        frame = shifted(30)
        frame.loc[:5, 'merchant_id'] = 'MER-0001'
        self.assertEqual(self.check(frame)['counts']['new_merchants'], 1)
        self.assertIn('empty', [e['code'] for e in self.check(frame.head(0), 'empty.csv')['errors']])
        self.assertIn('missing_columns', [e['code'] for e in self.check(frame.drop(columns=['amount']), 'bad.csv')['errors']])

    def test_operational_csv_is_complete_unique_and_finite(self):
        frame = pd.DataFrame({'merchant_id': ['MER-1', 'MER-2'], 'date': ['2026-12-01', '2026-12-01'],
                              'is_anomaly': [0, 1], 'anomaly_score': [0.1, 4.2]})
        self.assertEqual(operational_csv(frame).decode().splitlines()[0], 'merchant_id,date,is_anomaly,anomaly_score')
        with self.assertRaises(ValueError):
            operational_csv(pd.concat([frame, frame]))
        with self.assertRaises(ValueError):
            operational_csv(frame.assign(anomaly_score=[0.1, float('nan')]))

    def test_sealed_submission_is_untouched(self):
        self.assertEqual(sha256((ROOT / 'y_pred_anomalies.csv').read_bytes()).hexdigest(), SEALED)


if __name__ == '__main__':
    unittest.main()


class LearningBridgeTests(unittest.TestCase):
    """The bridge maps the server-validated account to a learning role from the account store only."""

    def test_roles_come_from_the_account_store(self):
        import json, os
        from unittest.mock import patch
        from engine import learning_bridge
        with TemporaryDirectory() as tmp:
            accounts = [{'id': 'admin', 'admin': True, 'actions': []}, {'id': 'expert', 'actions': ['label']},
                        {'id': 'lead', 'actions': ['supervise']}, {'id': 'viewer', 'actions': ['export']}]
            Path(tmp, 'accounts.json').write_text(json.dumps({'accounts': accounts}), encoding='utf-8')
            with patch.dict(os.environ, {'RUNS_DIR': tmp}):
                role = lambda who: (learning_bridge.resolve(who) or type('N', (), {'role': None})).role
                self.assertEqual(role('admin'), 'supervisor')
                self.assertEqual(role('lead'), 'supervisor')
                self.assertEqual(role('expert'), 'reviewer')
                self.assertIsNone(learning_bridge.resolve('viewer'))
                self.assertIsNone(learning_bridge.resolve('nobody'))
                self.assertIsNone(learning_bridge.resolve({'user_id': 'x', 'role': 'supervisor'}))   # never an Actor from a request
                with self.assertRaises(PermissionError):   # operational batches only come from the import worker
                    learning_bridge.call('admin', 'score_operational_batch', {'observation_day': '2026-11-20'})
                with self.assertRaises(ValueError):
                    learning_bridge.call('admin', 'labelled_export', {})
