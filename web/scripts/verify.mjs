import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.SATIM_TEST_ORIGIN ?? 'http://127.0.0.1:3100';
const evidence = path.resolve(process.env.SATIM_TEST_ARTIFACTS ?? '../.verification/browser');
const runs = path.resolve(process.env.RUNS_DIR ?? '../runs');
const browsers = [
  process.env.PDF_CHROMIUM,
  chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = browsers.find((p) => p && existsSync(p));
assert(executablePath, 'Install Chromium or configure PDF_CHROMIUM.');
mkdirSync(evidence, { recursive: true });

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 655 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => {
    if (!r.failure()?.errorText.includes('ERR_ABORTED')) errors.push(r.failure()?.errorText);
  });
  assert.equal((await context.request.get(origin + '/api/v1/overview')).status(), 401);
  // sign in with an account (the administrator by default): SATIM_TEST_USER / SATIM_TEST_PASSWORD
  const password = process.env.SATIM_TEST_PASSWORD;
  assert(password, 'Set SATIM_TEST_PASSWORD (and SATIM_TEST_USER, default admin) for the test account.');
  await page.goto(origin + '/login');
  await page.getByLabel('Username').fill(process.env.SATIM_TEST_USER ?? 'admin');
  await page.getByLabel('Password').fill(password);
  const dashboardStart = performance.now();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Network overview', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Network activity', exact: true }).waitFor();
  const dashboardMs = performance.now() - dashboardStart;

  const timing = {};
  async function json(route) {
    const started = performance.now();
    const response = await context.request.get(origin + route);
    timing[route] = Math.round(performance.now() - started);
    assert.equal(response.status(), 200, route);
    return response.json();
  }
  const latest = JSON.parse(readFileSync(path.join(runs, 'latest.json')));
  const snapshot = JSON.parse(readFileSync(path.join(runs, latest.path), 'utf8'));
  const health = await json('/api/v1/health');
  assert.equal(health.run_id, latest.run_id);
  // a labelled preview run (exact local replay, sealed digest not reproduced) only when explicitly allowed
  if (process.env.SATIM_TEST_ALLOW_PREVIEW !== '1') assert.equal(health.sealed_parity, true);
  const overview = await json('/api/v1/overview');
  const total = snapshot.network.daily.filter((d) => d.date >= overview.scope.from).reduce((a, b) => a + b.transactions, 0);
  assert.equal(overview.kpis.events.value, total);
  const scored = await json('/api/v1/anomalies?scope=official');
  assert.deepEqual(scored.predictions, snapshot.official_predictions);
  const alerts = await json('/api/v1/anomalies');
  assert(alerts.rows.length > 0);
  const alert = alerts.rows[0];
  const incidents = await json('/api/v1/incidents');
  assert(incidents.incidents.length > 0);
  const incident = incidents.incidents[0];
  const advisories = await json('/api/v1/advisories');
  assert.equal(advisories.advisories.length, snapshot.advisories.length);
  assert(advisories.hybrid.rows.every((r) => r.investigation_candidate));
  const forecast = await json('/api/v1/forecasts');
  assert.equal(forecast.metrics.length, 7);
  assert.equal(forecast.metrics[0].date, forecast.origin);
  assert(forecast.metrics.every((d) => d.accepted_value.intervals['80'].length === 2));

  async function navigate(route, heading) {
    await page.goto(origin + route);
    await page.getByRole('heading', { name: heading }).first().waitFor();
  }
  await navigate('/', 'Network overview');
  await page.getByText('Accepted value and rejection forecasts', { exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'network_overview.png'), fullPage: true });
  await navigate('/merchants', 'Merchants');
  await navigate('/merchants/' + alert.merchant, new RegExp(alert.merchant));
  await navigate('/transactions?contactless=breach', 'Transactions');
  await page.getByText('contactless limit exceeded', { exact: true }).first().waitFor();
  await navigate('/transactions?merchant=MER-0000', 'Transactions');
  await page.getByText('No transaction matches these filters', { exact: true }).waitFor();
  await navigate('/alerts', 'Alerts');
  await navigate('/alerts/' + encodeURIComponent(alert.id), 'Alert explanation');
  await page.getByText(alert.explanation, { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(evidence, 'official_v2_explanation.png'), fullPage: true });
  await navigate('/intelligence', 'Network intelligence');
  await page.locator('details.cluster > summary').first().click();
  await page.screenshot({ path: path.join(evidence, 'advisory_intelligence.png'), fullPage: true });
  await navigate('/intelligence/' + encodeURIComponent(advisories.advisories[0].id), 'Hypotheses');
  await navigate('/incidents', 'Incidents');
  await navigate('/incidents/' + encodeURIComponent(incident.id), 'Estimated business impact');

  const review = (data) => context.request.post(origin + '/api/v1/incidents/' + encodeURIComponent(incident.id) + '/review', { data });
  const originalVersion = incident.review.version;
  const changes = [
    { action: 'acknowledge' }, { action: 'comment', reason: 'Checked archive feed coverage' },
    { action: 'assign', owner: 'Operations' }, { action: 'escalate', reason: 'Request service records' },
    { action: 'close', reason: 'Verification exercise completed' }, { action: 'reopen' },
  ];
  for (const [i, action] of changes.entries()) {
    const response = await review({ ...action, version: originalVersion + i });
    assert.equal(response.status(), 200, action.action + ': ' + await response.text());
  }
  assert.equal((await review({ action: 'acknowledge', version: originalVersion })).status(), 409);
  assert.deepEqual((await json('/api/v1/anomalies?scope=official')).predictions, scored.predictions);

  await navigate('/simulate', 'Simulator');
  await page.getByText('Hypothetical impact using the published forecast').waitFor();
  const before = await page.locator('.sim-kpis').innerText();
  await page.getByLabel('Duration (days)').fill('2');
  assert.notEqual(await page.locator('.sim-kpis').innerText(), before);
  await navigate('/assistant', /assistant|ask the dashboard/i);
  // answers come from the language model only; without it the assistant must say so (503), never answer from rules
  const modelState = (await json('/api/v1/assistant/status')).model;
  for (const question of ['Network summary', 'Which hybrid ML investigation candidates are there this week?', 'How many contactless limit breaches are there?',
    'What is the business impact this week?', 'Forecast for the next 7 days', 'What data quality problems should I consider?']) {
    const response = await context.request.post(origin + '/api/v1/assistant', { data: { question } });
    if (modelState !== 'online') {
      assert.equal(response.status(), 503, question);
      assert.match((await response.json()).error.code, /^model_/);
      continue;
    }
    assert.equal(response.status(), 200, question);
    const reply = await response.json();
    assert.equal(reply.source, 'model');
    assert(!reply.refused && reply.evidence.length, question);
  }
  // guard refusals still work without the model
  const refusal = await context.request.post(origin + '/api/v1/assistant', { data: { question: 'Close incident ' + incident.id } });
  assert.equal(refusal.status(), 200);
  assert.equal((await refusal.json()).refused, 'write');
  const privateInput = '5'.repeat(6) + '*'.repeat(6) + '8'.repeat(4);
  const privateResponse = await context.request.post(origin + '/api/v1/assistant', { data: { question: privateInput } });
  assert.equal(privateResponse.status(), 422);
  assert(!(await privateResponse.text()).includes(privateInput));
  await navigate('/data', 'Data & runs');
  await navigate('/reports?type=incident&incident=' + encodeURIComponent(incident.id), /Incident brief/);

  for (const [name, route] of [
    ['daily', '/api/v1/reports/pdf?type=daily'],
    ['weekly', '/api/v1/reports/pdf?type=weekly'],
    ['merchant', '/api/v1/reports/pdf?type=merchant&merchant=' + alert.merchant],
    ['incident', '/api/v1/reports/pdf?type=incident&incident=' + encodeURIComponent(incident.id)],
  ]) {
    const response = await context.request.get(origin + route, { maxRedirects: 0 });
    assert.equal(response.status(), 200, name);
    assert.match(response.headers()['content-type'], /application\/pdf/);
    const pdf = await response.body();
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    writeFileSync(path.join(evidence, name + '_brief.pdf'), pdf);
  }
  for (const kind of ['predictions', 'transactions', 'anomalies', 'incidents']) {
    const response = await context.request.get(origin + '/api/v1/export/' + kind);
    // the official submission is only offered from a sealed run
    if (kind === 'predictions' && !health.sealed_parity) { assert.equal(response.status(), 409); continue; }
    assert.equal(response.status(), 200);
    const csv = await response.text();
    assert(!/masked_pan|card_number/i.test(csv));
    if (kind === 'predictions') {
      const rows = csv.trimEnd().split(/\r?\n/);
      assert.equal(rows.length, 712);
      assert.equal(rows[0], 'merchant_id,date,is_anomaly,anomaly_score');
      const values = rows.slice(1).map((line) => {
        const [merchant_id, date, flag, score] = line.split(',');
        return { merchant_id, date, is_anomaly: Number(flag), anomaly_score: Number(score) };
      });
      assert.deepEqual(values, scored.predictions);
    }
  }
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  for (const width of [1920, 1366, 820, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await navigate('/', 'Network overview');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow at ' + width);
  }
  await page.screenshot({ path: path.join(evidence, 'overview_mobile_dark.png'), fullPage: true });
  const alternate = process.env.SATIM_TEST_ALTERNATE_RUNS;
  if (alternate) {
    const other = JSON.parse(readFileSync(path.join(alternate, 'latest.json')));
    const alternatePath = path.join(runs, other.path);
    mkdirSync(path.dirname(alternatePath), { recursive: true });
    copyFileSync(path.join(alternate, other.path), alternatePath);
    const setLatest = (pointer) => {
      const incoming = path.join(runs, 'verify-incoming.json');
      writeFileSync(incoming, JSON.stringify(pointer));
      renameSync(incoming, path.join(runs, 'latest.json'));
    };
    try {
      setLatest(other);
      assert.equal((await json('/api/v1/health')).run_id, other.run_id);
      assert.deepEqual((await json('/api/v1/anomalies?scope=official')).predictions, scored.predictions);
      await navigate('/intelligence', 'Network intelligence');
      await page.getByText('V4 advisory module disabled', { exact: true }).waitFor();
      await page.getByText('V3 advisory module disabled', { exact: true }).waitFor();
    } finally {
      setLatest(latest);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ run_id: latest.run_id, dashboard_ms: Math.round(dashboardMs), api_ms: timing,
    assertions: 'Browser journeys, API parity, review locking, CSV/PDF and responsive checks passed' }, null, 2));
} finally {
  await browser.close();
}
