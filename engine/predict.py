"""Compatibility entry point for the authoritative SATIM export.

Run: python -m engine.predict
"""
import pandas as pd

from engine import data, detect
from engine.evaluate import dz_holidays

HIGH, LOW = 4.0, 2.0  # hysteresis thresholds chosen on y_train (plateau, see evaluate.py)


def score_all() -> pd.DataFrame:
    """Archived prototype scorer, retained for historical comparisons."""
    tx, _ = data.load_transactions()
    years = sorted(tx["date"].dt.year.unique())
    g = detect.enhanced(data.merchant_day_grid(tx), dz_holidays(years),
                        merchant_channel=data.merchant_channel_day(tx))
    g["is_anomaly"] = detect.flag_episodes(g, HIGH, LOW).astype(int)
    return g


def main():
    from engine.export import main as export_main

    export_main()


if __name__ == "__main__":
    main()
