"""Feedback revisions, independent decisions, and fail-closed eligibility."""

from datetime import date, timedelta
import json

from .observations import effective
from .store import HOLD_PHASES, LABELS, NORMAL, Store, authorize, day, dump, now, safe_text


def _key(merchant, observation_day, actor):
    merchant = safe_text(merchant, limit=64)
    authorize(actor, merchant=merchant)
    return merchant, day(observation_day)


def submit(store, actor, merchant, observation_day, *, label, notes, evidence=(), category=None, expected_revision=0,
           observation_revision):
    key = _key(merchant, observation_day, actor)
    if label not in LABELS or not isinstance(evidence, (list, tuple)) or len(evidence) > 10:
        raise ValueError('Invalid feedback label or evidence.')
    notes = safe_text(notes)
    evidence = dump([safe_text(text, limit=240) for text in evidence])
    category = safe_text(category, limit=80) if category is not None else None
    with store.connect(write=True) as db:
        obs = Store.observation(db, *key)
        if observation_revision != obs['revision']:
            raise ValueError('The observation revision changed.')
        current = db.execute('SELECT * FROM current_feedback WHERE merchant=? AND day=?', key).fetchone()
        current_revision = current['revision'] if current else 0
        if current_revision != expected_revision:
            raise ValueError('The feedback revision changed.')
        fields = (obs['revision'], actor.user_id, label, category, notes, evidence)
        columns = ('observation_revision', 'reviewer', 'label', 'category', 'notes', 'evidence')
        if current and fields == tuple(current[col] for col in columns):
            return current_revision
        review = db.execute('SELECT payload FROM review_day WHERE day=?', (key[1],)).fetchone()
        entry = next((item for item in json.loads(review['payload']) if item['merchant_id'] == key[0]), {}) if review else {}
        if entry.get('observation_revision') != obs['revision']:
            entry = {}
        model_evidence = entry.get('model_evidence') or json.loads(effective(db, [obs])[0]['payload'])['evidence']
        probability = entry.get('selection_probability')
        revision = current_revision + 1
        db.execute('INSERT INTO feedback VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (*key, revision, obs['revision'], actor.user_id, now(), label, category, notes, evidence,
                    model_evidence['model_version'] or 'unavailable', model_evidence['reference_version'] or 'unavailable',
                    probability))
    return revision


def decide(store, actor, merchant, observation_day, *, revision, decision, reason):
    authorize(actor, supervisor=True)
    key = _key(merchant, observation_day, actor)
    reason = safe_text(reason)
    if decision not in {'approved', 'rejected'}:
        raise ValueError('Unknown approval decision.')
    with store.connect(write=True) as db:
        obs = Store.observation(db, *key)
        current = db.execute('SELECT * FROM current_feedback WHERE merchant=? AND day=?', key).fetchone()
        if (not current or current['revision'] != revision or current['observation_revision'] != obs['revision']
                or current['approval'] != 'pending'):
            raise ValueError('Only the current pending feedback can be decided.')
        if current['reviewer'] == actor.user_id:
            raise PermissionError('Feedback requires an independent supervisor.')
        db.execute('INSERT INTO feedback_decision VALUES (?,?,?,?,?,?,?)',
                   (*key, revision, actor.user_id, now(), decision, reason))


def history(store, actor, merchant, observation_day):
    key = _key(merchant, observation_day, actor)
    with store.connect() as db:
        rows = db.execute('''SELECT f.*, COALESCE(d.decision, 'pending') AS approval,
                             d.actor AS approver, d.at AS decided_at, d.reason AS decision_reason
                             FROM feedback f LEFT JOIN feedback_decision d USING (merchant,day,revision)
                             WHERE f.merchant=? AND f.day=? ORDER BY f.revision''', key)
        return [{**dict(row), 'evidence': json.loads(row['evidence'])} for row in rows]


def current_feedback(db):
    return {(row['merchant'], row['day']): row for row in db.execute('SELECT * FROM current_feedback')}


def decisions_as_of(db, cutoff):
    rows = db.execute('''SELECT f.*, d.at AS decided_at, d.decision AS approval
                         FROM feedback f LEFT JOIN feedback_decision d USING (merchant,day,revision)
                         WHERE substr(f.reviewed_at,1,10) < ?
                         AND f.revision = (SELECT MAX(prior.revision) FROM feedback prior
                           WHERE prior.merchant=f.merchant AND prior.day=f.day
                           AND substr(prior.reviewed_at,1,10) < ?)''', (cutoff, cutoff))
    return {(row['merchant'], row['day']): row for row in rows}


def trusted(row, obs, cutoff=None):
    return bool(row and row['observation_revision'] == obs['revision'] and row['approval'] == 'approved'
                and (cutoff is None or row['decided_at'][:10] < cutoff))


def incident_days(rows, labels, policy):
    """Keep the full lifecycle and a buffer around alerts or any unresolved anomaly allegation."""
    restricted = {}
    for row in rows:
        merchant, stamp = row['merchant'], date.fromisoformat(row['day'])
        evidence = json.loads(row['payload'])['evidence']
        label = labels.get((merchant, row['day']))
        if (evidence['reference_hold'] or evidence['phase'] in HOLD_PHASES or evidence['sequential_flag']
                or (label and label['label'] == 'confirmed_anomaly' and label['approval'] != 'rejected')):
            dates = restricted.setdefault(merchant, set())
            for delta in range(-policy['quarantine_lead_days'], policy['quarantine_recovery_days'] + 1):
                dates.add((stamp + timedelta(days=delta)).isoformat())
    return restricted


def eligibility(db, policy, cutoff):
    """Use the evidence and admissions known before the exclusive as-of day."""
    rows = list(db.execute('''SELECT * FROM current_observation
                              WHERE day < ? AND substr(ingested_at,1,10) < ? ORDER BY day,merchant''', (cutoff, cutoff)))
    past_labels = decisions_as_of(db, cutoff)
    latest = current_feedback(db)
    rows = effective(db, rows, before=cutoff)
    quarantine = incident_days(rows, past_labels, policy)
    windows = list(db.execute('SELECT * FROM evaluation_window'))
    results = []
    for obs in rows:
        key = obs['merchant'], obs['day']
        recorded = past_labels.get(key)
        current = latest.get(key)
        payload = json.loads(obs['payload'])
        evidence = payload['evidence']
        if any(w['start_day'] <= key[1] <= w['end_day'] for w in windows):
            reason = 'reserved_evaluation'
        elif key[1] in quarantine.get(key[0], ()):
            reason = 'incident_or_recovery'
        elif payload['quality_issue'] or (current and current['label'] == 'data_quality_issue'):
            reason = 'data_quality'
        elif evidence['phase'] == 'unavailable':
            reason = 'missing_lifecycle'
        elif evidence['collective'] and not trusted(recorded, obs, cutoff):
            reason = 'unresolved_collective_candidate'
        elif not trusted(recorded, obs, cutoff):
            reason = 'awaiting_approved_feedback'
        elif current['revision'] != recorded['revision'] or recorded['label'] not in NORMAL:
            reason = recorded['label'] if current['revision'] == recorded['revision'] else 'feedback_changed'
        else:
            reason = 'eligible'
        results.append((obs, recorded, reason))
    return results

