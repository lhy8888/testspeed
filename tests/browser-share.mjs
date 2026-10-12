import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails } from './browser-helpers.mjs';
import { HISTORY_KEY, toShareRecord } from '../web/results.js';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-share';
const token = process.env.SHARE_WRITE_TOKEN || '';
await mkdir(artifacts, { recursive: true });
const browser = await launchBrowser();
const errors = [];
const cases = [];
const cleanup = [];
let current;
const maliciousName = '<img src=x onerror="window.__shareInjected=true"> · 测试节点';
// These values are explicit client report fixtures, never throughput evidence.
// The API, SQLite writes/reads, shared page and deletion requests are all real.
const fixture = {
  schemaVersion: 1, completedAt: '2026-10-12T11:00:00.000Z', node: { id: 'fixture', name: maliciousName },
  testType: 'full', measurementPolicy: 'fixed', transport: 'websocket', mode: 'manual', maxBytes: 0,
  download: { mbps: 1000, durationMs: 10000, measuredBytes: 1250000000, totalBytes: 1400000000, completionReason: 'duration', complete: true },
  upload: { mbps: 20, durationMs: 10000, measuredBytes: 25000000, totalBytes: 30000000, completionReason: 'duration', complete: true },
  latency: { idle: { medianMs: 20, jitterMs: 1, samples: 2, failed: 0, attempts: 2 }, download: { medianMs: 30, jitterMs: 2, samples: 2, failed: 0, attempts: 2 }, upload: { medianMs: 40, jitterMs: 3, samples: 2, failed: 0, attempts: 2 } },
  connections: { downloadPeak: 8, uploadPeak: 8 },
};

async function openShared(context, url) {
  const page = await context.newPage();
  current = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL(url, baseURL).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#share-result').hidden || !/Loading|正在读取/.test(document.querySelector('#share-status').textContent));
  return page;
}

async function post(context, value) {
  const response = await context.request.post(`${baseURL}/api/results`, { data: toShareRecord(value), headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal(response.status(), 201, await response.text());
  const data = await response.json();
  assert.match(data.id, /^[a-f0-9]{32}$/);
  assert.match(data.deleteToken, /^[a-f0-9]{32}$/);
  assert.equal(data.url, `/share.html?id=${data.id}`);
  cleanup.push(data);
  return data;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const configResponse = await context.request.get(`${baseURL}/api/config`);
  assert.equal(configResponse.status(), 200);
  const config = await configResponse.json();
  assert.equal(JSON.stringify(config).includes('ShareWriteToken'), false);
  if (token) assert.equal(JSON.stringify(config).includes(token), false, 'configuration must never expose the write token');
  let posts = 0;
  context.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/results') posts += 1; });
  await context.addInitScript(({ key, report }) => {
    localStorage.setItem(key, JSON.stringify([report]));
    localStorage.setItem('light-speed:language:v1', 'zh');
  }, { key: HISTORY_KEY, report: fixture });
  const main = await context.newPage();
  current = main;
  main.on('pageerror', error => errors.push(error.message));
  await main.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await main.waitForFunction(() => !document.querySelector('#start-button').disabled);
  await openDetails(main);
  await main.waitForFunction(() => document.querySelector('#history-select').options.length === 1 && !document.querySelector('#history-select').disabled);
  assert.equal(posts, 0, 'history must not produce automatic server telemetry');

  if (config.features.sharing !== true) {
    assert.equal(await main.locator('#share-tools').isVisible(), false);
    const disabled = await context.request.post(`${baseURL}/api/results`, { data: toShareRecord(fixture) });
    assert.equal(disabled.status(), 404);
    cases.push({ name: 'default-disabled-no-automatic-telemetry', sharing: false });
    console.log('PASS result sharing is disabled by default with no automatic telemetry');
  } else {
    assert.equal(config.features.shareRequiresToken, Boolean(token), 'provide SHARE_WRITE_TOKEN only when the test server requires it');
    assert.equal(await main.locator('#share-tools').isVisible(), true);
    assert.equal(await main.locator('#share-token-label').isVisible(), Boolean(token));
    if (token) {
      const rejected = await context.request.post(`${baseURL}/api/results`, { data: toShareRecord(fixture) });
      assert.equal(rejected.status(), 401);
      const beforeMissingToken = posts;
      await main.locator('#share-result').click();
      assert.match(await main.locator('#share-status').textContent(), /令牌/);
      assert.equal(posts, beforeMissingToken, 'missing token in UI must not trigger another POST');
      await main.locator('#share-token').fill(token);
    }
    const saved = main.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/results');
    await main.locator('#share-result').click();
    const savedResponse = await saved;
    assert.equal(savedResponse.status(), 201, await savedResponse.text());
    const full = await savedResponse.json();
    cleanup.push(full);
    await main.waitForFunction(() => !document.querySelector('#share-link').hidden);
    assert.equal(await main.locator('#share-link').getAttribute('href'), new URL(full.url, baseURL).href);
    assert.equal(await main.locator('#share-token').inputValue(), '', 'ephemeral write token must be cleared');
    if (token) assert.equal(await main.evaluate(secret => JSON.stringify(localStorage).includes(secret), token), false, 'credentials cannot enter local history');
    const read = await context.request.get(`${baseURL}/api/results/${full.id}`);
    assert.equal(read.status(), 200);
    const publicRecord = await read.json();
    assert.equal(publicRecord.provenance, 'client-reported');
    assert.equal(publicRecord.result.node.name, maliciousName);
    const publicJSON = JSON.stringify(publicRecord);
    for (const forbidden of ['clientIp', 'userAgent', 'networkInfo', 'deleteToken', 'writeToken']) assert.equal(publicJSON.includes(`"${forbidden}"`), false);
    assert.equal(publicJSON.includes(full.deleteToken), false);
    assert.equal(publicRecord.result.maxBytes, undefined);
    const forged = await context.request.post(`${baseURL}/api/results`, { data: toShareRecord(fixture), headers: { Origin: 'https://untrusted.invalid', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    assert.equal(forged.status(), 403, 'sharing writes must inherit the server origin checks');
    const page = await openShared(context, full.url);
    assert.equal(await page.locator('#share-result').isVisible(), true);
    assert.equal(await page.locator('#share-download').textContent(), '1');
    assert.equal(await page.locator('#share-download-unit').textContent(), 'Gbps');
    assert.equal(await page.locator('#share-upload').textContent(), '20');
    assert.equal(await page.locator('#share-node').textContent(), maliciousName);
    assert.equal(await page.locator('#share-node img, #share-node script').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.__shareInjected)), false);
    assert.match(await page.locator('.share-provenance').textContent(), /未经服务器认证/);
    await page.locator('#share-language').selectOption('en');
    assert.match(await page.locator('.share-provenance').textContent(), /without server certification/);
    await page.screenshot({ path: join(artifacts, 'shared-fixture-full-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, 'shared-fixture-full-mobile.png'), fullPage: true });
    const unauthorizedDelete = await context.request.delete(`${baseURL}/api/results/${full.id}`);
    assert.equal(unauthorizedDelete.status(), 403);
    await main.locator('#share-revoke').click();
    await main.waitForFunction(() => document.querySelector('#share-link').hidden && document.querySelector('#share-revoke').hidden);
    assert.equal((await context.request.get(`${baseURL}/api/results/${full.id}`)).status(), 404);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#share-status').textContent.includes('expires') || document.querySelector('#share-status').textContent.includes('expired') || document.querySelector('#share-status').textContent.includes('过期'));
    assert.equal(await page.locator('#share-result').isVisible(), false);
    cases.push({ name: 'explicit-real-sqlite-create-public-read-safe-text-language-mobile-revoke', id: full.id, requiresToken: Boolean(token) });
    console.log('PASS explicit sharing, SQLite API, safe shared page and revocation');

    const latency = structuredClone(fixture);
    Object.assign(latency, { testType: 'latency', download: null, upload: null, transport: null, connections: { downloadPeak: null, uploadPeak: null } });
    latency.latency.download = latency.latency.upload = null;
    const latencyShare = await post(context, latency);
    const latencyPage = await openShared(context, latencyShare.url);
    assert.equal(await latencyPage.locator('#share-transfer').isVisible(), false);
    assert.equal(await latencyPage.locator('#share-upload-summary').isVisible(), false);
    assert.equal(await latencyPage.locator('#share-latency').textContent(), '20');
    cases.push({ name: 'latency-only-share-hides-skipped-transfer-values', id: latencyShare.id });

    const budget = structuredClone(fixture);
    Object.assign(budget, { testType: 'download', upload: null, connections: { downloadPeak: 8, uploadPeak: null } });
    budget.download = { mbps: null, durationMs: 0, measuredBytes: 0, totalBytes: 5000, completionReason: 'budget', complete: false };
    budget.latency.download = { medianMs: null, jitterMs: null, samples: 0, failed: 0, attempts: 0 };
    budget.latency.upload = null;
    const budgetShare = await post(context, budget);
    const budgetPage = await openShared(context, budgetShare.url);
    assert.equal(await budgetPage.locator('#share-download').textContent(), '—', 'unmeasured budget stops cannot become a false zero');
    assert.equal(await budgetPage.locator('#share-incomplete').isVisible(), true);
    assert.equal(await budgetPage.locator('#share-upload-summary').isVisible(), false);
    cases.push({ name: 'budget-before-measurement-keeps-null-throughput', id: budgetShare.id });
    console.log('PASS skipped and budget-limited phases preserve unavailable measurements');
  }

  const invalid = await openShared(context, '/share.html?id=javascript:invalid');
  assert.equal(await invalid.locator('#share-result').isVisible(), false);
  assert.match(await invalid.locator('#share-status').textContent(), /不存在|does not exist/);
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'share-report.json'), JSON.stringify({ baseURL, cases, errors, note: 'Client metric values and malicious node text are explicit fixtures. Requests use the real sharing API and SQLite storage; this test makes no bandwidth claim and captures no WebSocket payloads or credentials.' }, null, 2) + '\n');
} catch (error) {
  if (current && !current.isClosed()) await current.screenshot({ path: join(artifacts, 'share-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  // Deletion capabilities remain only in this process and are never written to
  // the report or browser history. Owned fixtures leave no public records.
  await Promise.allSettled(cleanup.map(value => fetch(`${baseURL}/api/results/${value.id}`, { method: 'DELETE', headers: { 'X-Delete-Token': value.deleteToken } })));
  await browser.close();
}
