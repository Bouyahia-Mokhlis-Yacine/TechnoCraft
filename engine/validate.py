"""Validate the snapshot serving contract before advancing the publication pointer."""

import math
import re
from datetime import date, datetime, timedelta


TRANSACTION_FIELDS = {'merchants', 'ts', 'merchant', 'category', 'channel', 'status', 'amount', 'source_row',
                      'quality', 'contactless_limit'}
CARD_PATTERN = re.compile(r'(?:\d{6}[\d*Xx •-]{4,16}\d{4}|\b\d{13,19}\b)')


def require(condition, description):
    if not condition:
        raise ValueError(f'Invalid snapshot: {description}')


def privacy(value):
    if isinstance(value, dict):
        for key, item in value.items():
            require(key.lower() not in {'masked_pan', 'pan', 'card_number', 'raw_pan'}, 'private field')
            privacy(item)
    elif isinstance(value, list):
        for item in value:
            privacy(item)
    elif isinstance(value, str):
        # Hashes are expected provenance values, including on the rare all-numeric prefix.
        require(re.fullmatch(r'[a-f0-9]{32,64}', value) or not CARD_PATTERN.search(value), 'private identifier')


def validate(payload):
    require(payload['schema_version'] == 2, 'unsupported schema version')
    run = payload['run']
    require(re.fullmatch(r'[a-f0-9]{16}', run['run_id']), 'run identifier')
    require(datetime.fromisoformat(run['generated_at']).tzinfo is not None, 'generation time zone')
    cut = date.fromisoformat(run['as_of'])
    first, train_end, reference = (date.fromisoformat(run[k]) for k in
                                   ('first_date', 'train_end', 'reference_last_date'))
    require(first <= reference < train_end < cut and run['batch_status'] == 'complete', 'reference and cutoff')

    def key(row):
        return row['merchant_id'], row['date']

    days = {key(row): row for row in payload['merchant_days']}
    require(len(days) == len(payload['merchant_days']), 'duplicate merchant-day key')
    predictions = payload['official_predictions']
    require(len(predictions) == len({key(row) for row in predictions}) == 711, 'official template coverage')
    require({key(row) for row in predictions} == {k for k in days if k[1] > run['train_end']},
            'official prediction and snapshot roster')
    for row in predictions:
        day = days[key(row)]
        require(set(row) == {'merchant_id', 'date', 'is_anomaly', 'anomaly_score'}, 'official prediction columns')
        require(type(row['is_anomaly']) is int and row['is_anomaly'] in (0, 1), 'official flag')
        require(type(row['anomaly_score']) is float and math.isfinite(row['anomaly_score']) and
                row['anomaly_score'] >= 0, 'finite official score')
        require(all(day[k] == row[k] for k in ('is_anomaly', 'anomaly_score')), 'official score and flag consistency')
    incidents = {row['id'] for row in payload['incidents']}
    for row in days.values():
        require(sum(row['hours']) == row['n'], 'hourly event total')
        require(sum(pair[0] for pair in row['channels'].values()) == row['n'], 'channel event total')
        if row['is_anomaly']:
            explanation = row['explanation']
            require(explanation and explanation['incident_id'] in incidents and explanation['observed_expected']
                    and explanation['first_action'] and explanation['reference_support'] is not None,
                    'complete B4 explanation')
    transaction = payload['transactions']
    require(set(transaction) == TRANSACTION_FIELDS, 'sanitized transaction allowlist')
    require(all(len(transaction[name]) == len(transaction['ts']) for name in TRANSACTION_FIELDS - {'merchants'}),
            'transaction columns have equal row counts')
    require(len(set(transaction['source_row'])) == len(transaction['ts']) == sum(row['n'] for row in days.values()),
            'clean transaction and source row coverage')
    require(all(0 <= idx < len(transaction['merchants']) for idx in transaction['merchant']), 'transaction merchant index')
    require(sum(transaction['contactless_limit']) == payload['domain_rules']['contactless']['events'],
            'transaction domain evidence consistency')
    require(payload['forecast']['origin'] == (cut + timedelta(days=1)).isoformat()
            and len(payload['forecast']['network']) == 7, 'forecast origin and horizon')
    if payload['hybrid'] is not None:
        rows = payload['hybrid']['rows']
        require(len(rows) == len(predictions) and {key(row) for row in rows} == {key(row) for row in predictions},
                'V4 roster coverage')
        for row in rows:
            require(0 < row['v4_ordinary_rank'] <= 1 and math.isfinite(row['v4_advisory_score']), 'V4 evidence')
            require(not (row['investigation_candidate'] and days[key(row)]['is_anomaly']), 'V4 candidate isolation')
    privacy(payload)
