"""Budgeted, deterministic review assignments, with a separate random audit sample."""

import json
from random import Random

from .feedback import current_feedback
from .observations import effective
from .store import authorize, day, dump, now


def select(rows, policy, stamp, prior_incidents=()):
    seen = set(prior_incidents)
    candidates = [r for r in sorted(rows, key=lambda r: r['merchant_id']) if r['incident_id'] not in seen]
    audit_pool = [r for r in candidates if r['apparently_normal']]
    random_count = min(policy['daily_review_budget'], policy['random_review_slots'], len(audit_pool))
    rng = Random(f"{policy['review_seed']}:{stamp}")
    audited = rng.sample(audit_pool, random_count)
    result = [{**r, 'selection_reason': ['random_normal_audit'], 'priority': 'routine',
               'selection_probability': random_count / len(audit_pool), 'random_pool_size': len(audit_pool)}
              for r in audited]
    merchants = {r['merchant_id'] for r in audited}
    channels = {r['channel'] for r in audited}
    symptoms = {r['symptom'] for r in audited}
    seen.update(r['incident_id'] for r in audited if r['incident_id'])
    while len(result) < policy['daily_review_budget']:
        options = []
        for row in candidates:
            if row['merchant_id'] in merchants or row['incident_id'] in seen or not row['reasons']:
                continue
            diversity = int(row['channel'] not in channels) + int(row['symptom'] not in symptoms)
            options.append((row['utility'] + 0.75 * diversity, row))
        if not options:
            break
        _, chosen = min(options, key=lambda item: (-item[0], item[1]['merchant_id']))
        result.append({**chosen, 'selection_reason': chosen['reasons'],
                       'priority': 'high' if chosen['utility'] >= 3 else 'standard',
                       'selection_probability': None, 'random_pool_size': None})
        merchants.add(chosen['merchant_id'])
        channels.add(chosen['channel'])
        symptoms.add(chosen['symptom'])
        if chosen['incident_id']:
            seen.add(chosen['incident_id'])
    return [{k: v for k, v in row.items() if k not in {'utility', 'reasons', 'apparently_normal'}} for row in result]


def candidate(obs, policy):
    payload = json.loads(obs['payload'])
    ev = payload['evidence']
    channels = {}
    for event in payload['events']:
        channel = event['channel']
        channels[channel] = channels.get(channel, 0) + 1
    top = min(channels, key=lambda channel: (-channels[channel], channel)) if channels else 'none'
    measured_hybrid = ev['hybrid_score'] is not None
    threshold = ev['sequential_threshold']
    proximity = None if not threshold or ev['sequential_score'] is None else abs(ev['sequential_score'] / threshold - 1)
    rank = ev['ml_tail_rank']
    reasons = []
    utility = 0.
    if ev['collective']:
        reasons.append('collective_advisory')
        utility += 4
    if ev['reference_hold'] or ev['sequential_flag']:
        reasons.append('incident_or_sequential_alert')
        utility += 3
    if measured_hybrid and ev['sequential_flag'] != ev['hybrid_flag']:
        reasons.append('detector_disagreement')
        utility += 3
    if proximity is not None and proximity <= policy['threshold_band']:
        reasons.append('near_sequential_threshold')
        utility += 1 + (1 - proximity / policy['threshold_band'])
    if rank is not None and rank <= policy['novelty_tail_rank']:
        reasons.append('unusual_feature_combination')
        utility += 2 + (1 - rank / policy['novelty_tail_rank'])
    if payload['quality_issue']:
        reasons.append('data_quality')
        utility += 3
    return {'merchant_id': obs['merchant'], 'date': obs['day'], 'observation_revision': obs['revision'],
            'incident_id': ev['incident_id'], 'model_evidence': ev, 'channel': top,
            'symptom': ev['symptom'] or 'unclassified', 'utility': utility, 'reasons': reasons,
            'apparently_normal': ev['phase'] == 'normal' and ev['sequential_score'] is not None
            and not reasons and not ev['hybrid_flag']}


def queue(store, actor, stamp, policy):
    authorize(actor)
    stamp = day(stamp)
    with store.connect(write=True) as db:
        assignment = db.execute('SELECT payload FROM review_day WHERE day=?', (stamp,)).fetchone()
        if assignment:
            selected = json.loads(assignment['payload'])
        else:
            authorize(actor, supervisor=True, global_scope=True)
            all_rows = effective(db, list(db.execute(
                'SELECT * FROM current_observation WHERE day=? ORDER BY merchant', (stamp,))))
            if not all_rows:
                return []
            labels = current_feedback(db)
            rows = [candidate(obs, policy) for obs in all_rows if (obs['merchant'], obs['day']) not in labels]
            prior = {item['incident_id'] for row in db.execute('SELECT payload FROM review_day WHERE day<?', (stamp,))
                     for item in json.loads(row['payload']) if item['incident_id']}
            # Assign days in order so a previously selected episode cannot reappear.
            latest = db.execute('SELECT MAX(day) FROM review_day').fetchone()[0]
            if latest and latest > stamp:
                raise ValueError('Daily review assignments must be created chronologically.')
            selected = select(rows, policy, stamp, prior)
            db.execute('INSERT INTO review_day VALUES (?,?,?)', (stamp, now(), dump(selected)))
        return [item for item in selected if actor.merchants is None or item['merchant_id'] in actor.merchants]

