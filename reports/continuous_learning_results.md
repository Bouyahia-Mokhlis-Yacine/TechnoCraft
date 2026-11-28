# SATIM continuous learning verification

## Saved adaptive generalization results

The existing Experiment F covered untouched ordinary observations, a synthetic 35% activity increase and an incident-contamination stress scenario. The saved Isolation Forest Hybrid results show:

- Ordinary false alerts fell from **10.20 to 8.16 per 1,000 merchant-days** with a controlled reference update and fixed Isolation Forest weights.
- For merchants with legitimate volume drift, false alerts fell from **457.14 to 400.00 per 1,000** after a controlled reference update and to **328.57 per 1,000** after the Isolation Forest refit.
- In the contamination stress test, Hybrid incident-day recall was **73.33%** with frozen references and weights, **66.67%** with controlled references and fixed weights, **46.67%** after a refit contaminated by inadequately quarantined tail days, and **0%** under unguarded reference adaptation. The contrast from 66.67% to 0% uses the controlled-reference arm as the comparison. These are incident-day figures from this stress scenario.

The integration reuses this evidence and adds focused synthetic verification. Experiment F was not rerun. The source files are the research workspace’s `reports/hybrid_detection_results.md` and `reports/hybrid_detection/adaptive_generalization.csv`, which are outside the platform branch. The packaged Hybrid configuration records the corresponding design decision. [Hybrid configuration](../config/hybrid_detection.v4.json)

## Synthetic integration checks

All experts, labels and operational cohorts in the integration tests are simulated. The active queue recovered **3 of 3** planted anomalous merchant-days using four reviews. Uniform random selection at the same budget recovered **1.27 on average** over 100 fixed seeds, against its theoretical expectation of 1.2. The signals were intentionally informative in this fixture. That comparison measures behavior on the fixture only.

The tests exercise reference admission, chronological reference/fit/calibration/evaluation separation, episode quarantine, Isolation Forest refitting, random inclusion probabilities, data corrections, drift distances, insufficient support, prospective comparison, rejection, approval, rollback, merchant authorization and privacy. The promotion pathway uses fixed synthetic paired scores to test governance independently of model fit. The model-fit fixture separately scores the 62-feature Probabilistic–Isolation Forest Hybrid and forecast artifacts. It uses 512 monetary resampling draws to keep the fixture small. The frozen reference and forest flagged **27/27** drifted normal merchant-days. The approved update and forest refit flagged **1/27**. Both flagged **3/3** planted anomalous merchant-days. Forecast count MAE fell from **8.58 to 2.76 transactions per merchant-day** across the 30 evaluation rows, including those anomalies. The deliberately large shift affected the fixture fleet. These are paired fixture diagnostics.

A backend smoke test used the real import engine with 36 simulated transactions across six closed merchant-days. The adapter registered all six, then added zero on retry. The archived baseline packaged successfully with 62 features. The operational scorer wrote six predictions across two checkpoints and returned a seven-day forecast.

## Sealed verification

The existing `engine.export` verification passed on the pinned Windows runtime. It reproduced **280 exact development score–flag pairs**, **711 exact official score–flag pairs**, and **52 official flags**. The regenerated CSV matched the committed artifact byte for byte (SHA-256 `4613fbe37e1dd6bf104119943753928733b30e82dca30e6efe07ccd7eaa6ddff`). The release files and verification code are unchanged. The isolated verification output was written under an ignored run directory. [Development parity](../docs/evidence/v2_development_parity.json) · [Official parity](../docs/evidence/v2_official_parity.json)

## Interpretation and scope

Promotion requires a predeclared complete prospective window and census review with adequate positive, negative and persistent episode support. This intentionally makes promotion uncommon when only a small targeted queue has been reviewed. Reviewed-only precision and recall carry no population interpretation when labels were selected actively. Calendar-matched distances are diagnostic effect sizes without hypothesis-test or causal interpretations. Software fixture results do not establish production performance or real expert agreement.

Episode and recovery dates stay quarantined even if a later reviewer describes the change as legitimate. In production, obtain additional complete observations outside the held episode with approved reviews. Live hourly weights are available from the backend for a later live adapter. Managed HTTP transport, worker scheduling and the existing frontend are outside this implementation.
