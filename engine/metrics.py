"""Day-level and episode-level evaluation against y_train_labels."""
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score


def episodes(df: pd.DataFrame, col: str) -> pd.DataFrame:
    """Consecutive flagged days per merchant -> one row per episode (merchant, start, end)."""
    d = df.loc[df[col].astype(bool), ["merchant_id", "date"]].sort_values(["merchant_id", "date"])
    if d.empty:
        return pd.DataFrame(columns=["merchant_id", "start", "end"])
    new = (d["merchant_id"] != d["merchant_id"].shift()) | (d["date"].diff().dt.days != 1)
    d["ep"] = new.cumsum()
    return d.groupby("ep").agg(merchant_id=("merchant_id", "first"), start=("date", "min"),
                               end=("date", "max")).reset_index(drop=True)


def _overlaps(a: pd.DataFrame, b: pd.DataFrame) -> np.ndarray:
    """For each episode in a, does any episode in b (same merchant) overlap it?"""
    hit = np.zeros(len(a), dtype=bool)
    for i, e in enumerate(a.itertuples()):
        m = b[b["merchant_id"] == e.merchant_id]
        hit[i] = bool(((m["start"] <= e.end) & (m["end"] >= e.start)).any())
    return hit


def evaluate(df: pd.DataFrame, y_true: str = "is_anomaly", y_pred: str = "pred",
             score: str = "anomaly_score") -> dict:
    t, p = df[y_true].astype(bool), df[y_pred].astype(bool)
    tp, fp, fn, tn = (t & p).sum(), (~t & p).sum(), (t & ~p).sum(), (~t & ~p).sum()
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    true_ep, pred_ep = episodes(df, y_true), episodes(df, y_pred)
    ep_prec = _overlaps(pred_ep, true_ep).mean() if len(pred_ep) else 0.0
    ep_rec = _overlaps(true_ep, pred_ep).mean() if len(true_ep) else 0.0
    return {
        "precision": prec, "recall": rec,
        "f1": 2 * prec * rec / (prec + rec) if prec + rec else 0.0,
        "fpr": fp / (fp + tn) if fp + tn else 0.0,
        "pr_auc": average_precision_score(t, df[score]),
        "episode_precision": ep_prec, "episode_recall": ep_rec,
        "pred_episodes": len(pred_ep), "true_episodes": len(true_ep),
        "tp": int(tp), "fp": int(fp), "fn": int(fn),
    }


if __name__ == "__main__":  # self-check
    d = pd.DataFrame({"merchant_id": ["A"] * 6 + ["B"] * 3,
                      "date": list(pd.date_range("2026-01-01", periods=6)) * 1
                      + list(pd.date_range("2026-01-01", periods=3)),
                      "is_anomaly": [0, 1, 1, 0, 0, 0, 0, 0, 1],
                      "pred":       [0, 0, 1, 0, 1, 0, 0, 0, 1],
                      "anomaly_score": [0, .5, .9, 0, .8, 0, 0, 0, .7]})
    r = evaluate(d)
    assert len(episodes(d, "pred")) == 3 and r["episode_precision"] == 2 / 3, r
    assert r["episode_recall"] == 1.0 and r["tp"] == 2 and r["fp"] == 1, r
    print("metrics self-check ok")
