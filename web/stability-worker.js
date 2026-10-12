// Independent HTTP stability measurements. No throughput traffic or external node.
export const MAX_STABILITY_SAMPLES = 2000;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value, fallback, min, max) => Math.round(Math.min(max, Math.max(min, finite(value, fallback))));

export function normalizeStabilityConfig(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  return Object.freeze({
    durationMs: bounded(input.durationMs, 60000, 1000, 300000),
    intervalMs: bounded(input.intervalMs, 250, 200, 5000),
    timeoutMs: bounded(input.timeoutMs, 5000, 200, 5000),
  });
}

// Percentiles use interpolation between observed values, including small samples.
export function summarizeStabilitySamples(samples) {
  const successful = samples.filter(sample => sample.ok && Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0);
  const values = successful.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const percentile = fraction => {
    if (!values.length) return null;
    const rank = (values.length - 1) * fraction;
    const below = Math.floor(rank);
    return values[below] + (values[Math.ceil(rank)] - values[below]) * (rank - below);
  };
  let jitterSum = 0;
  let adjacent = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (previous.ok && current.ok && Number.isFinite(previous.latencyMs) && Number.isFinite(current.latencyMs)) {
      jitterSum += Math.abs(current.latencyMs - previous.latencyMs);
      adjacent += 1;
    }
  }
  const last = samples.at(-1);
  return {
    requests: samples.length, successes: values.length, failures: samples.length - values.length,
    failurePercent: samples.length ? (samples.length - values.length) * 100 / samples.length : null,
    currentMs: last?.ok && Number.isFinite(last.latencyMs) ? last.latencyMs : null,
    minimumMs: values.length ? values[0] : null, maximumMs: values.length ? values.at(-1) : null,
    averageMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    jitterMs: adjacent ? jitterSum / adjacent : null,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  // Every field is quoted; spreadsheet formula prefixes are neutralised too.
  return `"${(/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
}

export function stabilityCSV(samples) {
  const rows = [['timestamp_utc', 'elapsed_ms', 'latency_ms', 'success', 'reason']];
  for (const sample of samples.slice(0, MAX_STABILITY_SAMPLES)) {
    rows.push([
      sample.timestamp, Number.isFinite(sample.elapsedMs) ? sample.elapsedMs.toFixed(3) : '',
      sample.ok && Number.isFinite(sample.latencyMs) ? sample.latencyMs.toFixed(3) : '',
      sample.ok ? 'true' : 'false', sample.reason || '',
    ]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export class StabilityRunner {
  constructor(config, environment = {}) {
    this.config = normalizeStabilityConfig(config);
    this.fetch = environment.fetch || globalThis.fetch.bind(globalThis);
    this.now = environment.now || (() => performance.now());
    this.timestamp = environment.timestamp || (() => new Date().toISOString());
    this.setTimeout = environment.setTimeout || globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = environment.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    this.post = environment.post || (() => {});
    this.samples = [];
    this.pending = [];
    this.running = false;
    this.stoppedReason = null;
    this.requestController = null;
    this.waitTimer = null;
    this.requestTimer = null;
    this.publishTimer = null;
    this.wake = null;
    this.lastPublication = -Infinity;
  }

  snapshot(type = 'update', reason = '') {
    const now = this.now();
    const elapsedMs = Math.min(this.config.durationMs, Math.max(0, now - this.startedAt));
    const message = {
      type, reason, elapsedMs, remainingMs: Math.max(0, this.config.durationMs - elapsedMs),
      config: this.config, samples: this.pending.splice(0), metrics: summarizeStabilitySamples(this.samples),
    };
    this.lastPublication = now;
    this.post(message);
  }

  publish() {
    // Progress deltas are capped at 5 Hz. Completion separately flushes pending
    // real samples immediately so cancellation never leaves a timer behind.
    const remaining = 200 - (this.now() - this.lastPublication);
    if (remaining <= 0) {
      if (this.publishTimer !== null) this.clearTimeout(this.publishTimer);
      this.publishTimer = null;
      this.snapshot();
    } else if (this.publishTimer === null) {
      this.publishTimer = this.setTimeout(() => {
        this.publishTimer = null;
        if (this.running) this.snapshot();
      }, Math.ceil(remaining));
    }
  }

  async sleep(delay) {
    if (!this.running || delay <= 0) return;
    await new Promise(resolve => {
      this.wake = resolve;
      this.waitTimer = this.setTimeout(() => {
        this.waitTimer = null;
        this.wake = null;
        resolve();
      }, Math.ceil(delay));
    });
  }

  stop(reason = 'stopped') {
    if (!this.running) return;
    this.stoppedReason = ['stopped', 'hidden', 'offline', 'pagehide'].includes(reason) ? reason : 'stopped';
    this.running = false;
    this.requestController?.abort();
    for (const key of ['waitTimer', 'requestTimer', 'publishTimer']) {
      if (this[key] !== null) this.clearTimeout(this[key]);
      this[key] = null;
    }
    this.wake?.();
    this.wake = null;
  }

  async start() {
    if (this.running || this.startedAt !== undefined) throw new Error('A stability runner can only start once.');
    this.running = true;
    this.startedAt = this.now();
    this.snapshot('started');
    try {
      while (this.running && this.now() - this.startedAt < this.config.durationMs && this.samples.length < MAX_STABILITY_SAMPLES) {
        const requestStartedAt = this.now();
        const remaining = this.config.durationMs - (requestStartedAt - this.startedAt);
        const timeout = Math.min(this.config.timeoutMs, remaining);
        const controller = new AbortController();
        this.requestController = controller;
        let timeoutReason = '';
        this.requestTimer = this.setTimeout(() => {
          timeoutReason = remaining <= this.config.timeoutMs ? 'duration' : 'timeout';
          controller.abort();
        }, Math.ceil(timeout));
        const sample = { timestamp: this.timestamp(), elapsedMs: requestStartedAt - this.startedAt, latencyMs: null, ok: false, reason: '' };
        try {
          // Nonce and no-store prevent both browser and intermediary cache hits.
          const response = await this.fetch(`/api/ping?stability=${encodeURIComponent(sample.timestamp)}-${this.samples.length}`, {
            method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
          }
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            let bytes = 0;
            try {
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > 4096) {
                  await reader.cancel();
                  throw new Error('response-too-large');
                }
              }
            } finally { reader.releaseLock(); }
          } else {
            const body = await response.arrayBuffer();
            if (body.byteLength > 4096) throw new Error('response-too-large');
          }
          sample.latencyMs = Math.max(0, this.now() - requestStartedAt);
          sample.ok = true;
        } catch (error) {
          sample.reason = timeoutReason || (/^HTTP \d{3}$/.test(error?.message) ? error.message : error?.message === 'response-too-large' ? 'response-too-large' : 'network-error');
        } finally {
          if (this.requestTimer !== null) this.clearTimeout(this.requestTimer);
          this.requestTimer = null;
          this.requestController = null;
        }
        // Stopping or reaching the duration never invents a failed request.
        if (!this.running || timeoutReason === 'duration') break;
        this.samples.push(sample);
        this.pending.push(sample);
        this.publish();
        const delay = Math.min(
          Math.max(0, this.config.intervalMs - (this.now() - requestStartedAt)),
          Math.max(0, this.config.durationMs - (this.now() - this.startedAt)),
        );
        await this.sleep(delay);
      }
    } finally {
      this.running = false;
      for (const key of ['waitTimer', 'requestTimer', 'publishTimer']) {
        if (this[key] !== null) this.clearTimeout(this[key]);
        this[key] = null;
      }
      this.snapshot('complete', this.stoppedReason || 'duration');
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let runner = null;
  globalThis.onmessage = ({ data }) => {
    if (data?.type === 'start' && !runner?.running) {
      runner = new StabilityRunner(data.config, { post: message => globalThis.postMessage(message) });
      runner.start().catch(() => globalThis.postMessage({ type: 'error', reason: 'worker-error' }));
    } else if (data?.type === 'stop') runner?.stop(data.reason);
  };
}
