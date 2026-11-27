// Optional language model for "Ask the Dashboard" (contract: llm/README.md). The model only reads
// the question, picks one of 9 read-only tools and rephrases the tool result; every tool runs the
// deterministic assistant below, so numbers still come from the engine. Any failure (unset, down,
// slow, a number not in the tool results, a prohibited term) falls back to the deterministic answer.
import fs from 'node:fs';
import path from 'node:path';
import { answer, detectLang, PROHIBITED, type Lang, type Reply } from './assistant';
import { model } from './model';
import { appToolDefs, isAppTool, runAppTool, type Display } from './assistant-tools';
import type { Turn } from './conversations';
import type { PageContext } from './page-context';
import { selectionBlock, type Selection } from './selection';
import { buildReport, composeToolDef, getReport, reportSummary, saveReport, unwrittenText, updateReport, validateSpec, type StoredReport } from './custom-report';

const URL_ = process.env.LLM_URL?.replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL ?? 'assistant';
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? 12000);
const MAX_ROUNDS = 4;
const HISTORY_TURNS = 6;   // earlier question/answer pairs sent to the model
const HISTORY_CHARS = 1500; // per earlier answer
const contractDir = () => process.env.LLM_CONTRACT_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..', 'llm', 'contract');

type Tool = { type: 'function'; function: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } } };
let contract: { prompt: string; tools: Tool[] } | null = null;
function loadContract() {
  if (!contract) {
    const dir = contractDir();
    contract = {
      prompt: fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, 'system-prompt.txt'), 'utf8'),
      tools: JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, 'tools.json'), 'utf8')),
    };
  }
  return contract;
}

/* ── tools: each maps to a question the deterministic assistant already answers ── */
const PERIODS: Record<string, string> = { today: 'today', yesterday: 'yesterday', this_week: 'this week', last_week: 'last week', last_30_days: 'this month' };
const CHANNELS: Record<string, string> = { ecommerce: 'e-commerce', pos: 'POS', mobile: 'mobile app', nfc: 'contactless', transfer: 'bank transfer' };
type Args = { period?: string; channel?: string; merchant?: string };
const per = (a: Args) => PERIODS[a.period ?? 'this_week'];
const ch = (a: Args) => (a.channel ? ` on ${CHANNELS[a.channel]}` : '');
const mer = (a: Args) => (a.merchant ? ` for ${a.merchant}` : '');
const QUESTION: Record<string, (a: Args) => string> = {
  network_summary: (a) => `Network summary for ${per(a)}${ch(a)}${mer(a)}`,
  explain_merchant: (a) => `Why was ${a.merchant} flagged?`,
  merchant_health: (a) => `health of ${a.merchant}`,
  open_incidents: (a) => `Show unresolved incidents and exposure${mer(a)}`,
  forecast: (a) => `Forecast for the next 7 days${mer(a)}`,
  channel_activity: (a) => `Which channels show concurrent abnormal behaviour ${per(a)}${ch(a)}`,
  top_declines: (a) => `Which merchants have the most declines ${per(a)}`,
  activity_shortfall: (a) => `Which merchants had the largest activity shortfall ${per(a)}`,
  next_checks: (a) => `What should I check first${mer(a)}`,
};
const NEEDS_MERCHANT = new Set(['explain_merchant', 'merchant_health']);

function runTool(name: string, raw: string, lang: Lang): { result: unknown; display?: Display } {
  let a: Args;
  try { a = JSON.parse(raw || '{}'); } catch { return { result: { error: 'Arguments must be JSON.' } }; }
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return { result: { error: 'Arguments must be an object.' } };
  if (isAppTool(name)) return runAppTool(name, a as Record<string, unknown>, { lang });
  const make = QUESTION[name];
  if (!make) return { result: { error: `Unknown tool ${name}.` } };
  if (a.period !== undefined && !(a.period in PERIODS)) return { result: { error: `Unknown period ${a.period}.` } };
  if (a.channel !== undefined && !(a.channel in CHANNELS)) return { result: { error: `Unknown channel ${a.channel}.` } };
  if (a.merchant !== undefined) {
    a.merchant = String(a.merchant).toUpperCase();
    if (!/^MER-\d{4}$/.test(a.merchant)) return { result: { error: 'Merchant ids look like MER-1234.' } };
    if (!model().byMerchant.has(a.merchant)) return { result: { error: `${a.merchant} is not in this run.` } };
  }
  if (NEEDS_MERCHANT.has(name) && !a.merchant) return { result: { error: 'This tool needs a merchant id.' } };
  const forModel = answer(make(a), 'en');                 // the model reads English results (as benchmarked)
  const reply = lang === 'en' ? forModel : answer(make(a), lang); // the table, links and scope shown in the user's language
  return { display: reply, result: { text: forModel.text, table: forModel.table, scope: forModel.scope, evidence: forModel.evidence.map((e) => e.label), intent: forModel.intent } };
}

/* ── output check: every number in the answer must appear in the tool results or the question ── */
const NUM = /(?<![\p{L}\d])(?:\d{1,3}(?:[\u00a0\u202f ]\d{3}(?!\d))+|\d+)(?:[.,]\d+)*(?:\s?[kKM](?![\p{L}]))?(?![\p{L}\d])/gu; // 1 052 is one number, 3 8 is two; digits inside words (ta3, 28th) are not numbers
function values(tok: string): number[] {
  const t = tok.replace(/[   ]/g, '');
  const mult = /k$/i.test(t) ? 1e3 : /M$/.test(t) ? 1e6 : 1;
  const body = t.replace(/[kKM]$/, '');
  const out = new Set<number>();
  const dec = Number(body.replace(/,/g, '.'));                       // 10,7 -> 10.7
  if (!Number.isNaN(dec)) out.add(dec * mult);
  if (/^\d{1,3}([.,]\d{3})+$/.test(body)) out.add(Number(body.replace(/[.,]/g, '')) * mult); // 1,234 / 1.234 -> 1234
  return [...out].map((v) => Math.round(v * 1000) / 1000);
}
/** Numbers in the answer that appear nowhere in the tool results or the question (empty = all good). */
function unknownNumbers(text: string, sources: string): string[] {
  const known = new Set<number>();
  for (const tok of sources.match(NUM) ?? []) for (const v of values(tok)) known.add(v);
  for (const d of sources.match(/\d+/g) ?? []) known.add(Number(d));      // parts of dates, ids, ranges
  const exact = [...known];
  // "383 k" / "5.0 M" may round a known amount to that unit; every other number must match exactly
  const rounded = (tok: string, v: number) => { const u = /k\s*$/i.test(tok) ? 1e3 : /M\s*$/.test(tok) ? 1e6 : 0; return u > 0 && exact.some((x) => Math.abs(x - v) <= u / 2); };
  return (text.match(NUM) ?? []).filter((tok) => !values(tok).some((v) => known.has(v) || rounded(tok, v))).map((t) => t.trim());
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\[[^\]]*\b(link|lien|pdf|csv|url)\b[^\]]*\]/gi, '').replace(/[ \t]{2,}/g, ' ').trim(); // links are shown under the answer, never written in it
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

type Msg = { role: string; content: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };

async function chat(messages: Msg[], tools: Tool[], signal: AbortSignal, force?: string) {
  const res = await fetch(`${URL_}/chat/completions`, {
    method: 'POST', signal, cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    // `force` names the one tool the model must call (vLLM named function calling)
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: force ? { type: 'function', function: { name: force } } : 'auto', temperature: 0, max_tokens: 1500 }), // room for a report spec
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message as Msg | undefined;
}

export const llmEnabled = () => !!URL_;

/** Is the model reachable right now? Cached a few seconds; 'off' when LLM_URL is not set. */
let statusCache: { at: number; v: 'online' | 'offline' } | null = null;
export async function modelStatus(): Promise<'online' | 'offline' | 'off'> {
  if (!URL_) return 'off';
  if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.v;
  let v: 'online' | 'offline' = 'offline';
  try { const r = await fetch(`${URL_}/models`, { signal: AbortSignal.timeout(2000), cache: 'no-store' }); v = r.ok ? 'online' : 'offline'; } catch { v = 'offline'; }
  statusCache = { at: Date.now(), v };
  return v;
}

const PAGE_TOOL = { type: 'function' as const, function: { name: 'page_context', description: 'What the user is looking at right now: the page, its filters and the figures behind each panel and chart, under the names shown on screen. Call it whenever the question is about "this", "here", this page, this chart or one of its panels.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };
// "this", "hada", "ça" with nothing newly selected: the user still means what they selected just before
const DEICTIC = /\b(this|that|these|those|it|here|hada|hadi|hadou|hna|ca|cela|ce|cette|ces|celui|celle|ici)\b|هذا|هذه|هاد|هادي|هنا/;

const SELECTION_NOTE = `\nThe question may come with parts of the page the user selected (text, a chart bar, a table row, a card or a panel), listed after it. Answer about those parts first, in plain words: what they show and whether anything is unusual. Use day_detail for a selected bar or row with a date, explain_merchant, incident_detail or merchant_health for an id in it, and page_context for the panel around it.`;
const pageNote = (p: PageContext) => `\n\nThe user is asking from the page "${p.title}" (panels: ${p.panels.join(', ')}). Questions about "this", "here", this page, a chart or one of these panels refer to it: call page_context and explain from its figures, in plain words, what the panel shows and what stands out.`;
const CASE_ACTION = /\b(close|assign|acknowledge|escalate|reopen|ferme[rz]?|cloture[rz]?|assigne[rz]?|acquitte[rz]?|escalade[rz]?)\b/;
const REPORT_WORD = /\b(report|rapport|section|title|titre|chart|graph|graphique|table|tableau|summary|resume|pdf|brief)\b/;
// a change to the report being worked on ("add…", "remove…", "ajoute…", "zid…")
const CHANGE = /\b(add|remove|delete|drop|replace|change|rename|move|reorder|shorten|shorter|longer|translate|put|include|exclude|swap|ajoute[rz]?|enleve[rz]?|supprime[rz]?|remplace[rz]?|change[rz]?|deplace[rz]?|raccourci[rs]?|tradui[st]|mets|inclu[st]|zid|na7i|beddel)\b/;
// asks for a file: never answer it with a page summary
const WANTS_FILE = /\b(pdf|reports?|rapports?|brief|csv|exports?|exporte[rz]?|telecharg\w*|download)\b/;
/** The report a change request refers to: the one on screen, else the latest one in this conversation. */
function activeReport(owner: string, page: PageContext | null, history: Turn[]): StoredReport | null {
  const onPage = page?.path.match(/^\/reports\/([a-f0-9]{16})/)?.[1];
  if (onPage) return getReport(owner, onPage);
  for (let i = history.length - 1; i >= 0; i--) { const t = history[i]; if (t.role === 'assistant' && t.reply.report) return getReport(owner, t.reply.report.id); }
  return null;
}

/** compose_report: validate the spec, fill it from the engine, check the model's own text, save it. */
function compose(raw: string, sources: string, owner: string | null, lang: Lang): { result: unknown; display?: Display } {
  let args: Record<string, unknown>;
  try { args = JSON.parse(raw || '{}'); } catch { return { result: { error: 'Arguments must be JSON.' } }; }
  if (!owner) return { result: { error: 'Reports need a signed-in account.' } };
  const editing = typeof args.report_id === 'string' ? getReport(owner, args.report_id) : null;
  if (args.report_id && !editing) return { result: { error: `Report ${String(args.report_id)} not found: leave report_id out to create a new one.` } };
  const { spec, errors } = validateSpec(args);
  if (!spec) return { result: { error: `Fix the report and call compose_report again: ${errors.join('; ')}.` } };
  const built = buildReport(spec);
  // text sections are written from the report's figures: hand them back first, save nothing yet
  const todo = unwrittenText(spec);
  if (todo.length) return { result: { status: 'figures ready, nothing saved yet', write_text_sections: todo, figures: reportSummary(built), next: `Call compose_report again${editing ? ` with report_id "${editing.id}"` : ''} and the same title and sections, now with the real body of text section(s) ${todo.join(', ')}, written from these figures only, in the user's language.` } };
  // the model's own words (title, notes, text sections) may only carry figures from the data
  const words = [spec.title, spec.subtitle, ...spec.sections.flatMap((x) => [x.title, x.note, x.body])].filter(Boolean).join('\n');
  const bad = unknownNumbers(words, `${sources}\n${JSON.stringify(built)}\n${editing ? JSON.stringify(editing.spec) : ''}`);
  if (bad.length) return { result: { error: `The report text contains figures that are not in the data: ${bad.join(', ')}. Remove them, or get them from a tool first, then call compose_report again.` } };
  const saved = editing ? updateReport(owner, editing.id, spec)! : saveReport(owner, spec), fr = lang === 'fr';
  return {
    result: { report_id: saved.id, version: saved.version, changed: !!editing, report: spec.title, sections: reportSummary(built), preview_and_pdf: 'shown under the answer' },
    display: { intent: 'compose_report', report: { id: saved.id, version: saved.version ?? 1, title: spec.title }, scope: `${fr ? 'Rapport' : 'Report'}: ${spec.title} · ${spec.sections.length} section(s) · version ${saved.version ?? 1} · ${fr ? 'exécution moteur' : 'engine run'} ${model().snap.run.run_id}`,
      evidence: [{ label: fr ? 'Télécharger le PDF' : 'Download PDF', href: `/api/v1/reports/pdf?id=${saved.id}` }, { label: fr ? 'Ouvrir le rapport' : 'Open the report', href: `/reports/${saved.id}` }] },
  };
}

/** Earlier turns of the conversation as chat messages (question and final answer text only). */
function historyMessages(history: Turn[]): Msg[] {
  const out: Msg[] = [];
  for (const t of history.slice(-2 * HISTORY_TURNS)) {
    if (t.role === 'user') out.push({ role: 'user', content: `${t.text}${t.selection?.length ? `\n(with selected: ${t.selection.map((x) => x.label).join('; ')})` : ''}${t.page ? `\n(asked on the page "${t.page.title}")` : ''}` });
    else out.push({ role: 'assistant', content: t.reply.text.join('\n').slice(0, HISTORY_CHARS) || '…' });
  }
  return out;
}

/** Why the assistant could not answer. There is no substitute answer: a figure from rules written
 *  for an earlier dataset could be wrong, so the user sees an error instead. */
export class ModelError extends Error {
  constructor(public code: 'model_off' | 'model_offline' | 'model_rejected', message: string) { super(message); }
}

/** The assistant entry point: guards, then the model with the conversation so far and the tools,
 *  then the output check. Throws ModelError when the model is missing, unreachable or unverified. */
export async function ask(question: string, history: Turn[] = [], page: PageContext | null = null, selection: Selection[] = [], owner: string | null = null): Promise<Reply> {
  const q = question.trim().slice(0, 500);
  if (!selection.length && page && DEICTIC.test(norm(q))) {
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    const samePage = lastUser?.role === 'user' && lastUser.page?.href.split('?')[0] === page.path.split('?')[0];
    if (lastUser?.role === 'user' && samePage && lastUser.selection?.length) selection = lastUser.selection;
  }
  let guarded = answer(q);
  // "remove the incidents section" edits a report, it is not a case action: only real case actions stay refused
  if (guarded.refused === 'write' && owner && !CASE_ACTION.test(norm(q)) && (REPORT_WORD.test(norm(q)) || activeReport(owner, page, history))) guarded = answer('summary');
  // guards first: refused questions never reach the model (a refusal states no figure)
  if (guarded.refused === 'prohibited' || guarded.refused === 'card_data' || guarded.refused === 'write') return { ...guarded, source: 'rules' };
  if (!URL_) throw new ModelError('model_off', 'The assistant needs its language model, and none is configured (LLM_URL).');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const { prompt, tools: base } = loadContract();
    const tools = [...base, ...appToolDefs(), ...(owner ? [composeToolDef()] : []), ...(page ? [PAGE_TOOL] : [])] as Tool[];
    const run = model().snap.run;
    const asOf = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${run.as_of}T00:00:00Z`)).replace(',', '');
    const system = prompt.replace('{{AS_OF}}', asOf).replace('{{RUN_ID}}', run.run_id) + (page ? pageNote(page) : '') + (selection.length ? SELECTION_NOTE : '');
    const block = selectionBlock(selection);
    const past = historyMessages(history);
    // earlier turns may be in another language: the reply follows the current message (rule 6)
    let sys = past.length ? `${system}\nAnswer the latest message in its own language, even if earlier turns used another one.` : system;
    const active = owner ? activeReport(owner, page, history) : null;
    if (active) sys += `\nThe report being worked on (report_id ${active.id}, version ${active.version ?? 1}): ${JSON.stringify(active.spec)}\nIf the user asks to change, add, remove, reorder, rename, shorten or translate anything in it, call compose_report with report_id "${active.id}" and the complete updated title and sections, keeping everything else exactly as it is. Only create a new report when they ask for a new one.`;
    const lang = detectLang(q);
    if (owner && WANTS_FILE.test(norm(q))) {
      if (!/[\u0600-\u06FF]/.test(q) && lang === 'en') sys += '\nWrite the report in English unless the user asks for another language.';
      sys += '\nFor a report, respect exactly what the user specifies (topics, order, filters, period, title, length, language): use compose_report with only those sections. Use generate_report only when they ask for one of the standard briefs as it is.';
    }
    const messages: Msg[] = [{ role: 'system', content: sys }, ...past, { role: 'user', content: q + block }];
    const used: Display[] = [];
    // numbers may come from this turn's tool results, the question, or earlier (already checked)
    // turns; not from the rules text, whose own numbers (rules 1–11) must not whitelist anything
    let repaired = false, nudged = false, madeFile = false, force: string | undefined;
    const wantsFile = WANTS_FILE.test(norm(q)) || (!!active && CHANGE.test(norm(q)));
    let sources = `${active ? JSON.stringify(active.spec) : ''}\n${q}${block}\n${asOf}\n${run.run_id}\n${past.map((m) => m.content).join('\n')}`;
    const rounds = wantsFile ? MAX_ROUNDS + 2 : MAX_ROUNDS; // a report may need figures first, then its text
    for (let round = 0; round < rounds; round++) {
      const msg = await chat(messages, tools, ctrl.signal, force);
      force = undefined;
      if (!msg) { console.warn('[assistant] model returned no message'); break; }
      if (!msg.tool_calls?.length) {
        const text = clean(msg.content ?? '');
        if (!text) { console.warn('[assistant] model returned an empty answer'); break; }
        // a file was asked for but none was made: the answer would point at a link that does not exist
        if (wantsFile && !madeFile) {
          if (nudged || round === rounds - 1) { console.warn('[assistant] file requested but no file tool called'); break; }
          nudged = true;
          // second chance with the tool imposed: the model only chooses the scope
          force = /\b(csv|exports?|exporte[rz]?)\b/.test(norm(q)) ? 'export_data' : owner ? 'compose_report' : 'generate_report';
          console.warn(`[assistant] file requested without a tool call: asking again with ${force} imposed`);
          // the reply without a tool is dropped, so it cannot steer the retry (or its language)
          const say = !/[\u0600-\u06FF]/.test(q) && lang === 'en' ? 'Answer in English.' : 'Answer in the language of that request.';
          messages.push({ role: 'user', content: `You have not created the file yet. Call ${force} with the scope of my request ("${q}"). ${say}` });
          continue;
        }
        if (PROHIBITED.test(norm(text))) { console.warn('[assistant] model answer rejected: prohibited term'); break; }
        const bad = unknownNumbers(text, sources);
        if (bad.length) {
          console.warn(`[assistant] model answer ${repaired ? 'rejected' : 'sent back'}: ${bad.join(', ')} not in the tool results`);
          if (process.env.LLM_DEBUG) console.warn(text);
          if (repaired || round === rounds - 1) break;
          // one repair round: the model restates its answer with the exact figures
          repaired = true;
          messages.push({ role: 'assistant', content: msg.content ?? '' }, { role: 'user', content: `Your answer contains figures that are not in the tool results: ${bad.join(', ')}. Rewrite the same answer, in the same language, using only the exact figures from the tool results (no rounding).` });
          continue;
        }
        const lead = used[used.length - 1];
        const evidence = [...new Map(used.flatMap((r) => r.evidence).map((e) => [e.href, e])).values()];
        return {
          lang, intent: lead?.intent ?? 'model', text: text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean),
          table: used.find((r) => r.table)?.table, evidence, scope: lead?.scope ?? '', suggestions: guarded.suggestions, source: 'model', model: 'online', report: [...used].reverse().find((r) => r.report)?.report,
        };
      }
      if (process.env.LLM_DEBUG) console.warn(`[assistant] round ${round + 1}: ${msg.tool_calls.map((t) => `${t.function?.name}(${t.function?.arguments})`).join(', ')}`);
      if (round === rounds - 1) console.warn('[assistant] model still calling tools after the last round');
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        if (tc.function?.name === 'generate_report' || tc.function?.name === 'export_data') madeFile = true;
        const composed = tc.function?.name === 'compose_report' ? compose(tc.function.arguments, sources, owner, lang) : null;
        if (composed?.display) madeFile = true;
        const { result, display } = composed ? composed : tc.function?.name === 'page_context' && page
          ? { result: { page: page.title, panels: page.panels, ...page.data }, display: { intent: 'page', evidence: [], scope: `Scope: ${page.title} · engine run ${run.run_id}` } as Display }
          : runTool(tc.function?.name, tc.function?.arguments, lang);
        if (display) used.push(display);
        const content = JSON.stringify(result);
        sources += `\n${content}`;
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
    }
    // the report was saved but the rounds ran out before the model wrote its answer: still show it
    const made = [...used].reverse().find((d) => d.report);
    if (made?.report) {
      const fr = detectLang(q) === 'fr';
      return { lang: detectLang(q), intent: 'compose_report', text: [fr ? `Le rapport « ${made.report.title} » est prêt : aperçu ci-dessous.` : `The report “${made.report.title}” is ready: preview below.`], evidence: made.evidence, scope: made.scope ?? '', suggestions: guarded.suggestions, source: 'model', model: 'online', report: made.report };
    }
  } catch (e) {
    console.warn('[assistant] model unavailable:', e instanceof Error ? e.message : e);
    statusCache = { at: Date.now(), v: 'offline' };
    throw new ModelError('model_offline', 'The language model is unreachable right now. Try again in a moment.');
  } finally {
    clearTimeout(timer);
  }
  // reachable, but no answer passed the checks: say so rather than show an unverified one
  throw new ModelError('model_rejected', 'The assistant could not produce a verified answer. Try rephrasing the question.');
}
