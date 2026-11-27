import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { liveReplay, ReplayError } from '@/lib/live';
import { can, canSee } from '@/lib/session';

async function replay(req: NextRequest, write: boolean) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!canSee(user, '/live') || (write && !can(user, 'replay'))) {
    return fail(403, 'forbidden', 'Your account lacks the requested live replay permission.');
  }
  const query = req.nextUrl.searchParams;
  const request = new URLSearchParams();
  for (const key of ['kind', 'name', 'limit']) {
    const value = query.get(key);
    if (value && value.length <= 100) request.set(key, value);
  }
  let command: unknown;
  if (write) {
    const site = req.headers.get('sec-fetch-site');
    const origin = req.headers.get('origin');
    const host = req.headers.get('host');
    if ((site && site !== 'same-origin') ||
        (origin && origin !== req.nextUrl.origin && origin !== `${req.nextUrl.protocol}//${host}`)) {
      return fail(403, 'forbidden', 'Use replay controls from the platform.');
    }
    if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') {
      return fail(415, 'invalid_content_type', 'Expected a JSON request.');
    }
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          void reader.cancel();
          return fail(413, 'request_too_large', 'Replay request is too large.');
        }
        chunks.push(value);
      }
    }
    try { command = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { return fail(400, 'invalid_json', 'Expected a replay command.'); }
  }
  try {
    return Response.json(await liveReplay(user.id, request, command), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return error instanceof ReplayError
      ? fail(error.status, 'live_replay_error', error.message)
      : fail(503, 'live_replay_unavailable', 'The local replay service is unavailable.');
  }
}

export const GET = (req: NextRequest) => replay(req, false);
export const POST = (req: NextRequest) => replay(req, true);
