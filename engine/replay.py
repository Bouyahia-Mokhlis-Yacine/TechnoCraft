"""The archived competition inputs, model epochs and parity gates."""

import json
import os
from hashlib import sha256
from pathlib import Path

import pandas as pd

from src.data.aggregation import merchant_days
from src.data.preprocessing import KEYS, clean_transactions
from src.detection.collective_evaluation import load_v3
from src.detection.detectors import amount_evidence, count_evidence, outcome_evidence
from src.detection.incidents import IncidentMonitor
from src.detection.references import Batch, fit_reference
from src.detection.sequential_evaluation import Ordinary, load_configs, terminal_replay
from src.operations.backend import OperationsBackend, Scope

ROOT = Path(__file__).resolve().parents[1]
INPUTS = {
    'X_train_transactions.csv': '3ccc299f6a2a30441cb6824d78acf9e5d793ef8461a2d5be92ee6af316a70dcd',
    'X_test_transactions.csv': '4c010cedcde6be510efee6d8728ea823c6349939480fb597b6af178ac89bc558',
    'y_train_labels.csv': 'ca137fef9639ce278c5916b2cd0710f9764b2e7dc57a8198510efd9ca47e2c88',
    'y_pred_template.csv': '7940873aeee31754dd46a2f864794abf2a5eac4266bd6c2c4e57d2f1d124b9f3',
}
CONFIGS = {
    'probabilistic_detection.v1.json': 'beb4adf341776696828f231372c8b83aa9d938a2c732bfdb6d7068f18427b967',
    'probabilistic_detection.v2.json': 'ae0e8b517a7890223ad3e9a023dea5a275793b54fabf00175ab99400e57c5c59',
    'probabilistic_detection.v3.json': '52b67dfe6814cf8403ca9ae2971764c47b845bbd2e7ac0211a1426be307683c1',
    'hybrid_detection.v4.json': '25ada2688573bc733e8512ba4d8f0e3dabe7a1e1ef0ef813e4f72277861894f7',
}
DEV_COLUMNS = ['date', 'merchant_id', 'v1', 'cusum', 'combined', 'managed', 'v1_alert',
               'cusum_alert', 'combined_alert', 'managed_alert']
PREDICTION_COLUMNS = [*KEYS, 'is_anomaly', 'anomaly_score']


def check_fingerprints(folder, expected):
    for name, fingerprint in expected.items():
        path = folder / name
        if not path.is_file():
            raise ValueError(f'Missing required archive input: {name}')
        if sha256(path.read_bytes()).hexdigest() != fingerprint:
            raise ValueError(f'Unexpected archive fingerprint: {name}')


def evidence(name):
    return json.loads((ROOT / 'docs/evidence' / name).read_text(encoding='utf-8'))


def load_split(directory, split, roster):
    raw = pd.read_csv(directory / f'X_{split}_transactions.csv', dtype={'masked_pan': 'string'})
    categories = pd.Series(dtype='string')
    events, flags = clean_transactions(raw, categories)
    events['source_row'] = [f'{split}:{i + 2}' for i in events.index]
    events['contactless_limit'] = events.channel.eq('nfc') & events.amount.gt(2500)
    events['unknown_channel'] = events.channel.eq('unknown')
    days = merchant_days(events, roster, categories)
    return days, events, flags


def load_archive(data_dir=None):
    directory = Path(data_dir or os.environ.get('SATIM_DATA_DIR', ROOT))
    check_fingerprints(directory, INPUTS)
    check_fingerprints(ROOT / 'config', CONFIGS)
    labels = pd.read_csv(directory / 'y_train_labels.csv')
    template = pd.read_csv(directory / 'y_pred_template.csv', usecols=KEYS)
    if len(template) != 711 or template.duplicated(KEYS).any():
        raise ValueError('The official template must contain 711 unique merchant-days.')
    train = load_split(directory, 'train', labels[KEYS])
    test = load_split(directory, 'test', template)
    v1, v2 = load_configs(ROOT)
    v3 = load_v3(ROOT)
    boundary = pd.Timestamp(v1['development']['reserved_start'])
    ordinary = train[0].loc[train[0].date.lt(boundary)]
    ordinary_events = train[1].loc[train[1].date.lt(boundary)]
    return directory, train, test, ordinary, ordinary_events, template, v1, v2, v3


def backend_for(days, events, ordinary, ordinary_events, epoch, configs, *, enable_v3):
    return OperationsBackend(
        pd.concat([ordinary, days], ignore_index=True),
        pd.concat([ordinary_events, events], ignore_index=True),
        ordinary, epoch, days.date.max(), *configs, enable_v3=enable_v3,
    )


def predictions(backend, template):
    rows = backend.official_v2_predictions(Scope(backend.roster), backend.epoch, backend.closed_through)
    values = pd.DataFrame(rows, columns=PREDICTION_COLUMNS)
    result = template.merge(values, on=KEYS, how='outer', sort=False, validate='one_to_one', indicator=True)
    if len(result) != 711 or not result.pop('_merge').eq('both').all():
        raise ValueError('Official inference must cover exactly the 711 template keys.')
    result = result.set_index(KEYS).reindex(pd.MultiIndex.from_frame(template)).reset_index()
    if not result.is_anomaly.isin([0, 1]).all():
        raise ValueError('Invalid official prediction flag.')
    canonical = '\n'.join(f'{d},{m},{f},{s.hex()}' for m, d, f, s in
                          result.sort_values(['date', 'merchant_id']).itertuples(index=False, name=None))
    digest = sha256(canonical.encode()).hexdigest()
    return result, digest


def development_parity(directory, ordinary, ordinary_events, backend, v1, v2):
    replay = terminal_replay(directory, v1, v2, Ordinary(ordinary, ordinary_events, v2['frozen'], None))
    baseline = replay.sort_values(DEV_COLUMNS[:2])[DEV_COLUMNS]
    digest = sha256(baseline.to_csv(index=False, float_format='%.15g', lineterminator='\r\n').encode()).hexdigest()
    actual = backend.official_v2_predictions(Scope(backend.roster), backend.epoch, backend.closed_through)
    left = {(row.date.date().isoformat(), row.merchant_id): (int(row.managed_alert), row.managed)
            for row in replay.itertuples()}
    right = {(row['date'], row['merchant_id']): (row['is_anomaly'], row['anomaly_score']) for row in actual}
    if left != right or len(left) != 280:
        raise ValueError('The integrated development replay differs from the archived replay implementation.')
    return replay, digest


def verify_official_replay(days, events, ordinary, ordinary_events, v1, v2, actual):
    """Compare the serving backend to the direct archived monitor using the official reset."""
    monitor = IncidentMonitor.from_config(v2)
    reference = fit_reference(ordinary, ordinary_events, days.date.min(), v1['version'])
    states, baseline = {}, {}
    for day in pd.date_range(days.date.min(), days.date.max()):
        states, derived = monitor.step_day(day, Batch('complete', day), days, events, reference,
                                           {reference.version: reference}, states, v1)
        for merchant, (item, _) in derived.items():
            if item.scores is not None:
                baseline[(merchant, day.date().isoformat())] = (int(item.alert), item.scores['managed'])
    observed = {(r.merchant_id, r.date): (r.is_anomaly, r.anomaly_score) for r in actual.itertuples()}
    if observed != baseline:
        raise ValueError('Official serving predictions differ from the direct frozen V2 replay.')


def historical_evidence(ordinary, events, config):
    """Past observation charts use prior-only V1 evidence before the held-out replay."""
    output = {}
    coverage = config['interval_coverage']
    for day in sorted(ordinary.date.unique())[1:]:
        reference = fit_reference(ordinary, events, day, config['version'])
        for row in ordinary.loc[ordinary.date.eq(day)].itertuples(index=False):
            output[(day, row.merchant_id)] = {
                'reference_version': reference.version, 'support': reference.support(row.merchant_id),
                'detectors': {'transaction_count': count_evidence(row, reference, config),
                              'declines': outcome_evidence(row, reference, 'declines', coverage),
                              'cancellations': outcome_evidence(row, reference, 'cancellations', coverage),
                              'median_ticket': amount_evidence(row, reference, 'median_ticket', config)},
            }
    return output
