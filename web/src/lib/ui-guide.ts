// The platform guide the assistant answers "how do I…", "what does this button do" and "what does
// this mean for the business" from: every page, its panels, its controls (with their on-screen
// names in English and French), the tasks a user can do there step by step, and the business terms.
// Written from the code (pages, components and role checks); keep it in step when the UI changes.
// The model reads it through the platform_guide tool and must not describe anything it does not list.
import type { Display } from './assistant-tools';
import type { Lang } from './assistant';
import type { Selection } from './selection';

interface Control { names: string[]; does: string; who?: string }
interface Task { task: string; steps: string[] }
export interface GuidePage {
  key: string; route: string; name: string; fr: string; purpose: string;
  panels: { name: string; explains: string }[]; controls: Control[]; tasks: Task[];
}

const EXPORT = 'needs the Export permission';
const ADMIN = 'administrator only';

const PAGES: GuidePage[] = [
  {
    key: 'shell', route: '', name: 'Everywhere (sidebar, page header, assistant)', fr: 'Partout (barre latérale, en-tête, assistant)',
    purpose: 'Navigation and settings shared by every page. An account only sees the pages and actions the administrator gave it.',
    panels: [
      { name: 'Sidebar', explains: 'Pages grouped as Monitor (Overview, Live Monitoring, Incidents, Alerts), Investigate (Intelligence, Merchants, Transactions, Assistant, Simulator), Report (Reports, Data & runs, Controlled learning) and Admin (Accounts). The number on Incidents counts open incidents.' },
      { name: 'Spotlight card', explains: 'The top open incident ("Critical now" or "Top of the queue") with its type, merchant, days running and priority; "All clear" when nothing is open.' },
      { name: 'Dataset status', explains: 'At the foot of the sidebar: which data the pages show (the official competition archive or imported collections) and its dates; opens Data & runs.' },
      { name: 'Banners', explains: 'A banner on data pages says when imported collections are shown instead of the official SATIM data, or when their analysis is still running or failed.' },
    ],
    controls: [
      { names: ['Collapse', 'Expand', 'Replier', 'Déplier'], does: 'Folds the sidebar to icons or unfolds it; remembered on this browser.' },
      { names: ['Open incident', 'Ouvrir l’incident'], does: 'In the spotlight card: opens the top incident of the queue.' },
      { names: ['Up one level', 'Remonter d’un niveau'], does: 'Back button on detail pages: returns to the list with its last filters.' },
      { names: ['SATIM dataset', 'Collection', 'Combined view', 'Active dataset', 'Jeu de données'], does: 'Dataset selector in the page header: shows which data every page reads. "Return to the original SATIM dataset" goes back to the official data; "Manage collections" opens Data & runs.' },
      { names: ['Return to the original SATIM dataset', 'Revenir au jeu de données SATIM d’origine'], does: 'Shows the official SATIM data again instead of imported collections (for your account only).' },
      { names: ['Manage collections', 'Gérer les collections'], does: 'Opens the Data collections panel on Data & runs.' },
      { names: ['FR', 'EN'], does: 'Language switch: changes the interface language in place; filters and selections are kept.' },
      { names: ['Switch light or dark theme', 'Theme', 'Thème'], does: 'Toggles the light and dark theme; remembered on this browser.' },
      { names: ['Sign out', 'Se déconnecter'], does: 'Ends the session.' },
      { names: ['Reset', 'Réinitialiser'], does: 'In a filter bar: clears every filter of the page.' },
      { names: ['Period', 'Période'], does: 'Date range: pick a preset (last 7, 14 or 30 days, full period) or click a start then an end day, then Apply.' },
      { names: ['Export CSV', 'Exporter en CSV'], does: 'Downloads the rows of the page with its current filters, without card data; each export is recorded in the audit ledger.', who: EXPORT },
      { names: ['How it’s computed', 'Mode de calcul', 'How was this computed?'], does: 'Opens a short method note under a panel.' },
      { names: ['Previous page', 'Next page'], does: 'Pages through a long table.' },
      { names: ['Ask the assistant', 'Interroger l’assistant', 'Ask the assistant about this page'], does: 'The mascot at the bottom right: a click opens the assistant on this page; it can be dragged anywhere.' },
      { names: ['Select something on the page', 'Sélectionner un élément de la page'], does: 'Pick mode: click a chart bar, row, card, panel or button to attach it to your question; Esc cancels.' },
      { names: ['Ask about this', 'Poser une question'], does: 'Appears next to highlighted text: attaches the text to a question.' },
      { names: ['New conversation', 'Nouvelle conversation'], does: 'Starts a new conversation with the assistant.' },
      { names: ['Open in the assistant page', 'Ouvrir dans la page Assistant'], does: 'Continues this conversation on the full Assistant page.' },
      { names: ['Close the assistant', 'Fermer l’assistant'], does: 'Closes the assistant panel (Esc does the same).' },
    ],
    tasks: [
      { task: 'Ask the assistant about something on the page', steps: ['Click the mascot at the bottom right', 'Click "Select something on the page" and click the chart bar, row, card or button', 'Type the question (or leave it empty to have the selection explained) and Send'] },
      { task: 'Change the language or theme', steps: ['Use FR / EN in the page header for the language', 'Use the theme button next to it for light or dark'] },
    ],
  },
  {
    key: 'overview', route: '/', name: 'Overview', fr: 'Vue d’ensemble',
    purpose: 'Network health at a glance for the selected period: KPIs against the previous period, daily activity against the expected level, signals, channel mix, open incidents and the 7-day forecast.',
    panels: [
      { name: 'KPI cards', explains: 'Each card compares the period with the previous one of the same length (green or red pill). Defaults: transactions, accepted value, attempted value, decline rate, merchants flagged, open incidents. "—" means the value cannot be computed.' },
      { name: 'Network activity', explains: 'One pair of bars per day: expected level (light) and actual transactions (dark); a red badge counts flagged merchant-days. With a channel filter, no expected level is drawn. Over 31 days, pick a shorter period.' },
      { name: 'Signals', explains: 'Last 14 days: Collective Detection warnings (many merchants moving together), Hybrid ML investigation candidates (advisory, not official alerts) and merchants under observation just below the alert threshold.' },
      { name: 'Channels', explains: 'Share of transactions per payment channel with its change against the previous period.' },
      { name: 'Open incidents', explains: 'Open incidents network-wide by severity.' },
      { name: 'Next 7 days', explains: 'Advisory forecast with an 80 % range and its backtest error against a naive forecast; it never raises alerts.' },
    ],
    controls: [
      { names: ['Category', 'Catégorie', 'Channel', 'Canal', 'Merchant', 'Commerçant'], does: 'Filters every panel of the page to one category, channel or merchant.' },
      { names: ['Customize KPIs', 'Personnaliser les indicateurs'], does: 'Opens the KPI editor to choose, reorder and define your own KPI cards (saved for your account).' },
      { names: ['Network activity bar'], does: 'Clicking a day opens its alerts (when merchants were flagged that day) or its transactions.' },
      { names: ['Collective Detection warnings', 'Hybrid ML investigation candidates'], does: 'Open the matching tab of Intelligence.' },
      { names: ['Channel slice or row', 'mix-check', 'All channels', 'Tous les canaux'], does: 'A click shows only that channel; Ctrl/⌘/Shift-click or the check box adds or removes it from a multi-selection; "All channels" clears it.' },
      { names: ['Severity bubble'], does: 'Opens the incident queue filtered on that severity.' },
    ],
    tasks: [
      { task: 'Customize the KPI cards', steps: ['Click "Customize KPIs"', 'Add a suggested KPI, or "Add KPI" and write a formula such as declined / transactions (use "Insert a measure" for the names)', 'Choose how it is shown (number, amount, percent), its chart and whether up or down is good', 'Reorder or remove cards, then Save (up to 12 cards; "Reset to the default six" restores the defaults)'] },
      { task: 'Investigate a bad day', steps: ['Find a day with a red badge in Network activity', 'Click its bar to open that day\'s alerts', 'Open an alert, then its incident'] },
      { task: 'Compare channels', steps: ['In Channels, click one channel or Ctrl/⌘-click several', 'Every panel follows the selection', 'Click "All channels" to clear'] },
    ],
  },
  {
    key: 'live', route: '/live', name: 'Live Monitoring', fr: 'Surveillance en direct',
    purpose: 'A simulated intraday replay of the training archive with a simulated clock, to show how early warnings would appear during the day. It is not a production feed.',
    panels: [
      { name: 'Simulated Live Monitoring — Historical Replay', explains: 'Replay controls, status (Idle, Running, Paused, Finished, Stopped, Failed) and simulated time.' },
      { name: 'Synthetic scenario truth', explains: 'What the chosen scenario injected (onset, end, channel or merchants, changed events), to compare with what was detected.' },
      { name: 'Live activity', explains: 'Metrics and four charts: observed against expected activity with a 90 % band and warning markers, cumulative activity, rejections and cancellations, accepted value.' },
      { name: 'Intraday early warnings', explains: 'Warnings raised during the day for a merchant, channel or category, with their state, score and timeline.' },
      { name: 'Collective advisories', explains: 'Warnings shared by several merchants at the same time.' },
      { name: 'Transaction domain evidence', explains: 'Contactless payments above the 2,500 DZD limit: observations, not anomalies.' },
      { name: 'Simulated daily closure', explains: 'The days scored and flagged once each simulated day closes.' },
    ],
    controls: [
      { names: ['Start date', 'End date'], does: 'Days to replay; editable before starting.' },
      { names: ['Scenario', 'Scénario'], does: 'Historical activity, or an injected disruption: short POS interruption, persistent merchant degradation, POS rejection spike, collective e-commerce disruption, POS interruption with same-day backlog.' },
      { names: ['Playback speed', 'Vitesse de lecture'], does: 'Replay speed; can be changed while running.' },
      { names: ['Start', 'Démarrer', 'Pause', 'Resume', 'Reprendre', 'Step forward', 'Avancer d’un pas', 'Stop', 'Arrêter'], does: 'Control the replay (Step forward only while paused).', who: 'needs the Control live replay permission' },
      { names: ['Scope', 'Selection', 'Window'], does: 'Focus Live activity on the network, a channel, a merchant or a category, over the last 15 minutes, hour, six hours or the current day.' },
    ],
    tasks: [
      { task: 'Run a replay', steps: ['Choose the start and end dates, a scenario and a speed', 'Click Start; Pause, Step forward and Resume as needed', 'Use Scope, Selection and Window to focus', 'Compare the warnings with "Synthetic scenario truth"', 'Stop, then Reset'] },
    ],
  },
  {
    key: 'incidents', route: '/incidents', name: 'Incidents', fr: 'Incidents',
    purpose: 'The ranked queue of incidents (consecutive flagged days of one merchant), handled from the top.',
    panels: [{ name: 'Incident queue', explains: 'Rank, priority (0–100), merchant and symptom, severity, state, review status and owner, period, exposure and who acts first.' }],
    controls: [
      { names: ['Show', 'Afficher'], does: 'Open incidents ranked (default), all, or closed and resolved.' },
      { names: ['Lifecycle', 'Cycle de vie'], does: 'Active, Recovering or Resolved.' },
      { names: ['Review', 'Revue'], does: 'New, Acknowledged, Assigned or Closed (official dataset only).' },
      { names: ['Severity', 'Sévérité'], does: 'Critical, High, Medium or Low.' },
      { names: ['Sort by', 'Trier par'], does: 'Business priority (default), statistical severity, estimated impact or duration.' },
    ],
    tasks: [{ task: 'Work the queue', steps: ['Keep "Show: Open" and "Sort by: Business priority"', 'Open the first incident', 'Review it (see the incident page), then come back with "Up one level"'] }],
  },
  {
    key: 'incident', route: '/incidents/[id]', name: 'Incident detail', fr: 'Détail de l’incident',
    purpose: 'Explains one incident, why it ranks where it does, what to check next, and records its review.',
    panels: [
      { name: 'Summary card', explains: 'Severity, lifecycle, review status, rank in the queue, priority, duration, affected transactions and the gross value shortfall estimate.' },
      { name: 'Next check', explains: 'Who acts and the numbered steps; the cause is never confirmed by the platform.' },
      { name: 'Review', explains: 'Review actions and their history (who, when, status change, reason).' },
      { name: 'Why it ranks here', explains: 'Priority = 40 % impact + 30 % urgency + 20 % evidence + 10 % actionability.' },
      { name: 'Estimated business impact', explains: 'Expected against observed transactions, shortfall, gross affected payment activity (not a confirmed loss) and excess rejections.' },
      { name: 'Timeline', explains: 'Daily transactions around the incident against the expected level; flagged bars open their alert.' },
      { name: 'Flagged days', explains: 'Each alert of the incident.' },
      { name: 'Evidence', explains: 'Signal scores of the strongest day.' },
      { name: 'Possible causes', explains: 'Ranked hypotheses with evidence for and against and what would confirm each; none is confirmed.' },
    ],
    controls: [
      { names: ['Incident brief', 'Fiche incident'], does: 'Opens the printable incident brief in Reports (official dataset).' },
      { names: ['Ask about it', 'Poser une question'], does: 'Asks the assistant why the merchant was flagged and what to check.' },
      { names: ['Acknowledge', 'Prendre en compte'], does: 'Marks a new incident as seen.', who: 'needs the Review permission' },
      { names: ['Assign', 'Assigner'], does: 'Gives the incident an owner: L1 operations, Technical investigator, Acquiring bank liaison or Network team.', who: 'needs the Manage permission' },
      { names: ['Escalate', 'Escalader'], does: 'Escalates with a required reason.', who: 'needs the Manage permission' },
      { names: ['Comment', 'Commenter'], does: 'Adds a note with a required reason (no card data).', who: 'needs the Review permission' },
      { names: ['Close', 'Clôturer'], does: 'Closes the incident with a required reason.', who: 'needs the Manage permission' },
      { names: ['Reopen', 'Rouvrir'], does: 'Reopens a closed incident.', who: 'needs the Manage permission' },
    ],
    tasks: [{ task: 'Review an incident', steps: ['Read the summary card, Next check, Why it ranks here and Possible causes', 'Click Acknowledge', 'Assign an owner', 'Comment with what was checked', 'Escalate or Close with a reason; the entry appears under History (Reopen if needed)'] }],
  },
  {
    key: 'alerts', route: '/alerts', name: 'Alerts', fr: 'Alertes',
    purpose: 'Every official flagged merchant-day: what was observed against what was expected and its score.',
    panels: [{ name: 'Alert table', explains: 'Severity, symptom, merchant, day, observed against expected and score; each row opens its explanation.' }],
    controls: [
      { names: ['Severity', 'Criticality', 'Criticité', 'Incident state', 'Symptom'], does: 'Filter by severity, criticality, the state of the linked incident or the type of anomaly.' },
      { names: ['Sort', 'Tri'], does: 'Newest first or highest score first.' },
    ],
    tasks: [{ task: 'Find the strongest alerts of a week', steps: ['Set Period to the last 7 days', 'Sort by highest score first', 'Open the first row'] }],
  },
  {
    key: 'alert', route: '/alerts/[id]', name: 'Alert explanation', fr: 'Explication de l’alerte',
    purpose: 'Why one merchant-day was flagged and what would have been normal.',
    panels: [
      { name: 'Summary card', explains: 'Symptom, severity, explanation and observed value against usual.' },
      { name: 'Transactions for this alert', explains: 'Links to the day\'s transactions, the declined or cancelled ones only, or the whole incident period.' },
      { name: 'That day vs usual', explains: 'Transactions, decline rate, cancellation rate, typical payment and accepted value against the merchant\'s usual level.' },
      { name: 'Hybrid ML advisory evidence', explains: 'Advisory machine-learning evidence, when there is some.' },
      { name: 'Per day chart', explains: 'The indicator 4 weeks before and 1 week after.' },
      { name: 'Channels that day', explains: 'Bar = that day, mark = usual.' },
      { name: 'Transactions per hour', explains: 'Dark = that day, light = usual.' },
    ],
    controls: [
      { names: ['Open incident', 'Ouvrir l’incident'], does: 'Opens the incident this alert belongs to.' },
      { names: ['View transactions for this alert', 'Voir les transactions liées à cette alerte', 'Show declined only', 'Show cancelled only'], does: 'Opens the matching transactions of that day.' },
    ],
    tasks: [{ task: 'Check the transactions behind an alert', steps: ['Click "View transactions for this alert" (or "Show declined only")', 'Look at status, channel and amount', 'Return with "Up one level"'] }],
  },
  {
    key: 'intelligence', route: '/intelligence', name: 'Intelligence', fr: 'Intelligence réseau',
    purpose: 'Network-wide advisory layers that complement, but are not, official alerts.',
    panels: [
      { name: 'Collective Detection warnings', explains: 'A channel or category where several merchants moved together the same day; corroborated merchants and a score.' },
      { name: 'Hybrid ML investigation candidates', explains: 'Merchant-days an Isolation Forest fused with the probabilistic score ranks as unusual, including some the official detector did not flag; for investigation only.' },
    ],
    controls: [
      { names: ['Collective Detection warnings', 'Alertes de détection collective', 'Hybrid ML investigation candidates', 'Cas à examiner (ML hybride)'], does: 'Tabs switching between the two layers.' },
      { names: ['Open merchant', 'Ouvrir le commerçant'], does: 'Opens the merchant of an ML candidate.' },
    ],
    tasks: [{ task: 'Check whether a problem is network-wide', steps: ['Open the Collective Detection tab', 'Open a warning to see its merchants and hypotheses', 'Follow its linked incidents'] }],
  },
  {
    key: 'advisory', route: '/intelligence/[id]', name: 'Collective advisory', fr: 'Alerte collective',
    purpose: 'One collective warning: the channel and symptom, the merchants involved and the hypotheses.',
    panels: [
      { name: 'Summary card', explains: 'Observed against expected, merchants affected and corroborated, score.' },
      { name: 'Hypotheses', explains: 'Possible causes with evidence for and against; none confirmed.' },
      { name: 'Linked incidents', explains: 'Incidents of merchants in this warning.' },
      { name: 'Merchants on the channel', explains: 'Each merchant\'s activity that day.' },
      { name: 'Merchant × channel', explains: 'Declined over total per merchant and channel; darker = more declines.' },
    ],
    controls: [], tasks: [],
  },
  {
    key: 'merchants', route: '/merchants', name: 'Merchants', fr: 'Commerçants',
    purpose: 'Health table of every merchant, to spot who needs attention.',
    panels: [{ name: 'Merchant table', explains: 'Main channel, transactions and value per day, declines, latest against expected, health score (0–100), open incidents and the last 30 days. "New" and "Learning" mark merchants with little history.' }],
    controls: [
      { names: ['Search', 'Rechercher'], does: 'Type a merchant id (MER-…) or a category, then Enter.' },
      { names: ['Sort', 'Tri'], does: 'Needs attention first, busiest first, highest decline rate or merchant id.' },
      { names: ['Merchant row'], does: 'Clicking a row opens the merchant (Ctrl/⌘-click for a new tab).' },
    ],
    tasks: [{ task: 'Find merchants that need attention', steps: ['Keep "Sort: Needs attention first"', 'Look at the health score and open incidents', 'Click a row to open the merchant'] }],
  },
  {
    key: 'merchant', route: '/merchants/[id]', name: 'Merchant detail', fr: 'Détail du commerçant',
    purpose: 'Everything about one merchant: activity, health, incidents, forecast and payment mix.',
    panels: [
      { name: 'KPI cards', explains: 'Transactions and accepted value per day, decline rate, flagged days.' },
      { name: 'Transactions per day', explains: 'Daily bars against the expected level; coloured bars are flagged days and open their alert.' },
      { name: 'Operational checklist', explains: 'Health index over the last 7 days from six checks, each OK, Watch, Issue or Unknown.' },
      { name: 'Incidents', explains: 'The merchant\'s incidents.' },
      { name: 'First days · category reference', explains: 'For a new merchant: its first days against its category, since it has no history of its own yet.' },
      { name: 'Next 7 days', explains: 'Advisory forecast.' },
      { name: 'Channel mix', explains: 'Share per channel; a click opens those transactions.' },
      { name: 'Status mix', explains: 'Accepted, declined, cancelled and refunded.' },
    ],
    controls: [
      { names: ['Transactions →'], does: 'Opens this merchant\'s transactions.' },
      { names: ['Health brief', 'Fiche santé'], does: 'Opens the printable merchant health brief (official dataset).' },
      { names: ['Ask about it', 'Poser une question'], does: 'Asks the assistant why this merchant was flagged.' },
    ],
    tasks: [{ task: 'Prepare a merchant follow-up', steps: ['Read the Operational checklist and Incidents', 'Open the flagged days from Transactions per day', 'Click "Health brief" and Download PDF'] }],
  },
  {
    key: 'transactions', route: '/transactions', name: 'Transactions', fr: 'Transactions',
    purpose: 'The cleaned transactions behind every figure, without card data.',
    panels: [{ name: 'Transaction table', explains: 'Time, merchant, category, channel, status, amount and data-quality chips; the total and accepted value are shown above.' }],
    controls: [
      { names: ['Status', 'Statut'], does: 'Accepted, Declined, Cancelled, Refunded or Unknown.' },
      { names: ['Quality', 'Qualité'], does: 'Rows with a missing, negative or invalid amount, an unknown channel or a recovered category.' },
      { names: ['Contactless', 'Sans contact'], does: 'Contactless payments over the 2,500 DZD limit or within it.' },
      { names: ['Min DZD', 'Max DZD'], does: 'Amount range; press Enter to apply.' },
      { names: ['Sort', 'Tri'], does: 'Newest, largest or smallest amount, or status.' },
      { names: ['Full data audit'], does: 'Opens Data & runs.' },
    ],
    tasks: [{ task: 'Export the declined transactions of a merchant', steps: ['Choose the Merchant and Status: Declined, and a Period', 'Click Export CSV'] }],
  },
  {
    key: 'assistant', route: '/assistant', name: 'Assistant', fr: 'Assistant',
    purpose: 'Full-page conversations with the assistant, with their history.',
    panels: [{ name: 'History', explains: 'Earlier conversations; open one to continue it.' }],
    controls: [
      { names: ['New conversation', 'Nouvelle conversation'], does: 'Starts a new conversation.' },
      { names: ['Fold the history', 'Replier l’historique', 'Show the history'], does: 'Hides or shows the history list.' },
      { names: ['Delete', 'Supprimer'], does: 'Deletes a conversation (click twice to confirm).' },
    ],
    tasks: [{ task: 'Get a report from the assistant', steps: ['Ask for it, for example "Prepare this week\'s management report as a PDF"', 'Open or download it from the card under the answer', 'It is also listed in Reports under "Prepared by the assistant"'] }],
  },
  {
    key: 'simulate', route: '/simulate', name: 'Simulator', fr: 'Simulateur',
    purpose: 'Hypothetical what-if estimates; nothing is saved and nothing is flagged.',
    panels: [
      { name: 'What if a disruption hits?', explains: 'Estimated transactions lost or extra declines, gross affected value and merchants touched for a hypothetical outage or decline surge.' },
      { name: 'Review cost vs missed anomalies', explains: 'For each alert threshold, the cost of analyst reviews against the cost of missed anomaly days, with your own cost assumptions; marks the cheapest threshold and the current policy.' },
    ],
    controls: [
      { names: ['Outage', 'Panne', 'Decline surge', 'Hausse des refus'], does: 'Type of disruption.' },
      { names: ['Starts at', 'Lasts', 'Duration (days)', 'Declined %', 'Daily activity %', 'Payment value %'], does: 'Shape the hypothetical scenario.' },
      { names: ['Cost of one analyst review (DZD)', 'Cost of one missed anomaly day (DZD)'], does: 'Your cost assumptions for the threshold comparison.' },
    ],
    tasks: [{ task: 'Estimate an outage', steps: ['Choose Outage, a channel and a category', 'Set when it starts and how long it lasts', 'Read the estimates below; they are hypotheses, not forecasts'] }],
  },
  {
    key: 'reports', route: '/reports', name: 'Reports', fr: 'Rapports',
    purpose: 'Standard briefs to read, print or download, and the reports the assistant prepared for you.',
    panels: [
      { name: 'Brief', explains: 'Daily operational brief, weekly management brief, merchant health brief, alerts brief or incident brief.' },
      { name: 'Prepared by the assistant', explains: 'Your own reports made by the assistant.' },
    ],
    controls: [
      { names: ['Brief', 'Fiche'], does: 'Chooses the brief; then pick its day, week, merchant or period.' },
      { names: ['Download PDF', 'Télécharger le PDF'], does: 'Downloads the brief as a PDF.', who: EXPORT },
      { names: ['Print / save as PDF', 'Imprimer / enregistrer en PDF'], does: 'Opens the browser print dialog.' },
      { names: ['Alerts of the day (CSV)', 'Alerts of the week (CSV)', 'All incidents (CSV)', 'These alerts (CSV)'], does: 'CSV buttons at the foot of a brief.', who: EXPORT },
    ],
    tasks: [
      { task: 'Download the weekly management brief', steps: ['Choose Brief: Weekly management brief', 'Pick the week ending date', 'Click Download PDF'] },
      { task: 'Make a custom report', steps: ['Ask the assistant, for example "Make me a report on this week\'s alerts and open incidents"', 'Open it from the card under the answer', 'Ask the assistant on that report to change it; Undo reverts the last change'] },
    ],
  },
  {
    key: 'report', route: '/reports/[id]', name: 'Prepared report', fr: 'Rapport préparé',
    purpose: 'A report the assistant prepared for you (only you can see it).',
    panels: [{ name: 'Report', explains: 'Its sections, with links to alerts, incidents and merchants.' }],
    controls: [
      { names: ['Version', 'Undo', 'Annuler'], does: 'The version number; Undo returns to the previous version.' },
      { names: ['Download PDF', 'Télécharger le PDF'], does: 'Downloads it as a PDF.', who: EXPORT },
    ],
    tasks: [{ task: 'Change this report', steps: ['Open the assistant on this page', 'Ask, for example "Add a section on open incidents"', 'The page shows the new version; Undo reverts it'] }],
  },
  {
    key: 'data', route: '/data', name: 'Data & runs', fr: 'Données et analyses',
    purpose: 'Which data the platform reads, how it was cleaned and validated, imported collections, run history and forecast history.',
    panels: [
      { name: 'Data collections', explains: 'The original SATIM dataset (protected) and imported collections: select which ones the pages show, import new files, rename, trash and restore.' },
      { name: 'Run history', explains: 'The official run and every import with its period, counts, quality, flagged days and prediction files.' },
      { name: 'Forecast history', explains: 'Earlier forecasts against what happened (error and interval coverage).' },
      { name: 'Cleaning', explains: 'From raw rows to clean rows: duplicates removed and quality fixes.' },
      { name: 'Validation', explains: 'On the labelled period: anomaly days caught, false alerts and missed days (precision, recall, F1, episodes).' },
      { name: 'Data-quality limitations', explains: 'Known limits of the data.' },
      { name: 'Audit ledger', explains: 'Recent recorded actions (exports, reviews, imports, account changes).', },
      { name: 'Digests', explains: 'File fingerprints that prove which files the run used.' },
    ],
    controls: [
      { names: ['Collections', 'Trash', 'Corbeille'], does: 'Tabs: active collections or the trash.' },
      { names: ['Import transactions', 'Importer des transactions'], does: 'Opens the import dialog.', who: ADMIN },
      { names: ['Apply selection', 'Appliquer la sélection'], does: 'Shows the ticked collections on every page, for your account; several make a combined view analysed on the server.' },
      { names: ['Show only this collection', 'Afficher uniquement cette collection'], does: 'Row menu: shows that collection alone.' },
      { names: ['Activate for everyone', 'Stop activating for everyone', 'Make the SATIM dataset the platform default'], does: 'Row menu: sets the default data for every account that has not chosen its own.', who: ADMIN },
      { names: ['Add files to this collection', 'Rename', 'Move to trash', 'Restore', 'Restaurer'], does: 'Row menu and trash actions on a collection (the SATIM dataset is protected).', who: ADMIN },
      { names: ['Import history'], does: 'Row menu: shows the batches of a collection.' },
      { names: ['Official predictions (CSV)', 'Predictions CSV'], does: 'Downloads the prediction file of the official run (sealed run only) or of an import.', who: EXPORT },
    ],
    tasks: [
      { task: 'Import new transactions', steps: ['Click "Import transactions" (administrator)', 'Optionally download the CSV template', 'Drop the CSV files (up to 12 files of 25 MB); each file is checked and its errors and warnings shown', 'Choose "Create a new collection" (name it) or "Add to an existing collection"', 'Check the preview, choose Partial or Complete batch (complete: days without transactions count as zero)', 'Click "Create the collection and analyse"; follow the stages, then "Open" it or "View its alerts"'] },
      { task: 'Show imported collections instead of the official data', steps: ['In Data collections, tick one or more collections', 'Click "Apply selection"; the dataset selector in the header changes', 'Use "Return to the original SATIM dataset" to go back'] },
    ],
  },
  {
    key: 'learning', route: '/learning', name: 'Controlled learning', fr: 'Apprentissage contrôlé',
    purpose: 'Experts label flagged days and supervisors decide, with a reason, whether a retrained operational model replaces the current one. The official competition predictions are never changed.',
    panels: [
      { name: 'Operational models', explains: 'The active model, earlier models and label statistics.' },
      { name: 'Review queue', explains: 'Observations to label: merchant, day, symptom and evidence.' },
      { name: 'Learning jobs', explains: 'Train a candidate model, score it in shadow, compare it with the current one, then activate or reject it.' },
      { name: 'Drift monitoring', explains: 'Compares a baseline window with a recent window to see whether the data changed.' },
    ],
    controls: [
      { names: ['Label', 'Submit label', 'Soumettre l’étiquette'], does: 'Labels an observation: Confirmed anomaly, Verified normal, Legitimate change, Data-quality issue or Insufficient evidence, with required notes (no card data).', who: 'needs the Expert labelling permission' },
      { names: ['Approve', 'Reject'], does: 'Approves or rejects a pending label, with a reason.', who: 'needs the Supervise learning permission' },
      { names: ['Register job', 'Run (background)', 'Status', 'Score in shadow', 'Compare with the champion', 'Activate', 'Reject model'], does: 'Learning job steps.', who: 'needs the Supervise learning permission' },
      { names: ['Initialise the operational baseline', 'Roll back to the previous model'], does: 'Creates the first operational model, or returns to the previous one, with a reason.', who: 'needs the Supervise learning permission' },
      { names: ['Compare windows'], does: 'Runs the drift comparison for the four dates.' },
    ],
    tasks: [{ task: 'From labels to a new model', steps: ['Reviewer: label observations with notes and Submit label', 'Supervisor: Approve the labels with a reason', 'Supervisor: Register job, Run it, check Status', 'Score in shadow, then Compare with the champion', 'Activate with a reason only if it is eligible; Roll back if needed'] }],
  },
  {
    key: 'admin', route: '/admin', name: 'Accounts', fr: 'Comptes',
    purpose: 'The administrator creates accounts and chooses the pages and actions of each one. Every change is recorded.',
    panels: [{ name: 'New account', explains: 'Username, display name, password, pages and actions.' }, { name: 'Account list', explains: 'Each account with its access, password and deletion.' }],
    controls: [
      { names: ['Create account', 'Créer le compte'], does: 'Creates the account (password of 10 characters or more).', who: ADMIN },
      { names: ['Save access', 'Enregistrer les accès'], does: 'Saves pages and actions; the account\'s open sessions are signed out.', who: ADMIN },
      { names: ['Reset password', 'Change my password'], does: 'Sets a new password.', who: ADMIN },
      { names: ['Delete account', 'Supprimer le compte'], does: 'Deletes the account after the confirmation box is ticked.', who: ADMIN },
    ],
    tasks: [{ task: 'Give a colleague access', steps: ['Fill New account: username, display name, password', 'Tick the pages they can see and what they can do (Review, Manage, Export, Control live replay, Expert labelling, Supervise learning)', 'Click "Create account"'] }],
  },
];

/** Business vocabulary: what the words on screen mean for operations. */
const TERMS: { term: string; names: string[]; means: string }[] = [
  { term: 'Alert', names: ['alert', 'alerte', 'flagged', 'signalé', 'merchant-day'], means: 'A merchant-day the official detector flagged because its activity left the merchant\'s own normal range. It describes an operational anomaly, never intent.' },
  { term: 'Incident', names: ['incident'], means: 'Consecutive flagged days of the same merchant grouped into one case to review, with an owner and a history.' },
  { term: 'Severity', names: ['severity', 'sévérité', 'critical', 'critique', 'high', 'medium', 'low'], means: 'How far activity is from normal and for how long: critical, high, medium or low. Critical is handled first.' },
  { term: 'Priority', names: ['priority', 'priorité', 'rank', 'rang'], means: 'Queue order from 0 to 100: 40 % impact + 30 % urgency + 20 % evidence + 10 % actionability.' },
  { term: 'Lifecycle', names: ['lifecycle', 'cycle de vie', 'active', 'recovering', 'resolved', 'actif', 'en reprise', 'résolu'], means: 'Active: still abnormal; Recovering: returning to normal; Resolved: back to normal.' },
  { term: 'Review status', names: ['review', 'revue', 'acknowledged', 'assigned', 'closed', 'new'], means: 'Where the human handling stands: new, acknowledged, assigned or closed.' },
  { term: 'Expected level', names: ['expected', 'attendu', 'usual', 'habituel', 'normal range', 'baseline'], means: 'What the merchant or network usually does on that kind of day, learned from its own history; the normal range around it is what still counts as normal.' },
  { term: 'Score and threshold', names: ['score', 'threshold', 'seuil'], means: 'The anomaly score of a merchant-day; above the alert threshold it is flagged. A higher threshold means fewer reviews but more missed anomalies (see the Simulator).' },
  { term: 'Exposure and business impact', names: ['exposure', 'exposition', 'impact', 'shortfall', 'manque', 'affected'], means: 'Estimated transactions and value affected; gross affected payment activity, not a confirmed loss.' },
  { term: 'Health score', names: ['health', 'santé', 'checklist'], means: 'A 0–100 heuristic index over the last 7 days from six operational checks (OK, Watch, Issue, Unknown).' },
  { term: 'Collective Detection warning', names: ['collective', 'collectif', 'advisory', 'network advisory'], means: 'Several merchants on the same channel or category moving together the same day: a likely shared cause (network, gateway, acquirer) rather than one merchant.' },
  { term: 'Hybrid ML investigation candidate', names: ['hybrid', 'hybride', 'ml', 'isolation forest', 'candidate'], means: 'Advisory machine-learning ranking to investigate; never an official alert.' },
  { term: 'Forecast', names: ['forecast', 'prévision', 'next 7 days'], means: 'Advisory expected activity with an 80 % range; it never raises alerts.' },
  { term: 'Decline rate', names: ['decline', 'refus', 'rejection', 'rejet'], means: 'Share of transactions declined; a jump often points to an issuer, gateway or terminal problem (to confirm with reason codes).' },
  { term: 'Contactless limit', names: ['contactless', 'sans contact', 'nfc', '2,500', '2500'], means: 'Contactless payments above 2,500 DZD are a domain rule observation, shown separately from anomalies.' },
  { term: 'Collection and dataset', names: ['collection', 'dataset', 'jeu de données', 'satim dataset', 'combined view'], means: 'The official SATIM data is protected; imported collections can be shown instead, for one account or for everyone.' },
  { term: 'Cold start', names: ['new', 'learning', 'nouveau', 'apprentissage', 'cold start', 'category reference'], means: 'A merchant with too little history is compared with its category until it has its own reference.' },
  { term: 'Validation', names: ['precision', 'recall', 'f1', 'validation', 'false alert'], means: 'How the engine did on the labelled period: anomaly days caught, false alerts and missed days.' },
];

/** "1. Click … 2. Choose …": step numbers of a list counting from 1 are not figures. */
export function dropStepNumbers(text: string): string {
  const STEP = /(^|\s)(\d{1,2})[.)](?=\s+\p{L})/gu;
  const n = [...text.matchAll(STEP)].map((m) => Number(m[2]));
  const isList = n.length >= 2 && n.every((x, i) => x === i + 1);
  return isList ? text.replace(STEP, '$1') : text;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ');
// question words carry no topic: "where can I see…", "comment faire pour…"
const STOP = new Set('the and for with can how what where which who why does this that these those see are you your from into does when then than its use used using want need show tell about page here there comment faire pour est les des une dans sur que qui quoi avec mon mes votre vos peut puis veux voir cette ces quel quelle quels sont'.split(' '));
const words = (s: string) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** The guide entry of a route: '/', '/incidents', '/incidents/INC-…' → its page. */
export function guidePage(path: string): GuidePage | null {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  const route = !parts.length ? '/' : parts.length === 1 ? `/${parts[0]}` : `/${parts[0]}/[id]`;
  return PAGES.find((p) => p.route === route) ?? null;
}

const compact = (p: GuidePage) => ({
  page: p.name, french_name: p.fr, purpose: p.purpose, panels: p.panels,
  controls: p.controls.map((c) => ({ names: c.names.join(' / '), does: c.does, ...(c.who ? { who: c.who } : {}) })),
  tasks: p.tasks,
});

/** For page_context: how to use the current page. */
export function pageGuide(path: string) { const p = guidePage(path); return p ? compact(p) : undefined; }

/** Controls, tasks and terms that match a question or a selected control, current page first. */
function search(topic: string, path: string) {
  const want = words(topic), here = guidePage(path)?.key;
  if (!want.size) return [];
  const hits: { score: number; hit: Record<string, unknown> }[] = [];
  const score = (text: string, boost = 1) => { const w = words(text); let n = 0; for (const x of want) if (w.has(x)) n++; return n * boost; };
  for (const p of PAGES) {
    const boost = p.key === here ? 1.5 : p.key === 'shell' ? 1.2 : 1;
    for (const c of p.controls) { const s = score(`${c.names.join(' ')} ${c.does}`, boost) + (c.names.some((n) => norm(topic).includes(norm(n))) ? 3 : 0); if (s) hits.push({ score: s, hit: { page: p.name, route: p.route, control: c.names.join(' / '), does: c.does, ...(c.who ? { who: c.who } : {}) } }); }
    for (const t of p.tasks) { const s = score(`${t.task} ${t.steps.join(' ')}`, boost); if (s) hits.push({ score: s + score(t.task, 1), hit: { page: p.name, route: p.route, task: t.task, steps: t.steps } }); }
    for (const x of p.panels) { const s = score(`${x.name} ${x.explains}`, boost); if (s) hits.push({ score: s, hit: { page: p.name, route: p.route, panel: x.name, explains: x.explains } }); }
    const s = score(`${p.name} ${p.fr} ${p.purpose}`, boost); if (s) hits.push({ score: s, hit: { page: p.name, route: p.route, purpose: p.purpose } });
  }
  for (const t of TERMS) { const s = score(`${t.term} ${t.names.join(' ')}`) + (t.names.some((n) => norm(topic).includes(norm(n))) ? 1 : 0); if (s) hits.push({ score: s, hit: { term: t.term, means: t.means } }); }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8).map((h) => h.hit);
}

export const GUIDE_TOOL = { type: 'function' as const, function: {
  name: 'platform_guide',
  description: 'The user guide of this platform: what each page, panel, button, tab, filter and field does, who may use it, step-by-step tasks (review an incident, import data, customize KPIs, export, run a live replay, label, give access…) and what business terms mean. Call it only for how to use the platform: "how do I…", "where is…", "what does this button/page do", a selected control, or the meaning of a term shown on screen. Never for questions about the data itself (data quality, alerts, incidents, merchants, figures, impact, forecasts): use the data tools for those. Without arguments it returns the current page and the list of pages.',
  parameters: { type: 'object', properties: {
    page: { type: 'string', enum: PAGES.map((p) => p.key), description: 'A page of the platform (shell = sidebar, page header and assistant, shared by every page).' },
    topic: { type: 'string', description: 'What the user wants to do or understand, in their words, e.g. "export declined transactions" or "what is priority".' },
  }, required: [], additionalProperties: false },
} };

const linkOf = (route: string, lang: Lang, name: string) => (route && !route.includes('[') ? [{ label: `${lang === 'fr' ? 'Ouvrir' : 'Open'} ${name}`, href: route }] : []);

/** Executes platform_guide for the model. */
export function guideResult(raw: string, path: string, lang: Lang): { result: unknown; display?: Display } {
  let a: { page?: unknown; topic?: unknown } = {};
  try { a = JSON.parse(raw || '{}') ?? {}; } catch { return { result: { error: 'Arguments must be JSON.' } }; }
  const here = guidePage(path);
  const page = typeof a.page === 'string' ? PAGES.find((p) => p.key === a.page) : null;
  const topic = typeof a.topic === 'string' ? a.topic.slice(0, 200) : '';
  const result: Record<string, unknown> = {};
  if (page) result.page_guide = compact(page);
  if (topic) result.matches = search(topic, path);
  if (!page && !topic) {
    result.current_page = here ? compact(here) : 'not a page of the guide';
    result.shared_controls = compact(PAGES[0]).controls;
    result.pages = PAGES.filter((p) => p.key !== 'shell').map((p) => ({ page: p.key, name: p.name, french_name: p.fr, purpose: p.purpose }));
  }
  result.note = 'Use the on-screen names (French names when answering in French). Actions marked "who" are hidden for accounts without that permission.';
  const target = page ?? here;
  return { result, display: target ? { intent: 'guide', scope: '', evidence: target.key === here?.key ? [] : linkOf(target.route, lang, lang === 'fr' ? target.fr : target.name) } : undefined };
}

/** Built-in guidance when the model is unavailable: the selected control, or the best-matching task. */
export function guideAnswer(q: string, selection: Selection[], path: string, lang: Lang): { text: string[]; evidence: { label: string; href: string }[] } | null {
  const fr = lang === 'fr';
  const ctl = selection.find((s) => s.kind === 'control')?.control;
  if (ctl) {
    // the selected control by its on-screen name: on this page first, then the shared controls, then anywhere
    const here = guidePage(path), name = norm(ctl.name);
    const c = [here, PAGES[0], ...PAGES].flatMap((p) => p?.controls ?? []).find((x) => x.names.some((n) => norm(n) === name))
      ?? [here, PAGES[0], ...PAGES].flatMap((p) => p?.controls ?? []).find((x) => x.names.some((n) => name.includes(norm(n)) || norm(n).includes(name)));
    if (c) return { text: [`${ctl.name}: ${c.does}${c.who ? ` (${c.who})` : ''}`, ...(fr ? ['Réponse du guide intégré (en anglais).'] : [])], evidence: [] };
  }
  const hits = search(ctl ? `${ctl.name} ${q}` : q, path);
  const task = hits.find((h) => 'task' in h) as { page: string; route: string; task: string; steps: string[] } | undefined;
  if (task) return { text: [`${task.task} (${task.page}):`, ...task.steps.map((s, i) => `${i + 1}. ${s}`)], evidence: linkOf(task.route, lang, task.page) };
  const other = hits[0] as Record<string, string> | undefined;
  if (other) return { text: [other.does ? `${other.control}: ${other.does}` : other.explains ? `${other.panel}: ${other.explains}` : other.means ? `${other.term}: ${other.means}` : `${other.page}: ${other.purpose}`], evidence: other.route ? linkOf(other.route, lang, other.page) : [] };
  return null;
}
