# Design Rules: SATIM · Payment Anomaly Intelligence

The frontend is an **internal operations tool for SATIM analysts**, not a marketing site. Every rule below serves one goal from the brief: an operator understands *what is wrong, where, and why* within **10 seconds**.

Files:
- `design/tokens.css`: all colors, type, spacing and radii as CSS variables (light + dark). **Never hard-code a hex in components.**
- `design/assets/logo-mark.svg`: product mark and favicon.
- `design/assets/technocraft-badge.svg`: "Built at TechnoCraft 2026" credit badge.
- `design/assets/sponsors/`: official SATIM and CIB logos.
- `design/motion.css` + `design/motion.js`: animation classes and helpers (§11).
- `design/styleguide.html`: live preview of every token and component.
- `design/animations.html`: **motion catalogue**, one live demo + spec (trigger, motion, timing, class) for every user action and system event.
- Serve both pages (`cd design && python3 -m http.server`, then open `localhost:8000/animations.html`) because they load `motion.js` as an ES module, which `file://` blocks.

---

## 1. Identity (researched 26 Nov 2026)

The product is **SATIM's**. TechnoCraft gets a small, deliberate nod; nothing else.

| Source | Identity observed | What we take |
|---|---|---|
| **SATIM** (satim.dz + logo) | Red "S" roundel `#E2211C` (site red `#D50000`), black wordmark `#1D1D1B`, bilingual AR/FR name. Site: white background, true grays (`#323232` text, `#9A9A9A` meta, `#EAEAEA` dividers, `#F8F8F8` sections), dark footer `#121212`/`#171717`, **Gotham** headings (600/700, H1 uppercase), **Open Sans** body, near-square corners, red nav accents. | Everything: ink `#1D1D1B` as primary, true-gray neutrals, near-square radii, Gotham-like headings (Montserrat), Open Sans body, AR + FR support, sober banking tone. Red as a **signature only**. |
| **CIB** (SATIM's card network) | Blue `#005B94` | Link color, main data color, "E-commerce (CIB / Edahabia)" channel. |
| **TechnoCraft 2026** (spec PDF) | Pixel-art world: night `#202028`, gold `#F2B705`, cream `#F0E8D8`, grass `#589828` over dirt `#785030`, Courier Bold type. | **A touch only** (see §12): the pixel-grid logo mark and the "Built at TechnoCraft 2026" badge. |

**Why red is not our primary color:** in an anomaly dashboard, red means *critical*. If the brand red were also used for buttons and headers, every screen would look alarming and real alerts would stop standing out. So SATIM red appears in exactly three places: the logo, the 3px brand bar on top of the app, and the active-nav indicator. Primary actions use SATIM ink.

---

## 2. Color rules

1. **Use semantic tokens** (`--surface`, `--text-secondary`, `--sev-high-bg`…), never raw grays or hexes.
2. **Severity colors are for anomalies only.** Never use them for decoration, buttons or charts that aren't about anomalies.
3. **Never use color alone**: every severity shows **icon + label + color** (color-blind operators, grayscale printouts).
4. **Channel colors are fixed** across every chart, legend and filter chip:

   | Channel | Token |
   |---|---|
   | E-commerce (CIB / Edahabia) | `--ch-ecommerce` |
   | TPE / POS Terminal | `--ch-pos` |
   | Mobile App | `--ch-mobile` |
   | Contactless / NFC | `--ch-contactless` |
   | Bank Transfer / Virement | `--ch-transfer` |
   | *(missing in data)* | `--ch-unknown`, labeled **"Not specified"** |

5. **Merchant categories (7) are not colored.** Show them as sorted single-color bars (`--chart-series`). Seven hues would be unreadable.
6. Status colors (`--st-*`) apply only to transaction-status breakdowns.
7. Contrast: body text ≥ 4.5:1, large text/icons ≥ 3:1. The `-fg` severity tokens on `-bg` tokens meet 4.5:1.
8. Dark mode is supported (`data-theme="dark"`) because operations rooms often run dark screens. Test every screen in both.

## 3. Severity scale (from B1 taxonomy)

| Level | Token | Icon (lucide) | Meaning for the operator |
|---|---|---|---|
| **Critical** | `--sev-critical` | `octagon-alert` | Act now: merchant down or multi-merchant incident |
| **High** | `--sev-high` | `triangle-alert` | Act today: strong deviation, revenue at risk |
| **Medium** | `--sev-medium` | `circle-alert` | Review: clear deviation, limited impact |
| **Low** | `--sev-low` | `info` | Watch: mild or uncertain deviation |
| **Normal / Recovered** | `--sev-normal` | `circle-check` | No action |

Thresholds mapping score → level live in **backend config**, not the UI (traceability to B1). The UI only renders the level the API returns.

## 4. Anomaly types: labels and icons

Raw labels from the data are never shown. Use these:

| Code | UI label (EN) | UI label (FR) | Icon (lucide) | Signal |
|---|---|---|---|---|
| `DROP_VOLUME` | Activity drop | Chute d'activité | `trending-down` | S1 |
| `ATYPICAL_SURGE` | Volume surge | Hausse inhabituelle du volume | `trending-up` | S2 |
| `SPIKE_AMOUNT` | Amount spike | Pic de montants | `banknote` | S2 |
| `SPIKE_DECLINED` | Rejection spike | Hausse des rejets | `ban` | S3 |
| `INTERRUPTION` | Activity interruption | Interruption d'activité | `unplug` | S4 |
| *(model-only)* | Atypical pattern | Comportement atypique | `scan-search` | S5 |
| *(incident group)* | Multi-merchant incident | Incident multi-commerçants | `network` | E3/E4 |

## 5. Wording rules (hard requirement)

**Forbidden anywhere** (UI, tooltips, API messages, chatbot, exports, code comments shown to users): *fraud, fraudulent, fraudster, scam, theft, stolen, suspicious, suspect, attack, criminal, illicit, compromise(d), blacklist*. (French too: *fraude, frauduleux, suspect, arnaque, vol*.)
Add a CI grep on the frontend for these words.

**Use instead:** anomaly, unusual activity, deviation, incident, interruption, operational issue.

**No ML jargon in operator-facing text:** never *z-score, isolation forest, outlier, p-value, sigma, residual, feature importance*. Translate it:
- "z = 4.2" → "about 4× more than usual"
- "outside 95% interval" → "well outside its usual range"
- "top SHAP feature" → "main reason"

**Explanation template** (every anomaly card, B4):

> **[Merchant] · [Day, date]**: **[Indicator]** was **[observed]**, against a usual **[reference]** for this day of the week (**[±x%]**).
> Main reasons: [factor 1], [factor 2].
> Suggested action: [who] should [what].

Rules: always show the observed value **and** the reference with the same unit; say what "usual" means ("median of the last 4 Tuesdays"); one sentence per idea; no hedging walls of text. A "How was this computed?" disclosure holds the technical details.

## 6. Typography

| Role | Font | Notes |
|---|---|---|
| Headings, KPI values | **Montserrat** (free stand-in for SATIM's Gotham) | 600; page title 24px; never uppercase except the 12px section eyebrows |
| Body, tables, UI | **Open Sans** (SATIM's own body font) | 14px default, 16px for explanation prose |
| Arabic / Darija (E2 assistant, bilingual names) | **IBM Plex Sans Arabic** | Set `dir="rtl"` on Arabic blocks only |
| IDs (`MER-7175`), code | **JetBrains Mono** | 13px |

- All numbers in tables and KPIs use `font-variant-numeric: tabular-nums` (`.num`) and are **right-aligned**.
- **Self-host fonts** (`@fontsource-variable/montserrat`, `@fontsource-variable/open-sans`, `@fontsource/ibm-plex-sans-arabic`, `@fontsource-variable/jetbrains-mono`). No Google Fonts CDN, because SATIM's data-residency stance means the tool must run on an isolated network. This is worth one line in the Decision Log.

## 7. Formatting

- Money: `12 450 DZD` (fr-DZ grouping, thin space). Compact in KPIs: `1,2 M DZD`. Use `Intl.NumberFormat`, never string concatenation.
- Percent change: always signed, with arrow + color *only if it is an anomaly*: `▼ −62 %`.
- Dates: `Tue 14 Oct 2026` in prose, `2026-10-14` in tables/exports. Timezone **Africa/Algiers**. Mark Algerian public holidays on every time axis.
- Merchants: `MER-7175` in mono + category as secondary text.
- **Card numbers (`masked_pan`) are never rendered**, not even masked. Show "unique cards: 214" instead (spec §4 privacy rule).

## 8. Layout & navigation

- Target 1440×900 desktop, must work down to 1280. Not mobile-first (operator tool), but no horizontal page scroll at 1280.
- Shell: 3px `--brand-accent` bar → 56px top bar (logo mark, product name, global period + channel filters, theme toggle, language) → 240px left sidebar (collapsible to 64px) → content (max 1600px, 24px padding).
- Sidebar order follows the operator workflow: **Overview → Alerts / Priority queue → Merchants → Transactions → Insights (forecast, incidents) → Assistant**.
- **Overview (10-second screen)**, top to bottom:
  1. Network health strip: one sentence + status ("3 critical incidents affecting 7 merchants since 09:00").
  2. Max **4 KPI cards**: transactions, value (DZD), rejection rate, open anomalies, each with a vs-usual delta + sparkline.
  3. Priority queue (top 5, ranked 1-2-3) on the left 2/3, trend chart on the right 1/3.
- Every anomaly row is clickable → anomaly detail (explanation card + chart with reference band) → merchant page → filtered transactions. Breadcrumbs always; filters persist in the URL.
- Global filters (period, merchant, category, channel) live in the top bar and apply everywhere.

## 9. Components (see styleguide.html)

- **Severity badge:** pill, `--sev-*-bg` background, `--sev-*-fg` text, icon 14px + label, 12px/600.
- **KPI card:** label (12px uppercase eyebrow, `--text-muted`) → value (32px Montserrat, tabular) → delta vs usual → sparkline. No more than one sparkline color.
- **Alert row:** rank number · severity badge · type icon+label · merchant · observed vs usual · time · chevron. Left border 3px `--sev-*` color.
- **Explanation card:** headline sentence (16px), observed vs reference mini-table, "Main reasons" list, suggested action, collapsible "How was this computed?".
- **Buttons:** primary (`--primary` bg), secondary (border), ghost. Height 36px, radius `--radius-md`. Only one primary per view.
- **Tables:** 40px rows, sticky header, zebra off, row hover `--surface-sunken`, numeric columns right-aligned.
- **Empty / loading / error states** on every panel: skeletons for loading, plain sentence + retry for errors. Never a blank card.

## 10. Charts

- Default: line for time series, bar for comparisons (sorted). No pies or donuts except a channel share with ≤5 slices; no 3D, no gradients.
- Every time-series that shows an anomaly draws: the observed line (`--chart-series`), the **usual reference** (dashed `--chart-baseline`), the **expected range** band (`--chart-band`), and anomaly points as dots in the severity color.
- Forecasts (E1): solid line for actuals, dashed for forecast, band for the uncertainty interval, vertical "today" rule.
- Axis labels 12px `--chart-axis`, grid `--chart-grid` horizontal only, legends top-left, direct labels when ≤3 series.
- Tooltip shows value, usual value, and delta. Charts must re-theme from tokens (read CSS vars at render).

## 11. Motion

The platform should feel **alive**: data arrives, charts draw themselves, the queue re-ranks in front of you. But every animation must answer *"what changed?"*. If it doesn't explain a change, it doesn't ship.

**Every action has an assigned animation.** The full map (42 actions: navigation, filters, tables, alerts & triage, overlays, charts, feedback & states, assistant, preferences) with live demos is `design/animations.html`. Building a screen = pick the matching card and copy its class/helper. If an action is missing from the catalogue, add a card there first. The table below shows the highlights.

| Moment | Effect | How |
|---|---|---|
| **App load** | Logo line draws, then the red pixel pops (stepped); brand bar light sweep | `.m-draw`, `.m-pixel`, `.brand-bar` |
| **Data arrives** | Cards/rows rise 10px + fade, 45ms stagger | `.m-rise` + `style="--i:n"` |
| **KPIs** | Numbers count up (ease-out-expo, 900ms); sparklines draw | `countUp(el, to, format)`, `.m-draw` |
| **Charts** | Expected-range band grows → usual line fades in → series draws → anomaly point pops + ripples | `.m-band`, `.m-fade`, `.m-draw`, `.m-pop`, `.m-ring` |
| **Priority queue** | Rows glide to their new rank on recovery or new alert; a new row flashes its severity tint | `transition(update, scope)` + `data-vt` per row, `.m-flash` |
| **Unacknowledged critical** | Badge icon heartbeat + infinite ripple on its chart point; **stops when acknowledged** | `.m-beat`, `.m-ring.is-critical` |
| **Refresh / loading** | Skeleton shimmer; brand bar sweeps until data lands | `.skeleton`, `.brand-bar.is-refreshing` |
| **Live status** | Green dot breathing next to "updated Xs ago" | `.m-live` |
| **Theme switch** | Circular reveal from the toggle button | `toggleTheme(button)` |
| **Scrolling long pages** | Sections rise into view (Chrome/Edge only, harmless elsewhere) | `.m-reveal` |
| **Hover / press** | Clickable cards lift 2px; buttons press to 97% | `.m-lift`, `.btn:active` |

**Budgets**
- Hover/press 120ms, toggles/filters 200ms, entrances & reorders 450ms, draws/count-ups 900ms. Nothing longer.
- Stagger caps at 8 items; a page's entrance finishes in under ~800ms.
- Draws and count-ups run on **first load and explicit refresh only**. Changing a filter crossfades in 200ms; it does not replay the show.
- **Infinite animations: only** the live dot and unacknowledged critical alerts. Everything else plays once (ripples twice).
- Animate only `transform`, `opacity`, `stroke-dashoffset` and `clip-path`: no width/height/top animations (no layout jank on big tables). Allowed exceptions, all small elements: sidebar width (collapse), tab/segment indicator width, accordion and expandable-row height (`.m-collapse`).
- Exits are faster than entrances (200ms vs 450ms). Always remove elements with `animateOut()` so they still disappear under reduced motion.
- Lists that reorder, insert or remove items use `transition(update, scope)` with a `data-vt` name per item, so the other items glide instead of jumping.
- Tooltips wait 300ms before showing (hover intent) and hide instantly. Error toasts never auto-dismiss.
- Numbers are `tabular-nums` so count-ups don't wobble.
- The pixel/stepped motion (`steps()`) is the TechnoCraft touch: logo pixel and badge hover only.

**Accessibility**
- `prefers-reduced-motion`: every CSS animation is disabled by `tokens.css` and elements rest in their final state; `countUp`, `transition` and `toggleTheme` switch to instant updates. Test the app with it on.
- Never convey information *only* through motion: the beat on a critical badge is extra; the label already says "Critical".
- Visible focus ring (`--focus-ring`) on everything interactive; full keyboard nav for tables and the alert queue.
- Icons that carry meaning have `aria-label`; charts have a text summary / data-table fallback.

## 12. Branding & the TechnoCraft touch

**SATIM**
- App top bar: logo mark + "Payment Anomaly Intelligence". The SATIM logo sits in the sidebar footer and on the login screen (24–32px high). In dark mode, show it on a white tile; never recolor it.
- Never stretch, crop or recolor the SATIM logo; keep clear space ≥ the height of its "S".

**TechnoCraft: exactly these touches, nowhere else**
1. **Logo mark:** the activity line is drawn on a pixel grid, and the anomaly is a single red block.
2. **Credit badge** (`technocraft-badge.svg`, 200×48): sidebar footer under the SATIM logo, plus the login/about page. Its colors and Courier font stay inside the badge.
3. *(optional)* **404 / empty-state illustrations** may use the pixel style and the grass/dirt strip.

Never use TechnoCraft gold in the dashboard: it is almost the same as the **Medium** severity amber and would read as an alert. No pixel fonts, no game graphics in data views.
