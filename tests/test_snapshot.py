"""Integration checks against a snapshot published by the competition engine."""

import csv
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pandas as pd

from engine.export import atomic_write, publish
from engine.replay import CONFIGS, INPUTS, ROOT, check_fingerprints, evidence
from engine.validate import privacy, validate


class SnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        runs = Path(os.environ.get('RUNS_DIR', ROOT / 'runs'))
        latest = json.loads((runs / 'latest.json').read_text(encoding='utf-8'))
        snapshot = runs / latest['path']
        cls.payload = json.loads(snapshot.read_text(encoding='utf-8'))
        with snapshot.with_name('y_pred_anomalies.csv').open(newline='', encoding='utf-8') as stream:
            cls.csv = [{**r, 'is_anomaly': int(r['is_anomaly']), 'anomaly_score': float(r['anomaly_score'])}
                       for r in csv.DictReader(stream)]

    def test_frozen_inputs(self):
        check_fingerprints(Path(os.environ.get('SATIM_DATA_DIR', ROOT)), INPUTS)
        check_fingerprints(ROOT / 'config', CONFIGS)

    def test_schema_and_submission_match_exactly(self):
        validate(self.payload)
        self.assertEqual(self.payload['official_predictions'], self.csv)
        parity = self.payload['run']['parity']
        self.assertEqual(parity['development_rows'], 280)
        self.assertEqual(parity['official_rows'], 711)
        if parity['sealed']:
            self.assertEqual(parity['official_sha256'], evidence('v2_official_parity.json')['exact_score_flag_digest_sha256'])
            self.assertEqual(parity['development_sha256'],
                             evidence('v2_development_parity.json')['prior_recorded_training_replay_sha256'])

    def test_advisories_and_domain_are_isolated(self):
        flagged = {(r['merchant_id'], r['date']) for r in self.csv if r['is_anomaly']}
        self.assertTrue(all(a['mode'] == 'advisory' and a['confirmed_cause'] is None for a in self.payload['advisories']))
        for row in (self.payload['hybrid'] or {}).get('rows', []):
            if row['investigation_candidate']:
                self.assertNotIn((row['merchant_id'], row['date']), flagged)
        tx = self.payload['transactions']
        for amount, channel, flags, breach in zip(tx['amount'], tx['channel'], tx['quality'], tx['contactless_limit']):
            self.assertEqual(breach, channel == 'Contactless / NFC' and amount is not None and amount > 2500)
            if 'negative_amount' in flags:
                self.assertIsNone(amount)

    def test_zero_days_cold_start_and_prior_support(self):
        days = self.payload['merchant_days']
        self.assertTrue(any(d['n'] == 0 and d['anomaly_score'] is not None for d in days))
        self.assertTrue(any(d['warming_up'] and
                            d['detectors'].get('transaction_count', {}).get('method') == 'global_gamma_poisson'
                            for d in days))
        for day in days:
            if day['is_anomaly']:
                detail = day['explanation']
                self.assertLess(detail['reference_last_date'], day['date'])
                self.assertIn('relative_deviation', detail['observed_expected'])
                self.assertIsNotNone(day['lifecycle']['incident_id'])

    def test_incomplete_monetary_values_are_withheld(self):
        days = self.payload['merchant_days']
        incomplete = [d for d in days if d['valid_accepted_amount_count'] != d['n_acc']]
        self.assertTrue(incomplete)
        self.assertTrue(all(d['value'] is None for d in incomplete))
        total = sum(d['n'] for d in days)
        self.assertEqual(total, sum(d['transactions'] for d in self.payload['network']['daily']))

    def test_privacy_checks_both_fields_and_values(self):
        privacy(self.payload)
        with self.assertRaises(ValueError):
            privacy({'masked_pan': 'test'})
        with self.assertRaises(ValueError):
            privacy({'note': '7' * 6 + '*' * 6 + '8' * 4})

    def test_atomic_publication_preserves_previous_pointer_on_failure(self):
        with TemporaryDirectory(dir=ROOT) as folder:
            root = Path(folder)
            atomic_write(root / 'latest.json', b'previous')
            with patch('engine.export.os.replace', side_effect=OSError('disk write failed')):
                with self.assertRaises(OSError):
                    publish(self.payload, pd.DataFrame(self.csv), root)
            self.assertEqual((root / 'latest.json').read_bytes(), b'previous')
            self.assertFalse(list(root.rglob('.snapshot.json*')))


if __name__ == '__main__':
    unittest.main()
