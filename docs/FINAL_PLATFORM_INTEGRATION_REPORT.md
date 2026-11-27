# Final platform integration report

Branch `final-platform-integration`, built on 27 November 2026 from `main` (`e98cf7d`) plus the latest frontend work, with `origin/backend-integration` (`c7f7586`) merged in. The integration was run and tested on Linux (Fedora, Node.js 22.23, Python 3.12.7). The demo server on port 3000 serves preview run `cbb4e4f7167a4688`, generated from this branch.

## 1. Architecture

Official CSVs → `python -m engine.export` (frozen Probabilistic, Sequential, Collective and Hybrid ML modules in `src/`, replay in `engine/`) → atomically published `runs/<run_id>/snapshot.json`, per-run prediction CSV and `runs/latest.json` → Next.js readers (`web/src/lib/snapshot.ts`, `model.ts`, `api.ts`), read on every request → `/api/v1` routes and pages. The web layer applies filters and view sums only. It contains no competing detector. See [ARCHITECTURE.md](ARCHITECTURE.md) for the contract.

| Name in the interface | Internal ID | Role |
| --- | --- | --- |
| Probabilistic Detection | V1 | Merchant-relative references, intervals, tail probabilities |
| Sequential Detection | V2 | The only source of the official `is_anomaly` and `anomaly_score` |
| Collective Detection | V3 | Advisory warnings shared across merchants, channels or categories |
| Hybrid ML | V4 | Advisory ranking (`C3_rank_fisher`, Isolation Forest H3, 62 features) |

**Assistant.** The HPC language model is the primary assistant. When it is not configured, unreachable, times out or its answer fails the checks, the existing deterministic assistant answers from the same run. That reply is marked `fallback` with the reason, labelled "Built-in answer" in the chat, and a "Fallback mode" bar is shown while the model is down.

**Accounts.** One administrator creates accounts and chooses each account's pages and actions (review, manage, export).

## 2. Git

| Commit | Content |
| --- | --- |
| `cc1b611` | The latest frontend, committed before the merge |
| `efd7591` | Merge of `backend-integration`. 11 conflicts resolved by keeping the latest frontend and the backend's computations |
| `7671908` | Frozen V1–V3 configs restored to their archived CRLF bytes. Without this, a fresh clone cannot export |
| `19052c0` | `verify.mjs` adapted to accounts and preview runs. The assistant's operational tools got real descriptions |
| `f9c3973` | Scientific model names in the interface |
| `efcd970` | Priority queue sorting, impact KPIs, official predictions download, data-quality text |
| `09d8d8a`–`a460308` | Five integration decisions in [DECISION_LOG.md](DECISION_LOG.md) |
| `5abfef4`, `dc9f3ff` | First version of this report and the PR description |
| `98e7731` | Built-in assistant restored as a labelled fallback; amount-range and incident filters |
| `2cf55ac` | Decision log: fallback restored (supersedes the no-fallback entry) |
| latest | README, architecture, handoff and report updated with this round's results |

Nothing was force-pushed. Nothing was committed to `main`.

**Uncommitted teammate edits.** Four files were changed outside this work: `page.tsx`, `globals.css`, `charts.tsx` and `skeletons.tsx`. They re-applied the full-width lower grid on the Overview, which the team had rejected for the two-column layout, and depended on CSS that no longer exists. No other agent session was running to coordinate with. The edits are saved in `git stash` ("teammate: overview full-width lower grid…") and in `.verification/teammate-overview-grid.patch`. They were not committed and not deleted.

## 3. Feature status

| Feature (brief section) | Status | Evidence |
| --- | --- | --- |
| Network dashboard (7.1) | Implemented and verified | KPI totals reconciled with the snapshot. Rates, official anomalies, critical incidents and gross affected activity are one-click KPI cards. A provenance line shows the preview, cutoff and batch |
| Per-account KPIs and formulas | Implemented and verified | Browser test and `node web/src/lib/formula.test.ts` |
| Merchants (7.2) | Implemented and verified | Directory, detail, history, channels, cold-start references, forecast |
| Transaction explorer (7.3) | Implemented and verified | Merchant, date, category, channel, status, quality, contactless and **amount range** (new). The CSV respects the same filters: the 5,000–6,000 DZD range exported 2,141 rows, all within bounds |
| Official anomaly center and B4 (7.4, 7.5) | Implemented and verified | Symptom, severity, **business criticality and incident state** filters (new; 26 high + 6 elevated + 51 resolved = 83 alerts). Explanation text equals the API |
| Incidents and review (7.6) | Implemented and verified | Six actions, stale write gives 409, predictions unchanged after review. Isolated ledger |
| Priority queue (7.7) | Implemented and verified | Engine MCDA rank by default. Sort by severity, impact or duration. Responsible role and first action shown |
| Collective intelligence (7.8) | Implemented and verified | Warnings and detail pages. A run without the module shows "module disabled" |
| Hybrid ML (7.9) | Implemented and verified | Candidates derived from the snapshot |
| Business impact (7.10) | Implemented and verified | Incident detail, PDF and KPI card, labelled "estimate, not a confirmed loss" |
| Forecasting (7.11) | Implemented and verified | Seven points from 14 Nov, 80 % intervals, backtest |
| What-if simulator (7.12) | Implemented and verified as a planning estimator | Duration change alters the estimate. It does not replay the detector |
| Assistant (7.13) | Implemented and verified, model online and offline | See section 5 |
| Reports and PDF (7.14) | Implemented and verified | Daily, weekly, merchant and incident PDFs |
| Exports (7.15) | Implemented and verified | Transaction, anomaly and incident CSVs carry no card fields. The official predictions download is refused (409) from a preview run |
| Data quality (7.16) | Implemented and verified | Cleaning audit, contactless and negative-amount policies, limitations |
| Accounts and access (7.17) | Implemented and verified | See section 6 |
| Official download from a sealed run | Implemented, not verified on Linux | Needs the sealed Windows run |
| Live feed, adjudicated labels, production identity | Not implemented | Outside the archive's scope |

## 4. Official prediction integrity on Linux

| Check | Result |
| --- | --- |
| Frozen V2 configuration SHA-256 | `ae0e8b51…` matches |
| Development replay (280 pairs) | Exact. Digest `9396f846…` |
| Official replay (711 rows) | Same keys and order, all 52 flags identical. 3 scores differ by at most 1.1 × 10⁻¹⁶. Digest `ae79ae90…` instead of `d29398ed…`, with both OpenBLAS and MKL |
| Advisory isolation | CSV byte-identical with Collective Detection and Hybrid ML on or off |
| Serving parity | All 711 API predictions equal the snapshot, before and after the review actions |
| Preview cannot replace the sealed file | `y_pred_anomalies.csv` stayed `4613fbe3…` after the preview publication. `engine.predict` stopped at the sealed check and wrote nothing. A preview with `--predictions` is refused |
| Preview cannot be shown as sealed | `health.sealed_parity` is false. The sidebar and Data page say "Unsealed replay preview". The official download returns 409 and the Data page shows "sealed run only" |

## 5. Assistant: model online and offline

| Case | Result |
| --- | --- |
| HPC tunnel up (`model: online`) | Four questions answered by the model (`source: model`) in 0.7–1.6 s, each with evidence links. The full `verify.mjs` journey passed |
| Model configured but unreachable (`model: offline`) | Answers came from the built-in assistant (`source: rules`, `fallback: model_offline`) with real figures and evidence, for example "263 of 329 contactless events … exceed 2 500 DZD" and "4 open incidents, estimated exposure 800 k DZD". The chat showed "Built-in answer · language model unavailable" and the "Fallback mode" bar. The full journey passed |
| Guards | Write requests refused, card numbers rejected (422), with or without the model |

Observed quality gap: with the model online, two answers were vaguer than the built-in ones ("no single total count" for contactless breaches). The answers are grounded, but the model under-uses the tool output.

## 6. Security checks (restricted account, isolated server)

An account with Overview and Incidents pages and only "Review incidents" sees just those two pages; Admin, Data, Transactions and Reports redirect home. The API refuses exports, PDFs, the assistant and run data with 403. Close and assign are refused with 403. Acknowledge and comment pass the permission check and stop at the version check (409, nothing written). The audit ledger is hidden from this account. Creating and deleting the account were both recorded in the audit trail.

## 7. Tests

| Test | Result |
| --- | --- |
| Backend integration tests (`python -m unittest discover -s tests`) | 7 passed |
| 84 research tests | Not run: not in this repository |
| `npx tsc --noEmit`, `npm run lint`, `npm run build`, `node src/lib/formula.test.ts` | Passed |
| `node scripts/verify.mjs`, model online (copy of run `cbb4e4f7167a4688`) | Passed, run twice (before and after the new filters) |
| `node scripts/verify.mjs`, model unreachable | Passed |

Each `verify.mjs` run covers sign-in, overview and snapshot reconciliation, merchants, transactions, alert explanation, intelligence, incidents, all six review actions with the 409, the simulator, forecasts, assistant, data, four PDFs, the CSVs, widths 1920/1366/820/390 px with no page overflow, and a live run-pointer swap without a rebuild. No browser console errors were reported. Screenshots and PDFs are in `.verification/browser/`, which Git ignores.

## 8. Performance (Linux)

| Measurement | Observed |
| --- | --- |
| Full export into `runs/` | 132.6 s. Snapshot about 12.5 MB |
| Sign-in to dashboard in Chrome | 0.96 s (model online), 1.39 s (offline) |
| API (model online) | health 176 ms on the first call, overview 86 ms, official roster 21 ms, anomalies 25 ms, incidents 31 ms, advisories 31 ms, forecasts 13 ms |
| Assistant | 0.7–1.6 s with the HPC model. The built-in fallback answers immediately once the model times out |

## 9. Reproduce

See the [README](../README.md): the sealed Windows release and the tested Linux preview commands. Sign in as `admin` (password `ADMIN_PASSWORD`, or the one written to `runs/admin-password.txt`). From `web/`:

```bash
RUNS_DIR=/abs/isolated/runs SATIM_TEST_ORIGIN=http://127.0.0.1:3001 \
  SATIM_TEST_PASSWORD=… SATIM_TEST_ALLOW_PREVIEW=1 node scripts/verify.mjs
```

## 10. Remaining limitations

- No live SATIM feed. Forecasts start on 14 November 2026.
- No adjudicated held-out labels. The 93.55 % F1 is a development figure, and the 0.40 episode-precision gate is unverified.
- Exact Linux parity is not established. The official CSV must come from the sealed Windows run.
- The HPC model depends on the SSH tunnel. When it is down, the labelled fallback answers.
- The simulator is a planning estimator. Collective causes are hypotheses. Gross affected activity is not a confirmed loss. The contactless synthetic-data issue remains.
- Accounts are local, with no production SATIM identity. The assistant is not limited to an account's pages.

## 11. Readiness

The branch is pushed and ready for team review. Do not merge into `main` until the AI team's sealed Windows export reproduces both digests.
