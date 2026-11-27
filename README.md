# SATIM Payment Anomaly Intelligence

The TechnoCraft competition platform replays the supplied historical archive. The Python engine computes one versioned snapshot for the Next.js dashboard, reports and assistant. The same frozen V2 run generates the official 711-row prediction CSV.

## Run the Live Monitoring workspace

Use the project's Python and Node environments and an existing published platform snapshot. The replay service reads the training archive and serves isolated simulations. The frozen daily detector remains authoritative for the official competition submission.

1. Generate a local shared token in PowerShell with `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`. Set the same value as `LIVE_MONITORING_TOKEN` in both service terminals. Keep the token server-side.
2. From the repository root, run `python -m src.live_monitoring.service`. It listens on `127.0.0.1:8765` and checkpoints to `runs/live-monitoring/replay.sqlite3`. Use `--state` to isolate verification or demonstration state.
3. In the second terminal, change into `web` and run `npm run dev`. If the Python port is different, set `LIVE_MONITORING_URL` to its loopback address before starting Next.js.
4. Sign in and open **Live Monitoring**. Choose a start and end date from 22 September through 24 October 2026, up to seven consecutive dates. The administrator can grant the **Live Monitoring** page and **Control live replay** action independently. Each account has its own replay.

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
