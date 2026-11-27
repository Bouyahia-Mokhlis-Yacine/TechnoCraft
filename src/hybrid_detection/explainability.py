"""Operational explainability via V2 symptoms, channel breakdown, and counterfactual ML attribution."""

import numpy as np
import pandas as pd

FEATURE_GROUPS = {
    'count_probabilistic': (
        'count_obs_log', 'count_exp_log', 'count_log_ratio', 'count_std_residual',
        'count_lower_score', 'count_upper_score',
    ),
    'monetary_merchant': (
        'ticket_score', 'ticket_signed_log_dev', 'attempted_value_score', 'accepted_value_score',
        'missing_amount_frac', 'no_valid_amount',
    ),
    'outcomes_merchant': (
        'declines_score', 'decline_std_residual', 'cancellations_score', 'cancel_std_residual',
    ),
    'cusum_sequential': (
        'cusum_drop', 'cusum_surge', 'cusum_drop_persistent', 'cusum_surge_persistent',
        'v1_max_score', 'v2_managed_score',
    ),
    'channel_hierarchy': (
        'ch_count_max_drop_z', 'ch_count_max_surge_z', 'ch_count_max_score', 'ch_inactivity_max_score',
        'ch_comp_max_abs_share_z', 'ch_comp_chi2', 'ch_decline_max_z', 'ch_cancel_max_z',
        'ch_outcome_max_score', 'ch_outcome_gated_score', 'ch_ticket_max_score', 'ch_ticket_max_abs_z',
        'ch_ticket_signed_extreme_z', 'ch_nfc_ticket_z', 'ch_nfc_ticket_score', 'ch_nfc_active',
        'ch_active_count', 'ch_expected_active_count', 'ch_unknown_share',
    ),
    'temporal_context': (
        'temp_v1_mean_3d', 'temp_v1_slope_3d', 'temp_count_z_mean_3d', 'temp_count_z_slope_3d',
        'temp_count_z_mean_7d', 'temp_count_z_std_7d', 'temp_decline_z_mean_3d', 'temp_ticket_abs_z_mean_3d',
        'temp_dev_streak', 'temp_intermittent_7d', 'lag1_count_z', 'lag1_v1_score', 'lag1_ch_drop_z',
    ),
    'multivariate_interactions': (
        'interact_drop_x_decline', 'interact_stable_cnt_x_ticket', 'interact_hidden_channel_drop',
        'interact_decline_x_comp', 'interact_multi_moderate',
    ),
}

FORBIDDEN_WORD = 'fraud'


def explain_v4_row(
    key,
    features_row,
    fit_medians,
    fit_scales,
    daily_detail,
    channel_df,
    ml_model,
    v2_score,
    v2_threshold,
    ml_score,
    ml_rank,
    fused_score,
    fused_threshold,
    v2_flagged,
    v4_flagged,
):
    """Build a structured, non-technical operational explanation for a scored merchant-day."""
    day, merchant = key
    if v2_flagged and v4_flagged:
        source = 'V2+ML Fusion' if ml_rank <= 0.05 else 'V2'
    elif v4_flagged and not v2_flagged:
        source = 'ML / Fusion'
    elif v2_flagged:
        source = 'V2'
    else:
        source = 'Below threshold'

    # Dominant V2 evidence & expected behavior
    dom = daily_detail.get('dominant_detector')
    dom_det = daily_detail['detectors'].get(dom, {}) if dom else {}
    v2_info = {
        'dominant_symptom': daily_detail.get('dominant_symptom'),
        'dominant_detector': dom,
        'observed': dom_det.get('observed'),
        'expected': dom_det.get('expected'),
        'interval': dom_det.get('interval'),
        'v2_score': float(v2_score),
        'v2_threshold': float(v2_threshold),
    }

    # Channel-specific evidence
    ch_highlights = []
    if channel_df is not None and not channel_df.empty:
        for r in channel_df.itertuples(index=False):
            if r.channel == 'unknown' or r.exposure <= 0:
                continue
            top_sc = float(max(r.declines_score, r.cancellations_score))
            if top_sc >= 1.0 or r.declines > r.declines_expected + 2:
                ch_highlights.append({
                    'channel': r.channel,
                    'exposure': int(r.exposure),
                    'declines': int(r.declines),
                    'declines_expected': round(float(r.declines_expected), 2),
                    'cancellations': int(r.cancellations),
                    'outcome_score': round(top_sc, 3),
                })

    # Counterfactual grouped feature perturbation attribution (heuristic, non-causal).
    group_impacts = {}
    base_frame = features_row.to_frame().T
    base_val = float(ml_model.score(base_frame)[0])
    for group_name, cols in FEATURE_GROUPS.items():
        present = [c for c in cols if c in features_row.index]
        if not present:
            continue
        perturbed = base_frame.copy()
        for c in present:
            perturbed[c] = fit_medians[c]
        new_val = float(ml_model.score(perturbed)[0])
        group_impacts[group_name] = float(base_val - new_val)

    # Top individual standardized deviations relative to ordinary fit distribution.
    z_devs = []
    for col in features_row.index:
        sc = max(float(fit_scales.get(col, 1.0)), 1e-6)
        z = (float(features_row[col]) - float(fit_medians.get(col, 0.0))) / sc
        z_devs.append((col, float(features_row[col]), float(fit_medians.get(col, 0.0)), z))
    z_devs.sort(key=lambda item: abs(item[3]), reverse=True)
    top_features = [
        {'feature': col, 'value': round(val, 4), 'ordinary_median': round(med, 4), 'std_dev': round(z, 2)}
        for col, val, med, z in z_devs[:5]
    ]

    top_group = max(group_impacts.items(), key=lambda x: x[1])[0] if group_impacts else 'none'
    summary = (
        f"Merchant {merchant} on {day.date().isoformat()}: decision source {source}. "
        f"Primary symptom: {v2_info['dominant_symptom']}. "
        f"ML anomaly score {ml_score:.3f} (ordinary tail rank {ml_rank:.4f}); "
        f"largest model attribution group: {top_group} (heuristic perturbation, not causal proof)."
    )
    if FORBIDDEN_WORD in summary.lower():
        raise ValueError('Explanation violated operational terminology constraint.')

    return {
        'merchant_id': merchant,
        'date': day.date().isoformat(),
        'v4_flagged': bool(v4_flagged),
        'v2_flagged': bool(v2_flagged),
        'decision_source': source,
        'v2_evidence': v2_info,
        'channel_evidence': ch_highlights,
        'ml_score': float(ml_score),
        'ml_ordinary_rank': float(ml_rank),
        'fused_score': float(fused_score),
        'fused_threshold': float(fused_threshold),
        'group_attributions_heuristic': group_impacts,
        'top_abnormal_features': top_features,
        'attribution_disclaimer': 'Heuristic counterfactual feature perturbation; indicates model association, not causal proof.',
        'summary': summary,
    }
