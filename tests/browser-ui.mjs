import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails, readMetrics, waitPhase } from './browser-helpers.mjs';
import { createNetworkFixture } from './browser-network-fixture.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-ui';
const skipManual = process.env.UI_SKIP_MANUAL === '1';
await mkdir(artifacts, { recursive: true });
const fixture = await createNetworkFixture(baseURL, { downloadMbps: 120, uploadMbps: 60, streams: 30 });
const browser = await launchBrowser();
const errors = [];
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  assert.equal(await page.locator('#more-details').isVisible(), false, 'the initial page should show the primary download result');
  assert.equal(await page.locator('#more-info-button').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#upload-value').isVisible(), false);
  for (const id of ['download-value', 'upload-value']) {
    assert.equal(await page.locator(`#${id}`).textContent(), '0', 'initial speed is an unmeasured zero');
    assert.equal(await page.locator(`#${id}`).getAttribute('data-mbps'), null, 'initial zero must not be recorded as a measurement');
    const channels = await page.locator(`#${id}`).evaluate(element => getComputedStyle(element).color.match(/\d+/g).slice(0, 3).map(Number));
    assert.ok(channels.every(channel => channel >= 120), 'unmeasured zero should remain gray');
  }
  const logo = await page.locator('.brand-gauge').boundingBox();
  const brandText = await page.locator('.brand > span').boundingBox();
  assert.ok(logo && brandText && brandText.y >= logo.y + logo.height - 1, 'the new gauge and TESTSPEED name should stack vertically');
  assert.equal(await page.locator('#language-select').inputValue(), 'en', 'a new browser should use its supported preferred language');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#language-select').selectOption('zh');
  assert.equal(await page.locator('#stream-count').inputValue(), '8');
  assert.equal(await page.locator('#stream-count').getAttribute('max'), '30');
  await page.waitForTimeout(300);
  assert.equal(fixture.stats.upgrades, 0, 'loading the page must not start a traffic-consuming measurement');
  await page.screenshot({ path: join(artifacts, 'desktop-ready.png'), fullPage: true });

  const initialUpload = await page.locator('#upload-value').textContent();
  await page.locator('#start-button').click();
  await waitPhase(page, '正在测量下载');
  await page.waitForFunction(() => Number(document.querySelector('#download-value').dataset.mbps) > 0, null, { timeout: 10000 });
  assert.equal(await page.locator('#more-details').isVisible(), false, 'measurements should preserve the collapsed default page');
  assert.equal(await page.locator('#upload-value').textContent(), initialUpload);
  assert.equal(await page.locator('#upload-value').getAttribute('data-mbps'), null, 'upload remains unmeasured during download');
  const liveDownloadColor = await page.locator('#download-value').evaluate(element => getComputedStyle(element).color);
  await page.screenshot({ path: join(artifacts, 'desktop-download-live.png'), fullPage: true });
  await waitPhase(page, '正在测量上传');
  const finalDownload = Number(await page.locator('#download-value').getAttribute('data-mbps'));
  assert.ok(finalDownload > 0);
  const finalDownloadColor = await page.locator('#download-value').evaluate(element => getComputedStyle(element).color);
  assert.notEqual(finalDownloadColor, liveDownloadColor, 'the completed download should leave its measuring appearance while upload is still active');
  assert.ok(finalDownloadColor.match(/\d+/g).slice(0, 3).every(channel => Number(channel) <= 32), 'the completed download should use its dark final appearance');
  await page.waitForTimeout(900);
  assert.equal(Number(await page.locator('#download-value').getAttribute('data-mbps')), finalDownload, 'the completed download result must stay stable during upload');
  assert.equal(await page.locator('#upload-value').textContent(), initialUpload, 'upload should show its final value only after its measurement window ends');
  assert.equal(await page.locator('#upload-value').getAttribute('data-mbps'), null);
  const upgradesBeforeLanguageChange = fixture.stats.upgrades;
  await page.locator('#language-select').selectOption('en');
  assert.equal(await page.locator('#phase-label').getAttribute('data-phase'), 'upload');
  assert.equal(Number(await page.locator('#download-value').getAttribute('data-mbps')), finalDownload);
  assert.equal(await page.locator('#upload-value').textContent(), initialUpload);
  await page.waitForTimeout(100);
  assert.equal(fixture.stats.upgrades, upgradesBeforeLanguageChange, 'language changes during measurement must not open a new run');
  await page.screenshot({ path: join(artifacts, 'desktop-upload-english.png'), fullPage: true });
  await waitPhase(page, '测速完成');
  const defaultMetrics = await readMetrics(page);
  assert.ok(defaultMetrics.uploadMbps > 0);
  assert.equal(defaultMetrics.downloadMbps, finalDownload);
  assert.equal(Number(defaultMetrics.tcpDetails.peak), 8);
  assert.equal(defaultMetrics.failureRate, 0);
  await page.screenshot({ path: join(artifacts, 'desktop-complete-collapsed.png'), fullPage: true });

  await openDetails(page);
  assert.equal(await page.locator('#more-info-button').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#upload-value').isVisible(), true);
  assert.equal(await page.locator('#idle-latency-value').isVisible(), true);
  if (await page.locator('#test-settings').getAttribute('open') === null) await page.locator('#test-settings > summary').click();
  assert.equal(await page.locator('#stream-count').isEnabled(), true);
  await page.locator('#language-select').selectOption('en');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await page.locator('#page-title').textContent(), /[a-z]/i);
  assert.equal(await page.locator('#phase-label').getAttribute('data-phase'), 'complete');
  assert.equal(Number(await page.locator('#download-value').getAttribute('data-mbps')), finalDownload, 'changing language must preserve the actual result');
  await page.screenshot({ path: join(artifacts, 'desktop-details-english.png'), fullPage: true });

  let manualMetrics = null;
  if (!skipManual) {
    await page.locator('#stream-count').fill('30');
    await page.locator('#start-button').click();
    await waitPhase(page, '正在测量下载');
    await waitPhase(page, '正在测量上传');
    await waitPhase(page, '测速完成');
    manualMetrics = await readMetrics(page);
    assert.equal(Number(manualMetrics.tcpDetails.peak), 30, 'manual connections remain effective through the expanded settings');
    assert.ok(manualMetrics.downloadMbps > 0 && manualMetrics.uploadMbps > 0);
    assert.equal(manualMetrics.failureRate, 0);
    await page.screenshot({ path: join(artifacts, 'desktop-manual-30-english.png'), fullPage: true });
  }

  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded results/settings must fit a 320px viewport');
  await page.screenshot({ path: join(artifacts, 'mobile-details-english.png'), fullPage: true });
  await page.locator('#more-info-button').click();
  assert.equal(await page.locator('#more-details').isVisible(), false);
  await page.locator('#language-select').selectOption('zh');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.screenshot({ path: join(artifacts, 'mobile-complete-chinese.png'), fullPage: true });
  await page.locator('#language-select').selectOption('en');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
  assert.equal(await page.locator('#language-select').inputValue(), 'en', 'language selection must survive reload');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('#more-details').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'collapsed mobile page must fit its viewport');
  await page.screenshot({ path: join(artifacts, 'mobile-ready-english.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { baseURL, defaultMetrics, manualMetrics, networkBudget: { downloadMbps: 120, uploadMbps: 60, divisor: 30 }, errors };
  await writeFile(join(artifacts, 'ui-report.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('PASS minimal multilingual UI', JSON.stringify(result));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error('FAIL minimal UI', JSON.stringify(await page.evaluate(() => ({ phase: document.querySelector('#phase-label').textContent, phaseKey: document.querySelector('#phase-label').dataset.phase, status: document.querySelector('#status-message').textContent, error: document.querySelector('#error-message').textContent, language: document.documentElement.lang })).catch(() => null)));
    await page.screenshot({ path: join(artifacts, 'ui-failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await fixture.close();
}
