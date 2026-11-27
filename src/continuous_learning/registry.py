"""On-demand fitting, paired shadow scoring, activation and rollback."""

import json
import pickle
from time import perf_counter
from uuid import uuid4

import pandas as pd

from . import evaluation, models
from .feedback import current_feedback, eligibility
from .observations import archive_end, frames
from .store import authorize, day, dump, fingerprint, now, safe_text

DATE_FIELDS = ('fit_start', 'calibration_start', 'calibration_end', 'eval_start', 'eval_end')


def _one(db, table, key):
    # Table names are internal constants, never request data.
    row = db.execute(f'SELECT * FROM {table} WHERE id=?', (key,)).fetchone()
    if row is None:
        raise LookupError('Unknown learning resource.')
    return row


def _active(db):
    row = db.execute("SELECT * FROM model WHERE state='active'").fetchone()
    if row is None:
        raise ValueError('Initialize the operational baseline first.')
    return row


def _artifact(row):
    # Serialized only by this worker. Never deserialize API input or external model files.
    return pickle.loads(row['artifact'])


def _audit(db, model, previous, action, actor, reason, effective_day=None):
    db.execute('''INSERT INTO model_action(model_id,prior_id,action,actor,at,reason,effective_day)
                  VALUES (?,?,?,?,?,?,?)''', (model, previous, action, actor, now(), reason, effective_day))


def _effective_day(db):
    dates = [now()[:10], db.execute('SELECT MAX(day) FROM current_observation').fetchone()[0]]
    return (pd.Timestamp(max(d for d in dates if d)) + pd.Timedelta(days=1)).date().isoformat()


def initialize(store, actor, reason, policy):
    user = authorize(actor, supervisor=True, global_scope=True)
    reason = safe_text(reason)
    with store.connect() as db:
        if db.execute('SELECT 1 FROM model').fetchone():
            raise ValueError('The operational baseline has already been initialized.')
    artifact, details = models.bootstrap(policy['forecast_draws'])
    model_id = 'operational-baseline-' + uuid4().hex[:12]
    with store.connect(write=True) as db:
        if db.execute('SELECT 1 FROM model').fetchone():
            raise ValueError('The operational baseline has already been initialized.')
        db.execute('INSERT INTO model VALUES (?,?,?,?)', (model_id, 'active', dump(details), pickle.dumps(artifact)))
        _audit(db, model_id, None, 'initialize', user, reason)
    return model_id


def start(store, actor, plan, policy):
    user = authorize(actor, supervisor=True, global_scope=True)
    if set(plan) - {*DATE_FIELDS, 'refit_isolation_forest'} or any(key not in plan for key in DATE_FIELDS):
        raise ValueError('Invalid learning plan fields.')
    plan = {**plan, **{name: day(plan[name]) for name in DATE_FIELDS}}
    plan.setdefault('refit_isolation_forest', True)
    if not isinstance(plan['refit_isolation_forest'], bool):
        raise ValueError('Refit must be a Boolean.')
    fit_start, cal_start, cal_end, eval_start, eval_end = (plan[name] for name in DATE_FIELDS)
    started = now()
    if not archive_end() < fit_start < cal_start <= cal_end < eval_start <= eval_end or cal_end >= started[:10]:
        raise ValueError('Use distinct chronological fitting, calibration and evaluation periods.')
    if (pd.Timestamp(eval_end) - pd.Timestamp(eval_start)).days > 90:
        raise ValueError('Evaluation windows are limited to 91 days.')
    job_id = uuid4().hex
    with store.connect(write=True) as db:
        active = _active(db)
        if db.execute('SELECT 1 FROM evaluation_window WHERE start_day <= ? AND end_day >= ?',
                      (eval_end, eval_start)).fetchone():
            raise ValueError('Evaluation windows may not overlap.')
        # A managed run may be retrospective for diagnostics. Such a window cannot qualify for activation.
        cutoff = min(eval_start, started[:10])
        if cal_end >= cutoff:
            raise ValueError('Fitting and calibration must predate the evaluation and job registration.')
        db.execute('INSERT INTO learning_job VALUES (?,?,?,?,?,?,?,?,?,?)',
                   (job_id, 'queued', user, started, dump(plan), dump(policy), active['id'], None, None, None))
        db.execute('INSERT INTO evaluation_window VALUES (?,?,?)', (job_id, eval_start, eval_end))
    return job_id


def _inputs(db, job):
    plan, policy = json.loads(job['plan']), json.loads(job['policy'])
    fit_at, cal_at, cal_end, eval_start, _ = (plan[name] for name in DATE_FIELDS)
    learned_by = min(eval_start, job['created_at'][:10])
    seed_eligible = eligibility(db, policy, fit_at)
    fitted_eligible = eligibility(db, policy, learned_by)
    # Later corrections and newly identified episode buffers invalidate even previously approved rows.
    current = {(obs['merchant'], obs['day']) for obs, _, why in
               eligibility(db, policy, (pd.Timestamp(now()[:10]) + pd.Timedelta(days=1)).date().isoformat())
               if why == 'eligible'}
    sections = {'reference': [], 'fit': [], 'calibration': []}
    manifest = {name: [] for name in sections}
    reference_approved = {(obs['merchant'], obs['day']): label['revision'] for obs, label, reason in seed_eligible
                          if reason == 'eligible'}
    for obs, label, reason in fitted_eligible:
        key = obs['merchant'], obs['day']
        stamp = key[1]
        if reason != 'eligible' or key not in current or stamp > cal_end:
            continue
        if stamp < fit_at:
            if reference_approved.get(key) != label['revision']:
                continue
            name = 'reference'
        elif stamp < cal_at:
            if not plan['refit_isolation_forest']:
                continue
            name = 'fit'
        else:
            name = 'calibration'
        sections[name].append(obs)
        manifest[name].append([*key, obs['revision'], obs['digest'], label['revision']])
    return plan, policy, sections, manifest, seed_eligible


def _valid_training(db, row):
    metadata = json.loads(row['metadata'])
    if 'manifest' not in metadata:
        return True
    job = db.execute('SELECT * FROM learning_job WHERE model_id=?', (row['id'],)).fetchone()
    if _inputs(db, job)[3] != metadata['manifest']:
        return False
    parent = metadata.get('parent_ml')
    return parent is None or _valid_training(db, _one(db, 'model', parent))


def _fit_job(db, job):
    plan, policy, sections, manifest, seed_eligible = _inputs(db, job)
    for name, minimum in [('reference', policy['min_reference_rows']), ('fit', policy['min_fit_rows']),
                          ('calibration', policy['min_calibration_rows'])]:
        rows = sections[name]
        if name == 'fit' and not plan['refit_isolation_forest']:
            continue
        if len(rows) < minimum or len({r['merchant'] for r in rows}) < policy['min_merchants']:
            raise ValueError(f'Insufficient approved {name} observations.')
    if len({r['day'] for r in sections['calibration']}) < policy['min_calibration_dates']:
        raise ValueError('Insufficient independent calibration dates.')
    histories, events = {}, []
    for name, rows in sections.items():
        if rows:
            days, transactions = frames(rows)
            histories[name] = days
            events.append(transactions)
    prior_row = _one(db, 'model', job['champion'])
    reference_only = not plan['refit_isolation_forest']
    if reference_only and not _valid_training(db, prior_row):
        raise ValueError('Insufficient approved provenance for the inherited Isolation Forest weights.')
    fixed_ml = _artifact(prior_row).ml if reference_only else None
    seed = models.reviewed_reference(sections['reference'], seed_eligible)
    artifact, details = models.fit(histories['reference'], histories.get('fit'), histories['calibration'],
                                  pd.concat(events, ignore_index=True), pd.Timestamp(plan['fit_start']),
                                  plan['calibration_end'], policy['forecast_draws'], reviews=seed,
                                  fixed_ml=fixed_ml)
    details.update(dataset_fingerprints={name: fingerprint(rows) for name, rows in manifest.items()},
                   feedback_dataset_version=fingerprint([[r[0], r[1], r[-1]] for rows in manifest.values() for r in rows]),
                   reference_last_day=artifact.reference.last_date.date().isoformat(),
                   training_rows={name: len(rows) for name, rows in sections.items()},
                   plan=plan, policy=policy, champion=job['champion'], parent_ml=job['champion'] if reference_only else None,
                   manifest=manifest)
    return artifact, details


def run(store, actor, job_id):
    authorize(actor, supervisor=True, global_scope=True)
    with store.connect(write=True) as db:
        job = _one(db, 'learning_job', job_id)
        if job['state'] != 'queued':
            raise ValueError('Only a queued job may be started.')
        db.execute("UPDATE learning_job SET state='running' WHERE id=?", (job_id,))
    try:
        with store.connect() as db:
            artifact, details = _fit_job(db, job)
        model_id = 'challenger-' + uuid4().hex[:12]
        with store.connect(write=True) as db:
            if _one(db, 'learning_job', job_id)['state'] != 'running':
                return None
            if _inputs(db, job)[3] != details['manifest'] or (
                    details['parent_ml'] and not _valid_training(db, _one(db, 'model', details['parent_ml']))):
                raise ValueError('Training eligibility changed during fitting. Start a new job.')
            db.execute('INSERT INTO model VALUES (?,?,?,?)',
                       (model_id, 'challenger', dump(details), pickle.dumps(artifact)))
            db.execute("UPDATE learning_job SET state='succeeded', finished_at=?, model_id=? WHERE id=?",
                       (now(), model_id, job_id))
    except Exception as error:
        # Persist only safe errors from the training gate, never source values or stack traces.
        detail = str(error) if type(error) is ValueError and str(error).startswith(
            ('Insufficient approved', 'Insufficient independent', 'Insufficient calibration', 'Training eligibility')
        ) else 'Learning worker failed.'
        with store.connect(write=True) as db:
            db.execute("UPDATE learning_job SET state='failed', finished_at=?, detail=? WHERE id=? AND state='running'",
                       (now(), detail, job_id))
        if detail == 'Learning worker failed.':
            raise
        return None
    return model_id


def cancel(store, actor, job_id):
    authorize(actor, supervisor=True, global_scope=True)
    with store.connect(write=True) as db:
        job = _one(db, 'learning_job', job_id)
        if job['state'] not in {'queued', 'running'}:
            raise ValueError('Only queued or running jobs may be cancelled.')
        db.execute("UPDATE learning_job SET state='cancelled', finished_at=?, detail=? WHERE id=?",
                   (now(), f'Cancelled by {actor.user_id}.', job_id))


def status(store, actor, job_id):
    authorize(actor, supervisor=True, global_scope=True)
    with store.connect() as db:
        result = dict(_one(db, 'learning_job', job_id))
    return {**result, 'plan': json.loads(result['plan']), 'policy': json.loads(result['policy'])}


def _scheduled_model(db, stamp):
    event = db.execute("""SELECT model_id, effective_day FROM model_action
                          WHERE action='initialize' OR (action IN ('activate','rollback') AND effective_day<=?)
                          ORDER BY COALESCE(effective_day,'' ) DESC, seq DESC LIMIT 1""", (stamp,)).fetchone()
    if event is None:
        raise ValueError('Initialize the operational baseline first.')
    return event


def operational_batch(store, actor, observation_day):
    authorize(actor, supervisor=True, global_scope=True)
    stamp = day(observation_day)
    with store.connect(write=True) as db:
        latest = db.execute('SELECT * FROM operational_batch ORDER BY day DESC LIMIT 1').fetchone()
        if latest and latest['day'] >= stamp:
            if latest['day'] == stamp:
                return {'date': stamp, 'model_id': latest['model_id'], 'rows_scored': len(json.loads(latest['evidence']))}
            raise ValueError('Operational batches must be scored in chronological order.')
        if db.execute('SELECT 1 FROM current_observation WHERE day>? AND day<? LIMIT 1',
                      (latest['day'] if latest else archive_end(), stamp)).fetchone():
            raise ValueError('Score earlier closed operational batches before this one.')
        scheduled = _scheduled_model(db, stamp)
        artifact = _artifact(_one(db, 'model', scheduled['model_id']))
        # Include the first date of a new reference epoch in the feature context.
        rows = list(db.execute('''SELECT * FROM current_observation
                                  WHERE day>? AND day>=? AND day<=? ORDER BY day,merchant''',
                               (artifact.calibration_end, scheduled['effective_day'] or '', stamp)))
        current = [row for row in rows if row['day'] == stamp]
        if not current:
            raise LookupError('No closed learning batch on this date.')
        states, snapshots = pickle.loads(latest['checkpoint']) if latest else ({}, {})
        days, events = frames(rows)
        started = perf_counter()
        output, states = models.score(artifact, scheduled['model_id'], days, events, prior_states=states,
                                      snapshots=snapshots, forecast_from=stamp, score_from=stamp)
        evidence = {r['merchant']: {'revision': r['revision'], 'model_evidence': output[r['merchant'], stamp]}
                    for r in current}
        snapshots[artifact.reference.version] = artifact.reference
        retained = {state.incident.pinned_version for state in states.values()} | {artifact.reference.version}
        snapshots = {version: value for version, value in snapshots.items() if version in retained}
        db.execute('INSERT INTO operational_batch VALUES (?,?,?,?,?,?)',
                   (stamp, scheduled['model_id'], now(), dump(evidence), pickle.dumps((states, snapshots)),
                    perf_counter() - started))
    return {'date': stamp, 'model_id': scheduled['model_id'], 'rows_scored': len(evidence)}


def operational_predictions(store, actor, observation_day):
    authorize(actor)
    stamp = day(observation_day)
    with store.connect() as db:
        row = db.execute('SELECT model_id,evidence FROM operational_batch WHERE day=?', (stamp,)).fetchone()
        if row is None:
            raise LookupError('No operational predictions on this date.')
        observations = list(db.execute('SELECT merchant,revision FROM current_observation WHERE day=?', (stamp,)))
    evidence = json.loads(row['evidence'])
    return {'date': stamp, 'model_id': row['model_id'], 'rows': [
        {'merchant_id': obs['merchant'], 'observation_revision': evidence[obs['merchant']]['revision'],
         'superseded': obs['revision'] != evidence[obs['merchant']]['revision'],
         **evidence[obs['merchant']]['model_evidence']}
        for obs in observations if obs['merchant'] in evidence and
        (actor.merchants is None or obs['merchant'] in actor.merchants)]}


def forecast(store, actor, merchant, origin):
    authorize(actor, merchant=merchant)
    origin = day(origin)
    with store.connect() as db:
        scheduled = _scheduled_model(db, origin)
        artifact = _artifact(_one(db, 'model', scheduled['model_id']))
    if origin <= artifact.calibration_end:
        raise ValueError('The forecast origin must follow calibration.')
    from src.operations.forecasting import seven_day_forecast
    values = seven_day_forecast(artifact.forecast, origin, [merchant], draws=artifact.forecast_draws)
    return {'model_id': scheduled['model_id'], 'reference_version': artifact.reference.version, 'forecast': values,
            'intraday_hourly_weights': artifact.hourly_profile(merchant, origin)}


def _score(db, artifact, model_id, through, from_day):
    rows = list(db.execute('''SELECT * FROM current_observation WHERE day>? AND day<=? ORDER BY day,merchant''',
                           (artifact.calibration_end, through)))
    if not rows:
        return {}
    days, events = frames(rows)
    return models.score(artifact, model_id, days, events, forecast_from=from_day)[0]


def shadow(store, actor, job_id, observation_day):
    authorize(actor, supervisor=True, global_scope=True)
    stamp = day(observation_day)
    with store.connect(write=True) as db:
        job = _one(db, 'learning_job', job_id)
        plan = json.loads(job['plan'])
        if job['state'] != 'succeeded' or not plan['eval_start'] <= stamp <= plan['eval_end']:
            raise ValueError('The job has no challenger for this date.')
        if db.execute('SELECT 1 FROM shadow WHERE job_id=? AND day=?', (job_id, stamp)).fetchone():
            raise ValueError('The immutable shadow batch has already been scored.')
        latest = db.execute('SELECT MAX(day) FROM shadow WHERE job_id=?', (job_id,)).fetchone()[0]
        if latest and stamp <= latest:
            raise ValueError('Shadow batches must be scored in date order.')
        rows = list(db.execute('SELECT * FROM current_observation WHERE day=? ORDER BY merchant', (stamp,)))
        if not rows:
            raise LookupError('No closed learning batch on this date.')
        operational = db.execute('SELECT * FROM operational_batch WHERE day=?', (stamp,)).fetchone()
        actual = json.loads(operational['evidence']) if operational and operational['model_id'] == job['champion'] else {}
        use_actual = bool(actual) and set(actual) == {r['merchant'] for r in rows} and all(
            actual[r['merchant']]['revision'] == r['revision'] for r in rows)
        scores, times = {}, {}
        for role, model_id in [('champion', job['champion']), ('challenger', job['model_id'])]:
            started = perf_counter()
            if role == 'champion' and use_actual:
                scores[role] = {(merchant, stamp): r['model_evidence'] for merchant, r in actual.items()}
                # Scoring cost is captured by the operational worker.
                times[role] = operational['scoring_seconds']
            else:
                scores[role] = _score(db, _artifact(_one(db, 'model', model_id)), model_id, stamp, stamp)
                times[role] = perf_counter() - started
        scored_at = now()
        prospective = (use_actual and job['finished_at'][:10] < plan['eval_start'] and
                       all(row['ingested_at'] > job['finished_at'] for row in rows))
        payload = {'date': stamp, 'scored_at': scored_at, 'prospective': prospective, 'scoring_seconds': times,
                   'context_fingerprint': _context_fingerprint(db, stamp),
                   'rows': [{'merchant': row['merchant'], 'revision': row['revision'], 'digest': row['digest'],
                             **{role: output[row['merchant'], stamp] for role, output in scores.items()}}
                            for row in rows]}
        db.execute('INSERT INTO shadow VALUES (?,?,?,?)', (job_id, stamp, scored_at, dump(payload)))
    return {'date': stamp, 'rows_scored': len(rows), 'prospective': prospective, 'scoring_seconds': times}


def _context_fingerprint(db, through):
    return fingerprint([list(row) for row in db.execute(
        'SELECT merchant,day,revision,digest FROM current_observation WHERE day<=? ORDER BY day,merchant', (through,))])


def _comparison(db, job):
    start, end = (json.loads(job['plan'])[key] for key in ('eval_start', 'eval_end'))
    rows = db.execute('SELECT * FROM current_observation WHERE day BETWEEN ? AND ?', (start, end))
    observations = {(row['merchant'], row['day']): row for row in rows}
    batches = [json.loads(row['payload']) for row in db.execute('SELECT payload FROM shadow WHERE job_id=? ORDER BY day',
                                                              (job['id'],))]
    result = evaluation.compare(batches, observations, current_feedback(db), json.loads(job['plan']), json.loads(job['policy']))
    if any(packet['context_fingerprint'] != _context_fingerprint(db, packet['date']) for packet in batches):
        result['blockers'].append('scoring_history_changed')
    if _active(db)['id'] != job['champion']:
        result['blockers'].append('champion_changed')
    challenger = _one(db, 'model', job['model_id'])
    if challenger['state'] != 'challenger':
        result['blockers'].append('model_is_not_pending')
    if not _valid_training(db, challenger):
        result['blockers'].append('training_eligibility_changed')
    result['eligible_for_promotion'] = not result['blockers']
    db.execute('INSERT INTO comparison(job_id,at,payload) VALUES (?,?,?)', (job['id'], now(), dump(result)))
    return result


def comparison(store, actor, job_id):
    authorize(actor, supervisor=True, global_scope=True)
    with store.connect(write=True) as db:
        job = _one(db, 'learning_job', job_id)
        if job['state'] != 'succeeded':
            raise ValueError('A fitted challenger is required.')
        return _comparison(db, job)


def _switch(db, model, champion, action, user, reason):
    effective = _effective_day(db)
    db.execute("UPDATE model SET state='archived' WHERE id=?", (champion,))
    db.execute("UPDATE model SET state='active' WHERE id=?", (model,))
    _audit(db, model, champion, action, user, reason, effective)
    return {'active_model': model, 'previous_model': champion, 'effective_day': effective}


def decide(store, actor, job_id, decision, reason):
    user = authorize(actor, supervisor=True, global_scope=True)
    reason = safe_text(reason)
    if decision not in {'activate', 'reject'}:
        raise ValueError('Choose activate or reject.')
    with store.connect(write=True) as db:
        job = _one(db, 'learning_job', job_id)
        if job['state'] != 'succeeded' or _one(db, 'model', job['model_id'])['state'] != 'challenger':
            raise ValueError('Only a pending challenger can be decided.')
        if decision == 'reject':
            db.execute("UPDATE model SET state='rejected' WHERE id=?", (job['model_id'],))
            _audit(db, job['model_id'], job['champion'], 'reject', user, reason)
            return {'model_id': job['model_id'], 'state': 'rejected'}
        result = _comparison(db, job)
        if result['eligible_for_promotion']:
            return _switch(db, job['model_id'], job['champion'], 'activate', user, reason)
        _audit(db, job['model_id'], job['champion'], 'activation_blocked', user, reason)
    raise ValueError('Challenger blocked: ' + ', '.join(result['blockers']))


def rollback(store, actor, *, expected_active, reason):
    user = authorize(actor, supervisor=True, global_scope=True)
    reason = safe_text(reason)
    with store.connect(write=True) as db:
        active = _active(db)['id']
        previous = db.execute("""SELECT prior_id FROM model_action WHERE model_id=? AND action='activate'
                                 ORDER BY seq DESC LIMIT 1""", (active,)).fetchone()
        last_switch = db.execute("""SELECT action FROM model_action WHERE action IN ('activate','rollback')
                                    ORDER BY seq DESC LIMIT 1""").fetchone()
        if active != expected_active or not previous or last_switch['action'] != 'activate':
            raise ValueError('No previous approved operational version for this activation.')
        return _switch(db, previous['prior_id'], active, 'rollback', user, reason)


def inventory(store, actor):
    authorize(actor, supervisor=True, global_scope=True)
    with store.connect() as db:
        versions = []
        for row in db.execute('SELECT id,state,metadata FROM model ORDER BY rowid'):
            meta = json.loads(row['metadata'])
            manifest = meta.pop('manifest', None)
            integrity = None
            if row['state'] == 'active':
                if manifest is None:
                    integrity = 'archived_seed'
                else:
                    integrity = 'current' if _valid_training(db, row) else 'recheck_required'
            versions.append({'model_id': row['id'], 'state': row['state'], 'metadata': meta,
                             'training_integrity': integrity})
        actions = [dict(row) for row in db.execute('SELECT * FROM model_action ORDER BY seq')]
    return {'models': versions, 'approval_history': actions}

