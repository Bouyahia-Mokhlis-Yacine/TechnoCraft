"""Compute and atomically publish the archived SATIM competition snapshot."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import perf_counter
from uuid import uuid4

import holidays
import pandas as pd
from sklearn.metrics import average_precision_score, confusion_matrix, f1_score, precision_score, recall_score

from src.detection.incidents import IncidentMonitor
from src.detection.evaluation import _episodes, match_episodes
from src.operations.backend import Scope

from .hybrid import build_hybrid
from .replay import (CONFIGS, INPUTS, ROOT, backend_for, development_parity, evidence,
                     historical_evidence, load_archive, predictions, verify_official_replay)
from .snapshot import SCHEMA_VERSION, advisory_view, clean, forecast_view, incident_view, merchant_view, network_view, transaction_view
from .validate import validate


def validation_metrics(replay, v1):
    truth, flag = replay.is_anomaly, replay.managed_alert
    tn, fp, fn, tp = confusion_matrix(truth, flag, labels=[0, 1]).ravel()
    truth_episodes = _episodes(replay.loc[truth.eq(1)], gap=0, labelled=True)
    predicted_episodes = _episodes(replay.loc[flag], gap=v1['episodes']['alert_max_gap_days'], labelled=False)
    matched = len(match_episodes(truth_episodes, predicted_episodes))
    return {'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn, 'rows': len(replay),
            'precision': precision_score(truth, flag), 'recall': recall_score(truth, flag),
            'f1': f1_score(truth, flag), 'ap': average_precision_score(truth, replay.managed),
            'true_episodes': len(truth_episodes), 'pred_episodes': len(predicted_episodes),
            'episode_precision': matched / len(predicted_episodes), 'episode_recall': matched / len(truth_episodes),
            'scope': 'Reserved development replay, 2026-10-17 to 2026-10-24'}


def build(*, data_dir=None, enable_v3=True, enable_v4=True, allow_unsealed_preview=False):
    start = perf_counter()
    directory, train, test, ordinary, ordinary_events, template, v1, v2, v3 = load_archive(data_dir)
    dev_days = train[0].loc[train[0].date.gt(ordinary.date.max())]
    dev_events = train[1].loc[train[1].date.gt(ordinary.date.max())]
    configs = (v1, v2, v3)
    development = backend_for(dev_days, dev_events, ordinary, ordinary_events, dev_days.date.min(),
                              configs, enable_v3=enable_v3)
    official = backend_for(test[0], test[1], ordinary, ordinary_events, test[0].date.min(),
                           configs, enable_v3=enable_v3)
    submission, digest = predictions(official, template)
    replay, dev_digest = development_parity(directory, ordinary, ordinary_events, development, v1, v2)
    expected_official = evidence('v2_official_parity.json')['exact_score_flag_digest_sha256']
    expected_dev = evidence('v2_development_parity.json')['prior_recorded_training_replay_sha256']
    sealed = (digest, dev_digest) == (expected_official, expected_dev)
    if not sealed:
        if not allow_unsealed_preview:
            raise ValueError(f'Sealed V2 reproduction failed. Development SHA: {dev_digest}. Official SHA: {digest}.')
        verify_official_replay(test[0], test[1], ordinary, ordinary_events, v1, v2, submission)
    print(f'Exact local V2 replay: {len(replay)} development and {len(submission)} official rows. '
          f'Sealed digest match: {sealed}', flush=True)

    backends = (development, official)
    days = pd.concat([train[0], test[0]], ignore_index=True)
    events = pd.concat([train[1], test[1]], ignore_index=True)
    prior = historical_evidence(ordinary, ordinary_events, v1)
    calendar = sorted(day.isoformat() for day in holidays.country_holidays('DZ', years=days.date.dt.year.unique()))
    transactions = transaction_view(events, ordinary_events)
    merchant_days = merchant_view(days, events, prior, backends, calendar)
    incident_records, queue = incident_view(backends)
    advisories = advisory_view(backends, days, merchant_days)
    forecast = official.forecast(Scope(official.roster))
    hybrid = None
    if enable_v4:
        hybrid = build_hybrid(ordinary, ordinary_events, test[0], events, submission, official, configs)

    threshold = IncidentMonitor.from_config(v2).threshold
    cleaning = train[2].sum().add(test[2].sum()).to_dict()
    cleaning.pop('missing_card_field', None)
    cleaning['retained_events'] = len(events)
    cleaning['raw_rows'] = len(train[2]) + len(test[2])
    cleaning['contactless_limit_events'] = int(events.contactless_limit.sum())
    run_id = uuid4().hex[:16]
    payload = clean({
        'schema_version': SCHEMA_VERSION,
        'run': {'run_id': run_id, 'generated_at': datetime.now(timezone.utc).isoformat(),
                'as_of': official.closed_through, 'first_date': days.date.min(), 'train_end': train[0].date.max(),
                'batch_status': 'complete', 'data_status': 'historical_competition_archive',
                'preprocessing_version': 'archived_v2', 'reference_version': official.reference.version,
                'reference_last_date': official.reference.last_date,
                'policy': {'version': v2['version'], 'high': threshold, 'low': None,
                           'window_days': (ordinary.date.max() - ordinary.date.min()).days + 1,
                           'min_history': v1['established_days'], 'recovery_days': v2['recovery_days']},
                'models': {'v1': v1['version'], 'v2': v2['version'],
                           'v3': v3['version'] if enable_v3 else None,
                           'v4': hybrid['version'] if hybrid else None},
                'inputs': INPUTS, 'configurations': CONFIGS, 'holidays': calendar, 'cleaning': cleaning,
                'validation': validation_metrics(replay, v1),
                'flagged_days': int(sum(bool(row['is_anomaly']) for row in merchant_days)),
                'parity': {'development_rows': len(replay), 'development_sha256': dev_digest,
                           'official_rows': len(submission), 'official_sha256': digest,
                           'sealed': sealed, 'expected_official_sha256': expected_official,
                           'expected_development_sha256': expected_dev},
                'generation_seconds': perf_counter() - start},
        'network': network_view(days, transactions), 'merchant_days': merchant_days,
        'official_predictions': submission.to_dict('records'), 'transactions': transactions,
        'incidents': incident_records, 'priority_queue': queue, 'advisories': advisories, 'hybrid': hybrid,
        'forecast': forecast_view(forecast),
        'domain_rules': {'contactless': {'condition': 'Contactless / NFC amount > 2500 DZD',
                                         'limit_dzd': 2500, 'events': cleaning['contactless_limit_events'],
                                         'limitation': 'High breach prevalence reflects synthetic data generation.',
                                         'affects_official_detection': False, 'amount_transformation': 'none'},
                         'negative_amount': {'active_policy': 'exclude amount; retain event',
                                             'alternative': 'satim-mentor-domain-v1 (explicit opt-in only)'}},
    })
    validate(payload)
    return payload, submission


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix='.' + path.name, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish(payload, submission, runs_dir, prediction_file=None):
    validate(payload)
    if submission.to_dict('records') != payload['official_predictions']:
        raise ValueError('Published CSV and snapshot predictions must match.')
    if prediction_file is not None and not payload['run']['parity']['sealed']:
        raise ValueError('A preview run cannot overwrite the official submission file.')
    rid = payload['run']['run_id']
    snapshot = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    csv = submission.to_csv(index=False, lineterminator='\n').encode('utf-8')
    atomic_write(runs_dir / rid / 'snapshot.json', snapshot)
    atomic_write(runs_dir / rid / 'y_pred_anomalies.csv', csv)
    if prediction_file is not None:
        atomic_write(prediction_file, csv)
    atomic_write(runs_dir / 'latest.json', json.dumps({
        'schema_version': SCHEMA_VERSION, 'run_id': rid, 'path': f'{rid}/snapshot.json',
    }).encode('utf-8'))
    return len(snapshot)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--runs-dir', type=Path, default=Path(os.environ.get('RUNS_DIR', ROOT / 'runs')))
    parser.add_argument('--predictions', type=Path)
    parser.add_argument('--allow-unsealed-preview', action='store_true',
                        help='Serve a labelled, exact local replay when sealed digests differ.')
    parser.add_argument('--no-v3', action='store_true')
    parser.add_argument('--no-v4', action='store_true')
    args = parser.parse_args()
    if args.allow_unsealed_preview and args.predictions:
        parser.error('An unsealed preview cannot write a submission file.')
    payload, submission = build(data_dir=args.data_dir, enable_v3=not args.no_v3, enable_v4=not args.no_v4,
                                allow_unsealed_preview=args.allow_unsealed_preview)
    prediction_file = args.predictions
    if prediction_file is None and payload['run']['parity']['sealed']:
        prediction_file = ROOT / 'y_pred_anomalies.csv'
    size = publish(payload, submission, args.runs_dir, prediction_file)
    print(f"Published {payload['run']['run_id']}: {len(payload['merchant_days'])} merchant-days, "
          f"{size:,} bytes; generated in {payload['run']['generation_seconds']:.2f}s")


if __name__ == '__main__':
    main()
