"""Allowlisted cleaned events and immutable, revisioned merchant-day observations."""

from hashlib import sha256
import json
import re

import numpy as np
import pandas as pd

from engine import import_batch
from engine.replay import INPUTS
from src.data.aggregation import merchant_days
from src.data.preprocessing import CHANNELS, KEYS, STATUSES, calendar_keys, clean_transactions

from .store import HOLD_PHASES, ROOT, authorize, dump, fingerprint, now, safe_text

EVENT_FIELDS = ['hour', 'amount', 'channel', 'transaction_status', 'merchant_category',
                'missing_amount', 'missing_channel', 'missing_category', 'category_imputed', 'invalid_amount', 'zero_amount']
EVENT_COLUMNS = [*KEYS, *EVENT_FIELDS]
CHANNEL_CODES = (*CHANNELS.values(), 'unknown')
PHASES = HOLD_PHASES | {'normal', 'unavailable'}
EVIDENCE_NUMBERS = ('sequential_score', 'sequential_threshold', 'hybrid_score', 'hybrid_threshold',
                    'ml_tail_rank', 'hybrid_tail_rank', 'count_residual', 'rejection_residual',
                    'cancellation_residual', 'forecast_error',
                    'forecast_covered', 'collective_tail_rank')
EVIDENCE_TEXT = ('model_version', 'reference_version', 'incident_id', 'symptom')
INTERNAL_VERSION = re.compile(r'(?:satim-probabilistic-v[123]-[a-f0-9]{24}|'
                              r'(?:operational-baseline|challenger)-[a-f0-9]{12})')


def archive_end():
    template = ROOT / 'y_pred_template.csv'
    if sha256(template.read_bytes()).hexdigest() != INPUTS[template.name]:
        raise ValueError('Protected competition calendar failed its fingerprint check.')
    return pd.read_csv(template, usecols=['date']).date.max()


def scalar(value):
    if pd.isna(value):
        return None
    if isinstance(value, np.generic):
        return value.item()
    return value


def normalized_evidence(raw):
    result = {'phase': raw.get('phase', 'unavailable')}
    if result['phase'] not in PHASES:
        raise ValueError('Unknown lifecycle phase.')
    for field in EVIDENCE_TEXT:
        value = raw.get(field)
        if field.endswith('_version') and isinstance(value, str) and INTERNAL_VERSION.fullmatch(value):
            result[field] = value
        else:
            result[field] = None if value is None else safe_text(value, limit=120)
    for field in EVIDENCE_NUMBERS:
        value = raw.get(field)
        result[field] = float(value) if value is not None else None
        if value is not None and (not np.isfinite(value) or
                                  ('rank' in field and not 0 < value <= 1)):
            raise ValueError('Invalid observation evidence.')
    for name in ('reference_hold', 'sequential_flag', 'hybrid_flag', 'collective'):
        result[name] = bool(raw.get(name, False))
    return result


def event_payload(values):
    row = dict(zip(EVENT_FIELDS, map(scalar, values), strict=True))
    if row['merchant_category'] is not None:
        row['merchant_category'] = safe_text(row['merchant_category'], limit=120)
    if (row['channel'] not in CHANNEL_CODES or row['transaction_status'] not in (*STATUSES, 'Unknown')
            or not isinstance(row['hour'], int) or not 0 <= row['hour'] < 24):
        raise ValueError('Invalid cleaned transaction.')
    return row


def ingest(store, actor, *, source, calendar, events, evidence, corrections=None):
    """Trusted adapter only. The calendar is an explicit closed and complete roster."""
    authorize(actor, supervisor=True, global_scope=True)
    if not isinstance(source, str) or not re.fullmatch('import:[a-f0-9]{16}', source):
        source = safe_text(source, limit=100)
    calendar = calendar_keys(calendar)
    if calendar.empty or calendar.date.min().date().isoformat() <= archive_end():
        raise ValueError('Only post-competition closed days can enter learning.')
    if calendar.date.max().date().isoformat() > now()[:10]:
        raise ValueError('Closed observations must not be in the future.')
    if not set(EVENT_COLUMNS) <= set(events.columns):
        raise ValueError('Expected cleaned operational events.')
    groups = {}
    for merchant, stamp, *values in events[EVENT_COLUMNS].itertuples(index=False, name=None):
        groups.setdefault((merchant, stamp.date().isoformat()), []).append(event_payload(values))
    keys = [(safe_text(m, limit=64), d.date().isoformat()) for m, d in calendar[KEYS].itertuples(index=False, name=None)]
    if not groups.keys() <= set(keys):
        raise ValueError('Transactions must match the closed roster.')
    corrections = corrections or {}
    inserted = 0
    with store.connect(write=True) as db:
        cursor = db.execute('SELECT MAX(day) FROM operational_batch').fetchone()[0]
        for key in sorted(keys, key=lambda key: (key[1], key[0])):
            lifecycle = normalized_evidence(evidence.get(key, {}))
            records = sorted(groups.get(key, []), key=dump)
            quality = any(r['amount'] is None or r['invalid_amount'] or r['channel'] == 'unknown'
                          or r['transaction_status'] == 'Unknown' for r in records)
            payload = {'events': records, 'evidence': lifecycle, 'quality_issue': quality}
            current = db.execute('SELECT * FROM current_observation WHERE merchant=? AND day=?', key).fetchone()
            if current:
                if fingerprint(payload) == current['digest']:
                    continue
                old = effective(db, [current])[0]
                old = json.loads(old['payload'])['evidence']
                if old['reference_hold'] or old['phase'] in HOLD_PHASES:
                    lifecycle['reference_hold'] = True
                if corrections.get(key) != current['revision']:
                    raise ValueError('An existing merchant-day requires an explicit revision.')
            if not current and cursor and key[1] <= cursor:
                raise ValueError('A scored date cannot receive new merchant-days.')
            revision = current['revision'] + 1 if current else 1
            db.execute('INSERT INTO observation VALUES (?,?,?,?,?,?,?)',
                       (*key, revision, fingerprint(payload), source, now(), dump(payload)))
            inserted += 1
    return inserted


def effective(db, rows, *, before=None):
    """Join immutable operational evidence only to the observation revision it scored."""
    if not rows:
        return rows
    batches = {row['day']: json.loads(row['evidence']) for row in db.execute(
        'SELECT day,evidence FROM operational_batch WHERE day BETWEEN ? AND ? AND (? IS NULL OR substr(scored_at,1,10)<?)',
        (min(r['day'] for r in rows), max(r['day'] for r in rows), before, before))}
    result = []
    for row in rows:
        prediction = batches.get(row['day'], {}).get(row['merchant'])
        if prediction and prediction['revision'] == row['revision']:
            body = json.loads(row['payload'])
            old = body['evidence']
            scored = normalized_evidence(prediction['model_evidence'])
            scored['reference_hold'] |= old['reference_hold'] or old['phase'] in HOLD_PHASES or old['sequential_flag']
            scored['incident_id'] = scored['incident_id'] or old['incident_id']
            scored['collective'] |= old['collective']
            if scored['collective_tail_rank'] is None:
                scored['collective_tail_rank'] = old['collective_tail_rank']
            body['evidence'] = scored
            row = {**dict(row), 'payload': dump(body)}
        result.append(row)
    return result


def frames(rows):
    calendar, events = [], []
    for row in rows:
        key = {'merchant_id': row['merchant'], 'date': pd.Timestamp(row['day'])}
        calendar.append(key)
        events.extend({**key, **event} for event in json.loads(row['payload'])['events'])
    transactions = pd.DataFrame(events, columns=EVENT_COLUMNS).astype({
        'amount': 'float64', 'merchant_id': 'string', 'merchant_category': 'string', 'hour': 'int64',
        **{field: 'bool' for field in EVENT_FIELDS[5:]},
    })
    transactions['date'] = pd.to_datetime(transactions.date)
    days = merchant_days(transactions, pd.DataFrame(calendar, columns=KEYS), pd.Series(dtype='string'))
    return days, transactions


def ingest_import(store, actor, run_id, *, corrections=None):
    """Read a successful operational import. Incomplete or mixed imports stay outside learning."""
    authorize(actor, supervisor=True, global_scope=True)
    if not isinstance(run_id, str) or not re.fullmatch('[a-f0-9]{16}', run_id):
        raise ValueError('Invalid import run identifier.')
    folder = import_batch.imports_dir() / run_id
    status = json.loads((folder / 'status.json').read_text(encoding='utf-8'))
    spec = json.loads((folder / 'spec.json').read_text(encoding='utf-8'))
    snapshot = json.loads((folder / 'snapshot.json').read_text(encoding='utf-8'))
    run = snapshot['run']
    batches = spec['batches']
    if (status['state'] != 'succeeded' or run['run_id'] != run_id or run['data_status'] != 'imported_batch'
            or run['batch_status'] != 'complete' or not batches or not all(b['complete'] for b in batches)):
        raise ValueError('Learning requires a successful, complete operational import.')
    if run['first_date'] <= archive_end():
        raise ValueError('The import overlaps the protected competition calendar.')
    raw_frames = []
    for index, batch in enumerate(batches):
        for upload in batch['uploads']:
            digest = upload['sha']
            if not re.fullmatch('[a-f0-9]{64}', digest):
                raise ValueError('Invalid upload fingerprint.')
            path = import_batch.upload_path(digest)
            if sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('The operational upload fingerprint has changed.')
            raw_frames.append(import_batch.canonical(import_batch.read_batch(path)).assign(_batch=index))
    raw = pd.concat(raw_frames, ignore_index=True)
    roster = calendar_keys(import_batch.roster_of(raw, batches))
    events, flags = clean_transactions(raw[import_batch.COLUMNS], pd.Series(dtype='string'))
    if flags[['invalid_timestamp', 'missing_merchant']].any().any():
        raise ValueError('Correct unassignable input rows before admitting this import.')
    if len(events) != status['result']['rows_processed']:
        raise ValueError('The operational input differs from the completed import.')
    collective = {(m['merchant_id'], advisory['date']): advisory.get('calibration_date_tail_rank')
                  for advisory in snapshot['advisories'] for m in advisory['members']}
    evidence = {}
    for row in snapshot['merchant_days']:
        key = row['merchant_id'], row['date']
        life = row.get('lifecycle') or {}
        evidence[key] = {
            'model_version': run['models']['v2'], 'reference_version': row.get('reference'),
            'phase': life.get('phase', 'unavailable'), 'reference_hold': life.get('reference_hold', False),
            'incident_id': life.get('incident_id') or (
                f"{key[0]}:{life['observation_on']}" if life.get('observation_on') else None
            ),
            'sequential_score': row['anomaly_score'], 'sequential_threshold': run['policy']['high'],
            'sequential_flag': row['is_anomaly'], 'symptom': row.get('main_signal'),
            'collective': key in collective, 'collective_tail_rank': collective.get(key),
        }
    if set(evidence) != {(m, d.date().isoformat()) for m, d in roster[KEYS].itertuples(index=False, name=None)}:
        raise ValueError('The operational snapshot does not match its closed roster.')
    return ingest(store, actor, source=f'import:{run_id}', calendar=roster, events=events, evidence=evidence,
                  corrections=corrections)

