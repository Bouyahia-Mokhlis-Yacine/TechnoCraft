# SATIM Payment Anomaly Intelligence

The TechnoCraft competition platform replays the supplied historical archive. The Python engine computes one versioned snapshot for the Next.js dashboard, reports and assistant. The same frozen V2 run generates the official 711-row prediction CSV.

## Start the complete platform

From the repository root, with the pinned conda environment (Linux: `satim-sealed-linux`, Windows: the sealed environment):

1. **Engine snapshot.** `python -m engine.export` writes `runs/<run_id>/snapshot.json` and `runs/latest.json` (on Linux add `--allow-unsealed-preview`; see below).
2. **Replay service (optional, for Live Monitoring).** Set `LIVE_MONITORING_TOKEN` and run `python -m src.live_monitoring.service` (details below).
3. **Web app.** In `web/`: `npm ci`, `npm run build`, then `SATIM_PYTHON=<env python> LIVE_MONITORING_TOKEN=<same token> npm start`. `SATIM_PYTHON` is the interpreter used for imports; the first start creates the administrator (password in `runs/admin-password.txt`, owner-only, or `ADMIN_PASSWORD`).
4. Open `http://localhost:3000`. The interface is in French by default; FR / EN is in the header and on the sign-in page.

## Three execution modes, never mixed

| Mode | Data | Where | Can change the official submission? |
| --- | --- | --- | --- |
| Official competition run | Supplied archive, frozen V1–V4 | `runs/<run_id>/`, `runs/latest.json`; sealed on Windows, labelled preview on Linux | It **is** the submission (`y_pred_anomalies.csv`, SHA-256 `4613fbe3…`), produced only by `engine.export` |
| Imported operational data | Future transaction CSVs uploaded in **Data & runs** | `runs/collections/`, `runs/imports/<run_id>/` | Never: separate directory, separate `operational_predictions_<run_id>.csv` |
| Simulated live replay | Training archive replayed on a simulated clock, per account | `runs/live-monitoring/replay.sqlite3` | Never: results are not published as runs |

## Import future transaction data

**Data & runs → Importer des transactions** (administrator):

1. Upload one or more CSV files (template: *Télécharger le modèle* or `GET /api/v1/imports/template`). Required columns: `merchant_id, transaction_date (YYYY-MM-DD HH:MM:SS, Algiers local time), amount, payment_channel, transaction_status, merchant_category`; `masked_pan` is optional and used only to tell exact duplicates apart. It is never stored in results, shown, logged or exported. Allowed channels and statuses are those of `src/data/preprocessing.py`.
2. Each file is validated by the Python engine: blocking errors (missing columns, empty file, unreadable dates, dates inside the history the official run already processed, too many rows or days) are listed beside the file; quality warnings (exact duplicates, missing or negative amounts, unknown or missing channels, unknown statuses, missing categories, contactless payments above 2,500 DZD, new merchants) are handled by the archived preprocessing, never silently.
3. The combined preview shows the period, merchants, rows received, duplicates (within the files and with the destination) and rows ready. Choose **new collection** or **existing collection**, and declare whether the batch is **complete** (absent merchant-days are zero activity) or **partial** (absent days stay unknown; nothing is scored for them).
4. Start. The live status shows the real stages: reading files, validating, cleaning, merchant-day aggregation, frozen reference, Sequential Detection, incidents, collective warnings and forecast, Hybrid ML, saving. It survives a page refresh; a failure keeps the last good version of the collection and offers **Retry**.
5. In **Historique des analyses**, inspect each run and download `operational_predictions_<run_id>.csv` (`merchant_id,date,is_anomaly,anomaly_score`, every scored merchant-day; export permission).
6. To show a run to everyone, open the collection's ⋯ menu → **Activer pour tous** (administrator). Accounts that have not chosen a dataset themselves then see it on Overview, Incidents, Alerts, Merchants, Transactions and Intelligence, without rebuilding. Reports, Simulator and the Assistant keep reading the official run and say so.

**How sequential state is kept.** Every analysis replays the frozen detector from the official epoch (25 Oct 2026) through the official test period and on through the collection's batches in date order, against the frozen pre-period reference (fitted on ordinary history before 17 Oct 2026, never refitted or updated from new days). CUSUM and incident lifecycles therefore continue from the official run, references cannot be contaminated by ongoing incidents, new merchants start from the hierarchical (category) Gamma–Poisson reference, and processing batches one at a time gives exactly the same scores as one continuous replay. A file already in the destination is skipped; dates on or before 13 Nov 2026 are refused rather than rewriting processed history.

## Dataset shown on each page

Every page, report, PDF, simulator view and assistant answer uses the same dataset: the operator's own choice (dataset menu), else the platform's activated run, else the official SATIM run. Reports and PDFs carry a **Dataset** line; assistant answers end with a provenance line. The sealed submission download and incident reviews always use the official run.

## Forecast history

**Data & runs → Historique des prévisions** keeps every published run's 7-day forecast as an immutable vintage (creation time, origin, targets, model and reference versions, intervals) and compares it with merchant-days observed later in complete imported batches: MAE and the share of actual values inside the 80 % and 90 % intervals, for transactions, accepted value and rejections. Nothing is forecast after the fact.

## Controlled learning

The AI team's backend (`src/continuous_learning`, `docs/CONTINUOUS_LEARNING_API.md`) is reached through `engine/learning_bridge.py` and the **Apprentissage contrôlé** page (`/learning`). Give accounts the **Expert labelling** and **Supervise learning** actions in **Comptes**; the administrator is a supervisor.

1. A supervisor initialises the operational baseline (packaged from the archived ordinary model; runs in the background).
2. From then on, every successful **complete** import is ingested into the learning ledger and each new date is scored in order by the model scheduled for it (CUSUM state and pinned incident references carried over); its `operational_predictions_<run_id>.csv` comes from that model. Partial imports and dates before 14 Nov 2026 or in the future stay out.
3. Reviewers label queued merchant-days; a different supervisor approves or rejects. Unflagged or closed days are never treated as verified normal.
4. A supervisor registers a learning job (fit, calibration and evaluation windows), runs it, shadow-scores the evaluation dates prospectively, compares it with the champion and activates it only when the service's gate passes. Rollback restores the previous model from the next unscored date.

## Assistant mascot

The assistant is the SATIM 3D mascot (`web/public/brand/satim-assistant.glb`, rendered with three.js, bundled locally). Its states follow the chat: idle, wave, thinking, typing and sleeping come from the model's own animations; listening, success and error are generated in `web/src/components/mascot.tsx` from the same nodes. Message avatars use a still render (`assistant-mascot.png`). Reduced motion shows a still pose; without WebGL the still image is shown.

## Run the Live Monitoring workspace

Use the project's Python and Node environments and an existing published platform snapshot. The replay service reads the training archive and serves isolated simulations. The frozen daily detector remains authoritative for the official competition submission.

1. Generate a local shared token in PowerShell with `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`. Set the same value as `LIVE_MONITORING_TOKEN` in both service terminals. Keep the token server-side.
2. From the repository root, run `python -m src.live_monitoring.service`. It listens on `127.0.0.1:8765` and checkpoints to `runs/live-monitoring/replay.sqlite3`. Use `--state` to isolate verification or demonstration state.
3. In the second terminal, change into `web` and run `npm run dev` (or `npm start` after a build), with the same `LIVE_MONITORING_TOKEN`. If the Python port is different, set `LIVE_MONITORING_URL` to its loopback address before starting Next.js.
4. Sign in and open **Live Monitoring** (*Surveillance en direct* in French). The page states its held-out results (read from `reports/live_monitoring/`) and what is not implemented yet. Choose a start and end date from 22 September through 24 October 2026, up to seven consecutive dates. The administrator can grant the **Live Monitoring** page and **Control live replay** action independently. Each account has its own replay.

**Simulated Live Monitoring — Historical Replay** advances on the archive clock. It uses no production feed. Set both dates to **15 October 2026** and choose *POS interruption with same-day backlog* to inspect a warning that opened before daily closure. The synthetic truth panel records the injected change separately from detector output. Sparse scopes may show little or no early-warning evidence.

The [research report](reports/live_monitoring_results.md) describes calibration, reproduction commands, independent validation, and current limitations. [Runtime architecture](docs/ARCHITECTURE.md#simulated-live-monitoring) describes the control and recovery contract.

## Run the sealed competition build

Use **Python 3.12** and **Node.js 20.9 or newer**. The exact archive was reproduced on Windows x64 with the SciPy build pinned in `environment.sealed-win.yml`. Run from this repository root in a Conda-enabled PowerShell.

```powershell
$env:PYTHONNOUSERSITE = '1'
conda env create -f environment.sealed-win.yml
conda activate satim-sealed
python -m engine.export
Set-Location web
npm ci
npm run build
npm start -- --hostname 127.0.0.1
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and sign in as `admin`: its password is `ADMIN_PASSWORD` if set at first start, otherwise it is written to `runs/admin-password.txt`. The administrator creates the other accounts on **Accounts**. With `LLM_URL` set the HPC model answers in the assistant; without it, or when it fails, the built-in deterministic assistant answers and the chat shows "Fallback mode". The export writes `runs/<run_id>/snapshot.json`, a matching per-run prediction CSV, `runs/latest.json` and the root `y_pred_anomalies.csv`. It checks both sealed digests before publishing. A new snapshot is read on the next request without rebuilding the website.

### Linux or a pip-based development environment

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m engine.export --allow-unsealed-preview
cd web
npm ci
npm run build
npm start -- --hostname 127.0.0.1
```

Tested on Linux (Fedora, 27 Nov 2026) with conda, which gives the same package versions as the sealed build:

```bash
conda create -n satim-sealed-linux -c defaults --override-channels python=3.12.7 scipy=1.13.1 pandas=2.2.2 scikit-learn=1.5.1 numpy=1.26.4 pip
conda run -n satim-sealed-linux pip install holidays==0.109 statsmodels==0.14.6
PYTHONNOUSERSITE=1 conda run -n satim-sealed-linux python -m engine.export --allow-unsealed-preview
```

On Linux the 280 development pairs match the sealed digest exactly. The 711 official rows keep every key, the order and all 52 flags, but 3 scores differ by at most 1.1 × 10⁻¹⁶, so the run is published as an **unsealed preview**. A preview never writes `y_pred_anomalies.csv` (`--predictions` is refused, `engine.predict` stops at the sealed check), and the app refuses the official download from it. Regenerate the submission in the sealed Windows environment.

On PowerShell use `python -m venv .venv`, then `./.venv/Scripts/python.exe -m pip install -r requirements.txt` and `./.venv/Scripts/python.exe -m engine.export --allow-unsealed-preview`. The preview option still requires exact local agreement with the direct frozen replay. If either sealed digest differs, the run carries a preview label and the submission file and submission-download endpoint stay gated. Linux sealed parity is unverified. Use the pinned Windows runtime to regenerate the release CSV.

### Inputs and switches

The branch inherits the original competition inputs from the team repository. Use the supplied byte-identical files in the repository root or in an authorized local directory given by `SATIM_DATA_DIR` or `--data-dir`. Keep the exact filenames and line endings. Input and frozen-configuration hashes are checked before scoring. Keep raw transaction inputs, entire snapshots and local review records within the authorized evaluation environment. The submission CSV contains only the four organizer-defined prediction fields.

- `python -m engine.export --no-v3 --no-v4` omits the advisory modules. Either switch can be used independently. The V2 prediction rows remain identical.
- `python -m engine.export --predictions PATH` writes the sealed submission to another path. `python -m engine.predict` is a compatibility alias for the same producer.
- `python -m engine.mentor_audit --split train` runs the separately versioned absolute-value audit. It prints aggregate evidence. Official files and serving forecasts use archived V2 preprocessing.
- `RUNS_DIR` can override the publication and serving directory. Use an absolute path when Python and Next.js start from different working directories. `npm run engine -- [options]` invokes the export from `web/` using the active Conda interpreter, local virtual environment, or `SATIM_PYTHON`.
- `SESSION_SECRET` optionally sets the demo cookie signing key. `PDF_CHROMIUM` optionally points to a local Chrome, Edge or Chromium executable. Without a browser for server-side PDFs, the application opens the print view.
- `LLM_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS` and optional `LLM_CONTRACT_DIR` configure the team's local/HPC assistant. `PDF_ORIGIN` can pin the browser's local origin. See [Web configuration](web/README.md) and [the optional HPC contract](llm/README.md).

See the [integration report](docs/INTEGRATION_REPORT.md), [API and snapshot contract](docs/ARCHITECTURE.md), [model selection](docs/MODEL_SELECTION.md) and [B1–B4 business pack](docs/BUSINESS_TRACEABILITY.md).

## Competition data and submission

## 1. Files Provided at Kickoff

| File | Rows | Period & Contents |
| --- | --- | --- |
| `X_train_transactions.csv` | 24,582 | Transactions, `1 Sep – 24 Oct 2026` (`35` merchants) |
| `y_train_labels.csv` | 1,890 | Daily training labels: `merchant_id, date, is_anomaly, anomaly_type` |
| `X_test_transactions.csv` | 8,790 | Unlabelled test transactions, `25 Oct – 13 Nov 2026` (`20` days) |
| `y_pred_template.csv` | 711 | Unified test submission template (`merchant_id, date, is_anomaly, anomaly_score`) |

Each label describes a **merchant's activity on a calendar day**, not an individual transaction.

**Important:** `X_test_transactions.csv` is unlabelled and may include anomaly patterns, holiday effects, cross-merchant incidents, and newly onboarded merchants that never appear in `y_train_labels.csv`.

## 2. Unified Submission Format (At Code Freeze)

Your final deliverable combines your working platform with your unified test prediction CSV:

1. **Running Web Platform (`D1`–`D4`):** Frontend + backend + integrated AI model (+ any value-add extensions) with a `README` allowing the technical evaluation team to run everything locally without your assistance.
2. **Filled Prediction File (`y_pred_anomalies.csv`):** Copied from `y_pred_template.csv` and populated programmatically by your backend:
   - `merchant_id`, `date`: keep exact template rows (`711` rows) unchanged.
   - `is_anomaly`: `1` if your model flags that merchant-day, else `0`.
   - `anomaly_score`: continuous numeric score (higher = more anomalous; required for ranking evaluation).
3. **Business Pack (`D5`):** `B1`–`B4` + justification of any value-add extensions.

## 3. Rules

- **No hand-edited predictions or test hardcoding:** The IT evaluation team will re-run your backend pipeline on `X_test_transactions.csv` to verify it deterministically reproduces `y_pred_anomalies.csv` and your dashboard results.
- **Official data only:** Do not substitute self-generated datasets.
- **Operational anomalies, not fraud:** Never use "fraud" labels or wording anywhere in the platform.

## Operational continuous learning

The backend can now review complete imported merchant-days, quarantine held episodes and train a separate Hierarchical Probabilistic Detection, Directional CUSUM, Collective Detection and Probabilistic–Isolation Forest Hybrid challenger. It uses a dedicated SQLite registry, independent prospective shadow evaluation and supervisor-controlled activation. See the [backend API contract](docs/CONTINUOUS_LEARNING_API.md) and [verification results](reports/continuous_learning_results.md).

Run the focused synthetic and authorization checks with `python -m unittest discover -s tests -p test_continuous_learning.py`. The sealed export workflow above continues to verify the competition numbers.
