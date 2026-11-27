// Server-side PDF of a Reports page brief: headless Chromium prints the same page the user sees
// (print styles, self-hosted fonts, Arabic shaping), so the PDF and the screen never disagree.
// Chromium comes from the local Playwright install; set PDF_CHROMIUM to use another binary.
import type { Browser } from 'playwright-core';

export type BriefType = 'daily' | 'weekly' | 'merchant' | 'alerts';
export interface BriefParams { type: BriefType; date?: string; merchant?: string; from?: string; to?: string; severity?: string; channel?: string }

let browser: Promise<Browser> | null = null;
async function getBrowser() {
  if (!browser) {
    browser = import('playwright-core').then(({ chromium }) => chromium.launch({ executablePath: process.env.PDF_CHROMIUM || undefined, args: ['--no-sandbox'] }));
    browser.catch(() => { browser = null; });
  }
  const b = await browser;
  if (!b.isConnected()) { browser = null; return getBrowser(); }
  return b;
}

export const briefQuery = (p: BriefParams) => new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();

/** Renders /reports?<brief> as an A4 PDF with the caller's session (the page checks access itself). */
export const renderBriefPdf = (origin: string, session: string, p: BriefParams) => renderReportPdf(origin, session, `/reports?${briefQuery(p)}`);

/** Renders any report page (a brief, or /reports/<id> composed by the assistant) as an A4 PDF. */
export async function renderReportPdf(origin: string, session: string, pagePath: string): Promise<Buffer> {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1600 } });
  try {
    const url = new URL(origin);
    await ctx.addCookies([{ name: 'pai_session', value: session, domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light'); } catch {} });
    const page = await ctx.newPage();
    await page.goto(`${origin}${pagePath}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('article.report', { timeout: 15000 });
    // print the final state: entry animations (bars growing, fades) would otherwise be caught mid-way
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally {
    await ctx.close();
  }
}
