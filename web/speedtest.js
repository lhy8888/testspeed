const MIB = 1024 * 1024;
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const abortError = (message = "测速已停止") => new DOMException(message, "AbortError");

function safeBaseURL(value, page) {
  const url = new URL(value || "/", page);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || (page.protocol === "https:" && url.protocol !== "https:")) {
    throw new Error("测速节点地址不受支持，请使用安全的 HTTP 或 HTTPS 地址。");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function normalizeConfig(config, pageURL = globalThis.location?.href || "http://localhost/") {
  if (config?.protocolVersion !== 2 || !Array.isArray(config.nodes) || !config.nodes.length) throw new Error("测速服务配置无效，请更新服务端与页面后重试。");
  const page = new URL(pageURL);
  const nodes = config.nodes.map((node) => {
    if (!node || typeof node.id !== "string" || typeof node.name !== "string") throw new Error("测速节点配置无效。");
    return { id: node.id, name: node.name, baseUrl: safeBaseURL(node.baseUrl, page) };
  });
  const raw = config.performance || {};
  const configuredOrigins = raw.measurementOrigins?.length ? raw.measurementOrigins : [nodes[0].baseUrl];
  if (!Array.isArray(configuredOrigins)) throw new Error("测速连接地址配置无效。");
  const originMap = new Map();
  for (const value of configuredOrigins) {
    const base = safeBaseURL(value, page);
    if (!originMap.has(new URL(base).origin)) originMap.set(new URL(base).origin, base);
  }
  const origins = [...originMap.values()];
  if (origins.length > 8) throw new Error("测速连接地址过多，请检查服务配置。");
  const controlOrigin = new URL(nodes[0].baseUrl).origin;
  const originSlots = [];
  for (let round = 0; round < 6; round += 1) {
    for (const origin of origins) {
      if (round < (new URL(origin).origin === controlOrigin ? 4 : 6)) originSlots.push(origin);
    }
  }
  const capacity = originSlots.length;
  const maxStreams = Math.min(bounded(raw.maxStreams, 24, 1, 48), capacity);
  const performanceConfig = {
    measurementOrigins: origins, originSlots, maxStreams, defaultMode: raw.defaultMode === "manual" ? "manual" : "auto",
    downloadBlockBytes: 25 * MIB, uploadBlockBytes: 25 * MIB,
    maxUploadBodyBytes: bounded(raw.maxUploadBodyBytes, 1024 * MIB, 25 * MIB, 1024 * MIB),
    sharedControlOrigin: origins.some((value) => new URL(value).origin === controlOrigin),
  };
  const input = config.test || {};
  const test = {
    downloadDurationMs: bounded(input.downloadDurationMs, 10000, 500, 60000),
    uploadDurationMs: bounded(input.uploadDurationMs, 10000, 500, 60000),
    warmupMs: bounded(input.warmupMs, 1500, 0, 10000),
    minStreams: bounded(input.minStreams, 2, 1, maxStreams), maxStreams,
    pingSamples: bounded(input.pingSamples, 8, 1, 20),
  };
  nodes[0].dataOrigins = origins;
  return { protocolVersion: 2, nodes, test, performance: performanceConfig, features: config.features || {} };
}

export function normalizeOptions(config, options = {}) {
  const mode = options.mode || config.performance.defaultMode;
  if (mode !== "auto" && mode !== "manual") throw new Error("请选择自动或手动并发模式。");
  const streams = options.streams ?? config.test.minStreams;
  if (!Number.isInteger(streams) || streams < 1 || streams > config.performance.maxStreams) throw new Error(`当前部署支持 1 至 ${config.performance.maxStreams} 条并行传输。`);
  if (options.durationMs !== undefined && (!Number.isInteger(options.durationMs) || options.durationMs < 10000 || options.durationMs > 60000)) throw new Error("测量时间应为 10 至 60 秒。");
  if (options.warmupOverride !== undefined && (!Number.isFinite(options.warmupOverride) || options.warmupOverride < 0 || options.warmupOverride > 10000)) throw new Error("预热时间应为 0 至 10 秒。");
  return { mode, streams, durationMs: options.durationMs, warmupOverride: options.warmupOverride };
}

export function toMbps(bytes, elapsedMs) { return elapsedMs > 0 ? bytes * 8 / elapsedMs / 1000 : 0; }
export function estimateBDPBytes(mbps, rttMs) { return Math.max(0, mbps) * 1000 * Math.max(0, rttMs) / 8; }

export function latencyStatistics(values, failed = 0) {
  const samples = values.filter((value) => Number.isFinite(value) && value >= 0);
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null;
  const jitterMs = samples.length > 1 ? samples.slice(1).reduce((sum, value, index) => sum + Math.abs(value - samples[index]), 0) / (samples.length - 1) : null;
  return { medianMs, jitterMs, samples: samples.length, failed, attempts: samples.length + failed };
}

export function chooseConcurrencyTarget(current, previousRate, currentRate, maxStreams, previousStreams = Math.max(1, Math.floor(current / 2))) {
  if (!(currentRate > 0)) return current;
  if (previousRate === null || currentRate >= previousRate * 1.1) return Math.min(maxStreams, current * 2);
  if (currentRate < previousRate * 1.04) return previousStreams;
  return current;
}

export function createUploadBody(baseBlob, bodyBytes) {
  if (!(baseBlob instanceof Blob) || baseBlob.size < 1 || !Number.isSafeInteger(bodyBytes) || bodyBytes < 1) throw new Error("上传数据块无效。");
  const parts = Array(Math.floor(bodyBytes / baseBlob.size)).fill(baseBlob);
  const tail = bodyBytes % baseBlob.size;
  if (tail) parts.push(baseBlob.slice(0, tail));
  // An untyped raw body keeps cross-origin POSTs simple and avoids a preflight round trip.
  return new Blob(parts);
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || abortError());
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(signal.reason || abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

function requestSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason || abortError());
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs) : null;
  return { signal: controller.signal, cleanup() { if (timer !== null) clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

export async function loadConfig({ fetchImpl = globalThis.fetch, signal } = {}) {
  const request = requestSignal(signal, 5000);
  try {
    const response = await fetchImpl("/api/config", { cache: "no-store", signal: request.signal });
    if (!response.ok) throw new Error(`测速服务暂时不可用（${response.status}），请稍后重试。`);
    return normalizeConfig(await response.json());
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("连接测速服务超时，请检查网络后重试。");
    throw error;
  } finally { request.cleanup(); }
}

class TransferState {
  constructor(engine, kind, node, test, performanceConfig, options, idle, globalSignal) {
    this.engine = engine;
    this.kind = kind;
    this.node = node;
    this.performance = performanceConfig;
    this.options = options;
    this.rttMs = idle.medianMs || 0;
    this.warmupMs = Math.min(10000, Math.ceil(Math.max(options.warmupOverride ?? test.warmupMs, 8 * this.rttMs)));
    this.durationMs = options.durationMs ?? (kind === "download" ? test.downloadDurationMs : test.uploadDurationMs);
    this.began = engine.clock();
    this.measurementStart = this.began + this.warmupMs;
    this.ends = this.measurementStart + this.durationMs;
    this.controller = new AbortController();
    this.stop = () => this.controller.abort(globalSignal.reason || abortError());
    this.globalSignal = globalSignal;
    globalSignal.addEventListener("abort", this.stop, { once: true });
    if (globalSignal.aborted) this.stop();
    this.target = options.mode === "manual" ? options.streams : Math.min(test.minStreams, performanceConfig.maxStreams);
    this.jobs = new Map();
    this.promises = [];
    this.headerConnections = new Set();
    this.protocols = new Set();
    this.serverStats = null;
    this.peakStreams = 0;
    this.measuredBytes = 0;
    this.totalBytes = 0;
    this.elapsedMs = 0;
    this.requests = 0;
    this.failedRequests = 0;
    this.cancelledRequests = 0;
    this.exhaustedJobs = 0;
    this.windowFinished = false;
    this.latencies = [];
    this.failedPings = 0;
    this.points = [];
    this.lastPointBytes = 0;
    this.lastPointTime = 0;
    this.lastProbeTime = this.began;
    this.lastProbeBytes = 0;
    this.previousProbeRate = null;
    this.previousTarget = this.target;
    this.converged = false;
    this.lastTick = this.began;
    this.lagTicks = 0;
    this.startupAllowanceMs = Math.min(15000, Math.max(5000, 8 * this.rttMs));
  }

  emitPhase() {
    this.engine.emit({ type: "phase", phase: this.kind, durationMs: this.durationMs, warmupMs: this.warmupMs, rttMs: this.rttMs, requestedStreams: this.target });
  }

  captureHeaders(response) {
    const id = response.headers.get("X-Test-Connection-ID");
    const protocol = response.headers.get("X-Test-Protocol");
    if (id) this.headerConnections.add(id);
    if (protocol) this.protocols.add(protocol);
  }

  metadata() {
    const stats = this.serverStats;
    const open = [...this.jobs.values()].filter((job) => job.open).length;
    const activeStreams = Number.isFinite(stats?.activeRequests) && this.kind === "upload" ? stats.activeRequests : open;
    this.peakStreams = Math.max(this.peakStreams, activeStreams);
    return {
      mode: this.options.mode, requestedStreams: this.target, activeStreams, peakStreams: this.peakStreams,
      streams: activeStreams, maxStreams: this.performance.maxStreams,
      connections: {
        observed: Number.isFinite(stats?.connectionsObserved) ? stats.connectionsObserved : this.headerConnections.size,
        active: Number.isFinite(stats?.activeTcpConnections) ? stats.activeTcpConnections : null,
        peak: Number.isFinite(stats?.peakTcpConnections) ? stats.peakTcpConnections : null,
        protocols: [...new Set([...this.protocols, ...(stats?.protocols || [])])],
        scope: stats?.scope || (this.headerConnections.size ? "server" : "unknown"),
      },
      bdpBytes: estimateBDPBytes(toMbps(this.measuredBytes, this.elapsedMs), this.rttMs),
      rttMs: this.rttMs, warmupMs: this.warmupMs,
      bottleneck: this.lagTicks >= 3 ? "client-scheduling" : this.performance.sharedControlOrigin ? "control-shared-origin" : null,
    };
  }

  adapt(now, launch) {
    if (this.elapsedMs >= this.durationMs || this.options.mode !== "auto" || this.converged || now - this.lastProbeTime < Math.max(800, 3 * this.rttMs)) return;
    const rate = toMbps(this.totalBytes - this.lastProbeBytes, now - this.lastProbeTime);
    const next = chooseConcurrencyTarget(this.target, this.previousProbeRate, rate, this.performance.maxStreams, this.previousTarget);
    if (rate > 0) {
      if (next < this.target || (next === this.target && this.previousProbeRate !== null)) this.converged = true;
      const oldTarget = this.target;
      if (next !== oldTarget) {
        this.target = next;
        if (next > oldTarget) this.previousTarget = oldTarget;
        this.resize(launch);
      }
      this.previousProbeRate = rate;
    }
    this.lastProbeBytes = this.totalBytes;
    this.lastProbeTime = now;
  }

  resize(launch) {
    for (const [index, job] of this.jobs) if (index >= this.target) job.controller.abort(abortError("调整并发传输"));
    for (let index = 0; index < this.target; index += 1) {
      if (this.jobs.has(index) || this.controller.signal.aborted) continue;
      const controller = new AbortController();
      const stop = () => controller.abort(this.controller.signal.reason || abortError());
      this.controller.signal.addEventListener("abort", stop, { once: true });
      const job = { controller, open: false, received: false, exhausted: false };
      this.jobs.set(index, job);
      this.promises.push(launch(index, job).finally(() => {
        this.controller.signal.removeEventListener("abort", stop);
        this.jobs.delete(index);
        if (job.exhausted) this.exhaustedJobs += 1;
        if (this.jobs.size === 0 && this.exhaustedJobs > 0 && !this.windowFinished && !this.controller.signal.aborted && (this.kind === "upload" || this.engine.clock() < this.ends)) {
          this.controller.abort(new Error(`${this.kind === "download" ? "下载" : "上传"}测速连接中断，请检查网络后重试。`));
        }
      }));
    }
  }

  tick(launch) {
    const now = this.engine.clock();
    if (now - this.lastTick > 450) this.lagTicks += 1;
    else this.lagTicks = Math.max(0, this.lagTicks - 1);
    this.lastTick = now;
    if (this.kind === "download") this.elapsedMs = Math.max(0, Math.min(this.durationMs, now - this.measurementStart));
    const interval = this.elapsedMs - this.lastPointTime;
    const rate = interval > 0 ? toMbps(this.measuredBytes - this.lastPointBytes, interval) : 0;
    if (interval > 0) {
      this.points.push({ elapsedMs: this.elapsedMs, mbps: rate });
      this.lastPointBytes = this.measuredBytes;
      this.lastPointTime = this.elapsedMs;
    }
    this.adapt(now, launch);
    this.engine.emit({
      type: "progress", phase: this.kind, progress: this.elapsedMs / this.durationMs, warmingUp: this.elapsedMs === 0,
      mbps: toMbps(this.measuredBytes, this.elapsedMs), instantaneousMbps: rate,
      measuredBytes: this.measuredBytes, totalBytes: this.totalBytes,
      remainingMs: Math.max(0, this.durationMs - this.elapsedMs + (this.elapsedMs === 0 ? this.warmupMs : 0)),
      points: [...this.points], ...this.metadata(),
    });
  }

  async loadedLatency() {
    await pause(this.warmupMs, this.controller.signal).catch(() => {});
    while (!this.controller.signal.aborted) {
      try { this.latencies.push(await this.engine.ping(this.node, this.controller.signal, this.rttMs)); }
      catch (error) { if (this.controller.signal.aborted) break; this.failedPings += 1; }
      this.engine.emit({ type: "latency", phase: this.kind, stats: latencyStatistics(this.latencies, this.failedPings) });
      await pause(650, this.controller.signal).catch(() => {});
    }
  }

  result() {
    if (!this.measuredBytes) throw new Error(`${this.kind === "download" ? "下载" : "上传"}测速没有收到有效数据，请检查连接后重试。`);
    return {
      mbps: toMbps(this.measuredBytes, this.elapsedMs), measuredBytes: this.measuredBytes, totalBytes: this.totalBytes,
      durationMs: this.elapsedMs, requests: this.requests - this.cancelledRequests, attemptedRequests: this.requests,
      failedRequests: this.failedRequests, latency: latencyStatistics(this.latencies, this.failedPings), points: this.points,
      ...this.metadata(),
    };
  }

  async cleanup() {
    this.controller.abort(abortError("测速阶段完成"));
    this.globalSignal.removeEventListener("abort", this.stop);
    await Promise.allSettled(this.promises);
  }
}

// This single implementation runs in a browser Worker and accepts injected I/O for meaningful tests.
export class MeasurementEngine {
  constructor({ onUpdate = () => {}, fetchImpl = globalThis.fetch, clock = () => performance.now(), randomFill = (bytes) => crypto.getRandomValues(bytes), taskYield } = {}) {
    this.onUpdate = onUpdate;
    this.fetch = (...args) => fetchImpl(...args);
    this.clock = clock;
    this.randomFill = randomFill;
    this.controller = null;
    this.nonce = 0;
    this.lastTaskYield = this.clock();
    this.yielding = null;
    this.taskYield = taskYield || (() => {
      if (typeof WorkerGlobalScope === "undefined" || !(globalThis instanceof WorkerGlobalScope)) return Promise.resolve();
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(0);
      });
    });
  }
  emit(update) { this.onUpdate(update); }
  cancel(message) { this.controller?.abort(abortError(message)); }
  async yieldReaders() {
    if (!this.yielding) {
      this.lastTaskYield = this.clock();
      this.yielding = this.taskYield().finally(() => { this.yielding = null; this.lastTaskYield = this.clock(); });
    }
    await this.yielding;
  }
  url(baseURL, path, params = {}) {
    const url = new URL(`api/${path}`, baseURL);
    url.searchParams.set("nonce", `${Date.now()}-${this.nonce++}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.href;
  }
  async json(url, options = {}, parent, timeoutMs = 5000) {
    const request = requestSignal(parent, timeoutMs);
    try {
      const response = await this.fetch(url, { cache: "no-store", ...options, signal: request.signal });
      if (!response.ok) throw new Error(`测速请求失败（${response.status}）`);
      if (response.status === 204) return null;
      return await response.json();
    } finally { request.cleanup(); }
  }
  async ping(node, signal, idleRTT = 0) {
    const start = this.clock();
    await this.json(this.url(node.baseUrl, "ping"), {}, signal, Math.min(15000, Math.max(5000, 6 * idleRTT)));
    return this.clock() - start;
  }
  async idleLatency(node, sampleCount, signal) {
    const values = [];
    let failed = 0;
    this.emit({ type: "phase", phase: "latency" });
    for (let index = 0; index < sampleCount; index += 1) {
      try { values.push(await this.ping(node, signal)); }
      catch (error) { if (signal.aborted) throw signal.reason || error; failed += 1; }
      this.emit({ type: "latency", phase: "idle", stats: latencyStatistics(values, failed) });
      this.emit({ type: "progress", phase: "latency", progress: (index + 1) / sampleCount });
      if (index < sampleCount - 1) await pause(90, signal);
    }
    if (!values.length) throw new Error("无法连接测速节点，请检查网络或稍后重试。");
    return latencyStatistics(values, failed);
  }

  async downloadPhase(node, test, performanceConfig, options, idle, globalSignal) {
    const state = new TransferState(this, "download", node, test, performanceConfig, options, idle, globalSignal);
    const runBytes = new Uint8Array(12);
    this.randomFill(runBytes);
    const run = Array.from(runBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const launch = async (index, job) => {
      let failures = 0;
      while (!job.controller.signal.aborted && this.clock() < state.ends) {
        state.requests += 1;
        try {
          const origin = performanceConfig.originSlots?.[index] || performanceConfig.measurementOrigins[index % performanceConfig.measurementOrigins.length];
          const response = await this.fetch(this.url(origin, "download", { stream: 1, run }), { cache: "no-store", signal: job.controller.signal });
          if (!response.ok) throw new Error(`下载请求失败（${response.status}）`);
          if (!response.body?.getReader) throw new Error("浏览器不支持流式下载，请更新浏览器后重试。");
          state.captureHeaders(response);
          job.open = true;
          const reader = response.body.getReader();
          try {
            while (!job.controller.signal.aborted && this.clock() < state.ends) {
              const { done, value } = await reader.read();
              if (done) throw new Error("连续下载连接提前结束");
              const now = this.clock();
              job.received = value.byteLength > 0 || job.received;
              state.totalBytes += value.byteLength;
              if (now >= state.measurementStart && now <= state.ends) state.measuredBytes += value.byteLength;
              failures = 0;
              // A continuously ready reader must still let timers and cancellation messages run.
              if (this.yielding || now - this.lastTaskYield >= 8) await this.yieldReaders();
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); job.open = false; }
        } catch (error) {
          job.open = false;
          if (job.controller.signal.aborted) { if (!job.received) state.cancelledRequests += 1; break; }
          state.failedRequests += 1;
          failures += 1;
          if (failures >= 3) {
            job.exhausted = true;
            const living = [...state.jobs.values()].filter((other) => other !== job && !other.controller.signal.aborted);
            if (!living.length) state.controller.abort(new Error("下载测速连接中断，请检查网络后重试。"));
            break;
          }
          await pause(180 * failures, job.controller.signal).catch(() => {});
        }
      }
    };
    state.emitPhase();
    state.resize(launch);
    const latencyJob = state.loadedLatency();
    const statsJob = (async () => {
      while (!state.controller.signal.aborted) {
        try { state.serverStats = await this.json(this.url(node.baseUrl, "connection-stats", { run }), {}, state.controller.signal, Math.max(5000, 6 * state.rttMs)); }
        catch { /* Connection diagnostics are optional; transfer integrity is independently measured. */ }
        await pause(900, state.controller.signal).catch(() => {});
      }
    })();
    const ticker = setInterval(() => state.tick(launch), 200);
    let result = null;
    try {
      await pause(state.warmupMs + state.durationMs, state.controller.signal);
      state.tick(launch);
      result = state.result();
      this.emit({ type: "phase-complete", phase: "download", result });
      return result;
    } finally {
      clearInterval(ticker);
      await state.cleanup();
      await Promise.allSettled([latencyJob, statsJob]);
      if (result) {
        try {
          state.serverStats = await this.json(this.url(node.baseUrl, "connection-stats", { run }), {}, globalSignal, Math.max(1500, 3 * state.rttMs));
          Object.assign(result, state.metadata());
        } catch { result.connections.active = null; }
        result.activeStreams = 0;
        result.streams = 0;
      }
    }
  }

  createRandomBlob(bytes) {
    const random = new Uint8Array(bytes);
    for (let offset = 0; offset < random.length; offset += 65536) this.randomFill(random.subarray(offset, Math.min(offset + 65536, random.length)));
    return new Blob([random], { type: "application/octet-stream" });
  }

  async uploadPhase(node, test, performanceConfig, options, idle, globalSignal) {
    const state = new TransferState(this, "upload", node, test, performanceConfig, options, idle, globalSignal);
    const timeoutMs = Math.min(15000, Math.max(5000, 8 * state.rttMs));
    let session = null;
    let ticker = null;
    let latencyJob = null;
    let uploadBody = null;
    let result = null;
    const launch = async (index, job) => {
      let failures = 0;
      while (!job.controller.signal.aborted) {
        state.requests += 1;
        try {
          const origin = performanceConfig.originSlots?.[index] || performanceConfig.measurementOrigins[index % performanceConfig.measurementOrigins.length];
          const response = await this.fetch(this.url(origin, "upload", { session: session.id }), { method: "POST", body: uploadBody, cache: "no-store", signal: job.controller.signal });
          if (response.status === 409) {
            const cutoff = await response.json();
            if (cutoff.code === "session_finished") { state.windowFinished = true; break; }
            throw new Error("上传测速会话已失效");
          }
          if (!response.ok) throw new Error(`上传请求失败（${response.status}）`);
          state.captureHeaders(response);
          await response.json();
          failures = 0;
        } catch (error) {
          if (job.controller.signal.aborted) { state.cancelledRequests += 1; break; }
          state.failedRequests += 1;
          failures += 1;
          if (failures >= 3) {
            job.exhausted = true;
            const living = [...state.jobs.values()].filter((other) => other !== job && !other.controller.signal.aborted);
            if (!living.length) state.controller.abort(new Error("上传测速连接中断，请检查网络后重试。"));
            break;
          }
          await pause(180 * failures, job.controller.signal).catch(() => {});
        }
      }
    };
    try {
      session = await this.json(this.url(node.baseUrl, "upload-sessions"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ warmupMs: state.warmupMs, durationMs: state.durationMs }),
      }, state.controller.signal, timeoutMs);
      if (!session || typeof session.id !== "string") throw new Error("上传测速会话无效，请更新服务后重试。");
      this.emit({ type: "session-created", id: session.id, baseUrl: node.baseUrl });
      const baseBlob = this.createRandomBlob(performanceConfig.uploadBlockBytes);
      uploadBody = createUploadBody(baseBlob, performanceConfig.maxUploadBodyBytes);
      state.began = this.clock();
      state.lastProbeTime = state.began;
      state.emitPhase();
      state.resize(launch);
      latencyJob = state.loadedLatency();
      ticker = setInterval(() => state.tick(launch), 200);
      let failedPolls = 0;
      while (!state.controller.signal.aborted) {
        if (this.clock() - state.began > state.warmupMs + state.durationMs + state.startupAllowanceMs + timeoutMs) throw new Error("上传测速超时，请检查服务和网络后重试。");
        let snapshot;
        try {
          state.requests += 1;
          snapshot = await this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), {}, state.controller.signal, timeoutMs);
          failedPolls = 0;
        } catch (error) {
          if (state.controller.signal.aborted) throw state.controller.signal.reason || error;
          failedPolls += 1;
          state.failedRequests += 1;
          if (failedPolls >= 3) throw new Error("无法获取上传进度，请检查连接后重试。");
          await pause(300, state.controller.signal);
          continue;
        }
        if (!snapshot || !Number.isFinite(snapshot.measuredBytes) || !Number.isFinite(snapshot.totalBytes) || !Number.isFinite(snapshot.measurementElapsedMs) || snapshot.measuredBytes < 0 || snapshot.measurementElapsedMs < 0 || snapshot.measurementElapsedMs > state.durationMs + 1) throw new Error("上传测速进度无效，请更新服务后重试。");
        state.measuredBytes = snapshot.measuredBytes;
        state.totalBytes = snapshot.totalBytes;
        state.elapsedMs = snapshot.measurementElapsedMs;
        state.serverStats = snapshot;
        if (snapshot.finished) {
          state.windowFinished = true;
          state.tick(launch);
          result = state.result();
          this.emit({ type: "phase-complete", phase: "upload", result });
          return result;
        }
        await pause(200, state.controller.signal);
      }
      throw state.controller.signal.reason || abortError();
    } finally {
      if (ticker !== null) clearInterval(ticker);
      await state.cleanup();
      if (latencyJob) await Promise.allSettled([latencyJob]);
      if (session) {
        if (result) {
          try {
            state.serverStats = await this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), {}, globalSignal, Math.max(1500, 3 * state.rttMs));
            Object.assign(result, state.metadata());
          } catch { result.connections.active = null; }
          result.activeStreams = 0;
          result.streams = 0;
        }
        try { await this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), { method: "DELETE" }, undefined, 1500); }
        catch { /* Session expiry also bounds server state if the client disconnects. */ }
      }
    }
  }

  async run(config, requestedOptions = {}) {
    if (this.controller) throw new Error("测速正在进行，请先停止当前测速。");
    const normalized = normalizeConfig(config);
    const options = normalizeOptions(normalized, requestedOptions);
    const node = normalized.nodes[0];
    const controller = new AbortController();
    this.controller = controller;
    try {
      const startedAt = new Date().toISOString();
      const idle = await this.idleLatency(node, normalized.test.pingSamples, controller.signal);
      const download = await this.downloadPhase(node, normalized.test, normalized.performance, options, idle, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const upload = await this.uploadPhase(node, normalized.test, normalized.performance, options, idle, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const result = {
        startedAt, completedAt: new Date().toISOString(), node, mode: options.mode,
        downloadMbps: download.mbps, uploadMbps: upload.mbps, latency: { idle, download: download.latency, upload: upload.latency }, download, upload,
      };
      this.emit({ type: "complete", result });
      return result;
    } finally { this.controller = null; }
  }
}

// Summaries cross the Worker boundary; network readers and the retained random Blob remain off the UI thread.
export class SpeedTest {
  constructor({ onUpdate = () => {}, workerFactory = (url, options) => new Worker(url, options) } = {}) {
    this.onUpdate = onUpdate;
    this.workerFactory = workerFactory;
    this.controller = null;
    this.worker = null;
    this.pending = null;
    this.cancelTimer = null;
  }
  cancel(message = "测速已停止") {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort(abortError(message));
    this.worker?.postMessage({ type: "cancel", message });
    this.cancelTimer = setTimeout(() => this.finish(abortError(message)), 2500);
  }
  finish(error, result) {
    if (!this.pending) return;
    if (this.cancelTimer !== null) clearTimeout(this.cancelTimer);
    const pending = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    this.controller = null;
    this.cancelTimer = null;
    if (error) pending.reject(error);
    else pending.resolve(result);
  }
  run(config, requestedOptions = {}) {
    if (this.controller) return Promise.reject(new Error("测速正在进行，请先停止当前测速。"));
    let normalized;
    let options;
    try { normalized = normalizeConfig(config); options = normalizeOptions(normalized, requestedOptions); }
    catch (error) { return Promise.reject(error); }
    this.controller = new AbortController();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        const worker = this.workerFactory(new URL("./measurement-worker.js", import.meta.url), { type: "module", name: "speed-measurement" });
        this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (this.worker !== worker) return;
          if (data.type === "update") {
            if (!this.controller?.signal.aborted) this.onUpdate(data.update);
          } else if (data.type === "result") {
            if (this.controller?.signal.aborted) this.finish(this.controller.signal.reason || abortError());
            else this.finish(null, data.result);
          } else if (data.type === "error") {
            this.finish(this.controller?.signal.aborted ? this.controller.signal.reason || abortError() : data.name === "AbortError" ? abortError(data.message) : new Error(data.message || "测速未完成，请重试。"));
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          if (this.worker !== worker) return;
          this.finish(new Error("测速工作线程无法运行，请更新浏览器或检查服务配置。"));
        };
        worker.postMessage({ type: "start", config: normalized, options });
      } catch { this.finish(new Error("浏览器无法启动测速工作线程，请使用最新稳定版浏览器重试。")); }
    });
  }
}
