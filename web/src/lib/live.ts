import 'server-only';
import type { ReplaySnapshot } from './live-types';

export class ReplayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function liveReplay(account: string, params = new URLSearchParams(), command?: unknown): Promise<ReplaySnapshot> {
  const token = process.env.LIVE_MONITORING_TOKEN;
  if (!token) throw new ReplayError(503, 'The local replay service is unavailable.');
  try {
    const url = new URL('/replay', process.env.LIVE_MONITORING_URL ?? 'http://127.0.0.1:8765');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Expected loopback address');
    url.search = params.toString();
    const response = await fetch(url, {
      method: command === undefined ? 'GET' : 'POST',
      body: command === undefined ? undefined : JSON.stringify(command),
      headers: { Authorization: `Bearer ${token}`, 'X-Replay-Account': account, 'Content-Type': 'application/json' },
      cache: 'no-store', signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 400) throw new ReplayError(400, body.error);
      throw new ReplayError(503, 'The local replay service is unavailable.');
    }
    return body;
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError(503, 'The local replay service is unavailable.');
  }
}
