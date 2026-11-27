# Payment Anomaly Intelligence: web platform

The SATIM × TechnoCraft 2026 operator platform, built to the team SRS (`../SATIM_Platform_SRS.pdf`) as a Next.js 16 + TypeScript app. All data comes from the team's **frozen V2 Python engine** in `../engine/`.

## Run it (clean machine, no internet needed at runtime)

```bash
# 1. engine run (from the repository root): scores the official CSVs and writes a versioned snapshot
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m engine.predict     # y_pred_anomalies.csv (submission)
.venv/bin/python -m engine.export      # runs/<run_id>/snapshot.json + runs/latest.json

# 2. web app
cd web
npm install
npm run build && npm start             # http://localhost:3000
```

### On another machine (no access to the HPC)

Everything runs locally; the HPC model is optional.

- **Needs:** Python 3.11+ and Node.js 20.9+. On Windows use `.venv\Scripts\python` instead of `.venv/bin/python`.
- **Assistant:** leave `LLM_URL` unset (`web/.env.local` is not in the repository). The built-in assistant then answers every question with the same data, evidence links and refusals; free-form phrasing, page interpretation and composed reports need the model.
- **PDF downloads:** printed by a local browser: `PDF_CHROMIUM` if set, else Playwright's Chromium (`npx playwright install chromium`, once, needs internet), else an installed Chrome, Chromium or Edge. With none, *Download PDF* opens the report with the print dialog, where "Save as PDF" gives the same document.
- **Data:** the official CSVs are in the repository root, so steps 1 and 2 above are all it takes.

`npm run engine` re-runs step 1's export from `web/`. Identical inputs and code give the same run ID and byte-identical snapshot. After a new export, rebuild the app (`npm run build`) so the prerendered pages pick it up. `RUNS_DIR` and `SESSION_SECRET` are optional overrides.

## Sign in

The sign-in page offers one demo account per role. Every write and export is checked on the server (FR-05):

| Role | Can |
|---|---|
| Operations analyst | read, comment, acknowledge, export |
| Operations supervisor | the analyst's actions, plus assign, escalate, close, reopen, view the audit ledger |
| Bank / management reader | read and export only |
| Administrator | read, export, view the audit ledger and run metadata |

## Screens

| Route | What it does | SRS |
|---|---|---|
| `/` | Network KPIs (events, accepted value, attempted value, decline rate, merchants with alerts, open incidents), each compared with the prior period of equal length. Also: filters (period, category, channel, merchant), trend against the expected level, channel mix, ranked queue, advisories, 7-day forecast, watchlist | FR-17–20, 36–42 |
| `/incidents`, `/incidents/[id]` | Incidents built from consecutive flagged days. Each has a lifecycle (active, recovering, resolved after two quiet days), review actions with an audit history, and a priority score of 100 × (0.4 I + 0.3 U + 0.2 E + 0.1 A) with its factors shown | FR-26–30, 36–39 |
| `/alerts`, `/alerts/[id]` | Every official V2 flag: explanation in the B4 template, observed vs expected with the normal range, the signals behind it, channels, hours, the suggested check | FR-15, 26 |
| `/intelligence`, `/intelligence/[id]` | Collective channel advisories from the engine's scan, plus collective anomalies from the V3 subset scan (groups of merchants abnormal together, with relative risk and Monte Carlo p-value). Merchant × channel matrix, hypotheses with evidence for and against | FR-31–35 |
| `/merchants`, `/merchants/[id]` | Merchant list, then a merchant's history with expected level, health components, forecast and incidents | FR-21–22, 43 |
| `/transactions` | Sanitized records with filters, sorting and quality flags. Card numbers are never shown | FR-23 |
| `/reports` | Daily operational brief, weekly management brief and merchant health brief; print to PDF and CSV export | FR-48–49 |
| `/simulate` | What-if simulator (outage or decline surge on real volumes, scored with the engine's own tests) and review-cost simulator (user-entered costs against training-period outcomes per threshold) | decision support |
| `/data` | Run ID, policy, input and code digests, cleaning audit, train-period validation, audit ledger | FR-11, NFR-08 |
| `/assistant` | “Ask the dashboard”: read-only questions in English, French and Algerian Darija (Latin or Arabic script), answered by our own model on the HPC when it is reachable, otherwise by the built-in rules. Each answer gives the scope, dates and denominators, with evidence links | FR-45–47 |

## API (`/api/v1`, JSON, session cookie required except `/health`)

- **Assistant** (`POST`): `assistant` takes `{ question }` and returns `{ text, table?, evidence, scope, refused?, source }`; `source` is `model` or `rules`.
- **Read endpoints** (`GET`): `overview`, `anomalies`, `incidents`, `advisories`, `forecasts`, `runs`, `health`.
- **Exports** (`GET`): `export/{transactions|anomalies|incidents}` returns sanitized CSV of the current filter scope. Each export is logged.
- **Review actions** (`POST`): `incidents/{id}/review` takes `{ action, reason, owner?, version }`. Error responses:
  - 401 when not signed in
  - 403 when the role isn't allowed
  - 409 when the incident changed since you loaded it
  - 422 for an invalid transition or a missing reason

  Errors carry a safe code, message and request ID, never a stack trace.

## Where things live

```
engine/export.py          the snapshot writer (reuses predict.score_all(), so UI = submission)
web/src/lib/snapshot.ts   loads runs/latest.json
web/src/lib/model.ts      types, severity, explanations, incidents, exposure, advisories (read-only)
web/src/lib/api.ts        page contract: overview, queue ranking, merchants, transactions, briefs
web/src/lib/reviews.ts    append-only review ledger (runs/reviews.jsonl); never touches flags or scores
web/src/lib/session.ts    signed session cookie, roles and permissions
```

## Known limits

- **Demo accounts:** sign-in uses role-picker demo accounts, not passwords. Production needs real identity and a security review (NFR-02).
- **Reviews are single-node:** the ledger is a local JSONL file, which is fine for one demo laptop.
- **Not built:**
  - FR-35, linking incidents into review groups. Advisory links are shown instead.
- **Cleaning differs from the SRS:** the engine sign-corrects negative amounts, while the SRS proposes excluding them. Both counts are disclosed on `/data`, so the team should settle it in the Decision Log.

## Assistant design (FR-45–47)

- **Deterministic and local.** `src/lib/assistant.ts` maps each question to one of a fixed set of queries over the snapshot: shortfall, declines, channels, incidents, forecast, summary, merchant explanation, health and next check. It makes no external call and needs no language model, and no free-form query ever reaches the data.
- **Refusals.** It refuses questions about intent or legality, any request for card data, and any write action (it is read-only). For "what caused…" questions it shows the evidence and states that the cause is not confirmed, listing the data needed to confirm it.
- **Language model (optional).** `src/lib/llm.ts` connects the assistant to Gemma 4 26B served on our HPC slice (contract and start-up: `../llm/README.md`). Set `LLM_URL` in `web/.env.local` (see `.env.example`) and open the tunnel with `../llm/tunnel.sh`. Order for every question:
  1. The rules' guards run first. Intent/legality, card-data and write requests are refused and never reach the model.
  2. The model sees the earlier turns of the conversation (last 6 questions and answers) and calls tools (at most 4 rounds, 8 s in all). The 9 benchmarked tools (`llm/contract/tools.json`) run the deterministic assistant above; 9 app tools (`src/lib/assistant-tools.ts`) add day detail, incident detail, alerts, merchant comparison, what-if simulation (same code as the Simulator page, `src/lib/simulate.ts`), collective anomalies, engine quality, PDF reports and CSV exports. Every number still comes from the engine; arguments are allowlisted.
  3. The answer is checked: no prohibited term, and every number must appear in the tool results, the question or the earlier (already checked) turns. Rounding a k/M amount is accepted; anything else is sent back once to be restated with the exact figures. The evidence links, table and scope line come from the tools, in the user's language.
  4. If the model is unset, unreachable, slow or rejected (or, on a first question, asks a clarifying question the rules can answer), the rules answer instead. The app keeps working offline.
- **Saved conversations.** Every turn is stored in `runs/conversations/<id>.json` (runtime state, owned by the signed-in account). The assistant page has a history rail (a drawer under 900 px): new conversation, open, delete with a confirm step, and a fold button that collapses it to the left (remembered in the `pai-rail` cookie, so the page renders folded without a jump); `/assistant?c=<id>` opens one directly. API: `GET /api/v1/assistant/conversations`, `GET|PATCH|DELETE /api/v1/assistant/conversations/{id}`; `POST /api/v1/assistant` takes `conversation_id`.
- **Filters follow the URL.** `FilterForm` is keyed by the query string, so a chart click, Back or a link rebuilds it and every field shows the filter actually applied. The overview's channel filter takes several channels (`channel=A,B`, comma-separated; also understood by the alerts and transactions lists). The Channels pie keeps every channel visible and dims the ones outside the filter: click a slice for only that channel, Ctrl / ⌘ / Shift-click or tick a legend row to add or remove one, and "All channels ×" clears it; the Channel field shows "N channels selected".
- **Assistant on every page.** `components/assistant-dock.tsx` (mounted in the app layout, hidden on `/assistant`): a round button bottom-right opens a panel over the page (full screen on phones, Esc closes). Each question carries the current path and query; the server rebuilds that page's figures with `lib/page-context.ts` (one describer per page, panel names as on screen) and offers them to the model as the `page_context` tool, with a system line naming the page and its panels. Page-specific suggestions; the conversation follows the user across pages (the panel lives in the layout), is saved like any other with the page each question came from ("asked on …" on the full page), and opens on `/assistant` from the panel's expand button. Without the model, a question about "this chart/page" gets the page's deterministic summary. If a page's panels change, update its describer.
- **Movable panel, selections.** The panel (380 × 560) is dragged by its header; the position is kept in `localStorage` (`pai-dock-pos`) and a double-click on the header puts it back. Users can attach up to 4 parts of the page to a question (`components/page-select.tsx`): highlighted text gets an "Ask about this" button, and the crosshair in the composer starts pick mode (outline on hover, click to attach, Esc to cancel; links are not followed while picking). Each selection carries its panel title, visible text, chart tooltip and ISO date (`data-date` on chart bars), table row mapped to column names, and in-app links; `lib/selection.ts` validates it on the server and appends it to the question for the model (its figures count as known numbers). The new `day_detail` tool explains one day for a merchant or the network, for a selected bar or row. Selections are stored with the question and shown as chips on it.
- **Reports composed by the assistant.** `compose_report` (`lib/custom-report.ts`) takes a title and up to 12 ordered sections: kpis, activity, channel_mix, alerts (with optional explanations), incidents, incident, merchant, compare, top_declines, shortfall, forecast, network_signals, engine_quality, simulation, and text written by the model. Only the spec is stored (`runs/reports/<id>.json`, per account); every section is filled from the engine when rendered, and text sections are checked so they contain only figures from the data (a text section left empty, or a placeholder, makes the server hand the figures back first). The report page `/reports/<id>` (version chip, Undo, Download PDF) and a preview route without the app shell (`/embed/reports/<id>?v=`) render it with `components/report-document.tsx`. The answer shows a live preview of the version it produced; asking for a change ("drop the forecast", "put the summary first", "translate the titles") calls `compose_report` with `report_id`, which keeps the previous version (`POST /api/v1/reports/<id>/undo`). On the report page the floating assistant edits it in place and the page refreshes. The Reports page lists these reports under "Prepared by the assistant".
- **PDF reports.** `GET /api/v1/reports/pdf?type=daily|weekly|merchant|alerts&date=&merchant=&from=&to=&severity=&channel=` or `?id=<report>` prints the Reports page brief to A4 with headless Chromium (`playwright-core`, the local Playwright browser; `PDF_CHROMIUM` to use another binary). Logged in the audit ledger like CSV exports. The Reports page has four briefs (daily, weekly, merchant, and an Alerts brief for any period / severity / merchant / channel) and a Download PDF button; the assistant's `generate_report` tool links the same file. With no browser on the machine the route sends the user to the report with the print dialog open (`?print=1`).
  When a file is asked for (PDF, report, CSV, export) and the model answers without calling `generate_report` / `export_data`, it is asked once more with that tool imposed (named `tool_choice`); if it still fails, the reply links ready-made PDFs instead of a page summary. Rejections are logged as `[assistant] model answer rejected: …` (set `LLM_DEBUG=1` to log the rejected text).
