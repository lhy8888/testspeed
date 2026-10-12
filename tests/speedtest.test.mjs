import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { chooseConcurrencyTarget, chooseWebSocketMessageBytes, createUploadBody, estimateBDPBytes, latencyStatistics, loadConfig, MeasurementEngine, normalizeConfig, normalizeOptions, SpeedTest, toMbps } from '../web/speedtest.js';

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

function fakeWebSockets(onReady = () => {}, { closeWaitsForServer = false, readyMessage } = {}) {
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
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.message(JSON.stringify(readyMessage || { type: 'ready', connectionId: `tcp-${sockets.indexOf(socket)}`, protocol: 'HTTP/1.1' }));
      onReady(socket, new URL(url));
    });
    return socket;
  };
  return { sockets, factory };
}

test('single-port WebSocket defaults to eight fixed streams and supports thirty independently of HTTP pools', () => {
  const normalized = websocketConfig();
  assert.equal(normalized.performance.transport, 'websocket');
  assert.equal(normalized.performance.maxStreams, 30);
  assert.equal(normalized.test.minStreams, 8);
  assert.deepEqual(normalizeOptions(normalized), { mode: 'manual', streams: 8, durationMs: undefined, warmupOverride: undefined });
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
