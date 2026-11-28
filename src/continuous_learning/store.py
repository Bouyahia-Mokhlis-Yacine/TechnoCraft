"""SQLite ledger. All callers enter through a trusted server-side identity adapter."""

from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
NORMAL = frozenset({'verified_normal', 'legitimate_change'})
LABELS = NORMAL | {'confirmed_anomaly', 'data_quality_issue', 'insufficient_evidence'}
HOLD_PHASES = {'under_observation', 'active_incident', 'recovering', 'resolved'}
# Identifiers are deliberately short. Free text is scanned before persistence.
CARD_LIKE = re.compile(r'(?:[0-9*Xx•][ -]?){12,}|(?:[Xx*•][ .-]?){3,}[0-9]{2,}|[0-9]{4,}(?:[ .-]?[Xx*•]){3,}')


def safe_text(value, *, limit=500, required=True):
    if (not isinstance(value, str) or len(value) > limit or
            (required and not value.strip()) or CARD_LIKE.search(value)):
        raise ValueError('Invalid text or possible payment-card identifier.')
    return value.strip()


def day(value):
    return date.fromisoformat(str(value)).isoformat()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def dump(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return sha256(dump(value).encode()).hexdigest()


@dataclass(frozen=True)
class Actor:
    user_id: str
    role: str
    merchants: frozenset[str] | None = None  # None is an explicitly global grant.


def authorize(actor, *, supervisor=False, global_scope=False, merchant=None):
    if not isinstance(actor, Actor) or actor.role not in {'reviewer', 'supervisor'}:
        raise PermissionError('Authenticated learning access required.')
    safe_text(actor.user_id, limit=80)
    if ((supervisor and actor.role != 'supervisor') or
            (global_scope and actor.merchants is not None) or
            (merchant is not None and actor.merchants is not None and merchant not in actor.merchants)):
        raise PermissionError('Insufficient learning permissions.')
    return actor.user_id


SCHEMA = """
CREATE TABLE IF NOT EXISTS observation (
    merchant TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
    digest TEXT NOT NULL, source TEXT NOT NULL, ingested_at TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(merchant, day, revision)
);
CREATE INDEX IF NOT EXISTS observation_date ON observation(day);
CREATE TABLE IF NOT EXISTS feedback (
    merchant TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
    observation_revision INTEGER NOT NULL, reviewer TEXT NOT NULL, reviewed_at TEXT NOT NULL,
    label TEXT NOT NULL, category TEXT, notes TEXT NOT NULL, evidence TEXT NOT NULL,
    model_version TEXT NOT NULL, reference_version TEXT NOT NULL, sampling_probability REAL,
    PRIMARY KEY(merchant, day, revision),
    FOREIGN KEY(merchant, day, observation_revision) REFERENCES observation(merchant, day, revision)
);
CREATE INDEX IF NOT EXISTS feedback_date ON feedback(day);
CREATE TABLE IF NOT EXISTS feedback_decision (
    merchant TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL,
    at TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY(merchant, day, revision),
    FOREIGN KEY(merchant, day, revision) REFERENCES feedback(merchant, day, revision)
);
CREATE TABLE IF NOT EXISTS review_day (
    day TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, metadata TEXT NOT NULL, artifact BLOB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS single_active ON model(state) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS model_action (
    seq INTEGER PRIMARY KEY, model_id TEXT NOT NULL REFERENCES model(id),
    prior_id TEXT REFERENCES model(id), action TEXT NOT NULL, actor TEXT NOT NULL,
    at TEXT NOT NULL, reason TEXT NOT NULL, effective_day TEXT
);
CREATE TABLE IF NOT EXISTS learning_job (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    plan TEXT NOT NULL, policy TEXT NOT NULL, champion TEXT REFERENCES model(id),
    finished_at TEXT, detail TEXT, model_id TEXT REFERENCES model(id)
);
CREATE TABLE IF NOT EXISTS evaluation_window (
    job_id TEXT PRIMARY KEY REFERENCES learning_job(id), start_day TEXT NOT NULL, end_day TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow (
    job_id TEXT NOT NULL REFERENCES learning_job(id), day TEXT NOT NULL,
    scored_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(job_id, day)
);
CREATE TABLE IF NOT EXISTS operational_batch (
    day TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES model(id), scored_at TEXT NOT NULL,
    evidence TEXT NOT NULL, checkpoint BLOB NOT NULL, scoring_seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS comparison (
    seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES learning_job(id),
    at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS current_observation AS
SELECT o.* FROM observation o WHERE revision =
  (SELECT MAX(revision) FROM observation WHERE merchant=o.merchant AND day=o.day);
CREATE VIEW IF NOT EXISTS current_feedback AS
SELECT f.*, (SELECT MIN(prior.reviewed_at) FROM feedback prior
             WHERE prior.merchant=f.merchant AND prior.day=f.day) AS first_reviewed_at,
       d.at AS decided_at, COALESCE(d.decision, 'pending') AS approval,
       d.actor AS approver, d.reason AS decision_reason
FROM feedback f LEFT JOIN feedback_decision d USING (merchant,day,revision)
WHERE f.revision = (SELECT MAX(revision) FROM feedback WHERE merchant=f.merchant AND day=f.day);
"""


class Store:
    def __init__(self, directory=None):
        self.directory = Path(directory or ROOT / 'runs' / 'continuous_learning').resolve()
        if self.directory.name != 'continuous_learning' or any(
            part.lower() in {'imports', 'collections', 'replay', 'simulation'} for part in self.directory.parts
        ):
            raise ValueError('Use a dedicated continuous_learning directory.')
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'ledger.sqlite3'
        with closing(sqlite3.connect(self.path, timeout=30)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + '\nCOMMIT;')

    @contextmanager
    def connect(self, *, write=False):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def observation(db, merchant, observation_day):
        row = db.execute('SELECT * FROM current_observation WHERE merchant=? AND day=?',
                         (merchant, observation_day)).fetchone()
        if row is None:
            raise LookupError('Unknown learning observation.')
        return row

    @staticmethod
    def scoped(rows, actor):
        return [row for row in rows if actor.merchants is None or row['merchant'] in actor.merchants]

