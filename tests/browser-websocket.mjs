import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails, readMetrics, waitPhase } from './browser-helpers.mjs';
import { createNetworkFixture } from './browser-network-fixture.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-websocket';
const manualCounts = (process.env.WS_STREAM_COUNTS || '1,4,8,16,30').split(',').map(Number);
const selected = process.env.WS_CASES ? new Set(process.env.WS_CASES.split(',')) : null;
const enabled = name => !selected || selected.has(name);
await mkdir(artifacts, { recursive: true });
const browser = await launchBrowser();
const reports = [];
const fixtures = [];
let activeState;

async function open(url, viewport = { width: 1440, height: 1100 }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' });
  const page = await context.newPage();
  const state = { url, context, page, errors: [], sockets: [], sessions: new Set(), snapshots: [], pending: [], responses: [], runs: new Set(), requests: [] };
  state.networkFixture = fixtures.find(fixture => fixture.url === url);
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('websocket', socket => {
    const address = new URL(socket.url());
    const record = { url: socket.url(), direction: address.searchParams.get('direction'), receivedBytes: 0, sentBytes: 0, ready: false, closed: false };
    if (address.searchParams.has('run')) state.runs.add(address.searchParams.get('run'));
    state.sockets.push(record);
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') {
        try { if (JSON.parse(payload).type === 'ready') record.ready = true; } catch {}
      } else record.receivedBytes += payload.byteLength;
    });
    socket.on('framesent', ({ payload }) => { if (typeof payload !== 'string') record.sentBytes += payload.byteLength; });
    socket.on('close', () => { record.closed = true; });
  });
  context.on('request', request => {
    state.requests.push({ url: request.url(), method: request.method() });
    const url = new URL(request.url());
    if (url.pathname === '/api/download' && url.searchParams.has('run')) state.runs.add(url.searchParams.get('run'));
  });
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/ping') state.responses.push({ url: response.url(), headers: response.headers(), status: response.status() });
    if (/^\/api\/upload-sessions(?:\/[^/]+)?$/.test(url.pathname) && response.status() >= 200 && response.status() < 300 && response.status() !== 204) {
      state.pending.push(response.json().then(snapshot => {
        if (snapshot.id) state.sessions.add(snapshot.id);
        if (Number.isFinite(snapshot.measuredBytes)) state.snapshots.push(snapshot);
      }).catch(() => {}));
    }
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  state.config = await (await context.request.get(`${url}/api/config`)).json();
  activeState = state;
  assert.equal(state.config.performance.transport, 'websocket');
  assert.equal(state.config.performance.defaultStreams, 8);
  assert.equal(state.config.performance.maxStreams, 30);
  return state;
}

async function manual(page, count) {
  await openDetails(page);
  if (await page.locator('#test-settings').getAttribute('open') === null) await page.locator('#test-settings > summary').click();
  await page.locator('#mode-manual').check();
  await page.locator('#stream-count').fill(String(count));
  await page.locator('#measurement-duration').selectOption('');
}

async function released(state, { runs, expectedCount } = {}) {
  await Promise.allSettled(state.pending);
  for (const session of state.sessions) assert.equal((await state.context.request.get(`${state.url}/api/upload-sessions/${encodeURIComponent(session)}`)).status(), 404, 'server upload session must be deleted after cancellation/completion');
  for (const run of state.runs) {
    let stats;
    for (let retry = 0; retry < 30; retry += 1) {
      const response = await state.context.request.get(`${state.url}/api/connection-stats?run=${encodeURIComponent(run)}`);
      if (response.status() === 404) {
        assert.ok(!runs?.has(run), 'a completed download must have authoritative server connection statistics');
        break;
      }
      assert.equal(response.status(), 200);
      stats = await response.json();
      if (!stats.activeRequests && !stats.activeTcpConnections) break;
      await state.page.waitForTimeout(50);
    }
    if (stats) {
      assert.equal(stats.activeRequests, 0);
      assert.equal(stats.activeTcpConnections, 0);
      if (runs?.has(run)) assert.equal(stats.peakTcpConnections, expectedCount, 'each completed download must separately prove its real TCP concurrency');
    }
  }
  for (let retry = 0; state.sockets.some(socket => !socket.closed) && retry < 20; retry += 1) await state.page.waitForTimeout(50);
  assert.ok(state.sockets.every(socket => socket.closed), 'every real measurement/probe WebSocket must close');
}

async function complete(state, { name, count = 8, setCount = true, fallback = false } = {}) {
  if (setCount) await manual(state.page, count);
  const firstSocket = state.sockets.length;
  const firstSnapshot = state.snapshots.length;
  const priorRuns = new Set(state.runs);
  const startedAt = Date.now();
  await state.page.locator('#start-button').click();
  await waitPhase(state.page, '正在测量下载', 30000);
  assert.equal(await state.page.locator('#settings-fields').evaluate(fieldset => fieldset.disabled), true);
  await waitPhase(state.page, '正在测量上传');
  await waitPhase(state.page, '测速完成');
  await state.page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  const metrics = await readMetrics(state.page);
  for (const key of ['downloadMbps', 'uploadMbps', 'idleMs', 'jitterMs', 'downloadLoadedMs', 'uploadLoadedMs']) assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0, `${key} must be a finite measurement`);
  assert.ok(metrics.downloadMbps > 0 && metrics.uploadMbps > 0, 'both directions must transfer actual data');
  assert.equal(metrics.failureRate, 0, 'normal server cutoff must not be reported as failed measurement requests');
  assert.equal(Number(metrics.tcpDetails.peak), count, 'backend must observe one real TCP connection per requested stream');
  assert.equal(Number(metrics.tcpDetails.active), 0);
  assert.equal(Number(await state.page.locator('#streams-value').getAttribute('data-peak')), count);
  assert.equal(Number(await state.page.locator('#streams-value').getAttribute('data-active')), 0);
  assert.equal(await state.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(Date.now() - startedAt >= state.config.test.downloadDurationMs + state.config.test.uploadDurationMs, 'full default measurement windows must run');
  await Promise.allSettled(state.pending);
  const snapshots = state.snapshots.slice(firstSnapshot);
  const finalUpload = snapshots.findLast(snapshot => snapshot.finished && snapshot.measuredBytes > 0);
  assert.ok(finalUpload, 'upload result requires a finished server receipt window');
  assert.equal(finalUpload.peakTcpConnections, count, 'each completed upload must separately prove its real TCP concurrency');
  assert.ok(Math.abs(finalUpload.mbps - metrics.uploadMbps) <= Math.max(.01, metrics.uploadMbps * .01), 'displayed upload result must match the authoritative final server window');
  assert.ok(Math.abs(finalUpload.mbps - finalUpload.measuredBytes * 8 / (finalUpload.measurementElapsedMs * 1000)) < .01, 'server result must derive from received bytes and server elapsed time');
  const current = state.sockets.slice(firstSocket);
  if (!fallback) {
    assert.match(metrics.protocol, /WebSocket/);
    assert.equal(current.filter(socket => socket.direction === 'download' && socket.ready && socket.receivedBytes > 0).length, count, 'each download socket must receive ready and actual binary data');
    assert.equal(current.filter(socket => socket.direction === 'upload' && socket.ready).length, count, 'each upload socket must receive ready');
    for (const socket of current.filter(socket => socket.direction === 'upload')) {
      const path = new URL(socket.url).pathname + new URL(socket.url).search;
      const flow = state.networkFixture.stats.flows.find(flow => flow.path === path);
      assert.ok(flow?.uploadBytes > 1024, 'each upload must send actual TCP bytes; Chromium omits Blob payloads from framesent events');
      socket.observedProxyUploadBytes = flow.uploadBytes;
    }
    assert.ok(state.requests.every(request => !(new URL(request.url).pathname === '/api/upload' && request.method === 'POST')), 'normal WebSocket runs must not silently use HTTP upload bodies');
  } else {
    const notice = state.page.locator('#transport-message');
    await notice.waitFor({ state: 'visible' });
    assert.equal(await notice.getAttribute('data-transport'), 'http');
    assert.equal(await notice.getAttribute('data-reason'), 'websocket-unavailable');
    assert.equal(await notice.getAttribute('data-max-streams'), '4');
    assert.ok((await notice.textContent()).includes('4'));
    assert.ok(state.requests.some(request => new URL(request.url).pathname === '/api/upload' && request.method === 'POST'), 'fallback upload must send actual HTTP bodies');
  }
  assert.deepEqual(state.errors, []);
  await released(state, { runs: new Set([...state.runs].filter(run => !priorRuns.has(run))), expectedCount: count });
  await state.page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
  const result = { name, count, fallback, metrics, elapsedMs: Date.now() - startedAt, sockets: current };
  reports.push(result);
  console.log('PASS WebSocket browser', JSON.stringify(result));
  return result;
}

try {
  // Playwright 1.64 forwards every observed WebSocket frame through DevTools,
  // even after frame listeners are removed. Keep that diagnostic traffic
  // bounded; these functional runs verify windows/connections, not NIC capacity.
  const functionalFixture = await createNetworkFixture(baseURL, { downloadMbps: 120, uploadMbps: 60, streams: 30 });
  fixtures.push(functionalFixture);
  const functionalBase = functionalFixture.url;
  if (enabled('concurrency')) {
    const state = await open(functionalBase);
    assert.equal(await state.page.locator('#mode-manual').isChecked(), true);
    assert.equal(await state.page.locator('#stream-count').inputValue(), '8', 'a fresh browser must default to eight connections');
    assert.equal(await state.page.locator('#stream-count').getAttribute('max'), '30');
    await state.page.screenshot({ path: join(artifacts, 'desktop-ready.png'), fullPage: true });
    await complete(state, { name: 'default-eight-complete', count: 8, setCount: false });
    for (const count of manualCounts) await complete(state, { name: `manual-${count}-complete`, count });
    await state.context.close();
  }
  if (enabled('cancel-mobile')) {
    const state = await open(functionalBase, { width: 320, height: 844 });
    await manual(state.page, 8);
    await state.page.screenshot({ path: join(artifacts, 'mobile-advanced-ready.png'), fullPage: true });
    for (const phase of ['正在测量下载', '正在测量上传']) {
      await state.page.locator('#start-button').click();
      await waitPhase(state.page, phase);
      await state.page.locator('#stop-button').click();
      await waitPhase(state.page, '测速已停止');
      await released(state);
      const socketsAfterStop = state.sockets.length;
      await state.page.waitForTimeout(300);
      assert.equal(state.sockets.length, socketsAfterStop, 'cancelled worker must not create more sockets');
    }
    await complete(state, { name: 'mobile-cancel-restart-complete', count: 8 });
    await state.context.close();
  }
  if (enabled('offline-background')) {
    const state = await open(functionalBase);
    await state.page.locator('#start-button').click();
    await waitPhase(state.page, '正在测量下载');
    await state.context.setOffline(true);
    await waitPhase(state.page, '测速已停止');
    await state.context.setOffline(false);
    await released(state);
    await state.page.locator('#start-button').click();
    await waitPhase(state.page, '正在测量下载');
    const extraTab = await state.context.newPage();
    await extraTab.bringToFront();
    const simulated = !await state.page.evaluate(() => document.hidden);
    if (simulated) await state.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await waitPhase(state.page, '测速已停止');
    await extraTab.close();
    if (simulated) await state.page.evaluate(() => { delete document.hidden; });
    await released(state);
    reports.push({ name: 'offline-and-background-stop', simulatedHeadlessVisibility: simulated });
    console.log('PASS WebSocket offline and background cancellation', JSON.stringify({ simulatedHeadlessVisibility: simulated }));
    await state.context.close();
  }
  if (enabled('unavailable')) {
    const fixture = await createNetworkFixture(baseURL, { rejectWebSocket: true });
    fixtures.push(fixture);
    const state = await open(fixture.url);
    await manual(state.page, 30);
    await complete(state, { name: 'websocket-unreachable-http-fallback', count: 4, setCount: false, fallback: true });
    assert.ok(fixture.stats.rejectedUpgrades > 0, 'real WebSocket upgrade must have been rejected by the network fixture');
    await state.context.close();
    await fixture.close();
  }
  if (enabled('low-bandwidth')) {
    const fixture = await createNetworkFixture(baseURL, { downloadMbps: 5, uploadMbps: 2, streams: 8, latencyMs: 150 });
    fixtures.push(fixture);
    const state = await open(fixture.url);
    const result = await complete(state, { name: 'low-bandwidth-eight-complete', count: 8, setCount: false });
    assert.ok(result.metrics.downloadMbps >= 1.5 && result.metrics.downloadMbps <= 6.5, 'real 5 Mbps TCP proxy should deliver a useful bounded download across eight sockets');
    assert.ok(result.metrics.uploadMbps >= .6 && result.metrics.uploadMbps <= 2.6, 'server-received upload should respect the real 2 Mbps TCP proxy budget');
    assert.ok(result.metrics.idleMs >= 100, 'control delay must be visible in measured HTTP ping latency');
    assert.ok(fixture.stats.downloadBytes > 0 && fixture.stats.uploadBytes > 0);
    assert.ok(fixture.stats.maxTransformWritableBytes <= 128 * 1024, 'the fixture Transform write queue must remain bounded; this does not measure browser bufferedAmount');
    result.networkFixture = { ...fixture.stats, downloadMbps: 5, uploadMbps: 2, controlDelayMs: 150, note: 'Limits real WebSocket TCP bytes; the control delay is not a physical TCP ACK RTT model.' };
    console.log('PASS real low-bandwidth TCP fixture', JSON.stringify(result.networkFixture));
    await state.context.close();
    await fixture.close();
  }
  await writeFile(join(artifacts, 'websocket-report.json'), JSON.stringify({ baseURL, functionalNetworkBudget: { downloadMbps: 120, uploadMbps: 60, budgetDivisor: 30, note: 'Functional TCP/byte-window verification with bounded DevTools observation; no NIC-capacity claim.' }, results: reports }, null, 2) + '\n');
} catch (error) {
  let state;
  if (activeState && !activeState.page.isClosed()) {
    state = await activeState.page.evaluate(() => ({ phase: document.querySelector('#phase-label').textContent, status: document.querySelector('#status-message').textContent, error: document.querySelector('#error-message').textContent, transport: { ...document.querySelector('#transport-message').dataset } })).catch(() => null);
    await activeState.page.screenshot({ path: join(artifacts, 'websocket-failure.png'), fullPage: true }).catch(() => {});
  }
  console.error('FAIL WebSocket browser', JSON.stringify({ state, errors: activeState?.errors, sockets: activeState?.sockets, recentServerSnapshots: activeState?.snapshots.slice(-3) }));
  await writeFile(join(artifacts, 'websocket-partial-report.json'), JSON.stringify({ baseURL, error: error.message, state, results: reports }, null, 2) + '\n');
  throw error;
} finally {
  for (const fixture of fixtures) await fixture.close();
  await browser.close();
}
