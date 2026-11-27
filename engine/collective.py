"""Advisory analytics on top of the frozen V2 engine (owned by the platform team).

Nothing here changes an official flag or score: it reads the scored grid from predict.score_all()
and adds explanations and advisory signals for the web platform.

- counterfactuals: for each flagged merchant-day, the bound at which each signal that fired would
  have stayed below the alert threshold, using the same tests and parameters as detect.enhanced.
- subset_scan: collective anomalies (V3). Expectation-based Poisson scan statistic over subsets of
  merchants, maximised exactly with the linear-time subset scanning property (sort by c/b, test
  the top-j subsets), significance by parametric Monte Carlo under the engine's own null model.
- cold_start: hierarchical reference for merchants still "warming up" (own history shrunk toward
  the category's same-day-type median), scored with the engine's negative-binomial test.
- calibration / value_curve: from the labelled training period only.
"""
import numpy as np
import pandas as pd
from scipy import stats

from engine import detect

SCAN_REPS = 999          # Monte Carlo replicas per scanned day; p-values are >= 1/1000
SCAN_ALPHA = 0.001       # report a collective anomaly at p <= 0.001
SCAN_MIN_F = 3.0         # skip Monte Carlo for days whose scan score is clearly unremarkable
COLD_PSEUDO_DAYS = 7     # weight of the category reference, in days of the merchant's own history


def _lg(x):
    return -np.log10(np.clip(x, 1e-300, 1))


# --------------------------------------------------------------------------- counterfactuals
def counterfactuals(g: pd.DataFrame, mcd: pd.DataFrame, alpha: float, high: float) -> dict:
    """{(merchant_id, date): [ {signal, op, bound, observed, unit, scope} ]} for flagged days."""
    r = 1.0 / alpha
    g = g.sort_values(["merchant_id", "date"]).copy()
    by = g.groupby("merchant_id")
    g["cf_n3"] = by["n"].transform(lambda s: s.rolling(detect.SUSTAIN_DAYS).sum())
    g["cf_mu3"] = by["expected_n_adj"].transform(lambda s: s.rolling(detect.SUSTAIN_DAYS).sum())
    nch = mcd.loc[mcd["payment_channel"] != "Unknown", "payment_channel"].nunique()
    chan = mcd.set_index(["merchant_id", "date", "payment_channel"])
    out = {}
    for row in g[g["is_anomaly"] == 1].itertuples(index=False):
        cf = []
        mu = row.expected_n_adj
        if row.s_drop >= high and np.isfinite(mu):
            p = r / (r + mu)
            grid = np.arange(0, int(mu * 4 + 60))
            ok = grid[_lg(stats.nbinom.cdf(grid, r, p)) < high]
            if len(ok):
                cf.append({"signal": "s_drop", "op": ">=", "bound": int(ok[0]), "observed": int(row.n), "unit": "tx", "scope": "day"})
        if row.s_surge >= high and np.isfinite(mu):
            p = r / (r + mu)
            grid = np.arange(0, int(mu * 6 + 80))
            ok = grid[_lg(stats.nbinom.sf(grid - 1, r, p)) < high]
            if len(ok):
                cf.append({"signal": "s_surge", "op": "<=", "bound": int(ok[-1]), "observed": int(row.n), "unit": "tx", "scope": "day"})
        if row.s_drop_sustained >= high and np.isfinite(row.cf_mu3):
            rk = detect.SUSTAIN_DAYS * r
            p = rk / (rk + row.cf_mu3)
            grid = np.arange(0, int(row.cf_mu3 * 4 + 80))
            ok = grid[_lg(stats.nbinom.cdf(grid, rk, p)) < high]
            if len(ok):
                cf.append({"signal": "s_drop_sustained", "op": ">=", "bound": int(ok[0]), "observed": int(row.cf_n3), "unit": "tx", "scope": "3 days"})
        if row.s_surge_sustained >= high and np.isfinite(row.cf_mu3):
            rk = detect.SUSTAIN_DAYS * r
            p = rk / (rk + row.cf_mu3)
            grid = np.arange(0, int(row.cf_mu3 * 6 + 120))
            ok = grid[_lg(stats.nbinom.sf(grid - 1, rk, p)) < high]
            if len(ok):
                cf.append({"signal": "s_surge_sustained", "op": "<=", "bound": int(ok[-1]), "observed": int(row.cf_n3), "unit": "tx", "scope": "3 days"})
        n = int(row.n)
        for sig, k, pr in (("s_decline", row.n_dec, row.expected_dec_rate), ("s_cancel", row.n_can, row.expected_can_rate)):
            if getattr(row, sig) >= high and n > 0 and np.isfinite(pr):
                ks = np.arange(0, n + 1)
                ok = ks[_lg(stats.binom.sf(ks - 1, n, pr)) < high]
                if len(ok):
                    cf.append({"signal": sig, "op": "<=", "bound": int(ok[-1]), "observed": int(k), "unit": "count", "of": n, "scope": "day"})
        if row.s_decline_channel >= high and np.isfinite(row.expected_dec_rate):
            for c in [c for (m, d, c) in chan.index if m == row.merchant_id and d == row.date]:
                cn, ck = (int(x) for x in chan.loc[(row.merchant_id, row.date, c), ["n", "n_dec"]])
                if c == "Unknown" or cn == 0:
                    continue
                ks = np.arange(0, cn + 1)
                s = _lg(np.clip(nch * stats.binom.sf(ks - 1, cn, row.expected_dec_rate), 0, 1))
                if s[ck] >= high:
                    ok = ks[s < high]
                    cf.append({"signal": "s_decline_channel", "op": "<=", "bound": int(ok[-1]), "observed": ck, "unit": "count", "of": cn, "channel": c, "scope": "day"})
        if row.s_incident >= high and isinstance(row.incident_channel, str):
            cn, ck = (int(x) for x in chan.loc[(row.merchant_id, row.date, row.incident_channel), ["n", "n_dec"]])
            ks = np.arange(0, cn + 1)
            ok = ks[stats.binom.sf(ks - 1, cn, row.expected_dec_rate) >= detect.AFFECTED_P]
            if len(ok):
                cf.append({"signal": "s_incident", "op": "<=", "bound": int(ok[-1]), "observed": ck, "unit": "count", "of": cn, "channel": row.incident_channel, "scope": "day"})
        if row.s_amount >= high and np.isfinite(row.ref_la_mean):
            se = np.sqrt(max(row.ref_la_var, 0.05) / max(row.n_la, 1))
            z = stats.norm.isf(10 ** -high)
            cf.append({"signal": "s_amount", "op": "<=", "bound": round(float(np.exp(row.ref_la_mean + z * se)), 0),
                       "observed": round(float(np.exp(row.la_sum / max(row.n_la, 1))), 0), "unit": "DZD", "scope": "day"})
        out[(row.merchant_id, row.date)] = cf
    return out


# --------------------------------------------------------------------------- subset scanning
def _ltss(c: np.ndarray, b: np.ndarray, direction: str):
    """Max expectation-based Poisson scan over subsets; rows of c are replicas.

    F(S) = C log(C/B) + B - C, restricted to C > B (excess) or C < B (shortfall).
    LTSS: the optimum is a top-j subset when merchants are sorted by c/b.
    """
    c = np.atleast_2d(c).astype(float)
    pr = c / b
    order = np.argsort(-pr if direction == "up" else pr, axis=1, kind="stable")
    cs = np.cumsum(np.take_along_axis(c, order, axis=1), axis=1)
    bs = np.cumsum(b[order], axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        f = np.where(cs > 0, cs * np.log(cs / bs), 0.0) + bs - cs
    f = np.where((cs > bs) if direction == "up" else (cs < bs), f, 0.0)
    j = f.argmax(axis=1)
    return f.max(axis=1), order, j


def _scan_unit(ids, c, b, sim, direction, rng):
    f, order, j = _ltss(c, b, direction)
    f0 = float(f[0])
    if f0 < SCAN_MIN_F:
        return None
    fr, _, _ = _ltss(sim(rng), b, direction)
    pval = (1 + int((fr >= f0).sum())) / (SCAN_REPS + 1)
    members = [ids[i] for i in order[0, : j[0] + 1]]
    sel = np.isin(ids, members)
    return {"score": round(f0, 3), "p_value": round(pval, 4), "members": members,
            "observed": float(c[sel].sum()), "expected": round(float(b[sel].sum()), 2),
            "relative_risk": round(float(c[sel].sum() / b[sel].sum()), 3)}


def subset_scan(g: pd.DataFrame, mcd: pd.DataFrame, alpha: float, seed: int = 7) -> dict:
    """Collective anomalies: groups of merchants jointly abnormal on the same day.

    excess declines per channel-day (null: declines ~ Binomial(n_i, merchant's expected rate));
    activity shortfall per day (null: counts ~ NB(expected_n_adj, alpha)). Only established
    merchants (not warming up) are scanned. Groups of one merchant are not collective.
    """
    rng = np.random.default_rng(seed)
    found, scanned = [], 0
    base = g[~g["warming_up"].astype(bool) & g["expected_dec_rate"].notna()]
    rates = base.set_index(["merchant_id", "date"])["expected_dec_rate"]
    dec = mcd[mcd["payment_channel"] != "Unknown"].join(rates, on=["merchant_id", "date"], how="inner")
    for (ch, d), u in dec.groupby(["payment_channel", "date"]):
        u = u[u["n"] > 0]
        if len(u) < 3:
            continue
        scanned += 1
        n, p = u["n"].to_numpy(), u["expected_dec_rate"].to_numpy()
        res = _scan_unit(u["merchant_id"].to_numpy(), u["n_dec"].to_numpy(), n * p,
                         lambda rg: rg.binomial(n, p, size=(SCAN_REPS, len(n))), "up", rng)
        if res and res["p_value"] <= SCAN_ALPHA and len(res["members"]) >= 2:
            found.append({"kind": "declines", "date": d.strftime("%Y-%m-%d"), "channel": ch, "cohort": int(len(u)), **res})
    r = 1.0 / alpha
    act = base[base["expected_n_adj"].notna()]
    for d, u in act.groupby("date"):
        if len(u) < 3:
            continue
        scanned += 1
        mu = u["expected_n_adj"].to_numpy()
        res = _scan_unit(u["merchant_id"].to_numpy(), u["n"].to_numpy(), mu,
                         lambda rg: rg.negative_binomial(r, r / (r + mu), size=(SCAN_REPS, len(mu))), "down", rng)
        if res and res["p_value"] <= SCAN_ALPHA and len(res["members"]) >= 2:
            found.append({"kind": "activity", "date": d.strftime("%Y-%m-%d"), "channel": None, "cohort": int(len(u)), **res})
    found.sort(key=lambda x: (x["date"], -x["score"]), reverse=True)
    for i, x in enumerate(found):
        x["id"] = f"CLU-{x['date'].replace('-', '')}-{x['kind'][:3].upper()}{'-' + x['channel'].split(' ')[0].upper() if x['channel'] else ''}"
    return {"method": "expectation-based Poisson scan, LTSS, parametric Monte Carlo", "reps": SCAN_REPS,
            "alpha": SCAN_ALPHA, "units_scanned": scanned, "clusters": found}


# --------------------------------------------------------------------------- cold start
def cold_start(g: pd.DataFrame, alpha: float, high: float) -> dict:
    """{(merchant_id, date): {expected, score, signal, own_days}} for warming-up merchant-days."""
    r = 1.0 / alpha
    g = g.sort_values(["merchant_id", "date"])
    est = g[~g["warming_up"].astype(bool)]
    out = {}
    for row in g[g["warming_up"].astype(bool)].itertuples(index=False):
        lo = row.date - pd.Timedelta(days=detect.WINDOW_DAYS)
        peers = est[(est["category"] == row.category) & (est["date"] < row.date) & (est["date"] >= lo)
                    & (est["date"].dt.dayofweek.isin([4, 5]) == (row.date.dayofweek in (4, 5)))]
        if peers.empty:
            continue
        cat_ref = float(peers.groupby("merchant_id")["n"].median().median())
        own = g[(g["merchant_id"] == row.merchant_id) & (g["date"] < row.date)]["n"]
        h = len(own)
        mu = max(0.5, (own.sum() + COLD_PSEUDO_DAYS * cat_ref) / (h + COLD_PSEUDO_DAYS))
        p = r / (r + mu)
        s_drop, s_surge = float(_lg(stats.nbinom.cdf(row.n, r, p))), float(_lg(stats.nbinom.sf(row.n - 1, r, p)))
        score = min(max(s_drop, s_surge), detect.SCORE_CAP)
        out[(row.merchant_id, row.date)] = {"expected": round(mu, 2), "category_ref": round(cat_ref, 2), "own_days": h,
                                            "score": round(score, 3), "signal": "drop" if s_drop >= s_surge else "surge",
                                            "would_alert": bool(score >= high)}
    return out


# --------------------------------------------------------------------------- calibration and value
BINS = [0, 1, 2, 4, 7, 10, 12.0001]


def calibration(df: pd.DataFrame) -> list:
    """Share of labelled anomalies per score band (training period)."""
    cut = pd.cut(df["anomaly_score"], BINS, right=False)
    t = df.groupby(cut, observed=False)["is_anomaly"].agg(["size", "sum"])
    return [{"lo": float(i.left), "hi": float(min(i.right, 12)), "n": int(s), "positives": int(k),
             "rate": round(k / s, 4) if s else None} for i, (s, k) in zip(t.index, t.to_numpy())]


def value_curve(df: pd.DataFrame) -> list:
    """Day-level outcomes per opening threshold (neighbours join at half of it), training period."""
    out = []
    truth = df["is_anomaly"].astype(bool)
    for h in np.arange(2.0, 10.01, 0.5):
        pred = detect.flag_episodes(df, float(h), float(h) / 2).astype(bool)
        out.append({"threshold": float(h), "tp": int((truth & pred).sum()), "fp": int((~truth & pred).sum()),
                    "fn": int((truth & ~pred).sum()), "flagged": int(pred.sum())})
    return out
