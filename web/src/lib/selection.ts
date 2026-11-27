// Parts of a page the user selected and attached to a question (assistant dock): highlighted text,
// or an element picked on the page (a chart bar, a table row, a card, a panel). Shared by the
// browser (which captures them) and the server (which checks them and shows them to the model).

export interface Selection {
  kind: 'text' | 'chart element' | 'chart' | 'table row' | 'card' | 'panel' | 'element';
  label: string;                    // short chip label
  panel?: string;                   // title of the panel it sits in
  text?: string;                    // visible text (or the highlighted text)
  tip?: string;                     // chart tooltip lines (date, value, expected…)
  date?: string;                    // ISO date of a chart bar
  table?: Record<string, string>;   // table row: column → cell
  links?: string[];                 // in-app links inside it (ids: /merchants/MER-…, /incidents/INC-…)
}

export const MAX_SELECTIONS = 4;
const KINDS = new Set<Selection['kind']>(['text', 'chart element', 'chart', 'table row', 'card', 'panel', 'element']);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+\n/g, '\n').trim().slice(0, max) : undefined);

/** Keep only well-formed, bounded fields (the browser sends them; never trust their shape). */
export function sanitizeSelections(raw: unknown): Selection[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SELECTIONS).flatMap((x): Selection[] => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    const kind = KINDS.has(o.kind as Selection['kind']) ? (o.kind as Selection['kind']) : 'element';
    const table = o.table && typeof o.table === 'object' && !Array.isArray(o.table)
      ? Object.fromEntries(Object.entries(o.table as Record<string, unknown>).slice(0, 14).map(([k, v]) => [k.slice(0, 40), str(v, 120) ?? '']))
      : undefined;
    const links = Array.isArray(o.links) ? o.links.filter((l): l is string => typeof l === 'string' && /^\/[\w\-/%.?=&]*$/.test(l) && !l.startsWith('/api')).slice(0, 6).map((l) => l.slice(0, 120)) : undefined;
    const s: Selection = { kind, label: str(o.label, 80) || kind, panel: str(o.panel, 80), text: str(o.text, 900), tip: str(o.tip, 300), date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.date)) ? String(o.date) : undefined, table, links };
    return s.text || s.tip || s.table ? [s] : [];
  });
}

/** The selections as a block appended to the user's question for the model. */
export function selectionBlock(sel: Selection[]): string {
  if (!sel.length) return '';
  const lines = sel.map((s, i) => {
    const parts = [`${i + 1}. ${s.kind}${s.panel ? ` in the panel "${s.panel}"` : ''}${s.date ? `, date ${s.date}` : ''}`];
    if (s.tip) parts.push(`   chart values: ${s.tip.replace(/\n/g, ' · ')}`);
    if (s.table) parts.push(`   row: ${Object.entries(s.table).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    if (s.text && !s.table) parts.push(`   text: ${s.text.replace(/\n+/g, ' / ')}`);
    if (s.links?.length) parts.push(`   links: ${s.links.join(', ')}`);
    return parts.join('\n');
  });
  return `\n\n[The user selected these parts of the page and is asking about them]\n${lines.join('\n')}`;
}
