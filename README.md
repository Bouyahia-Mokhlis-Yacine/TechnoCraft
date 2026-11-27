# Payment Anomaly Intelligence: Data & Submission Guide

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
