import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const origin = process.env.SATIM_TEST_ORIGIN ?? 'http://127.0.0.1:3017';
const password = process.env.SATIM_TEST_PASSWORD;
const browserPath = [process.env.PDF_CHROMIUM, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium'].find(p => p && existsSync(p));
assert(password && browserPath, 'Set SATIM_TEST_PASSWORD and install or configure Chromium.');
const browser = await chromium.launch({ executablePath: browserPath, args: ['--no-sandbox'] });
const live = origin + '/api/v1/live';

async function signIn(page, user, secret) {
  await page.goto(origin + '/login?next=/live');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(secret);
  await Promise.all([page.waitForURL('**/live'), page.getByRole('button', { name: 'Sign in' }).click()]);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  // the interface defaults to French; this journey asserts the English labels
  const english = ctx => ctx.addCookies([{ name: 'pai_lang', value: 'en', url: origin }]);
  await english(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  assert.equal((await context.request.get(live)).status(), 401);
  await signIn(page, 'admin', password);
  await page.getByRole('heading', { name: 'Live Monitoring', exact: true }).waitFor();
  const data = async route => {
    const response = await context.request.get(route ?? live);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  assert.equal((await context.request.post(live, {
    headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' }, data: { action: 'reset' },
  })).status(), 403);
  await context.request.post(live, { data: { action: 'reset' } });
  await page.getByLabel('Scenario').selectOption('collective');
  await page.getByLabel('Playback speed').selectOption('3600');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const started = performance.now();
  await page.getByRole('img', { name: 'Observed and expected activity' }).waitFor();
  const firstPlotMs = Math.round(performance.now() - started);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  const paused = await data();
  assert.equal(paused.status, 'paused');
  await page.getByRole('button', { name: 'Step forward' }).click();
  await page.waitForFunction(clock => !document.querySelector('progress')?.parentElement?.textContent?.includes(clock.replace('T', ' ')), paused.clock);
  const stepped = await data();
  assert.equal(Date.parse(stepped.clock) - Date.parse(paused.clock), 300_000);
  await page.getByLabel('Playback speed').selectOption('600');
  const scope = page.locator('label').filter({ hasText: /^Scope/ }).locator('select');
  await scope.selectOption('channel');
  await page.getByLabel('Selection').selectOption('ecommerce');
  await page.getByText('E-commerce · Finalized five-minute intervals').waitFor();
  await scope.selectOption('merchant');
  assert((await page.getByLabel('Selection').locator('option').count()) > 1);
  await page.reload();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  const restored = await data();
  assert.equal(restored.clock, stepped.clock);
  assert.equal(restored.speed, 600);
  await page.getByLabel('Playback speed').selectOption('3600');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByText(/complete · 35 scored · \d+ daily flags/i).waitFor({ timeout: 90_000 });
  const complete = await data();
  assert.equal(complete.status, 'finished');
  assert(complete.points.length > 200);
  assert.equal(complete.summary.transactions_per_minute, complete.points.at(-1).observed / 5);
  assert.equal(complete.summary.daily_rejection_rate,
    complete.points.at(-1).daily_rejections / complete.points.at(-1).cumulative);
  assert(complete.warnings.some(w => w.kind === 'Collective advisory'));
  assert(complete.warnings.some(w => w.state === 'Resolved'));
  await page.locator('details').filter({ hasText: /Shared activity shortfall|Shared rejection increase/ }).first().locator('summary').click();
  await page.getByText('Selected merchants', { exact: true }).first().waitFor();
  const t = performance.now();
  await data(live + '?limit=12');
  const apiMs = Math.round(performance.now() - t);
  const assistant = await context.request.post(origin + '/api/v1/assistant', {
    data: { question: 'What happened in the replay during simulated daily closure?', page: { path: '/live' } },
  });
  assert.equal(assistant.status(), 200);
  const answer = await assistant.json();
  assert.equal(answer.intent, 'live_replay', JSON.stringify(answer));
  assert.match(answer.text.join(' '), /simulated|replay/i);
  await page.getByLabel('Start date').fill('2026-10-15');
  await page.getByLabel('End date').fill('2026-10-15');
  await page.getByLabel('Scenario').selectOption('backlog');
  await page.getByLabel('Playback speed').selectOption('3600');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const early = page.locator('details').filter({ hasText: /Activity shortfall.*POS terminals/ }).first();
  await early.locator('summary').click({ timeout: 45_000 });
  await early.getByText(/Directional CUSUM crossed the replay warning threshold/).first().waitFor();   // the composed explanation (the service's original follows it)
  await early.getByText('Resolved', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
  assert.equal((await data()).status, 'stopped');
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  assert.equal(overflow, false);
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
  assert.equal((await data()).status, 'idle');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/admin');
  const user = 'reader.' + String(Date.now()).slice(-7);
  const readerSecret = 'live-reader-verification';
  const readerName = `Replay Reader ${user}`;
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create account' }) });
  await form.getByLabel('Username').fill(user);
  await form.getByLabel('Display name').fill(readerName);
  await form.getByLabel('Password').fill(readerSecret);
  await form.getByLabel('Live Monitoring').check();
  await form.getByRole('button', { name: 'Create account' }).click();
  await page.getByText(readerName, { exact: true }).waitFor();
  const restricted = await browser.newContext();
  await english(restricted);
  const readPage = await restricted.newPage();
  await signIn(readPage, user, readerSecret);
  await readPage.getByText('This account has read access.', { exact: false }).waitFor();
  assert.equal((await restricted.request.get(live)).status(), 200);
  assert.equal((await restricted.request.post(live, { data: { action: 'reset' } })).status(), 403);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', first_plot_ms: firstPlotMs, warm_snapshot_ms: apiMs,
    collective_warnings: complete.warnings.filter(w => w.kind === 'Collective advisory').length,
    resolved_warnings: complete.warnings.filter(w => w.state === 'Resolved').length,
    backlog_warning: 'POS activity shortfall', assistant: answer.source }));
} finally {
  await browser.close();
}
