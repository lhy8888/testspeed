import { detectInitialLanguage, LANGUAGE_STORAGE_KEY } from "./i18n.js";

const dictionaries = {
  zh: { title: "测速结果", loading: "正在读取测速结果…", failed: "无法读取测速结果，请稍后重试。", missing: "此分享不存在、已撤销或已过期。", download: "下载", upload: "上传", latency: "空闲延迟", jitter: "抖动", node: "测速节点", completed: "完成时间", type: "测试项目", policy: "测量策略", connections: "TCP 峰值 · 下载 / 上传", expiry: "分享有效期至", provenance: "这是客户端主动分享的测速记录，未经服务器认证；不包含客户端 IP、所在地或设备信息。", newTest: "测试我的网速", deployment: "部署教程", full: "下载、上传与延迟", downloadType: "仅下载", latencyType: "仅延迟", fixed: "固定时长", adaptive: "稳定后结束", incomplete: "流量预算在有效计量前耗尽的方向不显示速率。", notMeasured: "未测量" },
  en: { title: "Speed test result", loading: "Loading the shared result…", failed: "Cannot load this result. Please try again later.", missing: "This share does not exist, was revoked or has expired.", download: "Download", upload: "Upload", latency: "Unloaded latency", jitter: "Jitter", node: "Test node", completed: "Completed", type: "Test selection", policy: "Measurement policy", connections: "Peak TCP · download / upload", expiry: "Share expires", provenance: "This is a report explicitly shared by the client, without server certification. It contains no client IP, location or device information.", newTest: "Test my speed", deployment: "Deployment guide", full: "Download, upload and latency", downloadType: "Download only", latencyType: "Latency only", fixed: "Fixed duration", adaptive: "Finish when stable", incomplete: "A direction whose traffic budget ran out before measurement has no reported speed.", notMeasured: "Not measured" },
};

const $ = (id) => document.getElementById(id);
let language = detectInitialLanguage();
let record = null;
let status = "loading";
const t = (key) => dictionaries[language][key] || key;
const finite = (value) => Number.isFinite(value) && value >= 0;
const number = (value) => finite(value) ? new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 1 }).format(value) : "—";

function setSpeed(value, element, unit) {
  const valid = finite(value);
  const display = valid && value >= 1000 ? value / 1000 : value;
  element.textContent = valid ? new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en", { maximumFractionDigits: display >= 100 ? 0 : 1 }).format(display) : "—";
  unit.textContent = valid && value >= 1000 ? "Gbps" : "Mbps";
  element.classList.toggle("is-pending", !valid);
  element.classList.toggle("is-settled", valid);
  element.classList.toggle("compact", valid && display >= 1000);
  element.title = valid ? `${number(value)} Mbps` : t("notMeasured");
}

function date(value) {
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) ? new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(time) : "—";
}

function render() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = `TESTSPEED · ${t("title")}`;
  $("share-language").value = language;
  document.querySelectorAll("[data-share-i18n]").forEach((element) => { element.textContent = t(element.dataset.shareI18n); });
  $("share-status").textContent = record ? "" : t(status);
  $("share-result").hidden = !record;
  if (!record) return;
  const result = record.result;
  $("share-transfer").hidden = result.testType === "latency";
  $("share-speed-label").hidden = result.testType === "latency";
  $("share-upload-summary").hidden = result.upload === null;
  $("share-summary").classList.toggle("share-summary-latency", result.upload === null);
  setSpeed(result.download?.mbps, $("share-download"), $("share-download-unit"));
  setSpeed(result.upload?.mbps, $("share-upload"), $("share-upload-unit"));
  $("share-latency").textContent = number(result.latency?.idle?.medianMs);
  $("share-jitter").textContent = number(result.latency?.idle?.jitterMs);
  $("share-node").textContent = result.node.name;
  $("share-completed").textContent = date(result.completedAt);
  $("share-type").textContent = t(result.testType === "download" ? "downloadType" : result.testType === "latency" ? "latencyType" : "full");
  $("share-policy").textContent = t(result.measurementPolicy);
  $("share-connections").textContent = `${number(result.connections?.downloadPeak)} / ${number(result.connections?.uploadPeak)}`;
  $("share-expiry").textContent = date(record.expiresAt);
  $("share-incomplete").hidden = ![result.download, result.upload].some((phase) => phase && phase.complete === false);
  $("share-incomplete").textContent = t("incomplete");
}

$("share-language").addEventListener("change", () => {
  language = $("share-language").value === "zh" ? "zh" : "en";
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch {}
  render();
});
render();

const id = new URLSearchParams(location.search).get("id");
if (!/^[a-f0-9]{32}$/.test(id || "")) {
  status = "missing";
  render();
} else {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`/api/results/${id}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (response.status === 404) status = "missing";
    else if (!response.ok) status = "failed";
    else {
      const value = await response.json();
      if (value?.id !== id || value?.provenance !== "client-reported" || value?.result?.schemaVersion !== 1 || typeof value.result.node?.name !== "string" || !["full", "download", "latency"].includes(value.result.testType)) status = "failed";
      else record = value;
    }
  } catch { status = "failed"; }
  finally { clearTimeout(timeout); render(); }
}
