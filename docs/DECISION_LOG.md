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

