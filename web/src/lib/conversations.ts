// Saved assistant conversations: one JSON file per conversation in runs/conversations/, owned by
// the signed-in account (one demo account per role). Runtime state, like reviews.jsonl.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Reply } from './assistant';
import { runsDir } from './snapshot';
import type { Selection } from './selection';

export type Turn = { role: 'user'; text: string; at: string; page?: { title: string; href: string }; selection?: Selection[] } | { role: 'assistant'; reply: Reply; at: string };
export interface Conversation { id: string; owner: string; title: string; created: string; updated: string; turns: Turn[] }
export interface ConversationInfo { id: string; title: string; updated: string; questions: number }

const dir = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'conversations');
const ID = /^[a-f0-9]{16}$/;
const file = (id: string) => path.join(/*turbopackIgnore: true*/ dir(), `${id}.json`);
const read = (id: string): Conversation | null => {
  if (!ID.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
};

/** The conversation, if it belongs to this account. */
export function getConversation(owner: string, id: string | undefined | null): Conversation | null {
  const c = id ? read(id) : null;
  return c && c.owner === owner ? c : null;
}

export function listConversations(owner: string): ConversationInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => read(n.slice(0, -5))).filter((c): c is Conversation => !!c && c.owner === owner)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map((c) => ({ id: c.id, title: c.title, updated: c.updated, questions: c.turns.filter((t) => t.role === 'user').length }));
}

const titleOf = (q: string) => { const t = q.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t; };

/** Append one question and its reply; creates the conversation when `id` is missing or not the owner's. */
export function appendTurn(owner: string, id: string | undefined | null, question: string, reply: Reply, page?: { title: string; href: string }, selection?: Selection[]): Conversation {
  const now = new Date().toISOString();
  const c = getConversation(owner, id) ?? { id: crypto.randomBytes(8).toString('hex'), owner, title: titleOf(question), created: now, updated: now, turns: [] };
  c.turns.push({ role: 'user', text: question, at: now, ...(page ? { page } : {}), ...(selection?.length ? { selection } : {}) }, { role: 'assistant', reply, at: now });
  c.updated = now;
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(c.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, file(c.id));
  return c;
}

export function deleteConversation(owner: string, id: string): boolean {
  if (!getConversation(owner, id)) return false;
  fs.rmSync(file(id), { force: true });
  return true;
}

export function renameConversation(owner: string, id: string, title: string): Conversation | null {
  const c = getConversation(owner, id);
  if (!c) return null;
  c.title = titleOf(title) || c.title;
  fs.writeFileSync(file(id), JSON.stringify(c));
  return c;
}
