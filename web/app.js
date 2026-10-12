import { loadConfig, SpeedTest } from "./speedtest.js";
import { t, setLanguage, getLanguage, applyLanguageText, onLanguageChange, translateError } from "./i18n.js";

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
  streamCountLabel: element("stream-count-label"), streamMetricLabel: element("stream-metric-label"), streamExplanation: element("stream-explanation"),
  streams: element("streams-value"), tcp: element("tcp-value"), tcpCaption: element("tcp-caption"), protocol: element("protocol-value"),
  rtt: element("rtt-value"), warmup: element("warmup-value"), bdp: element("bdp-value"),
  modeLabel: element("concurrency-mode-label"), bottleneck: element("bottleneck-message"),
  transportMessage: element("transport-message"),
  more: element("more-details"), moreButton: element("more-info-button"), language: element("language-select"),
};
let config = null;
let connectionController = null;
let running = false;
let phase = "idle";
let stopMessageKey = "stopped";
let statusState = { key: "connecting", params: {} };
let lastError = null;
let errorDuringTransfer = false;
let previousResult = null;
let hasRun = false;
let downloadComplete = false;
let lastDiagnostics = null;
let downloadBytes = 0;
let uploadBytes = 0;
let progress = 0;
let curves = { download: [], upload: [] };
let chartDurationMs = 10000;
let peakStreams = 0;
let peakConnections = 0;
let testOptions = null;
let transportState = null;
let runtimeMaxStreams = null;
let settings = { mode: "manual", streams: 8, durationMs: null };
let hasSavedSettings = false;
const settingsKey = "light-speed:settings:v3";

try {
  const saved = JSON.parse(localStorage.getItem(settingsKey));
  if (saved && (saved.mode === "auto" || saved.mode === "manual")) { settings.mode = saved.mode; hasSavedSettings = true; }
  if (Number.isInteger(saved?.streams) && saved.streams >= 1) { settings.streams = Math.min(saved.streams, 30); hasSavedSettings = true; }
  if ([10000, 20000, 30000].includes(saved?.durationMs)) { settings.durationMs = saved.durationMs; hasSavedSettings = true; }
} catch { /* Settings are optional when local storage is unavailable. */ }

const number = (value, decimals = 1) => {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return Math.round(value).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en");
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
    ui.downloadUnitDescription.textContent = t(speedUnit(value) === "Gbps" ? "unitGbpsDescription" : "unitMbpsDescription");
  }
}

const setDownload = (value) => setSpeed("download", value);

function configuredMaxStreams() {
  return Math.max(1, Math.min(30, config?.performance?.maxStreams || config?.test?.maxStreams || 30));
}

function maxStreams() {
  return Math.min(configuredMaxStreams(), runtimeMaxStreams || configuredMaxStreams());
}

function currentDuration() {
  return settings.durationMs || Math.max(config?.test?.downloadDurationMs || 10000, config?.test?.uploadDurationMs || 10000);
}

function usesWebSocket() {
  return (transportState?.transport || config?.performance?.transport || (config ? "http" : "websocket")) === "websocket";
}

function syncSettings() {
  settings.streams = Math.min(30, Math.max(1, Math.round(settings.streams)));
  const effectiveStreams = Math.min(maxStreams(), settings.streams);
  ui.autoMode.checked = settings.mode === "auto";
  ui.manualMode.checked = settings.mode === "manual";
  ui.streamCount.value = String(effectiveStreams);
  ui.streamCount.max = String(maxStreams());
  ui.streamCount.disabled = running || settings.mode === "auto";
  ui.settingsFields.disabled = running;
  ui.duration.value = settings.durationMs ? String(settings.durationMs) : "";
  const duration = durationLabel(currentDuration());
  ui.defaultDuration.textContent = t("defaultDuration", { seconds: durationLabel(Math.max(config?.test?.downloadDurationMs || 10000, config?.test?.uploadDurationMs || 10000)) });
  ui.settingsSummary.textContent = t("settingsSummary", { mode: settings.mode === "auto" ? t("automatic") : t("concurrencyCount", { count: effectiveStreams }), seconds: duration });
  if (config) ui.streamLimit.textContent = usesWebSocket()
    ? t("streamLimitWs", { count: maxStreams() })
    : t("streamLimitHttp", { count: maxStreams() });
  ui.streamCountLabel.textContent = t(usesWebSocket() ? "concurrencyConnections" : "concurrencyFlows");
  ui.streamMetricLabel.textContent = t(usesWebSocket() ? "streamConnections" : "streamFlows");
  ui.streamExplanation.textContent = t(usesWebSocket() ? "streamExplanationWs" : "streamExplanationHttp");
  if (!curves.download.length && !curves.upload.length) {
    ui.modeLabel.textContent = settings.mode === "auto" ? t("automatic") : t("manualModeLabel", { count: effectiveStreams });
    chartDurationMs = currentDuration();
    drawChart();
  }
  if (!running && !curves.download.length && !curves.upload.length && transportState) renderTransportMessage();
}

function updateSettings(event) {
  settings.mode = ui.manualMode.checked ? "manual" : "auto";
  const count = Number(ui.streamCount.value);
  const shownCount = Math.min(settings.streams, maxStreams());
  if (Number.isFinite(count) && count >= 1 && (event?.target === ui.streamCount || count !== shownCount)) {
    settings.streams = Math.min(maxStreams(), Math.round(count));
  }
  settings.durationMs = ["10000", "20000", "30000"].includes(ui.duration.value) ? Number(ui.duration.value) : null;
  syncSettings();
  hasSavedSettings = true;
  try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch { /* Optional local preference storage. */ }
}

function renderTransportMessage() {
  const update = transportState;
  if (!update) return;
  const unavailable = Array.isArray(update.unreachableOrigins) && update.unreachableOrigins.length > 0;
  const single = update.mode === "single-origin";
  const websocketFallback = update.reason === "websocket-unavailable";
  const currentMode = running || phase === "complete" ? testOptions?.mode || settings.mode : settings.mode;
  const effective = (running || phase === "complete") && Number.isFinite(update.effectiveStreams) ? update.effectiveStreams : Math.min(settings.streams, maxStreams());
  let message = "";
  if (usesWebSocket()) message = t("wsTransport", { mode: currentMode === "auto" ? t("automatic") : t("concurrencyCount", { count: effective }) });
  else if (websocketFallback) message = t("wsFallback", { count: maxStreams() });
  else if (update.fallback) message = t("httpFallback", { count: maxStreams() });
  else if (unavailable) message = t("partialOrigins", { count: maxStreams() });
  else if (single) message = t("singleHttpTransport", { count: maxStreams() });
  if (update.streamsAdjusted && testOptions?.mode === "manual") {
    message += ` ${t("streamsAdjusted", { from: update.requestedStreams, to: update.effectiveStreams })}`;
  }
  if (websocketFallback) message += ` ${t("wsFallbackHint")}`;
  else if (unavailable || update.fallback) message += ` ${t("httpFallbackHint")}`;
  ui.transportMessage.textContent = message;
  ui.transportMessage.hidden = !message;
  ui.transportMessage.classList.toggle("is-fallback", Boolean(unavailable || update.fallback));
}

function updateTransport(update) {
  if (!Number.isFinite(update.maxStreams) || update.maxStreams < 1) return;
  runtimeMaxStreams = Math.min(configuredMaxStreams(), Math.round(update.maxStreams));
  transportState = { ...update, maxStreams: runtimeMaxStreams };
  for (const key of ["transport", "mode", "reason", "fallback", "maxStreams", "requestedStreams", "effectiveStreams"]) {
    if (update[key] !== undefined) ui.transportMessage.dataset[key] = String(update[key]);
    else delete ui.transportMessage.dataset[key];
  }
  syncSettings();
  renderTransportMessage();
  if (usesWebSocket() && update.reason !== "single-origin-config" && !ui.protocol.textContent.startsWith("WebSocket")) ui.protocol.textContent = "WebSocket";
  else if (!usesWebSocket() && ui.protocol.textContent.startsWith("WebSocket")) ui.protocol.textContent = "—";
  if (testOptions?.mode === "manual" && Number.isFinite(update.effectiveStreams)) {
    ui.modeLabel.textContent = t("manualModeLabel", { count: update.effectiveStreams });
  }
}

function showConfiguredTransport() {
  const origins = config?.performance?.measurementOrigins;
  if (Array.isArray(origins) && origins.length === 1) {
    updateTransport({ transport: config.performance.transport, mode: "single-origin", reason: "single-origin-config", fallback: false, origins, maxStreams: configuredMaxStreams() });
  }
}

function finishInterruptedDiagnostics() {
  ui.streams.textContent = `0 / ${peakStreams ? number(peakStreams, 0) : "—"}`;
  ui.streams.dataset.active = "0";
  delete ui.tcp.dataset.active;
  ui.tcp.textContent = `— / ${peakConnections ? number(peakConnections, 0) : "—"}`;
  ui.tcpCaption.textContent = t("currentUnknownPeak");
}

function protocolLabel(protocols) {
  const values = Array.isArray(protocols) ? protocols : typeof protocols === "string" ? [protocols] : protocols && typeof protocols === "object" ? Object.keys(protocols) : [];
  const labels = values.map((value) => ({ "h2": "HTTP/2", "h3": "HTTP/3", "http/1.1": "HTTP/1.1", "http/2.0": "HTTP/2", "http/3.0": "HTTP/3" }[String(value).toLowerCase()] || String(value)));
  return [...new Set(labels)].join(" + ") || "—";
}

function updateDiagnostics(update) {
  lastDiagnostics = { ...lastDiagnostics, ...update };
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
      ui.tcpCaption.textContent = t(hasActiveCount ? "currentPeak" : peakConnections ? "observedPeak" : "observedTotal");
      if (Number.isFinite(connections.observed)) ui.tcp.dataset.observed = String(connections.observed);
      if (hasActiveCount) ui.tcp.dataset.active = String(connections.active);
      else delete ui.tcp.dataset.active;
      ui.tcp.dataset.peak = String(peakConnections);
      ui.tcp.dataset.scope = connections.scope || "server";
    }
    const protocol = protocolLabel(connections.protocols);
    if (protocol !== "—") ui.protocol.textContent = usesWebSocket() ? `WebSocket · ${protocol}` : protocol;
  }
  if (Number.isFinite(update.rttMs)) ui.rtt.textContent = number(update.rttMs);
  if (Number.isFinite(update.warmupMs)) ui.warmup.textContent = t("secondsUnit", { seconds: durationLabel(update.warmupMs) });
  if (Number.isFinite(update.bdpBytes)) {
    ui.bdp.textContent = formatTraffic(update.bdpBytes);
    ui.bdp.dataset.bytes = String(update.bdpBytes);
  }
  if (typeof update.bottleneck === "string" && update.bottleneck) {
    const message = {
      "client-scheduling": t("clientScheduling"),
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
  ui.phase.dataset.phase = next;
  ui.download.classList.toggle("measuring", next === "download" && !downloadComplete);
  const stages = ["latency", "download", "upload", "complete"];
  const index = stages.indexOf(next);
  for (const item of document.querySelectorAll("[data-stage]")) {
    const position = stages.indexOf(item.dataset.stage);
    item.classList.toggle("active", position === index);
    item.classList.toggle("done", position < index);
  }
  ui.badge.classList.toggle("running", running && next !== "complete");
  ui.badge.classList.toggle("complete", next === "complete");
  ui.phase.textContent = t(`phase${next[0].toUpperCase()}${next.slice(1)}`);
}

function setStatus(key, params = {}) {
  statusState = { key, params };
  ui.status.textContent = t(key, params);
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = "";
  lastError = null;
}

function showError(error, transferFailed = phase === "download" || phase === "upload") {
  lastError = error;
  errorDuringTransfer = transferFailed;
  const hint = usesWebSocket()
    ? t("wsHint")
    : t("httpHint");
  ui.error.textContent = error instanceof TypeError
    ? transferFailed ? `${t("transferError")} ${hint}` : t("configError")
    : translateError(error);
  ui.error.hidden = false;
  ui.dot.className = "connection-dot disconnected";
  setStage("error");
  setStatus(transferFailed ? usesWebSocket() ? "wsHint" : "httpHint" : "serviceHint");
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
  downloadComplete = false;
  lastDiagnostics = null;
  setSpeed("download", null);
  setSpeed("upload", null);
  [ui.streams, ui.tcp].forEach((item) => { item.textContent = "— / —"; });
  [ui.protocol, ui.rtt, ui.bdp].forEach((item) => { item.textContent = "—"; });
  for (const item of [ui.streams, ui.tcp, ui.bdp]) for (const key of Object.keys(item.dataset)) delete item.dataset[key];
  ui.warmup.textContent = t("warmupPending");
  ui.tcpCaption.textContent = t("currentPeak");
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
  element("chart-duration").textContent = t("chartDuration", { seconds: number(duration / 1000, 0) });
}

function onUpdate(update) {
  if (update.type === "transport") {
    updateTransport(update);
  } else if (update.type === "phase") {
    setStage(update.phase);
    if (Number.isFinite(update.durationMs)) chartDurationMs = update.durationMs;
    updateDiagnostics(update);
    setStatus(update.phase === "latency" ? "statusLatency" : "statusWarmup");
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
        if (isDownload && !downloadComplete) setDownload(update.mbps);
      }
      if (isDownload) downloadBytes = update.totalBytes;
      else uploadBytes = update.totalBytes;
      ui.traffic.textContent = formatTraffic(downloadBytes + uploadBytes);
      setStatus(update.warmingUp ? "statusWarmup" : "statusTransfer", { direction: t(isDownload ? "downloadLabel" : "uploadLabel"), seconds: Math.ceil(update.remainingMs / 1000) });
      curves[update.phase] = update.points;
      drawChart();
    }
  } else if (update.type === "phase-complete") {
    updateDiagnostics(update.result);
    if (update.phase === "download") {
      downloadComplete = true;
      ui.download.classList.remove("measuring");
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
    if (result.transport) updateTransport(result.transport);
    ui.traffic.textContent = formatTraffic(result.download.totalBytes + result.upload.totalBytes);
    const latency = Object.values(result.latency);
    const failed = result.download.failedRequests + result.upload.failedRequests + latency.reduce((sum, item) => sum + item.failed, 0);
    const requests = result.download.requests + result.upload.requests + latency.reduce((sum, item) => sum + item.attempts, 0);
    ui.failure.textContent = number(requests ? failed / requests * 100 : 0);
    const noLoadedSamples = !result.latency.download.samples || !result.latency.upload.samples;
    setStatus(failed || noLoadedSamples ? "statusPartial" : "statusComplete");
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
  ui.node.textContent = config.nodes[0].name === "默认测速节点" ? t("defaultNode") : config.nodes[0].name;
  ui.dot.className = "connection-dot connected";
  if (!hasSavedSettings) {
    settings.mode = config.performance?.defaultMode === "auto" ? "auto" : "manual";
    settings.streams = Math.max(1, Math.min(30, config.performance?.defaultStreams || 8));
  }
  syncSettings();
  showConfiguredTransport();
  drawChart();
}

async function start() {
  if (running) return;
  clearError();
  updateSettings();
  runtimeMaxStreams = null;
  transportState = null;
  ui.transportMessage.hidden = true;
  ui.transportMessage.textContent = "";
  for (const key of Object.keys(ui.transportMessage.dataset)) delete ui.transportMessage.dataset[key];
  resetMetrics();
  setRunning(true);
  showConfiguredTransport();
  stopMessageKey = "stopped";
  try {
    if (navigator.onLine === false) throw new Error(t("offline"));
    if (!config) {
      setStage("latency");
      setStatus("connecting");
      await connect();
      // A user may stop while the configuration request is in flight.
      if (!running) return;
    }
    testOptions = { mode: settings.mode, streams: Math.min(settings.streams, configuredMaxStreams()), ...(settings.durationMs ? { durationMs: settings.durationMs } : {}) };
    chartDurationMs = currentDuration();
    ui.modeLabel.textContent = testOptions.mode === "auto" ? t("automatic") : t("manualModeLabel", { count: testOptions.streams });
    await speedtest.run(config, testOptions);
  } catch (error) {
    if (error.name === "AbortError") {
      setStage("stopped");
      setStatus(stopMessageKey);
    } else {
      showError(error);
    }
  } finally {
    if (phase !== "complete") finishInterruptedDiagnostics();
    setRunning(false);
    hasRun = true;
    ui.startLabel.textContent = t("retest");
    ui.startIcon.className = "";
    ui.startIcon.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-refresh"></use></svg>';
    ui.start.setAttribute("aria-label", t("retest"));
    if (phase !== "complete") ui.badge.classList.remove("running");
  }
}

ui.start.addEventListener("click", start);
for (const control of [ui.autoMode, ui.manualMode, ui.streamCount, ui.duration]) control.addEventListener("change", updateSettings);
ui.stop.addEventListener("click", () => {
  connectionController?.abort(new DOMException(t("stopped"), "AbortError"));
  if (speedtest.controller) speedtest.cancel();
  else {
    setRunning(false);
    setStage("stopped");
    setStatus(stopMessageKey);
  }
});

window.addEventListener("offline", () => {
  ui.dot.className = "connection-dot disconnected";
  if (running) {
    stopMessageKey = "offline";
    connectionController?.abort(new DOMException(t(stopMessageKey), "AbortError"));
    speedtest.cancel(t(stopMessageKey));
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) {
    stopMessageKey = "hiddenStop";
    connectionController?.abort(new DOMException(t(stopMessageKey), "AbortError"));
    speedtest.cancel(t(stopMessageKey));
  }
});

try {
  const previous = JSON.parse(localStorage.getItem("light-speed:last-result"));
  if (previous && Number.isFinite(previous.downloadMbps) && Number.isFinite(previous.uploadMbps) && !Number.isNaN(Date.parse(previous.completedAt))) {
    previousResult = previous;
    ui.previous.hidden = false;
  }
} catch { /* Previous results never block a test. */ }

function renderPrevious() {
  if (!previousResult) return;
  const time = new Intl.DateTimeFormat(getLanguage() === "zh" ? "zh-CN" : "en", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(previousResult.completedAt));
  ui.previous.textContent = t("previousResult", { time, download: formatSpeed(previousResult.downloadMbps), upload: formatSpeed(previousResult.uploadMbps) });
}

function renderLanguage() {
  applyLanguageText();
  ui.language.value = getLanguage();
  ui.moreButton.textContent = t(ui.more.hidden ? "moreInfo" : "lessInfo");
  ui.startLabel.textContent = t(hasRun ? "retest" : "start");
  ui.start.setAttribute("aria-label", t(hasRun ? "retest" : "start"));
  ui.stop.setAttribute("aria-label", t("stop"));
  ui.phase.textContent = t(`phase${phase[0].toUpperCase()}${phase.slice(1)}`);
  ui.downloadUnitDescription.textContent = t(ui.downloadUnit.textContent === "Gbps" ? "unitGbpsDescription" : "unitMbpsDescription");
  if (statusState.key === "statusTransfer") statusState.params.direction = t(phase === "download" ? "downloadLabel" : "uploadLabel");
  ui.status.textContent = t(statusState.key, statusState.params);
  if (config) ui.node.textContent = config.nodes[0].name === "默认测速节点" ? t("defaultNode") : config.nodes[0].name;
  syncSettings();
  if (testOptions && (running || curves.download.length || curves.upload.length)) {
    ui.modeLabel.textContent = testOptions.mode === "auto" ? t("automatic") : t("manualModeLabel", { count: transportState?.effectiveStreams || testOptions.streams });
  }
  if (transportState) renderTransportMessage();
  if (lastDiagnostics) updateDiagnostics(lastDiagnostics);
  else ui.warmup.textContent = t("warmupPending");
  if (phase === "stopped" || phase === "error") finishInterruptedDiagnostics();
  if (lastError) showError(lastError, errorDuringTransfer);
  drawChart();
  renderPrevious();
}

ui.moreButton.addEventListener("click", () => {
  ui.more.hidden = !ui.more.hidden;
  ui.moreButton.setAttribute("aria-expanded", String(!ui.more.hidden));
  ui.moreButton.textContent = t(ui.more.hidden ? "moreInfo" : "lessInfo");
});
ui.language.addEventListener("change", () => setLanguage(ui.language.value));
onLanguageChange(renderLanguage);

renderLanguage();
connect().then(() => {
  setStage("idle");
  setStatus("statusIdle");
}).catch((error) => {
  showError(error);
  ui.startLabel.textContent = t("retryConnection");
  ui.start.setAttribute("aria-label", t("retryConnection"));
}).finally(() => {
  ui.start.disabled = false;
});
