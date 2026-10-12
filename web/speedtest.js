const MIB = 1024 * 1024;
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const abortError = (message = "测速已停止") => new DOMException(message, "AbortError");

function ensureActive(signal) {
  if (signal.aborted) throw signal.reason || abortError();
  if (globalThis.navigator?.onLine === false) throw abortError("网络连接已断开，请恢复连接后重新测速。");
}

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
  const transport = raw.transport === "websocket" ? "websocket" : "http";
  const maxStreams = transport === "websocket" ? bounded(raw.maxStreams, 30, 1, 30) : Math.min(bounded(raw.maxStreams, 24, 1, 48), capacity);
  const defaultStreams = bounded(raw.defaultStreams, transport === "websocket" ? 8 : 2, 1, maxStreams);
  const performanceConfig = {
    transport, measurementOrigins: origins, originSlots, maxStreams, defaultStreams,
    defaultMode: raw.defaultMode === "auto" ? "auto" : raw.defaultMode === "manual" || transport === "websocket" ? "manual" : "auto",
    downloadBlockBytes: 25 * MIB, uploadBlockBytes: 25 * MIB,
    maxUploadBodyBytes: bounded(raw.maxUploadBodyBytes, 1024 * MIB, 25 * MIB, 1024 * MIB),
    sharedControlOrigin: origins.some((value) => new URL(value).origin === controlOrigin),
  };
  const input = config.test || {};
  const test = {
    downloadDurationMs: bounded(input.downloadDurationMs, 10000, 500, 60000),
    uploadDurationMs: bounded(input.uploadDurationMs, 10000, 500, 60000),
    warmupMs: bounded(input.warmupMs, 1500, 0, 10000),
    minStreams: bounded(input.minStreams, defaultStreams, 1, maxStreams), maxStreams,
    pingSamples: bounded(input.pingSamples, 8, 1, 20),
  };
  nodes[0].dataOrigins = origins;
  return { protocolVersion: 2, nodes, test, performance: performanceConfig, features: config.features || {} };
}

export function normalizeOptions(config, options = {}) {
  const mode = options.mode || config.performance.defaultMode;
  if (mode !== "auto" && mode !== "manual") throw new Error("请选择自动或手动并发模式。");
  const streams = options.streams ?? config.performance.defaultStreams ?? config.test.minStreams;
  if (!Number.isInteger(streams) || streams < 1 || streams > config.performance.maxStreams) throw new Error(`当前部署支持 1 至 ${config.performance.maxStreams} 条并行传输。`);
  if (options.durationMs !== undefined && (!Number.isInteger(options.durationMs) || options.durationMs < 10000 || options.durationMs > 60000)) throw new Error("测量时间应为 10 至 60 秒。");
  if (options.warmupOverride !== undefined && (!Number.isFinite(options.warmupOverride) || options.warmupOverride < 0 || options.warmupOverride > 10000)) throw new Error("预热时间应为 0 至 10 秒。");
  const testType = options.testType ?? "full";
  const measurementPolicy = options.measurementPolicy ?? "fixed";
  const minDurationMs = options.minDurationMs ?? 5000;
  const maxBytes = options.maxBytes ?? 0;
  if (!["full", "download", "latency"].includes(testType)) throw new Error("请选择完整、下载或延迟测试。");
  if (!["fixed", "adaptive"].includes(measurementPolicy)) throw new Error("请选择固定或稳定后结束的测量策略。");
  if (!Number.isInteger(minDurationMs) || minDurationMs < 5000 || minDurationMs > (options.durationMs ?? 60000)) throw new Error("最短测量时间应为 5 秒至最大测量时间。");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1024 ** 4) throw new Error("单方向流量预算应为 0 至 1 TiB 的整数，0 表示不限。");
  return { mode, streams, durationMs: options.durationMs, warmupOverride: options.warmupOverride, testType, measurementPolicy, minDurationMs, maxBytes };
}

export function isThroughputStable(windows) {
  const recent = windows.slice(-3);
  if (recent.length < 3 || recent.some((window) => !(window.elapsedMs >= 1000) || !(window.mbps > 0))) return false;
  const rates = recent.map((window) => window.mbps);
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const variation = Math.sqrt(rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length) / mean;
  const dropped = rates.some((rate, index) => index > 0 && rate < rates[index - 1] * 0.9);
  // Reject a continuing ramp even when three close samples have a low CV.
  const drift = Math.abs(rates.at(-1) - rates[0]) / rates[0];
  return variation <= 0.05 && !dropped && drift <= 0.05;
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

export function chooseWebSocketMessageBytes(bytes, elapsedMs) {
  const desired = Math.max(1024, Math.min(MIB, bytes / Math.max(1, elapsedMs) * 20));
  return 2 ** Math.floor(Math.log2(desired));
}

export function chooseWebSocketHandshakeTimeout(streams, rttMs = 0) {
  const concurrent = Math.max(1, Math.min(30, Math.ceil(Number.isFinite(streams) ? streams : 1)));
  const rtt = Number.isFinite(rttMs) ? Math.max(0, rttMs) : 0;
  // Browsers queue simultaneous upgrades; allow one bounded budget per group of six.
  const queueBudget = 5000 + (Math.ceil(concurrent / 6) - 1) * 1500;
  return Math.min(30000, Math.ceil(Math.max(queueBudget, 6 * rtt)));
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
    this.options = { measurementPolicy: "fixed", minDurationMs: 5000, maxBytes: 0, ...options };
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
    this.completionReason = null;
    this.stabilityWindows = [];
    this.stabilityTime = 0;
    this.stabilityBytes = 0;
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
    this.lastProgressEmittedAt = -Infinity;
    this.lagTicks = 0;
    this.startupAllowanceMs = Math.min(15000, Math.max(5000, 8 * this.rttMs));
  }

  emitPhase() {
    this.engine.emit({ type: "phase", phase: this.kind, transport: this.performance.transport || "http", durationMs: this.durationMs, warmupMs: this.warmupMs, rttMs: this.rttMs, requestedStreams: this.target, measurementPolicy: this.options.measurementPolicy, maxBytes: this.options.maxBytes });
  }

  captureDownload(bytes, now) {
    this.totalBytes += bytes;
    if (now >= this.measurementStart && now <= this.ends) this.measuredBytes += bytes;
    this.emitPreview(now);
    if (this.options.maxBytes && this.totalBytes >= this.options.maxBytes) this.finishDownload("budget", now);
  }

  finishDownload(reason, now = this.engine.clock()) {
    if (this.windowFinished || this.controller.signal.aborted) return;
    this.elapsedMs = Math.max(0, Math.min(this.durationMs, now - this.measurementStart));
    this.completionReason = reason;
    this.windowFinished = true;
    this.controller.abort(abortError("测量窗口完成"));
  }

  recordStability() {
    const elapsed = this.elapsedMs - this.stabilityTime;
    if (elapsed < 1000) return;
    this.stabilityWindows.push({ elapsedMs: elapsed, mbps: toMbps(this.measuredBytes - this.stabilityBytes, elapsed) });
    if (this.stabilityWindows.length > 6) this.stabilityWindows.shift();
    this.stabilityTime = this.elapsedMs;
    this.stabilityBytes = this.measuredBytes;
  }

  shouldFinishStable() {
    return this.options.measurementPolicy === "adaptive" && this.elapsedMs < this.durationMs
      && this.elapsedMs >= Math.max(5000, this.options.minDurationMs, 8 * this.rttMs)
      && this.failedRequests === 0 && this.failedPings === 0 && this.lagTicks === 0
      && (this.options.mode !== "auto" || this.converged)
      && isThroughputStable(this.stabilityWindows);
  }

  applyUploadSnapshot(snapshot) {
    if (!snapshot || !Number.isSafeInteger(snapshot.measuredBytes) || !Number.isSafeInteger(snapshot.totalBytes) || !Number.isFinite(snapshot.measurementElapsedMs)
      || snapshot.measuredBytes < this.measuredBytes || snapshot.totalBytes < this.totalBytes || snapshot.totalBytes < snapshot.measuredBytes
      || snapshot.measurementElapsedMs < this.elapsedMs || snapshot.measurementElapsedMs > this.durationMs + 1
      || (snapshot.finished && snapshot.completionReason !== undefined && !["duration", "stable", "budget"].includes(snapshot.completionReason))) throw new Error("上传测速进度无效，请更新服务后重试。");
    this.measuredBytes = snapshot.measuredBytes;
    this.totalBytes = snapshot.totalBytes;
    this.elapsedMs = snapshot.measurementElapsedMs;
    this.serverStats = snapshot;
    this.recordStability();
    if (snapshot.finished) this.completionReason = ["duration", "stable", "budget"].includes(snapshot.completionReason) ? snapshot.completionReason : "duration";
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
      transport: this.performance.transport || "http",
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
      bottleneck: this.lagTicks >= 3 ? "client-scheduling" : this.performance.transport !== "websocket" && this.performance.sharedControlOrigin ? "control-shared-origin" : null,
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
    if (this.kind === "download" && !this.windowFinished) this.elapsedMs = Math.max(0, Math.min(this.durationMs, now - this.measurementStart));
    const interval = this.elapsedMs - this.lastPointTime;
    const rate = interval > 0 ? toMbps(this.measuredBytes - this.lastPointBytes, interval) : 0;
    if (interval > 0) {
      this.points.push({ elapsedMs: this.elapsedMs, mbps: rate });
      this.lastPointBytes = this.measuredBytes;
      this.lastPointTime = this.elapsedMs;
    }
    this.adapt(now, launch);
    this.recordStability();
    if (this.kind === "download" && this.shouldFinishStable()) this.finishDownload("stable", now);
    this.emitProgress(now, rate);
  }

  emitProgress(now, instantaneousMbps = 0) {
    // Warm-up previews use received bytes and actual wall-clock time. Share a
    // 10 Hz limit between the ticker and payload callbacks; no preview enters
    // the measured window, curve, or final throughput calculation.
    if (this.elapsedMs === 0 && now - this.lastProgressEmittedAt < 100) return;
    this.lastProgressEmittedAt = now;
    const previewElapsedMs = Math.max(0, now - this.began);
    this.engine.emit({
      type: "progress", phase: this.kind, progress: this.elapsedMs / this.durationMs, warmingUp: this.elapsedMs === 0,
      mbps: toMbps(this.measuredBytes, this.elapsedMs), instantaneousMbps,
      previewMbps: toMbps(this.totalBytes, previewElapsedMs), previewElapsedMs,
      measuredBytes: this.measuredBytes, totalBytes: this.totalBytes,
      remainingMs: Math.max(0, this.durationMs - this.elapsedMs + (this.elapsedMs === 0 ? this.warmupMs : 0)),
      points: [...this.points], ...this.metadata(),
    });
  }

  emitPreview(now) {
    if (this.kind === "download" && now < this.measurementStart && now > this.began && this.totalBytes > 0) this.emitProgress(now);
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
    const incomplete = this.completionReason === "budget" && (!this.measuredBytes || this.elapsedMs <= 0);
    if ((!this.measuredBytes || this.elapsedMs <= 0) && !incomplete) throw new Error(`${this.kind === "download" ? "下载" : "上传"}测速没有收到有效数据，请检查连接后重试。`);
    return {
      mbps: incomplete ? null : toMbps(this.measuredBytes, this.elapsedMs), measuredBytes: this.measuredBytes, totalBytes: this.totalBytes,
      complete: !incomplete, incompleteReason: incomplete ? "budget-before-measurement" : null,
      completionReason: this.completionReason || "duration", measurementPolicy: this.options.measurementPolicy,
      maxBytes: this.options.maxBytes, budgetOvershootBytes: this.options.maxBytes ? Math.max(0, this.totalBytes - this.options.maxBytes) : 0,
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
  constructor({ onUpdate = () => {}, fetchImpl = globalThis.fetch, webSocketFactory = (url) => new WebSocket(url), clock = () => performance.now(), randomFill = (bytes) => crypto.getRandomValues(bytes), taskYield } = {}) {
    this.onUpdate = onUpdate;
    this.fetch = (...args) => fetchImpl(...args);
    this.webSocketFactory = (...args) => webSocketFactory(...args);
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
  async idleLatency(node, sampleCount, signal, options = {}) {
    const values = [...(options.seedValues || [])];
    let failed = options.seedFailed || 0;
    const announce = options.announce !== false;
    if (announce) this.emit({ type: "phase", phase: "latency" });
    let emitted = false;
    for (let index = values.length + failed; index < sampleCount; index += 1) {
      try { values.push(await this.ping(node, signal)); }
      catch (error) { if (signal.aborted) throw signal.reason || error; failed += 1; }
      this.emit({ type: "latency", phase: "idle", stats: latencyStatistics(values, failed) });
      emitted = true;
      if (announce) this.emit({ type: "progress", phase: "latency", progress: (index + 1) / sampleCount });
      if (options.stopAfterFirstSuccess && values.length) break;
      if (index < sampleCount - 1) await pause(90, signal);
    }
    if (!values.length) throw new Error("无法连接测速节点，请检查网络或稍后重试。");
    const stats = latencyStatistics(values, failed);
    if (!emitted) this.emit({ type: "latency", phase: "idle", stats });
    return stats;
  }

  async probeOrigin(baseUrl, signal, timeoutMs) {
    ensureActive(signal);
    const request = requestSignal(signal, timeoutMs);
    let reader = null;
    try {
      const response = await this.fetch(this.url(baseUrl, "download", { bytes: 16384 }), { cache: "no-store", signal: request.signal });
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      const encoding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
      if (!response.ok || contentType !== "application/octet-stream" || (encoding && encoding !== "identity") || !response.body?.getReader) {
        await response.body?.cancel().catch(() => {});
        return false;
      }
      reader = response.body.getReader();
      // A real first block proves reachability without waiting for the entire probe on a slow link.
      for (let emptyReads = 0; emptyReads < 4; emptyReads += 1) {
        const { done, value } = await reader.read();
        ensureActive(signal);
        if (done) return false;
        if (value.byteLength > 0) return true;
      }
      return false;
    } catch (error) {
      ensureActive(signal);
      return false;
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      request.cleanup();
    }
  }

  socketExchange(baseUrl, params, signal, callbacks = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      ensureActive(signal);
      const address = new URL(this.url(baseUrl, "ws", params));
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      let socket;
      let ready = false;
      let settled = false;
      let closeTimer = null;
      let abortReason = null;
      const cleanup = () => {
        clearTimeout(connectTimer);
        if (closeTimer !== null) clearTimeout(closeTimer);
        signal.removeEventListener("abort", abort);
        if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const close = () => { try { if (socket?.readyState < 2) socket.close(1000, "measurement_complete"); } catch {} };
      const abort = () => {
        abortReason = signal.reason || abortError();
        close();
        if (!settled && closeTimer === null) closeTimer = setTimeout(() => finish(abortReason), 2000);
      };
      const connectTimer = setTimeout(() => { close(); finish(new Error("WebSocket 测速连接超时")); }, timeoutMs);
      try {
        socket = this.webSocketFactory(address.href);
        socket.binaryType = "arraybuffer";
        callbacks.onSocket?.(socket);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        socket.onmessage = ({ data }) => {
          if (settled || signal.aborted) return;
          try {
            if (typeof data === "string") {
              const message = JSON.parse(data);
              if (ready || message.type !== "ready" || typeof message.connectionId !== "string" || typeof message.protocol !== "string") throw new Error("WebSocket 测速响应无效");
              ready = true;
              if (params.direction !== "probe") clearTimeout(connectTimer);
              callbacks.onReady?.(socket, message);
            } else {
              if (!ready || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) throw new Error("WebSocket 测速数据无效");
              if (callbacks.onBinary?.(socket, data.byteLength) === false) { finish(null, true); close(); }
            }
          } catch (error) { close(); finish(error); }
        };
        socket.onerror = () => { close(); finish(abortReason || new Error("WebSocket 测速连接不可用")); };
        socket.onclose = ({ code, reason }) => {
          if (abortReason || signal.aborted) finish(abortReason || signal.reason || abortError());
          else if (callbacks.acceptClose?.(code, reason)) finish(null, true);
          else finish(new Error("WebSocket 测速连接提前关闭"));
        };
      } catch (error) { close(); finish(error); }
    });
  }

  async probeWebSocket(node, signal, timeoutMs) {
    try {
      return await this.socketExchange(node.baseUrl, { direction: "probe" }, signal, { onBinary: (_, bytes) => bytes > 0 ? false : undefined }, timeoutMs);
    } catch { ensureActive(signal); return false; }
  }

  async prepareTransport(config, options, idle, signal) {
    ensureActive(signal);
    const requestedTransport = config.performance.transport;
    const configuredMaxStreams = config.performance.maxStreams;
    if (requestedTransport === "websocket") {
      const reachable = await this.probeWebSocket(config.nodes[0], signal, Math.min(8000, Math.ceil(Math.max(5000, 6 * (idle.medianMs || 0) + 500))));
      ensureActive(signal);
      if (reachable) {
        const transport = {
          type: "transport", transport: "websocket", mode: "single-origin", reason: "configured-origins", fallback: false,
          origins: [config.nodes[0].baseUrl], unreachableOrigins: [], configuredMaxStreams, maxStreams: configuredMaxStreams,
          requestedStreams: options.streams, effectiveStreams: options.streams, streamsAdjusted: false, message: null,
        };
        this.emit(transport);
        return { config, options, transport };
      }
      config = normalizeConfig({ ...config, performance: { ...config.performance, transport: "http" } }, config.nodes[0].baseUrl);
    }
    const configured = config.performance.measurementOrigins;
    const timeoutMs = Math.min(8000, Math.ceil(Math.max(1500, 6 * (idle.medianMs || 0) + 500)));
    const checks = await Promise.allSettled(configured.map((origin) => this.probeOrigin(origin, signal, timeoutMs)));
    ensureActive(signal);
    const origins = configured.filter((_, index) => checks[index].status === "fulfilled" && checks[index].value);
    const unreachableOrigins = configured.filter((_, index) => checks[index].status !== "fulfilled" || !checks[index].value);
    const main = config.nodes[0].baseUrl;
    const mainOrigin = new URL(main).origin;
    const hadIndependentOrigins = configured.some((origin) => new URL(origin).origin !== mainOrigin);
    let fallback = false;
    if (!origins.length) {
      // Reuse an identical failed main probe; a retry without a state change would add only delay.
      const mainIndex = configured.indexOf(main);
      const mainReachable = mainIndex >= 0 ? false : await this.probeOrigin(main, signal, timeoutMs);
      ensureActive(signal);
      if (!mainReachable) {
        throw new Error(hadIndependentOrigins
          ? "独立测速端口无法连接，主站测速接口也不可用。请检查防火墙、安全组或反向代理的测速路径。"
          : "主站测速下载接口不可用，请检查服务和反向代理是否允许测速传输。");
      }
      origins.push(main);
      fallback = true;
    } else {
      fallback = hadIndependentOrigins && origins.every((origin) => new URL(origin).origin === mainOrigin);
    }
    const effective = normalizeConfig({ ...config, performance: { ...config.performance, measurementOrigins: origins } }, main);
    const effectiveStreams = Math.min(options.streams, effective.performance.maxStreams);
    const streamsAdjusted = options.mode === "manual" && effectiveStreams !== options.streams;
    const mode = origins.length > 1 ? "multi-origin" : "single-origin";
    const reason = requestedTransport === "websocket" ? "websocket-unavailable" : unreachableOrigins.length ? "unreachable-origins" : mode === "single-origin" ? "single-origin-config" : "configured-origins";
    let message = requestedTransport === "websocket" ? `WebSocket 测速暂不可用，已改用 HTTP 测速，当前最多 ${effective.performance.maxStreams} 条并行传输。`
      : fallback ? "独立测速端口暂不可用，已切换为单端口测速。"
      : unreachableOrigins.length ? "部分测速端口暂不可用，已使用可达连接继续测速。" : null;
    if (streamsAdjusted) message = `${message || "可用测速连接已调整。"}手动并发已从 ${options.streams} 条调整为 ${effectiveStreams} 条。`;
    const transport = {
      type: "transport", transport: "http", mode, reason, fallback: fallback || requestedTransport === "websocket", origins, unreachableOrigins,
      configuredMaxStreams, maxStreams: effective.performance.maxStreams,
      requestedStreams: options.streams, effectiveStreams, streamsAdjusted, message,
    };
    ensureActive(signal);
    this.emit(transport);
    return { config: effective, options: { ...options, streams: effectiveStreams }, transport };
  }

  captureSocketReady(state, job, message) {
    job.open = true;
    state.headerConnections.add(message.connectionId);
    state.protocols.add(message.protocol);
    state.peakStreams = Math.max(state.peakStreams, [...state.jobs.values()].filter((item) => item.open).length);
  }

  async checkUploadCompletion(state, session, snapshot, timeoutMs) {
    state.applyUploadSnapshot(snapshot);
    if (!snapshot.finished && state.shouldFinishStable()) {
      // Only the server can freeze its actual received-byte window. Never
      // replace server counts with bytes accepted by socket.send()/fetch().
      state.requests += 1;
      try {
        const frozen = await this.json(this.url(state.node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}/finish`), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "stable" }),
        }, state.controller.signal, timeoutMs);
        state.applyUploadSnapshot(frozen);
        // A byte/time limit can win between the poll and this POST; report
        // that authoritative reason rather than pretending stability won.
        if (!frozen.finished) throw new Error("上传测量窗口未完成，请检查服务后重试。");
        snapshot = frozen;
      } catch (error) { if (!state.controller.signal.aborted) state.failedRequests += 1; throw error; }
    }
    return snapshot.finished;
  }

  async settleHTTPDownloadConnections(node, run, signal) {
    // A reverse proxy can observe browser cancellation before its upstream
    // Go request closes. Verify actual release instead of replacing a stale
    // positive count with an invented zero. This diagnostic never changes
    // transfer bytes, elapsed time, or a recorded transfer failure.
    const deadline = this.clock() + 1000;
    let snapshot = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const remainingMs = deadline - this.clock();
      if (remainingMs <= 0) break;
      snapshot = await this.json(this.url(node.baseUrl, "connection-stats", { run }), {}, signal, remainingMs);
      if (!(snapshot?.activeTcpConnections > 0) && !(snapshot?.activeRequests > 0)) return snapshot;
      if (attempt < 5) await pause(Math.min(180, Math.max(0, deadline - this.clock())), signal);
    }
    return snapshot;
  }

  async websocketDownloadPhase(node, test, performanceConfig, options, idle, globalSignal) {
    const state = new TransferState(this, "download", node, test, performanceConfig, options, idle, globalSignal);
    const random = new Uint8Array(12);
    this.randomFill(random);
    const run = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const launch = async (_, job) => {
      let failures = 0;
      while (!job.controller.signal.aborted && this.clock() < state.ends) {
        state.requests += 1;
        let feedbackTime = this.clock();
        let feedbackBytes = 0;
        let messageBytes = 4096;
        let first = true;
        try {
          await this.socketExchange(node.baseUrl, { direction: "download", run }, job.controller.signal, {
            onSocket: (socket) => { job.socket = socket; },
            onReady: (_, ready) => this.captureSocketReady(state, job, ready),
            onBinary: (socket, bytes) => {
              const now = this.clock();
              job.received ||= bytes > 0;
              state.captureDownload(bytes, now);
              feedbackBytes += bytes;
              failures = 0;
              if (now < state.ends && (first || now - feedbackTime >= 250)) {
                const next = chooseWebSocketMessageBytes(feedbackBytes, now - feedbackTime);
                if (next !== messageBytes && socket.readyState === 1 && socket.bufferedAmount < 65536) {
                  socket.send(JSON.stringify({ type: "resize", bytes: next }));
                  messageBytes = next;
                }
                first = false;
                feedbackTime = now;
                feedbackBytes = 0;
              }
            },
          }, chooseWebSocketHandshakeTimeout(state.target, state.rttMs));
        } catch (error) {
          if (job.controller.signal.aborted) { if (!job.received) state.cancelledRequests += 1; break; }
          state.failedRequests += 1;
          if (++failures >= 3) { job.exhausted = true; break; }
          await pause(180 * failures, job.controller.signal).catch(() => {});
        } finally { job.open = false; job.socket = null; }
      }
    };
    state.emitPhase();
    state.resize(launch);
    const latencyJob = state.loadedLatency();
    const statsJob = (async () => {
      while (!state.controller.signal.aborted) {
        try { state.serverStats = await this.json(this.url(node.baseUrl, "connection-stats", { run }), {}, state.controller.signal, Math.max(5000, 6 * state.rttMs)); }
        catch { /* A socket's ready message still supplies independently observed connection metadata. */ }
        await pause(900, state.controller.signal).catch(() => {});
      }
    })();
    const ticker = setInterval(() => state.tick(launch), 200);
    let result = null;
    try {
      await pause(state.warmupMs + state.durationMs, state.controller.signal).catch((error) => { if (!state.windowFinished || globalSignal.aborted) throw error; });
      if (globalSignal.aborted) throw globalSignal.reason || abortError();
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

  async websocketUploadPhase(node, test, performanceConfig, options, idle, globalSignal) {
    const state = new TransferState(this, "upload", node, test, performanceConfig, options, idle, globalSignal);
    const timeoutMs = Math.min(15000, Math.max(5000, 8 * state.rttMs));
    let session = null;
    let ticker = null;
    let pumpJob = null;
    let latencyJob = null;
    let result = null;
    let deleting = null;
    const payloads = [];
    const launch = async (index, job) => {
      let failures = 0;
      job.payloadIndex = index % payloads.length;
      while (!job.controller.signal.aborted && !state.windowFinished) {
        state.requests += 1;
        try {
          await this.socketExchange(node.baseUrl, { direction: "upload", session: session.id }, job.controller.signal, {
            onSocket: (socket) => { job.socket = socket; },
            onReady: (_, ready) => this.captureSocketReady(state, job, ready),
            acceptClose: (code, reason) => {
              if (code === 1000 && reason === "session_finished") { state.windowFinished = true; return true; }
              return false;
            },
          }, chooseWebSocketHandshakeTimeout(state.target, state.rttMs));
          if (state.windowFinished) break;
        } catch (error) {
          if (job.controller.signal.aborted) { state.cancelledRequests += 1; break; }
          state.failedRequests += 1;
          if (++failures >= 3) { job.exhausted = true; break; }
          await pause(180 * failures, job.controller.signal).catch(() => {});
        } finally { job.open = false; job.socket = null; }
      }
    };
    try {
      session = await this.json(this.url(node.baseUrl, "upload-sessions"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ warmupMs: state.warmupMs, durationMs: state.durationMs, maxBytes: state.options.maxBytes }),
      }, state.controller.signal, timeoutMs);
      if (!session || typeof session.id !== "string") throw new Error("上传测速会话无效，请更新服务后重试。");
      this.emit({ type: "session-created", id: session.id, baseUrl: node.baseUrl });
      const base = this.createRandomBlob(state.options.maxBytes ? Math.min(performanceConfig.uploadBlockBytes, state.options.maxBytes) : performanceConfig.uploadBlockBytes);
      for (let offset = 0; offset < base.size; offset += MIB) payloads.push(base.slice(offset, Math.min(offset + MIB, base.size)));
      state.began = this.clock();
      state.lastProbeTime = state.began;
      state.emitPhase();
      state.resize(launch);
      latencyJob = state.loadedLatency();
      pumpJob = (async () => {
        while (!state.controller.signal.aborted && !state.windowFinished) {
          let sentAny = false;
          for (const job of state.jobs.values()) {
            const socket = job.socket;
            if (!job.open || job.controller.signal.aborted || socket?.readyState !== 1) continue;
            for (let sent = 0; sent < 4; sent += 1) {
              const payload = payloads[job.payloadIndex % payloads.length];
              if (socket.bufferedAmount + payload.size > Math.min(4 * MIB, state.options.maxBytes || 4 * MIB)) break;
              try { socket.send(payload); job.payloadIndex += 1; sentAny = true; }
              catch { try { socket.close(); } catch {} break; }
            }
          }
          if (sentAny) await this.yieldReaders();
          else await pause(2, state.controller.signal).catch(() => {});
        }
      })();
      ticker = setInterval(() => state.tick(launch), 200);
      let failures = 0;
      while (!state.controller.signal.aborted) {
        if (this.clock() - state.began > state.warmupMs + state.durationMs + state.startupAllowanceMs + timeoutMs) throw new Error("上传测速超时，请检查服务和网络后重试。");
        let snapshot;
        try {
          state.requests += 1;
          snapshot = await this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), {}, state.controller.signal, timeoutMs);
          failures = 0;
        } catch (error) {
          if (state.controller.signal.aborted) throw state.controller.signal.reason || error;
          state.failedRequests += 1;
          if (++failures >= 3) throw new Error("无法获取上传进度，请检查连接后重试。");
          await pause(300, state.controller.signal);
          continue;
        }
        if (await this.checkUploadCompletion(state, session, snapshot, timeoutMs)) {
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
      // close() is queued behind pending browser data. DELETE forces server-side sockets closed first.
      if (session && !result) deleting = this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), { method: "DELETE" }, undefined, 1500).catch(() => {});
      await state.cleanup();
      if (latencyJob) await Promise.allSettled([latencyJob]);
      if (pumpJob) await Promise.allSettled([pumpJob]);
      if (session) {
        if (result) {
          try {
            state.serverStats = await this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), {}, globalSignal, Math.max(1500, 3 * state.rttMs));
            Object.assign(result, state.metadata());
          } catch { result.connections.active = null; }
          result.activeStreams = 0;
          result.streams = 0;
          deleting = this.json(this.url(node.baseUrl, `upload-sessions/${encodeURIComponent(session.id)}`), { method: "DELETE" }, undefined, 1500).catch(() => {});
        }
        await deleting;
      }
    }
  }

  async downloadPhase(node, test, performanceConfig, options, idle, globalSignal) {
    if (performanceConfig.transport === "websocket") return this.websocketDownloadPhase(node, test, performanceConfig, options, idle, globalSignal);
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
              state.captureDownload(value.byteLength, now);
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
      await pause(state.warmupMs + state.durationMs, state.controller.signal).catch((error) => { if (!state.windowFinished || globalSignal.aborted) throw error; });
      if (globalSignal.aborted) throw globalSignal.reason || abortError();
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
          state.serverStats = await this.settleHTTPDownloadConnections(node, run, globalSignal);
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
    if (performanceConfig.transport === "websocket") return this.websocketUploadPhase(node, test, performanceConfig, options, idle, globalSignal);
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
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ warmupMs: state.warmupMs, durationMs: state.durationMs, maxBytes: state.options.maxBytes }),
      }, state.controller.signal, timeoutMs);
      if (!session || typeof session.id !== "string") throw new Error("上传测速会话无效，请更新服务后重试。");
      this.emit({ type: "session-created", id: session.id, baseUrl: node.baseUrl });
      const baseBlob = this.createRandomBlob(state.options.maxBytes ? Math.min(performanceConfig.uploadBlockBytes, state.options.maxBytes) : performanceConfig.uploadBlockBytes);
      uploadBody = createUploadBody(baseBlob, Math.min(performanceConfig.maxUploadBodyBytes, state.options.maxBytes || performanceConfig.maxUploadBodyBytes));
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
        if (await this.checkUploadCompletion(state, session, snapshot, timeoutMs)) {
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
      if (options.testType === "latency") {
        const idle = await this.idleLatency(node, normalized.test.pingSamples, controller.signal);
        ensureActive(controller.signal);
        const result = {
          schemaVersion: 1, testType: options.testType, measurementPolicy: options.measurementPolicy, maxBytes: options.maxBytes,
          startedAt, completedAt: new Date().toISOString(), node, mode: options.mode, transport: null,
          downloadMbps: null, uploadMbps: null, latency: { idle, download: null, upload: null }, download: null, upload: null,
        };
        this.emit({ type: "complete", result });
        return result;
      }
      // One successful unloaded request is sufficient to choose RTT-aware
      // transport and warm-up budgets. Keep all failures and finish the same
      // total idle-probe budget only after both transfer phases clean up.
      const initialIdle = await this.idleLatency(node, normalized.test.pingSamples, controller.signal, { stopAfterFirstSuccess: true });
      const prepared = await this.prepareTransport(normalized, options, initialIdle, controller.signal);
      ensureActive(controller.signal);
      const effective = prepared.config;
      const effectiveNode = effective.nodes[0];
      const download = await this.downloadPhase(effectiveNode, effective.test, effective.performance, prepared.options, initialIdle, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const upload = options.testType === "full" ? await this.uploadPhase(effectiveNode, effective.test, effective.performance, prepared.options, initialIdle, controller.signal) : null;
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const idle = await this.idleLatency(effectiveNode, normalized.test.pingSamples, controller.signal, {
        seedValues: [initialIdle.medianMs], seedFailed: initialIdle.failed || 0, announce: false,
      });
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const result = {
        schemaVersion: 1, testType: options.testType, measurementPolicy: options.measurementPolicy, maxBytes: options.maxBytes,
        startedAt, completedAt: new Date().toISOString(), node: effectiveNode, mode: options.mode, transport: prepared.transport,
        downloadMbps: download.mbps, uploadMbps: upload?.mbps ?? null, latency: { idle, download: download.latency, upload: upload?.latency ?? null }, download, upload,
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
