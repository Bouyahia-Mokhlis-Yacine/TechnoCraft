"""Anomaly detectors over the merchant-day grid.

Every detector returns the grid with an `anomaly_score` column (higher = more anomalous).
- baseline_zscore: per-merchant robust z-score of the daily transaction count.
- isolation_forest: generic multivariate ML on per-merchant-normalised features.
- enhanced: calibrated statistical tests against a causal, calendar-aware expected level.
"""
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import IsolationForest

WINDOW_DAYS = 28      # history used as "normal reference"
MIN_HISTORY = 7       # days of history before a merchant is scored ("warming up")
PRIOR_TX = 60         # shrinkage strength of merchant rates toward the network rate
SCORE_CAP = 12.0      # cap on -log10(p)
INCIDENT_MIN_SCORE = 6.0   # network-wide channel decline test, -log10(p)
AFFECTED_P = 0.01          # merchant's own declines on that channel above its normal
SIGNALS = ["s_drop", "s_surge", "s_drop_sustained", "s_surge_sustained", "s_decline",
           "s_decline_channel", "s_cancel", "s_amount", "s_incident"]


# --------------------------------------------------------------------------- baselines
def baseline_zscore(grid: pd.DataFrame) -> pd.DataFrame:
    g = grid.copy()
    med = g.groupby("merchant_id")["n"].transform("median")
    mad = g.groupby("merchant_id")["n"].transform(lambda s: (s - s.median()).abs().median())
    g["anomaly_score"] = ((g["n"] - med).abs() / (1.4826 * mad.clip(lower=1))).fillna(0)
    return g


def _ratio_features(g: pd.DataFrame) -> pd.DataFrame:
    by = g.groupby("merchant_id")
    return pd.DataFrame({
        "count_ratio": g["n"] / by["n"].transform("median").clip(lower=1),
        "value_ratio": g["value"] / by["value"].transform("median").clip(lower=1),
        "ticket_ratio": (g["ticket"] / by["ticket"].transform("median")).fillna(1),
        "decline_rate": g["n_dec"] / g["n"].clip(lower=1),
        "cancel_rate": g["n_can"] / g["n"].clip(lower=1),
    })


def isolation_forest(grid: pd.DataFrame, seed: int = 0) -> pd.DataFrame:
    g = grid.copy()
    X = _ratio_features(g)
    model = IsolationForest(n_estimators=300, random_state=seed).fit(X)
    g["anomaly_score"] = -model.score_samples(X)
    return g


# --------------------------------------------------------------------------- enhanced
def _causal_reference(g: pd.DataFrame) -> pd.DataFrame:
    """Expected count/rates for each merchant-day from the previous WINDOW_DAYS days only."""
    g = g.sort_values(["merchant_id", "date"]).copy()
    out = []
    for _, m in g.groupby("merchant_id", sort=False):
        m = m.set_index("date")
        win = f"{WINDOW_DAYS}D"
        # Same day-type (weekday vs Fri-Sat) median, from strictly earlier days.
        exp = pd.Series(np.nan, index=m.index)
        for flag in (True, False):
            sub = m.loc[m["weekend"] == flag, "n"]
            exp.loc[sub.index] = sub.shift(1).rolling(win, min_periods=3).median()
        m["expected_n"] = exp
        m["history_days"] = np.arange(len(m))
        cols = ["n", "n_dec", "n_can", "n_la", "la_sum", "la2_sum"]
        roll = m[cols].shift(1).rolling(win, min_periods=1).sum()
        m["ref_n"], m["ref_dec"], m["ref_can"] = roll["n"], roll["n_dec"], roll["n_can"]
        # Per-transaction log-amount mean/variance over the reference window.
        m["ref_n_la"] = roll["n_la"]
        m["ref_la_mean"] = roll["la_sum"] / roll["n_la"]
        m["ref_la_var"] = roll["la2_sum"] / roll["n_la"] - m["ref_la_mean"] ** 2
        out.append(m.reset_index())
    return pd.concat(out, ignore_index=True)


def _holiday_factor(g: pd.DataFrame, holidays: set) -> pd.Series:
    """On public holidays, scale expectation by how the merchant's category moved that day.

    Leave-one-out: a merchant's own drop does not explain itself away.
    """
    factor = pd.Series(1.0, index=g.index)
    hol = g["date"].isin(holidays) & g["expected_n"].notna()
    if not hol.any():
        return factor
    h = g[hol]
    key = [h["category"], h["date"]]
    obs_sum = h.groupby(key)["n"].transform("sum") - h["n"]
    exp_sum = h.groupby(key)["expected_n"].transform("sum") - h["expected_n"]
    factor.loc[h.index] = (obs_sum / exp_sum.replace(0, np.nan)).fillna(1).clip(0.05, 1.5)
    return factor


def _shrunk_rate(k, n, prior_rate):
    return (k + PRIOR_TX * prior_rate) / (n + PRIOR_TX)


def estimate_dispersion(g: pd.DataFrame) -> float:
    """Method-of-moments NB alpha from (n - mu)^2 - mu, clipped to a sane range."""
    ok = g["expected_n"].notna() & (g["history_days"] >= MIN_HISTORY)
    mu, n = g.loc[ok, "expected_n"], g.loc[ok, "n"]
    alpha = ((n - mu) ** 2 - mu).sum() / (mu ** 2).sum()
    return float(np.clip(alpha, 0.005, 0.2))


SUSTAIN_DAYS = 3
DROP_MATERIAL = 0.7   # business materiality: a "drop" day is at most 70% of normal
SURGE_MATERIAL = 1.5  # a "surge" day is at least 150% of normal


def _channel_decline_score(g: pd.DataFrame, mcd: pd.DataFrame) -> pd.Series:
    """Worst per-channel decline test for each merchant-day (Bonferroni over channels).

    A gateway failure on one channel is diluted in the merchant's all-channel rate.
    """
    m = mcd[mcd["payment_channel"] != "Unknown"].merge(
        g[["merchant_id", "date", "expected_dec_rate"]], on=["merchant_id", "date"])
    p_raw = stats.binom.sf(m["n_dec"] - 1, m["n"], m["expected_dec_rate"])
    k = mcd["payment_channel"].nunique()
    m["s"] = -np.log10(np.clip(k * p_raw, 1e-300, 1))
    # Systemic incident: weak merchant-level evidence is enough when the same channel is
    # failing network-wide that day; the merchant inherits the incident's confidence.
    inc = channel_incidents(mcd)[["payment_channel", "date", "score"]]
    m = m.merge(inc.rename(columns={"score": "incident_score"}), how="left",
                on=["payment_channel", "date"])
    affected = m["incident_score"].notna() & (p_raw < AFFECTED_P) & (m["n_dec"] > 0)
    m["s_inc"] = m["incident_score"].clip(upper=SCORE_CAP).where(affected, 0)
    m["inc_channel"] = m["payment_channel"].where(affected)
    idx = pd.MultiIndex.from_frame(g[["merchant_id", "date"]])
    by = m.groupby(["merchant_id", "date"])
    return pd.DataFrame({
        "s_decline_channel": idx.map(by["s"].max()),
        "s_incident": idx.map(by["s_inc"].max()),
        "incident_channel": idx.map(by["inc_channel"].first()),
    }, index=g.index).fillna({"s_decline_channel": 0, "s_incident": 0})


def enhanced(grid: pd.DataFrame, holidays: set = frozenset(), dispersion: float | None = None,
             merchant_channel: pd.DataFrame | None = None) -> pd.DataFrame:
    """Score each merchant-day with one-sided tail probabilities per signal.

    dispersion: negative-binomial alpha (var = mu + alpha*mu^2). None = estimated from data
    (on this dataset counts are close to Poisson, alpha ~0.01).
    """
    g = _causal_reference(grid)
    g["holiday"] = g["date"].isin(holidays)
    g["holiday_factor"] = _holiday_factor(g, holidays)
    mu = (g["expected_n"] * g["holiday_factor"]).clip(lower=0.5)
    g["expected_n_adj"] = mu
    n = g["n"]
    alpha = estimate_dispersion(g) if dispersion is None else dispersion
    g.attrs["dispersion"] = alpha

    # Negative binomial with mean mu, var mu + a*mu^2  ->  scipy (r, p)
    r = 1.0 / alpha
    p = r / (r + mu)
    sf = lambda x: pd.Series(-np.log10(np.clip(x, 1e-300, 1)), index=g.index)  # noqa: E731
    g["s_drop"] = sf(stats.nbinom.cdf(n, r, p))
    g["s_surge"] = sf(stats.nbinom.sf(n - 1, r, p))

    # Sustained shift: last SUSTAIN_DAYS days together (sum of NB ~ NB with k*r).
    # Materiality gate: the day itself must be >=30% below / >=50% above expectation,
    # otherwise the window just carries evidence over from the days before it.
    by = g.groupby("merchant_id")
    n_k = by["n"].transform(lambda s: s.rolling(SUSTAIN_DAYS).sum())
    mu_k = g.assign(mu=mu).groupby("merchant_id")["mu"].transform(
        lambda s: s.rolling(SUSTAIN_DAYS).sum())
    p_k = SUSTAIN_DAYS * r / (SUSTAIN_DAYS * r + mu_k)
    g["s_drop_sustained"] = sf(stats.nbinom.cdf(n_k, SUSTAIN_DAYS * r, p_k)).where(
        n <= DROP_MATERIAL * mu, 0)
    g["s_surge_sustained"] = sf(stats.nbinom.sf(n_k - 1, SUSTAIN_DAYS * r, p_k)).where(
        n >= SURGE_MATERIAL * mu, 0)

    net_dec = g["n_dec"].sum() / g["n"].sum()
    net_can = g["n_can"].sum() / g["n"].sum()
    p_dec = _shrunk_rate(g["ref_dec"], g["ref_n"], net_dec)
    p_can = _shrunk_rate(g["ref_can"], g["ref_n"], net_can)
    g["expected_dec_rate"], g["expected_can_rate"] = p_dec, p_can
    g["s_decline"] = sf(stats.binom.sf(g["n_dec"] - 1, n, p_dec))
    g["s_cancel"] = sf(stats.binom.sf(g["n_can"] - 1, n, p_can))
    if merchant_channel is None:
        g["s_decline_channel"], g["s_incident"], g["incident_channel"] = 0.0, 0.0, np.nan
    else:
        g = g.join(_channel_decline_score(g, merchant_channel))

    # Amount level: mean log-amount of today's accepted payments vs the reference
    # per-transaction distribution; standard error shrinks with sqrt(n), so 4 payments
    # need a much bigger shift than 20 to be flagged. Upward only (SPIKE_AMOUNT).
    se = np.sqrt(g["ref_la_var"].clip(lower=0.05) / g["n_la"].clip(lower=1))
    z = (g["la_sum"] / g["n_la"].clip(lower=1) - g["ref_la_mean"]) / se
    g["expected_ticket"] = np.exp(g["ref_la_mean"])
    g["s_amount"] = sf(stats.norm.sf(z)).where((g["n_la"] >= 3) & (g["ref_n_la"] >= 30), 0)

    signals = SIGNALS
    g[signals] = g[signals].clip(upper=SCORE_CAP).fillna(0)
    # Warming up: count/amount signals need a reference level first.
    warm = (g["history_days"] < MIN_HISTORY) | g["expected_n"].isna()
    g.loc[warm, ["s_drop", "s_surge", "s_drop_sustained", "s_surge_sustained", "s_amount"]] = 0
    g["anomaly_score"] = g[signals].max(axis=1)
    g["main_signal"] = g[signals].idxmax(axis=1).str[2:].where(g["anomaly_score"] > 0, "none")
    g["warming_up"] = warm
    return g


def flag_episodes(g: pd.DataFrame, high: float, low: float | None = None) -> pd.Series:
    """Hysteresis: a day opens an episode at >= high; neighbours join it at >= low.

    Days affected by a network-wide incident are flagged on their own and never pull
    neighbouring days in (the incident is one day; the merchant's own signals are not).
    """
    low = high if low is None else low
    own = g[[s for s in SIGNALS if s != "s_incident"]].max(axis=1)
    incident = g["s_incident"] >= high
    g = g.assign(_own=own).sort_values(["merchant_id", "date"])
    flags = pd.Series(False, index=g.index)
    for _, m in g.groupby("merchant_id", sort=False):
        s = m["_own"].to_numpy()
        f = s >= high
        changed = True
        while changed:
            nb = np.zeros_like(f)
            nb[1:] |= f[:-1]
            nb[:-1] |= f[1:]
            new = f | (nb & (s >= low))
            changed = bool((new != f).any())
            f = new
        flags.loc[m.index] = f
    return flags.reindex(incident.index) | incident


def channel_incidents(merchant_channel: pd.DataFrame,
                      min_score: float = INCIDENT_MIN_SCORE) -> pd.DataFrame:
    """Channel-days whose network-wide decline rate is far above that channel's history."""
    c = (merchant_channel[merchant_channel["payment_channel"] != "Unknown"]
         .groupby(["payment_channel", "date"])[["n", "n_dec"]].sum().reset_index()
         .sort_values(["payment_channel", "date"]))
    by = c.groupby("payment_channel")
    ref_n = by["n"].transform(lambda s: s.shift(1).rolling(WINDOW_DAYS, min_periods=7).sum())
    ref_d = by["n_dec"].transform(lambda s: s.shift(1).rolling(WINDOW_DAYS, min_periods=7).sum())
    c["expected_rate"] = _shrunk_rate(ref_d, ref_n, c["n_dec"].sum() / c["n"].sum())
    c["observed_rate"] = c["n_dec"] / c["n"]
    c["score"] = -np.log10(np.clip(stats.binom.sf(c["n_dec"] - 1, c["n"], c["expected_rate"]),
                                   1e-300, 1))
    return c[c["score"] >= min_score].dropna(subset=["expected_rate"])
