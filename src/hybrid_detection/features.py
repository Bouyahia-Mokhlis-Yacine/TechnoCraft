"""Hierarchical probabilistic, channel, temporal and interaction features (H1, H2, H3).

Every reference parameter and feature value at date t uses strictly prior history (< cutoff)
and causal observations available up to day t within the active replay epoch.
"""

from dataclasses import dataclass
from hashlib import blake2b
import json
from math import log, sqrt

import numpy as np
import pandas as pd
from scipy import stats

from src.data.preprocessing import CHANNELS, KEYS
from src.detection.benchmark_features import KEY_INDEX, keyed
from src.detection.calibration import PRIMARY
from src.detection.channel import ChannelReference, merchant_channel_max, score_channels
from src.detection.detectors import ALL_METRICS, score_day
from src.detection.distributions import (
    AmountPool,
    corrected_variance,
    discrete_log_tail,
    evidence_score,
    fit_amount_pool,
    two_sided,
)
from src.detection.references import Batch, CHANNEL_NAMES, fit_reference
from src.detection.sequential import CountTrack, RateBank

KNOWN_CHANNELS = tuple(CHANNELS.values())

H1_COLUMNS = (
    'count_obs_log',
    'count_exp_log',
    'count_log_ratio',
    'count_std_residual',
    'count_lower_score',
    'count_upper_score',
    'ticket_score',
    'ticket_signed_log_dev',
    'attempted_value_score',
    'accepted_value_score',
    'declines_score',
    'decline_std_residual',
    'cancellations_score',
    'cancel_std_residual',
    'interval_exceedances',
    'support_log_days',
    'cold_start',
    'missing_amount_frac',
    'no_valid_amount',
    'cusum_drop',
    'cusum_surge',
    'cusum_drop_persistent',
    'cusum_surge_persistent',
    'v1_max_score',
    'v2_managed_score',
)

H2_EXTRA_COLUMNS = (
    'ch_count_max_drop_z',
    'ch_count_max_surge_z',
    'ch_count_max_score',
    'ch_inactivity_max_score',
    'ch_comp_max_abs_share_z',
    'ch_comp_chi2',
    'ch_decline_max_z',
    'ch_cancel_max_z',
    'ch_outcome_max_score',
    'ch_outcome_gated_score',
    'ch_ticket_max_score',
    'ch_ticket_max_abs_z',
    'ch_ticket_signed_extreme_z',
    'ch_nfc_ticket_z',
    'ch_nfc_ticket_score',
    'ch_nfc_active',
    'ch_active_count',
    'ch_expected_active_count',
    'ch_unknown_share',
)

H3_EXTRA_COLUMNS = (
    'temp_v1_mean_3d',
    'temp_v1_slope_3d',
    'temp_count_z_mean_3d',
    'temp_count_z_slope_3d',
    'temp_count_z_mean_7d',
    'temp_count_z_std_7d',
    'temp_decline_z_mean_3d',
    'temp_ticket_abs_z_mean_3d',
    'temp_dev_streak',
    'temp_intermittent_7d',
    'lag1_count_z',
    'lag1_v1_score',
    'lag1_ch_drop_z',
    'interact_drop_x_decline',
    'interact_stable_cnt_x_ticket',
    'interact_hidden_channel_drop',
    'interact_decline_x_comp',
    'interact_multi_moderate',
)

H2_COLUMNS = H1_COLUMNS + H2_EXTRA_COLUMNS
H3_COLUMNS = H2_COLUMNS + H3_EXTRA_COLUMNS
FEATURE_SETS = {'H1': H1_COLUMNS, 'H2': H2_COLUMNS, 'H3': H3_COLUMNS}


@dataclass(frozen=True)
class ChannelMonetaryPool:
    """Empirical Bayes shrunk log-amount pool scoped to a single payment channel."""
    channel: str
    pool: AmountPool
    residual_scale: float


@dataclass(frozen=True)
class HierarchicalChannelModel:
    """Strictly prior hierarchical parameters across channels for frequency, mix, outcomes, and amounts."""
    base_reference: object
    channel_reference: ChannelReference
    gamma_priors: dict
    merchant_channel_counts: dict
    merchant_exposures: dict
    dirichlet_alpha: dict
    dirichlet_concentration: float
    monetary_pools: dict
    expected_active_channels: dict


def _fit_channel_gamma_prior(prior, exposure_series, channel):
    col = f'{channel}_count'
    totals = prior.groupby('merchant_id')[col].sum().to_frame('y')
    totals['exposure'] = exposure_series.groupby(prior['merchant_id']).sum().clip(lower=1e-6)
    total_y = float(totals['y'].sum())
    total_e = float(totals['exposure'].sum())
    if total_y <= 0 or total_e <= 0:
        return 1e-3, 1.0
    center = max(1e-6, total_y / total_e)
    rate = totals['y'] / totals['exposure']
    between = corrected_variance(rate, float((rate / totals['exposure']).mean()), 1e-4 * center**2)
    shape = float(np.clip(center**2 / between, 0.05, 1e4))
    return shape, float(shape / center)


def _fit_dirichlet_prior(prior):
    counts = prior.groupby('merchant_id')[[f'{c}_count' for c in KNOWN_CHANNELS]].sum()
    totals = counts.sum(axis=1)
    active = counts.loc[totals.gt(0)]
    if active.empty:
        equal = {c: 1.0 / len(KNOWN_CHANNELS) for c in KNOWN_CHANNELS}
        return {c: 2.0 * v for c, v in equal.items()}, 2.0
    n = active.sum(axis=1)
    pi_bar = active.sum(axis=0) / float(n.sum())
    pi_bar = pi_bar.clip(lower=1e-4)
    pi_bar = pi_bar / pi_bar.sum()
    if len(active) <= 1:
        kappa = 10.0
    else:
        shares = active.div(n, axis=0)
        kappas = []
        for c in KNOWN_CHANNELS:
            col = f'{c}_count'
            p = float(pi_bar[col])
            obs_var = float(shares[col].var(ddof=1))
            sampling = float((p * (1.0 - p) / n).mean())
            excess = max(1e-6, obs_var - sampling)
            k_c = max(2.0, min(200.0, p * (1.0 - p) / excess - 1.0))
            kappas.append(k_c)
        kappa = float(np.median(kappas))
    alpha = {c: float(kappa * pi_bar[f'{c}_count']) for c in KNOWN_CHANNELS}
    return alpha, kappa


def fit_hierarchical_channel_model(history, events, cutoff, config):
    """Fit prior-only hierarchical merchant-channel priors strictly before cutoff."""
    cutoff = pd.Timestamp(cutoff).normalize()
    prior = history.loc[history.date.lt(cutoff)].sort_values(KEY_INDEX)
    if prior.empty:
        raise ValueError('Hierarchical model requires at least one prior merchant-day.')
    reference = fit_reference(prior, events, cutoff, config['version'])
    past_events = events.loc[events.date.lt(cutoff)].merge(prior[KEYS], on=KEYS, validate='many_to_one')
    exposure = prior.groupby('merchant_id')[[f'{c}_count' for c in CHANNEL_NAMES]].sum()
    ch_ref = ChannelReference(reference, exposure, pd.Series(dtype=object))

    weekday_exp = prior.date.dt.weekday.map(reference.weekday).fillna(1.0)
    gamma_priors = {c: _fit_channel_gamma_prior(prior, weekday_exp, c) for c in KNOWN_CHANNELS}
    mc_counts = prior.groupby('merchant_id')[[f'{c}_count' for c in KNOWN_CHANNELS]].sum().to_dict('index')
    merchant_exposures = {m: float(t[2]) for m, t in reference.totals.items()}
    dir_alpha, dir_kappa = _fit_dirichlet_prior(prior)

    monetary_pools = {}
    for c in KNOWN_CHANNELS:
        ch_events = past_events.loc[past_events.channel.eq(c)]
        pool = fit_amount_pool(ch_events)
        if len(pool.positive_residuals) >= 3:
            mad = float(stats.median_abs_deviation(pool.positive_residuals, scale='normal'))
            r_scale = max(0.05, mad if mad > 0 else float(np.std(pool.positive_residuals)))
        else:
            r_scale = 0.5
        monetary_pools[c] = ChannelMonetaryPool(c, pool, r_scale)

    prior_active = prior.assign(
        known_active=prior[[f'{c}_count' for c in KNOWN_CHANNELS]].gt(0).sum(axis=1)
    ).groupby('merchant_id').known_active.mean().to_dict()

    return HierarchicalChannelModel(
        base_reference=reference,
        channel_reference=ch_ref,
        gamma_priors=gamma_priors,
        merchant_channel_counts=mc_counts,
        merchant_exposures=merchant_exposures,
        dirichlet_alpha=dir_alpha,
        dirichlet_concentration=dir_kappa,
        monetary_pools=monetary_pools,
        expected_active_channels=prior_active,
    )


def _channel_median_score(pool_obj: ChannelMonetaryPool, merchant, date, amounts_arr, *, draws=256, seed=710):
    """Empirical exposure-conditioned ticket score and signed log-deviation for a channel."""
    pool = pool_obj.pool
    vals = np.asarray(amounts_arr, dtype=float)
    vals = vals[np.isfinite(vals) & (vals >= 0)]
    n_obs = len(vals)
    if n_obs == 0 or pool.center is None:
        return 0.0, 0.0
    observed = float(np.median(vals))
    anchor = pool.anchor(merchant)
    signed_z = (np.log1p(observed) - np.log1p(np.exp(anchor))) / pool_obj.residual_scale

    key = json.dumps([seed, 'ch', pool_obj.channel, str(merchant), str(date.date()), n_obs]).encode()
    rng = np.random.default_rng(int.from_bytes(blake2b(key, digest_size=16).digest(), 'little'))
    local = pool.local_positive.get(merchant)
    support = pool.counts.get(merchant, 0)
    weight = support / (support + pool.strength)
    local_zero = pool.local_zero_rates.get(merchant, 0.0)
    use_local = rng.random((draws, n_obs)) < weight
    zero = rng.random((draws, n_obs)) < np.where(use_local, local_zero, pool.zero_rate)
    residual = rng.choice(pool.positive_residuals, (draws, n_obs))
    if local is not None:
        residual = np.where(use_local, rng.choice(local, (draws, n_obs)), residual)
    sim_medians = np.median(np.where(zero, 0.0, np.exp(anchor + residual)), axis=1)
    tol = abs(observed) * 1e-12
    lo = (1 + np.count_nonzero(sim_medians <= observed + tol)) / (draws + 1)
    hi = (1 + np.count_nonzero(sim_medians >= observed - tol)) / (draws + 1)
    score = evidence_score(two_sided(np.log(lo), np.log(hi)))
    return float(score), float(signed_z)


def _extract_h1_row(row, daily_item, count_evidence_seq, reference, config, fusion_cfg):
    """Compute H1 statistical & sequential features for a single merchant-day."""
    dets = daily_item['detectors']
    cnt = dets['transaction_count']
    obs_cnt = float(cnt['observed'] or 0.0)
    exp_cnt = float(cnt['expected'] or 0.0)
    days_hist, _, _, _, _ = reference.totals.get(row.merchant_id, (0, 0, 0.0, 0, 0))
    if cnt['method'] == 'weekday_merchant_poisson':
        var_cnt = max(exp_cnt, 1e-6)
    else:
        a, b = reference.gamma
        _, _, exposure_hist, _, _ = reference.totals.get(row.merchant_id, (0, 0, 0.0, 0, 0))
        shape_post = a + float(reference.totals.get(row.merchant_id, (0, 0, 0.0, 0, 0))[1])
        var_cnt = max(exp_cnt + (exp_cnt**2) / max(shape_post, 1e-3), 1e-6)
    count_std_res = (obs_cnt - exp_cnt) / sqrt(var_cnt)
    count_log_ratio = log((obs_cnt + 0.5) / (exp_cnt + 0.5))

    lower_p = max(float(cnt.get('lower_tail_probability') or 1.0), 1e-300)
    upper_p = max(float(cnt.get('upper_tail_probability') or 1.0), 1e-300)

    tkt = dets['median_ticket']
    tkt_score = float(tkt['score'] or 0.0)
    if tkt['observed'] is not None and tkt['expected'] is not None:
        tkt_signed_log = float(np.log1p(tkt['observed']) - np.log1p(tkt['expected']))
    else:
        tkt_signed_log = 0.0

    att_score = float(dets['attempted_value']['score'] or 0.0)
    acc_score = float(dets['accepted_value']['score'] or 0.0)

    dec = dets['declines']
    dec_score = float(dec['score'] or 0.0)
    if dec['exposure'] and dec['expected'] is not None:
        p_dec = float(dec['expected_rate'])
        dec_var = max(float(dec['exposure']) * p_dec * (1.0 - p_dec), 1e-6)
        dec_z = (float(dec['observed']) - float(dec['expected'])) / sqrt(dec_var)
    else:
        dec_z = 0.0

    can = dets['cancellations']
    can_score = float(can['score'] or 0.0)
    if can['exposure'] and can['expected'] is not None:
        p_can = float(can['expected_rate'])
        can_var = max(float(can['exposure']) * p_can * (1.0 - p_can), 1e-6)
        can_z = (float(can['observed']) - float(can['expected'])) / sqrt(can_var)
    else:
        can_z = 0.0

    exceedances = 0
    for key in PRIMARY:
        d = dets[key]
        if d['observed'] is not None and d['interval'] is not None:
            lo, hi = d['interval']
            if d['observed'] < lo or d['observed'] > hi:
                exceedances += 1

    missing_frac = (
        1.0 - float(row.valid_amount_count) / float(row.transaction_count)
        if row.transaction_count > 0 else 0.0
    )

    if count_evidence_seq is not None:
        drop_arms = [
            (val, streak)
            for r, val, streak in zip(count_evidence_seq.ratios, count_evidence_seq.values, count_evidence_seq.streaks)
            if r < 1
        ]
        surge_arms = [
            (val, streak)
            for r, val, streak in zip(count_evidence_seq.ratios, count_evidence_seq.values, count_evidence_seq.streaks)
            if r > 1
        ]
        c_drop = max((v for v, _ in drop_arms), default=0.0)
        c_surge = max((v for v, _ in surge_arms), default=0.0)
        c_drop_p = max((v for v, s in drop_arms if s >= fusion_cfg['persistence']), default=0.0)
        c_surge_p = max((v for v, s in surge_arms if s >= fusion_cfg['persistence']), default=0.0)
    else:
        c_drop = c_surge = c_drop_p = c_surge_p = 0.0

    v1_max = float(daily_item['anomaly_score'] or 0.0)
    v2_managed = max(
        v1_max / fusion_cfg['instant_scale'],
        max(c_drop_p, c_surge_p) / fusion_cfg['sequential_scale'],
    )

    return {
        'count_obs_log': float(np.log1p(obs_cnt)),
        'count_exp_log': float(np.log1p(exp_cnt)),
        'count_log_ratio': float(count_log_ratio),
        'count_std_residual': float(count_std_res),
        'count_lower_score': float(-np.log10(lower_p)),
        'count_upper_score': float(-np.log10(upper_p)),
        'ticket_score': tkt_score,
        'ticket_signed_log_dev': tkt_signed_log,
        'attempted_value_score': att_score,
        'accepted_value_score': acc_score,
        'declines_score': dec_score,
        'decline_std_residual': float(dec_z),
        'cancellations_score': can_score,
        'cancel_std_residual': float(can_z),
        'interval_exceedances': float(exceedances),
        'support_log_days': float(np.log1p(days_hist)),
        'cold_start': float(days_hist < config['established_days']),
        'missing_amount_frac': float(missing_frac),
        'no_valid_amount': float(row.valid_amount_count == 0),
        'cusum_drop': float(c_drop),
        'cusum_surge': float(c_surge),
        'cusum_drop_persistent': float(c_drop_p),
        'cusum_surge_persistent': float(c_surge_p),
        'v1_max_score': v1_max,
        'v2_managed_score': float(v2_managed),
    }


def _extract_h2_extra(row, day, ch_day_df, ch_events_by_mc, hmodel: HierarchicalChannelModel, channel_minimum, seed):
    """Compute hierarchical merchant-channel features for a single merchant-day."""
    merchant = row.merchant_id
    weekday = hmodel.base_reference.weekday.get(day.weekday(), 1.0)
    hist_exp = hmodel.merchant_exposures.get(merchant, 0.0)
    mc_hist = hmodel.merchant_channel_counts.get(merchant, {})

    drop_zs, surge_zs, cnt_scores, inact_scores = [], [], [], []
    known_obs_counts = []
    known_post_alphas = []
    for c in KNOWN_CHANNELS:
        a_c, b_c = hmodel.gamma_priors[c]
        y_prior = float(mc_hist.get(f'{c}_count', 0.0))
        r_post = a_c + y_prior
        rate_post = b_c + hist_exp
        p_nb = rate_post / (rate_post + weekday)
        law = stats.nbinom(r_post, p_nb)
        mu = float(law.mean())
        var = max(mu + (mu**2) / max(r_post, 1e-6), 1e-6)
        obs = float(getattr(row, f'{c}_count'))
        z = (obs - mu) / sqrt(var)
        drop_zs.append(max(0.0, -z))
        surge_zs.append(max(0.0, z))
        lower = discrete_log_tail(law, int(obs), upper=False)
        upper = discrete_log_tail(law, int(obs), upper=True)
        cnt_scores.append(evidence_score(two_sided(lower, upper)))
        if obs == 0 and y_prior > 0 and mu >= 0.5:
            inact_scores.append(evidence_score(lower))
        else:
            inact_scores.append(0.0)
        known_obs_counts.append(obs)
        known_post_alphas.append(hmodel.dirichlet_alpha[c] + y_prior)

    n_known = sum(known_obs_counts)
    alpha_sum = sum(known_post_alphas)
    comp_abs_zs = []
    comp_chi2 = 0.0
    if n_known > 0 and alpha_sum > 0:
        for obs, a_post in zip(known_obs_counts, known_post_alphas):
            pi = a_post / alpha_sum
            exp_c = n_known * pi
            # Beta-Binomial marginal variance under Dirichlet-Multinomial.
            bb_var = max(n_known * pi * (1.0 - pi) * ((n_known + alpha_sum) / (1.0 + alpha_sum)), 1e-6)
            z_share = (obs - exp_c) / sqrt(bb_var)
            comp_abs_zs.append(abs(z_share))
            comp_chi2 += (obs - exp_c) ** 2 / max(exp_c, 0.5)
    else:
        comp_abs_zs = [0.0]

    # Outcomes from score_channels output for this merchant.
    dec_zs, can_zs, out_scores, gated_scores = [0.0], [0.0], [0.0], [0.0]
    if ch_day_df is not None and not ch_day_df.empty:
        for ch_row in ch_day_df.itertuples(index=False):
            if ch_row.channel == 'unknown' or ch_row.exposure <= 0:
                continue
            p_d = float(ch_row.declines_probability)
            v_d = max(ch_row.exposure * p_d * (1.0 - p_d), 1e-6)
            dec_zs.append((ch_row.declines - ch_row.declines_expected) / sqrt(v_d))

            p_c = float(ch_row.cancellations_probability)
            v_c = max(ch_row.exposure * p_c * (1.0 - p_c), 1e-6)
            can_zs.append((ch_row.cancellations - ch_row.cancellations_expected) / sqrt(v_c))

            s_max = float(max(ch_row.declines_score, ch_row.cancellations_score))
            out_scores.append(s_max)
            if ch_row.exposure >= channel_minimum:
                gated_scores.append(s_max)

    # Hierarchical channel monetary evidence.
    tkt_scores, tkt_abs_zs, tkt_signed_zs = [0.0], [0.0], [0.0]
    nfc_z = 0.0
    nfc_score = 0.0
    nfc_active = 0.0
    for c in KNOWN_CHANNELS:
        vals = ch_events_by_mc.get((merchant, c))
        if vals is not None and len(vals) > 0:
            sc, sz = _channel_median_score(hmodel.monetary_pools[c], merchant, day, vals, seed=seed)
            tkt_scores.append(sc)
            tkt_abs_zs.append(abs(sz))
            tkt_signed_zs.append(sz)
            if c == 'nfc':
                nfc_z = sz
                nfc_score = sc
                nfc_active = 1.0

    extreme_idx = int(np.argmax(tkt_abs_zs))
    active_known = sum(1 for x in known_obs_counts if x > 0)
    exp_active = float(hmodel.expected_active_channels.get(
        merchant, np.mean(list(hmodel.expected_active_channels.values())) if hmodel.expected_active_channels else 0.0
    ))
    unknown_share = float(row.unknown_count / row.transaction_count) if row.transaction_count > 0 else 0.0

    return {
        'ch_count_max_drop_z': float(max(drop_zs)),
        'ch_count_max_surge_z': float(max(surge_zs)),
        'ch_count_max_score': float(max(cnt_scores)),
        'ch_inactivity_max_score': float(max(inact_scores)),
        'ch_comp_max_abs_share_z': float(max(comp_abs_zs)),
        'ch_comp_chi2': float(comp_chi2),
        'ch_decline_max_z': float(max(dec_zs)),
        'ch_cancel_max_z': float(max(can_zs)),
        'ch_outcome_max_score': float(max(out_scores)),
        'ch_outcome_gated_score': float(max(gated_scores)),
        'ch_ticket_max_score': float(max(tkt_scores)),
        'ch_ticket_max_abs_z': float(max(tkt_abs_zs)),
        'ch_ticket_signed_extreme_z': float(tkt_signed_zs[extreme_idx]),
        'ch_nfc_ticket_z': float(nfc_z),
        'ch_nfc_ticket_score': float(nfc_score),
        'ch_nfc_active': float(nfc_active),
        'ch_active_count': float(active_known),
        'ch_expected_active_count': float(exp_active),
        'ch_unknown_share': unknown_share,
    }


def _add_h3_temporal_and_interactions(h2_frame):
    """Add strictly causal temporal summaries (<= t) and multivariate interaction features."""
    df = h2_frame.sort_index().copy()
    dates = df.index.get_level_values('date')
    merchants = df.index.get_level_values('merchant_id')

    # Interactions (row-wise, strictly same-day, zero leakage).
    df['interact_drop_x_decline'] = np.maximum(0.0, -df['count_std_residual']) * np.maximum(0.0, df['decline_std_residual'])
    df['interact_stable_cnt_x_ticket'] = (
        1.0 / (1.0 + df['count_std_residual'].abs())
    ) * np.maximum(df['ticket_signed_log_dev'].abs(), df['ch_ticket_max_abs_z'])
    df['interact_hidden_channel_drop'] = np.maximum(0.0, df['ch_count_max_drop_z'] - df['count_std_residual'].abs())
    df['interact_decline_x_comp'] = np.maximum(0.0, df['ch_decline_max_z']) * df['ch_comp_chi2']
    df['interact_multi_moderate'] = (
        (df['count_std_residual'].abs() >= 1.0).astype(float)
        + (df['ticket_signed_log_dev'].abs() >= 0.35).astype(float)
        + (df['decline_std_residual'] >= 1.0).astype(float)
        + (df['cancel_std_residual'] >= 1.0).astype(float)
        + (df['ch_count_max_drop_z'] >= 1.5).astype(float)
        + (df['ch_comp_chi2'] >= 2.0).astype(float)
    )

    # Strictly causal per-merchant temporal features, resetting across date gaps (> 1 day).
    n = len(df)
    cols = {
        'temp_v1_mean_3d': np.zeros(n),
        'temp_v1_slope_3d': np.zeros(n),
        'temp_count_z_mean_3d': np.zeros(n),
        'temp_count_z_slope_3d': np.zeros(n),
        'temp_count_z_mean_7d': np.zeros(n),
        'temp_count_z_std_7d': np.zeros(n),
        'temp_decline_z_mean_3d': np.zeros(n),
        'temp_ticket_abs_z_mean_3d': np.zeros(n),
        'temp_dev_streak': np.zeros(n),
        'temp_intermittent_7d': np.zeros(n),
        'lag1_count_z': np.zeros(n),
        'lag1_v1_score': np.zeros(n),
        'lag1_ch_drop_z': np.zeros(n),
    }

    v1_arr = df['v1_max_score'].to_numpy()
    cz_arr = df['count_std_residual'].to_numpy()
    dz_arr = df['decline_std_residual'].to_numpy()
    tz_arr = df['ticket_signed_log_dev'].abs().to_numpy()
    chd_arr = df['ch_count_max_drop_z'].to_numpy()
    pos_map = {key: idx for idx, key in enumerate(df.index)}

    for _, group_idx in df.groupby(merchants, sort=False).groups.items():
        # Order chronologically for this merchant.
        ordered = sorted(group_idx, key=lambda k: k[0])
        streak = 0
        prev_day = None
        buf_v1, buf_cz, buf_dz, buf_tz, buf_chd, buf_dev = [], [], [], [], [], []
        for key in ordered:
            day = key[0]
            if prev_day is not None and (day - prev_day).days != 1:
                streak = 0
                buf_v1.clear()
                buf_cz.clear()
                buf_dz.clear()
                buf_tz.clear()
                buf_chd.clear()
                buf_dev.clear()
            i = pos_map[key]
            v1_t, cz_t, dz_t, tz_t, chd_t = v1_arr[i], cz_arr[i], dz_arr[i], tz_arr[i], chd_arr[i]
            is_dev = float(max(abs(cz_t), dz_t, chd_t) > 1.5 or v1_t > 1.0)
            streak = streak + 1 if is_dev > 0 else 0

            buf_v1.append(v1_t)
            buf_cz.append(cz_t)
            buf_dz.append(dz_t)
            buf_tz.append(tz_t)
            buf_chd.append(chd_t)
            buf_dev.append(float(abs(cz_t) > 1.25 or v1_t > 1.0))

            w3_v1 = buf_v1[-3:]
            w3_cz = buf_cz[-3:]
            w7_cz = buf_cz[-7:]
            cols['temp_v1_mean_3d'][i] = float(np.mean(w3_v1))
            cols['temp_v1_slope_3d'][i] = float(w3_v1[-1] - w3_v1[0]) / max(1, len(w3_v1) - 1) if len(w3_v1) > 1 else 0.0
            cols['temp_count_z_mean_3d'][i] = float(np.mean(w3_cz))
            cols['temp_count_z_slope_3d'][i] = float(w3_cz[-1] - w3_cz[0]) / max(1, len(w3_cz) - 1) if len(w3_cz) > 1 else 0.0
            cols['temp_count_z_mean_7d'][i] = float(np.mean(w7_cz))
            cols['temp_count_z_std_7d'][i] = float(np.std(w7_cz, ddof=0))
            cols['temp_decline_z_mean_3d'][i] = float(np.mean(buf_dz[-3:]))
            cols['temp_ticket_abs_z_mean_3d'][i] = float(np.mean(buf_tz[-3:]))
            cols['temp_dev_streak'][i] = float(streak)
            cols['temp_intermittent_7d'][i] = float(np.mean(buf_dev[-7:]))
            cols['lag1_count_z'][i] = float(buf_cz[-2]) if len(buf_cz) >= 2 else 0.0
            cols['lag1_v1_score'][i] = float(buf_v1[-2]) if len(buf_v1) >= 2 else 0.0
            cols['lag1_ch_drop_z'][i] = float(buf_chd[-2]) if len(buf_chd) >= 2 else 0.0
            prev_day = day

    for name, arr in cols.items():
        df[name] = arr
    return df


@dataclass
class V4FeatureEpoch:
    h1: pd.DataFrame
    h2: pd.DataFrame
    h3: pd.DataFrame
    daily_details: dict
    channel_details: dict
    hmodel: HierarchicalChannelModel
    timings_ms: dict

    def matrix(self, name, keys=None):
        frame = {'H1': self.h1, 'H2': self.h2, 'H3': self.h3}[name]
        return frame if keys is None else frame.loc[keys]


def build_feature_epoch(history, events, current, cutoff, v1_cfg, v2_cfg, v3_cfg, *, prior_hmodel=None):
    """Build strictly prior-only H1, H2, H3 feature matrices for the current slice."""
    from time import perf_counter

    cutoff = pd.Timestamp(cutoff).normalize()
    if current.empty:
        raise ValueError('Current slice cannot be empty.')
    if current.date.min() < cutoff:
        raise ValueError('Feature cutoff is after a score date.')

    t0 = perf_counter()
    hmodel = prior_hmodel or fit_hierarchical_channel_model(history, events, cutoff, v1_cfg)
    reference = hmodel.base_reference
    bank = RateBank(tuple(v2_cfg['ratio_banks'][v2_cfg['primary_bank']]))
    fusion_cfg = v2_cfg['frozen']['fusion'][v2_cfg['primary_bank']]
    channel_minimum = v3_cfg['channel']['minimum_exposure']

    tracks = {}
    daily_details = {}
    channel_details = {}
    h1_rows, h2_rows = [], []

    # Pre-index valid non-negative amounts by (date, merchant, channel) for fast channel monetary scoring.
    day_min, day_max = current.date.min(), current.date.max()
    cur_events = events.loc[events.date.between(day_min, day_max) & events.amount.ge(0) & events.amount.notna()]
    events_by_day = {d: grp for d, grp in cur_events.groupby('date', sort=False)}

    for day, group in current.sort_values(KEY_INDEX).groupby('date', sort=True):
        batch = Batch('complete', day)
        details = score_day(group, events, day, batch, reference, v1_cfg)
        ch_day = score_channels(group, day, batch, hmodel.channel_reference, roster=group.merchant_id)
        ch_by_m = {m: grp for m, grp in ch_day.evidence.groupby('merchant_id', sort=False)} if ch_day else {}

        day_ev = events_by_day.get(day)
        ev_by_mc = {}
        if day_ev is not None:
            for (m, c), vals in day_ev.groupby(['merchant_id', 'channel']).amount:
                ev_by_mc[(m, c)] = vals.to_numpy()

        det_by_m = {item['merchant_id']: item for item in details}
        for row in group.itertuples(index=False):
            m = row.merchant_id
            item = det_by_m[m]
            daily_details[day, m] = item
            channel_details[day, m] = ch_by_m.get(m)

            track = tracks.get(m, CountTrack())
            if track.last_day is not None and (day - track.last_day).days != 1:
                track = CountTrack()
            tracks[m], seq_ev = track.step(day, batch, item, reference, bank)

            h1_row = _extract_h1_row(row, item, seq_ev, reference, v1_cfg, fusion_cfg)
            h1_rows.append({'date': day, 'merchant_id': m, **h1_row})
            h2_extra = _extract_h2_extra(row, day, ch_by_m.get(m), ev_by_mc, hmodel, channel_minimum, v1_cfg['seed'])
            h2_rows.append({'date': day, 'merchant_id': m, **h1_row, **h2_extra})

    t_h2 = perf_counter()
    h1_df = keyed(pd.DataFrame(h1_rows))[list(H1_COLUMNS)].astype(float)
    h2_df = keyed(pd.DataFrame(h2_rows))[list(H2_COLUMNS)].astype(float)
    t_h3_start = perf_counter()
    h3_df = _add_h3_temporal_and_interactions(h2_df)[list(H3_COLUMNS)].astype(float)
    t_end = perf_counter()

    timings = {
        'H1_H2_build_ms': 1000.0 * (t_h2 - t0),
        'H3_build_ms': 1000.0 * (t_end - t_h3_start),
        'total_build_ms': 1000.0 * (t_end - t0),
    }
    return V4FeatureEpoch(h1_df, h2_df, h3_df, daily_details, channel_details, hmodel, timings)


def build_feature_matrices(history, events, current, cutoff, v1_cfg, v2_cfg, v3_cfg, *, prior_hmodel=None):
    """Convenience wrapper returning {'H1': df, 'H2': df, 'H3': df} and the epoch."""
    epoch = build_feature_epoch(history, events, current, cutoff, v1_cfg, v2_cfg, v3_cfg, prior_hmodel=prior_hmodel)
    return {'H1': epoch.h1, 'H2': epoch.h2, 'H3': epoch.h3}, epoch
