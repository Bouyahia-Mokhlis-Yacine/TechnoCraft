"""Score the test period and write y_pred_anomalies.csv from the template.

Run: python -m engine.predict
"""
import pandas as pd

from engine import data, detect
from engine.evaluate import dz_holidays

HIGH, LOW = 4.0, 2.0  # hysteresis thresholds chosen on y_train (plateau, see evaluate.py)
OUT = data.ROOT / "y_pred_anomalies.csv"


def score_all() -> pd.DataFrame:
    """Score every merchant-day; history from train is the reference for test (no labels used)."""
    tx, _ = data.load_transactions()
    years = sorted(tx["date"].dt.year.unique())
    g = detect.enhanced(data.merchant_day_grid(tx), dz_holidays(years),
                        merchant_channel=data.merchant_channel_day(tx))
    g["is_anomaly"] = detect.flag_episodes(g, HIGH, LOW).astype(int)
    return g


def main():
    g = score_all()
    tpl = pd.read_csv(data.TEMPLATE, parse_dates=["date"])[["merchant_id", "date"]]
    out = tpl.merge(g[["merchant_id", "date", "is_anomaly", "anomaly_score"]],
                    on=["merchant_id", "date"], how="left")
    missing = out["anomaly_score"].isna().sum()
    assert missing == 0, f"{missing} template rows have no score"
    assert len(out) == len(tpl)
    out["anomaly_score"] = out["anomaly_score"].round(4)
    out["date"] = out["date"].dt.strftime("%Y-%m-%d")
    out.to_csv(OUT, index=False)
    print(f"wrote {OUT.name}: {len(out)} rows, {int(out['is_anomaly'].sum())} flagged")


if __name__ == "__main__":
    main()
