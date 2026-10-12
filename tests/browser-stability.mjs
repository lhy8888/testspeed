import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser-helpers.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
const outputDir = resolve(process.env.STABILITY_OUTPUT_DIR || '/tmp/testspeed-browser-stability');
await mkdir(outputDir, { recursive: true });
const pingRequests = [];
let mode = 'measure';
let active = 0;
let peak = 0;
let aborted = 0;
const allTimers = new Set();
const server = createServer(async (request, response) => {
  // Match production's restrictions; no inline script, third-party fetch or blob Worker.
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/ping') {
    assert.equal(request.method, 'GET');
    assert.ok(url.searchParams.has('stability'));
    const index = pingRequests.length;
    const entry = { index, mode, at: Date.now(), status: mode === 'measure' && index === 2 ? 503 : 200, closed: false };
    pingRequests.push(entry);
    active += 1;
    peak = Math.max(peak, active);
    const delays = [80, 120, 30, 60, 90];
    const delay = mode === 'measure' ? delays[index] ?? 60000 : 60000;
    const timer = setTimeout(() => {
      allTimers.delete(timer);
      response.writeHead(entry.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ nodeId: 'local-stability-fixture' }));
    }, delay);
    allTimers.add(timer);
    response.on('close', () => {
      if (entry.closed) return;
      entry.closed = true;
      active -= 1;
      entry.aborted = !response.writableFinished;
      if (entry.aborted) aborted += 1;
      clearTimeout(timer);
      allTimers.delete(timer);
    });
    return;
  }
  const file = url.pathname === '/' ? 'stability.html' : url.pathname.slice(1);
  if (!/^(stability\.(html|js|css)|stability-worker\.js|i18n\.js|styles\.css|favicon\.svg)$/.test(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const body = await readFile(resolve(webRoot, file));
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const context = await browser.newContext({ locale: 'zh-CN', acceptDownloads: true, viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();
await page.addInitScript(() => {
  window.stabilityPolicyViolations = [];
  document.addEventListener('securitypolicyviolation', event => window.stabilityPolicyViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
});
const errors = [];
const workerURLs = [];
page.on('pageerror', error => errors.push(error.message));
page.on('worker', worker => workerURLs.push(worker.url()));
const report = { baseURL, source: 'local HTTP fixture with actual browser Worker requests; no simulated latency values', cases: [] };
const eventually = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), 'condition did not become true');
};

try {
  await page.goto(`${baseURL}/stability.html`);
  assert.equal(await page.locator('#stability-current').textContent(), '—');
  assert.equal(await page.locator('#stability-average').getAttribute('data-value'), null);
  assert.equal(await page.locator('#stability-export').isEnabled(), false);
  assert.equal(pingRequests.length, 0, 'the page must not measure until explicitly started');
  await page.selectOption('#stability-threshold', '100');
  await page.click('#stability-start');
  await page.waitForFunction(() => document.querySelector('#stability-status').dataset.state === 'running');
  await page.waitForFunction(() => Number(document.querySelector('#stability-failure').dataset.value) > 0);
  await page.waitForFunction(() => document.querySelector('#stability-requests').textContent.startsWith('5 '));
  await eventually(() => pingRequests.length === 6);
  await page.click('#stability-stop');
  await page.waitForFunction(() => document.querySelector('#stability-status').dataset.state === 'stopped');
  await eventually(() => active === 0);
  const measured = await page.evaluate(() => Object.fromEntries(['current', 'average', 'minimum', 'maximum', 'p50', 'p95', 'p99', 'failure', 'jitter'].map(id => [id, Number(document.querySelector(`#stability-${id}`).dataset.value)])));
  assert.equal(measured.failure, 20);
  assert.ok(measured.minimum >= 45 && measured.maximum >= 110, 'latency must include the actual fixture response delay');
  assert.ok(measured.minimum <= measured.p50 && measured.p50 <= measured.p95 && measured.p95 <= measured.p99 && measured.p99 <= measured.maximum);
  assert.ok(measured.average > measured.minimum && measured.average < measured.maximum);
  assert.ok(measured.jitter > 0);
  assert.equal(peak, 1, 'requests must not overlap');
  assert.ok(aborted >= 1, 'stop must abort the real active HTTP request');
  assert.ok((await page.locator('#stability-line').getAttribute('d')).includes('M'));
  assert.ok((await page.locator('#stability-failures').getAttribute('d')).includes('a3'));
  const noMore = pingRequests.length;
  await page.waitForTimeout(650);
  assert.equal(pingRequests.length, noMore, 'stopped tests must leave no traffic behind');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#stability-export');
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  const rows = csv.trimEnd().split('\r\n');
  assert.equal(rows.length, 6, 'CSV contains only the five completed real requests');
  assert.match(rows[3], /,"","false","HTTP 503"$/);
  const firstRow = rows[1].split(',').map(cell => JSON.parse(cell));
  assert.equal(firstRow.length, 5);
  assert.match(firstRow[0], /^\d{4}-\d{2}-\d{2}T[^" ]+Z$/);
  assert.ok(Math.abs(Date.parse(firstRow[0]) - pingRequests[0].at) < 1000, 'the UTC export timestamp must match the real first HTTP request');
  assert.ok(Number.isFinite(Number(firstRow[1])) && Number(firstRow[1]) >= 0 && Number(firstRow[1]) < 60000, 'first elapsed time must be within the configured run, allowing actual Worker scheduling delay');
  assert.ok(Number(firstRow[2]) >= measured.minimum - 0.001 && Number(firstRow[2]) <= measured.maximum + 0.001, 'CSV latency must be one of the observed response times');
  assert.equal(firstRow[3], 'true');
  assert.equal(firstRow[4], '');
  await writeFile(resolve(outputDir, 'actual-stability.csv'), csv);
  await page.screenshot({ path: resolve(outputDir, 'desktop-stability.png'), fullPage: true });
  report.cases.push({ name: 'actual latency, percentiles, HTTP failures, real CSV and stop abort', passed: true, measured, requestCount: noMore });

  await page.selectOption('#language-select', 'en');
  assert.equal(await page.title(), 'TESTSPEED · Connection stability');
  assert.equal(await page.locator('#stability-average').getAttribute('data-value'), String(measured.average));
  await page.reload();
  assert.equal(await page.locator('#language-select').inputValue(), 'en');
  assert.equal(await page.locator('#stability-current').textContent(), '—');
  assert.equal(pingRequests.length, noMore, 'reload does not autostart');
  await page.setViewportSize({ width: 320, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(outputDir, 'mobile-stability.png'), fullPage: true });
  report.cases.push({ name: 'language persistence, untouched measurements and 320 px layout', passed: true });

  for (const reason of ['offline', 'hidden']) {
    mode = reason;
    const before = pingRequests.length;
    await page.click('#stability-start');
    await eventually(() => pingRequests.length === before + 1);
    if (reason === 'offline') await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    else await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(expected => document.querySelector('#stability-status').dataset.state === expected, reason);
    await eventually(() => active === 0);
    assert.equal(await page.locator('#stability-current').getAttribute('data-value'), null);
    assert.equal(await page.locator('#stability-failure').getAttribute('data-value'), null, 'a lifecycle cancellation must not invent request failures');
    await page.waitForTimeout(600);
    assert.equal(pingRequests.length, before + 1);
    if (reason === 'hidden') await page.evaluate(() => { delete document.hidden; });
    report.cases.push({ name: `${reason} immediately aborts an actual pending request without fake failure or extra traffic`, passed: true });
  }
  mode = 'duration';
  const beforeDuration = pingRequests.length;
  const automaticEnd = await page.evaluate(() => new Promise((resolve, reject) => {
    // Exercise the Worker's public short-duration contract without changing the UI menu.
    const startedAt = performance.now();
    const worker = new Worker('/stability-worker.js', { type: 'module' });
    const guard = setTimeout(() => { worker.terminate(); reject(new Error('The duration limit did not stop the Worker.')); }, 5000);
    worker.onmessage = ({ data }) => {
      if (data.type !== 'complete') return;
      clearTimeout(guard);
      worker.terminate();
      resolve({ ...data, wallDurationMs: performance.now() - startedAt });
    };
    worker.onerror = event => { clearTimeout(guard); worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ type: 'start', config: { durationMs: 1000, intervalMs: 250, timeoutMs: 200 } });
  }));
  await eventually(() => active === 0);
  assert.equal(automaticEnd.reason, 'duration');
  assert.equal(automaticEnd.elapsedMs, 1000);
  assert.ok(automaticEnd.wallDurationMs >= 950 && automaticEnd.wallDurationMs < 3000);
  assert.equal(automaticEnd.metrics.requests, 4);
  assert.equal(automaticEnd.metrics.failures, 4);
  assert.equal(automaticEnd.metrics.failurePercent, 100);
  assert.equal(automaticEnd.metrics.averageMs, null);
  assert.equal(pingRequests.length, beforeDuration + 4);
  await page.waitForTimeout(400);
  assert.equal(pingRequests.length, beforeDuration + 4, 'automatic completion leaves no timers or extra requests');
  report.cases.push({ name: 'real Worker timeouts and automatic duration limit clear all traffic', passed: true, automaticEnd });
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.deepEqual(await page.evaluate(() => window.stabilityPolicyViolations), [], 'production CSP must allow the same-origin module Worker and actual CSV download');
  assert.ok(workerURLs.every(url => url === `${baseURL}/stability-worker.js`));
  report.peakConcurrentRequests = peak;
  report.abortedRequests = aborted;
  report.workerURLs = workerURLs;
  report.requests = pingRequests;
  await writeFile(resolve(outputDir, 'stability-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  for (const timer of allTimers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
