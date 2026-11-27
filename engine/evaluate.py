"""Compare detectors on the labelled training period.

Run: python -m engine.evaluate
"""
import holidays as pyholidays
import numpy as np
import pandas as pd

from engine import data, detect
from engine.metrics import evaluate


def dz_holidays(years=(2026,)) -> set:
    # Source: python-holidays (holidays.DZ), cited in the Decision Log.
    return {pd.Timestamp(d) for d in pyholidays.DZ(years=years)}


def best_threshold(df: pd.DataFrame, candidates) -> tuple[float, dict]:
    best = None
    for t in candidates:
        r = evaluate(df.assign(pred=df["anomaly_score"] >= t))
        if best is None or r["f1"] > best[1]["f1"]:
            best = (t, r)
    return best


def labelled(scored: pd.DataFrame, labels: pd.DataFrame) -> pd.DataFrame:
    return labels.merge(scored, on=["merchant_id", "date"], how="left").fillna(
        {"anomaly_score": 0})


def fmt(r: dict) -> str:
    return (f"P={r['precision']:.2f} R={r['recall']:.2f} F1={r['f1']:.2f} "
            f"FPR={r['fpr']:.4f} PR-AUC={r['pr_auc']:.2f} | episodes: "
            f"P={r['episode_precision']:.2f} R={r['episode_recall']:.2f} "
            f"({r['pred_episodes']} predicted / {r['true_episodes']} true) "
            f"tp={r['tp']} fp={r['fp']} fn={r['fn']}")


def main():
    tx, report = data.load_transactions((data.TRAIN_TX,))  # train only: no test leakage
    grid = data.merchant_day_grid(tx)
    labels = data.load_labels()
    print("cleaning:", report)

    iso = detect.isolation_forest(grid)
    enh = detect.enhanced(grid, dz_holidays(), merchant_channel=data.merchant_channel_day(tx))
    runs = {
        "baseline_zscore": (detect.baseline_zscore(grid), np.arange(1, 8, 0.25)),
        "isolation_forest": (iso, np.quantile(iso["anomaly_score"], np.arange(0.90, 0.999, 0.002))),
        "enhanced": (enh, np.arange(2, 12, 0.25)),
    }
    # Each detector gets its best single threshold on y_train (optimistic, same for all).
    for name, (scored, cands) in runs.items():
        df = labelled(scored, labels)
        t, r = best_threshold(df, cands)
        print(f"{name:17s} best thr={t:6.2f}  {fmt(r)}")

    from engine.predict import HIGH, LOW
    df = labelled(enh, labels)
    r = evaluate(df.assign(pred=detect.flag_episodes(df, HIGH, LOW)))
    print(f"{'enhanced+episodes':17s} hi={HIGH} lo={LOW}  {fmt(r)}")
    print("hysteresis sensitivity (high, low -> F1, episode precision):")
    for hi in (3.5, 4, 5):
        print("  ", *[f"({hi},{lo})->{(x := evaluate(df.assign(pred=detect.flag_episodes(df, hi, lo))))['f1']:.2f},{x['episode_precision']:.2f}"
                     for lo in (1.5, 2, 2.5)])


if __name__ == "__main__":
    main()
