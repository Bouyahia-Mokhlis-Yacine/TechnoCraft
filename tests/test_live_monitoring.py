from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
import pandas as pd

from engine.replay import CONFIGS
from engine.validate import privacy
from src.data.preprocessing import clean_transactions
from src.live_monitoring.archive import Archive, BIN, CONFIG, ROOT, SLOTS, Tape
from src.live_monitoring.detection import Signals
from src.live_monitoring.evaluation import locked_thresholds
from src.live_monitoring.replay import Lifecycle, Replay
from src.live_monitoring.service import Controller


class LiveMonitoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.archive = Archive()
        cls.day = pd.Timestamp(CONFIG["evaluation_start"])
        cls.thresholds = locked_thresholds(cls.archive)

    def test_reference_is_prior_and_reconciles_daily_expectations(self):
        prior = self.archive.reference
        self.assertLess(prior.cutoff, self.day)
        self.assertEqual(prior.cutoff, pd.Timestamp(CONFIG["calibration_start"]))
        for profile in prior.cell_profiles.values():
            np.testing.assert_allclose(profile.sum(axis=-1), 1)
        np.testing.assert_allclose(prior.mean.sum(axis=1), prior.daily_cell.T @ prior.weights)
        with self.assertRaises(ValueError):
            self.archive.tape("2026-09-01", "2026-09-01")

    def test_timer_scores_zero_arrivals_and_skips_incomplete_bin(self):
        base = self.archive.tape(self.day, self.day)
        empty = Tape(base.ref, base.start, base.end, base.events.iloc[:0], None, 0)
        empty.complete[5] = False
        model = Signals(empty)
        first, *_ = model.tick(0, scan=False)
        self.assertGreater(first["gap"][0, 0], 0)
        self.assertAlmostEqual(first["cusum"][0, 0], .5 * empty.mean[0, 0])
        for i in range(1, 5):
            scores, *_ = model.tick(i, scan=False)
        self.assertAlmostEqual(scores["cusum"][0, 0], .5 * empty.mean[:5, 0].sum())
        self.assertFalse(np.any(scores["adaptive"][:, 0][(empty.mean[:5].sum(axis=0) < 3)]))
        scores, *_ = model.tick(5, scan=False)
        self.assertFalse(np.any(scores["selected"]))
        self.assertFalse(np.any(model.cusum))
        replay = Replay(self.archive, empty, self.thresholds, close_daily=False)
        for _ in range(8):
            replay.advance()
        self.assertEqual(replay.snapshot(limit=1)["feed"], "Incomplete interval")

    def test_tape_order_watermark_and_privacy(self):
        tape = self.archive.tape(self.day, self.day)
        self.assertTrue(tape.events.transaction_date.is_monotonic_increasing)
        reversed_tape = Tape(tape.ref, tape.start, tape.end, tape.events.iloc[::-1], None, 0)
        np.testing.assert_array_equal(reversed_tape.bins, tape.bins)
        self.assertEqual(len(tape.events), tape.offsets[-1])
        self.assertNotIn("masked_pan", tape.events)
        for start, end in zip(tape.offsets[:-1], tape.offsets[1:]):
            if end > start:
                self.assertEqual(tape.bins[start], tape.bins[end - 1])
        replay = Replay(self.archive, tape, self.thresholds, close_daily=False)
        self.assertIsNone(replay.snapshot()["watermark"])
        replay.advance()
        self.assertEqual(replay.snapshot()["watermark"], (self.day + BIN).isoformat())
        privacy(replay.snapshot())

    def test_raw_exact_duplicates_are_removed_without_collapsing_distinct_attempts(self):
        columns = ["merchant_id", "masked_pan", "transaction_date", "amount", "payment_channel",
                   "transaction_status", "merchant_category"]
        original = ["MER-1111", "fixture-a", "2026-10-03 10:00:00", 2501., "Contactless / NFC",
                    "Accepted", "Food & Dining"]
        separate = [*original]
        separate[1] = "fixture-b"
        source = pd.DataFrame([original, original, separate], columns=columns).iloc[::-1]
        events, audit = clean_transactions(source, pd.Series(dtype="string"))
        self.assertEqual(int(audit.exact_duplicate.sum()), 1)
        self.assertEqual(len(events), 2)
        self.assertNotIn("masked_pan", events)
        self.assertEqual(events.amount.tolist(), [2501., 2501.])

    def test_warning_lifecycle_and_uncertainty(self):
        model = Lifecycle()
        key = (0, 0)
        model.update(key, "01", 11, 10, {"kind": "Intraday early warning"})
        self.assertEqual(model.live[key]["state"], "Early warning")
        model.update(key, "02", 11, 10, {"kind": "Intraday early warning"})
        self.assertEqual(model.live[key]["state"], "Persistent warning")
        model.update(key, "03", 0, 10, complete=False)
        self.assertEqual(model.live[key]["state"], "Uncertain")
        for t in ("04", "05", "06"):
            model.update(key, t, 0, 10)
        self.assertFalse(model.live)
        self.assertEqual(model.resolved[0]["state"], "Resolved")
        self.assertEqual(model.resolved[0]["opened"], "01")
        model.update(key, "07", 1, 0, {"kind": "Collective advisory"})
        for t in ("08", "09", "10"):
            model.update(key, t, 0, 0)
        self.assertFalse(model.live)

    def test_collective_scores_have_observed_expected_and_multiple_merchants(self):
        tape = self.archive.tape(self.day, self.day, "collective")
        model = Signals(tape)
        rows = []
        for i in range(tape.size):
            _, scans, *_ = model.tick(i)
            rows.extend(scans)
        self.assertTrue(rows)
        self.assertTrue(all(len(x["merchants"]) >= 2 for x in rows))
        self.assertTrue(all(x["observed"] < x["expected"] for x in rows if x["symptom"] == "Shared activity shortfall"))

    def test_checkpoint_restore_and_speed_invariance(self):
        with TemporaryDirectory(dir=ROOT / ".verification" if (ROOT / ".verification").exists() else ROOT) as tmp:
            path = Path(tmp) / "checkpoints.sqlite3"
            controller = Controller(path, self.archive, self.thresholds)
            args = {"action": "start", "start": str(self.day.date()), "end": str(self.day.date()),
                    "speed": 60, "preset": "ordinary"}
            controller.command("account.one", args)
            controller.command("account.one", {"action": "pause"})
            for _ in range(12):
                controller.command("account.one", {"action": "step"})
            original = controller.snapshot("account.one")
            self.assertEqual(controller.snapshot("account.two")["status"], "idle")
            controller.db.close()
            controller = Controller(path, self.archive, self.thresholds)
            self.assertEqual(original, controller.snapshot("account.one"))
            controller.command("account.one", {"action": "speed", "speed": 3600})
            updated = controller.snapshot("account.one")
            self.assertEqual(original | {"speed": 3600}, updated)
            controller.command("account.one", {"action": "reset"})
            self.assertEqual(controller.snapshot("account.one")["status"], "idle")
            controller.db.close()

    def test_daily_closure_and_backlog_isolation(self):
        protected = [ROOT / "y_pred_anomalies.csv", *[ROOT / "config" / name for name in CONFIGS]]
        latest = ROOT / "runs/latest.json"
        if latest.exists():
            protected.extend([latest, latest.parent / json.loads(latest.read_text())["path"]])
        protected.append(ROOT / "runs/reviews.jsonl")
        def fingerprints():
            return {p: sha256(p.read_bytes()).digest() if p.exists() else None for p in protected}
        before = fingerprints()
        base = self.archive.tape(self.day, self.day)
        backlog = self.archive.tape(self.day, self.day, "backlog")
        self.assertGreater(backlog.changed, 0)
        self.assertEqual(len(base.events), len(backlog.events))
        replay = Replay(self.archive, backlog, self.thresholds)
        for _ in range(SLOTS):
            self.assertTrue(replay.advance())
        self.assertFalse(replay.advance())
        daily, = replay.daily
        self.assertEqual(daily["status"], "complete")
        self.assertEqual(daily["scored"], len(backlog.ref.merchants))
        self.assertEqual(before, fingerprints())

    def test_individual_warning_reaches_recovery_after_score_falls(self):
        date = "2026-10-15"
        tape = self.archive.tape(date, date, "backlog")
        replay = Replay(self.archive, tape, self.thresholds, close_daily=False)
        for _ in range(SLOTS):
            replay.advance()
        pos = [row for row in replay.lifecycle.warnings() if row["scope"] == ("channel", "pos")
               and row["symptom"] == "Activity shortfall"]
        self.assertTrue(pos)
        self.assertEqual(pos[0]["opened"], "2026-10-15T09:35:00")
        self.assertEqual(pos[0]["state"], "Resolved")
        self.assertTrue(any(item["state"] == "Recovering" for item in pos[0]["timeline"]))


if __name__ == "__main__":
    unittest.main()
