"""Separate daily closure adapter around the unchanged competition engine."""

from functools import cached_property

import pandas as pd

from engine.replay import CONFIGS, ROOT, check_fingerprints
from src.data.aggregation import merchant_days
from src.detection.incidents import IncidentMonitor
from src.detection.references import Batch, fit_reference
from src.detection.sequential_evaluation import load_configs
from .archive import CONFIG, DAY, SLOTS


class DailyClosure:
    def __init__(self, archive, tape):
        self.archive, self.tape = archive, tape
        self.states = {}

    @cached_property
    def model(self):
        check_fingerprints(ROOT / "config", CONFIGS)
        v1, v2 = load_configs(ROOT)
        cutoff = min(self.tape.start, pd.Timestamp(CONFIG["development_start"]))
        labels = self.archive.labels
        calendar = labels.loc[labels.date.lt(cutoff.date().isoformat()) & labels.is_anomaly.eq(0),
                              ["merchant_id", "date"]]
        events = self.archive.events.loc[self.archive.events.date.lt(cutoff)]
        keys = pd.MultiIndex.from_frame(calendar.assign(date=pd.to_datetime(calendar.date)))
        events = events.loc[pd.MultiIndex.from_frame(events[["merchant_id", "date"]]).isin(keys)]
        days = merchant_days(events, calendar, self.archive.categories)
        return v1, IncidentMonitor.from_config(v2), fit_reference(days, events, self.tape.start, v1["version"])

    def close(self, index):
        day = self.tape.start + (index // SLOTS) * DAY
        date = day.date().isoformat()
        start = index + 1 - SLOTS
        if not self.tape.complete[start:index + 1].all():
            return {"date": date, "status": "incomplete", "scored": 0, "flagged": []}
        events = self.tape.events.iloc[self.tape.offsets[start]:self.tape.offsets[index + 1]]
        calendar = self.archive.labels.loc[self.archive.labels.date.eq(date), ["merchant_id", "date"]]
        days = merchant_days(events, calendar, self.archive.categories)
        v1, monitor, reference = self.model
        self.states, results = monitor.step_day(
            day, Batch("complete", day), days, events, reference, {reference.version: reference}, self.states, v1)
        return {"date": date, "status": "complete", "scored": sum(r.scores is not None for r, _ in results.values()),
                "flagged": [{"merchant": m, "score": r.scores["managed"]} for m, (r, _) in results.items()
                            if r.alert and r.scores is not None]}
