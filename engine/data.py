"""Load, clean and aggregate transactions into a complete merchant-day grid."""
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TRAIN_TX = ROOT / "X_train_transactions.csv"
TEST_TX = ROOT / "X_test_transactions.csv"
LABELS = ROOT / "y_train_labels.csv"
TEMPLATE = ROOT / "y_pred_template.csv"

TRAIN_END = pd.Timestamp("2026-10-24")


def load_transactions(paths=(TRAIN_TX, TEST_TX)) -> tuple[pd.DataFrame, dict]:
    """Return cleaned transactions and a report of what cleaning changed."""
    raw = pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
    report = {"rows_raw": len(raw)}

    # Identical on all 7 fields (incl. timestamp to the second) = double-posted record.
    df = raw.drop_duplicates().copy()
    report["exact_duplicates_removed"] = len(raw) - len(df)

    df["ts"] = pd.to_datetime(df["transaction_date"], errors="coerce")
    report["unparseable_dates_removed"] = int(df["ts"].isna().sum())
    df = df.dropna(subset=["ts"])
    df["date"] = df["ts"].dt.normalize()

    # Negative amounts are almost all 'Accepted' (refunds are positive) -> sign error.
    report["negative_amounts_sign_fixed"] = int((df["amount"] < 0).sum())
    df["amount"] = df["amount"].abs()
    # Missing amount: the attempt still happened -> keep for counts, skip in value sums.
    report["missing_amount_kept_for_counts"] = int(df["amount"].isna().sum())

    # Each merchant has exactly one category -> fill gaps from the merchant itself.
    cat = df.dropna(subset=["merchant_category"]).groupby("merchant_id")["merchant_category"].agg(
        lambda s: s.mode().iat[0])
    report["missing_category_filled"] = int(df["merchant_category"].isna().sum())
    df["merchant_category"] = df["merchant_category"].fillna(df["merchant_id"].map(cat))

    report["missing_channel_set_unknown"] = int(df["payment_channel"].isna().sum())
    df["payment_channel"] = df["payment_channel"].fillna("Unknown")
    report["rows_clean"] = len(df)
    return df, report


def merchant_day_grid(df: pd.DataFrame) -> pd.DataFrame:
    """One row per (merchant, day) from the merchant's first active day to the end of data.

    Days with no transactions are kept as n=0: they are the interruption signal.
    """
    s = df["transaction_status"]
    acc_amount = df["amount"].where(s.eq("Accepted"))
    log_amt = np.log(acc_amount.where(acc_amount > 0))
    agg = (df.assign(acc=s.eq("Accepted"), dec=s.eq("Declined"), can=s.eq("Cancelled"),
                     ref=s.eq("Refunded"), acc_amount=acc_amount,
                     la=log_amt, la2=log_amt ** 2, has_la=log_amt.notna())
           .groupby(["merchant_id", "date"])
           .agg(n=("amount", "size"), n_acc=("acc", "sum"), n_dec=("dec", "sum"),
                n_can=("can", "sum"), n_ref=("ref", "sum"),
                value=("acc_amount", "sum"), ticket=("acc_amount", "median"),
                # per-transaction log-amount moments, for a sample-size-aware amount test
                n_la=("has_la", "sum"), la_sum=("la", "sum"), la2_sum=("la2", "sum")))

    end = df["date"].max()
    first = df.groupby("merchant_id")["date"].min()
    idx = pd.MultiIndex.from_tuples(
        [(m, d) for m, start in first.items() for d in pd.date_range(start, end)],
        names=["merchant_id", "date"])
    grid = agg.reindex(idx)
    counts = ["n", "n_acc", "n_dec", "n_can", "n_ref", "value", "n_la", "la_sum", "la2_sum"]
    grid[counts] = grid[counts].fillna(0)
    grid = grid.reset_index()
    grid["category"] = grid["merchant_id"].map(df.groupby("merchant_id")["merchant_category"].first())
    grid["weekend"] = grid["date"].dt.dayofweek.isin([4, 5])  # Algeria: Friday-Saturday
    return grid


def merchant_channel_day(df: pd.DataFrame) -> pd.DataFrame:
    """Attempts and declines per merchant, day and payment channel."""
    return (df.assign(dec=df["transaction_status"].eq("Declined"))
            .groupby(["merchant_id", "date", "payment_channel"])
            .agg(n=("dec", "size"), n_dec=("dec", "sum")).reset_index())


def load_labels() -> pd.DataFrame:
    y = pd.read_csv(LABELS, parse_dates=["date"])
    return y
