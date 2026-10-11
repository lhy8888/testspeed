import { loadConfig, SpeedTest } from "./speedtest.js";

const element = (id) => document.getElementById(id);
const ui = {
  start: element("start-button"), startLabel: element("start-label"), startIcon: element("start-icon"),
  stop: element("stop-button"), phase: element("phase-label"), badge: element("phase-badge"),
  status: element("status-message"), error: element("error-message"),
  download: element("download-value"), upload: element("upload-value"),
  idle: element("idle-latency-value"), jitter: element("jitter-value"),
  downloadLoaded: element("download-loaded-value"), uploadLoaded: element("upload-loaded-value"),
  failure: element("failure-rate-value"), traffic: element("traffic-value"),
  progress: element("test-progress"), progressFill: element("progress-fill"),
  node: element("node-name"), dot: element("connection-dot"), previous: element("previous-result"),
  downloadUnit: element("download-unit"), downloadUnitDescription: element("download-unit-description"), uploadUnit: element("upload-unit"),
  settingsFields: element("settings-fields"), settingsSummary: element("settings-summary"),
  autoMode: element("mode-auto"), manualMode: element("mode-manual"), streamCount: element("stream-count"), streamLimit: element("stream-limit"),
  duration: element("measurement-duration"), defaultDuration: element("default-duration"),
  streams: element("streams-value"), tcp: element("tcp-value"), tcpCaption: element("tcp-caption"), protocol: element("protocol-value"),
  rtt: element("rtt-value"), warmup: element("warmup-value"), bdp: element("bdp-value"),
  modeLabel: element("concurrency-mode-label"), bottleneck: element("bottleneck-message"),
};
let config = null;
let connectionController = null;
let running = false;
let phase = "idle";
let stopMessage = "测速已停止，可重新开始。";
let downloadBytes = 0;
let uploadBytes = 0;
let progress = 0;
let curves = { download: [], upload: [] };
let chartDurationMs = 10000;
let peakStreams = 0;
let peakConnections = 0;
let testOptions = null;
let settings = { mode: "auto", streams: 4, durationMs: null };
const settingsKey = "light-speed:settings";

try {
  const saved = JSON.parse(localStorage.getItem(settingsKey));
  if (saved && (saved.mode === "auto" || saved.mode === "manual")) settings.mode = saved.mode;
  if (Number.isInteger(saved?.streams) && saved.streams >= 1) settings.streams = Math.min(saved.streams, 128);
  if ([10000, 20000, 30000].includes(saved?.durationMs)) settings.durationMs = saved.durationMs;
} catch { /* Settings are optional when local storage is unavailable. */ }

const number = (value, decimals = 1) => {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return Math.round(value).toLocaleString("zh-CN");
  if (value >= 100) return value.toFixed(0);
  return value.toFixed(decimals);
};
const speedUnit = (value) => Number.isFinite(value) && value >= 1000 ? "Gbps" : "Mbps";
const speedNumber = (value) => {
  const scaled = speedUnit(value) === "Gbps" ? value / 1000 : value;
  return number(scaled, scaled < 10 ? 2 : 1);
};
const formatSpeed = (value) => `${speedNumber(value)} ${speedUnit(value)}`;
const durationLabel = (milliseconds) => number(milliseconds / 1000, milliseconds % 1000 ? 1 : 0);
const formatTraffic = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
};

function setSpeed(kind, value) {
  const target = kind === "download" ? ui.download : ui.upload;
  target.textContent = speedNumber(value);
  if (Number.isFinite(value)) target.dataset.mbps = String(value);
  else delete target.dataset.mbps;
  (kind === "download" ? ui.downloadUnit : ui.uploadUnit).textContent = speedUnit(value);
  if (kind === "download") {
    ui.download.classList.toggle("compact", target.textContent.length > 5);
    ui.downloadUnitDescription.textContent = speedUnit(value) === "Gbps" ? "千兆比特 / 秒" : "兆比特 / 秒";
  }
}

const setDownload = (value) => setSpeed("download", value);

function maxStreams() {
  return Math.max(1, Math.min(128, config?.performance?.maxStreams || config?.test?.maxStreams || 24));
}

function currentDuration() {
  return settings.durationMs || Math.max(config?.test?.downloadDurationMs || 10000, config?.test?.uploadDurationMs || 10000);
}

function syncSettings() {
  settings.streams = Math.min(maxStreams(), Math.max(1, Math.round(settings.streams)));
  ui.autoMode.checked = settings.mode === "auto";
  ui.manualMode.checked = settings.mode === "manual";
  ui.streamCount.value = String(settings.streams);
  ui.streamCount.max = String(maxStreams());
  ui.streamCount.disabled = running || settings.mode === "auto";
  ui.settingsFields.disabled = running;
  ui.duration.value = settings.durationMs ? String(settings.durationMs) : "";
  const duration = durationLabel(currentDuration());
  ui.defaultDuration.textContent = `节点默认 · ${durationLabel(Math.max(config?.test?.downloadDurationMs || 10000, config?.test?.uploadDurationMs || 10000))} 秒`;
  ui.settingsSummary.textContent = `${settings.mode === "auto" ? "自动适配" : `${settings.streams} 条测速流`} · ${duration} 秒 / 阶段`;
  if (config) ui.streamLimit.textContent = `当前部署支持 ${maxStreams()} 条测速流`;
  if (!curves.download.length && !curves.upload.length) {
    ui.modeLabel.textContent = settings.mode === "auto" ? "自动并发" : `手动 · ${settings.streams} 条流`;
    chartDurationMs = currentDuration();
    drawChart();
  }
}

function updateSettings() {
  settings.mode = ui.manualMode.checked ? "manual" : "auto";
  const count = Number(ui.streamCount.value);
  if (Number.isFinite(count) && count >= 1) settings.streams = Math.round(count);
  settings.durationMs = ["10000", "20000", "30000"].includes(ui.duration.value) ? Number(ui.duration.value) : null;
  syncSettings();
  try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch { /* Optional local preference storage. */ }
}

function protocolLabel(protocols) {
  const values = Array.isArray(protocols) ? protocols : typeof protocols === "string" ? [protocols] : protocols && typeof protocols === "object" ? Object.keys(protocols) : [];
  const labels = values.map((value) => ({ "h2": "HTTP/2", "h3": "HTTP/3", "http/1.1": "HTTP/1.1", "http/2.0": "HTTP/2", "http/3.0": "HTTP/3" }[String(value).toLowerCase()] || String(value)));
  return [...new Set(labels)].join(" + ") || "—";
}

function updateDiagnostics(update) {
  const active = Number.isFinite(update.activeStreams) ? update.activeStreams : update.streams;
  if (Number.isFinite(active)) {
    peakStreams = Math.max(peakStreams, update.peakStreams || active);
    ui.streams.textContent = `${number(active, 0)} / ${number(peakStreams, 0)}`;
    ui.streams.dataset.active = String(active);
    ui.streams.dataset.peak = String(peakStreams);
    if (Number.isFinite(update.requestedStreams)) ui.streams.dataset.requested = String(update.requestedStreams);
  }
  const connections = update.connections;
  if (connections) {
    const hasActiveCount = Number.isFinite(connections.active);
    const current = hasActiveCount ? connections.active : connections.observed;
    if (Number.isFinite(current)) {
      peakConnections = Math.max(peakConnections, connections.peak || 0, hasActiveCount ? current : 0);
      ui.tcp.textContent = hasActiveCount || peakConnections ? `${number(current, 0)} / ${number(peakConnections, 0)}` : number(current, 0);
      ui.tcpCaption.textContent = hasActiveCount ? "当前 / 峰值" : peakConnections ? "已观测 / 峰值" : "累计观测";
      if (Number.isFinite(connections.observed)) ui.tcp.dataset.observed = String(connections.observed);
      if (hasActiveCount) ui.tcp.dataset.active = String(connections.active);
      else delete ui.tcp.dataset.active;
      ui.tcp.dataset.peak = String(peakConnections);
      ui.tcp.dataset.scope = connections.scope || "server";
    }
    const protocol = protocolLabel(connections.protocols);
    if (protocol !== "—") ui.protocol.textContent = protocol;
  }
  if (Number.isFinite(update.rttMs)) ui.rtt.textContent = number(update.rttMs);
  if (Number.isFinite(update.warmupMs)) ui.warmup.textContent = `${durationLabel(update.warmupMs)} 秒`;
  if (Number.isFinite(update.bdpBytes)) {
    ui.bdp.textContent = formatTraffic(update.bdpBytes);
    ui.bdp.dataset.bytes = String(update.bdpBytes);
  }
  if (typeof update.bottleneck === "string" && update.bottleneck) {
    const message = {
      "client-scheduling": "浏览器计时出现持续延迟，结果可能受客户端调度影响。",
      "control-shared-origin": "测速流与延迟探测共用连接，负载延迟可能包含浏览器排队时间。",
    }[update.bottleneck];
    if (message) {
      ui.bottleneck.textContent = message;
      ui.bottleneck.hidden = false;
    }
  }
}

function setProgress(value) {
  progress = Math.max(progress, Math.min(1, Math.max(0, value)));
  ui.progress.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  ui.progressFill.style.width = `${progress * 100}%`;
}

function setStage(next) {
  phase = next;
  const stages = ["latency", "download", "upload", "complete"];
  const index = stages.indexOf(next);
  for (const item of document.querySelectorAll("[data-stage]")) {
    const position = stages.indexOf(item.dataset.stage);
    item.classList.toggle("active", position === index);
    item.classList.toggle("done", position < index);
  }
  ui.badge.classList.toggle("running", running && next !== "complete");
  ui.badge.classList.toggle("complete", next === "complete");
  ui.phase.textContent = { idle: "准备就绪", latency: "正在连接", download: "正在测量下载", upload: "正在测量上传", complete: "测速完成", stopped: "测速已停止", error: "连接遇到问题" }[next];
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = "";
}

function showError(error) {
  ui.error.textContent = error instanceof TypeError ? "无法连接测速服务，请检查网络后重试。" : error.message || "测速暂时不可用，请稍后重试。";
  ui.error.hidden = false;
  ui.dot.className = "connection-dot disconnected";
  setStage("error");
  ui.status.textContent = "请检查连接后再试一次。";
}

function setRunning(value) {
  running = value;
  ui.start.hidden = value;
  ui.stop.hidden = !value;
  ui.start.disabled = value;
  syncSettings();
}

function resetMetrics() {
  [ui.download, ui.upload, ui.idle, ui.jitter, ui.downloadLoaded, ui.uploadLoaded, ui.failure, ui.traffic].forEach((item) => { item.textContent = "—"; });
  ui.download.classList.remove("compact");
  setSpeed("download", null);
  setSpeed("upload", null);
  [ui.streams, ui.tcp].forEach((item) => { item.textContent = "— / —"; });
  [ui.protocol, ui.rtt, ui.bdp].forEach((item) => { item.textContent = "—"; });
  for (const item of [ui.streams, ui.tcp, ui.bdp]) for (const key of Object.keys(item.dataset)) delete item.dataset[key];
  ui.warmup.textContent = "随 RTT 调整";
  ui.tcpCaption.textContent = "当前 / 峰值";
  ui.bottleneck.hidden = true;
  ui.bottleneck.textContent = "";
  peakStreams = 0;
  peakConnections = 0;
  curves = { download: [], upload: [] };
  downloadBytes = 0;
  uploadBytes = 0;
  progress = 0;
  setProgress(0);
  drawChart();
}

function drawChart() {
  const samples = [...curves.download, ...curves.upload];
  const max = Math.max(1, ...samples.map((point) => point.mbps)) * 1.12;
  const duration = chartDurationMs;
  for (const kind of ["download", "upload"]) {
    const points = curves[kind];
    const coordinates = points.map((point) => `${Math.min(960, point.elapsedMs / duration * 960).toFixed(1)},${(148 - Math.min(1, point.mbps / max) * 130).toFixed(1)}`);
    const line = coordinates.length ? `M${coordinates.join(" L")}` : "";
    element(`${kind}-line`).setAttribute("d", line);
    element(`${kind}-area`).setAttribute("d", coordinates.length ? `${line} L${coordinates.at(-1).split(",")[0]},148 L${coordinates[0].split(",")[0]},148 Z` : "");
  }
  element("chart-empty").hidden = samples.length > 0;
  element("chart-max").hidden = !samples.length;
  element("chart-max").textContent = formatSpeed(max);
  element("chart-duration").textContent = `${number(duration / 1000, 0)} 秒 / 阶段`;
}

function onUpdate(update) {
  if (update.type === "phase") {
    setStage(update.phase);
    if (Number.isFinite(update.durationMs)) chartDurationMs = update.durationMs;
    updateDiagnostics(update);
    ui.status.textContent = update.phase === "latency" ? "正在检查连接并测量空闲延迟…" : "正在预热连接，准备测量…";
  } else if (update.type === "latency") {
    if (update.phase === "idle") {
      ui.idle.textContent = number(update.stats.medianMs);
      ui.rtt.textContent = number(update.stats.medianMs);
      ui.jitter.textContent = number(update.stats.jitterMs);
    } else {
      (update.phase === "download" ? ui.downloadLoaded : ui.uploadLoaded).textContent = number(update.stats.medianMs);
    }
  } else if (update.type === "progress") {
    if (update.phase === "latency") {
      setProgress(update.progress * .05);
    } else {
      const isDownload = update.phase === "download";
      updateDiagnostics(update);
      setProgress((isDownload ? .05 : .52) + update.progress * .47);
      if (!update.warmingUp) {
        if (isDownload) setDownload(update.mbps);
        else setSpeed("upload", update.mbps);
      }
      if (isDownload) downloadBytes = update.totalBytes;
      else uploadBytes = update.totalBytes;
      ui.traffic.textContent = formatTraffic(downloadBytes + uploadBytes);
      ui.status.textContent = update.warmingUp ? "正在预热连接，准备测量…" : `正在测量${isDownload ? "下载" : "上传"}速度，还需约 ${Math.ceil(update.remainingMs / 1000)} 秒`;
      curves[update.phase] = update.points;
      drawChart();
    }
  } else if (update.type === "phase-complete") {
    updateDiagnostics(update.result);
    if (update.phase === "download") {
      setDownload(update.result.mbps);
      downloadBytes = update.result.totalBytes;
    } else {
      setSpeed("upload", update.result.mbps);
      uploadBytes = update.result.totalBytes;
    }
  } else if (update.type === "complete") {
    const result = update.result;
    setStage("complete");
    setProgress(1);
    setDownload(result.downloadMbps);
    setSpeed("upload", result.uploadMbps);
    updateDiagnostics(result.download);
    updateDiagnostics(result.upload);
    ui.traffic.textContent = formatTraffic(result.download.totalBytes + result.upload.totalBytes);
    const latency = Object.values(result.latency);
    const failed = result.download.failedRequests + result.upload.failedRequests + latency.reduce((sum, item) => sum + item.failed, 0);
    const requests = result.download.requests + result.upload.requests + latency.reduce((sum, item) => sum + item.attempts, 0);
    ui.failure.textContent = number(requests ? failed / requests * 100 : 0);
    const noLoadedSamples = !result.latency.download.samples || !result.latency.upload.samples;
    ui.status.textContent = failed || noLoadedSamples ? "测速完成；部分请求未成功，结果可能受当前网络状态影响。" : "测速完成，结果反映此刻到当前节点的连接表现。";
    ui.dot.className = "connection-dot connected";
    try {
      localStorage.setItem("light-speed:last-result", JSON.stringify({ completedAt: result.completedAt, downloadMbps: result.downloadMbps, uploadMbps: result.uploadMbps }));
    } catch { /* Storage may be disabled; it is optional. */ }
  }
}

const speedtest = new SpeedTest({ onUpdate });

async function connect() {
  const controller = new AbortController();
  connectionController = controller;
  try {
    config = await loadConfig({ signal: controller.signal });
  } finally {
    if (connectionController === controller) connectionController = null;
  }
  ui.node.textContent = config.nodes[0].name;
  ui.dot.className = "connection-dot connected";
  syncSettings();
  drawChart();
}

async function start() {
  if (running) return;
  clearError();
  updateSettings();
  resetMetrics();
  setRunning(true);
  stopMessage = "测速已停止，可重新开始。";
  try {
    if (navigator.onLine === false) throw new Error("当前设备处于离线状态，请恢复网络连接后重试。");
    if (!config) {
      setStage("latency");
      ui.status.textContent = "正在连接测速服务…";
      await connect();
      // A user may stop while the configuration request is in flight.
      if (!running) return;
    }
    testOptions = { mode: settings.mode, streams: settings.streams, ...(settings.durationMs ? { durationMs: settings.durationMs } : {}) };
    chartDurationMs = currentDuration();
    ui.modeLabel.textContent = testOptions.mode === "auto" ? "自动并发" : `手动 · ${testOptions.streams} 条流`;
    await speedtest.run(config, testOptions);
  } catch (error) {
    if (error.name === "AbortError") {
      setStage("stopped");
      ui.status.textContent = stopMessage;
    } else {
      showError(error);
    }
  } finally {
    setRunning(false);
    ui.startLabel.textContent = "再测一次";
    ui.startIcon.className = "";
    ui.startIcon.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-refresh"></use></svg>';
    ui.start.setAttribute("aria-label", "再测一次");
    if (phase !== "complete") ui.badge.classList.remove("running");
  }
}

ui.start.addEventListener("click", start);
for (const control of [ui.autoMode, ui.manualMode, ui.streamCount, ui.duration]) control.addEventListener("change", updateSettings);
ui.stop.addEventListener("click", () => {
  connectionController?.abort(new DOMException("测速已停止", "AbortError"));
  if (speedtest.controller) speedtest.cancel();
  else {
    setRunning(false);
    setStage("stopped");
    ui.status.textContent = stopMessage;
  }
});

window.addEventListener("offline", () => {
  ui.dot.className = "connection-dot disconnected";
  if (running) {
    stopMessage = "网络连接已断开，请恢复连接后重新测速。";
    connectionController?.abort(new DOMException(stopMessage, "AbortError"));
    speedtest.cancel(stopMessage);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) {
    stopMessage = "页面已切到后台，请保持页面在前台后重新测速。";
    connectionController?.abort(new DOMException(stopMessage, "AbortError"));
    speedtest.cancel(stopMessage);
  }
});

try {
  const previous = JSON.parse(localStorage.getItem("light-speed:last-result"));
  if (previous && Number.isFinite(previous.downloadMbps) && Number.isFinite(previous.uploadMbps) && !Number.isNaN(Date.parse(previous.completedAt))) {
    const time = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(previous.completedAt));
    ui.previous.textContent = `上次测速 ${time} · 下载 ${formatSpeed(previous.downloadMbps)} · 上传 ${formatSpeed(previous.uploadMbps)}`;
    ui.previous.hidden = false;
  }
} catch { /* Previous results never block a test. */ }

syncSettings();
connect().then(() => {
  setStage("idle");
  ui.status.textContent = "点击开始，自动测量当前连接。";
}).catch((error) => {
  showError(error);
  ui.startLabel.textContent = "重试连接";
  ui.start.setAttribute("aria-label", "重试连接");
}).finally(() => {
  ui.start.disabled = false;
});
