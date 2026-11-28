// Append-only review ledger (SRS FR-07, FR-29): every action records actor, time, reason and
// previous/new state. Reviews never touch the official flags, scores or raw inputs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from './snapshot';

export type ReviewStatus = 'new' | 'acknowledged' | 'assigned' | 'closed';
export type Action = 'comment' | 'acknowledge' | 'assign' | 'escalate' | 'close' | 'reopen' | 'export' | 'account' | 'activate' | 'rule';
export interface ReviewEvent {
  event_id: string; ts: string; actor: string; action: Action; target: string; run_id: string;
  reason: string; owner?: string; prior: ReviewStatus; next: ReviewStatus; escalated: boolean; version: number;
}
export interface CaseState { status: ReviewStatus; owner: string | null; escalated: boolean; version: number; history: ReviewEvent[] }

const file = () => path.join(/*turbopackIgnore: true*/ runsDir(), 'reviews.jsonl');

export function readAll(): ReviewEvent[] {
  try {
    return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

export function caseState(target: string, events = readAll()): CaseState {
  const history = events.filter((e) => e.target === target && e.action !== 'export' && e.action !== 'account');
  const last = history[history.length - 1];
  return {
    status: last?.next ?? 'new', escalated: last?.escalated ?? false, version: history.length, history,
    owner: [...history].reverse().find((e) => e.owner)?.owner ?? null,
  };
}

const NEXT: Record<Exclude<Action, 'export' | 'account' | 'activate' | 'rule'>, (s: ReviewStatus) => ReviewStatus | null> = {
  comment: (s) => s,
  acknowledge: (s) => (s === 'new' ? 'acknowledged' : null),
  assign: (s) => (s === 'closed' ? null : 'assigned'),
  escalate: (s) => (s === 'closed' ? null : s),
  close: (s) => (s === 'closed' ? null : 'closed'),
  reopen: (s) => (s === 'closed' ? 'acknowledged' : null),
};

export class ReviewError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Validate and append one review action. `version` must match (409 on a stale view). */
export function applyReview(input: { target: string; run_id: string; actor: string; action: Action; reason: string; owner?: string; version: number }): CaseState {
  const state = caseState(input.target);
  if (input.version !== state.version) throw new ReviewError(409, 'This incident changed since you opened it. Reload to see the latest state.');
  if (input.action === 'export' || input.action === 'account' || input.action === 'activate' || input.action === 'rule') throw new ReviewError(400, 'Unsupported action.');
  const next = NEXT[input.action](state.status);
  if (next === null) throw new ReviewError(422, `Cannot ${input.action} an incident that is ${state.status}.`);
  if ((input.action === 'close' || input.action === 'escalate' || input.action === 'comment') && !input.reason.trim()) throw new ReviewError(422, 'A reason is required for this action.');
  if (input.action === 'assign' && !input.owner?.trim()) throw new ReviewError(422, 'Choose who owns the incident.');
  appendEvent({ ...input, prior: state.status, next, escalated: input.action === 'escalate' ? true : input.action === 'close' ? false : state.escalated, version: state.version + 1 });
  return caseState(input.target);
}

export function appendEvent(e: Omit<ReviewEvent, 'event_id' | 'ts'>) {
  const ev: ReviewEvent = { event_id: crypto.randomUUID(), ts: new Date().toISOString(), ...e, reason: e.reason.slice(0, 500) };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.appendFileSync(file(), `${JSON.stringify(ev)}\n`);
}
