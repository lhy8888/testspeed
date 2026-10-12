import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { chooseConcurrencyTarget, chooseWebSocketHandshakeTimeout, chooseWebSocketMessageBytes, createUploadBody, estimateBDPBytes, isThroughputStable, latencyStatistics, loadConfig, MeasurementEngine, normalizeConfig, normalizeOptions, SpeedTest, toMbps } from '../web/speedtest.js';

const config = () => ({ protocolVersion: 2, nodes: [{ id: 'local', name: '本地节点', baseUrl: '' }], performance: { measurementOrigins: [8081, 8082, 8083, 8084].map(port => `http://localhost:${port}/`), maxStreams: 24 }, test: { warmupMs: 0 } });
const node = { id: 'local', name: '本地节点', baseUrl: 'http://localhost/' };
const abortablePending = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
async function advance(t, milliseconds) { t.mock.timers.tick(milliseconds); await setImmediate(); }
function mockTime(t) { t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1700000000000 }); }
function phaseConfiguration() {
  const normalized = normalizeConfig(config());
  return {
    test: { ...normalized.test, warmupMs: 0, downloadDurationMs: 1000, uploadDurationMs: 1000, minStreams: 1 },
    performance: { ...normalized.performance, uploadBlockBytes: 65536, maxUploadBodyBytes: 1048576 },
    options: { mode: 'manual', streams: 1 }, idle: { medianMs: 0 },
  };
}

test('protocol v2 validates node URLs and rejects mixed content or embedded credentials', () => {
  assert.throws(() => normalizeConfig({ ...config(), protocolVersion: 1 }), /配置无效/);
  assert.throws(() => normalizeConfig({ ...config(), nodes: [] }), /配置无效/);
  for (const baseUrl of ['javascript:alert(1)', 'https://user:pass@example.com/', 'http://example.com/']) {
    assert.throws(() => normalizeConfig({ ...config(), nodes: [{ ...node, baseUrl }] }, 'https://speed.example/'), /地址不受支持/);
  }
  const relative = normalizeConfig({ ...config(), nodes: [{ ...node, baseUrl: '/measure?ignored=yes#ignored' }], performance: { measurementOrigins: ['/data'] } }, 'https://speed.example/ui/');
  assert.equal(relative.nodes[0].baseUrl, 'https://speed.example/measure/');
});

test('HTTP/1.1 stream capacity counts origin pools and reserves the shared control pool', () => {
  assert.equal(normalizeConfig(config()).performance.maxStreams, 24);
  const shared = normalizeConfig({ ...config(), performance: { measurementOrigins: ['/'], maxStreams: 24 } });
  assert.equal(shared.performance.maxStreams, 4);
  assert.equal(shared.performance.sharedControlOrigin, true);
  const duplicates = normalizeConfig({ ...config(), performance: { measurementOrigins: ['http://localhost:8081/', 'http://localhost:8081/'], maxStreams: 24 } });
  assert.equal(duplicates.performance.maxStreams, 6);
  const paths = normalizeConfig({ ...config(), performance: { measurementOrigins: ['http://localhost:8081/first', 'http://localhost:8081/second'], maxStreams: 24 } });
  assert.equal(paths.performance.maxStreams, 6, 'paths on one origin share a single browser TCP pool');
});

test('manual options reject unsupported concurrency and unsafe durations', () => {
  const normalized = normalizeConfig(config());
  for (const streams of [0, 25, 1.5, NaN]) assert.throws(() => normalizeOptions(normalized, { mode: 'manual', streams }), /并行传输/);
  assert.equal(normalizeOptions(normalized, { mode: 'manual', streams: 24 }).streams, 24);
  assert.throws(() => normalizeOptions(normalized, { mode: 'unknown' }), /并发模式/);
  assert.throws(() => normalizeOptions(normalized, { durationMs: 9999 }), /测量时间/);
  assert.equal(normalizeOptions(normalized, { durationMs: 30000 }).durationMs, 30000);
});

test('latency preserves chronological jitter, median and failed probes', () => {
  assert.deepEqual(latencyStatistics([10, 30, 20, NaN, -1], 2), { medianMs: 20, jitterMs: 15, samples: 3, failed: 2, attempts: 5 });
  assert.deepEqual(latencyStatistics([], 3), { medianMs: null, jitterMs: null, samples: 0, failed: 3, attempts: 3 });
  assert.equal(latencyStatistics([10, 20]).medianMs, 15);
});

test('decimal Mbps and BDP remain valid from 1 to 100 Gbps', () => {
  assert.equal(toMbps(125000000, 1000), 1000);
  assert.equal(toMbps(12500000000, 1000), 100000);
  assert.equal(toMbps(1000000, 0), 0);
  assert.equal(estimateBDPBytes(1000, 300), 37500000);
  assert.equal(estimateBDPBytes(100000, 300), 3750000000);
});

test('automatic concurrency explores growth and returns to the efficient previous pool', () => {
  assert.equal(chooseConcurrencyTarget(2, null, 1000, 24), 4);
  assert.equal(chooseConcurrencyTarget(12, 10000, 13000, 24), 24);
  assert.equal(chooseConcurrencyTarget(24, 13000, 13100, 24, 12), 12);
  assert.equal(chooseConcurrencyTarget(4, 1000, 0, 24), 4);
  assert.equal(chooseConcurrencyTarget(24, 13000, 17000, 24), 24);
});

test('large upload bodies repeat immutable Blob references and preserve a partial final block', async () => {
  const body = createUploadBody(new Blob([new Uint8Array([1, 2, 3, 4])]), 11);
  assert.equal(body.type, '', 'an empty outer Blob MIME type preserves raw bytes without cross-origin preflight');
  assert.deepEqual([...new Uint8Array(await body.arrayBuffer())], [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3]);
  const base = new Blob([new Uint8Array(65536)]);
  const before = process.memoryUsage().arrayBuffers;
  const giant = createUploadBody(base, 1024 ** 3);
  assert.equal(giant.size, 1024 ** 3);
  assert.ok(process.memoryUsage().arrayBuffers - before < 4 * 1024 * 1024, 'joining Blob references should not allocate a gigabyte byte array');
  assert.throws(() => createUploadBody(new Blob(), 1), /数据块无效/);
});

test('configuration request times out with an actionable message and disables caching', async t => {
  mockTime(t);
  let requestOptions;
  const loading = loadConfig({ fetchImpl: (_, options) => { requestOptions = options; return abortablePending(options.signal); } });
  const rejected = assert.rejects(loading, /连接测速服务超时/);
  await advance(t, 4999);
  assert.equal(requestOptions.signal.aborted, false);
  assert.equal(requestOptions.cache, 'no-store');
  await advance(t, 1);
  await rejected;
});

test('native fetch keeps its own receiver rather than the MeasurementEngine instance', async () => {
  let engine;
  engine = new MeasurementEngine({ fetchImpl: function () {
    assert.notEqual(this, engine, 'native Window.fetch rejects an engine receiver');
    return Promise.resolve(new Response('{}'));
  } });
  assert.ok(await engine.ping(node, new AbortController().signal) >= 0);
});

test('partial idle failures retain usable probes and report failure counts', async t => {
  mockTime(t);
  let attempts = 0;
  const engine = new MeasurementEngine({ clock: () => Date.now(), fetchImpl: async () => {
    if (++attempts === 2) throw new TypeError('simulated failure');
    return new Response('{}');
  } });
  const result = engine.idleLatency(node, 3, new AbortController().signal);
  await setImmediate();
  await advance(t, 90);
  await advance(t, 90);
  assert.deepEqual(await result, { medianMs: 0, jitterMs: 0, samples: 2, failed: 1, attempts: 3 });
});

test('fast initial RTT keeps early failures and quietly completes the original idle attempt budget', async t => {
  mockTime(t);
  let attempts = 0;
  const events = [];
  const engine = new MeasurementEngine({ clock: () => Date.now(), onUpdate: event => events.push(event), fetchImpl: async () => {
    if (++attempts === 1) throw new TypeError('first probe failed');
    return new Response('{}');
  } });
  const signal = new AbortController().signal;
  const first = engine.idleLatency(node, 4, signal, { stopAfterFirstSuccess: true });
  await setImmediate();
  await advance(t, 90);
  const initial = await first;
  assert.deepEqual(initial, { medianMs: 0, jitterMs: null, samples: 1, failed: 1, attempts: 2 });
  assert.equal(Date.now(), 1700000000090, 'the successful RTT starts measurement without another idle pause');
  const announcements = events.filter(event => event.type === 'phase' || event.type === 'progress').length;
  const final = engine.idleLatency(node, 4, signal, { seedValues: [initial.medianMs], seedFailed: initial.failed, announce: false });
  await setImmediate();
  await advance(t, 90);
  assert.deepEqual(await final, { medianMs: 0, jitterMs: 0, samples: 3, failed: 1, attempts: 4 });
  assert.equal(attempts, 4, 'the first successful probe and its failure are not repeated or discarded');
  assert.equal(events.filter(event => event.type === 'phase' || event.type === 'progress').length, announcements);
  assert.equal(events.at(-1).type, 'latency');
});

test('fast initial RTT preserves the full failed-probe tolerance and cannot invent a usable latency', async t => {
  mockTime(t);
  let attempts = 0;
  const engine = new MeasurementEngine({ fetchImpl: async () => { attempts += 1; throw new TypeError('unreachable'); } });
  const first = engine.idleLatency(node, 3, new AbortController().signal, { stopAfterFirstSuccess: true });
  const rejected = assert.rejects(first, /无法连接测速节点/);
  await setImmediate();
  await advance(t, 90);
  await advance(t, 90);
  await rejected;
  assert.equal(attempts, 3);
});

test('one unloaded RTT starts both phases before the remaining probes and waits for their cleanup', async t => {
  mockTime(t);
  const events = [];
  let attempts = 0;
  let active = '';
  let downloadClosed = false;
  let uploadClosed = false;
  let finishDownload;
  let finishUpload;
  const downloadCleanup = new Promise(resolve => { finishDownload = resolve; });
  const uploadCleanup = new Promise(resolve => { finishUpload = resolve; });
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event) });
  engine.ping = async () => {
    attempts += 1;
    assert.equal(active, '', 'no transfer-phase probe may be labeled unloaded');
    if (attempts > 1) assert.ok(downloadClosed && uploadClosed, 'remaining idle probes wait for all transfer cleanup');
    return 10 + attempts;
  };
  engine.prepareTransport = async (normalized, options, idle) => {
    assert.equal(attempts, 1);
    assert.equal(idle.medianMs, 11);
    return { config: normalized, options, transport: { transport: 'http' } };
  };
  const resultFor = () => ({ mbps: 1, measuredBytes: 125000, totalBytes: 125000, latency: latencyStatistics([20]) });
  engine.downloadPhase = async (_, __, ___, ____, idle) => {
    assert.equal(idle.medianMs, 11);
    active = 'download'; engine.emit({ type: 'phase', phase: active });
    await downloadCleanup;
    active = ''; downloadClosed = true;
    return resultFor();
  };
  engine.uploadPhase = async (_, __, ___, ____, idle) => {
    assert.equal(idle.medianMs, 11, 'later idle probes must not retroactively change warm-up or handshake RTT');
    active = 'upload'; engine.emit({ type: 'phase', phase: active });
    await uploadCleanup;
    active = ''; uploadClosed = true;
    return resultFor();
  };
  const running = engine.run(config());
  await setImmediate();
  assert.equal(active, 'download');
  assert.equal(attempts, 1);
  finishDownload(); await setImmediate();
  assert.equal(active, 'upload');
  assert.equal(attempts, 1);
  finishUpload(); await setImmediate();
  for (let index = 0; index < 6; index += 1) await advance(t, 90);
  const final = await running;
  assert.equal(attempts, 8);
  assert.deepEqual(final.latency.idle, { medianMs: 14.5, jitterMs: 1, samples: 8, failed: 0, attempts: 8 });
  assert.deepEqual(events.filter(event => event.type === 'phase').map(event => event.phase), ['latency', 'download', 'upload']);
  assert.equal(events.at(-1).type, 'complete');
});

test('cancelling the quiet idle tail aborts its request and never publishes a completed run', async () => {
  let attempts = 0;
  const events = [];
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event) });
  engine.ping = async (_, signal) => ++attempts === 1 ? 5 : abortablePending(signal);
  engine.prepareTransport = async (normalized, options) => ({ config: normalized, options, transport: {} });
  engine.downloadPhase = engine.uploadPhase = async () => ({ mbps: 1, latency: latencyStatistics([]) });
  const running = engine.run(config());
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await setImmediate();
  assert.equal(attempts, 2);
  engine.cancel();
  await rejected;
  assert.equal(engine.controller, null);
  assert.equal(events.some(event => event.type === 'complete'), false);
});

test('continuous download excludes warm-up and keeps a single request open until its shared deadline', async t => {
  mockTime(t);
  let downloads = 0;
  let cancelled = false;
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname !== '/api/download') return new Response('{}');
    downloads += 1;
    assert.equal(new URL(url).searchParams.get('stream'), '1');
    assert.equal(new URL(url).searchParams.has('bytes'), false);
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(1000000));
      const timer = setTimeout(() => controller.enqueue(new Uint8Array(1000)), 70);
      options.signal.addEventListener('abort', () => { cancelled = true; clearTimeout(timer); controller.error(options.signal.reason); }, { once: true });
    } });
    return new Response(body);
  } });
  const settings = phaseConfiguration();
  settings.test = { ...settings.test, warmupMs: 50, downloadDurationMs: 100 };
  const result = engine.downloadPhase(node, settings.test, settings.performance, settings.options, settings.idle, new AbortController().signal);
  await setImmediate();
  await advance(t, 50);
  await advance(t, 20);
  await advance(t, 80);
  const measured = await result;
  assert.equal(measured.measuredBytes, 1000);
  assert.equal(measured.totalBytes, 1001000);
  assert.equal(measured.mbps, .08);
  assert.equal(downloads, 1);
  assert.equal(cancelled, true);
});

for (const transport of ['http', 'websocket']) {
  test(`${transport} displays real warm-up bytes before the first ticker without contaminating speed or curves`, async t => {
    mockTime(t);
    const began = Date.now();
    const events = [];
    const timing = [[50, 1000], [75, 1000], [160, 1000], [370, 100]];
    const ws = fakeWebSockets(socket => {
      socket.message(new ArrayBuffer(1000));
      for (const [delay, bytes] of timing) setTimeout(() => socket.message(new ArrayBuffer(bytes)), delay);
    });
    const normalized = transport === 'websocket' ? websocketConfig() : normalizeConfig(config());
    const engine = new MeasurementEngine({
      clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory,
      onUpdate: event => events.push({ ...event, observedAt: Date.now() - began }),
      fetchImpl: async (url, options) => {
        if (new URL(url).pathname !== '/api/download') return new Response('{}');
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array(1000));
          const timers = timing.map(([delay, bytes]) => setTimeout(() => controller.enqueue(new Uint8Array(bytes)), delay));
          options.signal.addEventListener('abort', () => { timers.forEach(clearTimeout); controller.error(options.signal.reason); }, { once: true });
        } }));
      },
    });
    const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 350, downloadDurationMs: 100 }, normalized.performance, { mode: 'manual', streams: 1 }, { medianMs: 0 }, new AbortController().signal);
    await setImmediate();
    assert.equal(events.some(event => event.previewMbps > 0), false, 'no timer-only or zero-time fake speed may be displayed');
    await advance(t, 50);
    const preview = events.find(event => event.type === 'progress' && event.previewMbps > 0);
    assert.equal(preview.observedAt, 50, 'a real positive elapsed interval need not wait for the 200 ms ticker');
    assert.equal(preview.previewElapsedMs, 50);
    assert.equal(preview.totalBytes, 2000);
    assert.equal(preview.previewMbps, .32);
    assert.equal(preview.warmingUp, true);
    assert.equal(preview.measuredBytes, 0);
    assert.equal(preview.mbps, 0);
    assert.deepEqual(preview.points, []);
    await advance(t, 25);
    assert.equal(events.filter(event => event.type === 'progress').length, 1, 'rapid payload callbacks share a 10 Hz preview limit');
    await advance(t, 85);
    await advance(t, 40);
    await advance(t, 150);
    await advance(t, 20);
    await advance(t, 80);
    const measured = await pending;
    const previews = events.filter(event => event.type === 'progress' && event.warmingUp);
    assert.ok(previews.slice(1).every((event, index) => event.observedAt - previews[index].observedAt >= 100));
    assert.ok(previews.every(event => event.measuredBytes === 0 && event.points.length === 0));
    assert.equal(measured.measuredBytes, 100);
    assert.equal(measured.totalBytes, 4100);
    assert.equal(measured.durationMs, 100);
    assert.equal(measured.mbps, .008, 'final throughput excludes all 4000 pre-window bytes');
    assert.equal(measured.points.some(point => point.mbps >= .16), false, 'the preview rate must never enter the measured curve');
  });
}

test('mixed control/data origins route ten actual streams into four control slots and six data slots', async t => {
  mockTime(t);
  const mixed = normalizeConfig({ ...config(), performance: { measurementOrigins: ['http://localhost/', 'http://localhost:8081/'], maxStreams: 24 } });
  const requestedOrigins = [];
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    if (new URL(url).pathname !== '/api/download') return new Response('{}');
    requestedOrigins.push(new URL(url).origin);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(1000));
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    } }));
  } });
  const settings = phaseConfiguration();
  const running = engine.downloadPhase(node, { ...settings.test, downloadDurationMs: 50 }, mixed.performance, { mode: 'manual', streams: 10 }, settings.idle, new AbortController().signal);
  await setImmediate();
  await advance(t, 50);
  await running;
  assert.equal(requestedOrigins.filter(origin => origin === 'http://localhost').length, 4);
  assert.equal(requestedOrigins.filter(origin => origin === 'http://localhost:8081').length, 6);
});

test('partial download followed by exhausted retries rejects instead of reporting complete success', async t => {
  mockTime(t);
  let downloads = 0;
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async url => {
    if (new URL(url).pathname !== '/api/download') return new Response('{}');
    downloads += 1;
    return downloads === 1 ? new Response(new Uint8Array(1000)) : new Response('unavailable', { status: 503 });
  } });
  const settings = phaseConfiguration();
  const running = engine.downloadPhase(node, settings.test, settings.performance, settings.options, settings.idle, new AbortController().signal);
  const rejected = assert.rejects(running, /下载测速连接中断/);
  await setImmediate();
  await advance(t, 180);
  await advance(t, 360);
  await rejected;
  assert.equal(downloads, 3);
});

test('simultaneous retry exhaustion on two streams cannot mistake each exhausted peer for a live transfer', async t => {
  mockTime(t);
  let downloads = 0;
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async url => {
    if (new URL(url).pathname !== '/api/download') return new Response('{}');
    downloads += 1;
    return downloads <= 2 ? new Response(new Uint8Array(1000)) : new Response('unavailable', { status: 503 });
  } });
  const settings = phaseConfiguration();
  settings.options.streams = 2;
  const running = engine.downloadPhase(node, settings.test, settings.performance, settings.options, settings.idle, new AbortController().signal);
  const rejected = assert.rejects(running, /下载测速连接中断/);
  await setImmediate();
  await advance(t, 180);
  await advance(t, 360);
  await rejected;
  assert.equal(downloads, 6);
});

test('high RTT upload counts server-received progress before any giant body acknowledgement', async t => {
  mockTime(t);
  const began = Date.now();
  const settings = phaseConfiguration();
  settings.idle = { medianMs: 300 };
  let bodyAcknowledgements = 0;
  let deleted = false;
  let phase;
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), onUpdate: update => { if (update.type === 'phase') phase = update; }, fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/upload-sessions' && options.method === 'POST') return new Response('{"id":"session"}', { status: 201 });
    if (pathname === '/api/upload-sessions/session' && options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (pathname === '/api/upload') {
      assert.ok(options.body instanceof Blob);
      assert.equal(options.body.size, 1048576);
      await abortablePending(options.signal);
      bodyAcknowledgements += 1;
    }
    if (pathname === '/api/upload-sessions/session') {
      const elapsed = Math.max(0, Math.min(1000, Date.now() - began - 2400));
      return new Response(JSON.stringify({ id: 'session', started: true, finished: elapsed === 1000, measuredBytes: elapsed * 125, totalBytes: Math.max(0, Date.now() - began) * 125, measurementElapsedMs: elapsed, activeRequests: elapsed === 1000 ? 0 : 1, activeTcpConnections: elapsed === 1000 ? 0 : 1, peakTcpConnections: 1, connectionsObserved: 1, protocols: ['HTTP/1.1'], scope: 'server' }));
    }
    return new Response('{}');
  } });
  const result = engine.uploadPhase(node, settings.test, settings.performance, settings.options, settings.idle, new AbortController().signal);
  await setImmediate();
  for (let elapsed = 0; elapsed < 3400; elapsed += 200) await advance(t, 200);
  const measured = await result;
  assert.equal(phase.warmupMs, 2400, 'warm-up should cover multiple RTTs');
  assert.equal(measured.measuredBytes, 125000);
  assert.equal(measured.mbps, 1);
  assert.equal(bodyAcknowledgements, 0);
  assert.equal(deleted, true);
  assert.equal(measured.connections.peak, 1);
});

test('fractional measured RTT produces integer milliseconds accepted by the upload session contract', async () => {
  const settings = phaseConfiguration();
  settings.idle = { medianMs: 300.123 };
  const controller = new AbortController();
  let sentWarmup;
  const engine = new MeasurementEngine({ randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/upload-sessions' && options.method === 'POST') {
      sentWarmup = JSON.parse(options.body).warmupMs;
      assert.ok(Number.isInteger(sentWarmup), 'Go JSON session fields require integer milliseconds');
      assert.ok(Math.abs(sentWarmup - settings.idle.medianMs * 8) < 1);
      controller.abort(new DOMException('test complete', 'AbortError'));
      return new Response('{"id":"fractional-rtt"}', { status: 201 });
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return abortablePending(options.signal);
  } });
  await assert.rejects(engine.uploadPhase(node, settings.test, settings.performance, settings.options, settings.idle, controller.signal), { name: 'AbortError' });
  assert.ok(Number.isInteger(sentWarmup));
});

test('queued giant upload data does not count when the server has received no measured bytes', async t => {
  mockTime(t);
  const began = Date.now();
  const settings = phaseConfiguration();
  let queued = 0;
  let deleted = false;
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/upload-sessions' && options.method === 'POST') return new Response('{"id":"empty"}', { status: 201 });
    if (pathname === '/api/upload-sessions/empty' && options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (pathname === '/api/upload') { queued += options.body.size; return abortablePending(options.signal); }
    if (pathname === '/api/upload-sessions/empty') return new Response(JSON.stringify({ started: false, finished: Date.now() - began >= 200, measuredBytes: 0, totalBytes: 0, measurementElapsedMs: 0 }));
    return new Response('{}');
  } });
  const running = engine.uploadPhase(node, settings.test, settings.performance, settings.options, settings.idle, new AbortController().signal);
  const rejected = assert.rejects(running, /没有收到有效数据/);
  await setImmediate();
  await advance(t, 200);
  await rejected;
  assert.equal(queued, 1048576);
  assert.equal(deleted, true);
});

test('cancelling an upload aborts all giant bodies and deletes the server progress session', async () => {
  const settings = phaseConfiguration();
  settings.options.streams = 2;
  let abortedBodies = 0;
  let deleted = false;
  const controller = new AbortController();
  const engine = new MeasurementEngine({ randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/upload-sessions' && options.method === 'POST') return new Response('{"id":"cancelled"}', { status: 201 });
    if (pathname === '/api/upload-sessions/cancelled' && options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (pathname === '/api/upload') {
      options.signal.addEventListener('abort', () => { abortedBodies += 1; }, { once: true });
      return abortablePending(options.signal);
    }
    if (pathname === '/api/upload-sessions/cancelled') return new Response('{"started":true,"finished":false,"measuredBytes":0,"totalBytes":1,"measurementElapsedMs":0}');
    return new Response('{}');
  } });
  const running = engine.uploadPhase(node, settings.test, settings.performance, settings.options, settings.idle, controller.signal);
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await setImmediate();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await rejected;
  assert.equal(abortedBodies, 2);
  assert.equal(deleted, true);
});

test('worker facade rejects overlap, cooperatively cancels and permits a fresh worker', async () => {
  const workers = [];
  const engine = new SpeedTest({ workerFactory: () => { const worker = { messages: [], terminated: false, postMessage(message) { this.messages.push(message); }, terminate() { this.terminated = true; } }; workers.push(worker); return worker; } });
  const running = engine.run(config(), { mode: 'manual', streams: 24 });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await assert.rejects(engine.run(config()), /测速正在进行/);
  assert.equal(workers[0].messages[0].options.streams, 24);
  engine.cancel('cancelled');
  assert.equal(workers[0].messages[1].type, 'cancel');
  workers[0].onmessage({ data: { type: 'error', name: 'AbortError', message: 'cancelled' } });
  await rejected;
  assert.equal(workers[0].terminated, true);
  const next = engine.run(config());
  workers[1].onmessage({ data: { type: 'result', result: { completed: true } } });
  assert.deepEqual(await next, { completed: true });
  assert.equal(workers[1].terminated, true);
});

test('an unresponsive worker is terminated after the cancellation grace period', async t => {
  mockTime(t);
  let terminated = false;
  const engine = new SpeedTest({ workerFactory: () => ({ postMessage() {}, terminate() { terminated = true; } }) });
  const running = engine.run(config());
  const rejected = assert.rejects(running, { name: 'AbortError' });
  engine.cancel();
  await advance(t, 2499);
  assert.equal(terminated, false);
  await advance(t, 1);
  await rejected;
  assert.equal(terminated, true);
  assert.equal(engine.controller, null);
});

test('a worker result arriving after the user cancels cannot revive a cancelled run', async () => {
  let worker;
  const engine = new SpeedTest({ workerFactory: () => { worker = { postMessage() {}, terminate() {} }; return worker; } });
  const running = engine.run(config());
  const rejected = assert.rejects(running, { name: 'AbortError' });
  engine.cancel();
  worker.onmessage({ data: { type: 'result', result: { completed: true } } });
  await rejected;
});

test('late messages and errors from a former worker cannot finish the next generation', async () => {
  const workers = [];
  const engine = new SpeedTest({ workerFactory: () => { const worker = { postMessage() {}, terminated: false, terminate() { this.terminated = true; } }; workers.push(worker); return worker; } });
  const first = engine.run(config());
  workers[0].onmessage({ data: { type: 'result', result: { first: true } } });
  await first;
  const second = engine.run(config());
  let settled = false;
  second.then(() => { settled = true; }, () => { settled = true; });
  workers[0].onmessage({ data: { type: 'result', result: { stale: true } } });
  workers[0].onerror({ preventDefault() {} });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(workers[1].terminated, false);
  workers[1].onmessage({ data: { type: 'result', result: { second: true } } });
  assert.deepEqual(await second, { second: true });
});

const probeResponse = (bytes = 16) => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'identity' } });

test('reachable data ports preserve all 24 streams and probe actual uncached bytes before measurement', async () => {
  const normalized = normalizeConfig(config());
  const calls = [];
  const events = [];
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event), fetchImpl: async (url, options) => {
    const address = new URL(url);
    calls.push(address);
    assert.equal(address.pathname, '/api/download');
    assert.equal(address.searchParams.get('bytes'), '16384');
    assert.equal(address.searchParams.has('stream'), false, 'a probe must never start an unbounded download');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    return probeResponse(); // Diagnostic X-Test-* headers are deliberately absent.
  } });
  const ready = await engine.prepareTransport(normalized, normalizeOptions(normalized), { medianMs: 214 }, new AbortController().signal);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(url => url.searchParams.get('nonce'))).size, 4);
  assert.deepEqual(ready.config.performance.measurementOrigins, normalized.performance.measurementOrigins);
  assert.equal(ready.config.performance.maxStreams, 24);
  assert.equal(ready.transport.fallback, false);
  assert.deepEqual(ready.transport.unreachableOrigins, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'transport');
});

test('partially reachable data ports retain only real origin pools and disclose adjusted manual concurrency', async () => {
  const normalized = normalizeConfig(config());
  const attemptedPorts = [];
  const engine = new MeasurementEngine({ fetchImpl: async url => {
    const port = Number(new URL(url).port);
    attemptedPorts.push(port);
    if (port === 8082 || port === 8084) throw new TypeError('blocked port');
    return probeResponse();
  } });
  const ready = await engine.prepareTransport(normalized, normalizeOptions(normalized, { mode: 'manual', streams: 24 }), { medianMs: 214 }, new AbortController().signal);
  assert.equal(attemptedPorts.length, 4, 'healthy remaining data ports need no main-port probe');
  assert.deepEqual(ready.config.performance.measurementOrigins, ['http://localhost:8081/', 'http://localhost:8083/']);
  assert.equal(ready.config.performance.maxStreams, 12);
  assert.equal(ready.config.performance.originSlots.length, 12);
  assert.equal(ready.options.streams, 12);
  assert.equal(ready.transport.requestedStreams, 24);
  assert.equal(ready.transport.effectiveStreams, 12);
  assert.equal(ready.transport.streamsAdjusted, true);
  assert.match(ready.transport.message, /24.*12/);
  assert.equal(ready.transport.fallback, false);
  assert.deepEqual(ready.transport.unreachableOrigins, ['http://localhost:8082/', 'http://localhost:8084/']);
});

test('blocked independent ports fall back to four main-origin slots after a real partial body probe', async () => {
  const normalized = normalizeConfig(config());
  let tailCancelled = false;
  let blocked = 0;
  const engine = new MeasurementEngine({ fetchImpl: async url => {
    if (new URL(url).port) { blocked += 1; throw new TypeError('firewall blocked'); }
    assert.equal(blocked, 4, 'main fallback begins only after all independent probes settle');
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1)); },
      cancel() { tailCancelled = true; },
    }), { headers: { 'Content-Type': 'application/octet-stream' } });
  } });
  const ready = await engine.prepareTransport(normalized, normalizeOptions(normalized, { mode: 'manual', streams: 24 }), { medianMs: 214 }, new AbortController().signal);
  assert.equal(tailCancelled, true, 'one real byte is enough; a slow probe tail must be cancelled');
  assert.deepEqual(ready.config.performance.measurementOrigins, [node.baseUrl]);
  assert.equal(ready.config.performance.maxStreams, 4);
  assert.deepEqual(ready.config.performance.originSlots, Array(4).fill(node.baseUrl));
  assert.equal(ready.config.performance.sharedControlOrigin, true);
  assert.equal(ready.transport.fallback, true);
  assert.equal(ready.transport.mode, 'single-origin');
  assert.equal(ready.options.streams, 4);
  assert.match(ready.transport.message, /单端口.*24.*4/);
  assert.equal(normalized.performance.maxStreams, 24, 'reachability must not overwrite the original configuration');
});

test('unusable main transfer after blocked data ports reports the deployment paths instead of publishing a result', async () => {
  const calls = [];
  const events = [];
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event), fetchImpl: async url => { calls.push(url); throw new TypeError('blocked'); } });
  engine.idleLatency = async () => ({ medianMs: 214 });
  engine.downloadPhase = async () => { assert.fail('no formal download may start without a reachable transfer route'); };
  await assert.rejects(engine.run(config()), /独立测速端口.*主站测速接口.*防火墙/);
  assert.equal(calls.length, 5);
  assert.equal(events.some(event => event.type === 'complete'), false);
  assert.equal(engine.controller, null);
});

test('text, compressed and empty successful responses cannot falsely qualify as reachable data ports', async () => {
  const normalized = normalizeConfig(config());
  const engine = new MeasurementEngine({ fetchImpl: async url => {
    switch (new URL(url).port) {
      case '8081': return new Response('<html>proxy error</html>', { headers: { 'Content-Type': 'text/html' } });
      case '8082': return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      case '8083': return probeResponse(0);
      case '8084': return new Response(new Uint8Array(16), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' } });
      default: return probeResponse();
    }
  } });
  const ready = await engine.prepareTransport(normalized, normalizeOptions(normalized), { medianMs: 0 }, new AbortController().signal);
  assert.equal(ready.transport.fallback, true);
  assert.equal(ready.transport.unreachableOrigins.length, 4);
});

test('parallel black-holed probes time out once using RTT and then use the main origin', async t => {
  mockTime(t);
  const normalized = normalizeConfig(config());
  const signals = [];
  let mainCalls = 0;
  const engine = new MeasurementEngine({ fetchImpl: async (url, options) => {
    if (!new URL(url).port) { mainCalls += 1; return probeResponse(); }
    signals.push(options.signal);
    return abortablePending(options.signal);
  } });
  const pending = engine.prepareTransport(normalized, normalizeOptions(normalized), { medianMs: 300 }, new AbortController().signal);
  await advance(t, 2299);
  assert.equal(signals.length, 4);
  assert.equal(signals.some(signal => signal.aborted), false);
  assert.equal(mainCalls, 0);
  await advance(t, 1);
  const ready = await pending;
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.equal(mainCalls, 1);
  assert.equal(ready.config.performance.maxStreams, 4);
});

test('cancelling parallel reachability probes aborts all requests and never tries fallback or publishes transport', async () => {
  const signals = [];
  const events = [];
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event), fetchImpl: async (url, options) => {
    assert.ok(new URL(url).port, 'cancelled probes must not proceed to the main fallback');
    signals.push(options.signal);
    return abortablePending(options.signal);
  } });
  engine.idleLatency = async () => ({ medianMs: 214 });
  const pending = engine.run(config());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  engine.cancel();
  await rejected;
  assert.equal(signals.length, 4);
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.equal(events.some(event => event.type === 'transport' || event.type === 'complete'), false);
});

test('cancelling the main fallback probe does not start either measurement phase', async () => {
  let mainSignal;
  const events = [];
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event), fetchImpl: async (url, options) => {
    if (new URL(url).port) throw new TypeError('blocked');
    mainSignal = options.signal;
    return abortablePending(options.signal);
  } });
  engine.idleLatency = async () => ({ medianMs: 214 });
  engine.downloadPhase = async () => { assert.fail('cancelled fallback must not begin measuring'); };
  const pending = engine.run(config());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  assert.ok(mainSignal);
  engine.cancel();
  await rejected;
  assert.equal(mainSignal.aborted, true);
  assert.equal(events.some(event => event.type === 'transport' || event.type === 'complete'), false);
});

test('a fallback run passes the effective pools to both phases without counting probe payload as measurements', async () => {
  const phases = [];
  const events = [];
  const engine = new MeasurementEngine({ onUpdate: event => events.push(event), fetchImpl: async url => {
    if (new URL(url).port) throw new TypeError('blocked');
    return probeResponse(16384);
  } });
  engine.idleLatency = async () => latencyStatistics([214, 215]);
  const phase = (name, bytes) => async (_, testSettings, performanceSettings, options) => {
    phases.push(name);
    assert.equal(testSettings.maxStreams, 4);
    assert.equal(performanceSettings.maxStreams, 4);
    assert.deepEqual(performanceSettings.measurementOrigins, [node.baseUrl]);
    assert.equal(options.streams, 4);
    return { mbps: toMbps(bytes, 1000), measuredBytes: bytes, totalBytes: bytes, latency: latencyStatistics([214]) };
  };
  engine.downloadPhase = phase('download', 1000);
  engine.uploadPhase = phase('upload', 2000);
  const result = await engine.run(config(), { mode: 'manual', streams: 24 });
  assert.deepEqual(phases, ['download', 'upload']);
  assert.equal(result.download.measuredBytes, 1000);
  assert.equal(result.upload.measuredBytes, 2000);
  assert.equal(result.downloadMbps, .008);
  assert.equal(result.transport.requestedStreams, 24);
  assert.equal(result.transport.effectiveStreams, 4);
  assert.equal(events.findIndex(event => event.type === 'transport') < events.findIndex(event => event.type === 'complete'), true);
});

test('recovered data ports restore capacity on the next run instead of caching a fallback indefinitely', async () => {
  const normalized = normalizeConfig(config());
  let recovered = false;
  const engine = new MeasurementEngine({ fetchImpl: async url => {
    if (!recovered && new URL(url).port) throw new TypeError('blocked');
    return probeResponse();
  } });
  const options = normalizeOptions(normalized);
  assert.equal((await engine.prepareTransport(normalized, options, { medianMs: 214 }, new AbortController().signal)).config.performance.maxStreams, 4);
  recovered = true;
  const ready = await engine.prepareTransport(normalized, options, { medianMs: 214 }, new AbortController().signal);
  assert.equal(ready.config.performance.maxStreams, 24);
  assert.equal(ready.transport.fallback, false);
});

test('going offline during discovery prevents additional probes, main fallback and completion', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const navigator = { onLine: true };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  try {
    let requests = 0;
    const events = [];
    const engine = new MeasurementEngine({ onUpdate: event => events.push(event), fetchImpl: async () => {
      requests += 1;
      navigator.onLine = false;
      throw new TypeError('device lost its network connection');
    } });
    engine.idleLatency = async () => ({ medianMs: 214 });
    await assert.rejects(engine.run(config()), error => error.name === 'AbortError' && /网络连接已断开/.test(error.message));
    assert.equal(requests, 1);
    assert.equal(events.some(event => event.type === 'transport' || event.type === 'complete'), false);
    assert.equal(engine.controller, null);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

function websocketConfig() {
  return normalizeConfig({ ...config(), performance: { transport: 'websocket', measurementOrigins: ['/'], defaultMode: 'manual', defaultStreams: 8, maxStreams: 30 } });
}

function fakeWebSockets(onReady = () => {}, { closeWaitsForServer = false, readyMessage, readyDelayMs = 0 } = {}) {
  const sockets = [];
  const factory = url => {
    const socket = {
      url, readyState: 0, bufferedAmount: 0, binaryType: '', binarySends: [], controls: [], closeCalls: 0,
      message(data) { this.onmessage?.({ data }); },
      send(data) {
        assert.equal(this.readyState, 1);
        if (typeof data === 'string') this.controls.push(JSON.parse(data));
        else { this.binarySends.push(data.size); this.bufferedAmount += data.size; }
      },
      serverClose(code = 1000, reason = '') { this.readyState = 3; this.bufferedAmount = 0; queueMicrotask(() => this.onclose?.({ code, reason })); },
      close(code = 1000, reason = '') {
        this.closeCalls += 1;
        this.readyState = 2;
        if (!closeWaitsForServer) this.serverClose(code, reason);
      },
    };
    sockets.push(socket);
    const deliverReady = () => {
      if (socket.readyState !== 0) return;
      socket.readyState = 1;
      socket.message(JSON.stringify(readyMessage || { type: 'ready', connectionId: `tcp-${sockets.indexOf(socket)}`, protocol: 'HTTP/1.1' }));
      onReady(socket, new URL(url));
    };
    const delay = typeof readyDelayMs === 'function' ? readyDelayMs(sockets.length - 1) : readyDelayMs;
    if (delay !== null) {
      if (delay > 0) setTimeout(deliverReady, delay);
      else queueMicrotask(deliverReady);
    }
    return socket;
  };
  return { sockets, factory };
}

test('single-port WebSocket defaults to eight fixed streams and supports thirty independently of HTTP pools', () => {
  const normalized = websocketConfig();
  assert.equal(normalized.performance.transport, 'websocket');
  assert.equal(normalized.performance.maxStreams, 30);
  assert.equal(normalized.test.minStreams, 8);
  assert.deepEqual(normalizeOptions(normalized), { mode: 'manual', streams: 8, durationMs: undefined, warmupOverride: undefined, testType: 'full', measurementPolicy: 'fixed', minDurationMs: 5000, maxBytes: 0 });
  assert.equal(normalizeOptions(normalized, { streams: 30 }).streams, 30);
  assert.throws(() => normalizeOptions(normalized, { streams: 31 }), /并行传输/);
  assert.equal(normalizeConfig({ ...config(), performance: { transport: 'websocket', maxStreams: 999 } }).performance.maxStreams, 30);
});

test('WebSocket frame feedback scales from slow kilobit messages to one MiB without fractional sizes', () => {
  assert.equal(chooseWebSocketMessageBytes(4096, 1000), 1024);
  assert.equal(chooseWebSocketMessageBytes(4096, 1), 65536);
  assert.equal(chooseWebSocketMessageBytes(100000000, 1), 1048576);
  for (const bytes of [0, 1024, 1048576]) assert.equal(Math.log2(chooseWebSocketMessageBytes(bytes, 40)) % 1, 0);
});

test('WebSocket handshake budget scales to actual concurrency and RTT while remaining capped', () => {
  assert.equal(chooseWebSocketHandshakeTimeout(1), 5000);
  assert.equal(chooseWebSocketHandshakeTimeout(6), 5000);
  assert.equal(chooseWebSocketHandshakeTimeout(8), 6500);
  assert.equal(chooseWebSocketHandshakeTimeout(30, 80), 11000);
  assert.equal(chooseWebSocketHandshakeTimeout(30, 2500), 15000);
  assert.equal(chooseWebSocketHandshakeTimeout(30, 10000), 30000);
  assert.equal(chooseWebSocketHandshakeTimeout(30, 2500.1), 15001);
  assert.equal(chooseWebSocketHandshakeTimeout(NaN, Infinity), 5000);
});

test('thirty downloads tolerate queued ready messages beyond five seconds without changing their byte window', async t => {
  mockTime(t);
  const ws = fakeWebSockets(socket => {
    if (ws.sockets.indexOf(socket) < 28) {
      socket.message(new ArrayBuffer(100));
      setTimeout(() => socket.message(new ArrayBuffer(1000)), 70);
    } else socket.message(new ArrayBuffer(1000));
  }, { readyDelayMs: index => index < 28 ? 0 : 5500 });
  const normalized = websocketConfig();
  const engine = new MeasurementEngine({ clock: () => Date.now(), webSocketFactory: ws.factory, randomFill: bytes => bytes.fill(1), fetchImpl: async () => new Response('{}') });
  const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 50, downloadDurationMs: 10000 }, normalized.performance, { mode: 'manual', streams: 30 }, { medianMs: 0 }, new AbortController().signal);
  await setImmediate();
  await advance(t, 70);
  await advance(t, 4931);
  assert.equal(ws.sockets.length, 30);
  assert.equal(ws.sockets.slice(28).every(socket => socket.readyState === 0 && socket.closeCalls === 0), true, 'queued upgrades remain pending beyond the old five-second deadline');
  await advance(t, 499);
  assert.equal(ws.sockets.every(socket => socket.readyState === 1), true);
  await advance(t, 4550);
  const measured = await pending;
  assert.equal(Date.now(), 1700000010050);
  assert.equal(measured.durationMs, 10000);
  assert.equal(measured.measuredBytes, 30000);
  assert.equal(measured.totalBytes, 32800);
  assert.equal(measured.mbps, .024);
  assert.equal(measured.attemptedRequests, 30);
  assert.equal(measured.failedRequests, 0);
  assert.equal(measured.peakStreams, 30);
  assert.equal(new Set(ws.sockets.map(socket => new URL(socket.url).searchParams.get('run'))).size, 1);
  assert.equal(ws.sockets.every(socket => socket.closeCalls === 1), true);
});

test('thirty uploads use the same queue-aware handshake budget and retain authoritative server bytes', async t => {
  mockTime(t);
  const ws = fakeWebSockets(() => {}, { readyDelayMs: index => index < 28 ? 0 : 5500 });
  const normalized = websocketConfig();
  const engine = new MeasurementEngine({ clock: () => Date.now(), taskYield: () => setImmediate(), webSocketFactory: ws.factory, randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/upload-sessions') return new Response('{"id":"queued-upgrade"}', { status: 201 });
    if (path === '/api/upload-sessions/queued-upgrade' && options.method === 'DELETE') return new Response(null, { status: 204 });
    if (path === '/api/upload-sessions/queued-upgrade') {
      const finished = Date.now() >= 1700000010000;
      return new Response(JSON.stringify({ measuredBytes: finished ? 1000 : 0, totalBytes: finished ? 1000 : 0, measurementElapsedMs: finished ? 10000 : 0, finished }));
    }
    return new Response('{}');
  } });
  const pending = engine.uploadPhase(node, { ...normalized.test, uploadDurationMs: 10000 }, { ...normalized.performance, uploadBlockBytes: 65536 }, { mode: 'manual', streams: 30 }, { medianMs: 0 }, new AbortController().signal);
  await setImmediate();
  await advance(t, 5001);
  assert.equal(ws.sockets.length, 30);
  assert.equal(ws.sockets.slice(28).every(socket => socket.readyState === 0 && socket.closeCalls === 0), true);
  await advance(t, 499);
  assert.equal(ws.sockets.every(socket => socket.readyState === 1), true);
  await advance(t, 4500);
  const measured = await pending;
  assert.equal(measured.durationMs, 10000);
  assert.equal(measured.measuredBytes, 1000);
  assert.equal(measured.mbps, .0008);
  assert.equal(measured.failedRequests, 0);
  assert.equal(measured.peakStreams, 30);
  assert.equal(ws.sockets.length, 30, 'healthy queued connections must not be retried');
  assert.equal(ws.sockets.every(socket => socket.closeCalls === 1), true);
});

test('unready upgrades still time out at their bounded deadline and cancellation skips the remaining wait', async t => {
  mockTime(t);
  const ws = fakeWebSockets(() => {}, { readyDelayMs: null });
  const engine = new MeasurementEngine({ webSocketFactory: ws.factory });
  const timeout = chooseWebSocketHandshakeTimeout(30, 80);
  let observedReady = 0;
  let observedBytes = 0;
  const callbacks = { onReady: () => { observedReady += 1; }, onBinary: (_, bytes) => { observedBytes += bytes; } };
  const blackhole = engine.socketExchange(node.baseUrl, { direction: 'download', run: 'blackhole' }, new AbortController().signal, callbacks, timeout);
  const rejected = assert.rejects(blackhole, /WebSocket.*超时/);
  await advance(t, 10999);
  assert.equal(ws.sockets[0].closeCalls, 0);
  await advance(t, 1);
  await rejected;
  assert.equal(ws.sockets[0].closeCalls, 1);
  const controller = new AbortController();
  const cancelled = engine.socketExchange(node.baseUrl, { direction: 'upload', session: 'cancelled' }, controller.signal, callbacks, timeout);
  const stopped = assert.rejects(cancelled, { name: 'AbortError' });
  await advance(t, 1);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await stopped;
  assert.equal(Date.now(), 1700000011001, 'cancellation does not wait for the extended handshake timer');
  assert.equal(ws.sockets[1].closeCalls, 1);
  assert.equal(observedReady, 0);
  assert.equal(observedBytes, 0);
});

test('a genuinely timed-out WebSocket remains a failed request even when its retry later succeeds', async t => {
  mockTime(t);
  const ws = fakeWebSockets(socket => socket.message(new ArrayBuffer(1000)), { readyDelayMs: index => index === 0 ? null : 0 });
  const normalized = websocketConfig();
  const engine = new MeasurementEngine({ clock: () => Date.now(), webSocketFactory: ws.factory, randomFill: bytes => bytes.fill(1), fetchImpl: async () => new Response('{}') });
  const pending = engine.downloadPhase(node, { ...normalized.test, downloadDurationMs: 10000 }, normalized.performance, { mode: 'manual', streams: 1 }, { medianMs: 0 }, new AbortController().signal);
  await setImmediate();
  await advance(t, 5000);
  assert.equal(ws.sockets[0].closeCalls, 1);
  await advance(t, 180);
  assert.equal(ws.sockets.length, 2);
  await advance(t, 4820);
  const measured = await pending;
  assert.equal(measured.failedRequests, 1);
  assert.equal(measured.attemptedRequests, 2);
  assert.equal(measured.measuredBytes, 1000);
  assert.equal(measured.mbps, .0008);
  assert.equal(measured.peakStreams, 1, 'unready connections never become observed test streams');
  assert.equal(measured.connections.observed, 1);
});

test('a ready WebSocket plus actual binary probe retains eight fixed streams with no HTTP downgrade', async () => {
  const ws = fakeWebSockets((socket, url) => { assert.equal(url.searchParams.get('direction'), 'probe'); socket.message(new ArrayBuffer(4096)); });
  const events = [];
  const normalized = websocketConfig();
  const engine = new MeasurementEngine({ webSocketFactory: ws.factory, onUpdate: event => events.push(event), fetchImpl: () => assert.fail('healthy WebSocket transport must not run HTTP fallback probes') });
  const ready = await engine.prepareTransport(normalized, normalizeOptions(normalized), { medianMs: 214 }, new AbortController().signal);
  assert.equal(ready.config.performance.maxStreams, 30);
  assert.equal(ready.options.streams, 8);
  assert.equal(ready.transport.transport, 'websocket');
  assert.equal(ready.transport.fallback, false);
  assert.equal(ws.sockets.length, 1);
  assert.equal(ws.sockets[0].binaryType, 'arraybuffer');
  assert.equal(ws.sockets[0].closeCalls, 1);
  assert.equal(events[0].transport, 'websocket');
});

test('an invalid WebSocket upgrade response explicitly downgrades eight requested streams to four HTTP streams', async () => {
  const ws = fakeWebSockets(() => {}, { readyMessage: { type: 'ready', protocol: 'HTTP/1.1' } });
  const normalized = websocketConfig();
  let httpProbes = 0;
  const engine = new MeasurementEngine({ webSocketFactory: ws.factory, fetchImpl: async url => { httpProbes += 1; assert.equal(new URL(url).searchParams.get('bytes'), '16384'); return probeResponse(); } });
  const ready = await engine.prepareTransport(normalized, normalizeOptions(normalized), { medianMs: 214 }, new AbortController().signal);
  assert.equal(httpProbes, 1);
  assert.equal(ready.config.performance.transport, 'http');
  assert.equal(ready.config.performance.maxStreams, 4);
  assert.equal(ready.options.streams, 4);
  assert.equal(ready.transport.reason, 'websocket-unavailable');
  assert.equal(ready.transport.configuredMaxStreams, 30);
  assert.equal(ready.transport.requestedStreams, 8);
  assert.equal(ready.transport.effectiveStreams, 4);
  assert.equal(ready.transport.fallback, true);
  assert.match(ready.transport.message, /WebSocket.*HTTP.*8.*4/);
});

test('thirty independent WebSocket downloads count only binary messages inside one shared window', async t => {
  mockTime(t);
  const ws = fakeWebSockets(socket => {
    socket.message(new ArrayBuffer(100));
    setTimeout(() => socket.message(new ArrayBuffer(1000)), 70);
  });
  const normalized = websocketConfig();
  const engine = new MeasurementEngine({ clock: () => Date.now(), webSocketFactory: ws.factory, randomFill: bytes => bytes.fill(1), fetchImpl: async () => new Response(JSON.stringify({ activeRequests: ws.sockets.filter(socket => socket.readyState === 1).length, activeTcpConnections: ws.sockets.filter(socket => socket.readyState === 1).length, peakTcpConnections: 30, connectionsObserved: 30, protocols: ['HTTP/1.1'], scope: 'server' })) });
  const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 50, downloadDurationMs: 100 }, normalized.performance, { mode: 'manual', streams: 30 }, { medianMs: 0 }, new AbortController().signal);
  await setImmediate();
  await advance(t, 50);
  await advance(t, 20);
  await advance(t, 80);
  const measured = await pending;
  assert.equal(ws.sockets.length, 30);
  assert.equal(new Set(ws.sockets.map(socket => new URL(socket.url).searchParams.get('run'))).size, 1);
  assert.equal(measured.measuredBytes, 30000);
  assert.equal(measured.totalBytes, 33000);
  assert.equal(measured.mbps, 2.4);
  assert.equal(measured.transport, 'websocket');
  assert.equal(measured.peakStreams, 30);
  assert.equal(measured.connections.peak, 30);
  assert.equal(measured.activeStreams, 0);
  assert.equal(ws.sockets.every(socket => socket.closeCalls === 1), true);
  assert.equal(ws.sockets.every(socket => socket.controls.length <= 1), true, 'feedback cannot flood a socket between quarter-second samples');
});

test('WebSocket uploads bound each outgoing queue while deriving speed from server receipt instead of queued frames', async t => {
  mockTime(t);
  const ws = fakeWebSockets();
  const normalized = websocketConfig();
  let deleted = false;
  const engine = new MeasurementEngine({ clock: () => Date.now(), taskYield: () => setImmediate(), webSocketFactory: ws.factory, randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/upload-sessions') return new Response('{"id":"ws-upload"}', { status: 201 });
    if (pathname === '/api/upload-sessions/ws-upload' && options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (pathname === '/api/upload-sessions/ws-upload') {
      const finished = Date.now() >= 1700000001000;
      return new Response(JSON.stringify({ measuredBytes: finished ? 1000 : 0, totalBytes: finished ? 1000 : 0, measurementElapsedMs: finished ? 1000 : 0, finished, activeRequests: ws.sockets.filter(socket => socket.readyState === 1).length, activeTcpConnections: ws.sockets.filter(socket => socket.readyState === 1).length, peakTcpConnections: 2, connectionsObserved: 2, protocols: ['HTTP/1.1'], scope: 'server' }));
    }
    return new Response('{}');
  } });
  const pending = engine.uploadPhase(node, { ...normalized.test, uploadDurationMs: 1000 }, { ...normalized.performance, uploadBlockBytes: 1048576 }, { mode: 'manual', streams: 2 }, { medianMs: 0 }, new AbortController().signal);
  await setImmediate();
  await advance(t, 10);
  await setImmediate();
  assert.equal(ws.sockets.length, 2);
  assert.equal(ws.sockets.every(socket => socket.bufferedAmount <= 4 * 1048576), true);
  assert.equal(ws.sockets.every(socket => socket.binarySends.length === 4), true);
  assert.equal(ws.sockets.every(socket => socket.binarySends.every(size => size === 1048576)), true);
  await advance(t, 990);
  const measured = await pending;
  assert.equal(measured.measuredBytes, 1000);
  assert.equal(measured.mbps, .008, 'eight queued MiB must not become measured upload data');
  assert.equal(measured.peakStreams, 2);
  assert.equal(deleted, true);
});

test('cancelling queued WebSocket upload deletes the server session before waiting for peer-close events', async t => {
  mockTime(t);
  const ws = fakeWebSockets(() => {}, { closeWaitsForServer: true });
  const normalized = websocketConfig();
  const controller = new AbortController();
  let deleted = false;
  const engine = new MeasurementEngine({ clock: () => Date.now(), taskYield: () => setImmediate(), webSocketFactory: ws.factory, randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/upload-sessions') return new Response('{"id":"ws-cancel"}', { status: 201 });
    if (pathname === '/api/upload-sessions/ws-cancel' && options.method === 'DELETE') {
      deleted = true;
      ws.sockets.forEach(socket => socket.serverClose(1000, 'session_finished'));
      return new Response(null, { status: 204 });
    }
    if (pathname === '/api/upload-sessions/ws-cancel') return new Response('{"finished":false,"measuredBytes":0,"totalBytes":0,"measurementElapsedMs":0}');
    return new Response('{}');
  } });
  const pending = engine.uploadPhase(node, { ...normalized.test, uploadDurationMs: 1000 }, { ...normalized.performance, uploadBlockBytes: 1048576 }, { mode: 'manual', streams: 2 }, { medianMs: 0 }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  await advance(t, 10);
  assert.equal(ws.sockets.every(socket => socket.bufferedAmount === 4 * 1048576), true);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await rejected; // No 2-second close timeout or queue drain is necessary; DELETE unblocks the peer.
  assert.equal(deleted, true);
  assert.equal(ws.sockets.every(socket => socket.readyState === 3), true);
});

test('test plans validate byte budgets and preserve the fixed full-test defaults', () => {
  const normalized = websocketConfig();
  const defaults = normalizeOptions(normalized);
  assert.equal(defaults.testType, 'full');
  assert.equal(defaults.measurementPolicy, 'fixed');
  assert.equal(defaults.maxBytes, 0);
  for (const testType of ['upload', '', 1]) assert.throws(() => normalizeOptions(normalized, { testType }), /完整、下载或延迟/);
  for (const measurementPolicy of ['speed', '', 1]) assert.throws(() => normalizeOptions(normalized, { measurementPolicy }), /测量策略/);
  for (const maxBytes of [-1, 1.5, Infinity, NaN, 1024 ** 4 + 1]) assert.throws(() => normalizeOptions(normalized, { maxBytes }), /流量预算/);
  for (const minDurationMs of [4999, 5000.5, 10001]) assert.throws(() => normalizeOptions(normalized, { durationMs: 10000, minDurationMs }), /最短测量时间/);
  assert.equal(normalizeOptions(normalized, { maxBytes: 1024 ** 4 }).maxBytes, 1024 ** 4);
});

test('convergence requires three complete positive windows and rejects noise, drops and a continuing ramp', () => {
  const windows = rates => rates.map(mbps => ({ mbps, elapsedMs: 1000 }));
  assert.equal(isThroughputStable(windows([100000, 101000, 100500])), true);
  assert.equal(isThroughputStable(windows([100, 100])), false);
  assert.equal(isThroughputStable(windows([0, 0, 0])), false);
  assert.equal(isThroughputStable(windows([100, 90, 70])), false);
  assert.equal(isThroughputStable(windows([100, 105, 110])), false);
  assert.equal(isThroughputStable(windows([100, 70, 100])), false);
  assert.equal(isThroughputStable([{ mbps: 100, elapsedMs: 900 }, ...windows([100, 100])]), false);
});

test('latency-only performs its full idle sample budget without any reachability or payload requests', async t => {
  mockTime(t);
  const requests = [];
  const events = [];
  const engine = new MeasurementEngine({ clock: () => Date.now(), onUpdate: event => events.push(event),
    webSocketFactory: () => { throw new Error('latency-only must not open a socket'); },
    fetchImpl: async url => {
      requests.push(new URL(url).pathname);
      assert.equal(new URL(url).pathname, '/api/ping');
      return new Response('{}');
    },
  });
  const pending = engine.run({ ...websocketConfig(), test: { warmupMs: 0, pingSamples: 3 } }, { testType: 'latency' });
  await setImmediate();
  await advance(t, 90);
  await advance(t, 90);
  const result = await pending;
  assert.deepEqual(requests, ['/api/ping', '/api/ping', '/api/ping']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.testType, 'latency');
  assert.equal(result.transport, null);
  assert.equal(result.download, null);
  assert.equal(result.upload, null);
  assert.equal(result.downloadMbps, null);
  assert.equal(result.uploadMbps, null);
  assert.deepEqual(result.latency, { idle: { medianMs: 0, jitterMs: 0, samples: 3, failed: 0, attempts: 3 }, download: null, upload: null });
  assert.equal(events.at(-1).type, 'complete');
});

test('download-only completes a real body window and never allocates or posts an upload session', async t => {
  mockTime(t);
  const requests = [];
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const address = new URL(url);
    requests.push({ path: address.pathname, method: options.method || 'GET' });
    if (address.pathname !== '/api/download') return new Response('{}');
    if (address.searchParams.has('bytes')) return new Response(new Uint8Array(16384), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => controller.enqueue(new Uint8Array(1000)), 100);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(options.signal.reason); }, { once: true });
    } }));
  } });
  const pending = engine.run({ ...config(), performance: { measurementOrigins: ['/'] }, test: { warmupMs: 0, downloadDurationMs: 500, pingSamples: 1 } }, { testType: 'download', mode: 'manual', streams: 1 });
  await setImmediate();
  await advance(t, 100);
  await advance(t, 400);
  const result = await pending;
  assert.equal(result.testType, 'download');
  assert.equal(result.download.measuredBytes, 1000);
  assert.equal(result.download.completionReason, 'duration');
  assert.equal(result.downloadMbps, .016);
  assert.equal(result.upload, null);
  assert.equal(result.uploadMbps, null);
  assert.equal(result.latency.upload, null);
  assert.equal(requests.some(request => request.method !== 'GET' || request.path.includes('upload')), false);
});

for (const transport of ['http', 'websocket']) {
  for (const warmupMs of [0, 500]) {
    test(`${transport} byte budget ends on actual received bytes and reports ${warmupMs ? 'incomplete warm-up' : 'a measured partial window'}`, async t => {
      mockTime(t);
      const normalized = transport === 'websocket' ? websocketConfig() : normalizeConfig(config());
      let delivered = 0;
      let cancelled = false;
      const ws = fakeWebSockets(socket => setTimeout(() => { delivered += 1200; socket.message(new ArrayBuffer(1200)); }, 100));
      const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory,
        fetchImpl: async (url, options) => {
          if (new URL(url).pathname !== '/api/download') return new Response('{}');
          return new Response(new ReadableStream({ start(controller) {
            const timer = setTimeout(() => { delivered += 1200; controller.enqueue(new Uint8Array(1200)); }, 100);
            options.signal.addEventListener('abort', () => { cancelled = true; clearTimeout(timer); controller.error(options.signal.reason); }, { once: true });
          } }));
        },
      });
      const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs, downloadDurationMs: 10000 }, normalized.performance,
        { mode: 'manual', streams: 1, maxBytes: 1000 }, { medianMs: 0 }, new AbortController().signal);
      await setImmediate();
      await advance(t, 100);
      const result = await pending;
      assert.equal(result.totalBytes, delivered);
      assert.equal(result.totalBytes, 1200, 'the event block is reported in full; received overshoot is not hidden');
      assert.equal(result.budgetOvershootBytes, 200);
      assert.equal(result.completionReason, 'budget');
      assert.equal(result.durationMs, warmupMs ? 0 : 100);
      assert.equal(result.complete, warmupMs === 0);
      assert.equal(result.mbps, warmupMs ? null : .096);
      assert.equal(result.incompleteReason, warmupMs ? 'budget-before-measurement' : null);
      assert.equal(result.failedRequests, 0);
      if (transport === 'websocket') assert.ok(ws.sockets.every(socket => socket.readyState === 3));
      else assert.equal(cancelled, true);
    });
  }
}

for (const transport of ['http', 'websocket']) {
  for (const policy of ['fixed', 'adaptive']) {
    test(`${transport} ${policy} uses real stable windows and preserves the chosen measurement deadline`, async t => {
      mockTime(t);
      const normalized = transport === 'websocket' ? websocketConfig() : normalizeConfig(config());
      let delivered = 0;
      const ws = fakeWebSockets(socket => {
        const timer = setInterval(() => { delivered += 1000; socket.message(new ArrayBuffer(1000)); }, 100);
        const originalClose = socket.close;
        socket.close = function (...args) { clearInterval(timer); return originalClose.apply(this, args); };
      });
      const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory,
        fetchImpl: async (url, options) => {
          if (new URL(url).pathname !== '/api/download') return new Response('{}');
          return new Response(new ReadableStream({ start(controller) {
            const timer = setInterval(() => { delivered += 1000; controller.enqueue(new Uint8Array(1000)); }, 100);
            options.signal.addEventListener('abort', () => { clearInterval(timer); controller.error(options.signal.reason); }, { once: true });
          } }));
        },
      });
      const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 0, downloadDurationMs: 10000 }, normalized.performance,
        { mode: 'manual', streams: 1, measurementPolicy: policy }, { medianMs: 0 }, new AbortController().signal);
      let completed = false;
      pending.then(() => { completed = true; });
      await setImmediate();
      for (let elapsed = 0; elapsed < 5000; elapsed += 200) await advance(t, 200);
      assert.equal(completed, policy === 'adaptive');
      if (policy === 'fixed') for (let elapsed = 5000; elapsed < 10000; elapsed += 200) await advance(t, 200);
      const result = await pending;
      assert.equal(result.completionReason, policy === 'adaptive' ? 'stable' : 'duration');
      assert.equal(result.durationMs, policy === 'adaptive' ? 5000 : 10000);
      assert.equal(result.mbps, toMbps(result.measuredBytes, result.durationMs));
      assert.equal(result.totalBytes, delivered - (transport === 'http' ? 1000 : 0), 'a stream chunk still queued at cutoff is not received until read() delivers it');
      assert.equal(result.complete, true);
      assert.equal(result.failedRequests, 0);
    });
  }
}

test('a falling transfer does not get an early stable result at the minimum deadline', async t => {
  mockTime(t);
  const began = Date.now();
  const normalized = websocketConfig();
  const ws = fakeWebSockets(socket => {
    const timer = setInterval(() => socket.message(new ArrayBuffer(Date.now() - began < 4500 ? 1000 : 400)), 100);
    const originalClose = socket.close;
    socket.close = function (...args) { clearInterval(timer); return originalClose.apply(this, args); };
  });
  const controller = new AbortController();
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory, fetchImpl: async () => new Response('{}') });
  const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 0, downloadDurationMs: 10000 }, normalized.performance,
    { mode: 'manual', streams: 1, measurementPolicy: 'adaptive' }, { medianMs: 0 }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  for (let elapsed = 0; elapsed < 6000; elapsed += 200) await advance(t, 200);
  assert.equal(ws.sockets[0].readyState, 1, 'the recent throughput drop prevents early completion at five seconds');
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await rejected;
  assert.equal(ws.sockets.every(socket => socket.readyState === 3), true);
});

for (const transport of ['http', 'websocket']) {
  test(`${transport} adaptive upload freezes server counts before closing queues and honors a racing budget`, async t => {
    mockTime(t);
    const began = Date.now();
    const ws = fakeWebSockets();
    const normalized = transport === 'websocket' ? websocketConfig() : normalizeConfig(config());
    let finishCalls = 0;
    let deleted = false;
    let frozen = null;
    const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory, taskYield: () => setImmediate(),
      fetchImpl: async (url, options) => {
        const address = new URL(url);
        if (address.pathname === '/api/upload-sessions') {
          assert.equal(JSON.parse(options.body).maxBytes, 1_000_000);
          return new Response('{"id":"adaptive-upload"}', { status: 201 });
        }
        if (address.pathname === '/api/upload') return abortablePending(options.signal);
        if (address.pathname === '/api/upload-sessions/adaptive-upload/finish') {
          assert.deepEqual(JSON.parse(options.body), { reason: 'stable' });
          finishCalls += 1;
          // This additional 37 ms/received bytes belongs to the server's
          // frozen window, never the preceding poll or queued browser data.
          frozen = { measuredBytes: 5037 * 125, totalBytes: 5037 * 125, measurementElapsedMs: 5037, finished: true,
            completionReason: transport === 'http' ? 'stable' : 'budget' };
          return new Response(JSON.stringify(frozen));
        }
        if (address.pathname === '/api/upload-sessions/adaptive-upload' && options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
        if (address.pathname === '/api/upload-sessions/adaptive-upload') {
          const elapsed = Date.now() - began;
          return new Response(JSON.stringify(frozen || { measuredBytes: elapsed * 125, totalBytes: elapsed * 125, measurementElapsedMs: elapsed, finished: false }));
        }
        return new Response('{}');
      },
    });
    const pending = engine.uploadPhase(node, { ...normalized.test, warmupMs: 0, uploadDurationMs: 10000 }, { ...normalized.performance, uploadBlockBytes: 65536 },
      { mode: 'manual', streams: 1, measurementPolicy: 'adaptive', maxBytes: 1_000_000 }, { medianMs: 0 }, new AbortController().signal);
    await setImmediate();
    for (let elapsed = 0; elapsed < 5000; elapsed += 200) await advance(t, 200);
    const result = await pending;
    assert.equal(finishCalls, 1);
    assert.equal(result.measuredBytes, 629625);
    assert.equal(result.durationMs, 5037);
    assert.equal(result.mbps, 1);
    assert.equal(result.completionReason, transport === 'http' ? 'stable' : 'budget');
    assert.equal(result.failedRequests, 0);
    assert.equal(deleted, true);
    assert.ok(ws.sockets.every(socket => socket.readyState === 3));
  });
}

test('adaptive download waits for eight RTTs of actual measurement after the RTT-aware warm-up', async t => {
  mockTime(t);
  const normalized = websocketConfig();
  const ws = fakeWebSockets(socket => {
    const timer = setInterval(() => socket.message(new ArrayBuffer(1000)), 100);
    const originalClose = socket.close;
    socket.close = function (...args) { clearInterval(timer); return originalClose.apply(this, args); };
  });
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory, fetchImpl: async () => new Response('{}') });
  const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 0, downloadDurationMs: 10000 }, normalized.performance,
    { mode: 'manual', streams: 1, measurementPolicy: 'adaptive' }, { medianMs: 750 }, new AbortController().signal);
  await setImmediate();
  for (let elapsed = 0; elapsed < 11000; elapsed += 200) await advance(t, 200);
  assert.equal(ws.sockets[0].readyState, 1, 'five measured seconds cannot truncate a 750 ms RTT link');
  for (let elapsed = 11000; elapsed < 12000; elapsed += 200) await advance(t, 200);
  const result = await pending;
  assert.equal(result.warmupMs, 6000);
  assert.equal(result.durationMs, 6000);
  assert.equal(result.completionReason, 'stable');
  assert.equal(result.mbps, toMbps(result.measuredBytes, 6000));
});

test('a recovered real socket failure remains visible and prevents an adaptive success from shortening the window', async t => {
  mockTime(t);
  const normalized = websocketConfig();
  const ws = fakeWebSockets(socket => {
    const timer = setInterval(() => socket.message(new ArrayBuffer(1000)), 100);
    const originalClose = socket.close;
    socket.close = function (...args) { clearInterval(timer); return originalClose.apply(this, args); };
    if (ws.sockets.indexOf(socket) === 0) setTimeout(() => { clearInterval(timer); socket.serverClose(1006, 'network_failed'); }, 500);
  });
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory, fetchImpl: async () => new Response('{}') });
  const pending = engine.downloadPhase(node, { ...normalized.test, warmupMs: 0, downloadDurationMs: 10000 }, normalized.performance,
    { mode: 'manual', streams: 1, measurementPolicy: 'adaptive' }, { medianMs: 0 }, new AbortController().signal);
  await setImmediate();
  for (let elapsed = 0; elapsed < 6000; elapsed += 200) await advance(t, 200);
  assert.equal(ws.sockets.length, 2);
  assert.equal(ws.sockets[1].readyState, 1, 'a successful retry cannot conceal the failed request or claim early stability');
  for (let elapsed = 6000; elapsed < 10000; elapsed += 200) await advance(t, 200);
  const result = await pending;
  assert.equal(result.failedRequests, 1);
  assert.equal(result.durationMs, 10000);
  assert.equal(result.completionReason, 'duration');
});

for (const transport of ['http', 'websocket']) {
  test(`${transport} upload budget can honestly finish during warm-up without counting browser queues as a zero-Mbps result`, async t => {
    mockTime(t);
    const began = Date.now();
    const ws = fakeWebSockets();
    const normalized = transport === 'websocket' ? websocketConfig() : normalizeConfig(config());
    let deleted = false;
    const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), webSocketFactory: ws.factory, taskYield: () => setImmediate(),
      fetchImpl: async (url, options) => {
        const address = new URL(url);
        if (address.pathname === '/api/upload-sessions') {
          assert.equal(JSON.parse(options.body).maxBytes, 1000);
          return new Response('{"id":"budget-upload"}', { status: 201 });
        }
        if (address.pathname === '/api/upload') {
          assert.equal(options.body.size, 1000, 'a small budget must not enqueue a giant HTTP Blob');
          return abortablePending(options.signal);
        }
        if (address.pathname === '/api/upload-sessions/budget-upload' && options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
        if (address.pathname === '/api/upload-sessions/budget-upload') {
          const finished = Date.now() - began >= 200;
          return new Response(JSON.stringify({ measuredBytes: 0, totalBytes: finished ? 1000 : 0, measurementElapsedMs: 0, finished,
            completionReason: finished ? 'budget' : '' }));
        }
        return new Response('{}');
      },
    });
    const pending = engine.uploadPhase(node, { ...normalized.test, warmupMs: 500, uploadDurationMs: 10000 }, normalized.performance,
      { mode: 'manual', streams: 1, maxBytes: 1000 }, { medianMs: 0 }, new AbortController().signal);
    await setImmediate();
    await advance(t, 100);
    assert.ok(ws.sockets.every(socket => socket.bufferedAmount <= 1000));
    await advance(t, 100);
    const result = await pending;
    assert.equal(result.mbps, null);
    assert.equal(result.complete, false);
    assert.equal(result.incompleteReason, 'budget-before-measurement');
    assert.equal(result.completionReason, 'budget');
    assert.equal(result.measuredBytes, 0);
    assert.equal(result.totalBytes, 1000);
    assert.equal(result.durationMs, 0);
    assert.equal(result.failedRequests, 0);
    assert.equal(deleted, true);
  });
}

test('HTTP cleanup waits for observed proxy release without changing its measured window or inventing connections', async t => {
  mockTime(t);
  const began = Date.now();
  let cancelledAt = null;
  const cleanupPolls = [];
  const engine = new MeasurementEngine({ clock: () => Date.now(), randomFill: bytes => bytes.fill(1), fetchImpl: async (url, options) => {
    const address = new URL(url);
    if (address.pathname === '/api/connection-stats') {
      if (cancelledAt !== null) cleanupPolls.push(Date.now() - began);
      const released = cancelledAt !== null && Date.now() - cancelledAt >= 50;
      return new Response(JSON.stringify({ activeRequests: released ? 0 : 1, activeTcpConnections: released ? 0 : 1,
        connectionsObserved: 1, peakTcpConnections: 1, protocols: ['HTTP/1.1'], scope: 'server' }));
    }
    if (address.pathname !== '/api/download') return new Response('{}');
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => controller.enqueue(new Uint8Array(1000)), 70);
      options.signal.addEventListener('abort', () => { cancelledAt = Date.now(); clearTimeout(timer); controller.error(options.signal.reason); }, { once: true });
    } }));
  } });
  const settings = phaseConfiguration();
  const pending = engine.downloadPhase(node, { ...settings.test, warmupMs: 50, downloadDurationMs: 100 }, settings.performance,
    settings.options, settings.idle, new AbortController().signal);
  await setImmediate();
  await advance(t, 70);
  await advance(t, 80);
  assert.deepEqual(cleanupPolls, [150]);
  await advance(t, 180);
  const result = await pending;
  assert.deepEqual(cleanupPolls, [150, 330]);
  assert.equal(result.connections.active, 0);
  assert.equal(result.connections.observed, 1);
  assert.equal(result.connections.peak, 1);
  assert.equal(result.measuredBytes, 1000);
  assert.equal(result.totalBytes, 1000);
  assert.equal(result.durationMs, 100);
  assert.equal(result.mbps, .08);
  assert.equal(result.failedRequests, 0);
});

test('HTTP cleanup keeps real nonzero counts when its bounded six polls cannot prove release', async t => {
  mockTime(t);
  let calls = 0;
  const engine = new MeasurementEngine({ clock: () => Date.now(), fetchImpl: async () => {
    calls += 1;
    return new Response('{"activeRequests":4,"activeTcpConnections":4,"peakTcpConnections":4,"connectionsObserved":4}');
  } });
  const began = Date.now();
  const pending = engine.settleHTTPDownloadConnections(node, 'run', new AbortController().signal);
  await setImmediate();
  for (let index = 0; index < 5; index += 1) await advance(t, 180);
  const snapshot = await pending;
  assert.equal(calls, 6, 'diagnostics cannot issue an unbounded polling loop');
  assert.equal(Date.now() - began, 900);
  assert.equal(snapshot.activeTcpConnections, 4, 'failure to prove release must never become a fabricated zero');
});

test('a black-holed HTTP cleanup diagnostic stops at one second and reports its timeout', async t => {
  mockTime(t);
  let signal;
  const engine = new MeasurementEngine({ clock: () => Date.now(), fetchImpl: (_, options) => { signal = options.signal; return abortablePending(options.signal); } });
  const pending = engine.settleHTTPDownloadConnections(node, 'run', new AbortController().signal);
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await advance(t, 999);
  assert.equal(signal.aborted, false);
  await advance(t, 1);
  await rejected;
});
