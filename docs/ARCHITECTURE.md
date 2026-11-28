# Runtime architecture and API contract

`engine.export` validates the archive and immutable configuration hashes, prepares closed merchant days, runs the V2 reserved replay and official reset, verifies the sealed digests, and reuses the operational backend for incident state, dispatch, impact and forecasting. V3 scans and V4 evidence are optional. The same prediction frame populates the CSV and the official snapshot array.

Python writes and flushes temporary files in each destination directory, atomically replaces the per-run snapshot and CSV, then replaces `runs/latest.json` as the serving commit point. The prior publication remains readable when generation fails. Next.js checks the pointer and schema on the server, caches the parsed run by identifier, and resolves new requests against the current pointer. Reload an already open tab to see a newly published run.

## Simulated Live Monitoring

`src/live_monitoring.archive` verifies the two training fingerprints, applies the existing preprocessing contract and constructs sorted, sanitized event tapes. On a timer the Python service advances through non-overlapping five-minute intervals, including silent intervals. Every committed cursor is a watermark. All historical tape events below a cursor have been consumed. The recorded source clock is rendered without a timezone conversion because its timezone is undocumented. Missing completeness suppresses scoring and puts affected warning state into uncertainty. The historical adapter sorts out-of-order archive rows and deduplicates exact source rows before playback. Corrections arriving after a live-source watermark require a future authorized ingestion adapter.

`detection.Signals` updates hierarchical count exposures, directional CUSUM, integrated interarrival exposure, empirical monetary summaries, Beta–Binomial outcome evidence, and 15-minute collective scans. The selected max score and the separate collective scan threshold are trained on ordinary archive day maxima. `replay.Replay` retains one day of chart points and bounded warning and domain histories. An incident key is scope, symptom and creation time. Repeated high evidence updates the same incident. After a lower recovery boundary holds across three eligible scores the replay resolves it. The collective key groups overlapping evidence by scope and symptom. A shared symptom can support investigation while independent telemetry is needed to confirm its cause.

`service.Controller` checkpoints each account's run parameters, status and finalized cursor in its own SQLite store. On restart an active checkpoint restores in Paused state by deterministic reconstruction from the same input and calibration fingerprints. The service holds at most eight hot sessions. Playback uses monotonic process time only to schedule increments. The scores consume event time exclusively. A simulated midnight closes a checked full day through `IncidentMonitor.step_day` with frozen daily configuration and separate sequential state. Both the daily reference and the intraday reference are fitted on strictly earlier eligible history and remain fixed during a run. A merchant warning may reference an overlapping simulated daily flag. This path writes only the replay database, leaving production snapshots, forecasts, review state and submission output under the existing publication path.

**GET `/api/v1/live`** returns the current account's watermark, data status, bounded history and warning state. Optional `kind`, `name` and `limit` select a chart scope and interval count. One-second polling returns a full recovery snapshot after disconnect or reload. **POST `/api/v1/live`** accepts `start`, `pause`, `resume`, `stop`, `reset`, `step` and `speed` actions. Start requires ISO dates, an allowed speed and a preset. Next.js resolves identity from the existing signed cookie. Requests need the Live Monitoring page permission, and writes also need replay control and a same-origin JSON request. The Python service binds only to loopback and requires the server-held bearer token. The browser receives neither raw events nor the token. The assistant uses the authenticated replay snapshot through its read-only page context tool.

## Imported operational runs

`engine/import_batch.py` (`validate`, `preview`, `analyze`) reuses the archived cleaning (`clean_transactions`), merchant-day aggregation and `OperationsBackend` without changing `src/` or `config/`. A collection is a list of batches (one or more CSV files each, with declared completeness); a run is one analysis of a collection version or of several collections analysed together, in `runs/imports/<run_id>/` (`status.json` polled by the browser, `snapshot.json` validated before an atomic write, `operational_predictions.csv`). The run id derives from the selected collection ids and versions, so unchanged data reuses its result.

Sequential state: the backend starts at the official epoch and replays `test days + batch days` with the frozen ordinary reference; predictions, merchant days, advisories and incidents are kept from the batch's first date (incidents only for the batch's merchants). The replayed test period reproduces the 52 official flags, which the run records under `run.continuation`. V3 advisories and the archived V4 Hybrid ML run on the batch; neither changes V2 flags or scores.

Activation: `runs/active.json` holds the administrator's platform-wide dataset; `lib/dataset.ts` resolves each request from the `pai_view` cookie (an account's own choice, `satim` for an explicit official choice) or else from `active.json`. Pages read `model(view.runId)`; reviews stay on the official run.

## Request-scoped dataset

`lib/run-scope.ts`: `resolveView()` pins the resolved run for the request (React request cache) and `withRun()` scopes route handlers (AsyncLocalStorage). `model()` without an argument reads the pinned run; `model(null)` is the official run. The PDF route pins the run in the printed URL (`?run=`). Explicitly official: `/api/v1/export/predictions`, review writes, the development validation curve.

## Forecast vintages

`lib/forecast-vintages.ts` writes `runs/forecast-vintages/<run_id>.json` once per published run (`wx`, never rewritten), from the immutable snapshot (`run.generated_at`, `forecast.detail`). Evaluation pairs a vintage's per-merchant targets with merchant-days from import runs generated after it whose `batch_status` is complete (latest run wins); unknown accepted values are skipped.

## Continuous learning adapter

`engine/learning_bridge.py` instantiates `LearningService(resolve, directory=RUNS_DIR/continuous_learning)`. `POST /api/v1/learning {method,args}` (whitelisted, page permission checked) spawns it with the session's account id; `run_learning_job` and `initialize_baseline` run detached. `engine.import_batch.learn()` runs after a successful complete import as the in-process worker identity: `ingest_import`, then `score_operational_batch` for unscored dates in order; already scored dates reuse `operational_predictions`.

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

Import and activation routes (administrator unless stated): `POST /api/v1/imports/validate` (multipart, 25 MB), `POST /api/v1/imports/preview`, `POST /api/v1/imports` (409 while another import runs), `GET|POST /api/v1/imports/{id}` (status, retry), `GET /api/v1/imports/{id}/predictions` (export permission), `GET /api/v1/imports/template`, `GET /api/v1/collections`, `POST /api/v1/collections/selection` (any account, its own view), `PATCH /api/v1/collections/{id}` (trash, restore, rename), `POST /api/v1/collections/active` (platform default).


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
