// GET /api/v1/assistant/conversations: the caller's saved conversations, most recent first.
import type { NextRequest } from 'next/server';
import { listConversations } from '@/lib/conversations';
import { fail, userOf } from '@/lib/http';

export async function GET(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in to see your conversations.');
  return Response.json({ conversations: listConversations(user.role) });
}
