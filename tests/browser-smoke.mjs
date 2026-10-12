import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails, readMetrics, waitPhase } from './browser-helpers.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifactDirectory = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-browser-v2';
const streamCounts = (process.env.SMOKE_STREAM_COUNTS || '1,4,12,24').split(',').map(Number);
const onlyRemaining = process.env.SMOKE_ONLY === 'remaining';
await mkdir(artifactDirectory, { recursive: true });
const browser = await launchBrowser();
const runtimeErrors = [];
const transferPattern = /\/api\/(ping|download|upload)(?:\?|$)/;

async function openPage(viewport = { width: 1440, height: 1100 }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const responses = [];
  const requests = [];
  const sessionIDs = new Set();
  const sessionSnapshots = [];
  const snapshotsPending = [];
  const runs = new Set();
  context.on('request', request => {
    const url = new URL(request.url());
    if (transferPattern.test(request.url())) requests.push({ url: request.url(), method: request.method() });
    if (url.pathname === '/api/download' && url.searchParams.has('run')) runs.add(url.searchParams.get('run'));
  });
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) responses.push({ url: response.url(), path: url.pathname, status: response.status(), headers: response.headers() });
    if (/^\/api\/upload-sessions(?:\/[^/]+)?$/.test(url.pathname) && response.status() >= 200 && response.status() < 300 && response.status() !== 204) {
      snapshotsPending.push(response.json().then(snapshot => { if (snapshot.id) sessionIDs.add(snapshot.id); if (Number.isFinite(snapshot.measuredBytes)) sessionSnapshots.push(snapshot); }).catch(() => {}));
    }
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  const config = await (await context.request.get(`${baseURL}/api/config`)).json();
  assert.equal(config.performance.transport, 'http', 'use the HTTP fixture for this suite and browser-websocket.mjs for the default WebSocket deployment');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page should fit the viewport');
  return { page, context, requests, responses, sessionIDs, sessionSnapshots, snapshotsPending, runs };
}

async function manualStreams(page, count) {
  await openDetails(page);
  if (await page.locator('#test-settings').getAttribute('open') === null) await page.locator('#test-settings > summary').click();
  await page.locator('#mode-manual').check();
  await page.locator('#stream-count').fill(String(count));
  await page.locator('#measurement-duration').selectOption('');
}

async function verifyReleased(state) {
  await Promise.allSettled(state.snapshotsPending);
  for (const id of state.sessionIDs) {
    const response = await state.context.request.get(`${baseURL}/api/upload-sessions/${encodeURIComponent(id)}`);
    assert.equal(response.status(), 404, `upload session ${id} should be deleted after completion or cancellation`);
  }
  for (const run of state.runs) {
    const response = await state.context.request.get(`${baseURL}/api/connection-stats?run=${encodeURIComponent(run)}`);
    if (response.status() === 404) continue; // Fault-injected requests may never reach the server.
    assert.equal(response.status(), 200);
    let stats = await response.json();
    for (let retry = 0; (stats.activeRequests || stats.activeTcpConnections) && retry < 20; retry += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      stats = await (await state.context.request.get(`${baseURL}/api/connection-stats?run=${encodeURIComponent(run)}`)).json();
    }
    assert.equal(stats.activeRequests, 0, 'stopped continuous downloads should release requests');
    assert.equal(stats.activeTcpConnections, 0, 'stopped continuous downloads should release active TCP observations');
  }
}

async function completedRun(state, count) {
  const { page } = state;
  if (count !== undefined) await manualStreams(page, count);
  await page.locator('#start-button').click();
  await waitPhase(page, '正在测量下载', 30000);
  assert.equal(await page.locator('#settings-fields').evaluate(fieldset => fieldset.disabled), true, 'settings should be fixed during a measurement');
  assert.equal(await page.locator('#mode-manual').isDisabled(), true);
  await waitPhase(page, '正在测量上传');
  await waitPhase(page, '测速完成');
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled && !document.querySelector('#start-button').hidden);
  const metrics = await readMetrics(page);
  for (const [key, value] of Object.entries(metrics).filter(([, value]) => typeof value === 'number')) {
    assert.ok(Number.isFinite(value) && value >= 0, `${key} should show a finite measured value`);
  }
  assert.ok(metrics.downloadMbps > 0 && metrics.uploadMbps > 0, 'both directions must transfer actual bytes');
  assert.match(metrics.protocol, /HTTP\/1\.1/, 'direct deployment should expose its actual transport protocol');
  assert.equal(metrics.tcpDetails.scope, 'server');
  assert.equal(Number(metrics.tcpDetails.active), 0, 'completed UI should show no active measurement TCP connections');
  assert.equal(Number(await page.locator('#streams-value').getAttribute('data-active')), 0, 'completed UI should show no active logical streams');
  if (count !== undefined) {
    assert.equal(Number(await page.locator('#streams-value').getAttribute('data-peak')), count, 'manual streams must create exactly the requested logical concurrency');
    assert.equal(Number(metrics.tcpDetails.peak), count, 'independent origins must create the requested actual TCP concurrency');
  }
  assert.equal(await page.locator('#error-message').isVisible(), false);
  assert.equal(await page.locator('#settings-fields').evaluate(fieldset => fieldset.disabled), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'completed page should fit its viewport');
  await Promise.allSettled(state.snapshotsPending);
  assert.ok(state.sessionSnapshots.some(snapshot => snapshot.measuredBytes > 0), 'upload speed must have positive server-received progress before body acknowledgement');
  for (const path of ['/api/ping', '/api/download']) {
    const success = state.responses.filter(response => response.path === path && response.status >= 200 && response.status < 300);
    assert.ok(success.length > 0, `real ${path} requests should succeed`);
    assert.ok(success.every(response => /no-store/i.test(response.headers['cache-control'] || '')), `${path} responses must bypass caches`);
    assert.equal(new Set(success.map(response => response.url)).size, success.length, 'measurement URLs should have unique nonces');
    if (path === '/api/download') assert.ok(success.every(response => !response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity'), 'download must be uncompressed');
  }
  assert.ok(state.requests.some(request => new URL(request.url).pathname === '/api/upload' && request.method === 'POST'), 'actual giant upload bodies should be sent');
  await verifyReleased(state);
  return metrics;
}

try {
  if (!onlyRemaining) {
  const desktop = await openPage();
  await desktop.page.screenshot({ path: join(artifactDirectory, 'desktop-ready.png'), fullPage: true });
  await openDetails(desktop.page);
  await desktop.page.locator('#test-settings > summary').click();
  await desktop.page.screenshot({ path: join(artifactDirectory, 'desktop-advanced-ready.png'), fullPage: true });
  for (const count of streamCounts) {
    const metrics = await completedRun(desktop, count);
    console.log('PASS manual logical/TCP concurrency', JSON.stringify({ count, metrics }));
  }
  await desktop.page.screenshot({ path: join(artifactDirectory, 'desktop-complete.png'), fullPage: true });
  await desktop.context.close();

  const mobile = await openPage({ width: 320, height: 844 });
  await manualStreams(mobile.page, 4);
  await mobile.page.screenshot({ path: join(artifactDirectory, 'mobile-advanced-ready.png'), fullPage: true });
  await mobile.page.locator('#start-button').click();
  await waitPhase(mobile.page, '正在测量上传');
  await mobile.page.waitForTimeout(500);
  await mobile.page.locator('#stop-button').click();
  await waitPhase(mobile.page, '测速已停止');
  const requestsAfterStop = mobile.requests.length;
  await mobile.page.waitForTimeout(400);
  assert.equal(mobile.requests.length, requestsAfterStop, 'cancelled worker should stop creating data requests');
  await verifyReleased(mobile);
  const mobileMetrics = await completedRun(mobile, 4);
  await mobile.page.screenshot({ path: join(artifactDirectory, 'mobile-complete.png'), fullPage: true });
  console.log('PASS mobile worker upload cancellation, released sessions and full restart', JSON.stringify(mobileMetrics));
  await mobile.context.close();
  }

  const failed = await openPage();
  await manualStreams(failed.page, 1);
  const downloadFault = /\/api\/download(?:\?|$)/;
  if (!onlyRemaining) {
  await failed.context.route(downloadFault, route => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': new URL(baseURL).origin }, body: '{"error":"test unavailable"}' }));
  await failed.page.locator('#start-button').click();
  await failed.page.locator('#error-message').waitFor({ state: 'visible', timeout: 30000 });
  assert.ok((await failed.page.locator('#error-message').textContent()).trim().length > 0);
  assert.equal(await failed.page.locator('#start-button').isEnabled(), true);
  await failed.context.unroute(downloadFault);
  await completedRun(failed, 1);
  console.log('PASS worker transfer service error and successful real retry');
  }

  await failed.page.locator('#start-button').click();
  await waitPhase(failed.page, '正在测量下载');
  const extraTab = await failed.context.newPage();
  await extraTab.bringToFront();
  const simulatedVisibility = !await failed.page.evaluate(() => document.hidden);
  if (simulatedVisibility) {
    // Headless Chromium keeps every tab visible. Exercise the real visibility
    // handler and real worker cancellation with an explicit hidden event.
    await failed.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  await waitPhase(failed.page, '测速已停止');
  await extraTab.close();
  await failed.page.bringToFront();
  if (simulatedVisibility) await failed.page.evaluate(() => { delete document.hidden; });
  await verifyReleased(failed);
  console.log(`PASS ${simulatedVisibility ? 'headless simulated' : 'native tab'} background visibility cancels the worker`);

  await failed.page.locator('#start-button').click();
  await waitPhase(failed.page, '正在测量下载');
  await failed.context.setOffline(true);
  await waitPhase(failed.page, '测速已停止');
  await failed.context.setOffline(false);
  await failed.page.waitForTimeout(250);
  assert.equal(await failed.page.locator('#start-button').isEnabled(), true);
  console.log('PASS offline transition cancels active worker transfers');
  await failed.context.close();

  const unavailableContext = await browser.newContext();
  const unavailablePage = await unavailableContext.newPage();
  unavailablePage.on('pageerror', error => runtimeErrors.push(error.message));
  await unavailableContext.route('**/api/config*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test unavailable"}' }));
  await unavailablePage.goto(baseURL, { waitUntil: 'networkidle' });
  await unavailablePage.locator('#error-message').waitFor({ state: 'visible' });
  await unavailableContext.unroute('**/api/config*');
  await unavailableContext.route('**/api/config*', async route => { await new Promise(resolve => setTimeout(resolve, 400)); await route.continue().catch(() => {}); });
  const delayedConfigRequest = unavailablePage.waitForRequest(request => new URL(request.url()).pathname === '/api/config');
  await unavailablePage.locator('#start-button').click();
  await delayedConfigRequest;
  await unavailablePage.locator('#stop-button').click();
  await waitPhase(unavailablePage, '测速已停止');
  await unavailablePage.waitForTimeout(600);
  assert.equal(await unavailablePage.locator('#phase-label').textContent(), '测速已停止');
  console.log('PASS configuration error and cancellation during reconnect');
  await unavailableContext.close();
  assert.deepEqual(runtimeErrors, [], 'browser must have no uncaught JavaScript errors');
  console.log(`Browser validation passed; screenshots: ${artifactDirectory}`);
} finally {
  await browser.close();
}
