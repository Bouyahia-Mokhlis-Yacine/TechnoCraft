"""Chronological workload and held-out archive overlays. No official test input."""

import argparse
import json
from itertools import product
from pathlib import Path
from time import perf_counter

import numpy as np
import pandas as pd
from scipy.special import ive
from scipy.stats import nbinom, poisson

from .archive import Archive, BIN, CONFIG, DAY, MINUTES, ROOT, SLOTS, Scenario
from .daily import DailyClosure
from .detection import METHODS, Signals
from .replay import Replay

OUT = ROOT / "reports/live_monitoring"
THRESHOLD_FILE = ROOT / "config/live_monitoring.calibration.v1.json"


def trace(tape, *, scan=True):
    model = Signals(tape)
    individual = {k: np.zeros((tape.size, len(tape.ref.keys), 4)) for k in METHODS if k != "collective"}
    results = []
    for i in range(tape.size):
        scores, scans, _, _, _, _ = model.tick(i, scan=scan)
        for key, value in scores.items():
            individual[key][i] = value
        results.append(scans)
    return individual, results


def maxima(tape, individual, results):
    daily = {key: values.reshape(-1, SLOTS, *values.shape[1:]).max(axis=(1, 2, 3))
             for key, values in individual.items()}
    daily["collective"] = np.array([max((s["score"] for scans in results[a:a + SLOTS] for s in scans), default=0)
                                    for a in range(0, tape.size, SLOTS)])
    return daily


def calibrate(archive, *, publish=True):
    start = pd.Timestamp(CONFIG["calibration_start"])
    end = pd.Timestamp(CONFIG["evaluation_start"]) - DAY
    tape = archive.tape(start, end)
    daily = maxima(tape, *trace(tape))
    scenarios = {}
    # Day maxima include every monitored scope, symptom and time. Split the
    # fleet budget between individual warning days and collective advisory days.
    for value in (0.5, 1, 2):
        quantile = 1 - value / 4
        scenarios[str(value)] = {key: float(np.quantile(x, quantile, method="higher")) for key, x in daily.items()}
    thresholds = scenarios[str(CONFIG["calibration_budget_per_day"])]
    payload = {"archive_fingerprint": archive.fingerprint, "first": str(start.date()), "last": str(end.date()),
               "thresholds": thresholds, "budget_sensitivity": scenarios,
               "day_maxima": {k: v.tolist() for k, v in daily.items()}}
    if publish:
        THRESHOLD_FILE.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return payload


def locked_thresholds(archive):
    calibration = json.loads(THRESHOLD_FILE.read_text(encoding="utf-8"))
    if calibration["archive_fingerprint"] != archive.fingerprint:
        raise ValueError("The archived input or intraday configuration changed. Recalibrate before replay.")
    return calibration["thresholds"]


def workload(archive, tape, thresholds):
    replay = Replay(archive, tape, thresholds, close_daily=False)
    notifications, warning_ticks = {}, 0
    for _ in range(tape.size):
        replay.advance()
        warning_ticks += bool(replay.lifecycle.live)
        for item in replay.lifecycle.live.values():
            notifications.setdefault(item["id"], (item["kind"], *item["scope"], item["symptom"],
                                                   item["opened"][:10]))
    rows = list(notifications.values())
    days = tape.size // SLOTS
    merchant = sum(kind == "merchant" for _, kind, *_ in rows)
    return {
        "days": days, "merchant_days": days * len(tape.ref.merchants),
        "merchant_warnings": merchant,
        "merchant_warnings_per_day": merchant / (days * len(tape.ref.merchants)),
        "merchant_warnings_per_week": 7 * merchant / (days * len(tape.ref.merchants)),
        "network_warnings_per_day": sum(kind == "network" for _, kind, *_ in rows) / days,
        "all_notifications": len(rows), "collective_notifications": sum(a == "Collective advisory" for a, *_ in rows),
        "repeat_scope_symptom_day": len(rows) - len(set(rows)), "fraction_time_warning": warning_ticks / tape.size,
        "notifications_per_day": len(rows) / days,
    }


def diagnostics(archive, start, end):
    # Derive all time scales directly from the unchanged card-free training tape.
    tape = archive.tape(start, end)
    prior = tape.ref
    days = (end - start).days + 1
    events = tape.events
    minute = ((events.transaction_date - start).dt.total_seconds() // 60).to_numpy(dtype=int)
    cell = np.array([prior.cell_index.get((m, c), -1) for m, c in zip(events.merchant_id, events.channel)])
    valid = cell >= 0
    diagnostics_rows, probability_rows = [], []
    fitting_start = pd.Timestamp(CONFIG["fit_start"])
    fitting_end = pd.Timestamp(CONFIG["calibration_start"]) - DAY
    dates_fit = pd.date_range(fitting_start, fitting_end)
    fitting = archive.events.loc[archive.events.date.between(fitting_start, fitting_end)]
    normal = archive.labels.loc[archive.labels.is_anomaly.eq(0), ["merchant_id", "date"]]
    normal = normal.assign(date=pd.to_datetime(normal.date))
    fitting = fitting.merge(normal, on=["merchant_id", "date"], validate="many_to_one")
    fitting_cells = np.array([prior.cell_index[m, c] for m, c in zip(fitting.merchant_id, fitting.channel)])
    fitting_minutes = ((fitting.transaction_date - fitting_start).dt.total_seconds() // 60).to_numpy(dtype=int)
    # Use each day's complete chronological tape, including explicit zero bins.
    for resolution in (1, 5, 15, 30, 60, 180, 360, 1440):
        slots = 1440 // resolution
        observations = np.zeros((days * slots, len(prior.cells)))
        outcomes = [np.zeros_like(observations), np.zeros_like(observations)]
        np.add.at(observations, (minute[valid] // resolution, cell[valid]), 1)
        for status, x in zip(("Declined", "Cancelled"), outcomes):
            selected = valid & events.transaction_status.eq(status)
            np.add.at(x, (minute[selected] // resolution, cell[selected]), 1)
        network = observations @ prior.weights
        rejected, cancelled = (x @ prior.weights for x in outcomes)
        means = {}
        for name, share in prior.cell_profiles.items():
            weekday = pd.date_range(start, end).dayofweek.to_numpy()
            matrix = (share.reshape(-1, 7, SLOTS) * prior.daily_cell[..., None]).transpose(1, 2, 0)
            fine = (matrix[weekday] @ prior.weights).reshape(days, SLOTS, -1)
            if resolution == 1:
                means[name] = np.repeat(fine / MINUTES, MINUTES, axis=1).reshape(-1, len(prior.keys))
            else:
                means[name] = fine.reshape(days, slots, resolution // MINUTES, -1).sum(axis=2).reshape(
                    -1, len(prior.keys))
        for col, (kind, name) in enumerate(prior.keys):
            base = network[:, col]
            mu = means["hierarchical"][:, col]
            counts = base.reshape(days, slots)
            left, right = base[:-1], base[1:]
            acf = np.corrcoef(left, right)[0, 1] if left.std() and right.std() else np.nan
            selected = cell >= 0
            selected[selected] = prior.weights[cell[selected], col] > 0
            gaps = np.diff(events.transaction_date[selected].to_numpy()).astype("timedelta64[s]").astype(float)
            q = np.quantile(gaps, [.1, .5, .9]) if len(gaps) else [np.nan] * 3
            diagnostics_rows.append({"minutes": resolution, "scope": kind, "name": name, "mean": base.mean(),
                                     "variance": base.var(), "vmr": base.var() / base.mean() if base.mean() else np.nan,
                                     "empty_fraction": (base == 0).mean(), "mean_expected": mu.mean(),
                                     "reference_days": prior.support[col], "rejection_fraction": rejected[:, col].sum() / max(1, base.sum()),
                                     "cancellation_fraction": cancelled[:, col].sum() / max(1, base.sum()),
                                     "acf1": acf, "gap_p10_seconds": q[0], "gap_p50_seconds": q[1],
                                     "gap_p90_seconds": q[2],
                                     "time_bin_means": json.dumps(counts.mean(axis=0).round(4).tolist()),
                                     "weekday_means": json.dumps(pd.Series(counts.sum(axis=1)).groupby(
                                         pd.date_range(start, end).dayofweek).mean().round(4).tolist())})
        # Predictive comparison at the core operational scopes and horizons.
        if resolution in (5, 15, 60, 360, 1440):
            fitting_counts = np.zeros((len(dates_fit) * slots, len(prior.cells)))
            np.add.at(fitting_counts, (fitting_minutes // resolution, fitting_cells), 1)
            fitting_counts = (fitting_counts @ prior.weights).reshape(len(dates_fit), slots, -1)
            fitting_mu = prior.mean[dates_fit.dayofweek].reshape(
                len(dates_fit), slots, resolution // MINUTES, -1).sum(axis=2)
            for kind in ("network", "channel", "merchant", "category", "merchant-channel"):
                cols = [i for i, key in enumerate(prior.keys) if key[0] == kind and prior.support_events[i] >= 30]
                y = network[:, cols].ravel()
                for profile, matrix in means.items():
                    mu = matrix[:, cols].ravel()
                    probability_rows.append(predictive_scores(y, mu, poisson(mu), resolution, kind, profile, "Poisson"))
                # Concentration chosen beforehand. This is a Gamma–Poisson
                # comparator, not a fitted dispersion alternative.
                for shape in (3, 15):
                    law = nbinom(shape, shape / (shape + mu))
                    probability_rows.append(predictive_scores(y, mu, law, resolution, kind, "hierarchical",
                                                              f"Gamma–Poisson k={shape}"))
                fit_y, fit_mu = fitting_counts[:, :, cols], fitting_mu[:, :, cols]
                alpha = max(0., float((((fit_y - fit_mu) ** 2 - fit_mu).sum()) / max(1, (fit_mu**2).sum())))
                law = poisson(mu) if alpha < 1e-6 else nbinom(1 / alpha, 1 / (1 + alpha * mu))
                probability_rows.append({**predictive_scores(y, mu, law, resolution, kind, "hierarchical",
                                                              "Fitted negative binomial"), "alpha": alpha})
                probability_rows.append(empirical_scores(y, mu, fit_y, resolution, kind))
    pd.DataFrame(diagnostics_rows).to_csv(OUT / "temporal_diagnostics.csv", index=False)
    pd.DataFrame(probability_rows).to_csv(OUT / "predictive_comparison.csv", index=False)


def predictive_scores(y, mu, law, resolution, scope, profile, distribution):
    # Exact discrete CRPS identity up to the upper numerical tail.
    # Chunking avoids a dense outcomes-by-support array at daily network scale.
    loss = np.zeros(len(y))
    for at in range(0, len(y), 2048):
        sl = slice(at, at + 2048)
        sublaw = law.dist(*(np.asarray(arg)[sl] if np.asarray(arg).ndim else arg for arg in law.args))
        max_k = int(max(y[sl].max(), sublaw.ppf(.99999).max()))
        for low in range(0, max_k + 1, 128):
            support = np.arange(low, min(low + 128, max_k + 1))[:, None]
            loss[sl] += np.sum((sublaw.cdf(support) - (support >= y[sl])) ** 2, axis=0)
    return summarise_probabilities(y, mu, resolution, scope, profile, distribution, loss, law.logpmf(y),
                                   law.pmf(0), law.cdf(y), law.sf(y - 1), law.cdf(y - 1))


def summarise_probabilities(y, mu, resolution, scope, profile, distribution, loss, logprob, zero, cdf, sf, prev):
    return {"minutes": resolution, "scope": scope, "profile": profile, "distribution": distribution,
            "rows": len(y), "nll": -np.maximum(logprob, -700).mean(), "crps": loss.mean(),
            "mae": np.abs(mu - y).mean(), "coverage90": np.mean((cdf >= .05) & (prev < .95)),
            "zero_expected": zero.mean(), "zero_observed": (y == 0).mean(),
            "lower_tail_05": (cdf <= .05).mean(), "upper_tail_05": (sf <= .05).mean()}


def empirical_scores(y, mu, past, resolution, scope):
    # Same wall-clock interval, all fit dates, plus a four-day Poisson prior.
    # Use histograms to keep the comparison feasible at low-count scopes.
    history = past.reshape(len(past), -1)
    weights = 4 / (len(history) + 4)
    n = history.shape[1]
    probability, zero, cdf, prev, loss = (np.zeros(len(y)) for _ in range(5))
    empirical_mean = weights * mu + (1 - weights) * np.tile(history.mean(axis=0), len(y) // n)
    for start in range(0, len(y), 1024):
        sl = slice(start, min(start + 1024, len(y)))
        ix = np.arange(start, sl.stop) % n
        observed = y[sl]
        prior = poisson(mu[sl])
        h = history[:, ix]
        probability[sl] = weights * prior.pmf(observed) + (1 - weights) * (h == observed).mean(axis=0)
        zero[sl] = weights * prior.pmf(0) + (1 - weights) * (h == 0).mean(axis=0)
        cdf[sl] = weights * prior.cdf(observed) + (1 - weights) * (h <= observed).mean(axis=0)
        prev[sl] = weights * prior.cdf(observed - 1) + (1 - weights) * (h < observed).mean(axis=0)
        # E|X-y| - 1/2 E|X-X'|, expanded for the empirical/Poisson mixture.
        sorted_h = np.sort(h, axis=0)
        rank = 2 * np.arange(len(h))[:, None] - len(h) + 1
        ee = 2 * (sorted_h * rank).sum(axis=0) / len(h)**2
        at_h = prior.cdf(h)
        ep = (h * (2 * at_h - 1) + mu[sl] * (1 - 2 * prior.cdf(h - 1))).mean(axis=0)
        ey = np.abs(h - observed).mean(axis=0)
        py = observed * (2 * prior.cdf(observed) - 1) + mu[sl] * (1 - 2 * prior.cdf(observed - 1))
        pp = 2 * mu[sl] * (ive(0, 2 * mu[sl]) + ive(1, 2 * mu[sl]))
        loss[sl] = weights * py + (1 - weights) * ey - .5 * (
            weights**2 * pp + 2 * weights * (1 - weights) * ep + (1 - weights)**2 * ee)
    return summarise_probabilities(y, empirical_mean, resolution, scope, "historical time bin",
                                   "Smoothed empirical", loss, np.log(np.maximum(probability, 1e-300)),
                                   zero, cdf, 1 - prev, prev)


def experiments(archive, thresholds, seeds):
    reference = archive.reference
    start = pd.Timestamp(CONFIG["evaluation_start"])
    end = pd.Timestamp(CONFIG["development_start"]) - DAY
    dates = pd.date_range(start, end)
    # Offset and onset vary by seed. Cases share historical background days.
    design = list(product((5, 15, 30, 60, 180, 360), (.1, .25, .5, .75, 1.)))
    design += [(30, 1., "backlog"), (60, .75, "rejection"), (60, .75, "cancellation"),
               (60, .75, "surge"), (60, .75, "amount"), (60, 1., "collective"),
               (180, .75, "merchant"), (60, 1., "network"), (360, 1., "gradual"),
               (360, 1., "intermittent"), (180, .75, "compound"), (60, 1., "cold"),
               (60, 1., "schedule"), (15, 1., "peak_network"), (15, 1., "peak_pos"),
               (30, 1., "peak_backlog"), (180, 1., "peak_collective")]
    data = []
    cache = {}
    for seed in seeds:
        rng = np.random.default_rng(seed)
        for case in design:
            minutes, magnitude, *rest = case
            family = rest[0] if rest else "drop"
            day = dates[int(rng.integers(len(dates)))]
            channel = None if family in ("merchant", "network", "peak_network") else (
                "ecommerce" if family in ("collective", "peak_collective") else "pos")
            merchants = ()
            key = ("channel", channel) if channel else ("network", "all")
            if family == "merchant":
                merchant = reference.merchants[int(rng.integers(len(reference.merchants)))]
                key, merchants = ("merchant", merchant), (merchant,)
            if family in ("collective", "peak_collective"):
                merchants = archive.preset(day, "collective").merchants
            onset_slot = int(rng.integers(45, 180))
            if family.startswith("peak_"):
                profile = reference.mean[day.weekday(), :, reference.index[key]]
                totals = np.convolve(profile, np.ones(minutes // MINUTES), mode="valid")
                onset_slot = 45 + int(totals[45:200].argmax())
            onset = day + onset_slot * BIN
            special = ("rejection", "cancellation", "surge", "amount", "cold", "schedule", "compound")
            s = Scenario(family if family in special else "drop",
                         channel, merchants, onset, onset + pd.Timedelta(minutes=minutes), magnitude, seed,
                         family in ("backlog", "peak_backlog"),
                         family if family in ("gradual", "intermittent") else "constant")
            tape = archive.tape(day, day, scenario=s)
            if day not in cache:
                base = archive.tape(day, day)
                base_closure = DailyClosure(archive, base)
                cache[day] = (base, trace(base), base_closure.close(SLOTS - 1), base_closure.model)
            base, (control, control_scans), base_daily, daily_model = cache[day]
            begin, finish = onset_slot, onset_slot + minutes // MINUTES
            # Advance only far enough to measure live event and bounded recovery.
            closure = DailyClosure(archive, tape)
            closure.model = daily_model
            batch = closure.close(SLOTS - 1) if family != "cold" else {"flagged": []}
            values, scans = trace(tape)
            j = reference.index[key]
            expected = tape.mean[begin:finish, j].sum()
            if channel and merchants:
                expected = sum(tape.mean[begin:finish, reference.index["merchant-channel", f"{merchant}/{channel}"]].sum()
                               for merchant in merchants)
            symptom = {"rejection": 2, "cancellation": 3, "surge": 1}.get(family, 0)
            observed_cut = min(SLOTS, finish + 12)
            for method in (*METHODS, "daily"):
                cutoff = thresholds.get(method)
                if (family == "amount" and method != "daily") or (family == "cold" and method == "daily"):
                    warning = ordinary = np.zeros(SLOTS, dtype=bool)
                elif method == "daily":
                    warn = {item["merchant"] for item in batch["flagged"]}
                    old = {item["merchant"] for item in base_daily["flagged"]}
                    affected = set(merchants) if merchants else set(base.events.loc[
                        base.events.transaction_date.ge(onset) & base.events.transaction_date.lt(s.end) &
                        (base.events.channel.eq(channel) if channel else True), "merchant_id"])
                    warn, old = warn.intersection(affected), old.intersection(affected)
                    warning, ordinary = np.zeros(SLOTS, dtype=bool), np.zeros(SLOTS, dtype=bool)
                    warning[-1] = bool(warn - old)
                elif method == "collective":
                    def mask(source):
                        return np.array([any(tuple(x["scope"]) == key and x["score"] > cutoff and
                                             (not merchants or len(set(x["merchants"]).intersection(merchants)) >= 2) and
                                             ((symptom == 0 and x["symptom"] == "Shared activity shortfall") or
                                              (symptom == 2 and x["symptom"] == "Shared rejection increase"))
                                             for x in group) for group in source])
                    warning, ordinary = mask(scans), mask(control_scans)
                else:
                    warning = values[method][:, j, symptom] > cutoff
                    ordinary = control[method][:, j, symptom] > cutoff
                incremental = np.flatnonzero(warning[begin:observed_cut] & ~ordinary[begin:observed_cut])
                negative_control = family in ("schedule", "cold")
                applicable = not negative_control and (family != "amount" or method == "daily")
                saw_warning = bool(tape.changed and len(incremental))
                # Score clearance is a research proxy. Lifecycle recovery is
                # measured separately using the actual replay transitions.
                clearance = None
                if saw_warning and method != "daily":
                    quiet = np.flatnonzero(~warning[finish:observed_cut])
                    if len(quiet):
                        clearance = int((quiet[0] + 1) * MINUTES)
                data.append({"seed": seed, "date": str(day.date()), "scope": key[0], "scope_name": key[1],
                             "onset": onset.isoformat(), "end": s.end.isoformat(), "family": family,
                             "minutes": minutes, "magnitude": magnitude, "changed_events": tape.changed,
                             "expected_events": expected, "during_event": bool(tape.changed and len(incremental) and
                                                                               begin + incremental[0] < finish),
                             "method": method, "applicable": applicable, "hit": applicable and saw_warning,
                             "nuisance": negative_control and saw_warning, "warning_bins": int(warning.sum()),
                             "delay": (incremental[0] + 1) * MINUTES if applicable and saw_warning else None,
                             "score_clearance_minutes": clearance,
                             "incremental_at_close": bool(warning[-1] and not ordinary[-1]) if method == "daily" else None,
                             "daily_delta": len(tape.events) - len(base.events)})
    pd.DataFrame(data).to_csv(OUT / "synthetic_cases.csv", index=False)


def collective_sensitivity(archive):
    def scans(tape, resolution):
        model = Signals(tape, collective_bins=resolution)
        n_cells = len(tape.ref.cells)
        pairs = np.zeros((tape.size, n_cells, 2))
        cells = np.array([tape.ref.cell_index[m, c] for m, c in zip(tape.events.merchant_id, tape.events.channel)])
        np.add.at(pairs[:, :, 0], (tape.bins, cells), 1)
        declined = tape.events.transaction_status.eq("Declined").to_numpy(dtype=bool)
        np.add.at(pairs[:, :, 1], (tape.bins, cells), declined)
        return [model._collective(i % SLOTS, pair, tape.ref.cell_mean[
            (tape.start.dayofweek + i // SLOTS) % 7, i % SLOTS], True) for i, pair in enumerate(pairs)]

    def day_maxima(records):
        return np.array([max((x["score"] for group in records[i:i+SLOTS] for x in group), default=0.)
                         for i in range(0, len(records), SLOTS)])

    cases = pd.read_csv(OUT / "synthetic_cases.csv").query(
        "method == 'collective' and family in ('collective', 'peak_collective')")
    cal = archive.tape(CONFIG["calibration_start"], pd.Timestamp(CONFIG["evaluation_start"]) - DAY)
    holdout = archive.tape(CONFIG["evaluation_start"], pd.Timestamp(CONFIG["development_start"]) - DAY)
    rows = []
    for resolution in (1, 3, 12):
        cutoff = float(np.quantile(day_maxima(scans(cal, resolution)), .75, method="higher"))
        burden = int((day_maxima(scans(holdout, resolution)) > cutoff).sum())
        hits = []
        for row in cases.itertuples():
            start, onset, end = map(pd.Timestamp, (row.date, row.onset, row.end))
            merchants = archive.preset(start, "collective").merchants
            scenario = Scenario("drop", "ecommerce", merchants, onset, end, row.magnitude, row.seed)
            tape = archive.tape(start, start, scenario=scenario)
            base = archive.tape(start, start)
            def flag(records):
                return np.array([any(x["score"] > cutoff and x["scope"] == ("channel", "ecommerce") and
                                     x["symptom"] == "Shared activity shortfall" and
                                     len(set(x["merchants"]).intersection(merchants)) >= 2
                                     for x in group) for group in records])
            paired = flag(scans(tape, resolution)) & ~flag(scans(base, resolution))
            position = int((onset - start) // BIN)
            found = np.flatnonzero(paired[position:min(SLOTS, int((end - start) // BIN) + 12)])
            if tape.changed and len(found):
                hits.append(int((found[0] + 1) * MINUTES))
        rows.append({"window_minutes": resolution * MINUTES, "threshold": cutoff,
                     "ordinary_warning_days": burden, "held_out_cases": len(cases), "paired_hits": len(hits),
                     "median_delay_minutes": float(np.median(hits)) if hits else None})
    return rows


def backlog_example(archive, thresholds):
    # Chosen after inspecting replay outputs, so keep it separate from held-out estimates.
    date = "2026-10-15"
    base = archive.tape(date, date)
    tape = archive.tape(date, date, "backlog")
    baseline = Replay(archive, base, thresholds)
    overlay = Replay(archive, tape, thresholds)
    for replay in (baseline, overlay):
        for _ in range(replay.tape.size):
            replay.advance()
    current = overlay.snapshot()
    return {"date": date, "selection": "post-hoc demonstration", "truth": current["truth"],
            "ordinary_daily_events": len(base.events), "overlay_daily_events": len(tape.events),
            "ordinary_daily_closure": baseline.daily, "overlay_daily_closure": overlay.daily,
            "ordinary_warnings": baseline.snapshot()["warnings"], "overlay_warnings": current["warnings"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["calibrate", "ordinary", "diagnostics", "development", "synthetic",
                                          "performance", "profile_sensitivity", "collective_sensitivity", "backlog_example"])
    parser.add_argument("--seed", action="append", type=int)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    archive = Archive()
    start, end = pd.Timestamp(CONFIG["evaluation_start"]), pd.Timestamp(CONFIG["development_start"]) - DAY
    if args.stage == "calibrate":
        print(calibrate(archive)["thresholds"])
    elif args.stage == "diagnostics":
        diagnostics(archive, start, end)
    elif args.stage == "profile_sensitivity":
        ref = archive.reference
        merchant = ref.cell_profiles["merchant"].reshape(-1, 7, SLOTS)
        ref.cell_mean = (ref.daily_cell[..., None] * merchant).transpose(1, 2, 0)
        ref.mean = ref.cell_mean @ ref.weights
        challenger = calibrate(archive, publish=False)
        champion = workload(archive, archive.tape(start, end), challenger["thresholds"])
        (OUT / "profile_sensitivity.json").write_text(json.dumps({
            "profile": "merchant profile with uniform shrinkage and hierarchical daily allocation",
            "serving_configuration_changed": False, "calibration": challenger, "ordinary_lifecycle": champion,
        }, indent=2) + "\n")
    else:
        thresholds = locked_thresholds(archive)
        if args.stage == "ordinary":
            tape = archive.tape(start, end)
            daily = maxima(tape, *trace(tape))
            alternatives = json.loads(THRESHOLD_FILE.read_text())["budget_sensitivity"]
            sensitivity = {name: workload(archive, tape, alternative) for name, alternative in alternatives.items()}
            result = {"method_warning_days": {k: int((v > thresholds[k]).sum()) for k, v in daily.items()},
                      "selected_lifecycle": sensitivity[str(CONFIG["calibration_budget_per_day"])],
                      "budget_sensitivity": sensitivity}
            (OUT / "ordinary_workload.json").write_text(json.dumps(result, indent=2) + "\n")
        elif args.stage == "collective_sensitivity":
            (OUT / "collective_sensitivity.json").write_text(json.dumps(collective_sensitivity(archive), indent=2) + "\n")
        elif args.stage == "backlog_example":
            (OUT / "backlog_example.json").write_text(json.dumps(backlog_example(archive, thresholds), indent=2) + "\n")
        elif args.stage == "synthetic":
            experiments(archive, thresholds, args.seed or [71931])
        elif args.stage == "development":
            begin = CONFIG["development_start"]
            tape = archive.tape(begin, CONFIG["archive_end"])
            daily = archive.labels.loc[archive.labels.date.ge(begin), ["date", "merchant_id", "is_anomaly"]]
            labels = {(r.date, r.merchant_id): bool(r.is_anomaly) for r in daily.itertuples(index=False)}
            values, _ = trace(tape, scan=False)
            rows = []
            for method, value in values.items():
                matched = set()
                for tick, j in np.argwhere((value > thresholds[method]).any(axis=2)):
                    kind, merchant = tape.ref.keys[j]
                    if kind == "merchant":
                        date = (tape.start + tick * BIN).date().isoformat()
                        matched.add((date, merchant))
                rows.append({"method": method, "days": len(labels), "positive_days": sum(labels.values()),
                             "merchant_days_with_warning": len(matched),
                             "overlap_positive_days": sum(labels.get(k, False) for k in matched)})
            (OUT / "development_overlap.json").write_text(json.dumps(rows, indent=2) + "\n")
        else:
            tape = archive.tape(start, start, "backlog")
            replay = Replay(archive, tape, thresholds)
            t = perf_counter()
            seconds = []
            for _ in range(tape.size):
                begin = perf_counter()
                replay.advance()
                seconds.append(perf_counter() - begin)
            elapsed = perf_counter() - t
            scan_ms = [seconds[i] * 1000 for i in range(2, len(seconds) - 1, 3)]
            plain_ms = [value * 1000 for i, value in enumerate(seconds[:-1]) if (i + 1) % 3]
            try:
                import psutil
                rss = psutil.Process().memory_info().rss
            except ImportError:
                rss = None
            output = {"events": len(tape.events), "bins": tape.size, "total_seconds": elapsed,
                      "events_per_second": len(tape.events) / elapsed,
                      "max_tick_ms": max(seconds[:-1]) * 1000,
                      "p95_tick_ms": float(np.quantile(seconds[:-1], .95) * 1000),
                      "median_scoring_tick_ms": float(np.median(plain_ms)),
                      "median_tick_with_collective_ms": float(np.median(scan_ms)),
                      "closing_tick_ms": seconds[-1] * 1000,
                      "process_rss_bytes": rss,
                      "snapshot_bytes": len(json.dumps(replay.snapshot()).encode())}
            (OUT / "performance.json").write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
