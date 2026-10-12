import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails, readMetrics, waitPhase } from './browser-helpers.mjs';
import { createNetworkFixture } from './browser-network-fixture.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-network-info';
await mkdir(artifacts, { recursive: true });
const fixture = await createNetworkFixture(baseURL, { downloadMbps: 120, uploadMbps: 60, streams: 8 });
const browser = await launchBrowser();
const errors = [];
const results = [];
let current;
const payload = (client, server) => ({ client, server });
const configuredServer = label => ({ scope: 'unknown', name: 'Fixture server', location: { status: 'resolved', source: 'configured', label, approximate: false } });
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });

async function open(responseHandler, pingHandler) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();
  current = page;
  const state = { context, page, networkRequests: 0, snapshots: [], pending: [], sessions: new Set() };
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/network-info*', route => {
    state.networkRequests += 1;
    return responseHandler(route);
  });
  if (pingHandler) await context.route('**/api/ping*', pingHandler);
  context.on('response', response => {
    if (/\/api\/upload-sessions(?:\/[^/?]+)?(?:\?|$)/.test(response.url()) && response.status() >= 200 && response.status() < 300 && response.status() !== 204) {
      state.pending.push(response.json().then(snapshot => {
        if (snapshot.id) state.sessions.add(snapshot.id);
        if (Number.isFinite(snapshot.measuredBytes)) state.snapshots.push(snapshot);
      }).catch(() => {}));
    }
  });
  // Waiting for networkidle would hide whether a slow location API blocks the
  // independent configuration/startup path being tested here.
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  assert.equal(await page.locator('#more-details').isVisible(), false);
  for (const id of ['client-ip', 'client-location', 'server-location']) assert.equal(await page.locator(`#${id}`).isVisible(), false, 'network details belong only inside More');
  return state;
}

async function unmeasured(page) {
  for (const id of ['download-value', 'upload-value']) {
    assert.equal(await page.locator(`#${id}`).textContent(), '0');
    assert.equal(await page.locator(`#${id}`).getAttribute('data-mbps'), null, 'zero is pending, not a fabricated measurement');
    const channels = await page.locator(`#${id}`).evaluate(element => getComputedStyle(element).color.match(/\d+/g).slice(0, 3).map(Number));
    assert.ok(channels.every(channel => channel >= 120), 'pending values must remain gray');
  }
}

try {
  // The following IP/proxy/location values are explicit UI fixtures. Actual
  // trusted-proxy interpretation and real providers are covered by Go tests.
  let releaseGeo;
  let releasePing;
  let pingStarted;
  const geoGate = new Promise(resolve => { releaseGeo = resolve; });
  const pingGate = new Promise(resolve => { releasePing = resolve; });
  const firstPing = new Promise(resolve => { pingStarted = resolve; });
  const maliciousCity = '<img src=x onerror="window.__geoInjected=true">';
  const literalServer = '<b>企业机房</b> · 冷通道';
  const geo = payload({ ip: '203.0.113.7', scope: 'public', proxied: true, location: { status: 'resolved', source: 'geoip', country: 'United States', countryCode: 'US', region: 'California', city: maliciousCity, approximate: true } }, configuredServer(literalServer));
  const delayed = await open(async route => { await geoGate; await fulfill(route, geo).catch(() => {}); }, async route => { pingStarted(); await pingGate; await route.continue().catch(() => {}); });
  await delayed.page.waitForFunction(() => document.querySelector('#client-ip').dataset.status === 'loading');
  assert.equal(delayed.networkRequests, 1);
  await unmeasured(delayed.page);
  const upgradesBefore = fixture.stats.upgrades;
  await delayed.page.locator('#start-button').click();
  await Promise.race([firstPing, new Promise((_, reject) => setTimeout(() => reject(new Error('measurement did not start while location lookup was pending')), 10000))]);
  await delayed.page.locator('#stop-button').click();
  await waitPhase(delayed.page, '测速已停止');
  releasePing();
  assert.equal(fixture.stats.upgrades, upgradesBefore, 'cancelling before latency samples must not start any data WebSocket');
  await unmeasured(delayed.page);
  releaseGeo();
  await delayed.page.waitForFunction(() => document.querySelector('#client-location').dataset.status === 'resolved');
  await openDetails(delayed.page);
  assert.equal(await delayed.page.locator('#client-ip').textContent(), '203.0.113.7');
  assert.match(await delayed.page.locator('#client-ip').getAttribute('title'), /可信代理/);
  assert.ok((await delayed.page.locator('#client-location').textContent()).includes('美国'));
  assert.ok((await delayed.page.locator('#client-location').textContent()).includes(maliciousCity));
  assert.equal(await delayed.page.locator('#server-location').textContent(), literalServer);
  assert.equal(await delayed.page.locator('#client-location img, #server-location b, #client-location script, #server-location script').count(), 0, 'provider/configuration strings must render as literal text');
  assert.equal(await delayed.page.evaluate(() => Boolean(window.__geoInjected)), false);
  assert.equal(await delayed.page.locator('#client-location-note').isVisible(), true);
  assert.equal(await delayed.page.locator('#server-location-note').isVisible(), false);
  await delayed.page.locator('#language-select').selectOption('en');
  assert.ok((await delayed.page.locator('#client-location').textContent()).includes('United States'));
  assert.match(await delayed.page.locator('#client-ip').getAttribute('title'), /trusted proxy/i);
  await delayed.page.waitForTimeout(100);
  assert.equal(delayed.networkRequests, 1, 'changing language must reuse the cached location response');
  await unmeasured(delayed.page);
  await delayed.page.screenshot({ path: join(artifacts, 'fixture-network-info-literal-desktop.png'), fullPage: true });
  await delayed.page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await delayed.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const boxes = await Promise.all(['client-ip', 'client-location', 'server-location'].map(id => delayed.page.locator(`#${id}`).boundingBox()));
  assert.ok(boxes[0].y < boxes[1].y && boxes[1].y < boxes[2].y, 'mobile network information should stack in one column');
  await delayed.page.screenshot({ path: join(artifacts, 'fixture-network-info-literal-mobile.png'), fullPage: true });
  results.push({ name: 'delayed-api-start-cancel-gray-zero-localization-and-safe-literal-text', fixtureIP: '203.0.113.7', networkRequests: delayed.networkRequests });
  console.log('PASS delayed network information, early cancellation, safe text and cached localization');
  await delayed.context.close();

  const failed = await open(route => fulfill(route, { error: 'fixture unavailable' }, 503));
  await failed.page.waitForFunction(() => document.querySelector('#client-ip').dataset.status === 'unavailable');
  assert.equal(await failed.page.locator('#error-message').isVisible(), false, 'an informational lookup error must not become a measurement error');
  assert.equal(await failed.page.locator('#start-button').isEnabled(), true);
  await unmeasured(failed.page);
  await failed.page.locator('#start-button').click();
  await waitPhase(failed.page, '正在测量下载');
  await failed.page.waitForFunction(() => Number(document.querySelector('#download-value').dataset.mbps) > 0, null, { timeout: 10000 });
  await waitPhase(failed.page, '正在测量上传');
  assert.equal(await failed.page.locator('#upload-value').textContent(), '0');
  assert.equal(await failed.page.locator('#upload-value').getAttribute('data-mbps'), null);
  await waitPhase(failed.page, '测速完成');
  const metrics = await readMetrics(failed.page);
  assert.ok(metrics.downloadMbps > 0 && metrics.uploadMbps > 0, 'a failed location lookup must allow a full real bidirectional measurement');
  assert.equal(metrics.failureRate, 0);
  assert.equal(Number(metrics.tcpDetails.peak), 8);
  assert.equal(Number(metrics.tcpDetails.active), 0);
  assert.equal(Number(await failed.page.locator('#streams-value').getAttribute('data-active')), 0);
  await Promise.allSettled(failed.pending);
  assert.ok(failed.snapshots.some(snapshot => snapshot.finished && snapshot.measuredBytes > 0), 'upload must have a completed server-received byte window');
  for (const id of failed.sessions) assert.equal((await failed.context.request.get(`${fixture.url}/api/upload-sessions/${encodeURIComponent(id)}`)).status(), 404);
  await openDetails(failed.page);
  for (const id of ['client-ip', 'client-location', 'server-location']) assert.equal(await failed.page.locator(`#${id}`).getAttribute('data-status'), 'unavailable');
  await failed.page.locator('#language-select').selectOption('en');
  assert.equal(failed.networkRequests, 1);
  await failed.page.screenshot({ path: join(artifacts, 'network-info-503-full-eight-complete.png'), fullPage: true });
  results.push({ name: 'network-info-503-full-default-eight-measurement', metrics, networkRequests: failed.networkRequests });
  console.log('PASS location failure preserves complete eight-stream measurement', JSON.stringify(metrics));
  await failed.context.close();

  const internal = await open(route => fulfill(route, payload({ ip: '10.20.30.40', scope: 'private', proxied: false, location: { status: 'internal', source: 'network' } }, { scope: 'unknown', location: { status: 'disabled', source: 'disabled' } })));
  await internal.page.waitForFunction(() => document.querySelector('#client-location').dataset.status === 'internal');
  await openDetails(internal.page);
  assert.equal(await internal.page.locator('#client-ip').textContent(), '10.20.30.40');
  assert.equal(await internal.page.locator('#client-location').textContent(), '内网');
  assert.equal(await internal.page.locator('#server-location').textContent(), '未启用定位');
  assert.match(await internal.page.locator('#client-ip').getAttribute('title'), /服务看到/);
  await internal.page.locator('#language-select').selectOption('en');
  assert.equal(await internal.page.locator('#client-location').textContent(), 'Private network');
  assert.equal(await internal.page.locator('#server-location').textContent(), 'Location lookup disabled');
  assert.equal(internal.networkRequests, 1);
  await unmeasured(internal.page);
  results.push({ name: 'private-network-and-disabled-location-localization', fixtureIP: '10.20.30.40', networkRequests: internal.networkRequests });
  console.log('PASS private and disabled location labels');
  await internal.context.close();

  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'network-info-report.json'), JSON.stringify({ baseURL, results, errors, note: 'Mock geography/proxy values are deterministic UI fixtures. The measurement uses actual WebSocket TCP bytes and authoritative server upload progress through a bounded 120/60 Mbps test proxy.' }, null, 2) + '\n');
} catch (error) {
  if (current && !current.isClosed()) {
    console.error('FAIL network-info browser', JSON.stringify(await current.evaluate(() => ({ phase: document.querySelector('#phase-label').dataset.phase, error: document.querySelector('#error-message').textContent, fields: ['client-ip', 'client-location', 'server-location'].map(id => ({ id, text: document.getElementById(id).textContent, status: document.getElementById(id).dataset.status })) })).catch(() => null)));
    await current.screenshot({ path: join(artifacts, 'network-info-failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await fixture.close();
}
