"""Export one versioned, read-only run snapshot for the web platform.

The snapshot is the platform's single source of truth (SRS FR-01, FR-12, FR-52): the official V2
flags and scores (same code path as predict.py), merchant-day evidence with expected intervals,
collective channel advisories, a 7-day advisory forecast with backtest, train-period validation
and the cleaning audit. Card numbers never enter it (NFR-01).

Run:  python -m engine.export      ->  runs/<run_id>/snapshot.json  and  runs/latest.json
"""
import hashlib
import json

import numpy as np
import pandas as pd
from scipy import stats

from engine import collective, data, detect, predict
from engine.evaluate import dz_holidays, labelled
from engine.metrics import evaluate

POLICY = {"version": "V2", "high": predict.HIGH, "low": predict.LOW,
          "window_days": detect.WINDOW_DAYS, "min_history": detect.MIN_HISTORY}
RUNS = data.ROOT / "runs"
HORIZON = 7
INTERVAL = (0.1, 0.9)  # 80 % predictive interval


def _sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _clean(v):
    """JSON-safe scalars: NaN/inf -> None, numpy -> python, timestamps -> ISO date."""
    if isinstance(v, (pd.Timestamp,)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, (np.floating, float)):
        return None if not np.isfinite(v) else round(float(v), 6)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def _nb_interval(mu, alpha):
    r = 1.0 / alpha
    p = r / (r + np.maximum(mu, 1e-9))
    return stats.nbinom.ppf(INTERVAL[0], r, p), stats.nbinom.ppf(INTERVAL[1], r, p)


def _day_type_median(series: pd.Series, origin: pd.Timestamp, target: pd.Timestamp) -> float:
    """Median of the same day type (weekday vs Fri-Sat) over the 28 days before `origin`."""
    hist = series[(series.index < origin) & (series.index >= origin - pd.Timedelta(days=detect.WINDOW_DAYS))]
    same = hist[(hist.index.dayofweek.isin([4, 5])) == (target.dayofweek in (4, 5))]
    return float(same.median()) if len(same) else float("nan")


def forecast(g: pd.DataFrame, alpha: float) -> dict:
    """Advisory 7-day count forecast per merchant and network, plus a rolling-origin backtest.

    Method: same-day-type median of the last 28 days (the engine's own reference), negative-binomial
    80 % interval. Benchmark: seasonal naive (same weekday one week earlier). Network interval is a
    normal approximation of the sum (labelled as such), not a calibrated joint interval.
    """
    last = g["date"].max()
    days = pd.date_range(last + pd.Timedelta(days=1), periods=HORIZON)
    out, net_mu, net_var = {}, np.zeros(HORIZON), np.zeros(HORIZON)
    for mid, m in g.groupby("merchant_id"):
        s = m.set_index("date")["n"]
        mu = np.array([_day_type_median(s, last + pd.Timedelta(days=1), d) for d in days])
        mu = np.nan_to_num(mu, nan=0.0)
        lo, hi = _nb_interval(mu, alpha)
        out[mid] = [{"date": d.strftime("%Y-%m-%d"), "expected": round(float(x), 2), "lo": int(a), "hi": int(b)}
                    for d, x, a, b in zip(days, mu, lo, hi)]
        net_mu += mu
        net_var += mu + alpha * mu ** 2
    z = stats.norm.ppf(INTERVAL[1])
    network = [{"date": d.strftime("%Y-%m-%d"), "expected": round(float(x), 1),
                "lo": max(0, int(x - z * np.sqrt(v))), "hi": int(x + z * np.sqrt(v))}
               for d, x, v in zip(days, net_mu, net_var)]

    # Backtest on the network total, rolling origins over the last 21 days (prior data only).
    net = g.groupby("date")["n"].sum()
    errs, naive, covered, total = [], [], 0, 0
    for origin in net.index[-21:-HORIZON + 1]:
        for h in range(HORIZON):
            t = origin + pd.Timedelta(days=h)
            if t not in net.index:
                continue
            per_m = [(_day_type_median(m.set_index("date")["n"], origin, t)) for _, m in g.groupby("merchant_id")]
            mu = float(np.nansum(per_m))
            var = float(np.nansum([x + alpha * x ** 2 for x in per_m if np.isfinite(x)]))
            errs.append(abs(net[t] - mu))
            prev = t - pd.Timedelta(days=7)
            if prev in net.index:
                naive.append(abs(net[t] - net[prev]))
            covered += int(abs(net[t] - mu) <= z * np.sqrt(var))
            total += 1
    backtest = {"origins": 21 - HORIZON + 1, "horizon_days": HORIZON,
                "mae_model": round(float(np.mean(errs)), 2), "mae_seasonal_naive": round(float(np.mean(naive)), 2),
                "interval_coverage": round(covered / total, 3) if total else None,
                "nominal_coverage": INTERVAL[1] - INTERVAL[0]}
    return {"as_of": last.strftime("%Y-%m-%d"), "method": "same-day-type median of 28 prior days, NB interval",
            "network": network, "merchants": out, "backtest": backtest}


def validation() -> tuple[dict, list, list]:
    """Train-period metrics, score calibration and threshold outcomes (train data only, no test leakage)."""
    tx, _ = data.load_transactions((data.TRAIN_TX,))
    years = sorted(tx["date"].dt.year.unique())
    enh = detect.enhanced(data.merchant_day_grid(tx), dz_holidays(years),
                          merchant_channel=data.merchant_channel_day(tx))
    df = labelled(enh, data.load_labels())
    r = evaluate(df.assign(pred=detect.flag_episodes(df, predict.HIGH, predict.LOW)))
    return {k: _clean(v) for k, v in r.items()}, collective.calibration(df), collective.value_curve(df)


def build() -> dict:
    tx, report = data.load_transactions()
    g = predict.score_all()                       # official V2 path, identical to the submission
    alpha = detect.estimate_dispersion(g)
    mcd = data.merchant_channel_day(tx)
    g = g.sort_values(["merchant_id", "date"]).reset_index(drop=True)
    lo, hi = _nb_interval(g["expected_n_adj"].to_numpy(), alpha)
    g["expected_lo"], g["expected_hi"] = lo, hi

    hours = (tx.assign(h=tx["ts"].dt.hour).groupby(["merchant_id", "date", "h"]).size()
             .unstack(fill_value=0).reindex(columns=range(24), fill_value=0))
    chan = {(r.merchant_id, r.date): {} for r in mcd.itertuples()}
    for r in mcd.itertuples():
        chan[(r.merchant_id, r.date)][r.payment_channel] = [int(r.n), int(r.n_dec)]

    cols = ["merchant_id", "date", "category", "n", "n_acc", "n_dec", "n_can", "n_ref", "value", "ticket",
            "expected_n", "expected_n_adj", "expected_lo", "expected_hi", "holiday", "holiday_factor",
            "history_days", "warming_up", "expected_dec_rate", "expected_can_rate", "expected_ticket",
            *detect.SIGNALS, "incident_channel", "anomaly_score", "main_signal", "is_anomaly"]
    cfs = collective.counterfactuals(g, mcd, alpha, predict.HIGH)
    cold = collective.cold_start(g, alpha, predict.HIGH)
    days = []
    for r in g[cols].itertuples(index=False):
        row = {c: _clean(v) for c, v in zip(cols, r)}
        key = (r.merchant_id, r.date)
        row["hours"] = [int(x) for x in hours.loc[key]] if key in hours.index else [0] * 24
        row["channels"] = chan.get(key, {})
        if key in cfs:
            row["counterfactual"] = cfs[key]
        if key in cold:
            row["cold_start"] = cold[key]
        days.append(row)

    adv = detect.channel_incidents(mcd)
    advisories = []
    for a in adv.itertuples():
        cohort = mcd[(mcd["payment_channel"] == a.payment_channel) & (mcd["date"] == a.date)]
        gd = g[g["date"] == a.date].set_index("merchant_id")
        members = [{"merchant_id": c.merchant_id, "n": int(c.n), "n_dec": int(c.n_dec),
                    "affected": bool(gd.loc[c.merchant_id, "s_incident"] > 0 and gd.loc[c.merchant_id, "incident_channel"] == a.payment_channel),
                    "flagged": bool(gd.loc[c.merchant_id, "is_anomaly"])}
                   for c in cohort.itertuples() if c.merchant_id in gd.index]
        advisories.append({"id": f"ADV-{a.date:%Y%m%d}-{a.payment_channel.split(' ')[0].upper()}",
                           "date": a.date.strftime("%Y-%m-%d"), "channel": a.payment_channel, "symptom": "excess declines",
                           "n": int(a.n), "n_dec": int(a.n_dec), "observed_rate": _clean(a.observed_rate),
                           "expected_rate": _clean(a.expected_rate), "score": _clean(a.score),
                           "threshold": detect.INCIDENT_MIN_SCORE, "members": members})

    t = tx.sort_values(["ts", "merchant_id"]).reset_index(drop=True)
    merchants = sorted(t["merchant_id"].unique())
    m_idx = {m: i for i, m in enumerate(merchants)}
    transactions = {  # columnar and sanitized: no card field (NFR-01, FR-23)
        "merchants": merchants,
        "ts": t["ts"].dt.strftime("%Y-%m-%d %H:%M:%S").tolist(),
        "merchant": [m_idx[m] for m in t["merchant_id"]],
        "category": t["merchant_category"].tolist(),
        "channel": t["payment_channel"].tolist(),
        "status": t["transaction_status"].tolist(),
        "amount": [_clean(x) for x in t["amount"]],
    }

    metrics, calib, value = validation()
    inputs = {p.name: _sha(p) for p in (data.TRAIN_TX, data.TEST_TX, data.LABELS, data.TEMPLATE)}
    code = {p.name: _sha(p) for p in sorted((data.ROOT / "engine").glob("*.py"))}
    run_id = hashlib.sha256(json.dumps([inputs, code, POLICY], sort_keys=True).encode()).hexdigest()[:12]
    snap = {
        "run": {"run_id": run_id, "policy": POLICY, "dispersion": round(alpha, 5), "inputs": inputs, "code": code,
                "as_of": g["date"].max().strftime("%Y-%m-%d"), "first_date": g["date"].min().strftime("%Y-%m-%d"),
                "train_end": data.TRAIN_END.strftime("%Y-%m-%d"), "batch_status": "complete",
                "holidays": sorted(d.strftime("%Y-%m-%d") for d in dz_holidays(sorted(tx["date"].dt.year.unique()))),
                "cleaning": {k: int(v) for k, v in report.items()}, "validation": metrics,
                "calibration": calib, "value_curve": value,
                "flagged_days": int(g["is_anomaly"].sum())},
        "merchant_days": days,
        "advisories": advisories,
        "collective": collective.subset_scan(g, mcd, alpha),
        "forecast": forecast(g, alpha),
        "transactions": transactions,
    }
    assert "masked_pan" not in json.dumps(list(snap["transactions"].keys())), "card field leaked"
    return snap


def main():
    snap = build()
    rid = snap["run"]["run_id"]
    out = RUNS / rid
    out.mkdir(parents=True, exist_ok=True)
    (out / "snapshot.json").write_text(json.dumps(snap, sort_keys=True, separators=(",", ":")))
    (RUNS / "latest.json").write_text(json.dumps({"run_id": rid, "path": f"{rid}/snapshot.json"}))
    print(f"run {rid}: {len(snap['merchant_days'])} merchant-days, {snap['run']['flagged_days']} flagged, "
          f"{len(snap['advisories'])} advisories, {len(snap['transactions']['ts'])} transactions")


if __name__ == "__main__":
    main()
