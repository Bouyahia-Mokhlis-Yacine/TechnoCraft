# Handoff: TechnoCraft 2026 · SATIM Payment Anomaly Intelligence (frontend)

Written 2026-11-27. Read this first, then `web/README.md`.

## What the project is
- Hackathon TechnoCraft 2026 (ENSIA × SATIM). Our team owns the **frontend**. Teammates built the Python engine in `engine/` (do not modify their files).
- The spec is `SATIM_Platform_SRS.pdf` (root). The product record is `PRODUCT.md`.
- The app is in `web/`: Next.js 16.4 App Router, React 19, TypeScript, Turbopack, `cacheComponents: true`.

## Run it
```bash
# from repo root (venv already exists at .venv, Python 3.14)
.venv/bin/python -m engine.export        # writes runs/<run_id>/snapshot.json + runs/latest.json
cd web && npm run build && npm start     # http://localhost:3000; sign in as admin (password: ADMIN_PASSWORD or runs/admin-password.txt)
```
- `npm run engine` (in `web/`) re-runs the export. Rebuild after a new export because the alert pages are prerendered.
- Previews were run with `PORT=3100 npm run start` in the background and stopped with `fuser -k 3100/tcp`. The "failed exit code 1" notices that follow are just that kill.

## Hard rules (from the user + SRS) — never break
1. Never use the word "fraud" or synonyms such as "suspicious" anywhere in the UI, the assistant or the docs. Use "operational anomalies" only.
2. Never show `masked_pan` or card numbers. Exports and the assistant must not reach card data.
3. Every number shown is computed from engine data (the snapshot). Never hand-write predictions.
4. Everything runs locally and offline. No payment data goes to third parties: the assistant's model runs on our own HPC slice (required for answers: without it the assistant shows an error, never a rules answer), and fonts are self-hosted.
5. Keep the user's email and personal details out of any external request.

## Architecture (where things live)
- `engine/export.py` (ours): calls `predict.score_all()`, then adds NB intervals, hourly and channel data, advisories (from `detect.channel_incidents`), the forecast with its backtest, validation, and sanitized transactions. It is deterministic: run_id = sha256(input, code, policy). Current run is `7f8b28eb5120`.
- `web/src/lib/snapshot.ts` loads `runs/latest.json` (override with `RUNS_DIR`).
- `web/src/lib/model.ts`: types, severity mapping, B4 explanations, incidents (consecutive flagged days → active / recovering / resolved), and the playbook.
- `web/src/lib/api.ts` is the page contract: overview, ranked queue (SRS priority = 100 × (0.4 I + 0.3 U + 0.2 E + 0.1 A)), merchants, transactions and briefs.
- `web/src/lib/reviews.ts` is an append-only ledger in `runs/reviews.jsonl`. It handles version checks (409), and close/escalate/comment require a reason. Delete the file to reset the demo.
- `web/src/lib/accounts.ts` holds the local accounts (`runs/accounts.json`): one administrator, who creates accounts and ticks their pages and actions (review, manage, export) on `/admin`. Each account also stores its own Overview KPI cards (formulas, `lib/formula.ts`). `web/src/lib/session.ts` signs an HMAC cookie `pai_session` (account id + version); `src/proxy.ts` checks every page and API call against the account's pages.
- `web/src/lib/assistant.ts` is the chat assistant. It is deterministic and allowlisted: EN/FR answers plus Darija keywords, with guards for prohibited, card, write and cause questions. Every answer carries evidence links and a scope line. `web/src/lib/llm.ts` puts the HPC model (Gemma 4 26B, `llm/README.md`) in front of it when `LLM_URL` is set: guards first, the model calls the 9 tools (which run these rules), numbers are checked against tool results, and any failure returns a 503 error (no rules answer: rules written for this dataset may be wrong on new data). Only the guards' refusals come from the rules (`source: "rules"`). The model sees the last 6 turns of the conversation and has 17 tools (9 benchmarked + 8 in `assistant-tools.ts`: incident detail, alerts, compare merchants, what-if simulation, collective anomalies, engine quality, PDF report, CSV export). Conversations are saved per account in `runs/conversations/` with a history rail on the assistant page. PDFs come from `GET /api/v1/reports/pdf` (headless Chromium prints the Reports page). The assistant is also on every page (`assistant-dock.tsx`): questions carry the page, and `lib/page-context.ts` gives the model that page's figures by panel name (keep it in step when a page's panels change). The panel can be dragged, and users can attach selected text or picked elements (chart bars, rows, cards, panels) to a question (`page-select.tsx`, `lib/selection.ts`); `day_detail` explains a selected day. Reports are composed by the model (`compose_report`, `lib/custom-report.ts`): ordered sections filled from engine data, previewed live in the conversation (`/embed/reports/<id>`), edited by asking (versions + Undo), page `/reports/<id>`, PDF `?id=`. Text written by the user or the model (chat paragraphs, question bubbles, composer, history titles, report titles and text) carries `dir="auto"` so Arabic reads right to left; keep it on any new place that shows such text, and use `text-align: start` / `padding-inline-start` rather than left. LaTeX was considered and not used: the structured spec keeps every figure engine-computed and needs no TeX install offline.
- `web/src/components/`:
  - `ui.tsx`: badges, PageHeader, IncidentRow, ExportLink (takes a `label`)
  - `client.tsx`: NavLinks with the gliding pill, SidebarToggle, HeaderActions, FilterForm, ReviewPanel
  - `charts.tsx`: hand-made SVG charts
  - `chat.tsx`
- Design tokens are in `design/tokens.css` (imported via `@design/*`). Motion is in `design/motion.css` and `design/motion.js`. All styles are in `web/src/app/globals.css`; recent overrides are appended at the bottom in dated blocks.

## Current design direction (user's latest decisions, in order — the later ones win)
- **SATIM identity** (2026-11-27): primary colour SATIM red **#E2211C** (scale `--brand-950..50`, from the SATIM emblem) for buttons, active nav, links and hero cards; the user chose red as primary over keeping red for alerts only. Data series, channel and status colours are SATIM charcoal and greys (`--satim-charcoal`), and "normal range" bands stay neutral grey, so charts never read as alarms. The emblem (`web/public/brand/satim-emblem.png`, cropped from the official logo) is the sidebar mark, the favicon (`app/icon.svg`) and the report header mark; the login shows the full bilingual logo. Product name: SATIM · Anomaly Intelligence. Replaced navy #0B2545. Channel colours are SATIM colours too (TPE red, E-commerce charcoal, Mobile grey, Contactless deep red, Transfer light red), assigned with the dataviz validator for the pie's slice order; the channel pie is 3-D with percentage callouts (user request).
- **No shadows anywhere**: every `--shadow-*` is `none`. Surfaces are separated by tone plus a 1px border.
- **Corners are Apple-like and moderate**: 10px on controls, 14px on cards, 18px on chat bubbles. Not square, not pill-heavy.
- **No coloured-background badges or chips.**
  - Severity shows as a coloured dot plus coloured text.
  - Lifecycle, review status, deltas and chips are plain coloured text.
  - Evidence links read "Label ›".
- **No "AI-looking" icon tiles** in list rows. The KPI-card icon tiles were kept because they come from the user's reference design.
- **Dark-mode primary is SATIM red #E2211C**; hero cards are deep red #7A110D.
- **Header is minimal**: role name, theme toggle and sign-out only. The assistant, search and bell buttons were removed because the sidebar already has them.
- **Sidebar folds** into an icon rail. The choice is saved in localStorage `sidebar` and applied before paint by the script in `app/layout.tsx`. The run/data status sits in the sidebar footer.
- **Filters fit on one line** (they wrap below 900px).
- **Design references the user liked**: the green "PinenMFB" sales-report dashboard and the slate inventory dashboard. The user rejected generic SaaS, "AI slop" and alarmist looks.

## Tips / gotchas
- Next 16 rules:
  - Runtime APIs (searchParams, cookies, params) must sit inside `<Suspense>`.
  - Use `connection()` for request-time rendering.
  - `RouteContext<'/x'>` types come from `npx next typegen`.
  - fs paths need a `/*turbopackIgnore: true*/` comment.
- Lint is strict React 19:
  - No `setState` inside an effect; use `useSyncExternalStore` or a lazy init instead.
  - No mutation during render.
- Always run `npx tsc --noEmit && npm run lint && npm run build` before saying something is done. Then check in Chrome at 1366×655 in both light and dark (set `localStorage.theme`).
- The user gives feedback as screenshots and wants a short, plain report afterwards: what changed, what was kept and why, and what's left.
- Design context (product, users, tone) lives in `PRODUCT.md` and `.impeccable/surfaces/`.

## Visual-first pass (2026-11-27)
- Shared visuals live in `web/src/components/visuals.tsx`: `Gauge`/`GaugeCell` (normal range band, expected tick, observed dot), `NextSteps` (owner + numbered checks from `PLAYBOOK[t].steps`), `PriorityStack`, `MerchantTiles`, `RateBars`, `Pipeline`, `HitDots`, `MethodNote` (method text folded behind a "How it's computed" toggle).
- Hero cards show one big number and a gauge; the full B4 sentence stays in an `sr-only` paragraph and in the gauge's aria-label, so screen readers still get it.
- Rule: no page should scroll sideways at 1366px. Check with `scrollWidth` vs `clientWidth` on `.panel`.

## Spacing system (2026-11-27)
- Semantic spacing tokens in `design/tokens.css`: `--page-pad`, `--gutter`, `--card-pad`, `--card-pad-lg`, `--head-gap`, `--item-gap` (rows of one list), `--tile-gap` (tiles inside a card). Breakpoints (1180 / 900 / 640px) retune these tokens instead of overriding each component; see the last block of `globals.css`.
- Table cells use `--cell-x` so cell text lines up with the card's content edge.
- No inline spacing styles in TSX: use `.panel-head.tight` / `.flush` and `.legend.above` / `.below`.
- At 640px and below, the sidebar turns into a top icon bar.
- Check at 1920, 1366, 820 and 390px: no page may scroll sideways.
- Next keeps visited pages mounted but hidden (cacheComponents / Activity). Never style the shared `.content` with `:has()` on one page's elements; scope page layouts to a wrapper of their own, as `.assistant-page` does.

## Decision-support pass (2026-11-27)
- `engine/collective.py` (ours, advisory only; official V2 flags unchanged): counterfactual bounds for each signal that fired, a V3 subset scan (expectation-based Poisson scan, LTSS, 999 Monte Carlo replicas, p ≤ 0.001, at least 2 merchants), a category-level cold-start reference, calibration bands and a value curve per threshold. It is wired into `engine/export.py`; teammates' files are untouched. Current run: `ceefbe13ee8b`.
- `web/src/lib/insights.ts`: the merchant health score (weighted mean of the six components; unknown components are excluded and the coverage is shown), rule-based incident hypotheses, the weekly brief, clusters and the simulator baseline.
- New UI:
  - "What would have been normal" on alert pages
  - Health score on merchant pages and the merchants list
  - "Possible causes" on incident pages (the assistant shows them for cause questions)
  - Collective anomalies on `/intelligence`
  - Weekly brief on `/reports`
  - Calibration chart and known limitations on `/data`
  - `/simulate`
- The simulator mirrors the engine's tests, including incident inheritance. As a check, 40 % declines all day on E-commerce gives an advisory and 15 flagged merchants (the real 5 Nov had 16).
- Still missing: an Arabic UI or Arabic answers (Darija keywords only) and external benchmarking (needs cited sources).

- **Back button** on detail pages (`BackButton` + `NavTracker` in `client.tsx`). It goes up one level in the hierarchy (incident → Incidents, merchant → Merchants…), never through the visit history, and reopens the list with the filters it was last left with (remembered per tab in sessionStorage). Top-level pages have no Back button; the sidebar covers them.
- **The Overview shows stats only.** The priority queue, advisory list and watchlist were removed because they live on their own pages. A "Signals" row keeps the counts and links to them.

- **Page enter/exit**: React `<ViewTransition>` in `components/page-transition.tsx`, used by `template.tsx` in `(app)/` and in `incidents/`, `alerts/`, `merchants/` and `intelligence/` (a template only remounts when its own child segment changes, so detail pages need their section template). The Back button and breadcrumbs pass the `nav-back` type, which slides the other way. Animations are at the end of `globals.css`; the sidebar is anchored and never animates. Don't use `usePathname` in the layout for this: it breaks prerendering outside Suspense.

- **Loading skeletons**: one per page in `web/src/components/skeletons.tsx`. They use the same layout classes as the real page (header, filters, grids, panels, dark hero), sized to the measured panel heights at 1366 px; at that width every block lands within 1–2 px of the real one. When a page's layout changes, update its skeleton too.
- **Header groups**: page actions (Print, Open incident…) and the account block (role, theme, logout) are separated by a gap and a thin divider; on phones the account block takes its own line under the actions. Plain text between chips gets slightly more room than chip-to-chip.

## Open items / known limits
- The pie chart, severity bubbles and chart dots are still round on purpose.
- On alert pages the evidence bullets are English only.
- Not built: FR-35 (incident review groups). Accounts are local (no SSO), and the assistant is not limited to the account's pages.
- Cleaning differs from the SRS: the engine sign-corrects negative amounts, while the SRS excludes them. Both counts are shown on `/data`.
