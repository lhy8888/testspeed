import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { chooseConcurrencyTarget, createUploadBody, estimateBDPBytes, latencyStatistics, loadConfig, MeasurementEngine, normalizeConfig, normalizeOptions, SpeedTest, toMbps } from '../web/speedtest.js';

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
