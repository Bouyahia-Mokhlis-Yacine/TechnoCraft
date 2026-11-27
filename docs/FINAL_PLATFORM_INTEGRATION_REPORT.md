# Final platform integration report

Branch `final-platform-integration`, built on 27 November 2026 from `main` (`e98cf7d`) plus the uncommitted frontend work, with `origin/backend-integration` (`c7f7586`) merged in. The integration was run and tested on Linux (Fedora, Node.js 22.23, Python 3.12.7).

## 1. Architecture

Official CSVs → `python -m engine.export` (frozen Probabilistic, Sequential, Collective and Hybrid ML modules in `src/`, replay in `engine/`) → atomically published `runs/<run_id>/snapshot.json`, per-run prediction CSV and `runs/latest.json` → Next.js readers (`web/src/lib/snapshot.ts`, `model.ts`, `api.ts`) → `/api/v1` routes and pages. The web layer applies filters and view sums only. It contains no competing detector. See [ARCHITECTURE.md](ARCHITECTURE.md) for the snapshot and API contract.

Scientific names used in the interface:

| Name | Internal ID | Role |
| --- | --- | --- |
| Probabilistic Detection | V1 | Merchant-relative references, intervals, tail probabilities |
| Sequential Detection | V2 | The only source of the official `is_anomaly` and `anomaly_score` |
| Collective Detection | V3 | Advisory warnings shared across merchants, channels or categories |
| Hybrid ML | V4 | Advisory ranking (`C3_rank_fisher`, Isolation Forest H3, 62 features) |

## 2. Git

| Commit | Content |
| --- | --- |
| `cc1b611` | The latest frontend, committed before the merge: SATIM identity, dark theme, accounts, custom KPIs, assistant without a rule fallback |
| `efd7591` | Merge of `backend-integration`. 11 conflicts resolved by keeping the latest frontend and the backend's computations |
| `7671908` | The V1–V3 configs restored to their archived CRLF bytes. As committed on the backend branch, a fresh clone could not export on any platform |
| `19052c0` | `verify.mjs` adapted to accounts and preview runs. The assistant's operational tools were given real descriptions |
| `f9c3973` | Scientific model names in the interface |
| `efcd970` | Priority queue sorting, impact KPIs, official predictions download, data-quality text |
| `09d8d8a` to `a460308` | Five integration decisions in [DECISION_LOG.md](DECISION_LOG.md), one commit each |

Nothing was force-pushed and nothing was committed to `main`.

## 3. Frontend kept and backend reused

**Frontend kept:**
- SATIM visual identity, the light and dark tokens, the two-column Overview and the exploded channel pie.
- Clickable merchant rows, the per-page assistant dock, report composition, skeletons and page transitions.
- The administrator-managed accounts and per-account KPI cards.

**Backend reused as is:**
- Sequential Detection scores, flags, B4 evidence and lifecycle.
- MCDA priority, responsible role and first action.
- Compound impact model, Collective Detection warnings, Hybrid ML candidates and attribution.
- Seven-day forecasts with backtest, domain rules, the cleaning audit and atomic publication.

Two decisions from the team override the backend branch:
- **Accounts:** one administrator creates accounts and chooses each account's pages and actions. This replaces the four fixed demo roles.
- **No rule-based assistant answers:** without a verified model answer, the API returns 503. The backend branch kept a rule fallback, and the team removed it because rules written for this dataset can state wrong figures on new data.

## 4. Feature status

| Feature (brief section) | Status | Evidence |
| --- | --- | --- |
| Network dashboard (7.1) | Implemented and verified | KPI totals reconciled with the snapshot in `verify.mjs`. Rates, official anomalies, critical incidents and gross affected activity are one-click KPI cards. The provenance line shows archive or preview, cutoff and batch |
| Per-account KPIs and formulas | Implemented and verified | Browser test: custom formula, charts, saved per account. `node web/src/lib/formula.test.ts` |
| Merchant directory and detail (7.2) | Implemented and verified | Page journeys in `verify.mjs`, clickable rows checked in Chrome |
| Transaction explorer (7.3) | Implemented and verified | Contactless filter, empty state, sanitized CSV |
| Official anomaly center and B4 (7.4, 7.5) | Implemented and verified | Alert explanation text equals the API explanation. Predictions identical across API and snapshot |
| Incidents and review workflow (7.6) | Implemented and verified | Six actions, stale write gives 409, predictions unchanged after review. Isolated ledger |
| Priority queue (7.7) | Implemented and verified | MCDA rank by default. Sort by severity, impact or duration. Responsible role and first action shown |
| Collective intelligence (7.8) | Implemented and verified | Warnings and detail pages. The run-pointer swap shows "module disabled" |
| Hybrid ML intelligence (7.9) | Implemented and verified | Candidates on Intelligence, count derived from the snapshot |
| Business impact (7.10) | Implemented and verified | Incident detail and PDF (backend). Overview KPI sums open merchant incidents and is labelled "estimate, not a confirmed loss" |
| Seven-day forecasting (7.11) | Implemented and verified | Seven points from the origin, 80 % intervals, backtest |
| What-if simulator (7.12) | Implemented and verified as a planning estimator | Changing the duration changes the result. It does not replay the detector |
| Conversational analyst (7.13) | Implemented and verified with the model online | Six questions answered by the HPC model with evidence. Write requests refused. Card numbers rejected (422). Without the model it returns 503 by design |
| Reports and PDF (7.14) | Implemented and verified | Daily, weekly, merchant and incident PDFs generated |
| Export center (7.15) | Implemented and verified | Transaction, anomaly and incident CSVs with no card fields. Official predictions are downloadable only from a sealed run (409 on a preview) |
| Data quality (7.16) | Implemented and verified | Cleaning audit, contactless and negative-amount policies, cold start, limitations |
| Accounts and access control (7.17) | Implemented and verified | Restricted account: pages outside its list redirect, API returns 403, close and escalate refused. Account changes audited |
| Official prediction download from a sealed run | Implemented but not fully verified | Needs the sealed Windows environment |
| Live feed, adjudicated labels, production identity | Not implemented | Out of scope for the archive |

## 5. Official model parity

| Check | Result on Linux |
| --- | --- |
| Frozen V2 configuration SHA-256 | `ae0e8b51…` matches after the CRLF fix |
| Development replay (280 pairs) | Exact. Digest `9396f846…` matches the sealed value |
| Official replay (711 rows) | Same keys, same template order, all 52 flags identical. 3 scores differ by at most 1.1 × 10⁻¹⁶. Digest `ae79ae90…` instead of `d29398ed…`, with both OpenBLAS and MKL |
| Committed `y_pred_anomalies.csv` | Unchanged sealed Windows output, SHA-256 `4613fbe3…` |
| Advisory isolation | CSV byte-identical with Collective and Hybrid ML on or off (`--no-v3 --no-v4`) |
| Serving parity | All 711 API predictions equal the snapshot, and stay equal after the review actions |

**Exact Linux parity is not established.** Linux serves a run labelled "Unsealed replay preview" and does not offer the official download. Run the release export in the sealed Windows environment.

## 6. Tests

| Test | Result |
| --- | --- |
| `python -m unittest discover -s tests` (integration) | 7 passed |
| 84 research tests | Not run: the suite lives in the separate research workspace, not in this repository |
| `npx tsc --noEmit`, `npm run lint`, `npm run build` | Passed |
| `node web/src/lib/formula.test.ts` | Passed |
| `node web/scripts/verify.mjs` (Chrome, preview run, isolated `RUNS_DIR`) | Passed, with no browser console errors |

The verification also covered the four widths 1920, 1366, 820 and 390 px (no page overflow) and the run-pointer swap, which refreshed the app without a rebuild.

## 7. Screenshots and PDFs

Saved locally in `.verification/browser/`, which Git ignores: `network_overview.png`, `official_v2_explanation.png`, `advisory_intelligence.png`, `overview_mobile_dark.png`, and the daily, weekly, merchant and incident briefs.

## 8. Performance on the Linux machine

| Measurement | Observed |
| --- | --- |
| Full export (Collective and Hybrid ML on) | 127.1 s. Snapshot 12,540,404 bytes |
| Sign-in to dashboard in Chrome | 0.88 s |
| API | health 179 ms (first call), overview 19 ms, official roster 10 ms, anomalies 10 ms, incidents 7 ms, advisories 9 ms, forecasts 10 ms |

## 9. Reproduce

Release (sealed Windows), as in the [README](../README.md):

```powershell
$env:PYTHONNOUSERSITE = '1'
conda env create -f environment.sealed-win.yml; conda activate satim-sealed
python -m engine.export
cd web; npm ci; npm run build; npm start -- --hostname 127.0.0.1
```

Linux preview, as tested here:

```bash
conda create -n satim-sealed-linux -c defaults --override-channels python=3.12.7 scipy=1.13.1 pandas=2.2.2 scikit-learn=1.5.1 numpy=1.26.4 pip
conda run -n satim-sealed-linux pip install holidays==0.109 statsmodels==0.14.6
conda run -n satim-sealed-linux python -m engine.export --allow-unsealed-preview
cd web && npm ci && npm run build && npm start -- --hostname 127.0.0.1
```

Sign in as `admin`. The password is `ADMIN_PASSWORD` if set at first start, otherwise it is written to `runs/admin-password.txt`.

To run the browser test, from `web/`, against an isolated runs folder:

```bash
RUNS_DIR=/abs/runs SATIM_TEST_ORIGIN=http://127.0.0.1:3001 \
  SATIM_TEST_PASSWORD=… SATIM_TEST_ALLOW_PREVIEW=1 node scripts/verify.mjs
```

## 10. Remaining limitations

- No live SATIM feed. The platform replays the supplied archive, and the forecasts start on 14 November 2026.
- No independently adjudicated held-out labels. The 93.55 % F1 is a development result, and the 0.40 episode-precision gate is unverified.
- Exact Linux submission parity is not established. Flags are identical and 3 scores differ in the 17th significant digit.
- The HPC model answered the test questions here, but it depends on the SSH tunnel. Without it the assistant returns errors by design.
- The simulator is a planning estimator. It is not an isolated detector replay.
- Collective causes are investigation hypotheses. Gross affected activity is not a confirmed financial loss.
- The contactless synthetic-data limitation remains.
- Accounts are local and there is no production SATIM identity. The assistant is not limited to an account's pages.

## 11. Pull request

The branch is ready for team review against `main`. It must not be merged without team authorization.
