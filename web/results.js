// Local records are a bounded allowlist. Network addresses, credentials and
// live curves never enter history, downloads or the optional sharing payload.
export const HISTORY_KEY = "light-speed:history:v1";
export const HISTORY_LIMIT = 50;
export const SETTINGS_KEY = "light-speed:settings:v4";
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 128) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
const bounded = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;

export function normalizeSettings(value) {
  const saved = object(value) ? value : {};
  return {
    mode: pick(saved.mode, ["manual", "auto"], "manual"),
    streams: Number.isInteger(saved.streams) && saved.streams >= 1 ? Math.min(30, saved.streams) : 8,
    durationMs: [10000, 20000, 30000].includes(saved.durationMs) ? saved.durationMs : null,
    testType: pick(saved.testType, ["full", "download", "latency"], "full"),
    measurementPolicy: pick(saved.measurementPolicy, ["fixed", "adaptive"], "fixed"),
    maxBytes: integer(saved.maxBytes, 1024 ** 4) ?? 0,
  };
}

export function readSettings(storage) {
  try {
    const current = storage?.getItem(SETTINGS_KEY);
    const legacy = current == null ? storage?.getItem("light-speed:settings:v3") : null;
    const parsed = JSON.parse(current ?? legacy ?? "null");
    return { settings: normalizeSettings(parsed), saved: Boolean(object(parsed)) };
  } catch { return { settings: normalizeSettings(), saved: false }; }
}

export function normalizeLatency(value) {
  if (!object(value)) return null;
  const samples = integer(value.samples, 1000000);
  const failed = integer(value.failed, 1000000);
  const attempts = integer(value.attempts, 1000000);
  const medianMs = bounded(value.medianMs, 3600000);
  const jitterMs = bounded(value.jitterMs, 3600000);
  if (samples === null || failed === null || attempts === null || samples + failed !== attempts || (samples > 0 && medianMs === null) || samples > 1 && jitterMs === null) return null;
  return { medianMs: samples ? medianMs : null, jitterMs: samples ? jitterMs : null, samples, failed, attempts };
}

export function normalizePhase(value) {
  if (!object(value)) return null;
  const mbps = bounded(value.mbps, 1000000000);
  const durationMs = bounded(value.durationMs, 3600000);
  const measuredBytes = integer(value.measuredBytes);
  const totalBytes = integer(value.totalBytes);
  const completionReason = pick(value.completionReason, ["duration", "stable", "budget"], null);
  if (durationMs === null || measuredBytes === null || totalBytes === null || totalBytes < measuredBytes || !completionReason) return null;
  if (typeof value.complete !== "boolean") return null;
  const complete = value.complete;
  if (complete && (mbps === null || !measuredBytes || !durationMs)) return null;
  if (!complete && (value.mbps !== null || completionReason !== "budget" || measuredBytes > 0 && durationMs > 0)) return null;
  return { mbps, durationMs, measuredBytes, totalBytes, completionReason, complete,
    incompleteReason: complete ? null : "budget-before-measurement", budgetOvershootBytes: integer(value.budgetOvershootBytes) ?? 0 };
}

export function normalizeResult(value) {
  if (!object(value) || value.schemaVersion !== 1) return null;
  const completedAt = date(value.completedAt);
  const testType = pick(value.testType, ["full", "download", "latency"], null);
  const measurementPolicy = pick(value.measurementPolicy, ["fixed", "adaptive"], null);
  const download = normalizePhase(value.download);
  const upload = normalizePhase(value.upload);
  const latency = { idle: normalizeLatency(value.latency?.idle), download: normalizeLatency(value.latency?.download), upload: normalizeLatency(value.latency?.upload) };
  if (!completedAt || !testType || !measurementPolicy || !latency.idle?.samples) return null;
  if (testType !== "latency" && !download || testType === "full" && !upload) return null;
  if (testType === "latency" && (value.download != null || value.upload != null) || testType === "download" && value.upload != null) return null;
  const transportValue = object(value.transport) ? value.transport.transport : value.transport;
  const transport = testType === "latency" ? null : pick(transportValue, ["websocket", "http"], null);
  if (testType !== "latency" && !transport) return null;
  const connections = {
    downloadPeak: integer(value.connections?.downloadPeak ?? value.download?.connections?.peak, 1000000),
    uploadPeak: integer(value.connections?.uploadPeak ?? value.upload?.connections?.peak, 1000000),
  };
  return {
    schemaVersion: 1, completedAt, node: { id: text(value.node?.id, 64), name: text(value.node?.name) },
    testType, measurementPolicy, transport, mode: pick(value.mode, ["manual", "auto"], "manual"), maxBytes: integer(value.maxBytes, 1024 ** 4) ?? 0,
    download: testType === "latency" ? null : download, upload: testType === "full" ? upload : null,
    latency: { idle: latency.idle, download: testType === "latency" ? null : latency.download, upload: testType === "full" ? latency.upload : null }, connections,
  };
}

export function toShareRecord(value) {
  const record = normalizeResult(value);
  if (!record) return null;
  const { maxBytes, ...shared } = record;
  const phase = measured => {
    if (!measured) return null;
    const { incompleteReason, budgetOvershootBytes, ...publicFields } = measured;
    return publicFields;
  };
  return { ...shared, download: phase(record.download), upload: phase(record.upload) };
}

export function readHistory(storage) {
  try {
    const raw = storage?.getItem(HISTORY_KEY);
    if (!raw || raw.length > 1024 * 1024) return [];
    const values = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.slice(0, HISTORY_LIMIT * 2).map(normalizeResult).filter(Boolean).slice(0, HISTORY_LIMIT);
  } catch { return []; }
}

export function appendHistory(history, result, storage) {
  const record = normalizeResult(result);
  const previous = Array.isArray(history) ? history.map(normalizeResult).filter(Boolean).slice(0, HISTORY_LIMIT) : [];
  if (!record) return { records: previous, saved: false };
  const records = [record, ...previous.filter(item => item.completedAt !== record.completedAt)].slice(0, HISTORY_LIMIT);
  let saved = false;
  try { if (storage) { storage.setItem(HISTORY_KEY, JSON.stringify(records)); saved = true; } } catch { /* Session-only history still works. */ }
  return { records, saved };
}

export function clearHistory(storage) {
  try { storage?.removeItem(HISTORY_KEY); storage?.removeItem("light-speed:last-result"); return true; } catch { return false; }
}

export function resultJSON(value) {
  const record = normalizeResult(value);
  if (!record) throw new TypeError("Invalid result");
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function csvCell(value) {
  let cell = value == null ? "" : String(value);
  // Quoting alone does not stop formulas when opened in spreadsheet software.
  if (/^[\s]*[=+\-@]/.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

export function resultsCSV(values) {
  const records = (Array.isArray(values) ? values : [values]).map(normalizeResult).filter(Boolean).slice(0, HISTORY_LIMIT);
  const headers = ["completed_at", "node", "test_type", "policy", "transport", "download_mbps", "upload_mbps", "idle_latency_ms", "jitter_ms", "download_loaded_latency_ms", "upload_loaded_latency_ms", "download_bytes", "upload_bytes", "download_measured_bytes", "upload_measured_bytes", "download_duration_ms", "upload_duration_ms", "download_completion", "upload_completion", "download_complete", "upload_complete", "budget_bytes_per_direction", "download_budget_overshoot_bytes", "upload_budget_overshoot_bytes"];
  const rows = records.map(record => [record.completedAt, record.node.name, record.testType, record.measurementPolicy, record.transport, record.download?.mbps, record.upload?.mbps, record.latency.idle.medianMs, record.latency.idle.jitterMs, record.latency.download?.medianMs, record.latency.upload?.medianMs, record.download?.totalBytes, record.upload?.totalBytes, record.download?.measuredBytes, record.upload?.measuredBytes, record.download?.durationMs, record.upload?.durationMs, record.download?.completionReason, record.upload?.completionReason, record.download?.complete, record.upload?.complete, record.maxBytes, record.download?.budgetOvershootBytes, record.upload?.budgetOvershootBytes]);
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
