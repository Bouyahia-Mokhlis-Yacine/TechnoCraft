import { AssistantSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Chat } from '@/components/chat';
import { PageHeader, flat } from '@/components/ui';
import { cookies } from 'next/headers';
import { currentUser } from '@/lib/session';
import { getConversation, listConversations } from '@/lib/conversations';

export const metadata: Metadata = { title: 'Assistant' };
type SP = Promise<Record<string, string | string[] | undefined>>;

const EXAMPLES = {
  en: ['Which merchants had the largest activity shortfall this week?', 'Why was MER-6434 flagged, and what should I check?', 'What if e-commerce goes down for 3 hours tomorrow at 10:00?', 'Prepare this week’s management report as a PDF'],
  fr: ['Pourquoi MER-1494 a-t-il été signalé ?', 'Compare MER-6434 et MER-1494'],
};

export default function AssistantPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<AssistantSkeleton />}><Assistant searchParams={searchParams} /></Suspense>;
}

async function Assistant({ searchParams }: { searchParams: SP }) {
  const p = flat(await searchParams);
  const user = await currentUser();
  const conversations = user ? listConversations(user.role) : [];
  const conversation = user ? getConversation(user.role, p.c) : null;
  const folded = (await cookies()).get('pai-rail')?.value === 'folded';
  return (
    <div className="assistant-page">
      <PageHeader title="Ask the dashboard" />
      <Chat initial={conversation ? undefined : p.q} examples={EXAMPLES} conversations={conversations} conversation={conversation} folded={folded} />
    </div>
  );
}
