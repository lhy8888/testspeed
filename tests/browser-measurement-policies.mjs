import assert from 'node:assert/strict';
import net from 'node:net';
import { Transform } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, openDetails, readMetrics } from './browser-helpers.mjs';
import { createNetworkFixture } from './browser-network-fixture.mjs';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const httpBaseURL = process.env.HTTP_SINGLE_BASE_URL || 'http://127.0.0.1:9490';
const artifacts = process.env.TEST_ARTIFACT_DIR || '/tmp/testspeed-measurement-policies';
const budgetBytes = 64 * 1024 ** 2;
const report = {
  baseURL, httpBaseURL, cases: [], errors: [],
  networkModel: 'Real TCP payloads are rate limited to 120/60 Mbps across each transport data pool. HTTP ping responses are delayed 40 ms; physical TCP ACK RTT is not emulated. Proxy counters include framing and are never substituted for application byte counts.',
};
await mkdir(artifacts, { recursive: true });

// Require both independent upstreams before claiming coverage. Missing HTTP
// does not silently become a successful WebSocket-only test.
for (const [target, transport, streams] of [[baseURL, 'websocket', 8], [httpBaseURL, 'http', 4]]) {
  const response = await fetch(`${target}/api/config`);
  assert.equal(response.status, 200, `Start the ${transport} fixture server at ${target}`);
  const config = await response.json();
  assert.equal(config.performance.transport, transport);
  assert.equal(config.performance.defaultStreams, streams);
  if (transport === 'websocket') assert.equal(config.performance.maxStreams, 30);
}

const browser = await launchBrowser();
const fixtures = [];
let active;
try {
  for (const transport of ['websocket', 'http']) {
    const streams = transport === 'websocket' ? 8 : 4;
    const target = transport === 'websocket' ? baseURL : httpBaseURL;
    const fixture = await createNetworkFixture(target, {
      downloadMbps: 120, uploadMbps: 60, streams, latencyMs: 40,
    });
    fixtures.push(fixture);
    // Existing fixture meters upgraded sockets only. Ordinary HTTP must pass
    // through an additional real TCP meter, otherwise localhost's unbounded
    // HTTP transfers would consume 64 MiB during warm-up and fake coverage.
    const bridge = transport === 'http' ? await createHTTPMeter(fixture.url, streams) : null;
    if (bridge) fixtures.push(bridge);
    const url = bridge?.url || fixture.url;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
    await context.addInitScript(() => {
      window.__policyResults = [];
      window.__policyErrors = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'result') window.__policyResults.push(data.result);
            if (data.type === 'error') window.__policyErrors.push({ name: data.name, message: data.message });
          });
        }
      };
    });
    const page = await context.newPage();
    active = { page, context, transport, streams, url, fixture, bridge, snapshots: [], sessions: new Set(), runs: new Set(), sockets: [], pending: [], finishPosts: 0, errors: [] };
    const state = active;
    page.on('pageerror', error => state.errors.push(error.message));
    // URLs and close events only. No WebSocket frame payload collection or
    // Fetch interception of streaming/giant HTTP upload bodies is enabled.
    page.on('websocket', socket => {
      const address = new URL(socket.url());
      const item = { direction: address.searchParams.get('direction'), closed: false };
      state.sockets.push(item);
      if (address.searchParams.has('run')) state.runs.add(address.searchParams.get('run'));
      socket.on('close', () => { item.closed = true; });
    });
    context.on('request', request => {
      const address = new URL(request.url());
      if (address.pathname === '/api/download' && address.searchParams.has('run')) state.runs.add(address.searchParams.get('run'));
      if (/^\/api\/upload-sessions\/[^/]+\/finish$/.test(address.pathname) && request.method() === 'POST') state.finishPosts += 1;
    });
    context.on('response', response => {
      const address = new URL(response.url());
      if (!/^\/api\/upload-sessions(?:\/[^/]+(?:\/finish)?)?$/.test(address.pathname) || response.status() < 200 || response.status() >= 300 || response.status() === 204) return;
      state.pending.push(response.json().then(snapshot => {
        if (snapshot.id) state.sessions.add(snapshot.id);
        if (Number.isFinite(snapshot.measuredBytes)) state.snapshots.push({
          path: address.pathname, measuredBytes: snapshot.measuredBytes, totalBytes: snapshot.totalBytes,
          measurementElapsedMs: snapshot.measurementElapsedMs, maxBytes: snapshot.maxBytes,
          finished: snapshot.finished, completionReason: snapshot.completionReason,
          activeTcpConnections: snapshot.activeTcpConnections,
        });
      }).catch(error => { state.errors.push(`Reading small session JSON: ${error.message}`); }));
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
    await openDetails(page);
    await page.locator('#test-settings').evaluate(element => { element.open = true; });
    await page.locator('#test-type').selectOption('full');
    await page.locator('#measurement-duration').selectOption('10000');
    assert.equal(await page.locator('#stream-count').inputValue(), String(streams));

    for (const policy of ['adaptive', 'budget']) {
      const snapshotIndex = state.snapshots.length;
      const priorSessions = new Set(state.sessions);
      const priorRuns = new Set(state.runs);
      const firstSocket = state.sockets.length;
      const priorFinishPosts = state.finishPosts;
      await page.locator('#measurement-policy').selectOption(policy === 'adaptive' ? 'adaptive' : 'fixed');
      await page.locator('#traffic-budget').selectOption(policy === 'adaptive' ? '0' : 'custom');
      if (policy === 'budget') {
        await page.locator('#custom-budget-mib').fill('64');
        await page.locator('#custom-budget-mib').dispatchEvent('change');
      }
      const count = await page.evaluate(() => window.__policyResults.length);
      await page.locator('#start-button').click();
      await page.waitForFunction(previous => window.__policyErrors.length || document.querySelector('#phase-label').dataset.phase === 'error'
        || (document.querySelector('#phase-label').dataset.phase === 'complete' && window.__policyResults.length > previous), count, { timeout: 60000 });
      const outcome = await page.evaluate(() => ({
        result: window.__policyResults.at(-1), workerErrors: window.__policyErrors,
        phase: document.querySelector('#phase-label').dataset.phase, error: document.querySelector('#error-message').textContent,
      }));
      assert.deepEqual(outcome.workerErrors, [], `Unexpected ${transport} ${policy} worker failure: ${outcome.error}`);
      assert.equal(outcome.phase, 'complete', `Unexpected ${transport} ${policy} phase: ${outcome.error}`);
      const result = outcome.result;
      assert.equal(result.schemaVersion, 1);
      assert.equal(result.testType, 'full');
      assert.equal(result.measurementPolicy, policy === 'adaptive' ? 'adaptive' : 'fixed');
      assert.equal(result.transport.transport, transport);
      assert.equal(result.transport.effectiveStreams, streams);
      if (transport === 'http') assert.ok(result.transport.origins.every(origin => new URL(origin).origin === new URL(url).origin), 'HTTP measurement origins must traverse the real TCP meter');
      assert.equal(result.maxBytes, policy === 'adaptive' ? 0 : budgetBytes);
      for (const direction of ['download', 'upload']) {
        const measured = result[direction];
        assert.equal(measured.completionReason, policy === 'adaptive' ? 'stable' : 'budget', `${transport} ${direction} must actually use the selected cutoff`);
        assert.equal(measured.complete, true);
        assert.equal(measured.failedRequests, 0, 'A retry/normal-close error must never be hidden by a successful result');
        assert.ok(measured.durationMs > 0 && measured.durationMs < 10000);
        if (policy === 'adaptive') assert.ok(measured.durationMs >= Math.max(5000, 8 * measured.rttMs));
        assert.ok(measured.measuredBytes > 0 && measured.totalBytes >= measured.measuredBytes);
        assert.ok(measured.mbps > 0);
        assert.ok(Math.abs(measured.mbps - measured.measuredBytes * 8 / measured.durationMs / 1000) < 1e-8, 'Throughput must use actual bytes and the frozen elapsed window');
        assert.equal(measured.activeStreams, 0);
        assert.equal(measured.connections.active, 0);
        assert.equal(measured.connections.peak, streams);
        if (policy === 'budget') {
          assert.ok(measured.totalBytes >= budgetBytes, 'Budget counts actual received traffic, including warm-up');
          assert.equal(measured.budgetOvershootBytes, measured.totalBytes - budgetBytes);
        }
      }
      await Promise.all(state.pending);
      const snapshots = state.snapshots.slice(snapshotIndex);
      const finished = snapshots.filter(snapshot => snapshot.finished);
      assert.ok(finished.length >= 2, 'Observe a frozen completion snapshot and the later cleanup snapshot');
      for (const snapshot of finished) {
        assert.equal(snapshot.completionReason, policy === 'adaptive' ? 'stable' : 'budget');
        assert.equal(snapshot.maxBytes, policy === 'adaptive' ? 0 : budgetBytes);
        assert.equal(snapshot.measuredBytes, result.upload.measuredBytes, 'Final upload bytes must match the actual server snapshot');
        assert.equal(snapshot.totalBytes, result.upload.totalBytes);
        assert.equal(snapshot.measurementElapsedMs, result.upload.durationMs, 'Server elapsed time must stay frozen after termination');
      }
      assert.equal(state.finishPosts - priorFinishPosts, policy === 'adaptive' ? 1 : 0, 'Adaptive upload freezes the server window with one explicit finish POST');
      const sessions = [...state.sessions].filter(id => !priorSessions.has(id));
      assert.equal(sessions.length, 1);
      for (const id of sessions) assert.equal((await context.request.get(`${url}/api/upload-sessions/${encodeURIComponent(id)}`)).status(), 404, 'Completed session is deleted');
      const runs = [...state.runs].filter(id => !priorRuns.has(id));
      assert.equal(runs.length, 1);
      const connections = await (await context.request.get(`${url}/api/connection-stats?run=${encodeURIComponent(runs[0])}`)).json();
      assert.equal(connections.activeRequests, 0);
      assert.equal(connections.activeTcpConnections, 0);
      assert.equal(connections.peakTcpConnections, streams);
      await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
      for (let attempt = 0; state.sockets.slice(firstSocket).some(socket => !socket.closed) && attempt < 20; attempt += 1) await page.waitForTimeout(50);
      assert.ok(state.sockets.slice(firstSocket).every(socket => socket.closed));
      assert.deepEqual(state.errors, []);
      const metrics = await readMetrics(page);
      assert.equal(metrics.failureRate, 0);
      assert.equal(metrics.downloadMbps, result.download.mbps);
      assert.equal(metrics.uploadMbps, result.upload.mbps);
      report.cases.push({ transport, policy, streams, result, serverFinishedSnapshots: finished, connections, metrics });
      await page.screenshot({ path: join(artifacts, `${transport}-${policy}-full-complete.png`), fullPage: true });
      await writeFile(join(artifacts, 'measurement-policy-report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('PASS actual measurement policy', JSON.stringify({ transport, policy, download: result.download.mbps, upload: result.upload.mbps, downloadMs: result.download.durationMs, uploadMs: result.upload.durationMs }));
    }
    await context.close();
    active = null;
  }
  assert.equal(report.cases.length, 4);
  console.log('PASS WebSocket and HTTP adaptive/budget policies');
} catch (error) {
  const liveConnectionStats = [];
  if (active) for (const run of active.runs) {
    const response = await active.context.request.get(`${active.url}/api/connection-stats?run=${encodeURIComponent(run)}`).catch(() => null);
    liveConnectionStats.push({ run, status: response?.status(), stats: response ? await response.json().catch(() => null) : null });
  }
  const diagnostics = {
    error: error.message, completedCases: report.cases, transport: active?.transport,
    liveConnectionStats,
    sessionSnapshots: active?.snapshots, fixture: active?.fixture.stats, httpMeter: active?.bridge?.stats,
    page: active ? await active.page.evaluate(() => ({ phase: document.querySelector('#phase-label').dataset.phase,
      error: document.querySelector('#error-message').textContent, results: window.__policyResults, workerErrors: window.__policyErrors })).catch(() => null) : null,
  };
  await writeFile(join(artifacts, 'measurement-policy-failure.json'), JSON.stringify(diagnostics, null, 2) + '\n');
  if (active) await active.page.screenshot({ path: join(artifacts, 'measurement-policy-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  for (const fixture of fixtures.reverse()) await fixture.close();
}

async function createHTTPMeter(targetURL, streams) {
  const target = new URL(targetURL);
  const sockets = new Set();
  const timers = new Set();
  const stats = { downloadBytes: 0, uploadBytes: 0, maxWritableBytes: 0 };
  function meter(direction, mbps) {
    const bytesPerMs = mbps * 1000000 / 8 / streams / 1000;
    let nextAt = performance.now();
    let timer;
    const transform = new Transform({ highWaterMark: 16384, transform(chunk, encoding, done) {
      stats.maxWritableBytes = Math.max(stats.maxWritableBytes, this.writableLength);
      nextAt = Math.max(nextAt, performance.now()) + chunk.byteLength / bytesPerMs;
      timer = setTimeout(() => {
        timers.delete(timer);
        if (this.destroyed) return done();
        stats[`${direction}Bytes`] += chunk.byteLength;
        done(null, chunk);
      }, Math.max(0, nextAt - performance.now()));
      timers.add(timer);
    } });
    transform.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    return transform;
  }
  const server = net.createServer(client => {
    const upstream = net.connect({ host: target.hostname, port: target.port || 80 });
    const down = meter('download', 120);
    const up = meter('upload', 60);
    sockets.add(client); sockets.add(upstream);
    const release = () => { client.destroy(); upstream.destroy(); up.destroy(); down.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', release); upstream.on('error', release);
    client.on('close', release); upstream.on('close', () => { up.destroy(); });
    // pipe() propagates EOF only after all rate-limited response bytes drain.
    upstream.on('connect', () => { client.pipe(up).pipe(upstream); upstream.pipe(down).pipe(client); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closing;
  return { url: `http://127.0.0.1:${server.address().port}`, stats, close() {
    closing ??= (async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    })();
    return closing;
  } };
}
