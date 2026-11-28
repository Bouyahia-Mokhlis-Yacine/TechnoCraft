"""Authenticated backend contracts for a server adapter or a managed worker."""

from collections import Counter
import json
from pathlib import Path

from . import drift, feedback, observations, registry, review_queue
from .store import NORMAL, ROOT, Store, authorize, day, fingerprint


class LearningService:
    """Resolve an opaque credential using server-owned account and merchant grants."""

    def __init__(self, resolve_identity, *, directory=None, policy_path=None):
        self.resolve_identity = resolve_identity
        self.store = Store(directory)
        self.policy = json.loads(Path(policy_path or ROOT / 'config/continuous_learning.v1.json').read_text(encoding='utf-8'))
        p = self.policy
        if (not 0 <= p['random_review_slots'] <= p['daily_review_budget'] or p['daily_review_budget'] < 1
                or p['threshold_band'] <= 0 or not 0 < p['novelty_tail_rank'] <= 1
                or not 0 < p['drift_min_calendar_match_fraction'] <= 1
                or min(p['quarantine_lead_days'], p['quarantine_recovery_days']) < 0 or p['forecast_draws'] < 64):
            raise ValueError('Invalid continuous learning policy.')

    def _actor(self, credential):
        actor = self.resolve_identity(credential)
        authorize(actor)
        return actor

    def ingest_import(self, credential, run_id, *, corrections=()):
        revisions = {(row['merchant_id'], day(row['date'])): row['expected_revision'] for row in corrections}
        if len(revisions) != len(corrections):
            raise ValueError('Duplicate correction keys.')
        return {'inserted': observations.ingest_import(self.store, self._actor(credential), run_id, corrections=revisions)}

    def review_queue(self, credential, observation_day):
        return review_queue.queue(self.store, self._actor(credential), observation_day, self.policy)

    def submit_feedback(self, credential, merchant_id, observation_day, **fields):
        return {'revision': feedback.submit(self.store, self._actor(credential), merchant_id, observation_day, **fields)}

    def decide_feedback(self, credential, merchant_id, observation_day, **fields):
        feedback.decide(self.store, self._actor(credential), merchant_id, observation_day, **fields)

    def feedback_history(self, credential, merchant_id, observation_day):
        return feedback.history(self.store, self._actor(credential), merchant_id, observation_day)

    def feedback_statistics(self, credential):
        actor = self._actor(credential)
        with self.store.connect() as db:
            rows = Store.scoped(db.execute('''SELECT f.* FROM current_feedback f
                                  JOIN current_observation o USING (merchant,day)
                                  WHERE f.observation_revision=o.revision'''), actor)
        return {'current_labels': dict(Counter(r['label'] for r in rows)),
                'approval_statuses': dict(Counter(r['approval'] for r in rows)), 'total': len(rows)}

    def training_eligibility(self, credential, as_of):
        actor = self._actor(credential)
        with self.store.connect() as db:
            return [{'merchant_id': obs['merchant'], 'date': obs['day'], 'eligible': reason == 'eligible', 'reason': reason,
                     'observation_revision': obs['revision'], 'feedback_revision': label['revision'] if label else None}
                    for obs, label, reason in feedback.eligibility(db, self.policy, day(as_of))
                    if actor.merchants is None or obs['merchant'] in actor.merchants]

    def drift_report(self, credential, baseline_start, baseline_end, recent_start, recent_end):
        return drift.report(self.store, self._actor(credential), baseline_start, baseline_end, recent_start, recent_end,
                            self.policy)

    def initialize_baseline(self, credential, reason):
        return {'model_id': registry.initialize(self.store, self._actor(credential), reason, self.policy)}

    def start_learning_job(self, credential, plan):
        return {'job_id': registry.start(self.store, self._actor(credential), plan, self.policy), 'state': 'queued'}

    def run_learning_job(self, credential, job_id):
        return {'model_id': registry.run(self.store, self._actor(credential), job_id)}

    def learning_job_status(self, credential, job_id):
        return registry.status(self.store, self._actor(credential), job_id)

    def cancel_learning_job(self, credential, job_id):
        registry.cancel(self.store, self._actor(credential), job_id)

    def score_operational_batch(self, credential, observation_day):
        return registry.operational_batch(self.store, self._actor(credential), observation_day)

    def operational_predictions(self, credential, observation_day):
        return registry.operational_predictions(self.store, self._actor(credential), observation_day)

    def forecast(self, credential, merchant_id, origin):
        return registry.forecast(self.store, self._actor(credential), merchant_id, origin)

    def shadow_batch(self, credential, job_id, observation_day):
        return registry.shadow(self.store, self._actor(credential), job_id, observation_day)

    def model_comparison(self, credential, job_id):
        return registry.comparison(self.store, self._actor(credential), job_id)

    def decide_model(self, credential, job_id, decision, reason):
        return registry.decide(self.store, self._actor(credential), job_id, decision, reason)

    def rollback(self, credential, **fields):
        return registry.rollback(self.store, self._actor(credential), **fields)

    def model_registry(self, credential):
        return registry.inventory(self.store, self._actor(credential))

    def labelled_export(self, credential):
        actor = self._actor(credential)
        with self.store.connect() as db:
            rows = Store.scoped(db.execute('SELECT * FROM current_observation ORDER BY day,merchant'), actor)
            labels = feedback.current_feedback(db)
        exported = []
        for obs in rows:
            label = labels.get((obs['merchant'], obs['day']))
            if feedback.trusted(label, obs) and label['label'] in NORMAL | {'confirmed_anomaly'}:
                exported.append({'merchant_id': obs['merchant'], 'date': obs['day'], 'label': label['label'],
                                 'observation_revision': obs['revision'], 'feedback_revision': label['revision'],
                                 'selection_probability': label['sampling_probability']})
        return {'dataset_version': fingerprint(exported), 'rows': exported}

