// Small helpers for the /api/v1 route handlers (SRS §13): auth, safe errors with a request id.
import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { COOKIE, decode, type User } from './session';

export function fail(status: number, code: string, message: string) {
  // Safe error: code, message, request id. Never a stack trace or the input values (SRS §13).
  return Response.json({ error: { code, message, request_id: crypto.randomUUID() } }, { status });
}

export function userOf(req: NextRequest): User | null {
  return decode(req.cookies.get(COOKIE)?.value);
}

export const params = (req: NextRequest) => Object.fromEntries(req.nextUrl.searchParams.entries()) as Record<string, string>;

/** RFC 4180 CSV. Only sanitized columns are ever passed in (no card field). */
export function csv(header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
