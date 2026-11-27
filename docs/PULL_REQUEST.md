# Final SATIM platform integration

Merges the validated backend (`backend-integration`, `c7f7586`) under the latest frontend. Full details are in [FINAL_PLATFORM_INTEGRATION_REPORT.md](FINAL_PLATFORM_INTEGRATION_REPORT.md).

## What changes

- **Engine:** the frozen Probabilistic, Sequential, Collective and Hybrid ML engine feeds every page through the schema v2 snapshot. The latest design is kept: SATIM identity, dark theme, Overview layout and exploded channel pie.
- **Accounts:** one administrator creates accounts and ticks their pages and actions. This replaces the four fixed roles.
- **KPIs:** each account chooses its Overview KPIs, including formulas over engine measures and one-click suggested rates and impact.
- **Assistant:** answers come only from the language model through read-only tools. Without a verified answer it returns 503, never a rule-based answer.
- **Priority queue:** sorts by business priority, statistical severity, impact or duration, and shows who should act.
- **Interface:** scientific model names replace V1–V4. The Data page adds the official predictions download (sealed runs only) and the contactless and negative-amount policies.
- **Fix:** the frozen configs now use their archived CRLF bytes, so a fresh clone can run the export.

## Verification

- 7 integration tests, TypeScript, ESLint, the production build and the formula self-test pass.
- `verify.mjs` passes in Chrome with zero console errors. It covers API/snapshot parity, review locking (409), PDFs, CSVs, four widths and the live run-pointer swap.
- **Linux parity:** 280/280 development pairs are exact. The 711 official rows keep the same keys, order and 52 flags. 3 scores differ by up to 1.1e-16, so the official digest differs. The committed sealed CSV (`4613fbe3…`) is unchanged.

## Before merging

- Run `python -m engine.export` in the sealed Windows environment and confirm both digests.
- Set the administrator password (`ADMIN_PASSWORD`) and create the team accounts.
- Check the HPC tunnel before the demo: the assistant has no offline answers.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
