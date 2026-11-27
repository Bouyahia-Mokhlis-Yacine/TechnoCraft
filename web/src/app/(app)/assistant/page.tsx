import { AssistantSkeleton } from '@/components/skeletons';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Chat } from '@/components/chat';
import { PageHeader, flat } from '@/components/ui';
import { cookies } from 'next/headers';
import { currentUser } from '@/lib/session';
import { getConversation, listConversations } from '@/lib/conversations';
import { getT } from '@/lib/i18n/server';
import { ViewBanner } from '@/components/dataset';
import { resolveView } from '@/lib/dataset';
import { connection } from 'next/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.assistant') };
}
type SP = Promise<Record<string, string | string[] | undefined>>;

const EXAMPLES = {
  en: ['Which merchants had the largest activity shortfall this week?', 'Why was MER-6434 flagged, and what should I check?', 'What if e-commerce goes down for 3 hours tomorrow at 10:00?', 'Prepare this week’s management report as a PDF'],
  fr: ['Quels commerçants ont eu la plus forte baisse d’activité cette semaine ?', 'Pourquoi MER-6434 a-t-il été signalé, et que dois-je vérifier ?', 'Et si l’e-commerce tombe en panne 3 heures demain à 10:00 ?', 'Prépare le rapport de gestion de cette semaine en PDF'],
};

export default function AssistantPage({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<AssistantSkeleton />}><Assistant searchParams={searchParams} /></Suspense>;
}

async function Assistant({ searchParams }: { searchParams: SP }) {
  await connection();
  const p = flat(await searchParams);
  const t = await getT();
  const view = await resolveView(p.run);
  const user = await currentUser();
  const conversations = user ? listConversations(user.id) : [];
  const conversation = user ? getConversation(user.id, p.c) : null;
  const folded = (await cookies()).get('pai-rail')?.value === 'folded';
  return (
    <div className="assistant-page">
      <PageHeader title={t('asst.title')} />
      <ViewBanner view={view} path="/assistant" />
      <Chat initial={conversation ? undefined : p.q} examples={EXAMPLES} conversations={conversations} conversation={conversation} folded={folded} />
    </div>
  );
}
