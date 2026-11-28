# Integration decision log

The original research Decision Log remains in the Technocraft research workspace with its retrospective provenance disclosures. The entries below record current integration decisions.

## 2026-11-27 · Keep intraday research and replay in a separate branch

The remote integration head was verified at `4ce5a1c2bf2ee0ca00386b0af8f853f6bf7d41a9` before branching. Add a separately calibrated training-archive replay. Keep the hierarchical probabilistic daily detector with directional CUSUM authoritative for official predictions, and retain collective and hybrid investigation roles. Use timer-driven scoring, per-account SQLite checkpoints and authenticated snapshot polling. Limit behavioural warnings to eligible exposure and label the mode as historical simulation. The sample is small and the short-disruption benchmark has low exposure, so the evidence supports a research workspace only. The implementation commit `88beefc` records its Git author and commit time as `2026-11-27T21:52:20+01:00`.

## 2026-11-27 · Freeze the serving policy

Use archived V2 for the official flag and score, with an October 16 reference cutoff and a separate October 25 reset. Use V3 warnings, V4 ranking and operational domain evidence for investigation. Keep source configuration and input fingerprints. Revisit only if the organizers authorize a new official policy.

## 2026-11-27 · Gate the release by numerical parity

Pinned version numbers alone produced platform-specific floating-point differences. The tested Windows Anaconda SciPy build reproduces both sealed digests exactly. Release CSV publication is gated by those digests. Preview runs can be labelled and served after independently matching the direct local replay. Keep actual differences in verification evidence.

## 2026-11-27 · Separate observed lifecycle and human review

Use Python reference-pinned lifecycle IDs. Acknowledge, comment, assign, escalate, close and reopen remain in the append-only workflow ledger. Historical V2 rows remain signed by their run provenance. The ledger is intended for one local server.

## 2026-11-27 · Restrict scenario arithmetic

The former simulator implemented an independent statistical scorer. The replacement combines Python forecast volume, outcome and value with observed channel-hour shares and user assumptions. It yields planning estimates and cannot write to review, reference or prediction state.

## 2026-11-27 · Administrator-managed accounts instead of fixed roles

Options: four fixed demo roles (analyst, supervisor, reader, administrator) or one administrator who creates accounts. Decision: one administrator creates each account and ticks the pages it sees and three action groups (review incidents, manage incidents, export). The proxy checks every page and API call; routes re-check each write and export. Passwords are scrypt hashes, five failures lock a username for a minute, and editing an account revokes its sessions. Evidence: SATIM teams differ in what they need to see; fixed roles could not express it. Would change our mind: integration with SATIM's own directory (SSO), which this local scheme does not replace.

## 2026-11-27 · An error instead of a rule-based assistant answer

Options: answer with the deterministic rules when the language model is missing, slow or rejected, or return an explicit error. Decision: the API returns 503 (model_off, model_offline, model_rejected) and the chat says so. Guard refusals (intent, card data, write actions) still answer, since they state no figures. Evidence: rules phrased for this dataset can state wrong figures once the data changes; an operator is better served by no answer than a false one. Would change our mind: rules that are regenerated and verified with every published run.

## 2026-11-27 · User-defined KPIs by formula

Options: a fixed set of overview cards, or cards each account chooses. Decision: every account picks its cards, chart type and order, and can define a KPI as a formula over named measures computed by the engine (for example declined / transactions). Formulas are parsed into a tree and evaluated, never run as code, and validated again on the server. Evidence: analysts track different indicators; a formula keeps every value traceable to engine measures. Would change our mind: a need for functions over time windows, which the formula language does not offer.

## 2026-11-27 · Store the frozen configs with their archived bytes

The replay fingerprints the V1–V3 configuration files byte for byte, and the recorded digests (including the frozen V2 ae0e8b51…) are those of the CRLF files. The branch had committed LF copies, so a fresh clone refused to export on every platform. Decision: commit the CRLF bytes, which .gitattributes already stores verbatim. No setting changed; the digests now match on checkout.

## 2026-11-27 · Linux serves a labelled preview; the sealed CSV stays the Windows one

On Linux (Python 3.12.7 and the pinned NumPy, SciPy, pandas and scikit-learn from the same conda channel, with OpenBLAS and with MKL) the 280 development pairs reproduce the sealed digest exactly. The 711 official rows keep every key, the order and all 52 flags; 3 scores differ by at most 1.1e-16, so the official digest does not match. Decision: Linux serves a run labelled as an unsealed preview, the app refuses to offer the official download from it, and the committed y_pred_anomalies.csv (SHA-256 4613fbe3…) remains the sealed Windows output. Would change our mind: a Linux runtime that reproduces the official digest.

## 2026-11-27 · Restore the built-in assistant as a labelled fallback

Supersedes "An error instead of a rule-based assistant answer". The team chose demo reliability: the HPC language model stays primary, and when it is not configured, unreachable, times out or its answer fails the checks, the existing deterministic assistant answers from the same published run. Each such reply is marked `fallback` with the reason and labelled "Built-in answer" in the chat, with a "Fallback mode" bar while the model is down, so a built-in answer is never mistaken for the model's. Tested with the model online (answers from the model, 0.7–1.6 s) and with an unreachable endpoint (labelled built-in answers with evidence).

## 2026-11-28 · Future batches continue the official run's sequential state

Imported transaction batches are scored by replaying the frozen detector from the official epoch through the official test period and on through the batch, with the frozen pre-period reference. Earlier imports restarted CUSUM at the batch's first day (verified: 0 of 460 scores changed when history was prepended, because the monitor starts empty at its epoch). Starting at the official epoch changed 15 of 200 early scores and reproduces the 52 official flags in the replayed period. Batches processed one at a time give the same 400 scores as one continuous replay. Dates on or before 13 Nov 2026 are refused; corrections need an explicit replay. The reference is not updated from new days: no reviewed-reference update policy exists in the frozen configuration, and unflagged days are not assumed safe.

## 2026-11-28 · One platform-wide active dataset, chosen by the administrator

Activation writes `runs/active.json`; it is the default for accounts that have not chosen a dataset. An explicit choice, including returning to the SATIM dataset, still wins. Reports, Simulator and the Assistant keep reading the official run, labelled, because their evidence chains (PDF briefs, simulator baselines, assistant tools) are built on it. The sealed submission is never written; imported runs export `operational_predictions_<run_id>.csv`.

## 2026-11-28 · No absolute-value negative-amount policy offered

The brief allows the mentor-confirmed absolute-value policy only where supported. Neither `config/` nor the preprocessing code implements it, so imports keep the archived rule (negative amounts excluded from monetary sums, counted as events) and report the count.

## 2026-11-27 · Require reviewed admission and prospective shadow evaluation

The saved adaptive experiment found fewer false alerts with controlled reference updates, while partial episode quarantine let the Isolation Forest absorb sustained anomalies. Unguarded adaptation reduced Hybrid incident-day recall from 66.67% in the controlled-reference arm to zero. Use explicit supervisor-approved normal labels, whole-episode quarantine and a lead/recovery buffer. Keep reference fitting, model fitting, calibration and reserved shadow observations temporally separate. Keep Directional CUSUM thresholds frozen and pin open incidents across model switches. Promote only after paired prospective evidence and a supervisor decision, with rollback to the prior approved version. Revisit admission and promotion policy only with independent labelled operational evidence. [Verification report](../reports/continuous_learning_results.md)

## 2026-11-28 · One dataset per request, provenance on every output

Reports, PDF briefs, the simulator and the assistant now follow the selected or activated dataset instead of always reading the official run. The run is pinned per request (server components through resolveView, route handlers through withRun) so a report or an answer cannot mix runs. Official-only outputs are bound explicitly: the sealed submission, incident reviews and the frozen development validation curve.

## 2026-11-28 · Forecast vintages are recorded, never reconstructed

A run's forecast is stored once with its own creation time and compared only with observations from complete batches analysed after it. Retrospective expectations are not substituted for forecasts.

## 2026-11-28 · Expected accepted value: forward forecast only; a same-period reference goes to the AI team

The compound frequency–outcome–severity engine provides accepted-value forecasts (mean and 80/90/95 % intervals) per merchant and for the network from a dated origin. They are used where they are valid: forecast panels and the vintage comparison (accepted value MAE and coverage). It provides no same-period expectation for an arbitrary observed window, and count × median ticket is not a mean. A contemporaneous expected-accepted-value reference is a new statistical element: requested from the AI team, not built in the web layer.

## 2026-11-28 · Negative amounts: the mentor policy stays an opt-in audit candidate

`src/data/mentor_rules.py` (`satim-mentor-domain-v1`, used by `src/operations/mentor_backend.py`) already implements the confirmed absolute-value correction, for every status, with `reference_events` handling contactless severities. It is not enabled for imports: the scope (whether refunds and cancellations are corrected) and the use of the same representation for the frozen reference history are not verified, and the archived official policy must stay unchanged. Enabling it needs the AI team to confirm both and to version a reference fitted with the same representation.

## 2026-11-28 · Live closure enrichment not integrated

The live daily closure runs its own frozen IncidentMonitor with a replay-window reference. Collective and Hybrid enrichment would need a channel reference, scan calibration and feature epochs per replay window: new orchestration of the research code, so it is left to the research owner. Sustained monetary alerts and sequential outcome monitoring remain documented limitations.

## 2026-11-28 · Continuous learning integrated through a thin adapter

The AI team's LearningService is used unchanged. Roles come from the account store (administrator or `supervise`: supervisor; `label`: reviewer), never from the browser; grants are fleet-wide because accounts have no merchant scope. Complete imports feed the ledger automatically once the baseline exists, and the active operational model scores subsequent imports with carried sequential state. The proposed batch-level reference update policy was not implemented.

## 2026-11-27 · Assistant model: self-hosted Gemma 4 26B, not a hosted API

Options: eleven open models served on the team's HPC GPU slice, or the hosted DeepSeek V4 Pro and V4.1 Flash APIs. Decision: Gemma 4 26B A4B (FP8, vLLM), self-hosted and reached through an SSH tunnel. Evidence (`llm-benchmark/REPORT.md`, raw results in `llm-benchmark/raw/`): on 56 questions in English, French and Darija it answered 51 fully correct, used no prohibited term in any run and took 0.75 s median, 1.25 s worst case. DeepSeek V4 Pro routed slightly better (53/56) but took 5–7 s typically and up to 19.6 s, quoted a prohibited term once, and would send engine data to a third party outside Algeria, against SATIM's data-residency and banking-secrecy constraints and offline evaluation. DeepSeek V4.1 Flash confirmed an allegation in Darija instead of declining. Jais 3 32B, Nemotron 3 Nano and Ministral 3 14B invented figures or merchant IDs. Would change our mind: a SATIM-approved in-country inference service with equal accuracy and no prohibited terms, or a self-hosted model that matches V4 Pro's routing at similar latency. The benchmark was committed in `cc1b611` (2026-11-27 18:41 +01:00); this entry records it in the log afterwards.

## 2026-11-27 · The assistant never computes a figure

Options: let the language model read the snapshot and answer freely, or restrict it to choosing tools. Decision: the model only picks from an allowlist of read-only query functions; the backend runs them with the engine's published data and the model rephrases the result. An output check rejects any answer containing a number that is not in the tool results or the question, and any prohibited term; a rejected or failed answer falls back to the labelled built-in answer (see "Restore the built-in assistant as a labelled fallback"). Since `7768e44` (2026-11-28) a `platform_guide` tool answers how-to questions from the same page and control catalogue as the offline guide. Evidence: in the benchmark, models that read data directly invented totals, breakdowns and merchant IDs (`ar02`, `dz04`, `dz06`, `b20`); the number check would have caught each. Would change our mind: a verified way to attribute every generated figure to engine evidence without a tool round.

## 2026-11-27 · Refusals run before the model and before any data access

Options: rely on the prompt to decline out-of-scope questions, or refuse deterministically first. Decision: guards in `web/src/lib/assistant.ts` run before any data access or model call. Questions using fraud vocabulary (French, English, Darija and Arabic script), asking for card numbers or masked PANs, or asking for write actions (close, assign, acknowledge, escalate) receive a fixed refusal that states no figures; the assistant is read-only. Evidence: the specification requires honest refusals on "fraud" questions and forbids exposing card data; in the benchmark even strong models repeated a prohibited term while refusing (Gemma 4 31B, Qwen3.8 27B, DeepSeek V4 Pro), and DeepSeek V4.1 Flash confirmed an allegation (`dz08`). Would change our mind: none for card data or writes; the vocabulary list grows whenever a review finds a missed phrasing.

## 2026-11-28 · Company rules are a separate, governed layer, never part of the AI

Options: let analysts adjust detector thresholds, add rules that create alerts in the AI queue, or keep company rules beside the AI. Decision (`323ce48`): administrators build rules on the Rules page from a whitelist of indicators (transaction amount; merchant-day transactions, rejection and cancellation rates, accepted value, typical payment, activity against expected, longest idle hours), operators, AND/OR, scope, persistence and an effective date. A deterministic evaluator runs them; no code or expression is executed, and missing values or zero denominators never match. Rules have versions, activation with a reason and confirmation, archive and rollback as a draft, with every change in the audit ledger. Active rules apply to operational collections only: the competition run is read for previews only, matches are linked to AI alerts for the same merchant and period but never become official flags, labels or training data. Evidence: SATIM teams need their own checks (for example the contactless limit) without changing the validated detector or the sealed predictions; `node web/src/lib/rules.test.ts` passes. Would change our mind: SATIM asking for selected rules to feed the review queue, which would need its own evaluation of false alerts.
