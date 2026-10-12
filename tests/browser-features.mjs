import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails } from './browser-helpers.mjs';
import { createNetworkFixture } from './browser-network-fixture.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-features';
const shareBaseURL = process.env.SHARE_BASE_URL;
const tokenBaseURL = process.env.SHARE_TOKEN_BASE_URL;
await mkdir(artifacts, { recursive: true });
const fixture = await createNetworkFixture(baseURL, { downloadMbps: 120, uploadMbps: 60, streams: 8, latencyMs: 40 });
const browser = await launchBrowser();
const errors = [];
const report = { baseURL, tests: [], errors };
let page;
async function prepare(context, url) {
  // Read only small final Worker summaries. Do not observe binary frames,
  // replace WebSocket or intercept upload bodies while a test is running.
  await context.addInitScript(() => {
    window.__featureResults = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => { if (data.type === 'result') window.__featureResults.push(data.result); });
      }
    };
  });
  const currentPage = await context.newPage();
  currentPage.on('pageerror', error => errors.push(error.message));
  await currentPage.goto(url, { waitUntil: 'networkidle' });
  await currentPage.waitForFunction(() => !document.querySelector('#start-button').disabled);
  await openDetails(currentPage);
  await currentPage.locator('#test-settings').evaluate(element => { element.open = true; });
  return currentPage;
}
async function run(currentPage) {
  const count = await currentPage.evaluate(() => window.__featureResults.length);
  await currentPage.locator('#start-button').click();
  await currentPage.waitForFunction(previous => document.querySelector('#phase-label').dataset.phase === 'complete' && window.__featureResults.length > previous, count, { timeout: 45000 });
  return currentPage.evaluate(() => window.__featureResults.at(-1));
}
async function budget(currentPage, mib) {
  await currentPage.locator('#traffic-budget').selectOption('custom');
  await currentPage.locator('#custom-budget-mib').fill(String(mib));
  await currentPage.locator('#custom-budget-mib').dispatchEvent('change');
}
async function downloaded(currentPage, selector, name) {
  const pending = currentPage.waitForEvent('download');
  await currentPage.locator(selector).click();
  const download = await pending;
  const path = join(artifacts, name);
  await download.saveAs(path);
  return readFile(path);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('light-speed:settings:v3', JSON.stringify({ mode: 'manual', streams: 8, durationMs: 10000 })));
  page = await prepare(context, fixture.url);
  assert.equal(await page.locator('#stream-count').inputValue(), '8');
  assert.equal(await page.locator('#test-type').inputValue(), 'full');
  assert.equal(await page.locator('#measurement-policy').inputValue(), 'fixed');
  assert.equal(await page.locator('#traffic-budget').inputValue(), '0');
  assert.equal(await page.locator('#share-tools').isVisible(), false, 'sharing is disabled on the default server');

  await page.locator('#test-type').selectOption('latency');
  assert.equal(await page.locator('#download-unit').textContent(), 'ms');
  assert.equal(await page.locator('#download-value').textContent(), '0');
  const upgradesBefore = fixture.stats.upgrades;
  const latency = await run(page);
  assert.equal(latency.testType, 'latency');
  assert.equal(latency.download, null);
  assert.equal(latency.upload, null);
  assert.equal(latency.transport, null);
  assert.equal(fixture.stats.upgrades, upgradesBefore, 'latency-only must not open speed-test connections');
  assert.ok(latency.latency.idle.samples > 0);
  assert.equal(await page.locator('#download-value').getAttribute('data-mbps'), null);
  assert.ok(Number(await page.locator('#download-value').getAttribute('data-latency-ms')) > 0);
  assert.equal(await page.locator('#upload-value').textContent(), 'Not tested');
  report.tests.push({ test: 'latency-only', speedUpgrades: 0, idleSamples: latency.latency.idle.samples, displayedUnit: 'ms' });

  await page.locator('#test-type').selectOption('download');
  await budget(page, 1);
  const flowsBefore = fixture.stats.flows.length;
  const earlyBudget = await run(page);
  assert.equal(earlyBudget.download.completionReason, 'budget');
  assert.equal(earlyBudget.download.complete, false);
  assert.equal(earlyBudget.download.mbps, null);
  assert.equal(earlyBudget.download.incompleteReason, 'budget-before-measurement');
  assert.equal(earlyBudget.upload, null);
  assert.ok(earlyBudget.download.totalBytes >= 1024 ** 2);
  assert.equal(await page.locator('#download-value').getAttribute('data-mbps'), null);
  assert.equal(await page.locator('#download-value').textContent(), '0');
  assert.equal(await page.locator('#upload-value').textContent(), 'Not tested');
  assert.equal(fixture.stats.flows.slice(flowsBefore).some(flow => flow.direction === 'upload'), false);
  assert.match(await page.locator('#completion-note').textContent(), /before valid measurement/);
  report.tests.push({ test: 'warm-up budget', requestedBytes: 1024 ** 2, actualBytes: earlyBudget.download.totalBytes, mbps: null, upload: null });

  await budget(page, 64);
  const measuredBudget = await run(page);
  assert.equal(measuredBudget.download.completionReason, 'budget');
  assert.equal(measuredBudget.download.complete, true);
  assert.ok(measuredBudget.download.mbps > 0);
  assert.ok(measuredBudget.download.measuredBytes > 0);
  assert.ok(measuredBudget.download.durationMs > 0 && measuredBudget.download.durationMs < 10000);
  assert.ok(measuredBudget.download.totalBytes >= 64 * 1024 ** 2);
  assert.equal(measuredBudget.upload, null);
  assert.equal(await page.locator('#upload-value').getAttribute('data-mbps'), null);
  report.tests.push({ test: 'measured budget', requestedBytes: 64 * 1024 ** 2, actualBytes: measuredBudget.download.totalBytes, mbps: measuredBudget.download.mbps, durationMs: measuredBudget.download.durationMs });

  await page.locator('#traffic-budget').selectOption('0');
  await page.locator('#measurement-policy').selectOption('adaptive');
  const adaptive = await run(page);
  assert.equal(adaptive.download.completionReason, 'stable');
  assert.ok(adaptive.download.durationMs >= 5000 && adaptive.download.durationMs < 10000, 'stable mode must respect the minimum window before finishing early');
  assert.equal(adaptive.download.failedRequests, 0);
  assert.ok(adaptive.download.mbps > 0);
  report.tests.push({ test: 'adaptive actual TCP', completionReason: adaptive.download.completionReason, durationMs: adaptive.download.durationMs, mbps: adaptive.download.mbps });

  const records = await page.evaluate(() => JSON.parse(localStorage.getItem('light-speed:history:v1')));
  assert.equal(records.length, 4, 'only completed tests enter history, including honest budget partials');
  assert.equal(records.find(record => record.download?.complete === false).download.mbps, null);
  for (const forbidden of ['baseUrl', 'client', 'ipAddress', 'deleteToken', 'Authorization', 'points']) assert.equal(JSON.stringify(records).includes(`"${forbidden}"`), false);
  const json = JSON.parse((await downloaded(page, '#export-json', 'actual-result.json')).toString());
  assert.equal(json.completedAt, records[0].completedAt);
  assert.equal(json.download.mbps, records[0].download.mbps);
  assert.equal(json.upload, null);
  const csv = (await downloaded(page, '#export-csv', 'actual-result.csv')).toString();
  assert.ok(csv.includes(`"${json.download.mbps}"`));
  assert.ok(csv.includes('budget_bytes_per_direction'));
  const png = await downloaded(page, '#export-png', 'actual-result.png');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 1000);
  const allCSV = (await downloaded(page, '#export-history-csv', 'actual-history.csv')).toString();
  assert.equal(allCSV.trim().split('\r\n').length, 5);

  // A cancelled test must not create a new history result.
  await page.locator('#start-button').click();
  await page.waitForFunction(() => document.querySelector('#phase-label').dataset.phase === 'download');
  await page.locator('#stop-button').click();
  await page.waitForFunction(() => document.querySelector('#phase-label').dataset.phase === 'stopped');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('light-speed:history:v1')).length), 4);
  await page.locator('#language-select').selectOption('zh');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  await openDetails(page);
  assert.equal(await page.locator('#language-select').inputValue(), 'zh');
  assert.equal(await page.locator('#measurement-policy').inputValue(), 'adaptive');
  assert.equal(await page.locator('#test-type').inputValue(), 'download');
  assert.equal(await page.locator('#history-select option').count(), 4);
  await page.screenshot({ path: join(artifacts, 'desktop-history-and-tools.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'mobile-history-and-tools.png'), fullPage: true });

  // Persisted strings are text, and exported node names cannot be formulas.
  await page.evaluate(() => {
    const values = JSON.parse(localStorage.getItem('light-speed:history:v1'));
    values[0].node.name = '=HYPERLINK("https://example.invalid")<img src=x onerror=window.__injected=1>';
    localStorage.setItem('light-speed:history:v1', JSON.stringify(values));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await openDetails(page);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  const guardedCSV = (await downloaded(page, '#export-csv', 'formula-safe-result.csv')).toString();
  assert.ok(guardedCSV.includes('"\'=HYPERLINK'));
  await page.locator('#history-clear').click();
  assert.equal(await page.locator('#history-select').isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('light-speed:history:v1')), null);
  report.tests.push({ test: 'history, exports and safety', completedRecords: 4, json: true, csv: true, png: { width: 1200, height: 1000 }, languagePersists: true, cancellationSaved: false, mobile320: true, formulaGuard: true });

  const blockedContext = await browser.newContext({ locale: 'en-US' });
  await blockedContext.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); });
  const blockedPage = await prepare(blockedContext, fixture.url);
  await blockedPage.locator('#test-type').selectOption('latency');
  await run(blockedPage);
  assert.equal(await blockedPage.locator('#history-select option').count(), 1);
  assert.match(await blockedPage.locator('#history-status').textContent(), /storage is unavailable/);
  report.tests.push({ test: 'blocked storage', measurementCompleted: true, sessionHistory: true });
  await blockedContext.close();

  if (shareBaseURL) report.tests.push(await verifySharing(shareBaseURL));
  else if (process.env.FEATURE_REQUIRE_SHARE === '1') throw new Error('SHARE_BASE_URL is required');
  else report.tests.push({ test: 'optional sharing', enabledServerNotProvided: true, defaultOffVerified: true });
  if (tokenBaseURL) report.tests.push(await verifySharing(tokenBaseURL, process.env.FEATURE_SHARE_TOKEN));
  else if (process.env.FEATURE_REQUIRE_SHARE === '1') throw new Error('SHARE_TOKEN_BASE_URL is required');
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'feature-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(artifacts, 'feature-failure-report.json'), JSON.stringify({ ...report, message: error.message }, null, 2));
  throw error;
} finally { await browser.close(); await fixture.close(); }

async function verifySharing(url, token) {
  const context = await browser.newContext({ locale: 'en-US' });
  const sharingPage = await prepare(context, url);
  const config = await (await sharingPage.request.get(`${url}/api/config`)).json();
  assert.equal(config.features.sharing, true);
  assert.equal(await sharingPage.locator('#share-tools').isVisible(), true);
  assert.equal(await sharingPage.locator('#share-token-label').isVisible(), config.features.shareRequiresToken === true);
  await sharingPage.locator('#test-type').selectOption('latency');
  await run(sharingPage);
  if (config.features.shareRequiresToken === true) {
    assert.ok(token, 'FEATURE_SHARE_TOKEN must be provided for the token-required test server');
    await sharingPage.locator('#share-result').click();
    assert.match(await sharingPage.locator('#share-status').textContent(), /requires a sharing authorization token/);
    await sharingPage.locator('#share-token').fill('deliberately-invalid-test-token');
    const deniedResponse = sharingPage.waitForResponse(response => new URL(response.url()).pathname === '/api/results' && response.request().method() === 'POST');
    await sharingPage.locator('#share-result').click();
    assert.equal((await deniedResponse).status(), 401);
    await sharingPage.waitForFunction(() => document.querySelector('#share-token').value === '' && !document.querySelector('#share-result').disabled);
    assert.equal(await sharingPage.locator('#share-link').isVisible(), false);
    await sharingPage.locator('#share-token').fill(token);
  }
  const responsePromise = sharingPage.waitForResponse(response => new URL(response.url()).pathname === '/api/results' && response.request().method() === 'POST');
  await sharingPage.locator('#share-result').click();
  const response = await responsePromise;
  assert.equal(response.status(), 201);
  const created = await response.json();
  await sharingPage.waitForFunction(() => !document.querySelector('#share-link').hidden);
  const link = await sharingPage.locator('#share-link').getAttribute('href');
  assert.equal(new URL(link).origin, new URL(url).origin);
  assert.equal(new URL(link).pathname, '/share.html');
  assert.equal(await sharingPage.locator('#share-token').inputValue(), '');
  const fetched = await (await sharingPage.request.get(`${url}/api/results/${created.id}`)).json();
  assert.equal(fetched.provenance, 'client-reported');
  assert.equal(fetched.result.testType, 'latency');
  assert.equal(fetched.result.download, null);
  assert.equal(fetched.result.upload, null);
  for (const forbidden of ['client', 'ipAddress', 'deleteToken', 'Authorization', 'maxBytes']) assert.equal(JSON.stringify(fetched.result).includes(`"${forbidden}"`), false);
  if (token) assert.equal(await sharingPage.evaluate(value => JSON.stringify(localStorage).includes(value), token), false);
  await sharingPage.locator('#share-revoke').click();
  await sharingPage.waitForFunction(() => document.querySelector('#share-link').hidden);
  assert.equal((await sharingPage.request.get(`${url}/api/results/${created.id}`)).status(), 404);
  await context.close();
  return { test: config.features.shareRequiresToken ? 'authorized optional sharing' : 'optional sharing', serverStored: true, clientIpExcluded: true, tokenPersisted: false, unauthorizedTokenRejected: config.features.shareRequiresToken === true, revoked: true };
}
