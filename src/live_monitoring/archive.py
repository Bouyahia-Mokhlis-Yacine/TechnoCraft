"""Sanitized tape adapters and prior-only intraday intensity estimates."""

from dataclasses import dataclass
from hashlib import sha256
import json
from functools import cached_property
from pathlib import Path

import numpy as np
import pandas as pd

from engine.replay import INPUTS, check_fingerprints
from src.data.preprocessing import CHANNELS, category_map, clean_transactions

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "config/live_monitoring.v1.json").read_text())
MINUTES = CONFIG["base_minutes"]
SLOTS = 1440 // MINUTES
BIN = pd.Timedelta(minutes=MINUTES)
DAY = pd.Timedelta(days=1)
CHANNEL_KEYS = (*CHANNELS.values(), "unknown")
PRESETS = {
    "ordinary": "Historical activity",
    "short": "Short POS interruption",
    "merchant": "Persistent merchant degradation",
    "rejection": "POS rejection spike",
    "collective": "Collective e-commerce disruption",
    "backlog": "POS interruption with same-day backlog",
}


@dataclass(frozen=True)
class Scenario:
    symptom: str
    channel: str | None
    merchants: tuple
    onset: pd.Timestamp
    end: pd.Timestamp
    fraction: float
    seed: int
    backlog: bool = False
    pattern: str = "constant"


def inject(events, scenario):
    """Create a deterministic overlay and return the actual changed-row count."""
    s = scenario
    eligible = events.transaction_date.ge(s.onset) & events.transaction_date.lt(s.end)
    if s.channel:
        eligible &= events.channel.eq(s.channel)
    if s.merchants:
        eligible &= events.merchant_id.isin(s.merchants)
    if s.symptom in ("rejection", "cancellation", "amount"):
        eligible &= events.transaction_status.eq("Accepted")
    ids = events.index[eligible].to_numpy()
    rng = np.random.default_rng(s.seed)
    if s.pattern in ("gradual", "intermittent"):
        position = ((events.loc[ids, "transaction_date"] - s.onset) / (s.end - s.onset)).to_numpy()
        gain = position if s.pattern == "gradual" else (np.floor(position * 6) % 2 == 0)
        selected = ids[rng.random(len(ids)) < s.fraction * gain]
    else:
        selected = rng.choice(ids, size=int(np.floor(len(ids) * s.fraction + .5)), replace=False)
    result = events.copy()
    if s.symptom in ("rejection", "cancellation"):
        status = "Declined" if s.symptom == "rejection" else "Cancelled"
        result.loc[selected, "transaction_status"] = status
    elif s.symptom == "amount":
        result.loc[selected, "amount"] *= 4
    elif s.symptom == "surge":
        result = pd.concat([result, result.loc[selected]], ignore_index=True)
    elif s.symptom == "schedule":
        result.loc[selected, "transaction_date"] += s.end - s.onset
        result["hour"] = result.transaction_date.dt.hour
    elif s.symptom == "cold":
        result.loc[selected, "merchant_id"] = "MER-SIM-COLD"
    elif s.symptom == "compound":
        result.loc[selected[::2], "transaction_status"] = "Declined"
        result = result.drop(index=selected[1::2])
    elif s.backlog:
        # Preserve status, amounts and date. Spread catch-up over the following window.
        span = min(s.end - s.onset, s.onset.normalize() + DAY - s.end)
        if span <= pd.Timedelta(0):
            raise ValueError("Backlog requires remaining time on the same date.")
        result.loc[selected, "transaction_date"] = s.end + rng.random(len(selected)) * span
        result["hour"] = result.transaction_date.dt.hour
    else:
        result = result.drop(index=selected)
    return result.sort_values("transaction_date", kind="stable").reset_index(drop=True), len(selected)


def _share(counts, prior, strength):
    return (counts + strength * prior) / (counts.sum(axis=-1, keepdims=True) + strength)


class Archive:
    def __init__(self, root=ROOT):
        self.root = root
        names = ("X_train_transactions.csv", "y_train_labels.csv")
        check_fingerprints(root, {name: INPUTS[name] for name in names})
        raw = pd.read_csv(root / names[0], dtype={"masked_pan": "string"})
        self.labels = pd.read_csv(root / names[1])
        prior_raw = raw.loc[raw.transaction_date.lt(CONFIG["calibration_start"])]
        self.categories = category_map(prior_raw)
        self.events, _ = clean_transactions(raw, self.categories)
        self.events = self.events.sort_values("transaction_date", kind="stable").reset_index(drop=True)
        self.fingerprint = sha256((INPUTS[names[0]] + INPUTS[names[1]] +
                                    json.dumps(CONFIG, sort_keys=True)).encode()).hexdigest()

    @cached_property
    def reference(self):
        start, end = map(pd.Timestamp, (CONFIG["fit_start"], CONFIG["calibration_start"]))
        labels = self.labels.loc[self.labels.date.ge(CONFIG["fit_start"]) &
                                 self.labels.date.lt(CONFIG["calibration_start"])]
        eligible = labels.loc[labels.is_anomaly.eq(0), ["merchant_id", "date"]].copy()
        eligible["date"] = pd.to_datetime(eligible.date)
        prior = self.events.loc[self.events.date.ge(start) & self.events.date.lt(end)]
        prior = prior.merge(eligible, on=["merchant_id", "date"], validate="many_to_one")
        return Reference(prior, eligible, self.categories, end)

    def tape(self, start, end, preset="ordinary", scenario=None):
        start, end = pd.Timestamp(start), pd.Timestamp(end)
        if not self.reference.cutoff <= start <= end <= pd.Timestamp(CONFIG["archive_end"]):
            raise ValueError("Replay dates must be inside the training replay calendar.")
        if start != start.normalize() or end != end.normalize():
            raise ValueError("Replay requires full calendar dates.")
        if preset not in PRESETS:
            raise ValueError("Unknown scenario preset.")
        events = self.events.loc[self.events.date.between(start, end)].copy()
        scenario = scenario or self.preset(start, preset)
        changed = 0
        if scenario:
            events, changed = inject(events, scenario)
        return Tape(self.reference, start, end, events, scenario, changed)

    def preset(self, day, name):
        if name == "ordinary":
            return None
        prior = self.reference
        if name == "merchant":
            merchants = (prior.merchants[int(prior.counts[:, :, :, :].sum(axis=(1, 2, 3)).argmax())],)
        elif name == "collective":
            channel = CHANNEL_KEYS.index("ecommerce")
            rank = prior.counts[:, channel].sum(axis=(1, 2)).argsort()
            merchants = tuple(prior.merchants[i] for i in rank[-12:])
        else:
            merchants = ()
        channel = {"merchant": None, "collective": "ecommerce"}.get(name, "pos")
        duration = {"short": 15, "backlog": 30, "merchant": 360, "rejection": 120, "collective": 60}[name]
        selection = "channel" if channel else "merchant"
        scope = channel or merchants[0]
        start_slot = 36
        end_slot = SLOTS - duration // MINUTES * (2 if name == "backlog" else 1) - 1
        profile = prior.mean[day.weekday(), :, prior.index[selection, scope]]
        totals = np.convolve(profile, np.ones(duration // MINUTES), mode="valid")
        onset_slot = start_slot + int(totals[start_slot:end_slot + 1].argmax())
        onset = day + onset_slot * BIN
        return Scenario("rejection" if name == "rejection" else "drop", channel, merchants,
                        onset, onset + pd.Timedelta(minutes=duration),
                        .75 if name in ("merchant", "rejection") else 1., CONFIG["scenario_seed"],
                        name == "backlog")


class Reference:
    def __init__(self, events, roster, categories, cutoff):
        self.cutoff = cutoff
        self.merchants = tuple(sorted(roster.merchant_id.unique()))
        self.categories = {m: str(categories.get(m, "Unknown")) for m in self.merchants}
        self.cells = tuple((m, c) for m in self.merchants for c in CHANNEL_KEYS)
        self.cell_index = {key: i for i, key in enumerate(self.cells)}
        groups = {("network", "all"): list(range(len(self.cells)))}
        for cell, (merchant, channel) in enumerate(self.cells):
            for scope in (("channel", channel), ("merchant", merchant),
                          ("category", self.categories[merchant]), ("merchant-channel", f"{merchant}/{channel}")):
                groups.setdefault(scope, []).append(cell)
        self.keys = tuple(groups)
        self.index = {key: i for i, key in enumerate(groups)}
        self.weights = np.zeros((len(self.cells), len(groups)))
        for i, cells in enumerate(groups.values()):
            self.weights[cells, i] = 1
        self.counts = np.zeros((len(self.merchants), len(CHANNEL_KEYS), 7, SLOTS))
        weekdays = events.date.dt.dayofweek.to_numpy()
        minute = events.hour * 60 + events.transaction_date.dt.minute
        cells = np.array([self.cell_index[m, c] for m, c in zip(events.merchant_id, events.channel)])
        np.add.at(self.counts.reshape(-1, 7, SLOTS), (cells, weekdays, minute // MINUTES), 1)
        history = roster.assign(weekday=roster.date.dt.dayofweek).groupby(
            ["merchant_id", "weekday"]).size().unstack(fill_value=0)
        days = history.reindex(index=self.merchants, columns=range(7), fill_value=0).to_numpy()
        daily_counts = self.counts.sum(axis=-1)
        overall = daily_counts.sum(axis=-1) / days.sum(axis=-1, keepdims=True)
        k = CONFIG["weekday_prior_days"]
        daily = (daily_counts + k * overall[:, :, None]) / (days[:, None, :] + k)
        network = _share(self.counts.sum(axis=(0, 1)), np.full(SLOTS, 1 / SLOTS), SLOTS)
        strength = CONFIG["profile_prior_events"]
        channel = _share(self.counts.sum(axis=0), network, strength)
        self.cell_profiles = {}
        uniform = np.full_like(self.counts, 1 / SLOTS)
        self.cell_profiles["global"] = np.broadcast_to(network, self.counts.shape)
        self.cell_profiles["channel"] = np.broadcast_to(channel, self.counts.shape)
        self.cell_profiles["merchant"] = np.broadcast_to(
            _share(self.counts.sum(axis=1, keepdims=True), uniform[:,:1], SLOTS), self.counts.shape)
        pooled = np.zeros_like(self.counts)
        category_only = np.zeros_like(self.counts)
        for cat in sorted(set(self.categories.values())):
            members = [i for i, m in enumerate(self.merchants) if self.categories[m] == cat]
            category_only[members] = _share(self.counts[members].sum(axis=(0, 1)), network, strength)
            cat_channel = _share(self.counts[members].sum(axis=0), channel, strength)
            pooled[members] = _share(self.counts[members], cat_channel, strength)
        self.cell_profiles.update(category=category_only, hierarchical=pooled)
        self.daily_cell = daily.reshape(-1, 7)
        self.cell_mean = (daily[..., None] * pooled).reshape(-1, 7, SLOTS).transpose(1, 2, 0)
        self.mean = self.cell_mean @ self.weights
        self.support = np.array([min(days[self.merchants.index(self.cells[cell][0])].sum()
                                     for cell in subset) for subset in groups.values()])
        raw_n = np.bincount(cells, minlength=len(self.cells))
        self.support_events = raw_n @ self.weights
        self.outcomes = []
        for outcome in ("Declined", "Cancelled"):
            count = np.bincount(cells[events.transaction_status.eq(outcome)], minlength=len(self.cells))
            overall_rate = (count.sum() + 1) / (raw_n.sum() + 2)
            self.outcomes.append((count @ self.weights + CONFIG["outcome_prior_attempts"] * overall_rate) /
                                 (self.support_events + CONFIG["outcome_prior_attempts"]))
        self.amounts = {
            m: np.sort(g.amount.dropna().to_numpy())
            for m, g in events.groupby("merchant_id")
        }
        self.amount_median = np.full(len(self.keys), np.nan)
        for index, subset in enumerate(groups.values()):
            selected = {self.cells[cell] for cell in subset}
            values = events.loc[[pair in selected for pair in zip(events.merchant_id, events.channel)]]
            accepted = values.loc[values.transaction_status.eq("Accepted"), "amount"].dropna()
            if len(accepted) >= 30:
                self.amount_median[index] = accepted.median()


class Tape:
    """Sorted archive intervals with an explicit completeness watermark."""

    def __init__(self, reference, start, end, events, scenario, changed):
        self.ref, self.start, self.end, self.events = reference, start, end, events
        self.scenario, self.changed = scenario, changed
        self.size = ((end - start).days + 1) * SLOTS
        self.bins = ((events.transaction_date - start) // BIN).to_numpy(dtype=int)
        self.offsets = np.searchsorted(self.bins, np.arange(self.size + 1))
        self.complete = np.ones(self.size, dtype=bool)
        self.mean = np.concatenate([reference.mean[d.weekday()] for d in pd.date_range(start, end)])

    def interval(self, index):
        return self.events.iloc[self.offsets[index]:self.offsets[index + 1]]
