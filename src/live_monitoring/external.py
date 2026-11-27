"""Optional AIOps 2018 transfer study using an explicitly separate continuous law."""

import argparse
import json
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import numpy as np
import pandas as pd

from .evaluation import OUT


def cumsum(values, delta=1.):
    scores = np.empty(len(values))
    high = low = 0.
    for i, val in enumerate(values):
        if not np.isfinite(val):
            high = low = 0.
        else:
            high = max(0., high + delta * val - delta**2 / 2)
            low = max(0., low - delta * val - delta**2 / 2)
        scores[i] = max(high, low)
    return scores


def episodes(labels):
    positive = np.flatnonzero(labels)
    if not len(positive):
        return []
    boundaries = np.flatnonzero(np.diff(positive) > 1) + 1
    return np.split(positive, boundaries)


def read_finals(directory):
    with ZipFile(directory / "aiops_finals_train.zip") as archive, archive.open("phase2_train.csv") as stream:
        train = pd.read_csv(stream)
    with ZipFile(directory / "aiops_finals_test.zip") as archive, TemporaryDirectory(dir=OUT) as folder:
        file = Path(folder) / "truth.hdf"
        with archive.open("phase2_ground_truth.hdf") as stream, file.open("wb") as target:
            copyfileobj(stream, target)
        test = pd.read_hdf(file, key="data")
    for frame in (train, test):
        frame["KPI ID"] = frame["KPI ID"].astype(str)
    return tuple(frame.sort_values(["KPI ID", "timestamp"]) for frame in (train, test))


def study(train, test):
    rows = []
    for kpi, evaluation in test.groupby("KPI ID", sort=True):
        history = train.loc[train["KPI ID"].eq(kpi)].reset_index(drop=True)
        if len(history) < 200 or history.timestamp.max() >= evaluation.timestamp.min():
            continue
        width = float(history.timestamp.diff().dropna().median())
        if not np.isfinite(width) or width <= 0:
            continue
        boundary = int(len(history) * .7)
        support, calibration = history.iloc[:boundary], history.iloc[boundary:]
        normal = support.loc[support.label.eq(0)]
        if len(normal) < 100:
            continue
        # Robust time-of-day reference for each continuous KPI. Independently
        # scaled AR(1) innovations are evaluated as a sensitivity.
        def slot(frame):
            return (frame.timestamp // 3600) % 24
        hourly = normal.groupby(slot(normal)).value.median()
        center = normal.value.median()
        def residual(frame):
            return (frame.value - slot(frame).map(hourly).fillna(center)).to_numpy()
        a = residual(normal)
        scale = np.median(np.abs(a - np.median(a))) * 1.4826
        if scale <= 1e-10:
            continue
        consecutive = normal.timestamp.diff().to_numpy()[1:] == width
        left, right = a[:-1][consecutive], a[1:][consecutive]
        rho = float(np.clip(np.dot(left, right) / max(1e-20, np.dot(left, left)), -.95, .95))

        def transformed(frame, autoregressive):
            residuals = residual(frame) / scale
            consecutive = frame.timestamp.diff().to_numpy()[1:] == width
            serial = rho if autoregressive else 0.
            result = np.r_[np.nan, (residuals[1:] - serial * residuals[:-1]) / np.sqrt(1 - serial**2)]
            result[1:][~consecutive] = np.nan
            return result

        def blocks(frame):
            return frame.timestamp.to_numpy() // 86400

        for mode in ("raw", "ar1"):
            # Include only fully ordinary labelled calibration days in the
            # maximum, and reset on the day boundary in both tapes.
            def day_scores(frame, values):
                day_id = blocks(frame)
                return [cumsum(values[day_id == day]) for day in np.unique(day_id)]
            c = day_scores(calibration, transformed(calibration, mode == "ar1"))
            ordinary = calibration.groupby(blocks(calibration)).label.max().eq(0).to_numpy()
            if ordinary.sum() < 4:
                continue
            threshold = float(np.quantile([v.max() for v, keep in zip(c, ordinary) if keep], .9, method="higher"))
            e = np.concatenate(day_scores(evaluation, transformed(evaluation, mode == "ar1")))
            label = evaluation.label.to_numpy().astype(bool)
            warnings = e > threshold
            # Never join positive labels over telemetry gaps.
            time = evaluation.timestamp.to_numpy()
            cases = [part for run in episodes(label) for part in
                     np.split(run, np.flatnonzero(np.diff(time[run]) != width) + 1)]
            matched = []
            for case in cases:
                hits = np.flatnonzero(warnings[case])
                if len(hits):
                    matched.append((time[case[hits[0]]] - time[case[0]]) / 60)
            n = (~label).sum()
            rows.append({"kpi": kpi, "mode": mode, "fit_rho": rho, "cadence_seconds": width,
                         "ordinary_calibration_days": int(ordinary.sum()), "threshold": threshold,
                         "events": len(cases), "hits": len(matched),
                         "median_delay_minutes": float(np.median(matched)) if matched else None,
                         "ordinary_points": int(n), "ordinary_warning_points": int((warnings & ~label).sum())})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path, help="Existing AIOps 2018 finals train and labelled test archives")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = study(*read_finals(args.directory))
    (OUT / "external_aiops.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(f"Evaluated {len(rows)} KPI/model pairs")


if __name__ == "__main__":
    main()
