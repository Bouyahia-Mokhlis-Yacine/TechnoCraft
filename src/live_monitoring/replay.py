"""Incident lifecycle and bounded dashboard history for one replay."""

from collections import deque
from math import isfinite

import numpy as np
from scipy.stats import poisson

from .archive import BIN, CONFIG, MINUTES, SLOTS
from .daily import DailyClosure
from .detection import SYMPTOMS, Signals

ACTIVE = {"Early warning", "Persistent warning", "Recovering", "Uncertain"}


class Lifecycle:
    def __init__(self):
        self.live = {}
        self.resolved = deque(maxlen=100)

    def update(self, key, time, score, threshold, evidence=None, *, complete=True):
        warning = self.live.get(key)
        if not complete:
            if warning:
                self.transition(warning, "Uncertain", time)
                warning["quiet"] = 0
            return
        if score > threshold and evidence is not None:
            if warning is None:
                warning = {"id": f"{key[0]}:{key[1]}:{time}", "opened": time, "state": "Early warning",
                           "timeline": [{"time": time, "state": "Early warning"}], "hits": 0, "quiet": 0}
                self.live[key] = warning
            warning["hits"] += 1
            warning["quiet"] = 0
            warning.update(evidence, last=time, score=float(score))
            if warning["hits"] >= 2:
                self.transition(warning, "Persistent warning", time)
        elif warning is not None and score <= threshold * .65:
            warning["quiet"] += 1
            self.transition(warning, "Recovering", time)
            if warning["quiet"] >= 3:
                self.transition(warning, "Resolved", time)
                self.resolved.append(warning)
                del self.live[key]
        elif warning is not None:
            warning["quiet"] = 0

    @staticmethod
    def transition(warning, state, time):
        if warning["state"] != state:
            warning["state"] = state
            warning["timeline"].append({"time": time, "state": state})
            warning["timeline"] = warning["timeline"][-24:]

    def warnings(self):
        return [*self.live.values(), *reversed(self.resolved)]


class Replay:
    def __init__(self, archive, tape, thresholds, *, close_daily=True):
        self.tape, self.ref = tape, tape.ref
        self.thresholds = thresholds
        self.signals = Signals(tape)
        self.lifecycle = Lifecycle()
        self.history = deque(maxlen=SLOTS)
        self.domain = deque(maxlen=100)
        self.daily = []
        self.closure = DailyClosure(archive, tape) if close_daily else None
        self.tick_count = 0
        self.current = {}

    @property
    def clock(self):
        return self.tape.start + self.tick_count * BIN

    def advance(self):
        i = self.tick_count
        if i >= self.tape.size:
            return False
        scores, scans, obs, windows, outcomes, medians = self.signals.tick(i)
        expected = self.tape.mean[i]
        time = (self.clock + BIN).isoformat()
        complete = bool(self.tape.complete[i])
        selected = scores["selected"]
        threshold = self.thresholds["selected"]
        tested = {(int(scope), int(symptom)) for scope, symptom in np.argwhere(selected > threshold)}
        for j, symptom in sorted(tested | {key for key in self.lifecycle.live if isinstance(key[0], int)}):
            scope = self.ref.keys[j]
            score = selected[j, symptom]
            start, total, mu = i, obs[j, 0], expected[j]
            signal = "Directional CUSUM"
            if symptom >= 2:
                start, total, mu = i - 5, outcomes[j, symptom - 1], outcomes[j, 0] * self.ref.outcomes[symptom - 2][j]
                signal = "Beta–Binomial predictive tail"
                if complete and (i + 1) % 6:
                    continue
            elif score == scores["adaptive"][j, symptom] and score > 0:
                start, total, mu = windows[0][j], windows[1][j, 0], windows[2][j]
                signal = "Exposure-gated Poisson tail"
            elif symptom == 0 and score == scores["gap"][j, 0] and score > 0:
                last = self.signals.last_event[j]
                start = max(i - i % SLOTS, int((last - self.tape.start.to_datetime64()) //
                            BIN.to_timedelta64())) if not np.isnat(last) else i - i % SLOTS
                total, mu = 0, self.signals.gap[j]
                signal = "Interarrival exposure"
            elif score > 0:
                start = self.signals.cusum_start[j, symptom]
                total = self.signals.cusum_observed[j, symptom]
                mu = self.signals.cusum_expected[j, symptom]
            evidence = self._evidence(scope, SYMPTOMS[symptom], time, start, total, mu, signal)
            evidence.update({"reference_days": int(self.ref.support[j]), "cusum": self.signals.cusum[j].tolist(),
                             "kind": "Intraday early warning"})
            self.lifecycle.update((j, symptom), time, score, threshold, evidence, complete=complete)
        if not complete or (i + 1) % 3 == 0:
            self._collective_updates(scans, i, time, complete)
        if (i + 1) % SLOTS == 0 and self.closure:
            closure = self.closure.close(i)
            self.daily.append(closure)
            flagged = {item["merchant"] for item in closure["flagged"]}
            for warning in self.lifecycle.warnings():
                if warning["scope"][0] == "merchant" and warning["scope"][1] in flagged and (
                        warning["opened"][:10] <= closure["date"] <= warning["through"][:10]):
                    warning["timeline"].append({"time": time, "state": "Overlapping simulated daily flag"})
        lower, upper = poisson.ppf(.05, expected), poisson.ppf(.95, expected)
        self.history.append({"time": time, "observed": obs, "expected": expected,
                             "lower": lower, "upper": upper, "cum": self.signals.running.copy(),
                             "cum_expected": self.signals.running_expected.copy(), "complete": complete})
        self.current = medians
        self.domain.extend(self.signals.domains)
        self.tick_count += 1
        return True

    def _collective_updates(self, scans, i, time, complete):
        threshold = self.thresholds["collective"]
        seen = {}
        for scan in scans:
            key = ("/".join(scan["scope"]), scan["symptom"])
            seen[key] = scan
        pending = {key for key in self.lifecycle.live if isinstance(key[0], str)}
        for key in sorted(set(seen) | pending):
            scan = seen.get(key)
            evidence = None
            if scan:
                evidence = self._evidence(scan["scope"], scan["symptom"], time, max(0, i - 2),
                                          scan["observed"], scan["expected"], "Subset scan likelihood ratio")
                corroborated = [m for m in scan["merchants"] if any(
                    row.get("scope") == ("merchant", m) and row["symptom"] == scan["symptom"].removeprefix("Shared ").capitalize()
                    for row in self.lifecycle.live.values())]
                evidence.update({"kind": "Collective advisory", "merchants": scan["merchants"],
                                 "corroborated": corroborated,
                                 "difference": scan["expected"] - scan["observed"],
                                 "limitation": "The selected merchants share a symptom. Verify traffic, feed health and channel telemetry independently."})
            self.lifecycle.update(key, time, scan["score"] if scan else 0, threshold, evidence, complete=complete)

    def _evidence(self, scope, symptom, end, start, observed, expected, signal):
        window = (self.tape.start + int(start) * BIN).isoformat()
        action = ("Check issuer response codes and channel telemetry." if "rejection" in symptom.lower()
                  else "Check ingestion completeness and compare channel telemetry with expected traffic.")
        unit = "declines" if "rejection" in symptom.lower() else "cancellations" if "cancellation" in symptom.lower() else "transactions"
        return {"scope": scope, "symptom": symptom, "from": window, "through": end, "observed": int(observed),
                "expected": float(expected), "signal": signal, "unit": unit, "action": action,
                "explanation": f"{scope[1]} recorded {observed:.0f} {unit} versus {expected:.1f} expected in the evidence window. "
                               f"{signal} crossed the replay warning threshold.",
                "limitation": "Replay evidence supports investigation. Independent telemetry is required to establish a service interruption."}

    def snapshot(self, scope=("network", "all"), limit=SLOTS):
        j = self.ref.index[scope]
        points = []
        recent = list(self.history)[-limit:]
        if limit == SLOTS and recent:
            current_day = (self.clock - BIN).date().isoformat()
            recent = [row for row in recent if row["time"][:10] == current_day or
                      (row is recent[-1] and row["time"][11:16] == "00:00")]
            if self.tick_count > SLOTS and len(recent) > 1 and recent[0]["time"][11:16] == "00:00":
                recent = recent[1:]
        for row in recent:
            values = row["observed"][j]
            cum = row["cum"][j]
            points.append({"time": row["time"], "observed": int(values[0]), "expected": float(row["expected"][j]),
                           "lower": int(row["lower"][j]), "upper": int(row["upper"][j]),
                           "cumulative": int(cum[0]), "cumulative_expected": float(row["cum_expected"][j]),
                           "rejections": int(values[1]), "cancellations": int(values[2]),
                           "accepted_value": float(values[3]), "daily_value": float(cum[3]),
                           "daily_rejections": int(cum[1]), "complete": row["complete"]})
        latest = self.signals.last_event[j]
        age = (self.clock.to_datetime64() - latest) / np.timedelta64(1, "m") if not np.isnat(latest) else None
        active = list(self.lifecycle.live.values())
        direct = [w for w in active if w["kind"] == "Intraday early warning"]
        affected_merchants = {m for w in active for m in
                              w.get("merchants", [w["scope"][1]] if w["scope"][0] == "merchant" else [])}
        affected_channels = {w["scope"][1] for w in active if w["scope"][0] == "channel"}
        last = points[-1] if points else None
        summary = {"transactions_per_minute": last["observed"] / MINUTES if last else None,
                   "daily_rejection_rate": last["daily_rejections"] / last["cumulative"]
                   if last and last["cumulative"] else None,
                   "minutes_since_event": float(age) if age is not None else None,
                   "active_individual": len(direct), "active_collective": len(active) - len(direct),
                   "affected_merchants": len(affected_merchants), "affected_channels": len(affected_channels)}
        s = self.tape.scenario
        historical_median = self.ref.amount_median[j]
        day_start = ((self.tick_count - 1) // SLOTS) * SLOTS if self.tick_count else 0
        day_complete = self.tape.complete[day_start:self.tick_count].all()
        return {"clock": self.clock.isoformat(), "watermark": self.clock.isoformat() if self.tick_count else None,
                "progress": self.tick_count / self.tape.size, "points": points, "scope": scope, "summary": summary,
                "scopes": [key for key in self.ref.keys if key[0] != "merchant-channel"],
                "last_event": str(latest)[:19] if not np.isnat(latest) else None,
                "reference_days": int(self.ref.support[j]), "reference_events": int(self.ref.support_events[j]),
                "monitoring": {"base_minutes": MINUTES, "adaptive_expected_events": CONFIG["minimum_exposure"],
                               "adaptive_max_minutes": CONFIG["maximum_window_bins"] * MINUTES,
                               "downward_cusum": float(self.signals.cusum[j, 0]),
                               "upward_cusum": float(self.signals.cusum[j, 1])},
                "median_ticket": self.current.get(j),
                "minimum_amount_tail": self.signals.amount_rarity.get(j),
                "reference_median_ticket": float(historical_median) if isfinite(historical_median) else None,
                "warnings": self.lifecycle.warnings(), "domain": list(reversed(self.domain)), "daily": self.daily,
                "feed": "Complete through watermark" if self.tick_count and day_complete
                        else "Incomplete interval" if self.tick_count else "Awaiting first finalized interval",
                "truth": {"onset": s.onset.isoformat(), "end": s.end.isoformat(), "channel": s.channel,
                          "merchants": s.merchants, "changed_events": self.tape.changed, "same_day_backlog": s.backlog}
                         if s else None}
