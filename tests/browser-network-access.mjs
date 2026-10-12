import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blockWorkerURLs, launchBrowser, openDetails, readMetrics, waitPhase } from './browser-helpers.mjs';

const multiBase = process.env.MULTIPORT_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:8080';
const singleBase = process.env.SINGLEPORT_BASE_URL;
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-network-access';
const transportNotice = process.env.TRANSPORT_NOTICE_SELECTOR || '#transport-message';
const cases = process.env.NETWORK_CASES ? new Set(process.env.NETWORK_CASES.split(',')) : null;
const enabled = name => !cases || cases.has(name);
if (enabled('single-port') && !singleBase) throw new Error('SINGLEPORT_BASE_URL is required for the complete network-access suite. Set NETWORK_CASES explicitly to run a diagnostic subset without this fixture.');
await mkdir(artifacts, { recursive: true });
const browser = await launchBrowser();
browser.on('disconnected', () => console.log('BROWSER disconnected'));
const results = [];

async function open(baseURL, routeInstaller) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const snapshots = [];
  const sessions = new Set();
  const pendingSnapshots = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => console.error('PAGE crashed', baseURL));
  const config = await (await context.request.get(`${baseURL}/api/config`)).json();
  assert.equal(config.performance.transport, 'http', 'network-access cases require explicit HTTP fixtures; default WebSocket coverage is in browser-websocket.mjs');
  const controlOrigin = new URL(baseURL).origin;
  const dataOrigins = [...new Set(config.performance.measurementOrigins.map(url => new URL(url).origin))];
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push({ url: request.url(), origin: url.origin, path: url.pathname, method: request.method(), bytes: url.searchParams.get('bytes'), stream: url.searchParams.get('stream') });
  });
  context.on('response', response => {
    if (/\/api\/upload-sessions(?:\/[^/?]+)?(?:\?|$)/.test(response.url()) && response.status() >= 200 && response.status() < 300 && response.status() !== 204) {
      pendingSnapshots.push(response.json().then(snapshot => { if (snapshot.id) sessions.add(snapshot.id); if (Number.isFinite(snapshot.measuredBytes)) snapshots.push(snapshot); }).catch(() => {}));
    }
  });
  const state = { baseURL, context, page, errors, requests, snapshots, sessions, pendingSnapshots, config, controlOrigin, dataOrigins };
  if (routeInstaller) await routeInstaller(state);
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  return state;
}

async function setManual(page, streams) {
  await openDetails(page);
  if (await page.locator('#test-settings').getAttribute('open') === null) await page.locator('#test-settings > summary').click();
  await page.locator('#mode-manual').check();
  await page.locator('#stream-count').fill(String(streams));
  await page.locator('#measurement-duration').selectOption('');
}

async function verifySessionCleanup(state) {
  await Promise.allSettled(state.pendingSnapshots);
  for (const id of state.sessions) {
    const response = await state.context.request.get(`${state.baseURL}/api/upload-sessions/${encodeURIComponent(id)}`);
    assert.equal(response.status(), 404, 'upload progress sessions must be deleted after the worker stops');
  }
}

async function finish(state, { name, capacity, manual, warning, onlyOrigin }) {
  if (manual !== undefined) await setManual(state.page, manual);
  await state.page.locator('#start-button').click();
  try {
    await waitPhase(state.page, '正在测量下载', 30000);
    assert.equal(Number(await state.page.locator('#stream-count').getAttribute('max')), capacity, 'readiness must scope capacity before upload bodies start');
  } catch (error) {
    if (!state.page.isClosed()) {
      console.error('FAIL readiness state', JSON.stringify(await state.page.evaluate(() => ({ phase: document.querySelector('#phase-label').textContent, error: document.querySelector('#error-message').textContent, transport: document.querySelector('#transport-message')?.textContent }))));
      await state.page.screenshot({ path: join(artifacts, `${name}-failure.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  }
  await waitPhase(state.page, '正在测量上传');
  await waitPhase(state.page, '测速完成');
  await state.page.waitForFunction(() => !document.querySelector('#start-button').disabled && !document.querySelector('#start-button').hidden);
  const metrics = await readMetrics(state.page);
  assert.ok(metrics.downloadMbps > 0 && metrics.uploadMbps > 0, 'both directions must count actual bytes');
  assert.equal(Number(await state.page.locator('#stream-count').getAttribute('max')), capacity, 'UI must advertise the actual reachable origin capacity');
  assert.ok(Number(metrics.tcpDetails.peak) > 0 && Number(metrics.tcpDetails.peak) <= capacity, 'observed TCP peak must stay inside reachable capacity');
  if (manual !== undefined) assert.equal(Number(metrics.tcpDetails.peak), Math.min(manual, capacity), 'manual requested streams must match actual reachable TCP concurrency');
  assert.equal(Number(metrics.tcpDetails.active), 0);
  assert.equal(Number(await state.page.locator('#streams-value').getAttribute('data-active')), 0);
  await Promise.allSettled(state.pendingSnapshots);
  assert.ok(state.snapshots.some(snapshot => snapshot.measuredBytes > 0), 'upload must have positive server-received progress');
  await verifySessionCleanup(state);
  let notice = null;
  if (warning) {
    await state.page.locator(transportNotice).waitFor({ state: 'visible' });
    notice = (await state.page.locator(transportNotice).textContent()).trim();
    assert.ok(notice.length > 0 && notice.includes(String(capacity)), 'reachable capacity/fallback explanation must be visible');
  }
  const formal = state.requests.filter(request => request.path === '/api/upload' || request.path === '/api/download' && request.stream === '1');
  assert.ok(formal.some(request => request.path === '/api/download') && formal.some(request => request.path === '/api/upload'));
  if (onlyOrigin) assert.ok(formal.every(request => request.origin === onlyOrigin), 'fallback must actually use the healthy control origin');
  assert.deepEqual(state.errors, []);
  await state.page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
  const result = { name, capacity, requestedManualStreams: manual, notice, metrics, configuredDuration: state.config.test, actualFormalOrigins: [...new Set(formal.map(request => request.origin))] };
  results.push(result);
  console.log('PASS network access', JSON.stringify(result));
}

try {
  if (enabled('blocked-data')) {
    const state = await open(multiBase, async state => {
      assert.equal(state.dataOrigins.length, 4, 'this scenario requires the explicit four-port deployment');
      state.blocking = await blockWorkerURLs(state.context, state.page, state.dataOrigins.map(origin => `${origin}/*`));
    });
    await finish(state, { name: 'blocked-all-data-fallback-control', capacity: 4, manual: 24, warning: true, onlyOrigin: state.controlOrigin });
    await state.context.close();
  }

  if (enabled('partial-data')) {
    const state = await open(multiBase, async state => {
      assert.equal(state.dataOrigins.length, 4);
      const blocked = state.dataOrigins.slice(2);
      state.blocking = await blockWorkerURLs(state.context, state.page, blocked.map(origin => `${origin}/*`));
    });
    await finish(state, { name: 'two-reachable-data-origins', capacity: 12, manual: 24, warning: true });
    const formal = state.requests.filter(request => request.path === '/api/upload' || request.path === '/api/download' && request.stream === '1');
    assert.deepEqual([...new Set(formal.map(request => request.origin))].sort(), state.dataOrigins.slice(0, 2).sort(), 'formal transfers must use exactly the reachable data origins');
    await state.context.close();
  }

  if (enabled('all-data')) {
    const state = await open(multiBase);
    await finish(state, { name: 'all-four-data-origins-manual-24', capacity: 24, manual: 24 });
    await state.context.close();
  }

  if (enabled('all-blocked')) {
    const state = await open(multiBase, async state => {
      state.blocking = await blockWorkerURLs(state.context, state.page, [...state.dataOrigins, state.controlOrigin].flatMap(origin => ['ping', 'download', 'upload', 'upload-sessions'].map(path => `${origin}/api/${path}*`)));
    });
    await state.page.locator('#start-button').click();
    await state.page.locator('#error-message').waitFor({ state: 'visible', timeout: 20000 });
    const message = (await state.page.locator('#error-message').textContent()).trim();
    assert.ok(message.length > 0);
    assert.notEqual(await state.page.locator('#phase-label').getAttribute('data-phase'), 'complete');
    assert.equal(state.requests.filter(request => request.path === '/api/upload').length, 0, 'unreachable control service must not produce a false completed upload');
    assert.deepEqual(state.errors, []);
    await state.page.screenshot({ path: join(artifacts, 'control-and-data-unreachable.png'), fullPage: true });
    results.push({ name: 'control-and-data-unreachable', message });
    console.log('PASS all measurement endpoints unreachable', message);
    await state.context.close();
  }

  if (enabled('cancel-probe')) {
    let firstProbe;
    const probeStarted = new Promise(resolve => { firstProbe = resolve; });
    const state = await open(multiBase, async state => {
      await state.context.route(url => state.dataOrigins.includes(url.origin) && url.pathname === '/api/download' && url.searchParams.has('bytes'), async route => {
        firstProbe();
        await new Promise(resolve => setTimeout(resolve, 3000));
        await route.continue().catch(() => {});
      });
    });
    await state.page.locator('#start-button').click();
    await Promise.race([probeStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('readiness probe did not start')), 15000))]);
    await state.page.locator('#stop-button').click();
    await waitPhase(state.page, '测速已停止', 10000);
    const requestsAfterStop = state.requests.length;
    await state.page.waitForTimeout(2000);
    assert.equal(state.requests.length, requestsAfterStop, 'cancelled readiness must not start further requests');
    assert.equal(state.requests.filter(request => request.path === '/api/download' && request.origin === state.controlOrigin).length, 0, 'cancelled probes must not proceed to control-origin fallback');
    assert.equal(state.requests.filter(request => request.stream === '1' || request.path === '/api/upload').length, 0, 'cancelled readiness must not start measurement windows');
    assert.deepEqual(state.errors, []);
    results.push({ name: 'cancel-during-readiness', requestsAfterStop });
    console.log('PASS readiness cancellation stops probes and fallback');
    await state.context.close();
  }

  if (enabled('single-port') && singleBase) {
    const state = await open(singleBase);
    assert.deepEqual(state.dataOrigins, [state.controlOrigin], 'single-port deployment should configure only its own main origin');
    await finish(state, { name: 'single-port-default-complete', capacity: 4, onlyOrigin: state.controlOrigin });
    await state.context.close();
  }
  await writeFile(join(artifacts, 'network-access-report.json'), JSON.stringify({ baseMultiPort: multiBase, baseSinglePort: singleBase || null, results }, null, 2) + '\n');
} finally {
  await browser.close();
}
