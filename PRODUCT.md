# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Shift operators** at SATIM (Algeria's interbank payment switch: CIB cards, e-payment) who watch merchants' payment activity during a shift, triage what is wrong right now and hand it to the right team.
- **Merchant analysts** who investigate one merchant's history over days and weeks to understand what happened and why.
- **The TechnoCraft 2026 jury**, who see a 5-minute live walkthrough and judge whether an operator understands the situation within 10 seconds (spec: "Dashboard UX (10-second clarity)").

Both operators and analysts are first-class. Used both in a monitoring room (large screens, dimmer light, glanced at from a distance, long sessions) and at an office desk (daylight, laptop or monitor).

## Product Purpose

Payment Anomaly Intelligence monitors each merchant's daily payment activity, detects **operational** anomalies (activity drops, interruptions, volume surges, amount spikes, rejection spikes), and explains each one in plain language with the observed value, the merchant's usual value, the main reasons, and a suggested action. Success: an operator goes from "something is wrong" to "I understand what happened, why, and who acts" without technical help.

## Positioning

Every alert is explained against the merchant's own history ("12 transactions against a usual 41"), grounded in the actual data, with who-acts-next guidance. Anomalies are operational incidents, never fraud.

## Operating Context

- Flow: network overview → ranked priority queue → anomaly explanation → merchant history → transaction records.
- Filters (merchant, period, category, channel, status) live in the URL and are shareable.
- Data: synthetic official dataset, 1 Sep – 13 Nov 2026, 36 merchants, ~33k transactions, 5 payment channels (E-commerce CIB/Edahabia, TPE/POS, Mobile App, Contactless/NFC, Bank Transfer). Amounts in DZD. Algerian public holidays matter (1 Nov, Revolution Day).

## Capabilities and Constraints

- Existing Next.js 16 app in `web/`: Overview, Alerts, Alert detail, Merchants, Merchant detail, Transactions. All screens, filters and computed data must be preserved.
- All data comes from the team's frozen V2 Python engine (`engine/`) through a versioned run snapshot (`python -m engine.export` → `runs/<run_id>/snapshot.json`); the web app reads only that snapshot plus the append-only review ledger.
- Team SRS: `SATIM_Platform_SRS.pdf` (FR-01…FR-52). Demo roles: analyst, supervisor, reader, admin (server-enforced).
- Hard rules from the client: the word "fraud" (and synonyms such as suspicious) never appears; card numbers (`masked_pan`) are never shown; every number on screen is computed from data.
- Motion follows `design/animations.html` (one defined animation per action) and `design/DESIGN_RULES.md` §11 budgets.
- Fonts must be self-hosted (data-residency / isolated network).
- Interface language: English for v0; French and Arabic (RTL) are expected later.

## Brand Commitments

- Client: SATIM. The SATIM logo identifies the client. SATIM's palette and the TechnoCraft badge are **not** binding for the visual world (user, 2026-11-26).
- Brand colour: navy #0B2545 (user, 2026-11-27; replaced burgundy so red appears only when something is off).
- Avoid: generic SaaS-template dashboards; alarmist noise (everything red, badges everywhere, constant pulsing); anything slow to read at a glance.

## Evidence on Hand

- Official CSVs at repo root; spec PDF `TECHNOCRAFT_SATIM_Participant_Specification.pdf`.
- SATIM logo: `design/assets/sponsors/satim-logo.png`.
- No real customer names, testimonials or performance claims exist; none may be invented.

## Product Principles

1. Ten-second clarity: what is wrong, where, how bad, who acts.
2. Explain against the merchant's own history, in plain words, with the evidence visible.
3. Calm by default: severity is rare and therefore loud only where it is real.
4. Operational, never accusatory.
5. Everything shown is traceable to computed data.

## Accessibility & Inclusion

WCAG AA contrast; severity never conveyed by colour alone; keyboard navigation for tables and queue; respect reduced motion; future RTL support.
