import { loadConfig, SpeedTest } from "./speedtest.js";
import { t, setLanguage, getLanguage, applyLanguageText, onLanguageChange, translateError, localizeCountry } from "./i18n.js";
import { SETTINGS_KEY, normalizeSettings, readSettings, readHistory, appendHistory, clearHistory, normalizeResult, toShareRecord, resultJSON, resultsCSV } from "./results.js";

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
  clientIp: element("client-ip"), clientLocation: element("client-location"), serverLocation: element("server-location"),
  clientLocationNote: element("client-location-note"), serverLocationNote: element("server-location-note"),
  clientIsp: element("client-isp"), clientAsn: element("client-asn"), serverIsp: element("server-isp"),
  testType: element("test-type"), policy: element("measurement-policy"), budget: element("traffic-budget"), title: element("page-title"),
  customBudget: element("custom-budget-mib"), customBudgetRow: element("custom-budget-row"),
  completionNote: element("completion-note"), historySelect: element("history-select"), historyClear: element("history-clear"), historySummary: element("history-summary"), historyStatus: element("history-status"),
  exportJSON: element("export-json"), exportCSV: element("export-csv"), exportPNG: element("export-png"), exportHistoryCSV: element("export-history-csv"),
  shareTools: element("share-tools"), shareTokenLabel: element("share-token-label"), shareToken: element("share-token"), shareResult: element("share-result"), shareRevoke: element("share-revoke"), shareStatus: element("share-status"), shareLink: element("share-link"),
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
let storage = null;
try { storage = globalThis.localStorage; } catch { /* Private browsing still supports tests and session-only history. */ }
const savedSettings = readSettings(storage);
let settings = savedSettings.settings;
let hasSavedSettings = savedSettings.saved;
let networkInfo = { status: "loading", data: null };
let displayType = settings.testType;
let history = readHistory(storage);
let lastResult = null;
let activeShare = null;
let shareBusy = false;
let historyStatusKey = "";
let shareStatusKey = "";

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

function setSpeed(kind, value, { preview = false } = {}) {
  const target = kind === "download" ? ui.download : ui.upload;
  const measured = Number.isFinite(value) && value >= 0;
  target.textContent = measured ? speedNumber(value) : "0";
  target.classList.toggle("is-pending", !measured);
  delete target.dataset.skipped;
  if (measured && !preview) target.dataset.mbps = String(value);
  else delete target.dataset.mbps;
  if (measured && preview) target.dataset.previewMbps = String(value);
  else delete target.dataset.previewMbps;
  (kind === "download" ? ui.downloadUnit : ui.uploadUnit).textContent = speedUnit(value);
  if (kind === "download") {
    target.classList.toggle("is-settled", measured && downloadComplete);
    ui.download.classList.toggle("compact", target.textContent.length > 5);
    ui.downloadUnitDescription.textContent = t(speedUnit(value) === "Gbps" ? "unitGbpsDescription" : "unitMbpsDescription");
  }
}

const setDownload = (value, options) => setSpeed("download", value, options);

function setHeroLatency(value, settled = false) {
  const measured = Number.isFinite(value) && value >= 0;
  ui.download.textContent = measured ? number(value) : "0";
  ui.download.classList.toggle("is-pending", !measured);
  ui.download.classList.toggle("is-settled", measured && settled);
  ui.download.classList.toggle("compact", ui.download.textContent.length > 5);
  delete ui.download.dataset.mbps;
  delete ui.download.dataset.previewMbps;
  if (measured) ui.download.dataset.latencyMs = String(value);
  else delete ui.download.dataset.latencyMs;
  ui.downloadUnit.textContent = "ms";
  ui.downloadUnitDescription.textContent = t("unitMsDescription");
}

function setSkipped(kind) {
  setSpeed(kind, null);
  (kind === "download" ? ui.download : ui.upload).textContent = t("notTested");
  (kind === "download" ? ui.download : ui.upload).dataset.skipped = "true";
  (kind === "download" ? ui.downloadUnit : ui.uploadUnit).textContent = "";
}

function renderHeroTitle() {
  const key = displayType === "latency" ? "latencyPageTitle" : "pageTitle";
  ui.title.dataset.i18n = key;
  ui.title.textContent = t(key);
}

function networkText(value) {
  return typeof value === "string" ? value.trim().slice(0, 256) : "";
}

function renderNetworkLocation(subject, target, note, isServer) {
  if (!target) return;
  const location = subject?.location;
  const status = location?.status;
  let description = "";
  target.dataset.status = typeof status === "string" ? status : "unavailable";
  if (status === "resolved") {
    const label = networkText(location.label);
    const country = localizeCountry(location.countryCode, networkText(location.country));
    const parts = [networkText(location.city), networkText(location.region), country].filter(Boolean);
    const assembled = [...new Set(parts)].join(" · ");
    const name = location.source === "configured" ? label || assembled : assembled || label;
    target.textContent = name || t("networkLocationUnavailable");
    if (name && ["geoip", "mmdb"].includes(location.source) && location.approximate === true) {
      description = t(isServer ? "networkServerApproximate" : "networkClientApproximate");
    }
  } else if (status === "internal") {
    const scopeKeys = { private: "networkPrivate", loopback: "networkLoopback", "link-local": "networkLinkLocal", reserved: "networkReserved" };
    target.textContent = t(scopeKeys[subject?.scope] || "networkPrivate");
  } else target.textContent = t(status === "disabled" ? "networkLocationDisabled" : "networkLocationUnavailable");
  if (note) {
    note.textContent = description;
    note.hidden = !description;
  }
}

function renderNetworkInfo() {
  if (!ui.clientIp || !ui.clientLocation || !ui.serverLocation) return;
  if (networkInfo.status !== "ready") {
    for (const target of [ui.clientIp, ui.clientLocation, ui.serverLocation, ui.clientIsp, ui.clientAsn, ui.serverIsp]) {
      target.textContent = t(networkInfo.status === "loading" ? "networkLoading" : "networkInfoUnavailable");
      target.dataset.status = networkInfo.status;
    }
    for (const note of [ui.clientLocationNote, ui.serverLocationNote]) if (note) { note.textContent = ""; note.hidden = true; }
    return;
  }
  const { client, server } = networkInfo.data;
  ui.clientIp.textContent = networkText(client.ip) || t("networkInfoUnavailable");
  ui.clientIp.dataset.status = client.ip ? "resolved" : "unavailable";
  ui.clientIp.dataset.scope = networkText(client.scope);
  ui.clientIp.title = t(client.proxied === true ? "networkForwardedIp" : "networkObservedIp");
  renderNetworkLocation(client, ui.clientLocation, ui.clientLocationNote, false);
  renderNetworkLocation(server, ui.serverLocation, ui.serverLocationNote, true);
  ui.clientIsp.textContent = networkText(client.isp) || t("networkUnknown");
  ui.clientAsn.textContent = typeof client.asn === "string" && /^AS\d{1,10}$/.test(client.asn) ? client.asn : t("networkUnknown");
  const serverAsn = typeof server.asn === "string" && /^AS\d{1,10}$/.test(server.asn) ? server.asn : "";
  ui.serverIsp.textContent = [networkText(server.isp), serverAsn].filter(Boolean).join(" · ") || t("networkUnknown");
}

async function loadNetworkInfo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/api/network-info", {
      signal: controller.signal, cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Network information unavailable");
    const data = await response.json();
    if (!data?.client || !data?.server || typeof data.client !== "object" || typeof data.server !== "object" || Array.isArray(data.client) || Array.isArray(data.server)) throw new Error("Invalid network information");
    networkInfo = { status: "ready", data };
  } catch {
    networkInfo = { status: "unavailable", data: null };
  } finally {
    clearTimeout(timer);
    renderNetworkInfo();
  }
}

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
  settings = normalizeSettings(settings);
  const effectiveStreams = Math.min(maxStreams(), settings.streams);
  const latencyOnly = settings.testType === "latency";
  ui.autoMode.checked = settings.mode === "auto";
  ui.manualMode.checked = settings.mode === "manual";
  ui.streamCount.value = String(effectiveStreams);
  ui.streamCount.max = String(maxStreams());
  ui.streamCount.disabled = running || settings.mode === "auto" || latencyOnly;
  ui.settingsFields.disabled = running;
  ui.duration.value = settings.durationMs ? String(settings.durationMs) : "";
  ui.testType.value = settings.testType;
  ui.policy.value = settings.measurementPolicy;
  const configuredBudget = String(settings.maxBytes);
  const customBudget = ![...ui.budget.options].some(option => option.value === configuredBudget);
  ui.budget.value = customBudget ? "custom" : configuredBudget;
  ui.customBudgetRow.hidden = !customBudget;
  if (customBudget) ui.customBudget.value = String(Math.max(1, Math.ceil(settings.maxBytes / 1024 ** 2)));
  for (const control of [ui.autoMode, ui.manualMode, ui.duration, ui.policy, ui.budget, ui.customBudget]) control.disabled = running || latencyOnly;
  const duration = durationLabel(currentDuration());
  ui.defaultDuration.textContent = t("defaultDuration", { seconds: durationLabel(Math.max(config?.test?.downloadDurationMs || 10000, config?.test?.uploadDurationMs || 10000)) });
  ui.settingsSummary.textContent = latencyOnly ? t("testLatency") : t("settingsSummary", { mode: settings.mode === "auto" ? t("automatic") : t("concurrencyCount", { count: effectiveStreams }), seconds: duration });
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
  settings.testType = ui.testType.value;
  settings.measurementPolicy = ui.policy.value;
  settings.maxBytes = ui.budget.value === "custom"
    ? Math.min(1048576, Math.max(1, Math.round(Number(ui.customBudget.value) || 1))) * 1024 ** 2
    : Number(ui.budget.value);
  settings = normalizeSettings(settings);
  if (!running && event?.target === ui.testType) {
    displayType = settings.testType;
    resetMetrics();
    setStage("idle");
    setStatus("statusIdle");
    clearError();
  }
  syncSettings();
  hasSavedSettings = true;
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Optional local preference storage. */ }
}

function renderTransportMessage() {
  const update = transportState;
  if (!update) return;
  if (displayType === "latency") { ui.transportMessage.hidden = true; return; }
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
  if (!update || typeof update !== "object") return;
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
  [ui.idle, ui.jitter, ui.downloadLoaded, ui.uploadLoaded, ui.failure, ui.traffic].forEach((item) => { item.textContent = "—"; });
  ui.download.classList.remove("compact");
  downloadComplete = false;
  lastDiagnostics = null;
  setSpeed("download", null);
  setSpeed("upload", null);
  delete ui.download.dataset.latencyMs;
  renderHeroTitle();
  if (displayType === "latency") setHeroLatency(null);
  ui.completionNote.hidden = true;
  ui.completionNote.textContent = "";
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
      if (displayType === "latency") setHeroLatency(update.stats.medianMs);
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
      if (isDownload && !downloadComplete) {
        if (update.warmingUp && update.totalBytes > 0 && update.previewMbps > 0) setDownload(update.previewMbps, { preview: true });
        else if (!update.warmingUp) setDownload(update.measuredBytes > 0 ? update.mbps : null);
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
    if (result.testType === "latency") {
      setHeroLatency(result.latency.idle.medianMs, true);
      setSkipped("upload");
    } else {
      downloadComplete = true;
      setDownload(result.downloadMbps);
      if (result.upload) setSpeed("upload", result.uploadMbps);
      else setSkipped("upload");
    }
    ui.downloadLoaded.textContent = result.download ? number(result.latency.download?.medianMs) : t("notTested");
    ui.uploadLoaded.textContent = result.upload ? number(result.latency.upload?.medianMs) : t("notTested");
    updateDiagnostics(result.download);
    updateDiagnostics(result.upload);
    if (result.transport) updateTransport(result.transport);
    ui.traffic.textContent = formatTraffic((result.download?.totalBytes || 0) + (result.upload?.totalBytes || 0));
    const latency = Object.values(result.latency).filter(Boolean);
    const failed = (result.download?.failedRequests || 0) + (result.upload?.failedRequests || 0) + latency.reduce((sum, item) => sum + item.failed, 0);
    const requests = (result.download?.requests || 0) + (result.upload?.requests || 0) + latency.reduce((sum, item) => sum + item.attempts, 0);
    ui.failure.textContent = number(requests ? failed / requests * 100 : 0);
    const noLoadedSamples = result.download && !result.latency.download?.samples || result.upload && !result.latency.upload?.samples;
    const incomplete = result.download?.complete === false || result.upload?.complete === false;
    setStatus(incomplete ? "resultIncomplete" : failed || noLoadedSamples ? "statusPartial" : "statusComplete");
    ui.dot.className = "connection-dot connected";
    lastResult = normalizeResult(result);
    if (lastResult) {
      const appended = appendHistory(history, lastResult, storage);
      history = appended.records;
      historyStatusKey = appended.saved ? "" : "historySessionOnly";
      renderHistory(lastResult.completedAt);
      renderCompletionNote(lastResult);
    }
    if (Number.isFinite(result.downloadMbps) && Number.isFinite(result.uploadMbps)) {
      try { storage?.setItem("light-speed:last-result", JSON.stringify({ completedAt: result.completedAt, downloadMbps: result.downloadMbps, uploadMbps: result.uploadMbps })); }
      catch { /* Optional compatibility with the previous-results caption. */ }
    }
  }
}

const typeLabel = type => t({ full: "testFull", download: "testDownload", latency: "testLatency" }[type] || "testFull");
const recordSpeed = phaseResult => phaseResult == null ? t("notTested") : phaseResult.mbps == null ? t("measurementUnavailable") : formatSpeed(phaseResult.mbps);
const recordTime = completedAt => new Intl.DateTimeFormat(getLanguage() === "zh" ? "zh-CN" : "en", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(completedAt));

function selectedRecord() {
  return history.find(record => record.completedAt === ui.historySelect.value) || null;
}

function completionText(record) {
  if (!record) return "";
  return ["download", "upload"].flatMap(kind => {
    const measured = record[kind];
    if (!measured) return [];
    const key = !measured.complete ? "completionNoMeasurement" : { stable: "completionStable", budget: "completionBudget", duration: "completionDuration" }[measured.completionReason];
    return [t(key, { direction: t(kind === "download" ? "downloadLabel" : "uploadLabel") })];
  }).join(" ");
}

function renderCompletionNote(record) {
  const notable = [record?.download, record?.upload].some(measured => measured && (measured.completionReason !== "duration" || !measured.complete));
  ui.completionNote.hidden = !notable;
  ui.completionNote.textContent = notable ? completionText(record) : "";
}

function renderHistory(preferred) {
  const selected = preferred || ui.historySelect.value;
  ui.historySelect.replaceChildren();
  if (!history.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = t("historyEmpty");
    ui.historySelect.append(empty);
  } else for (const record of history) {
    const option = document.createElement("option");
    option.value = record.completedAt;
    option.textContent = t("historyItem", { time: recordTime(record.completedAt), type: typeLabel(record.testType) });
    ui.historySelect.append(option);
  }
  if (history.some(record => record.completedAt === selected)) ui.historySelect.value = selected;
  ui.historySelect.disabled = !history.length;
  ui.historyClear.disabled = !history.length;
  ui.exportHistoryCSV.disabled = !history.length;
  renderSelectedRecord();
}

function renderSelectedRecord() {
  const record = selectedRecord();
  for (const control of [ui.exportJSON, ui.exportCSV, ui.exportPNG]) control.disabled = !record;
  ui.shareResult.disabled = !record || shareBusy;
  ui.shareRevoke.disabled = shareBusy;
  ui.historySummary.textContent = record ? `${t("historySummary", { download: recordSpeed(record.download), upload: recordSpeed(record.upload), latency: `${number(record.latency.idle.medianMs)} ms` })} ${completionText(record)}` : "";
  ui.historyStatus.textContent = historyStatusKey ? t(historyStatusKey) : "";
  ui.shareStatus.textContent = shareStatusKey ? t(shareStatusKey) : "";
}

function downloadFile(blob, suffix, completedAt) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `testspeed-${completedAt ? completedAt.replace(/[:.]/g, "-") : "history"}.${suffix}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportResult(format) {
  const record = selectedRecord();
  if (!record) return;
  try {
    if (format === "json") downloadFile(new Blob([resultJSON(record)], { type: "application/json" }), "json", record.completedAt);
    else if (format === "csv") downloadFile(new Blob([resultsCSV(record)], { type: "text/csv;charset=utf-8" }), "csv", record.completedAt);
    else {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 1000;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#e32529";
      context.font = "bold 46px Arial, sans-serif";
      context.fillText("TESTSPEED", 72, 90);
      context.fillStyle = "#777";
      context.font = "24px Arial, sans-serif";
      context.fillText(`${recordTime(record.completedAt)} · ${typeLabel(record.testType)}`, 72, 145);
      context.fillText(record.node.name.slice(0, 64), 72, 185, 1040);
      const lines = [
        [t("downloadLabel"), recordSpeed(record.download)], [t("uploadLabel"), recordSpeed(record.upload)],
        [t("idleLatency"), `${number(record.latency.idle.medianMs)} ms`], [t("jitter"), `${number(record.latency.idle.jitterMs)} ms`],
        [t("traffic"), formatTraffic((record.download?.totalBytes || 0) + (record.upload?.totalBytes || 0))],
        [t("measurementPolicy"), t(record.measurementPolicy === "adaptive" ? "policyAdaptive" : "policyFixed")],
      ];
      lines.forEach(([label, value], index) => {
        const y = 265 + index * 85;
        context.fillStyle = "#888";
        context.font = "25px Arial, sans-serif";
        context.fillText(label, 72, y);
        context.fillStyle = "#111";
        context.font = "32px Arial, sans-serif";
        context.fillText(value, 535, y, 585);
      });
      context.fillStyle = "#888";
      context.font = "22px Arial, sans-serif";
      ["download", "upload"].forEach((kind, index) => {
        if (record[kind]) context.fillText(completionText({ [kind]: record[kind] }), 72, 805 + index * 40, 1040);
      });
      context.fillText(t("footer"), 72, 925);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("PNG unavailable");
      downloadFile(blob, "png", record.completedAt);
    }
    historyStatusKey = "exportComplete";
  } catch { historyStatusKey = "exportFailed"; }
  renderSelectedRecord();
}

async function shareResult() {
  const record = toShareRecord(selectedRecord());
  if (!record || shareBusy || config?.features?.sharing !== true) return;
  const token = ui.shareToken.value.trim();
  if (config.features.shareRequiresToken === true && !token) {
    shareStatusKey = "shareTokenNeeded";
    renderSelectedRecord();
    return;
  }
  shareBusy = true;
  shareStatusKey = "shareSaving";
  renderSelectedRecord();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("/api/results", { method: "POST", credentials: "same-origin", cache: "no-store", headers, body: JSON.stringify(record), signal: controller.signal });
    if (!response.ok) throw new Error("Share unavailable");
    const data = await response.json();
    if (!/^[a-f0-9]{32}$/.test(data.id) || !/^[a-f0-9]{32}$/.test(data.deleteToken) || data.url !== `/share.html?id=${data.id}`) throw new Error("Invalid share response");
    activeShare = { id: data.id, deleteToken: data.deleteToken };
    ui.shareLink.href = new URL(data.url, location.origin).href;
    ui.shareLink.textContent = ui.shareLink.href;
    ui.shareLink.hidden = false;
    ui.shareRevoke.hidden = false;
    shareStatusKey = "shareReady";
  } catch { shareStatusKey = "shareFailed"; }
  finally {
    clearTimeout(timer);
    ui.shareToken.value = "";
    shareBusy = false;
    renderSelectedRecord();
  }
}

async function revokeShare() {
  if (!activeShare || shareBusy) return;
  shareBusy = true;
  renderSelectedRecord();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`/api/results/${activeShare.id}`, { method: "DELETE", credentials: "same-origin", cache: "no-store", headers: { "X-Delete-Token": activeShare.deleteToken }, signal: controller.signal });
    if (!response.ok) throw new Error("Cannot revoke share");
    activeShare = null;
    ui.shareLink.hidden = true;
    ui.shareLink.removeAttribute("href");
    ui.shareLink.textContent = "";
    ui.shareRevoke.hidden = true;
    shareStatusKey = "shareRevoked";
  } catch { shareStatusKey = "shareFailed"; }
  finally { clearTimeout(timer); shareBusy = false; renderSelectedRecord(); }
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
  ui.shareTools.hidden = config.features?.sharing !== true;
  ui.shareTokenLabel.hidden = config.features?.shareRequiresToken !== true;
  renderHistory();
  showConfiguredTransport();
  drawChart();
}

async function start() {
  if (running) return;
  clearError();
  updateSettings();
  displayType = settings.testType;
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
    testOptions = { mode: settings.mode, streams: Math.min(settings.streams, configuredMaxStreams()), testType: settings.testType, measurementPolicy: settings.measurementPolicy, minDurationMs: 5000, maxBytes: settings.maxBytes, ...(settings.durationMs ? { durationMs: settings.durationMs } : {}) };
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
for (const control of [ui.autoMode, ui.manualMode, ui.streamCount, ui.duration, ui.testType, ui.policy, ui.budget, ui.customBudget]) control.addEventListener("change", updateSettings);
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
  const previous = JSON.parse(storage?.getItem("light-speed:last-result") || "null");
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
  renderHeroTitle();
  ui.downloadUnitDescription.textContent = t(displayType === "latency" ? "unitMsDescription" : ui.downloadUnit.textContent === "Gbps" ? "unitGbpsDescription" : "unitMbpsDescription");
  if (displayType === "latency") ui.downloadUnit.textContent = "ms";
  if (ui.upload.dataset.skipped === "true") setSkipped("upload");
  if (phase === "complete" && lastResult) {
    if (lastResult.testType === "latency") setHeroLatency(lastResult.latency.idle.medianMs, true);
    if (!lastResult.upload) setSkipped("upload");
    if (!lastResult.download) ui.downloadLoaded.textContent = t("notTested");
    if (!lastResult.upload) ui.uploadLoaded.textContent = t("notTested");
    renderCompletionNote(lastResult);
  }
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
  renderNetworkInfo();
  renderHistory();
}

ui.moreButton.addEventListener("click", () => {
  ui.more.hidden = !ui.more.hidden;
  ui.moreButton.setAttribute("aria-expanded", String(!ui.more.hidden));
  ui.moreButton.textContent = t(ui.more.hidden ? "moreInfo" : "lessInfo");
});
ui.language.addEventListener("change", () => setLanguage(ui.language.value));
onLanguageChange(renderLanguage);
ui.historySelect.addEventListener("change", renderSelectedRecord);
ui.historyClear.addEventListener("click", () => {
  const cleared = clearHistory(storage);
  history = [];
  lastResult = null;
  previousResult = null;
  ui.previous.hidden = true;
  historyStatusKey = cleared ? "historyCleared" : "historyClearUnavailable";
  renderHistory();
});
ui.exportJSON.addEventListener("click", () => { void exportResult("json"); });
ui.exportCSV.addEventListener("click", () => { void exportResult("csv"); });
ui.exportPNG.addEventListener("click", () => { void exportResult("png"); });
ui.exportHistoryCSV.addEventListener("click", () => {
  if (!history.length) return;
  try { downloadFile(new Blob([resultsCSV(history)], { type: "text/csv;charset=utf-8" }), "csv"); historyStatusKey = "exportComplete"; }
  catch { historyStatusKey = "exportFailed"; }
  renderSelectedRecord();
});
ui.shareResult.addEventListener("click", () => { void shareResult(); });
ui.shareRevoke.addEventListener("click", () => { void revokeShare(); });

setSpeed("download", null);
setSpeed("upload", null);
if (displayType === "latency") setHeroLatency(null);
renderLanguage();
void loadNetworkInfo();
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
