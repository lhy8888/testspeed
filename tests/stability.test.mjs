import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_STABILITY_SAMPLES, normalizeStabilityConfig, StabilityRunner, stabilityCSV, summarizeStabilitySamples } from '../web/stability-worker.js';

class Clock {
  nowMs = 0;
  timers = new Map();
  nextTimer = 1;
  setTimeout = (callback, delay) => {
    const id = this.nextTimer++;
    this.timers.set(id, { callback, due: this.nowMs + Math.max(0, delay) });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async flush() { for (let i = 0; i < 24; i += 1) await Promise.resolve(); }
  async advance(ms) {
    const until = this.nowMs + ms;
    await this.flush();
    let guard = 0;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(guard++ < 10000, 'clock callbacks must be bounded');
      this.nowMs = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
      await this.flush();
    }
    this.nowMs = until;
    await this.flush();
  }
}

function fixture(config, responses) {
  const clock = new Clock();
  const requests = [];
  const posts = [];
  let active = 0;
  let peak = 0;
  const runner = new StabilityRunner(config, {
    now: () => clock.nowMs,
    timestamp: () => new Date(Date.UTC(2026, 9, 12) + clock.nowMs).toISOString(),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    post: message => posts.push({ ...message, postedAt: clock.nowMs }),
    fetch: (url, options) => new Promise((resolve, reject) => {
      const response = responses[requests.length] || { delay: 10 };
      const request = { url, options, startedAt: clock.nowMs, aborted: false };
      requests.push(request);
      active += 1;
      peak = Math.max(peak, active);
      let timer = null;
      let settled = false;
      const settle = callback => {
        if (settled) return;
        settled = true;
        active -= 1;
        if (timer !== null) clock.clearTimeout(timer);
        callback();
      };
      options.signal.addEventListener('abort', () => {
        request.aborted = true;
        settle(() => reject(new DOMException('Aborted', 'AbortError')));
      }, { once: true });
      if (response.delay !== Infinity) timer = clock.setTimeout(() => settle(() => {
        if (response.error) reject(new Error(response.error));
        else resolve(new Response(response.body || '{}', { status: response.status || 200 }));
      }), response.delay);
    }),
  });
  return { runner, clock, requests, posts, peak: () => peak, active: () => active };
}

test('stability configuration has finite duration, spacing and timeout bounds', () => {
  assert.deepEqual(normalizeStabilityConfig(), { durationMs: 60000, intervalMs: 250, timeoutMs: 5000 });
  assert.deepEqual(normalizeStabilityConfig(null), normalizeStabilityConfig());
  assert.deepEqual(normalizeStabilityConfig({ durationMs: Infinity, intervalMs: NaN, timeoutMs: 'bad' }), normalizeStabilityConfig());
  assert.deepEqual(normalizeStabilityConfig({ durationMs: 10 ** 9, intervalMs: 1, timeoutMs: 10 ** 9 }), { durationMs: 300000, intervalMs: 200, timeoutMs: 5000 });
  assert.deepEqual(normalizeStabilityConfig({ durationMs: -1, intervalMs: 10 ** 9, timeoutMs: -1 }), { durationMs: 1000, intervalMs: 5000, timeoutMs: 200 });
  assert.ok(300000 / 200 < MAX_STABILITY_SAMPLES, 'duration and spacing keep all result samples within the chart bound');
});

test('real sample percentiles exclude failures and jitter never bridges a failed request', () => {
  const metrics = summarizeStabilitySamples([
    { ok: true, latencyMs: 100 }, { ok: true, latencyMs: 200 },
    { ok: false, latencyMs: null }, { ok: true, latencyMs: 500 },
  ]);
  assert.equal(metrics.failurePercent, 25);
  assert.equal(metrics.requests, 4);
  assert.equal(metrics.currentMs, 500);
  assert.equal(metrics.averageMs, 800 / 3);
  assert.equal(metrics.jitterMs, 100);
  assert.equal(metrics.p50Ms, 200);
  assert.equal(metrics.p95Ms, 470);
  assert.equal(metrics.p99Ms, 494);
  assert.equal(metrics.minimumMs, 100);
  assert.equal(metrics.maximumMs, 500);
});

test('empty and failed-only tests do not manufacture zero latency', () => {
  const empty = summarizeStabilitySamples([]);
  for (const field of ['currentMs', 'minimumMs', 'maximumMs', 'averageMs', 'p50Ms', 'p95Ms', 'p99Ms', 'jitterMs', 'failurePercent']) assert.equal(empty[field], null);
  const failed = summarizeStabilitySamples([{ ok: false, reason: 'HTTP 503', latencyMs: null }]);
  assert.equal(failed.failurePercent, 100);
  for (const field of ['currentMs', 'minimumMs', 'maximumMs', 'averageMs', 'p50Ms', 'p95Ms', 'p99Ms', 'jitterMs']) assert.equal(failed[field], null);
});

test('sequential real responses determine latency, HTTP failures, fixed spacing and bounded updates', async () => {
  const f = fixture({ durationMs: 1000 }, [{ delay: 10 }, { delay: 30 }, { delay: 20, status: 503 }, { delay: 50 }]);
  const done = f.runner.start();
  await f.clock.advance(1000);
  await done;
  assert.deepEqual(f.requests.map(request => request.startedAt), [0, 250, 500, 750]);
  assert.equal(f.peak(), 1);
  assert.equal(f.active(), 0);
  assert.deepEqual(f.runner.samples.map(sample => [sample.ok, sample.latencyMs, sample.reason]), [[true, 10, ''], [true, 30, ''], [false, null, 'HTTP 503'], [true, 50, '']]);
  assert.equal(f.posts.at(-1).metrics.failurePercent, 25);
  assert.equal(f.posts.at(-1).metrics.p50Ms, 30);
  assert.equal(f.posts.at(-1).metrics.jitterMs, 20);
  assert.equal(f.posts.at(-1).reason, 'duration');
  assert.equal(f.clock.timers.size, 0);
  const updates = f.posts.filter(post => post.type === 'update');
  for (let i = 1; i < updates.length; i += 1) assert.ok(updates[i].postedAt - updates[i - 1].postedAt >= 200);
  assert.equal(f.posts.flatMap(post => post.samples).length, 4, 'delta messages do not duplicate samples');
  for (const request of f.requests) {
    assert.match(request.url, /^\/api\/ping\?stability=/);
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.method, 'GET');
  }
});

test('a genuine timeout is recorded while duration cancellation is not a failure', async () => {
  const f = fixture({ durationMs: 1000, timeoutMs: 200 }, [{ delay: Infinity }, { delay: 20 }, { delay: 20 }, { delay: Infinity }]);
  const done = f.runner.start();
  await f.clock.advance(1000);
  await done;
  assert.equal(f.requests[0].aborted, true);
  assert.equal(f.requests[3].aborted, true);
  assert.equal(f.runner.samples[0].reason, 'timeout');
  assert.equal(f.runner.samples[3].reason, 'timeout');
  assert.equal(f.posts.at(-1).metrics.failures, 2);
  assert.equal(f.clock.timers.size, 0);
  const pending = fixture({ durationMs: 1000 }, [{ delay: Infinity }]);
  const pendingDone = pending.runner.start();
  await pending.clock.advance(1000);
  await pendingDone;
  assert.equal(pending.requests.length, 1);
  assert.equal(pending.requests[0].aborted, true);
  assert.equal(pending.runner.samples.length, 0);
  assert.equal(pending.posts.at(-1).metrics.failurePercent, null);
  assert.equal(pending.clock.timers.size, 0);
});

test('stop, hidden and offline abort active requests immediately with no additional traffic', async () => {
  for (const reason of ['stopped', 'hidden', 'offline', 'pagehide']) {
    const f = fixture({ durationMs: 1000 }, [{ delay: 10 }, { delay: Infinity }]);
    const done = f.runner.start();
    await f.clock.advance(260);
    f.runner.stop(reason);
    await f.clock.flush();
    await done;
    assert.equal(f.requests[1].aborted, true);
    assert.equal(f.runner.samples.length, 1);
    assert.equal(f.posts.at(-1).reason, reason);
    assert.equal(f.posts.at(-1).metrics.failurePercent, 0);
    assert.equal(f.active(), 0);
    assert.equal(f.clock.timers.size, 0);
    await f.clock.advance(10000);
    assert.equal(f.requests.length, 2);
  }
});

test('stopping between requests clears waiting and publication timers and preserves actual samples', async () => {
  const f = fixture({ durationMs: 1000 }, [{ delay: 10 }]);
  const done = f.runner.start();
  await f.clock.advance(25);
  f.runner.stop();
  await f.clock.flush();
  await done;
  assert.equal(f.requests.length, 1);
  assert.equal(f.runner.samples[0].latencyMs, 10);
  assert.equal(f.posts.at(-1).samples.length, 1, 'the final publication flushes any pending true response');
  assert.equal(f.clock.timers.size, 0);
});

test('slow responses never overlap or cause a backlog of extra requests', async () => {
  const f = fixture({ durationMs: 1000, intervalMs: 200 }, [{ delay: 450 }, { delay: 450 }, { delay: 450 }]);
  const done = f.runner.start();
  await f.clock.advance(1000);
  await done;
  assert.deepEqual(f.requests.map(request => request.startedAt), [0, 450, 900]);
  assert.equal(f.runner.samples.length, 2);
  assert.equal(f.requests[2].aborted, true);
  assert.equal(f.peak(), 1);
  assert.equal(f.clock.timers.size, 0);
});

test('unexpected large ping responses fail without counting their body as latency', async () => {
  const f = fixture({ durationMs: 1000, intervalMs: 5000 }, [{ delay: 5, body: 'x'.repeat(4097) }]);
  const done = f.runner.start();
  await f.clock.advance(1000);
  await done;
  assert.equal(f.runner.samples.length, 1);
  assert.equal(f.runner.samples[0].reason, 'response-too-large');
  assert.equal(f.runner.samples[0].latencyMs, null);
});

test('CSV preserves real UTC timestamps, blanks failed latency, escapes fields and bounds output', () => {
  const csv = stabilityCSV([
    { timestamp: '2026-10-12T12:00:00.000Z', elapsedMs: 0, latencyMs: 12.3456, ok: true, reason: '' },
    { timestamp: '2026-10-12T12:00:00.250Z', elapsedMs: 250, latencyMs: null, ok: false, reason: 'HTTP 503' },
    { timestamp: 'a"b\nc', elapsedMs: 500, latencyMs: NaN, ok: false, reason: '=malicious()' },
  ]);
  assert.ok(csv.startsWith('"timestamp_utc","elapsed_ms","latency_ms","success","reason"\r\n'));
  assert.ok(csv.includes('"2026-10-12T12:00:00.000Z","0.000","12.346","true",""\r\n'));
  assert.ok(csv.includes('"250.000","","false","HTTP 503"'));
  assert.ok(csv.includes('"a""b\nc"'));
  assert.ok(csv.includes('"\'=malicious()"'));
  const bounded = stabilityCSV(Array.from({ length: MAX_STABILITY_SAMPLES + 1 }, (_, elapsedMs) => ({ timestamp: 'x', elapsedMs, ok: false })));
  assert.equal(bounded.split('\r\n').length, MAX_STABILITY_SAMPLES + 2);
});
