import { liveReplay } from './live';
import type { PageContext } from './page-context';
import { fmtNum } from './format';

export const LIVE_QUESTION = /\b(live monitoring|replay|early warning|intraday|simulated daily closure)\b/i;

export async function liveContext(account: string, question: string): Promise<PageContext> {
  const merchant = question.match(/\bMER-\d{4}\b/i)?.[0].toUpperCase();
  const channelPatterns: [RegExp, string][] = [
    [/\b(e-commerce|ecommerce)\b/i, 'ecommerce'], [/\b(pos|terminal)\b/i, 'pos'],
    [/\bmobile\b/i, 'mobile'], [/\b(nfc|contactless)\b/i, 'nfc'], [/\btransfer\b/i, 'transfer'],
  ];
  const channel = channelPatterns.find(([pattern]) => pattern.test(question))?.[1];
  const query = new URLSearchParams({ limit: '1' });
  if (merchant || channel) {
    query.set('kind', merchant ? 'merchant' : 'channel');
    query.set('name', merchant ?? channel!);
  }
  const title = 'Simulated Live Monitoring — Historical Replay';
  const page: PageContext = {
    path: '/live', title, link: { label: 'Open Live Monitoring', href: '/live' },
    panels: ['Live activity', 'Intraday early warnings', 'Collective advisories', 'Simulated daily closure'],
    data: {}, summary: [],
  };
  try {
    const replay = await liveReplay(account, query);
    const item = replay.points?.[0];
    const name = replay.scope?.[1] ?? 'the payment network';
    const warnings = replay.warnings?.filter(w => (!merchant || w.scope[1] === merchant || w.merchants?.includes(merchant))
      && (!channel || w.scope[1] === channel)) ?? [];
    const closure = replay.daily?.at(-1);
    page.data = { mode: replay.mode, status: replay.status, clock: replay.clock, watermark: replay.watermark,
      scope: replay.scope, interval: item, feed: replay.feed, last_event: replay.last_event,
      reference_days: replay.reference_days, monitoring: replay.monitoring, warnings: warnings.slice(0, 8),
      simulated_daily_closure: closure };
    if (replay.status === 'idle') {
      page.summary = ['No historical replay is running for your account.'];
      return page;
    }
    page.summary = [
      `Historical replay is ${replay.status} at simulated time ${replay.clock?.replace('T', ' ')}. ${replay.feed}.`,
      ...(item ? [`${name} recorded ${item.observed} transactions in the latest finalized interval, with ${fmtNum(item.expected, 1)} expected on ${replay.reference_days} prior dates.`] : []),
      ...(warnings.length ? warnings.slice(0, 3).map(w => `${w.kind}, ${w.state}. ${w.explanation} ${w.action}`) : ['There are no recorded warnings for this replay scope.']),
      closure ? `The simulated daily batch on ${closure.date} is ${closure.status}. The frozen daily detector scored ${closure.scored} merchant-days and flagged ${closure.flagged.length}.`
        : 'The simulated daily detector is awaiting batch closure.',
    ];
  } catch {
    page.data = { error: 'Replay service unavailable.' };
    page.summary = ['The replay service is unavailable.'];
  }
  return page;
}
