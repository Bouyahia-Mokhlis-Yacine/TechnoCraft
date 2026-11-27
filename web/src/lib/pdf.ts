// Server-side PDF of a Reports page brief: headless Chromium prints the same page the user sees
// (print styles, self-hosted fonts, Arabic shaping), so the PDF and the screen never disagree.
// The browser is PDF_CHROMIUM if set, else Playwright's Chromium if installed, else a Chrome,
// Chromium or Edge already on the machine. With none, the route sends the user to the print dialog.
import fs from 'node:fs';
import type { Browser } from 'playwright-core';

const SYSTEM_BROWSERS = [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
/** The browser binary to print with, or null when this machine has none. */
async function browserPath(): Promise<string | null> {
  if (process.env.PDF_CHROMIUM) return process.env.PDF_CHROMIUM;
  const { chromium } = await import('playwright-core');
  const own = chromium.executablePath();
  return [own, ...SYSTEM_BROWSERS].find((p) => { try { return !!p && fs.existsSync(p); } catch { return false; } }) ?? null;
}
export class NoBrowserError extends Error {}

export type BriefType = 'daily' | 'weekly' | 'merchant' | 'alerts' | 'incident';
export interface BriefParams { type: BriefType; incident?: string; date?: string; merchant?: string; from?: string; to?: string; severity?: string; channel?: string; run?: string }

let browser: Promise<Browser> | null = null;
async function getBrowser() {
  if (!browser) {
    browser = Promise.all([import('playwright-core'), browserPath()]).then(([{ chromium }, exe]) => {
      if (!exe) throw new NoBrowserError('No Chrome, Chromium or Edge found: set PDF_CHROMIUM or run `npx playwright install chromium`.');
      return chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    });
    browser.catch(() => { browser = null; });
  }
  const b = await browser;
  if (!b.isConnected()) { browser = null; return getBrowser(); }
  return b;
}

export const briefQuery = (p: BriefParams) => new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();

/** Renders /reports?<brief> as an A4 PDF with the caller's session (the page checks access itself). */
export const renderBriefPdf = (origin: string, session: string, p: BriefParams, lang?: string) => renderReportPdf(origin, session, `/reports?${briefQuery(p)}`, lang);

/** Renders any report page (a brief, or /reports/<id> composed by the assistant) as an A4 PDF. */
/** pagePath carries ?run= when a collection run is shown, so the printed page reads the same run as the request. */
export async function renderReportPdf(origin: string, session: string, pagePath: string, lang?: string): Promise<Buffer> {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1600 } });
  try {
    const url = new URL(origin);
    await ctx.addCookies([{ name: 'pai_session', value: session, domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
      ...(lang ? [{ name: 'pai_lang', value: lang, domain: url.hostname, path: '/', sameSite: 'Lax' as const }] : [])]);
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
