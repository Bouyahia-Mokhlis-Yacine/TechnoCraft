"""Server adapter for src.continuous_learning.LearningService (no logic of its own).

    python -m engine.learning_bridge   < {"actor": "<account id>", "method": "...", "args": {...}}

The Next.js server validates the signed session, then starts this process with the account id; the browser
never supplies an identity or a role. Each call re-reads runs/accounts.json (the existing account store):
the administrator and accounts with the `supervise` action are supervisors, accounts with the `label`
action are reviewers, others have no learning access. The account system has no merchant scoping, so
grants are deliberately fleet-wide (merchants=None). The import worker uses the in-process worker identity
(never reachable from HTTP). Output: one JSON object, {"ok": ...} or {"error": {status, code, message}}.
"""

import json
import os
import sys
import traceback

from src.continuous_learning.service import LearningService
from src.continuous_learning.store import Actor

from .import_batch import runs_dir

WORKER = object()   # in-process credential of the import worker
READ = {'review_queue', 'feedback_history', 'feedback_statistics', 'training_eligibility', 'drift_report',
        'operational_predictions', 'forecast', 'learning_job_status', 'model_comparison', 'model_registry'}
WRITE = {'submit_feedback', 'decide_feedback', 'initialize_baseline', 'start_learning_job', 'run_learning_job',
         'cancel_learning_job', 'shadow_batch', 'decide_model', 'rollback', 'score_operational_batch', 'ingest_import'}


def account_actor(account_id):
    try:
        data = json.loads((runs_dir() / 'accounts.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None
    accounts = data if isinstance(data, list) else data.get('accounts', [])
    account = next((a for a in accounts if a.get('id') == account_id), None)
    if account is None:
        return None
    actions = set(account.get('actions') or [])
    if account.get('admin') or 'supervise' in actions:
        return Actor(account_id, 'supervisor', None)
    if 'label' in actions:
        return Actor(account_id, 'reviewer', None)
    return None


def resolve(credential):
    if credential is WORKER:
        return Actor('import-worker', 'supervisor', None)
    return account_actor(credential) if isinstance(credential, str) else None


def service():
    return LearningService(resolve, directory=runs_dir() / 'continuous_learning')


def ledger_ready():
    """True once the operational baseline exists (learning is opt-in: nothing happens before initialisation)."""
    path = runs_dir() / 'continuous_learning' / 'ledger.sqlite3'
    if not path.exists():
        return False
    try:
        return bool(service().model_registry(WORKER)['models'])
    except Exception:
        return False


def call(actor, method, args):
    if method not in READ | WRITE:
        raise ValueError('Unknown learning method.')
    if method in {'ingest_import', 'score_operational_batch'}:
        raise PermissionError('Operational batches are fed by the import worker.')
    return getattr(service(), method)(actor, **args)


def main():
    request = json.loads(sys.stdin.read() or '{}')
    try:
        result = call(request.get('actor'), request.get('method'), request.get('args') or {})
        print(json.dumps({'ok': result}, ensure_ascii=False, default=str))
    except PermissionError as error:
        print(json.dumps({'error': {'status': 403, 'code': 'forbidden', 'message': str(error)}}))
    except LookupError as error:
        print(json.dumps({'error': {'status': 404, 'code': 'not_found', 'message': str(error)}}))
    except (ValueError, TypeError) as error:
        text = str(error)
        stale = any(word in text.lower() for word in ('stale', 'revision', 'changed', 'expected_active'))
        print(json.dumps({'error': {'status': 409 if stale else 422, 'code': 'conflict' if stale else 'invalid', 'message': text[:400]}}))
    except Exception:   # never leak internals to the browser; the server log keeps the trace
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error': {'status': 500, 'code': 'learning_failed', 'message': 'The learning service failed.'}}))


if __name__ == '__main__':
    os.umask(0o077)
    main()
