"""Event-time scoring. Every sequential increment consumes one finalized bin."""

from collections import defaultdict
from math import log

import numpy as np
from scipy.stats import betabinom, poisson

from src.detection.collective import poisson_scan, rejection_scan
from .archive import BIN, CHANNEL_KEYS, CONFIG, MINUTES, SLOTS

SYMPTOMS = ("Activity shortfall", "Activity surge", "Rejection increase", "Cancellation increase")
METHODS = ("fixed", "cumulative", "adaptive", "gap", "cusum", "fusion", "collective", "selected")


def tail_score(probability):
    return -np.log(np.clip(probability, 1e-100, 1))


class Signals:
    """Per-bin non-overlapping updates plus separately calibrated candidate methods."""

    def __init__(self, tape, *, collective_bins=3):
        self.tape = tape
        self.ref = tape.ref
        self.size = len(self.ref.keys)
        self.counts = np.zeros((self.size, 4))
        self.window_expected = np.zeros(self.size)
        self.window_start = np.zeros(self.size, dtype=int)
        self.gap = np.zeros(self.size)
        self.cusum = np.zeros((self.size, 2))
        self.cusum_start = np.zeros((self.size, 2), dtype=int)
        self.cusum_observed = np.zeros((self.size, 2))
        self.cusum_expected = np.zeros((self.size, 2))
        self.running = np.zeros((self.size, 4))
        self.running_expected = np.zeros(self.size)
        self.last_event = np.full(self.size, np.datetime64("NaT", "ns"))
        self.outcome_window = np.zeros((self.size, 4))
        self.collective_n = np.zeros(len(self.ref.cells))
        self.collective_d = np.zeros(len(self.ref.cells))
        self.collective_mu = np.zeros(len(self.ref.cells))
        self.collective_good = True
        self.collective_bins = collective_bins
        self.positions = np.array([np.flatnonzero(self.ref.weights[cell])
                                   for cell in range(len(self.ref.cells))])
        self.monitored = np.array([kind != "merchant-channel" for kind, _ in self.ref.keys])
        self.eligible = self.monitored & (self.ref.support >= CONFIG["minimum_reference_days"]) & (
            self.ref.support_events > 0)
        self.scopes = np.array([key[0] for key in self.ref.keys])
        self.resolutions = np.where(self.scopes == "network", 1, np.where(self.scopes == "channel", 3, 1))
        self.ratios = np.asarray(CONFIG["ratios"])
        self.amount_rarity = {}
        self.domains = []

    def _aggregate(self, events, end):
        totals = np.zeros((self.size, 4))
        pairs = np.zeros((len(self.ref.cells), 2))
        accepted_amounts = defaultdict(list)
        last = np.full(self.size, np.nan)
        self.amount_rarity, self.domains = {}, []
        for row in events.itertuples(index=False):
            cell = self.ref.cell_index.get((row.merchant_id, row.channel))
            indices = self.positions[cell] if cell is not None else (0, self.ref.index["channel", row.channel])
            valid = np.isfinite(row.amount)
            value = row.amount if valid and row.transaction_status == "Accepted" else 0
            declined = row.transaction_status == "Declined"
            cancelled = row.transaction_status == "Cancelled"
            totals[list(indices)] += [1, declined, cancelled, value]
            if cell is not None:
                pairs[cell] += [1, declined]
            last[list(indices)] = (end - row.transaction_date).total_seconds() / (MINUTES * 60)
            self.last_event[list(indices)] = row.transaction_date.to_datetime64()
            if valid and row.transaction_status == "Accepted":
                for index in indices:
                    accepted_amounts[index].append(row.amount)
            if valid and row.channel == "nfc" and row.amount > 2500:
                self.domains.append({"time": row.transaction_date.isoformat(), "merchant": row.merchant_id,
                                     "amount": float(row.amount), "rule": "Contactless above 2,500 DZD"})
            sample = self.ref.amounts.get(row.merchant_id)
            if valid and sample is not None and len(sample) >= 30:
                left, right = sample.searchsorted(row.amount, side="left"), sample.searchsorted(row.amount, side="right")
                rarity = min(1., 2 * (1 + min(right, len(sample) - left)) / (1 + len(sample)))
                for index in indices:
                    self.amount_rarity[index] = min(rarity, self.amount_rarity.get(index, 1.))
        median = {idx: float(np.median(values)) for idx, values in accepted_amounts.items()}
        return totals, pairs, last, median

    def tick(self, i, *, scan=True):
        position = i % SLOTS
        if position == 0:
            self.running.fill(0)
            self.running_expected.fill(0)
            self.cusum.fill(0)
            self.cusum_start.fill(i)
            self.cusum_observed.fill(0)
            self.cusum_expected.fill(0)
            self.gap.fill(0)
            self.counts.fill(0)
            self.window_expected.fill(0)
            self.window_start.fill(i)
            self.outcome_window.fill(0)
            self.outcome_good = True
        end = self.tape.start + (i + 1) * BIN
        mu = self.tape.mean[i]
        complete = self.tape.complete[i]
        obs, pairs, last, medians = self._aggregate(self.tape.interval(i), end)
        n = obs[:, 0]
        self.running += obs
        self.running_expected += mu
        low = np.zeros((self.size, 4))
        scores = {key: low.copy() for key in METHODS if key != "collective"}
        windows = (self.window_start.copy(), self.counts.copy(), self.window_expected.copy())
        if complete:
            self.counts += obs
            self.window_expected += mu
            self.outcome_window += obs
            self.cusum = np.maximum(0, self.cusum + n[:, None] * np.log(self.ratios) -
                                    mu[:, None] * (self.ratios - 1))
            positive = self.cusum > 0
            self.cusum_start[~positive] = i + 1
            self.cusum_observed = np.where(positive, self.cusum_observed + n[:, None], 0)
            self.cusum_expected = np.where(positive, self.cusum_expected + mu[:, None], 0)
            self.gap = np.where(np.isnan(last), self.gap + mu, np.nan_to_num(last) * mu)
            fixed = self.eligible & (mu >= 0.1)
            scores["fixed"][fixed, :2] = self._counts(n[fixed], mu[fixed])
            cumulative = self.eligible & (self.running_expected >= CONFIG["minimum_exposure"])
            scores["cumulative"][cumulative, :2] = self._counts(
                self.running[cumulative, 0], self.running_expected[cumulative])
            ready = ((self.window_expected >= CONFIG["minimum_exposure"]) &
                     ((position + 1) % self.resolutions == 0))
            ready |= i - self.window_start + 1 >= CONFIG["maximum_window_bins"]
            tested = ready & self.eligible & (self.window_expected >= CONFIG["minimum_exposure"])
            scores["adaptive"][tested, :2] = self._counts(self.counts[tested, 0], self.window_expected[tested])
            scores["gap"][self.eligible, 0] = self.gap[self.eligible]
            scores["cusum"][self.eligible, :2] = self.cusum[self.eligible]
            windows = (self.window_start.copy(), self.counts.copy(), self.window_expected.copy())
            self.counts[ready] = 0
            self.window_expected[ready] = 0
            self.window_start[ready] = i + 1
        else:
            self.counts.fill(0)
            self.window_expected.fill(0)
            self.window_start.fill(i + 1)
            self.gap.fill(0)
            self.cusum.fill(0)
            self.cusum_start.fill(i + 1)
            self.cusum_observed.fill(0)
            self.cusum_expected.fill(0)
            self.outcome_good = False
        outcome_obs = self.outcome_window.copy()
        if (position + 1) % 6 == 0:
            attempts = self.outcome_window[:, 0]
            eligible = self.eligible & (attempts >= CONFIG["minimum_outcome_attempts"]) & self.outcome_good
            for outcome, p in enumerate(self.ref.outcomes):
                strength = CONFIG["outcome_prior_attempts"]
                scores["fusion"][eligible, outcome + 2] = tail_score(betabinom.sf(
                    self.outcome_window[eligible, outcome + 1] - 1, attempts[eligible],
                    p[eligible] * strength, (1 - p[eligible]) * strength))
            self.outcome_window.fill(0)
            self.outcome_good = True
        scores["fusion"][:, :2] = np.maximum(scores["fixed"][:, :2], scores["cusum"][:, :2])
        scores["selected"] = np.maximum.reduce([scores["adaptive"], scores["cusum"],
                                                scores["gap"], scores["fusion"] *
                                                np.array([0., 0., 1., 1.])])
        weekday = end.dayofweek if position != SLOTS - 1 else (end.dayofweek - 1) % 7
        advisories = self._collective(position, pairs, self.ref.cell_mean[weekday, position], complete) if scan else []
        return scores, advisories, obs, windows, outcome_obs, medians

    @staticmethod
    def _counts(n, mu):
        return np.column_stack((tail_score(poisson.cdf(n, mu)), tail_score(poisson.sf(n - 1, mu))))

    def _collective(self, position, pairs, mu, complete):
        self.collective_n += pairs[:, 0]
        self.collective_d += pairs[:, 1]
        self.collective_mu += mu
        self.collective_good &= complete
        if (position + 1) % self.collective_bins:
            return []
        n, d, expected = self.collective_n.copy(), self.collective_d.copy(), self.collective_mu.copy()
        good = self.collective_good
        self.collective_n.fill(0)
        self.collective_d.fill(0)
        self.collective_mu.fill(0)
        self.collective_good = True
        if not good:
            return []
        result = []
        groups = [(("channel", c), np.arange(j, len(n), len(CHANNEL_KEYS)))
                  for j, c in enumerate(CHANNEL_KEYS) if c != "unknown"]
        categories = {c for kind, c in self.ref.keys if kind == "category" and c != "Unknown"}
        for category in sorted(categories):
            active = self.ref.weights[:, self.ref.index["category", category]].astype(bool)
            groups.append((("category", category), np.flatnonzero(active)))
        for key, indices in groups:
            merchants = np.array(self.ref.merchants)
            members = indices // len(CHANNEL_KEYS)
            count, decline, mean = (np.bincount(members, weights=values[indices], minlength=len(merchants))
                                    for values in (n, d, expected))
            scope = self.ref.index[key]
            probability = np.full(len(merchants), self.ref.outcomes[0][scope])
            include = mean >= .35
            if include.sum() >= 2:
                selected, score, _ = poisson_scan(count[include], mean[include], "drop")
                selected = list(selected)
                self._add_scan(result, key, "Shared activity shortfall", score, merchants[include][selected],
                               count[include][selected], mean[include][selected])
            include = count >= 2
            if include.sum() >= 2:
                selected, score, _ = rejection_scan(decline[include], count[include], probability[include],
                                                    (2., 4., 8.))
                selected = list(selected)
                self._add_scan(result, key, "Shared rejection increase", score, merchants[include][selected],
                               decline[include][selected], (count * probability)[include][selected])
        return result

    @staticmethod
    def _add_scan(result, key, symptom, score, merchants, observed, expected):
        if score > 0:
            result.append({"scope": key, "symptom": symptom, "score": float(score),
                           "merchants": merchants.tolist(), "observed": int(observed.sum()),
                           "expected": float(expected.sum())})
