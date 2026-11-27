# Integration decision log

The original research Decision Log remains in the Technocraft research workspace with its retrospective provenance disclosures. The entries below record current integration decisions.

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
