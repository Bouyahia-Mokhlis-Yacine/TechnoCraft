# B1–B4 business pack

The archive provides merchant, channel, category, outcome and amount evidence. SATIM confirmation is pending for operational roles, escalation preferences, assumed costs, and real merchant entitlements. The local sign-in roles are demonstration accounts. The competition inputs provide no merchant-to-bank ownership mapping.

## B1 · Taxonomy and impact

| Symptom and decision | Operational impact and first action | Product trace |
| --- | --- | --- |
| Activity shortfall or interruption | Assess missing attempts and gross accepted value coverage. Check feed closure, opening schedule and service connectivity. | Alerts and Incidents · `Gauge`, `ImpactEvidence` · `/api/v1/anomalies`, `/api/v1/incidents` · `count_evidence`, `OperationsBackend._replay`, `incident_impact` · V1 weekday and cold-start policy, V2 directional bank and persistence |
| Activity surge or ticket-size shift | Confirm volume or ticket distribution and processing timestamps. Request merchant or authorized acquirer evidence where appropriate. | Alert explanation and Merchant monitoring · `AreaChart`, `NextSteps` · `/api/v1/anomalies` · `amount_evidence`, `positive_ticket_evidence`, `triage.ACTIONS` · V1 resampling seed, exposure and interval settings |
| Rejection or cancellation increase | Compare recorded outcomes at retained-event exposure. Inspect channel mix, retries and response codes. | Alert explanation and Explorer · `GaugeCell`, `FilterForm` · `/api/v1/anomalies`, `/api/v1/export/transactions` · `outcome_evidence`, `channel_evidence` · V1 Empirical Bayes prior and low-exposure threshold |
| Shared operational symptoms | Inspect affected merchants and local corroboration. Request independent service telemetry. | Intelligence and advisory detail · `MerchantTiles`, evidence and hypotheses · `/api/v1/advisories` · `network_scan`, `diagnose` · V3 minimum attributed merchants, local tail and frozen date maxima |
| V4 investigation candidate | Review unusual channel or temporal patterns and check official V2 evidence first. | Intelligence and Alert explanation · `HybridEvidence` · `/api/v1/advisories` · `build_hybrid`, `explain_v4_row` · V4 H3 architecture and archived rank-Fisher boundary |
| Contactless transaction exceeds 2,500 DZD | Verify recorded channel, amount and authorization setting. High breach prevalence is a synthetic-data limitation. | Transactions and Data & runs · `FilterForm`, `Pipeline` · `/api/v1/export/transactions` · `engine.replay.load_split`, `transaction_view` · merchant-day V2 fields have independent provenance |

## B2 · Users and decisions

| User and decision | Product trace |
| --- | --- |
| Supervisor reviews open incidents, assigns responsibility, escalates or closes with evidence | Overview → Incidents → `ReviewPanel` · `GET /api/v1/incidents`, `POST /api/v1/incidents/{id}/review` · `OperationsBackend.queue`, `reviews.applyReview` · evaluated MCDA policy, allowed role and expected review version |
| Monitoring or authorization analyst checks whether abnormal activity requires telemetry or merchant follow-up | Alerts → B4 explanation → Transactions or collective detail · `NextSteps`, `FilterForm` · `/api/v1/anomalies`, `/api/v1/advisories` · `OperationsBackend.explanation`, `diagnose` · frozen V2 and V3 evidence thresholds |
| Management reader reviews workload, activity and uncertainty | Overview, Merchant, Assistant and Reports · `ForecastEvidence`, `ReportHead` · `/api/v1/forecasts`, `/api/v1/assistant`, `/api/v1/reports/pdf` · `seven_day_forecast`, `forecast_view`, archived forecast backtest · seven-day origin and 80%, 90% and 95% ranges |
| Administrator audits data and exports | Data & runs → parity, input digests and audit · `Pipeline`, `HitDots` · `/api/v1/health`, signed export routes · `check_fingerprints`, `validate`, `publish` · complete archive roster and append-only ledger |

## B3 · Value case

The eight-day development block had 31 V2 flagged merchant-days. The archived operational study counted nine distinct review IDs across 31 alerts and one V3 warning. Under an assumed one opening per input and 15 minutes per opening, the case-ID workflow would avoid 23 openings, or 345 minutes. Actual handling times and outcomes remain unavailable.

`OperationsBackend._incident_item` → `incident_impact` → `GET /api/v1/incidents` → `ImpactEvidence` provides expected and observed counts, gross accepted value gaps, excess rejections and predictive uncertainty. Missing qualifying payment amounts withhold the corresponding monetary comparison. `triage.ranked_queue` exposes provisional weights, drivers and recommended roles. Its `expected_cost` output includes conservative, central and high-impact assumptions. The Simulator applies user-entered review and missed-day costs to the fixed development outcome counts and applies hypothetical volume, rejection, value and duration changes to published forecast inputs.

## B4 · Explanation standard

`IncidentMonitor.step_day` supplies the actual underlying V1 evidence. `OperationsBackend._replay` records the stable incident ID, date, indicator, predictive interval, relative deviation, persistent direction, reference support and limitations. `merchant_view` adds the triage action and role. `getAnomaly` exposes the resulting record on the Alert explanation screen and `/api/v1/anomalies`; the incident brief carries that evidence into PDF. Business criticality uses the impact and triage policy, with zero-activity interruptions highlighted for review. Technical causes need independent confirmation. The V2 score describes unusualness and the V4 attribution describes model association.

## Extension decisions

Forecasting supports capacity planning by making the origin, horizon and backtest visible. V3 and V4 support different investigations while preserving official V2 authority. The assistant reads the same snapshot as the dashboard and provides deterministic answers offline. Reports use known scope, preserve archived cutoff and expose the evidence category and data limit beside the result. Review actions update the human ledger, while model lifecycle and evidence remain reproducible.
