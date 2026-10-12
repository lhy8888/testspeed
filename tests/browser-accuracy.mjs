import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, readMetrics, shapeWorkerNetwork, waitPhase } from './browser-helpers.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const artifactDirectory = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-browser-v2';
await mkdir(artifactDirectory, { recursive: true });
const browser = await launchBrowser();
const shapes = process.env.ACCURACY_SHAPES ? JSON.parse(process.env.ACCURACY_SHAPES) : [
  { downloadMbps: 20, uploadMbps: 10, latencyMs: 80 },
  { downloadMbps: 1000, uploadMbps: 1000, latencyMs: 150 },
  { downloadMbps: 1000, uploadMbps: 1000, latencyMs: 300 },
];

try {
  for (const shape of shapes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
    const config = await (await context.request.get(`${baseURL}/api/config`)).json();
    assert.equal(config.protocolVersion, 2);
    assert.equal(config.performance.transport, 'http', 'this CDP accuracy suite requires the explicit HTTP fixture; it does not validate WebSocket bandwidth shaping');
    assert.ok(config.performance.measurementOrigins.length >= 4);
    const network = await shapeWorkerNetwork(context, page, shape);
    try {
    const started = Date.now();
    await page.locator('#start-button').click();
    await waitPhase(page, '正在测量上传');
    await page.waitForTimeout(700);
    const heaps = [];
    for (const worker of network.attachedWorkers) heaps.push(await network.workerCommand(worker, 'Runtime.getHeapUsage'));
    await waitPhase(page, '测速完成');
    const metrics = await readMetrics(page);
    assert.ok(metrics.downloadMbps > 0 && metrics.downloadMbps <= shape.downloadMbps * 1.35, 'download must respect shaped aggregate bandwidth');
    assert.ok(metrics.uploadMbps > 0 && metrics.uploadMbps <= shape.uploadMbps * 1.35, 'server-received upload must respect shaped aggregate bandwidth');
    if (shape.downloadMbps <= 20) {
      assert.ok(metrics.downloadMbps >= shape.downloadMbps * .5, 'ordinary shaped download should use most of the available bandwidth');
      assert.ok(metrics.uploadMbps >= shape.uploadMbps * .4, 'ordinary shaped upload should use most of the available bandwidth');
    }
    assert.ok(metrics.idleMs >= shape.latencyMs * .7 && metrics.idleMs <= 2000, 'worker RTT must reflect configured latency');
    assert.ok(Number.isFinite(metrics.downloadLoadedMs) && Number.isFinite(metrics.uploadLoadedMs), 'loaded probes must produce samples');
    assert.ok(Date.now() - started >= config.test.downloadDurationMs + config.test.uploadDurationMs, 'run must use full configured measurement windows');
    assert.deepEqual(errors, []);
    assert.deepEqual(network.workerErrors, []);
    assert.ok(network.ruleIds.length > 0 && network.attachedWorkers.size > 0, 'shaping rules and worker instrumentation must both be active');
    const downloads = [...network.requests.values()].filter(request => new URL(request.url).pathname === '/api/download' && request.receivedBytes > 0);
    const uploads = [...network.requests.values()].filter(request => new URL(request.url).pathname === '/api/upload' && request.method === 'POST');
    assert.ok(downloads.length > 0 && uploads.length > 0, 'both actual transfer directions must originate in the worker');
    assert.equal([...network.requests.values(), ...network.pageRequests].filter(request => new URL(request.url).pathname === '/api/upload' && request.method === 'OPTIONS').length, 0, 'raw upload Blob bodies should avoid cross-origin preflight RTT');
    const firstByte = Math.min(...downloads.map(request => request.firstDataAt));
    const lastByte = Math.max(...downloads.map(request => request.lastDataAt));
    const networkMbps = downloads.reduce((total, request) => total + request.receivedBytes, 0) * 8 / ((lastByte - firstByte) * 1000000);
    assert.ok(networkMbps > 0 && networkMbps <= shape.downloadMbps * 1.35, 'worker protocol byte events independently prove that the global shaping rule applies to worker fetches');
    for (const heap of heaps) assert.ok(heap.usedSize < 128 * 1024 * 1024, 'worker JS heap should remain bounded instead of materializing per-stream gigabyte buffers');
    await page.screenshot({ path: join(artifactDirectory, `desktop-shaped-${shape.latencyMs}ms.png`), fullPage: true });
    console.log('PASS shaped worker HTTP run', JSON.stringify({ shape, metrics, observedDownloadMbps: networkMbps, elapsedMs: Date.now() - started, workerHeap: heaps }));
    } catch (error) {
      const state = await page.evaluate(() => ({ phase: document.querySelector('#phase-label').textContent, status: document.querySelector('#status-message').textContent, error: document.querySelector('#error-message').textContent }));
      console.error('FAIL shaped worker HTTP run', JSON.stringify({ shape, state, workerErrors: network.workerErrors, workers: network.attachedWorkers.size, requestSummaries: [...network.requests.values()].map(({ url, method, receivedBytes, status, error }) => ({ url, method, receivedBytes, status, error })) }));
      await page.screenshot({ path: join(artifactDirectory, `failure-shaped-${shape.latencyMs}ms.png`), fullPage: true });
      throw error;
    }
    await context.close();
  }
} finally {
  await browser.close();
}
