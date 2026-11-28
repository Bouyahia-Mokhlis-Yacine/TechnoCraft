# Handoff: SATIM Payment Anomaly Intelligence (TechnoCraft 2026)

Written 2026-11-27, updated 2026-11-28 (final release candidate) for the next agent working in this directory. Read this first, then:
- [README.md](README.md): run commands, sealed vs Linux preview;
- [web/README.md](web/README.md): accounts, KPIs, import, assistant;
- [docs/FINAL_PLATFORM_INTEGRATION_REPORT.md](docs/FINAL_PLATFORM_INTEGRATION_REPORT.md): what is verified;
- [docs/DECISION_LOG.md](docs/DECISION_LOG.md).

## 1. State right now

**Git**
- Branch: `final-platform-integration`, pushed to `origin`. Final release candidate: tag `rc-final-3` (see below). Development is frozen: only release-blocking fixes.
- No pull request exists yet. The `gh` CLI is not installed; the compare link is in the report.
- Do **not** merge into `main`: the AI team must first regenerate the official `y_pred_anomalies.csv` in the sealed Windows environment.
- **Committed in `cdb9fc5`** (pushed; tested end to end):
  - **Data collections** (replaces the old single-file import panel): `engine/import_batch.py`, `web/src/lib/imports.ts`, `web/src/lib/dataset.ts`, `web/src/app/api/v1/{imports,collections}/`, `web/src/components/{collections,dataset,dataset-client}.tsx`. Multi-file import → one batch; new or existing collection; the original SATIM dataset is an ordinary collection (`satim`: selectable alone or combined, appendable, renamable, trash/restore; its archive files are read in place, never copied or deleted); combined views analysed by the backend (run ID = hash of selected IDs + versions); Trash/restore; selection in the `pai_view` cookie, `?run=` pins an analysis.
  - **French UI (default) + EN**: `web/src/lib/i18n/` (flat dictionaries, `en.ts` is the reference, `fr.ts` must define every key; plurals `_one`/`_other`), `web/src/components/i18n.tsx` (provider, `useT`, FR/EN switch, `pai_lang` cookie). Backend messages carry `code` + `values` (`msg.*` keys). Untyped helpers (`tr`, `tk`, template keys) are not checked by tsc: re-run the key scan in section 5 after adding strings.
  - "Transactions for this alert", red filter bar, `date-range.tsx`, and edits across pages, `globals.css` (dated blocks at the bottom), `web/README.md`, `web/.env.example`.
  - Also in `cdb9fc5`: KPI editor (collapsible cards, unit check, current-state warning, new measures), Intelligence tabs, episode metrics, merchant accepted value over known days, `components/balanced.tsx` (two-column dashboards packed by height).
  - No historical forecast vintages exist in the snapshot, so actual-vs-past-forecast is not shown.
- `git stash@{0}`: a teammate's uncommitted Overview edit (full-width "ov-lower" grid). It conflicts with the user's two-column layout decision and depends on CSS that no longer exists. It is also saved at `.verification/teammate-overview-grid.patch`. Don't apply it without asking the user.

**2026-11-28 (pushed, `f680c8b`)**: Live Monitoring merged (`a314f80`), localised (`00a7306`); future batches continue the official run's sequential state, Hybrid ML on imports, platform-wide activation (`runs/active.json`), `operational_predictions_<run_id>.csv`, run history (`53369f9`); read APIs follow `pai_lang` (`f680c8b`). See README "Import future transaction data" and the integration report table.

**2026-11-28 second pass**: continuous learning merged (`4cf98c0`, from `0805305`); dataset-scoped reports, PDF, simulator and assistant, French live explanations, forecast vintages (`c6086e7`); learning adapter, import feed and `/learning` (`e6bb1eb`). Learning state lives in `runs/continuous_learning/` (private); vintages in `runs/forecast-vintages/`.

**Final release candidate (2026-11-28)**: tag `rc-final-3` on `final-platform-integration` (this documentation commit). Earlier tags stay where they are: `rc-final` (`0aabe94`) and `rc-final-2` (`45b4a5e`, same code as `rc-final-3`, which only adds this handoff and the README tag). Sealed check: `y_pred_anomalies.csv` SHA-256 `4613fbe37e1dd6bf104119943753928733b30e82dca30e6efe07ccd7eaa6ddff` (unchanged by every commit since `rc-final`); run the README section "Verify the release candidate on Windows" on `rc-final-3`. Note: `origin/main` already holds a merge of this branch at `rc-final` (PR #1, `52f79f3`, made from the owner's GitHub account on 2026-11-28 01:55); the later commits are not in `main`. Merge again only after the sealed Windows verification passes on `rc-final-3`.

Since `rc-final`:
- Assistant: SATIM mascot (pointer follow, idle moves, sit, drag and drop), sidebar icon; per-call model timeout inside a 45 s budget; ungrounded figures get one retry with the evidence tool imposed; `platform_guide` tool (`web/src/lib/ui-guide.ts`, self-check `ui-guide.test.ts`): every page, control (EN/FR names), permission and task, offered for how-to questions and selected controls; pick mode attaches buttons, tabs, fields and sidebar links; the assistant API requires the Assistant page and rebuilds context only for pages the account may open.
- Accounts: permission cells with live counts (`components/access-cells.tsx`).
- Collections: the original SATIM dataset is an ordinary collection (`satim`; record `runs/collections/satim/collection.json`, archive read in place, never copied or deleted); selections that include it are analysed from the archive test start (`engine/import_batch.py`, `archive_included`); nothing selected → `/data?empty=1`, data APIs `409 no_dataset`; run history names input collections; import dialog states the resulting scope; audit ledger collapsible.
- Operator UX: Overview "Needs attention" (`components/needs-attention.tsx`) and severity counts; drill-down keeps filters; alert decision facts and "Model details"; advisory linked-incident table; guided 15 Oct live demo with milestones read from the replay; Controlled learning guidance (suggested dates, remembered jobs, blockers explained).

**Running processes**
- Replay service: `python -m src.live_monitoring.service` on 127.0.0.1:8765 (state `runs/live-monitoring/replay.sqlite3`, log `.verification/live-service.log`). Its token is `LIVE_MONITORING_TOKEN` in `web/.env.local` (private, git-ignored); start the service with the same value.
- Demo on port 3000, all interfaces (the team reaches it at `http://10.80.223.212:3000`).
  - Started detached from `web/` with `SATIM_PYTHON=<conda env python> setsid nohup npm start -- -p 3000`. Its log is `.verification/demo-server.log`.
  - It serves preview run `cbb4e4f7167a4688` from `runs/`.
  - After every `npm run build`, restart it: the build replaces `.next` under the running server.
- The HPC model tunnel (`llm/tunnel.sh`) was up during testing. `web/.env.local` sets `LLM_URL`; it is private and in `.gitignore`.

**Credentials (never print, commit or send them)**
- The demo administrator is `admin`. Its password is in `runs/admin-password.txt`, which is owner-only.
- Test servers used `ADMIN_PASSWORD=…` with an isolated `RUNS_DIR`, because the admin is bootstrapped on the first start against an empty `runs/`.
- `Deepseek_key.txt` (repo root, git-ignored) is an API key. Don't touch it or read it into requests.

**Python**
- Use the conda env `satim-sealed-linux` (Python 3.12.7 with the pinned NumPy, SciPy, pandas and scikit-learn, MKL). It is at `/home/mokhlis/miniconda3/envs/satim-sealed-linux/bin/python`.
- Run it with `PYTHONNOUSERSITE=1`.
- The repo `.venv` is Python 3.14 from the old prototype. Don't use it for the engine.

## 2. Architecture

Official CSVs → `python -m engine.export` (frozen V1–V4 in `src/` + `config/`, replay and gates in `engine/`) → `runs/<run_id>/snapshot.json`, the per-run prediction CSV and `runs/latest.json` → Next.js readers → `/api/v1` routes and pages.

**Engine (`engine/`)**
- The engine is the only source of numbers. The web layer filters and sums; it never detects.
- Do **not** modify `src/`, `config/` (frozen; fingerprinted byte for byte, and V1–V3 are stored with CRLF on purpose) or the official exporter logic.
- `engine/import_batch.py` is new and imports the frozen code without changing it.
- Interface names: Probabilistic Detection (V1), Sequential Detection (V2, the only source of the official flag and score), Collective Detection (V3, advisory) and Hybrid ML (V4, advisory). Internal IDs stay `v1`–`v4`.
- The official submission `y_pred_anomalies.csv` is the sealed Windows output (SHA-256 `4613fbe3…`).
  - On Linux, exact parity is **not** reproducible: the 280 development pairs match, all 52 official flags match, but 3 scores differ by 1e-16.
  - So run `--allow-unsealed-preview` on Linux. A preview can never write the submission, and the app refuses the official download for it.

**Web (`web/src/lib/`)**

| File | Role |
| --- | --- |
| `snapshot.ts` | `snapshot(run?)`: the official run from `latest.json`, re-read per request, or an imported run from `runs/imports/<id>/` |
| `model.ts` | `model(run?)` |
| `api.ts` | Page contract. `getMeta`, `listAnomalies`, `getAnomaly`, `listTransactions` and `rankedIncidents` accept a run |
| `reviews.ts` | Append-only ledger `runs/reviews.jsonl`. A version mismatch returns 409. Imported runs get no review overlay |
| `accounts.ts` + `session.ts` + `src/proxy.ts` | One administrator creates accounts (`/admin`) with pages and actions (review, manage, export). Scrypt passwords. The proxy gates every page and API. `can(user, action)`: `import` and `audit` are administrator-only |
| `formula.ts` | Per-account KPI cards: formulas over named measures. Parsed, never evaluated as code. Self-test: `node web/src/lib/formula.test.ts` |
| `llm.ts` + `assistant.ts` | HPC model first. On off, timeout or rejection, the deterministic assistant answers, marked `fallback` and labelled in the chat |
| `imports.ts` | Transaction import: backend validation, detached worker, `status.json` polling, dedup by file SHA plus coverage, retry |

## 3. Hard rules (user + SRS): never break them

1. Never write "fraud" or synonyms such as "suspicious", anywhere. Say "operational anomalies".
2. Never expose `masked_pan` or card numbers in UI, API, logs, exports, snapshots, status files or assistant output.
3. Every number comes from engine evidence. No mock, hand-written or JS-invented statistics.
4. Everything runs locally. No third-party AI or CDNs; fonts are self-hosted.
5. Keep the user's email and personal details out of any external request.
6. Official predictions are immutable from the UI. Reviews, imports, simulations and advisories can't change them.
7. Gross affected activity is "an estimate, not a confirmed loss". Collective causes are hypotheses.

## 4. User decisions (latest wins)

**Layout and look**
- **Overview layout:** two columns. Left: KPIs, Network activity, Signals. Right: Channels, Open incidents, Next 7 days. The user rejected the full-width lower grid.
- **SATIM identity:**
  - SATIM red `#E2211C` is the primary colour, and the dark theme is near-black.
  - No shadows (except popovers), moderate corners and no coloured-background badges.
  - The channel pie is exploded, with percentages inside the slices.
- **Filter bar:** a SATIM red container with white fields and white labels, in both themes. Field text colours are set explicitly. One date-range control (hidden `from`/`to`, inclusive ISO dates), with presets anchored to the run's last date. It wraps on narrow screens.

**Behaviour**
- **Merchants table:** whole rows open the merchant, and the merchant link stays the keyboard route.
- **Assistant fallback:** restored on purpose, after first being removed. Keep it clearly labelled and never write new mock answers.
- **Accounts:** administrator-created, not fixed roles.
- **KPIs:** chosen per account, including formulas and one-click suggestions.

**Working style**
- The user wants a short, plain report after each task: what changed, what was kept and why, what's left, and the checks actually run.
- The user pastes long briefs from teammates. When a brief contradicts an earlier explicit decision of the user's, flag it rather than silently overriding it.

## 5. How to verify

From `web/`:
```bash
npx tsc --noEmit && npm run lint && npm run build && node src/lib/formula.test.ts && node src/lib/ui-guide.test.ts
```
After adding UI text, also check that every `tr('x.y')` / `tk('x.y')` / template key (`stage.${…}`, `measure.${…}`, `kpi.name.${formula}`…) exists in `en.ts` and `fr.ts`: missing keys show the raw key on screen. Isolated test server: copy `runs/latest.json` + the official run into a scratch dir and start with `RUNS_DIR=<dir> ADMIN_PASSWORD=<test> npm start -- -p 3100`.

Backend tests, from the repo root, with the conda python:
```bash
RUNS_DIR=<runs> python -m unittest discover -s tests
```
These 7 tests pass. The 84 research tests aren't in this repo.

**Browser journey (`scripts/verify.mjs`)**
- Run it on an **isolated** copy of the run: it performs review actions.
- Copy `runs/<id>` and `latest.json` into a scratch folder, then start `npx next start -p 3001` with `RUNS_DIR=<copy>`, `ADMIN_PASSWORD=<test pw>` and `SATIM_PYTHON=<conda python>`. Then:
  ```bash
  RUNS_DIR=<copy> SATIM_TEST_ORIGIN=http://127.0.0.1:3001 SATIM_TEST_PASSWORD=<test pw> \
    SATIM_TEST_ALLOW_PREVIEW=1 node scripts/verify.mjs
  ```
- Delete the copy's `reviews.jsonl` between runs: a second pass hits "already acknowledged".
- It covers sign-in, snapshot/API parity, every page, reviews with the 409, PDFs, CSVs, widths 1920/1366/820/390 and the assistant (model or fallback).

**Manual Chrome checks:** 1366 px and 390 px, light and dark. No page may scroll sideways; check with `scrollWidth` against `clientWidth`.

## 6. Gotchas

**Next.js 16 and React**
- Runtime APIs (`searchParams`, `cookies`, `params`) must be read inside `<Suspense>`.
- `currentUser()` calls `connection()`.
- `RouteContext<'/x'>` types come from `npx next typegen`.
- Filesystem paths in server code need `/*turbopackIgnore: true*/`.
- Strict React 19 lint: no `setState` called directly in an effect. Start the fetch in the effect and set state in the `.then` callback, as `import-panel.tsx` does.

**Styles and layout**
- All styles are in `web/src/app/globals.css`, with newer blocks appended at the bottom under dated headings. Tokens are in `design/tokens.css`.
- Next keeps visited pages mounted, so never style `.content` with `:has()` on one page's elements.
- `FilterForm` keeps `?run=` on submit and Reset, and ignores change events from inside `.dr-pop` (the preset select).

**Runs and imports**
- An imported run never moves `runs/latest.json`.
- Run-scoped pages use `?run=<16 hex>`. Incidents, Overview and Reports are official-run only.
- The import worker needs the official CSVs in the repo root, for the frozen reference.
- Batches must start after 16 Oct 2026.

**Engine**
- The engine `src/` was written for Windows. Don't "fix" line endings in `config/`: that breaks the fingerprints.

## 7. Open items and documented limitations

1. **Sealed release:** run the Windows verification on `rc-final-3`; then merge into `main` (the owner decides). No further features: development is frozen.
2. **Teammate stash** (`stash@{0}`, also `.verification/teammate-overview-grid.patch`): not applied; it conflicts with the two-column Overview.
3. **No grouped parent cases:** collective advisories link incidents but each incident is reviewed on its own (a shared case would need new review-ledger storage and actions). No shared root cause is ever claimed.
4. **Reviews** are recorded only when the SATIM collection is shown alone (the review ledger belongs to the archive run); other selections are read-only.
5. **Combined views with SATIM** start at the archive test period (25 Oct 2026); SATIM alone also shows the development period from 1 Sept.
6. **Assistant:** the offline guide text is English only; tool answers cover engine data regardless of the account's pages (page context is restricted); no bank-level scoping (no verified merchant-to-bank mapping).
7. **Controlled learning:** the API cannot list jobs; the job list is the jobs registered from the same browser. Suggested dates are a split of the observed days; the service still enforces eligibility, quarantine and prospective evaluation.
8. **Guided live demo** is one selected synthetic example (15 Oct, POS interruption with same-day backlog), not typical performance; the method note gives the measured limits.
9. **Not built:** Arabic UI/RTL, notifications, production identity (SSO) and live feed ingestion.
10. **Import checks not yet done:** a screen reader on the date picker and files near the 25 MB / 200,000-row limit.
