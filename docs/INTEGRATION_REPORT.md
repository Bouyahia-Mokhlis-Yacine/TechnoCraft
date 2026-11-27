# SATIM integration report

## Architecture and source modules

The shipped producer is `engine/export.py`. It uses the packaged `src/data`, `src/detection`, `src/operations` and `src/hybrid_detection` modules and the archived `config/` files. `engine/replay.py` applies the official roster, checks byte fingerprints and verifies both sealed V2 digests. `engine/hybrid.py` reproduces the selected H3 challenger. `engine/snapshot.py` and `engine/validate.py` serialize and validate a card-free schema v2. `web/src/lib/snapshot.ts` serves the latest published result. The Next.js model and API layer display Python evidence and apply deterministic view filters and aggregations.

The production exporter supersedes the prototype's rounded predictions, sign-corrected amounts, day-type medians, Negative Binomial display intervals, independent collective scan and browser statistical simulator. Active pages use Python V2 explanations and lifecycle, compound forecasting and impact, evaluated MCDA priority, frozen V3 subset evidence and V4 advisory evidence. Operator actions remain in the local append-only ledger. See the [architecture and API contract](ARCHITECTURE.md).

```text
config/          Frozen V1–V4 settings and the opt-in mentor policy
engine/          Replay, adapters, schema, atomic publication and CLI
src/             Validated Python detection and operational modules
web/src/app/     Existing screens and /api/v1 routes
web/src/lib/     Snapshot reader, view calculations and workflow ledger
web/scripts/     Cross-platform Python launcher and Chrome verification
tests/          Snapshot integration tests
docs/           Model, API, B1–B4 and release evidence
```

## Official model parity

| Check | Result |
| --- | --- |
| Frozen V2 configuration SHA-256 | `ae0e8b517a7890223ad3e9a023dea5a275793b54fabf00175ab99400e57c5c59` |
| Reserved development | 280 exact archived pairs. Digest `9396f8464bab86463fa9a36bc14951c4e6b2e8bb175412cfa1ae4dfee94ef0bf` |
| Official inference | 711 template-ordered keys with 52 flags. Digest `d29398ed1d52a78558ddab4e7bfc2eba09849ac46714accd951732cdf476e29b` |
| Submission file | `merchant_id,date,is_anomaly,anomaly_score`. SHA-256 `4613fbe37e1dd6bf104119943753928733b30e82dca30e6efe07ccd7eaa6ddff` |
| Isolation | Sealed advisory-enabled, advisory-disabled and fresh Conda runs produced byte-identical submission files |
| Serving parity | All 711 score–flag pairs compared between snapshot and API. The authenticated prediction CSV download decoded to exactly the same records |

The sealed reference uses ordinary history through 16 October and a fresh official lifecycle epoch on 25 October. Development F1 is 93.55% with 29 true positives, two false positives and two false negatives. Development episode precision is 87.5%. The organizer's 0.40 precision gate applies to the official held-out evaluation.

An isolated pip environment produced the same development flags with 36 managed scores differing by at most 8.88 × 10⁻¹⁶. Its byte-level digests also differed when running the untouched source. A freshly created Windows Conda environment with the pinned SciPy build reproduced both sealed digests and the original research suite passed with the matching runtime. Linux supports the labelled preview workflow. Exact Linux submission reproduction has not been verified.

## Feature verification

| Feature | Status | Evidence |
| --- | --- | --- |
| V2 scoring, official CSV and stable snapshot | Implemented and verified | Sealed 280/711 replay, latest-pointer schema, score/flag/key checks |
| Overview and merchant monitoring | Implemented and verified | Chrome navigation, scoped API and aggregate reconciliation, historical reference support and forecast charts |
| Transaction explorer | Implemented and verified | Actual sanitized rows, source row, contactless filter, empty results, CSV |
| Anomaly center and B4 | Implemented and verified | Complete Python evidence on flagged rows, official alert detail in Chrome |
| V3 intelligence | Implemented and verified | 12 warnings in the sealed run. Browser detail and API warnings with local evidence and hypotheses |
| V4 ML enrichment | Implemented and verified | 62 features, keyed advisory scoring, 17 unflagged V2 investigation candidates, isolation tests |
| Incident lifecycle and operator review | Implemented and verified | Open and historical records, all six workflow actions, stale write HTTP 409, predictions unchanged after review |
| Triage and business impact | Implemented and verified | Python criteria and responsible role, compound impact and uncertainty in Incident detail and PDF |
| Seven-day forecasting | Implemented and verified | Origin on 14 November, seven API points, network and merchant intervals, ordinary-history backtest |
| Simulator | Implemented and verified | Interactive frequency, rejection, amount and duration assumptions. Estimates use published planning values and historical hourly shares |
| Offline conversational analyst | Implemented and verified | Verified summary, hybrid, domain evidence, quality, impact and forecast queries via deterministic answers |
| Optional private HPC assistant | Implemented but not fully verified | Connector retained and extended. This verification used the local fallback |
| Standard reports and CSV | Implemented and verified | Daily, weekly, merchant and incident PDF files generated and inspected. Prediction, anomaly, transaction and incident downloads verified |
| Browser data states and responsive layout | Implemented and verified | Empty explorer and desktop/mobile navigation. Width checks at 1920, 1366, 820 and 390 px. Swapping the run pointer refreshed API results and advisory panels without rebuilding |
| Opt-in mentor audit | Implemented and verified | Test split audit sign-corrected 8 retained values solely within the named candidate |
| Live batch ingestion and organizer sign-off | Not implemented | Scope is the supplied archive. Runtime has no live SATIM feed, production identity or adjudicated held-out labels |

B1 taxonomy and impact, B2 decisions and roles, B3 gross-activity value case and B4 explanation traceability are in the [business pack](BUSINESS_TRACEABILITY.md). The [model selection record](MODEL_SELECTION.md) explains the V4 calendar correction, uncertainty, synthetic workload and contactless limitations.

## Tests and reproduction

- **84 research tests passed** on the archive-matching runtime. The original source suite was run from the parent research workspace.
- **7 integration tests passed** for snapshot and CSV parity, archive fingerprints, card identifier filtering, missing value handling, positive date ordering, advisory isolation and atomic failed-write recovery.
- Next.js TypeScript checks, ESLint and production compilation passed. Chrome completed the authenticated journey and verified the API payloads, review locking, PDFs, CSV and four responsive widths.
- PDF output was readable and text-extractable. Daily and merchant briefs were two pages, weekly was three pages, and the incident brief was two pages.

Follow the [repository README](../README.md) for the sealed Windows runtime or portable preview. Run backend integration tests after generation with `python -m unittest discover -s tests -v`. From `web/`, `node scripts/verify.mjs` tests the local Chrome journey at `http://127.0.0.1:3100`. Use an isolated `RUNS_DIR` for review actions made by the test. Set `SATIM_TEST_ALTERNATE_RUNS` to a verified advisory-disabled run folder to exercise a live pointer update.

Browser evidence is saved locally in `../.verification/browser/`: `network_overview.png`, `official_v2_explanation.png`, `advisory_intelligence.png`, `overview_mobile_dark.png` and the generated example briefs. The snapshots, the local ledger, screenshots and test reports are ignored by Git.

## Performance on the verification machine

| Measurement | Observed |
| --- | --- |
| Full generation on fresh Conda runtime | 149.53 s |
| Snapshot | 12,540,362 bytes (11.96 MiB) |
| V4 features, fit, score, attribution on fresh Conda | 49.69 s, 189 ms, 20 ms, 2.84 s |
| Next.js startup on the final build | 1.14 s |
| Chrome first dashboard journey from sign-in on the final build | 1.97 s |
| Local API requests on the final build | Health 202 ms, overview 307 ms, official roster 16 ms, flagged anomalies 30 ms, incidents 37 ms, advisories 38 ms, forecasts 29 ms |

The forecast backtest uses nine prior ordinary origins. Network count MAE was 17.83 versus 22.57 for seasonal naive, and the nominal 80% interval covered 92.06% of those observations. The archived forecast is historical planning evidence, with conditional independence and limited support for shared shocks. A run contains no independently verified service causes or revenue losses.

## Git and release readiness

The initial fetch verified that both remote branches were at `e98cf7d`. `67acdf4` packages the frozen engine, parity artifacts and schema. `a2ae29a` connects the website, commits the generated sealed submission and includes the verification tools and B1–B4 documentation. The delivery branch is `backend-integration`. The [pull request description](PULL_REQUEST.md) is ready for review against `main`.
