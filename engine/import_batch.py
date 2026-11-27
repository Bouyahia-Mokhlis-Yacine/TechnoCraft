"""Validate, preview and analyse operator-imported transaction files with the frozen engine.

    python -m engine.import_batch validate --file batch.csv [--filename name.csv]
    python -m engine.import_batch preview --uploads <sha256,...> [--existing <sha256,...>]
    python -m engine.import_batch analyze --run-id <16 hex>

Imported data lives in saved collections (runs/collections/<id>/collection.json). A collection is a
list of batches; a batch is one import operation (one or more CSV files) with its declared coverage
(partial or complete). Every analysis, of one collection or of several selected together, reads the
raw files of all its batches, runs the frozen cleaning once over the union (so exact duplicates across
files and collections are removed by the official duplicate rule), builds the merchant-day roster from
each batch's own coverage, and scores with the frozen V2 detector. Results live in
runs/imports/<run_id>/ and never touch runs/latest.json, the official snapshot or y_pred_anomalies.csv.
Card fields are read only to detect exact duplicates, as the official pipeline does; they are never
written, printed or returned.

Messages to the operator carry a stable `code` and `values` next to an English `text`, so the web app
can show them in the operator's language from the same evidence.
"""

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import traceback

import holidays
import pandas as pd

from src.data.aggregation import merchant_days
from src.data.preprocessing import CHANNELS, STATUSES, TIMESTAMP, clean_text, clean_transactions
from src.detection.incidents import IncidentMonitor
from src.operations.backend import Scope

from .export import atomic_write
from .hybrid import build_hybrid
from .replay import KEYS, PREDICTION_COLUMNS, ROOT, backend_for, load_archive
from .snapshot import SCHEMA_VERSION, advisory_view, clean, forecast_view, incident_view, merchant_view, network_view, transaction_view
from .validate import privacy, require

REQUIRED = ['merchant_id', 'transaction_date', 'amount', 'payment_channel', 'transaction_status', 'merchant_category']
OPTIONAL = ['masked_pan']   # used only to tell exact duplicates apart, as in the official pipeline
COLUMNS = ['merchant_id', 'masked_pan', 'transaction_date', 'amount', 'payment_channel', 'transaction_status', 'merchant_category']
CARD_COLUMNS = {'masked_pan', 'pan', 'card_number'}
MAX_ROWS = 200_000
MAX_SPAN_DAYS = 92
PREVIEW = 8
STAGES = {
    'collect': 'Reading the collection files',
    'validate': 'Validating rows',
    'clean': 'Cleaning transactions',
    'aggregate': 'Building merchant-day summaries',
    'reference': 'Loading the frozen reference history',
    'score': 'Scoring anomalies',
    'evidence': 'Building incidents, collective warnings and forecast',
    'hybrid': 'Computing Hybrid ML advisory candidates',
    'save': 'Saving results',
}


class OperatorError(ValueError):
    """A failure the operator can act on, reported with a stable code."""

    def __init__(self, code, text, **values):
        super().__init__(text)
        self.code, self.values = code, values


def runs_dir():
    return Path(os.environ.get('RUNS_DIR', ROOT / 'runs'))


def imports_dir():
    return runs_dir() / 'imports'


def uploads_dir():
    return imports_dir() / 'uploads'


def collections_dir():
    return runs_dir() / 'collections'


def now():
    return datetime.now(timezone.utc).isoformat()


def msg(code, text, **values):
    """An operator message: stable code + values for translation, English text as the fallback."""
    return {'code': code, 'values': values, 'text': text}


def read_batch(path):
    raw = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[''])
    raw.columns = [c.strip() for c in raw.columns]
    return raw


def canonical(raw):
    """The seven columns the official cleaning reads, in its order; an absent card column is missing."""
    if 'masked_pan' not in raw.columns:
        raw = raw.assign(masked_pan=float('nan'))
    return raw[COLUMNS]


def reference_last_date():
    config = json.loads((ROOT / 'config' / 'probabilistic_detection.v1.json').read_text(encoding='utf-8'))
    return pd.Timestamp(config['development']['reserved_start']) - pd.Timedelta(days=1)


def archive_history():
    """The official archive's merchants and its last processed date. Future batches continue from that date:
    anything on or before it would rewrite history the official run already scored."""
    directory = Path(os.environ.get('SATIM_DATA_DIR', ROOT))
    frames = [pd.read_csv(directory / f'X_{split}_transactions.csv', usecols=['merchant_id', 'transaction_date'], dtype=str)
              for split in ('train', 'test')]
    merchants = set(clean_text(pd.concat([f.merchant_id for f in frames])).dropna())
    last = pd.to_datetime(frames[1].transaction_date.str.strip(), format=TIMESTAMP, errors='coerce').max().normalize()
    return merchants, last


def usable_mask(raw):
    stamp = pd.to_datetime(raw['transaction_date'].str.strip(), format=TIMESTAMP, errors='coerce')
    merchant = clean_text(raw['merchant_id'])
    return stamp, merchant, stamp.notna() & merchant.notna()


def inspect(path, filename):
    """Backend validation of one file: counts, coverage, preview, blocking errors and handled warnings."""
    errors, warnings = [], []
    try:
        raw = read_batch(path)
    except Exception as error:  # noqa: BLE001 - parsing errors are reported to the operator
        return {'ok': False, 'filename': filename, 'rows': 0, 'warnings': [],
                'errors': [msg('unreadable', f'The file is not a readable CSV ({type(error).__name__}).', kind=type(error).__name__)]}
    missing = [c for c in REQUIRED if c not in raw.columns]
    unexpected = [c for c in raw.columns if c not in REQUIRED + OPTIONAL]
    result = {'filename': filename, 'rows': int(len(raw)), 'missing_columns': missing,
              'columns': [c for c in raw.columns if c.lower() not in CARD_COLUMNS]}
    if missing:
        errors.append(msg('missing_columns', 'Missing required column(s): ' + ', '.join(missing) + '. Use the CSV template.',
                          columns=', '.join(missing)))
    if unexpected:
        shown = [c for c in unexpected if c.lower() not in CARD_COLUMNS]
        card = len(shown) < len(unexpected)
        warnings.append(msg('ignored_columns_card' if card else 'ignored_columns',
                            'Ignored column(s): ' + ', '.join(shown) + (' (card columns are never read)' if card else ''), columns=', '.join(shown)))
    if not len(raw):
        errors.append(msg('empty', 'The file has no data rows.'))
    if len(raw) > MAX_ROWS:
        errors.append(msg('too_many_rows', f'The file has {len(raw):,} rows; the limit is {MAX_ROWS:,} per import. Split it by date.',
                          rows=len(raw), limit=MAX_ROWS))
    if errors:
        return {**result, 'ok': False, 'errors': errors, 'warnings': warnings}

    stamp, merchant, valid = usable_mask(raw)
    amount = pd.to_numeric(raw['amount'], errors='coerce')
    channel = raw['payment_channel'].str.strip()
    status = raw['transaction_status'].str.strip()
    exact = canonical(raw).duplicated()
    usable = valid & ~exact
    counts = {
        'invalid_timestamp': int(stamp.isna().sum()), 'missing_merchant': int(merchant.isna().sum()),
        'exact_duplicates': int(exact.sum()), 'missing_amount': int(raw['amount'].isna().sum()),
        'non_numeric_amount': int((amount.isna() & raw['amount'].notna()).sum()),
        'negative_amount': int(amount.lt(0).sum()), 'unknown_channel': int((channel.notna() & ~channel.isin(CHANNELS)).sum()),
        'missing_channel': int(channel.isna().sum()), 'unknown_status': int((status.notna() & ~status.isin(STATUSES)).sum()),
        'missing_category': int(raw['merchant_category'].isna().sum()),
        'contactless_limit': int((channel.map(CHANNELS).eq('nfc') & amount.gt(2500)).sum()),
    }
    if not usable.any():
        errors.append(msg('no_usable_rows', 'No row has both a merchant and a valid timestamp (format YYYY-MM-DD HH:MM:SS).'))
        return {**result, 'ok': False, 'errors': errors, 'warnings': warnings, 'counts': counts}
    errors += span_errors(stamp[usable].dt.normalize())
    dates = stamp[usable].dt.normalize()
    first, last = dates.min(), dates.max()
    merchants = sorted(merchant[usable].unique())
    known, _ = archive_history()
    counts['new_merchants'] = len(set(merchants) - known)
    observed = int(pd.DataFrame({'m': merchant[usable], 'd': dates}).drop_duplicates().shape[0])
    expected = len(merchants) * ((last - first).days + 1)
    labels = {'invalid_timestamp': 'rows with an invalid timestamp will be dropped',
              'missing_merchant': 'rows without a merchant will be dropped',
              'exact_duplicates': 'exact duplicate rows will be removed',
              'missing_amount': 'rows without an amount count as events but not in values',
              'non_numeric_amount': 'non-numeric amounts are treated as invalid amounts',
              'negative_amount': 'negative amounts are excluded from values (archived policy)',
              'unknown_channel': 'unrecognised channels are kept as Unknown',
              'missing_channel': 'rows without a channel are kept as Unknown',
              'unknown_status': 'unrecognised statuses are kept as Unknown',
              'missing_category': 'missing categories stay Unknown unless recoverable',
              'contactless_limit': 'contactless payments above 2,500 DZD are kept unchanged as domain-rule evidence, never as anomalies on their own',
              'new_merchants': 'merchants are new to the monitored roster and start from the hierarchical (category) reference'}
    for key, label in labels.items():
        if counts[key]:
            warnings.append(msg(f'clean_{key}', f'{counts[key]:,} {label}.', count=counts[key]))
    preview_rows = raw.loc[usable].head(PREVIEW)
    preview = [{'merchant_id': r.merchant_id, 'transaction_date': r.transaction_date, 'payment_channel': r.payment_channel,
                'transaction_status': r.transaction_status, 'merchant_category': r.merchant_category,
                'amount': r.amount} for r in preview_rows[REQUIRED].fillna('').itertuples(index=False)]  # blank cells: '' (NaN is not valid JSON)
    result.update({'ok': not errors, 'errors': errors, 'warnings': warnings, 'counts': counts,
                   'first_date': first.date().isoformat(), 'last_date': last.date().isoformat(),
                   'merchants': len(merchants), 'usable_rows': int(usable.sum()),
                   'coverage': {'observed_merchant_days': observed, 'merchant_date_grid': expected},
                   'preview': preview})
    privacy(result)
    return result


def span_errors(dates):
    errors = []
    first, last = dates.min(), dates.max()
    floor = reference_last_date()
    if first <= floor:
        errors.append(msg('before_reference', f'Transactions start on {first.date()}; imported batches must start after {floor.date()}, '
                          'the end of the frozen reference history.', first=first.date().isoformat(), floor=floor.date().isoformat()))
    _, history_end = archive_history()
    if floor < first <= history_end:
        errors.append(msg('overlaps_official', f'Transactions start on {first.date()}, inside the history the official run already processed '
                          f'(through {history_end.date()}). Future batches must start after it; corrections need an explicit replay.',
                          first=first.date().isoformat(), last=history_end.date().isoformat()))
    if (last - first).days > MAX_SPAN_DAYS:
        errors.append(msg('span_too_long', f'The batch spans more than {MAX_SPAN_DAYS} days. Import it in shorter periods.', limit=MAX_SPAN_DAYS))
    return errors


def operational_csv(frame):
    """Every scored merchant-day (not only anomalies) as merchant_id,date,is_anomaly,anomaly_score; checked before writing."""
    out = frame[PREDICTION_COLUMNS].copy()
    out['date'] = pd.to_datetime(out['date']).dt.date.astype(str)
    if out.duplicated(KEYS).any() or not out.is_anomaly.isin([0, 1]).all() or not pd.to_numeric(out.anomaly_score).map(lambda v: v == v and abs(v) != float('inf')).all():
        raise ValueError('The operational predictions are not unique, binary and finite.')
    return out.sort_values(['date', 'merchant_id']).to_csv(index=False, lineterminator='\n').encode('utf-8')


def upload_path(sha):
    if not (len(sha) == 64 and all(c in '0123456789abcdef' for c in sha)):
        raise ValueError('Invalid upload id.')
    return uploads_dir() / f'{sha}.csv'


def preview(new, existing):
    """Combined preview of one import operation: the new files together, against the destination's files.

    Duplicates use the official exact-duplicate rule (all seven raw columns, card included) over the
    union, so a row repeated across the new files, or already in the destination, is counted once.
    """
    frames = []
    for origin, shas in (('existing', existing), ('new', new)):
        for sha in shas:
            frames.append(canonical(read_batch(upload_path(sha))).assign(_origin=origin))
    raw = pd.concat(frames, ignore_index=True)
    is_new = raw['_origin'].eq('new')
    data = raw[COLUMNS]
    stamp, merchant, valid = usable_mask(data)
    dup = data.duplicated()
    first_seen = data.loc[~dup]
    # a duplicate is "already in the destination" when its first copy is an existing row
    origin_of_first = raw.loc[first_seen.index, '_origin']
    key = pd.util.hash_pandas_object(data, index=False)
    first_origin = pd.Series(origin_of_first.values, index=key.loc[first_seen.index].values)
    first_origin = first_origin[~first_origin.index.duplicated()]
    dup_origin = key.map(first_origin)
    within = int((is_new & dup & dup_origin.eq('new')).sum())
    against = int((is_new & dup & dup_origin.eq('existing')).sum())
    ready = is_new & valid & ~dup
    errors = []
    if is_new.sum() > MAX_ROWS:
        errors.append(msg('too_many_rows', f'This import has {int(is_new.sum()):,} rows; the limit is {MAX_ROWS:,} per import. Split it by date.',
                          rows=int(is_new.sum()), limit=MAX_ROWS))
    new_valid = is_new & valid
    if not ready.any():
        errors.append(msg('nothing_new', 'Every usable row of these files is already in the destination: nothing would be added.'))
    out = {'ok': True, 'files': len(new), 'rows_received': int(is_new.sum()), 'invalid_rows': int((is_new & ~valid).sum()),
           'duplicates_within': within, 'duplicates_existing': against, 'rows_ready': int(ready.sum()),
           'existing_rows': int((~is_new).sum())}
    if new_valid.any():
        dates = stamp[new_valid].dt.normalize()
        errors += span_errors(dates)
        out.update({'first_date': dates.min().date().isoformat(), 'last_date': dates.max().date().isoformat(),
                    'merchants': int(merchant[new_valid].nunique()),
                    'coverage': {'observed_merchant_days': int(pd.DataFrame({'m': merchant[new_valid], 'd': dates}).drop_duplicates().shape[0]),
                                 'merchant_date_grid': int(merchant[new_valid].nunique()) * ((dates.max() - dates.min()).days + 1)}})
    out.update(ok=not errors, errors=errors)
    privacy(out)
    return out


class Status:
    """status.json of one analysis run, rewritten atomically at every step (polled by the web app)."""

    def __init__(self, folder, base):
        self.path, self.data = folder / 'status.json', base

    def write(self, **changes):
        self.data.update(changes, updated_at=now())
        privacy(self.data)
        atomic_write(self.path, json.dumps(self.data, ensure_ascii=False).encode('utf-8'))

    def stage(self, key, done=None, total=None, unit=None):
        order = list(STAGES)
        self.write(state='running', stage=key, stage_label=STAGES[key], stage_order=order,
                   progress={'done': done, 'total': total, 'unit': unit} if total else None,
                   stages_done=[k for k in order if order.index(k) < order.index(key)])


def validate_import(payload):
    """The serving checks that apply to an imported analysis (no official template)."""
    require(payload['schema_version'] == SCHEMA_VERSION, 'unsupported schema version')
    days = {(r['merchant_id'], r['date']): r for r in payload['merchant_days']}
    require(len(days) == len(payload['merchant_days']), 'duplicate merchant-day key')
    require({(r['merchant_id'], r['date']) for r in payload['official_predictions']} <= set(days), 'prediction roster')
    t = payload['transactions']
    require(len(set(t['source_row'])) == len(t['ts']) == sum(r['n'] for r in days.values()), 'transaction coverage')
    privacy(payload)


def read_collection(cid):
    return json.loads((collections_dir() / cid / 'collection.json').read_text(encoding='utf-8'))


def write_collection(data):
    privacy(data)
    atomic_write(collections_dir() / data['id'] / 'collection.json', json.dumps(data, ensure_ascii=False, indent=1).encode('utf-8'))


def roster_of(raw, batches):
    """Union of each batch's coverage. A complete batch covers every one of its merchants on every date of
    its own range (absence = zero activity); a partial batch covers only its merchant-days with rows, so a
    missing period stays unknown and can never read as an interruption."""
    stamp, merchant, valid = usable_mask(raw[COLUMNS])
    parts = []
    for index, batch in enumerate(batches):
        rows = valid & raw['_batch'].eq(index)
        if not rows.any():
            continue
        observed = pd.DataFrame({'merchant_id': merchant[rows].astype(str).values, 'date': stamp[rows].dt.normalize().values}).drop_duplicates()
        if batch['complete']:
            dates = pd.date_range(observed.date.min(), observed.date.max())
            observed = pd.MultiIndex.from_product([sorted(observed.merchant_id.unique()), dates],
                                                  names=['merchant_id', 'date']).to_frame(index=False)
        parts.append(observed)
    roster = pd.concat(parts, ignore_index=True).drop_duplicates().sort_values(['merchant_id', 'date'], ignore_index=True)
    return roster.assign(date=roster.date.dt.strftime('%Y-%m-%d'))


def analyze(run_id):
    folder = imports_dir() / run_id
    spec = json.loads((folder / 'spec.json').read_text(encoding='utf-8'))
    status = Status(folder, json.loads((folder / 'status.json').read_text(encoding='utf-8')))
    status.write(state='running', started_at=now(), pid=os.getpid(), stage_order=list(STAGES))
    commit = spec.get('commit')
    try:
        batches = spec['batches']
        files = [(index, upload) for index, batch in enumerate(batches) for upload in batch['uploads']]
        frames = []
        for done, (index, upload) in enumerate(files):
            status.stage('collect', done, len(files), 'files read')
            path = upload_path(upload['sha'])
            if not path.exists():
                raise OperatorError('file_missing', f'The file {upload["filename"]} is no longer stored on the server. Import it again.', name=upload['filename'])
            part = canonical(read_batch(path)).copy()
            part['_batch'] = index
            part['_source'] = [f'{upload["sha"][:8]}:{line}' for line in range(2, len(part) + 2)]
            frames.append(part)
        status.stage('collect', len(files), len(files), 'files read')
        raw = pd.concat(frames, ignore_index=True)
        total = len(raw)

        step = max(1000, total // 8)
        for done in range(0, total, step):   # real row checks, reported as they progress
            part = raw.iloc[done:done + step]
            pd.to_datetime(part['transaction_date'].str.strip(), format=TIMESTAMP, errors='coerce')
            pd.to_numeric(part['amount'], errors='coerce')
            status.stage('validate', min(done + step, total), total, 'rows validated')

        status.stage('clean', 0, total, 'rows cleaned')
        roster = roster_of(raw, batches)
        events, flags = clean_transactions(raw[COLUMNS], pd.Series(dtype='string'))
        events['source_row'] = raw.loc[events.index, '_source'].values
        events['contactless_limit'] = events.channel.eq('nfc') & events.amount.gt(2500)
        events['unknown_channel'] = events.channel.eq('unknown')
        added = None
        if commit:   # the new batch's own coverage, for the collection's import history
            stamp, merchant, valid = usable_mask(raw[COLUMNS])
            rows = valid & raw['_batch'].eq(len(batches) - 1)
            added = {'first_date': stamp[rows].min().date().isoformat(), 'last_date': stamp[rows].max().date().isoformat(),
                     'merchants': int(merchant[rows].nunique()), 'rows_received': int(raw['_batch'].eq(len(batches) - 1).sum())}
        del raw   # nothing card-related survives past cleaning
        status.stage('clean', total, total, 'rows cleaned')

        status.stage('aggregate', 0, len(roster), 'merchant-days built')
        days = merchant_days(events, roster, pd.Series(dtype='string'))
        status.stage('aggregate', len(days), len(roster), 'merchant-days built')

        status.stage('reference')
        _, train, test, ordinary, ordinary_events, _, v1, v2, v3 = load_archive()
        if days.date.min() <= test[0].date.max():
            raise OperatorError('overlaps_official', f'The data starts inside the history the official run already processed (through {test[0].date.max().date()}).',
                                first=days.date.min().date().isoformat(), last=test[0].date.max().date().isoformat())

        status.stage('score', None, len(days), 'merchant-days')
        # Sequential state continues from the official run: the frozen detector starts at the official epoch, replays the
        # official test period (reproducing the official scores) and carries its CUSUM and incident state into this batch,
        # against the same frozen pre-period reference (never refitted, never updated from new days). Only the batch's own
        # days are reported. Replaying the same chronology is deterministic, so batches processed one by one give the same
        # state as one continuous replay.
        start = days.date.min()
        history = pd.concat([test[0], days], ignore_index=True)
        backend = backend_for(history, pd.concat([test[1], events], ignore_index=True),
                              ordinary, ordinary_events, test[0].date.min(), (v1, v2, v3), enable_v3=True)
        scored = backend.official_v2_predictions(Scope(backend.roster), start, backend.closed_through)
        status.stage('score', len(scored), len(scored), 'merchant-days scored')
        replayed = {(r['merchant_id'], str(pd.Timestamp(r['date']).date())): r['is_anomaly'] for r in
                    backend.official_v2_predictions(Scope(backend.roster), test[0].date.min(), test[0].date.max())}
        official_flags = sum(replayed.values())

        status.stage('evidence')
        backends = (backend,)
        transactions = transaction_view(events, ordinary_events)
        calendar = sorted(d.isoformat() for d in holidays.country_holidays('DZ', years=days.date.dt.year.unique()))
        merchant_rows = [r for r in merchant_view(history, pd.concat([test[1], events], ignore_index=True), {}, backends, calendar)
                         if pd.Timestamp(r['date']) >= start]
        # incidents and advisories that reach into this batch (incidents opened earlier keep their lifecycle)
        batch_merchants = set(days.merchant_id)
        mine = lambda r: bool(batch_merchants & set(r.get('merchants') or [r['id'].split(':')[0]]))
        reaches = lambda r: mine(r) and (pd.Timestamp(r.get('last_alert') or r.get('date') or r['start']) >= start or r.get('recovery_status') not in (None, 'resolved'))
        incident_records, queue = incident_view(backends)
        incident_records, queue = [r for r in incident_records if reaches(r)], [r for r in queue if reaches(r)]
        advisories = [a for a in advisory_view(backends, history, merchant_rows) if pd.Timestamp(a['date']) >= start]
        forecast = forecast_view(backend.forecast(Scope(backend.roster)))
        status.stage('hybrid')
        operational = pd.DataFrame(scored, columns=PREDICTION_COLUMNS) if scored and not isinstance(scored[0], dict) else pd.DataFrame(scored)[PREDICTION_COLUMNS]
        hybrid, hybrid_note = None, None
        try:   # advisory only: it never changes the sequential flags or scores above
            hybrid = build_hybrid(ordinary, ordinary_events, days, pd.concat([ordinary_events, test[1], events], ignore_index=True),
                                  operational, backend, (v1, v2, v3))
        except Exception as error:   # e.g. too little history for some of the 62 features: reported, never invented
            hybrid_note = f'Hybrid ML candidates unavailable for this batch: {error}'

        status.stage('save')
        cleaning = flags.sum().to_dict()
        cleaning.pop('missing_card_field', None)
        cleaning.update(retained_events=len(events), raw_rows=total, contactless_limit_events=int(events.contactless_limit.sum()))
        flagged = int(sum(bool(r['is_anomaly']) for r in merchant_rows))
        complete = all(b['complete'] for b in batches)
        mixed = len({b['complete'] for b in batches}) > 1
        payload = clean({
            'schema_version': SCHEMA_VERSION,
            'run': {'run_id': run_id, 'generated_at': now(), 'as_of': backend.closed_through,
                    'first_date': days.date.min(), 'train_end': train[0].date.max(),
                    'batch_status': 'mixed' if mixed else 'complete' if complete else 'partial', 'data_status': 'imported_batch',
                    'preprocessing_version': 'archived_v2', 'reference_version': backend.reference.version,
                    'reference_last_date': backend.reference.last_date,
                    'policy': {'version': v2['version'], 'high': IncidentMonitor.from_config(v2).threshold, 'low': None,
                               'window_days': (ordinary.date.max() - ordinary.date.min()).days + 1,
                               'min_history': v1['established_days'], 'recovery_days': v2['recovery_days']},
                    'models': {'v1': v1['version'], 'v2': v2['version'], 'v3': v3['version'], 'v4': (hybrid or {}).get('version') if hybrid else None},
                    'continuation': {'from_run': 'official', 'replayed_from': test[0].date.min(), 'history_through': test[0].date.max(),
                                     'replayed_official_flags': int(official_flags), 'reference': 'frozen pre-period, not updated'},
                    'hybrid_note': hybrid_note,
                    'selection': spec['selection'], 'kind': spec['kind'],
                    'import': {'batches': len(batches), 'files': [u['filename'] for _, u in files], 'complete': complete},
                    'inputs': {u['filename']: u['sha'] for _, u in files}, 'configurations': {}, 'holidays': calendar, 'cleaning': cleaning,
                    'validation': None, 'flagged_days': flagged,
                    'parity': {'development_rows': 0, 'official_rows': len(scored), 'official_sha256': '',
                               'development_sha256': '', 'sealed': False, 'expected_official_sha256': '',
                               'expected_development_sha256': ''}},
            'network': network_view(days, transactions), 'merchant_days': merchant_rows,
            'official_predictions': scored, 'transactions': transactions,
            'incidents': incident_records, 'priority_queue': queue, 'advisories': advisories, 'hybrid': hybrid,
            'forecast': forecast,
            'domain_rules': {'contactless': {'condition': 'Contactless / NFC amount > 2500 DZD', 'limit_dzd': 2500,
                                             'events': cleaning['contactless_limit_events'],
                                             'limitation': 'Limit violations never make a merchant-day anomalous on their own.',
                                             'affects_official_detection': False, 'amount_transformation': 'none'}},
        })
        validate_import(payload)
        atomic_write(folder / 'operational_predictions.csv', operational_csv(operational))
        atomic_write(folder / 'snapshot.json', json.dumps(payload, ensure_ascii=False, allow_nan=False,
                                                          separators=(',', ':')).encode('utf-8'))
        stats = {'first_date': payload['run']['first_date'], 'last_date': payload['run']['as_of'],
                 'merchants': len(transactions['merchants']), 'transactions': len(events), 'rows_received': total}
        result = {'rows_received': total, 'rows_processed': len(events),
                  'duplicates_removed': int(flags['exact_duplicate'].sum()),
                  'merchant_days_scored': len(scored), 'alerts': flagged,
                  'incidents': len(incident_records), 'first_date': stats['first_date'],
                  'last_date': stats['last_date'], 'merchants': stats['merchants'], 'complete': complete,
                  'collective_warnings': len(advisories),
                  'hybrid_candidates': sum(1 for r in (hybrid or {}).get('rows', []) if r.get('investigation_candidate')) if hybrid else None,
                  'hybrid_note': hybrid_note, 'reference_version': backend.reference.version, 'preprocessing_version': 'archived_v2',
                  'model_version': v2['version'], 'contactless_limit_events': cleaning['contactless_limit_events']}
        if commit:
            # the collection changes only now, after a successful analysis: a failure keeps the last good version
            collection = read_collection(commit['collection_id'])
            before = (collection.get('stats') or {}).get('transactions', 0)
            batch = {**commit['batch'], **(added or {}), 'run_id': run_id, 'rows_added': len(events) - before, 'added_at': now()}
            collection.update(batches=[*collection.get('batches', []), batch], version=commit['version'], stats=stats,
                              analysis={'version': commit['version'], 'run_id': run_id}, pending=None, last_error=None,
                              updated_at=now())
            write_collection(collection)
            result['rows_added'] = batch['rows_added']
        status.write(state='succeeded', stage='done', stage_label='Analysis complete', progress=None,
                     stages_done=list(STAGES), finished_at=now(), result=result)
    except Exception as error:  # noqa: BLE001 - every failure is reported in status.json
        stage = status.data.get('stage') or 'collect'
        known = isinstance(error, ValueError)
        message = str(error) if known else f'{type(error).__name__} during {STAGES.get(stage, stage).lower()}'
        traceback.print_exc(file=sys.stderr)
        status.write(state='failed', finished_at=now(),
                     error={'stage': stage, 'stage_label': STAGES.get(stage, stage), 'message': message[:300],
                            'code': error.code if isinstance(error, OperatorError) else 'engine_message' if known else 'engine_exception',
                            'values': {**(error.values if isinstance(error, OperatorError) else {}), 'detail': message[:300], 'kind': type(error).__name__},
                            'action': 'Correct the file and import it again, or retry if the cause was temporary.'})
        if commit:
            try:
                collection = read_collection(commit['collection_id'])
                collection.update(pending=None, last_error={'run_id': run_id, 'stage': stage, 'message': message[:300], 'at': now()})
                write_collection(collection)
            except Exception:  # noqa: BLE001 - the run's own status already records the failure
                traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    check = sub.add_parser('validate')
    check.add_argument('--file', type=Path, required=True)
    check.add_argument('--filename', default=None)
    look = sub.add_parser('preview')
    look.add_argument('--uploads', required=True)
    look.add_argument('--existing', default='')
    start = sub.add_parser('analyze')
    start.add_argument('--run-id', required=True)
    args = parser.parse_args()
    if args.command == 'validate':
        data = args.file.read_bytes()
        result = inspect(args.file, args.filename or args.file.name)
        result['upload_id'] = sha256(data).hexdigest()
        print(json.dumps(result, ensure_ascii=False, default=str))
    elif args.command == 'preview':
        split = lambda s: [x for x in s.split(',') if x]  # noqa: E731
        print(json.dumps(preview(split(args.uploads), split(args.existing)), ensure_ascii=False, default=str))
    else:
        if not (len(args.run_id) == 16 and all(c in '0123456789abcdef' for c in args.run_id)):
            parser.error('Invalid run id.')
        analyze(args.run_id)


if __name__ == '__main__':
    main()
