"""Small, simulated feedback fixtures. No official evaluation rows enter learning."""

from contextlib import ExitStack
from hashlib import sha256
import json
from pathlib import Path
from random import Random
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pandas as pd

from src.continuous_learning import drift, feedback, models, observations, registry, review_queue
from src.continuous_learning.service import LearningService
from src.continuous_learning.store import Actor, ROOT
from src.detection.incidents import Incident, MerchantState, Phase

M = ('MER-A', 'MER-B', 'MER-C', 'MER-D', 'MER-E', 'MER-F', 'MER-G', 'MER-H', 'MER-I', 'MER-J')
SUPERVISOR = Actor('sam', 'supervisor')
REVIEWER = Actor('ray', 'reviewer')


class LearningTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        temp = self.stack.enter_context(TemporaryDirectory())
        self.clock = '2031-04-01'
        self.ticks = 0
        for module in (observations, feedback, registry, review_queue):
            self.stack.enter_context(patch.object(module, 'now', self.tick))
        self.service = LearningService({'super': SUPERVISOR, 'review': REVIEWER,
                                        'limited': Actor('lou', 'reviewer', frozenset({M[0]}))}.get,
                                       directory=Path(temp) / 'continuous_learning')
        self.policy = self.service.policy
        self.store = self.service.store

    def tick(self):
        self.ticks += 1
        return f'{self.clock}T12:00:00.{self.ticks:06d}+00:00'

    def day_inputs(self, start, end, *, drifted=False, anomalies=(), merchants=M):
        roster, events, evidence = [], [], {}
        for stamp in pd.date_range(start, end):
            day = stamp.date().isoformat()
            for i, merchant in enumerate(merchants):
                key = merchant, day
                roster.append((merchant, day))
                count = 12 + i * 2 + stamp.weekday() % 3 + stamp.day % 2
                if drifted:
                    count = round(1.35 * count)
                if key in anomalies:
                    count = 0
                evidence[key] = {'phase': 'normal', 'sequential_score': .1, 'sequential_threshold': 1.,
                                 'model_version': 'frozen-v2', 'reference_version': 'fixture-v1',
                                 'symptom': 'transaction_count'}
                for j in range(count):
                    record = dict(hour=9 + j % 9, amount=float(220 + i * 30 + j % 5 * 20),
                                  channel=('pos', 'mobile', 'nfc')[j % 3], merchant_category='Retail',
                                  transaction_status='Declined' if j % 13 == 5 else 'Accepted')
                    record.update({k: False for k in observations.EVENT_FIELDS if k not in record})
                    events.append({'merchant_id': merchant, 'date': stamp, **record})
        return (pd.DataFrame(roster, columns=['merchant_id', 'date']),
                pd.DataFrame(events, columns=observations.EVENT_COLUMNS), evidence)

    def insert(self, start, end=None, *, amend=None, corrections=None, **kwargs):
        calendar, events, evidence = self.day_inputs(start, end or start, **kwargs)
        if amend:
            amend(evidence, events)
        return observations.ingest(self.store, SUPERVISOR, source='simulated', calendar=calendar, events=events,
                                   evidence=evidence, corrections=corrections)

    def label(self, merchant, day, label='verified_normal', *, expected=0, observation_revision=1, approve=True):
        revision = self.service.submit_feedback('review', merchant, day, label=label, notes='Simulated review.',
                                                evidence=['Synthetic activity fixture'], expected_revision=expected,
                                                observation_revision=observation_revision)['revision']
        if approve:
            self.service.decide_feedback('super', merchant, day, revision=revision, decision='approved',
                                         reason='Independent simulated review.')
        return revision

    def approve_range(self, start, end, **kwargs):
        for stamp in pd.date_range(start, end):
            for m in M:
                self.label(m, stamp.date().isoformat(), **kwargs)

    def test_feedback_revisions_authorization_and_privacy(self):
        date = '2031-03-20'
        self.insert(date)
        with self.assertRaises(PermissionError):
            self.service.feedback_statistics('missing')
        with self.assertRaises(PermissionError):
            self.service.feedback_history('limited', M[1], date)
        with self.assertRaises(ValueError):
            self.service.submit_feedback('review', M[0], date, label='verified_normal',
                                         notes='4111-1111-1111-1111', observation_revision=1)
        with self.assertRaises(ValueError):
            self.service.submit_feedback('review', M[0], date, label='verified_normal',
                                         notes='123456******1234', observation_revision=1)
        self.label(M[0], date)
        self.assertEqual(self.label(M[0], date, expected=1, approve=False), 1)
        with self.assertRaises(ValueError):
            self.label(M[0], date, label='confirmed_anomaly', approve=False)
        self.label(M[0], date, label='confirmed_anomaly', expected=1, approve=False)
        with self.assertRaises(PermissionError):
            self.service.decide_feedback('review', M[0], date, revision=2, decision='approved', reason='No.')
        records = self.service.feedback_history('limited', M[0], date)
        self.assertEqual([(r['revision'], r['approval']) for r in records], [(1, 'approved'), (2, 'pending')])
        self.assertEqual(self.service.labelled_export('limited')['rows'], [])
        self.service.decide_feedback('super', M[0], date, revision=2, decision='approved', reason='Audit.')
        exported = self.service.labelled_export('limited')['rows']
        self.assertEqual(exported[0]['label'], 'confirmed_anomaly')
        self.assertNotIn('notes', exported[0])
        self.assertNotIn('reviewer', exported[0])

    def test_eligibility_prior_only_quality_and_incident_episode(self):
        def evidence(ev, events):
            ev[M[0], '2031-03-21'].update(phase='active_incident', incident_id='test-incident')
            ev[M[0], '2031-03-22'].update(phase='resolved', incident_id='test-incident')
            ev[M[3], '2031-03-20']['collective'] = True
            events.loc[events.merchant_id.eq(M[2]), 'amount'] = None

        self.insert('2031-03-20', '2031-03-24', amend=evidence)
        for date in pd.date_range('2031-03-20', '2031-03-24'):
            self.label(M[0], date.date().isoformat())
        self.label(M[1], '2031-03-20', label='legitimate_change', approve=False)
        self.label(M[2], '2031-03-20')
        self.label(M[4], '2031-03-20')
        self.assertEqual(self.service.training_eligibility('review', self.clock), [])
        all_rows = {(r['merchant_id'], r['date']): r for r in self.service.training_eligibility('review', '2031-04-02')}
        self.assertTrue(all_rows[M[4], '2031-03-20']['eligible'])
        self.assertFalse(all_rows[M[1], '2031-03-20']['eligible'])
        self.assertEqual(all_rows[M[2], '2031-03-20']['reason'], 'data_quality')
        self.assertEqual(all_rows[M[3], '2031-03-20']['reason'], 'unresolved_collective_candidate')
        self.assertEqual({key[1] for key, row in all_rows.items() if key[0] == M[0] and row['reason'] == 'incident_or_recovery'},
                         {'2031-03-20', '2031-03-21', '2031-03-22', '2031-03-23', '2031-03-24'})
        self.service.decide_feedback('super', M[1], '2031-03-20', revision=1, decision='approved', reason='Verified shift.')
        status = self.service.training_eligibility('review', '2031-04-02')
        self.assertTrue(next(row for row in status if row['merchant_id'] == M[1] and row['date'] == '2031-03-20')['eligible'])

    def test_corrected_data_requires_new_review(self):
        date = '2031-03-20'
        self.insert(date)
        self.label(M[0], date)
        self.assertEqual(self.insert(date), 0)
        def change(_, events):
            events.loc[events.merchant_id.eq(M[0]), 'amount'] += 2.
        with self.assertRaises(ValueError):
            self.insert(date, amend=change)
        self.assertEqual(self.insert(date, amend=change, corrections={(M[0], date): 1}), 1)
        self.assertEqual(self.service.labelled_export('review')['rows'], [])
        self.label(M[0], date, expected=1, observation_revision=2)
        self.assertEqual(self.service.labelled_export('review')['rows'][0]['observation_revision'], 2)

    def test_queue_determinism_diversity_and_equal_budget(self):
        self.policy.update(daily_review_budget=4, random_review_slots=1)
        for date in ('2031-03-20', '2031-03-21'):
            def amend(ev, events):
                a, b, c, d = (ev[m, date] for m in M[:4])
                a.update(collective=True, incident_id='ep-1', symptom='drop')
                b.update(hybrid_score=4., hybrid_flag=True, ml_tail_rank=.01, symptom='outcomes')
                c.update(sequential_score=.98, ml_tail_rank=.04, symptom='amount')
                d.update(sequential_score=.84, symptom='amount')
                events.loc[events.merchant_id.eq(M[1]), 'channel'] = 'mobile'
                events.loc[events.merchant_id.eq(M[2]), 'channel'] = 'ecommerce'
            self.insert(date, amend=amend)
        first = self.service.review_queue('super', '2031-03-20')
        self.assertEqual(first, self.service.review_queue('review', '2031-03-20'))
        self.assertEqual(len(first), 4)
        self.assertEqual(len({row['merchant_id'] for row in first}), 4)
        self.assertGreaterEqual(len({row['channel'] for row in first}), 3)
        self.assertAlmostEqual(first[0]['selection_probability'], 1 / 6)
        self.assertTrue(all(row['selection_probability'] is None for row in first[1:]))
        self.assertFalse(any(row['incident_id'] == 'ep-1' for row in self.service.review_queue('super', '2031-03-21')))
        positives = set(M[:3])
        discovered = len({row['merchant_id'] for row in first} & positives)
        random_yield = sum(len(set(Random(seed).sample(M, 4)) & positives) for seed in range(100)) / 100
        self.assertEqual(discovered, 3)
        self.assertGreater(discovered, random_yield)
        print(f'Selection fixture: active={discovered}/4, uniform mean={random_yield:.2f}/4 (100 seeds).')

    def test_drift_calendar_support_and_distance(self):
        self.insert('2031-02-03', '2031-02-16')
        self.insert('2031-02-17', '2031-03-02', drifted=True)
        self.policy['drift_min_rows_per_stratum'] = 2
        report = self.service.drift_report('review', '2031-02-03', '2031-02-16', '2031-02-17', '2031-03-02')
        signals = report['distribution_shift']
        self.assertEqual(signals['transaction_count']['status'], 'investigate')
        self.assertEqual(signals['hybrid_score']['status'], 'insufficient_support')
        self.assertGreater(signals['transaction_count']['distance'], 1.)
        self.assertEqual(report['reviewed_performance']['recent']['reviewed'], 0)
        self.assertAlmostEqual(drift.statistic('channel_composition', [[1, 0]], [[0, 1]]), 1.)

    def test_official_files_cannot_enter_or_be_modified(self):
        official = ROOT / 'y_pred_anomalies.csv'
        before = sha256(official.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            self.insert(observations.archive_end())
        self.assertEqual(before, '4613fbe37e1dd6bf104119943753928733b30e82dca30e6efe07ccd7eaa6ddff')
        self.assertEqual(sha256(official.read_bytes()).hexdigest(), before)
        self.assertFalse(self.store.path.is_relative_to(ROOT / 'runs' / 'imports'))

    def baseline(self):
        self.insert('2031-01-01', '2031-01-15')
        self.insert('2031-01-16', '2031-01-23')
        self.insert('2031-01-24', '2031-02-12')
        with self.store.connect() as db:
            rows = list(db.execute('SELECT * FROM current_observation ORDER BY day,merchant'))
        all_days, events = observations.frames(rows)
        origin, cal = pd.Timestamp('2031-01-16'), pd.Timestamp('2031-01-24')
        seed = all_days.loc[all_days.date.lt(origin)]
        artifact, details = models.fit(seed, all_days.loc[all_days.date.ge(origin) & all_days.date.lt(cal)],
                                       all_days.loc[all_days.date.ge(cal)], events, origin, '2031-02-12', 64)
        # Seed rows represent a pre-existing operational model. The fixture ledger starts fresh.
        with self.store.connect(write=True) as db:
            db.execute('DELETE FROM observation')
        with patch.object(models, 'bootstrap', return_value=(artifact, details)):
            identifier = self.service.initialize_baseline('super', 'Simulated incumbent.')['model_id']
        return identifier, artifact

    def test_controlled_refit_separation_shadow_decisions_and_rollback(self):
        v1, v2, v3, v4 = models.configs()
        fixture_configs = ({**v1, 'resampling_draws': 512}, v2, v3, v4)
        self.stack.enter_context(patch.object(models, 'configs', return_value=fixture_configs))
        baseline, base_artifact = self.baseline()
        self.policy.update(min_eval_rows=30, min_eval_dates=3, min_eval_anomalies=3,
                           min_eval_normal=20, min_eval_episodes=2, forecast_draws=64)
        self.clock = '2031-04-02'
        def prior_episode(evidence, events):
            for date in ('2031-03-19', '2031-03-20'):
                evidence[M[-1], date].update(phase='active_incident', incident_id='persistent-drop')
        prior_anomalies = {(M[-1], '2031-03-19'), (M[-1], '2031-03-20')}
        self.insert('2031-03-10', '2031-03-30', drifted=True, anomalies=prior_anomalies, amend=prior_episode)
        self.approve_range('2031-03-10', '2031-03-30', label='legitimate_change')
        self.clock = '2031-05-01'
        self.insert('2031-04-03', '2031-04-30', drifted=True)
        self.approve_range('2031-04-03', '2031-04-30')
        self.clock = '2031-05-03'
        plan = {'fit_start': '2031-04-03', 'calibration_start': '2031-04-11', 'calibration_end': '2031-04-30',
                'eval_start': '2031-05-06', 'eval_end': '2031-05-08'}
        # Under-supported job is a terminal audited result.
        short = {**plan, 'calibration_start': '2031-04-29', 'eval_start': '2031-05-10', 'eval_end': '2031-05-12'}
        job = self.service.start_learning_job('super', short)['job_id']
        self.assertIsNone(self.service.run_learning_job('super', job)['model_id'])
        self.assertIn('Insufficient approved calibration', self.service.learning_job_status('super', job)['detail'])
        job = self.service.start_learning_job('super', plan)['job_id']
        with self.assertRaises(ValueError):
            self.service.start_learning_job('super', plan)
        candidate = self.service.run_learning_job('super', job)['model_id']
        self.assertIsNotNone(candidate)
        blocked = self.service.model_comparison('super', job)
        self.assertFalse(blocked['eligible_for_promotion'])
        with self.assertRaises(ValueError):
            self.service.decide_model('super', job, 'activate', 'Insufficient evidence.')
        with self.store.connect() as db:
            row = registry._one(db, 'model', candidate)
            artifact = registry._artifact(row)
            manifest = json.loads(row['metadata'])['manifest']
        self.assertTrue(all(manifest.values()))
        self.assertTrue(all(not (row[0] == M[-1] and '2031-03-17' <= row[1] <= '2031-03-22')
                            for row in manifest['reference']))
        self.assertTrue(set(x[1] for x in manifest['reference']).isdisjoint(x[1] for x in manifest['fit']))
        self.assertTrue(set(x[1] for x in manifest['fit']).isdisjoint(x[1] for x in manifest['calibration']))
        self.assertLess(max(x[1] for x in manifest['calibration']), plan['eval_start'])
        self.assertEqual(len(artifact.ml.feature_names), 62)
        self.assertEqual(artifact.reference.last_date.date().isoformat(), '2031-03-30')
        self.assertEqual(len(artifact.hourly_profile(M[0], '2031-05-06')), 24)
        self.assertGreater(artifact.forecast.count_law(M[0], '2031-05-06', 'gamma_poisson').mean(),
                           base_artifact.forecast.count_law(M[0], '2031-05-06', 'gamma_poisson').mean())

        # Isolated evaluation fixture verifies governance against identical paired
        # scores and labels. The real refit is scored separately below.
        anomalies = {(M[0], '2031-05-06'), (M[0], '2031-05-07'), (M[1], '2031-05-08')}
        for date in ('2031-05-06', '2031-05-07', '2031-05-08'):
            self.clock = date
            self.insert(date, drifted=True, anomalies=anomalies)
        with self.store.connect() as db:
            eval_rows = list(db.execute("SELECT * FROM current_observation WHERE day>='2031-05-06' ORDER BY day,merchant"))
        eval_days, events = observations.frames(eval_rows)
        real_scores = [models.score(item, tag, eval_days, events)[0] for item, tag in
                       ((base_artifact, baseline), (artifact, candidate))]
        for tag, result in zip(('frozen', 'updated'), real_scores):
            counts = sum(registry.evaluation.alert(value) for key, value in result.items() if key not in anomalies)
            hits = sum(registry.evaluation.alert(result[key]) for key in anomalies)
            mae = sum(abs(value['forecast_error']) for value in result.values()) / len(result)
            print(f'Synthetic {tag}: false alerts={counts}/27, anomaly days={hits}/3, count MAE={mae:.2f}.')
        stamp = pd.Timestamp('2031-05-06')
        pinned_version = base_artifact.reference.version
        open_incident = Incident(M[0], Phase.ACTIVE, pinned_version=pinned_version, candidate_on='2031-05-05',
                                 incident_id='previous-incident', direction='drop', last_day=stamp - pd.Timedelta(days=1))
        pin_score, pin_state = models.score(artifact, candidate, eval_days.loc[eval_days.date.eq(stamp)], events,
                                            prior_states={M[0]: MerchantState(open_incident)},
                                            snapshots={pinned_version: base_artifact.reference})
        self.assertEqual(pin_score[M[0], '2031-05-06']['reference_version'], pinned_version)
        self.assertEqual(pin_state[M[0]].incident.incident_id, 'previous-incident')
        with self.store.connect() as db:
            earlier = [r['day'] for r in db.execute("SELECT DISTINCT day FROM current_observation WHERE day<'2031-05-06' ORDER BY day")]
        # Operational history is auditable. Synthetic fixed scores isolate promotion rules
        # from how one particular forest fits this small simulated scenario.
        def fixed(item, version, days, events, **kwargs):
            readings = {}
            for current in days.itertuples():
                stamp = current.date.date().isoformat()
                key = (current.merchant_id, stamp)
                value = key in anomalies
                readings[key] = {'phase': 'normal', 'model_version': version, 'reference_version': item.reference.version,
                                 'sequential_score': 2. if value else .1, 'sequential_flag': value,
                                 'sequential_threshold': 1., 'hybrid_score': 2. if value else .1,
                                 'hybrid_threshold': 1., 'hybrid_flag': value, 'forecasts': {}}
            return readings, {}
        with patch.object(models, 'score', side_effect=fixed):
            for date in earlier:
                self.service.score_operational_batch('super', date)
            for date in ('2031-05-06', '2031-05-07', '2031-05-08'):
                self.service.score_operational_batch('super', date)
                self.assertTrue(self.service.shadow_batch('super', job, date)['prospective'])
                for merchant in M:
                    self.label(merchant, date, label='confirmed_anomaly' if (merchant, date) in anomalies else 'verified_normal')
        self.assertTrue(self.service.model_comparison('super', job)['eligible_for_promotion'])
        with self.assertRaises(PermissionError):
            self.service.decide_model('review', job, 'activate', 'Unauthorized.')
        self.assertEqual(self.service.decide_model('super', job, 'activate', 'Simulated gate passed.')['active_model'], candidate)
        active_version = lambda: next(model for model in self.service.model_registry('super')['models']
                                      if model['state'] == 'active')
        self.assertEqual(active_version()['training_integrity'], 'current')
        self.label(M[0], '2031-03-25', label='confirmed_anomaly', expected=1, approve=False)
        self.assertEqual(active_version()['training_integrity'], 'recheck_required')
        self.assertEqual(self.service.rollback('super', expected_active=candidate, reason='Simulated rollback.')['active_model'], baseline)
        with self.assertRaises(ValueError):
            self.service.rollback('super', expected_active=baseline, reason='No earlier version.')
        plan = {**plan, 'eval_start': '2031-05-13', 'eval_end': '2031-05-15', 'refit_isolation_forest': False}
        job = self.service.start_learning_job('super', plan)['job_id']
        model = self.service.run_learning_job('super', job)['model_id']
        self.assertIsNotNone(model)
        self.assertEqual(self.service.decide_model('super', job, 'reject', 'Simulated rejection.')['state'], 'rejected')


if __name__ == '__main__':
    unittest.main()
