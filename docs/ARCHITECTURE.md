# Runtime architecture and API contract

`engine.export` validates the archive and immutable configuration hashes, prepares closed merchant days, runs the V2 reserved replay and official reset, verifies the sealed digests, and reuses the operational backend for incident state, dispatch, impact and forecasting. V3 scans and V4 evidence are optional. The same prediction frame populates the CSV and the official snapshot array.

Python writes and flushes temporary files in each destination directory, atomically replaces the per-run snapshot and CSV, then replaces `runs/latest.json` as the serving commit point. The prior publication remains readable when generation fails. Next.js checks the pointer and schema on the server, caches the parsed run by identifier, and resolves new requests against the current pointer. Reload an already open tab to see a newly published run.

## Snapshot schema v2

| Field | Meaning |
| --- | --- |
| `schema_version`, `run` | Version, unique run, UTC generation time, data cutoff, declared archive completeness, reference version and last eligible date, model/config/input hashes and parity status |
| `official_predictions` | 711 template-ordered V2 keys with binary flags and full-precision continuous scores |
| `merchant_days` | 2,601 roster rows, even with zero events, daily outcomes, accepted value availability, prior-only expected values, intervals, V2 evidence and model lifecycle. Ordinary dates before the reserved block have observation evidence and no official prediction |
| `network`, `transactions` | Daily counts, outcomes, period coverage and sanitized columnar events. `source_row` is split plus one-based physical CSV line. Exported amount values follow archived V2 |
| `incidents`, `priority_queue` | Model observation, activation and recovery evidence, contextual recommendations, model-backed impact and provisional business criteria |
| `advisories`, `hybrid` | Frozen V3 collective likelihood evidence and the selected V4 advisory score, tail rank and attribution. ML candidate status means the V4 advisory boundary was met on an unflagged V2 day |
| `forecast`, `domain_rules` | Seven days of count, outcome and value predictions, interval levels and backtest evidence, plus transaction-level domain policy and limitations |

Transaction, cancellation and rejection totals use retained recorded events. Refunds are separate events. Attempted value excludes refunds. Accepted value uses accepted events. If any qualifying amount is missing, the period aggregate is unavailable. Gross activity estimates use conditional counterfactuals and suppress incomplete monetary gaps. Dated review records change operator workflow. The release retains the pinned competition reference.

## HTTP routes

All operational endpoints check the signed session of a local account, and the proxy refuses any page or route outside the account's pages (HTTP 403). `GET /api/v1/health` is public and publishes availability metadata only. Error responses include a safe error code and can include a request ID.

| Route under `/api/v1` | Contract |
| --- | --- |
| `GET /health` | Run ID, generation time, historical cutoff, batch and sealed status. HTTP 503 if no compatible run exists |
| `GET /overview` | Computed totals, trend, channel mix and forecast. Optional `from`, `to`, `channel`, `category`, `merchant` |
| `GET /anomalies` | Paginated flagged rows with structured V2 explanations. `scope=official` returns the matching official roster, including unflagged keys |
| `GET /incidents` | Python-derived incident state, compound impact and operational priority with the review ledger overlay |
| `POST /incidents/{id}/review` | `{action, reason, owner?, version}`. Mismatched versions return HTTP 409. Review state and historical detection remain separate |
| `GET /advisories` | Frozen V3 warnings with hypotheses, plus V4-only investigation candidates |
| `GET /forecasts?merchant=` | Seven days from the origin, with interval bounds, optional merchant scope and backtest |
| `POST /assistant` | Questions answered by the local/HPC language model through allowlisted read-only tools, with scoped evidence links and conversations. Guard refusals (intent, card data, writes) never reach the model. When the model is not configured, unreachable, slow or its answer fails the checks, the deterministic assistant answers and the reply carries `fallback` (`model_off`, `model_offline`, `model_rejected`) |
| `GET /assistant/status` | Whether the language model is `online`, `offline` or `off` |
| `PUT /kpis` | The signed-in account's own Overview cards (formulas over engine measures, validated server-side) |
| `GET /export/{transactions,anomalies,incidents,predictions}` | Sanitized CSV. Submission export requires sealed parity |
| `GET /reports/pdf` | Browser-printed daily, weekly, merchant, alert or incident brief. The custom report route uses a report ID and owner scope |

The archived website scorer in `engine/detect.py` and `engine/legacy_export.py` remains available for historical code inspection. The active export, official CSV and web readers all use the packaged `src/` engine.

## Post-deployment learning

A trusted adapter reads successful complete import runs and registers immutable observation revisions in the dedicated learning SQLite store. Expert labels and independent supervisor decisions are append-only. A closed incident action never changes training eligibility. Operational scoring checkpoints preserve Directional CUSUM incident state and immutable pinned references. Each acknowledged activation takes effect at a future closed-batch boundary so historical learning predictions and imported snapshots remain separately reproducible.

An on-demand worker fits the reviewed Hierarchical Probabilistic Detection and channel references, forecasts, and optional 62-feature Isolation Forest refit. It computes rank calibrations on a separate approved period. A predeclared window is reserved before fitting and scores the operational champion and challenger on the same closed merchant-days before expert labels are submitted. Distribution monitoring is advisory. Model activation and rollback are explicit, audited supervisor actions. [Backend contract](CONTINUOUS_LEARNING_API.md)
