# SATIM Payment Anomaly Intelligence

The TechnoCraft competition platform replays the supplied historical archive. The Python engine computes one versioned snapshot for the Next.js dashboard, reports and assistant. The same frozen V2 run generates the official 711-row prediction CSV.

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

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and choose a demo role. Leave `LLM_URL` unset for deterministic local answers. The export writes `runs/<run_id>/snapshot.json`, a matching per-run prediction CSV, `runs/latest.json` and the root `y_pred_anomalies.csv`. It checks both sealed digests before publishing. A new snapshot is read on the next request without rebuilding the website.

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
