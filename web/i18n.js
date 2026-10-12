// Local dictionaries keep language changes independent from the measurement Worker.
export const LANGUAGE_STORAGE_KEY = "light-speed:language:v1";
export const supportedLanguages = Object.freeze(["zh", "en"]);

export const translations = Object.freeze({
  zh: Object.freeze({
    documentTitle: "轻测速 · 网络测速", brand: "轻测速", brandTagline: "你的网速，有多快？", pageTitle: "你的网速",
    language: "语言", languageLabel: "选择界面语言", downloadLabel: "下载速度", uploadLabel: "上传速度",
    downloadDirection: "下载", uploadDirection: "上传", start: "开始测速", stop: "停止", retest: "重新测速", retryConnection: "重试连接",
    moreInfo: "显示更多信息", lessInfo: "收起详细信息", idleLatency: "空闲延迟", jitter: "延迟抖动", loadedLatency: "负载延迟",
    downloadLoaded: "下载负载延迟", uploadLoaded: "上传负载延迟", failureRate: "请求失败率", traffic: "流量估算",
    connectionPerformance: "连接表现", transportDiagnostics: "传输诊断", streamConnections: "测速连接", streamFlows: "并行传输",
    tcpObserved: "服务端观测 TCP", currentPeak: "当前 / 峰值", observedPeak: "累计观测 / 峰值", observedTotal: "累计观测",
    currentUnknownPeak: "当前未知 / 峰值", protocol: "传输协议", rtt: "空闲 RTT", warmup: "自动预热", warmupPending: "随 RTT 调整",
    bdp: "带宽时延积", estimated: "估算", testSettings: "测速设置", concurrencyMode: "并发方式",
    concurrencyHelp: "默认 8 路，可按 RTT 和吞吐自动调整。", manual: "手动指定", defaultTag: "默认", automatic: "自动适配",
    concurrencyConnections: "并发连接数", concurrencyFlows: "并行传输数", concurrencyCount: "{count} 路并发", manualModeLabel: "手动 · {count} 路",
    measurementTime: "测量时间", measurementHelp: "每个方向单独计时，预热不计入结果。", defaultDuration: "节点默认 · {seconds} 秒",
    durationOption: "{seconds} 秒 / 阶段", secondsUnit: "{seconds} 秒", settingsSummary: "{mode} · {seconds} 秒 / 阶段",
    unitMbpsDescription: "兆比特 / 秒", unitGbpsDescription: "吉比特 / 秒",
    privacyNote: "高速测速会使用大量流量。可测上限取决于浏览器、CPU、网卡与测速服务。",
    previousResult: "上次测速 {time} · 下载 {download} · 上传 {upload}", footer: "设备 ↔ 当前测速节点", defaultNode: "默认测速节点", deploymentGuide: "部署教程",
    chartTitle: "实际测速曲线", chartDescription: "每个阶段实际测量的速度变化。", chartEmpty: "测速开始后显示速度变化", chartDuration: "{seconds} 秒 / 阶段",
    phaseIdle: "准备就绪", phaseLatency: "测量延迟", phaseDownload: "下载", phaseUpload: "上传", phaseComplete: "完成", phaseStopped: "已停止", phaseError: "连接遇到问题",
    connecting: "正在连接测速节点…", statusIdle: "点击开始，测量当前连接。", statusLatency: "正在测量空闲延迟…",
    statusWarmup: "正在预热连接…", statusTransfer: "正在测量{direction} · 剩余 {seconds} 秒", statusComplete: "测速完成。",
    statusPartial: "测速完成，部分请求未成功。", stopped: "测速已停止。", offline: "网络已断开，测速已停止。",
    hiddenStop: "页面进入后台，测速已停止。返回后可重新测速。", configError: "无法连接测速服务，请检查服务地址后重试。",
    transferError: "测速连接中断，请重试。", serviceHint: "请检查测速服务是否可用，然后重试。",
    wsHint: "请检查服务或反向代理是否允许 WebSocket 连接。", httpHint: "请检查测速端口、防火墙或反向代理是否允许测速传输。",
    wsTransport: "单端口 WebSocket 测速 · {mode}", singleHttpTransport: "单端口 HTTP 测速，当前最多 {count} 路并行传输。",
    wsFallback: "WebSocket 暂不可用，已切换为 HTTP 测速，当前最多 {count} 路并行传输。",
    httpFallback: "独立测速端口暂不可用，已切换为单端口测速，当前最多 {count} 路并行传输。",
    partialOrigins: "部分测速端口无法连接，已使用可达端口，当前最多 {count} 路并行传输。",
    streamsAdjusted: "本次并发已从 {from} 路调整为 {to} 路。",
    wsFallbackHint: "允许 WebSocket 升级后可恢复更多独立连接。", httpFallbackHint: "开放配置的测速端口后可恢复更多并发。",
    streamLimitWs: "单端口支持最多 {count} 路独立连接", streamLimitHttp: "当前测速路径支持最多 {count} 路并行传输",
    streamExplanationWs: "每路 WebSocket 使用独立连接。", streamExplanationHttp: "HTTP 并行传输数不等于独立 TCP 连接数；实际连接以服务端观测为准。",
    clientScheduling: "浏览器调度较慢，可能限制本次测速上限。",
    latencyCaption: "延迟为 HTTP 往返时间；请求失败率不代表网络丢包率。",
    transportCaption: "TCP 数是测速服务看到的连接；经过代理时仅反映代理到服务端的连接。带宽时延积是吞吐 × RTT 的在途数据估算。",
    networkInformation: "网络信息", clientIp: "你的 IP", clientLocation: "你的位置", serverLocation: "服务器位置",
    networkLoading: "正在获取…", networkInfoUnavailable: "暂不可用", networkLocationUnavailable: "位置暂不可用", networkLocationDisabled: "未启用定位",
    networkPrivate: "内网", networkLoopback: "本机", networkLinkLocal: "链路本地", networkReserved: "保留地址",
    networkClientApproximate: "按 IP 估算，可能与实际位置不同。", networkServerApproximate: "按服务器出口 IP 估算，非精确物理位置。",
    networkForwardedIp: "可信代理转发的客户端 IP", networkObservedIp: "测速服务看到的客户端 IP",
    errorNodeAddress: "测速节点地址不受支持，请使用安全的 HTTP 或 HTTPS 地址。",
    errorConfig: "测速服务配置无效，请更新服务端与页面后重试。", errorNodeConfig: "测速节点配置无效。",
    errorOriginConfig: "测速连接地址配置无效。", errorTooManyOrigins: "测速连接地址过多，请检查服务配置。",
    errorMode: "请选择自动或手动并发模式。", errorStreams: "当前部署支持 1 至 {count} 条并行传输。",
    errorDuration: "测量时间应为 10 至 60 秒。", errorWarmup: "预热时间应为 0 至 10 秒。", errorUploadData: "上传数据块无效。",
    errorServiceStatus: "测速服务暂时不可用（{code}），请稍后重试。", errorTimeout: "连接测速服务超时，请检查网络后重试。",
    errorPhaseConnection: "{direction}测速连接中断，请检查网络后重试。", errorNoData: "{direction}测速没有收到有效数据，请检查连接后重试。",
    errorRequestStatus: "测速请求失败（{code}）", errorNodeConnection: "无法连接测速节点，请检查网络或稍后重试。",
    errorWsTimeout: "WebSocket 测速连接超时", errorWsResponse: "WebSocket 测速响应无效", errorWsData: "WebSocket 测速数据无效",
    errorWsUnavailable: "WebSocket 测速连接不可用", errorWsClosed: "WebSocket 测速连接提前关闭",
    errorOriginsUnavailable: "独立测速端口无法连接，主站测速接口也不可用。请检查防火墙、安全组或反向代理的测速路径。",
    errorMainUnavailable: "主站测速下载接口不可用，请检查服务和反向代理是否允许测速传输。",
    errorUploadSession: "上传测速会话无效，请更新服务后重试。", errorUploadTimeout: "上传测速超时，请检查服务和网络后重试。",
    errorRunning: "测速正在进行，请先停止当前测速。", errorIncomplete: "测速未完成，请重试。",
    errorWorker: "测速工作线程无法运行，请更新浏览器或检查服务配置。", errorWorkerStart: "浏览器无法启动测速工作线程，请使用最新稳定版浏览器重试。",
  }),
  en: Object.freeze({
    documentTitle: "Light Speed · Internet speed test", brand: "Light Speed", brandTagline: "How fast is your internet?", pageTitle: "Your internet speed",
    language: "Language", languageLabel: "Choose interface language", downloadLabel: "Download speed", uploadLabel: "Upload speed",
    downloadDirection: "download", uploadDirection: "upload", start: "Start test", stop: "Stop", retest: "Test again", retryConnection: "Retry connection",
    moreInfo: "Show more info", lessInfo: "Show less", idleLatency: "Idle latency", jitter: "Jitter", loadedLatency: "Loaded latency",
    downloadLoaded: "Download loaded latency", uploadLoaded: "Upload loaded latency", failureRate: "Request failure rate", traffic: "Estimated data used",
    connectionPerformance: "Connection performance", transportDiagnostics: "Connection details", streamConnections: "Test connections", streamFlows: "Parallel transfers",
    tcpObserved: "Server-observed TCP", currentPeak: "Current / peak", observedPeak: "Total observed / peak", observedTotal: "Total observed",
    currentUnknownPeak: "Current unknown / peak", protocol: "Protocol", rtt: "Idle RTT", warmup: "Warm-up", warmupPending: "Adjusted to RTT",
    bdp: "Bandwidth-delay product", estimated: "Estimated", testSettings: "Test settings", concurrencyMode: "Concurrency",
    concurrencyHelp: "Defaults to 8 connections. Auto mode adjusts to RTT and throughput.", manual: "Manual", defaultTag: "Default", automatic: "Automatic",
    concurrencyConnections: "Concurrent connections", concurrencyFlows: "Parallel transfers", concurrencyCount: "{count} concurrent", manualModeLabel: "Manual · {count} connections",
    measurementTime: "Measurement time", measurementHelp: "Each direction is timed separately. Warm-up is excluded from the result.", defaultDuration: "Node default · {seconds} s",
    durationOption: "{seconds} s / phase", secondsUnit: "{seconds} s", settingsSummary: "{mode} · {seconds} s / phase",
    unitMbpsDescription: "Megabits per second", unitGbpsDescription: "Gigabits per second",
    privacyNote: "High-speed tests can use significant data. The maximum speed depends on your browser, CPU, network adapter and test server.",
    previousResult: "Previous test {time} · Download {download} · Upload {upload}", footer: "Device ↔ Current test node", defaultNode: "Default test node", deploymentGuide: "Deployment guide",
    chartTitle: "Measured speed over time", chartDescription: "Actual speed measurements during each test phase.", chartEmpty: "Speed measurements appear when the test starts", chartDuration: "{seconds} s / phase",
    phaseIdle: "Ready", phaseLatency: "Measuring latency", phaseDownload: "Download", phaseUpload: "Upload", phaseComplete: "Complete", phaseStopped: "Stopped", phaseError: "Connection issue",
    connecting: "Connecting to the test node…", statusIdle: "Start a test to measure your connection.", statusLatency: "Measuring idle latency…",
    statusWarmup: "Warming up the connections…", statusTransfer: "Measuring {direction} · {seconds} s remaining", statusComplete: "Test complete.",
    statusPartial: "Test complete. Some requests did not succeed.", stopped: "Test stopped.", offline: "Your network disconnected. The test has stopped.",
    hiddenStop: "The test stopped when the page moved to the background. Return to start a new test.", configError: "Cannot connect to the test service. Check the service address and try again.",
    transferError: "The test connection was interrupted. Please try again.", serviceHint: "Check that the test service is available, then try again.",
    wsHint: "Check that the service or reverse proxy allows WebSocket connections.", httpHint: "Check that the test ports, firewall or reverse proxy allow measurement traffic.",
    wsTransport: "Single-port WebSocket test · {mode}", singleHttpTransport: "Single-port HTTP test, with up to {count} parallel transfers.",
    wsFallback: "WebSocket is unavailable. Using HTTP with up to {count} parallel transfers.",
    httpFallback: "Separate test ports are unavailable. Using a single port with up to {count} parallel transfers.",
    partialOrigins: "Some test ports are unreachable. Using the available ports with up to {count} parallel transfers.",
    streamsAdjusted: "Concurrency for this test was adjusted from {from} to {to}.",
    wsFallbackHint: "Allow WebSocket upgrades to restore more independent connections.", httpFallbackHint: "Open the configured test ports to restore more concurrency.",
    streamLimitWs: "Up to {count} independent connections on one port", streamLimitHttp: "Up to {count} parallel transfers on the available test routes",
    streamExplanationWs: "Each WebSocket uses an independent connection.", streamExplanationHttp: "Parallel HTTP transfers do not necessarily use separate TCP connections. Actual connections are observed by the server.",
    clientScheduling: "Browser scheduling is slow and may limit this test's maximum speed.",
    latencyCaption: "Latency is HTTP round-trip time. Request failures do not measure network packet loss.",
    transportCaption: "TCP counts are observed by the test server. Behind a proxy, they describe connections from the proxy to the server. The bandwidth-delay product estimates data in flight as throughput × RTT.",
    networkInformation: "Network information", clientIp: "Your IP", clientLocation: "Your location", serverLocation: "Server location",
    networkLoading: "Loading…", networkInfoUnavailable: "Unavailable", networkLocationUnavailable: "Location unavailable", networkLocationDisabled: "Location lookup disabled",
    networkPrivate: "Private network", networkLoopback: "Local machine", networkLinkLocal: "Link-local", networkReserved: "Reserved address",
    networkClientApproximate: "Estimated from your IP. Your actual location may differ.", networkServerApproximate: "Estimated from the server's outbound IP, rather than its exact physical location.",
    networkForwardedIp: "Client IP forwarded by a trusted proxy", networkObservedIp: "Client IP observed by the test service",
    errorNodeAddress: "The test node address is unsupported. Use a secure HTTP or HTTPS address.",
    errorConfig: "The test service configuration is invalid. Update the server and page, then try again.", errorNodeConfig: "The test node configuration is invalid.",
    errorOriginConfig: "The test connection addresses are invalid.", errorTooManyOrigins: "Too many test connection addresses. Check the service configuration.",
    errorMode: "Choose automatic or manual concurrency.", errorStreams: "This deployment supports 1 to {count} parallel transfers.",
    errorDuration: "Measurement time must be 10 to 60 seconds.", errorWarmup: "Warm-up time must be 0 to 10 seconds.", errorUploadData: "The upload data block is invalid.",
    errorServiceStatus: "The test service is temporarily unavailable ({code}). Please try again later.", errorTimeout: "The test service connection timed out. Check your connection and try again.",
    errorPhaseConnection: "The {direction} test connection was interrupted. Check your connection and try again.", errorNoData: "The {direction} test received no measurement data. Check your connection and try again.",
    errorRequestStatus: "Test request failed ({code})", errorNodeConnection: "Cannot connect to the test node. Check your connection or try again later.",
    errorWsTimeout: "The WebSocket test connection timed out", errorWsResponse: "Invalid WebSocket test response", errorWsData: "Invalid WebSocket test data",
    errorWsUnavailable: "The WebSocket test connection is unavailable", errorWsClosed: "The WebSocket test connection closed early",
    errorOriginsUnavailable: "The separate test ports and the main test endpoint are unreachable. Check the firewall, security group or reverse proxy routes.",
    errorMainUnavailable: "The main download test endpoint is unavailable. Check that the service and reverse proxy allow measurement traffic.",
    errorUploadSession: "The upload test session is invalid. Update the service and try again.", errorUploadTimeout: "The upload test timed out. Check the service and your connection, then try again.",
    errorRunning: "A test is already running. Stop it before starting another.", errorIncomplete: "The test did not complete. Please try again.",
    errorWorker: "The measurement Worker could not run. Update your browser or check the service configuration.", errorWorkerStart: "The browser could not start the measurement Worker. Try again with the latest stable browser.",
  }),
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isLanguage = (value) => supportedLanguages.includes(value);

export function detectInitialLanguage(options = {}) {
  let saved;
  try {
    const storage = hasOwn(options, "storage") ? options.storage : globalThis.localStorage;
    saved = storage?.getItem(LANGUAGE_STORAGE_KEY);
  } catch { /* Storage is optional in private browsing and restricted contexts. */ }
  if (isLanguage(saved)) return saved;
  let browserLanguage;
  try { browserLanguage = hasOwn(options, "navigatorLanguage") ? options.navigatorLanguage : globalThis.navigator?.language; }
  catch { /* Fall back to English when browser preferences are unavailable. */ }
  return typeof browserLanguage === "string" && browserLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const initialLang = detectInitialLanguage();
let language = initialLang;
const listeners = new Set();
export const getLanguage = () => language;

export function localizeCountry(countryCode, fallback = "") {
  if (typeof countryCode !== "string" || !/^[A-Za-z]{2}$/.test(countryCode)) return fallback;
  if (countryCode.toUpperCase() === "ZZ") return fallback;
  try {
    return new Intl.DisplayNames([language === "zh" ? "zh-CN" : "en"], { type: "region", fallback: "none" }).of(countryCode.toUpperCase()) || fallback;
  } catch { return fallback; }
}

export function t(key, vars = {}) {
  const name = String(key);
  const template = hasOwn(translations[language], name) ? translations[language][name]
    : hasOwn(translations.en, name) ? translations.en[name] : name;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, variable) => {
    return vars != null && hasOwn(Object(vars), variable) ? String(vars[variable]) : token;
  });
}

export function applyLanguageText(root = globalThis.document) {
  if (!root) return;
  const selectors = "[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]";
  const elements = [...(root.querySelectorAll?.(selectors) || [])];
  if (root.matches?.(selectors)) elements.unshift(root);
  for (const element of elements) {
    let vars = {};
    try {
      const parsed = JSON.parse(element.getAttribute("data-i18n-vars") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) vars = parsed;
    } catch { /* Invalid optional substitutions must not block the rest of the page. */ }
    const textKey = element.getAttribute("data-i18n");
    if (textKey) element.textContent = t(textKey, vars);
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      if (key) element.setAttribute(attribute, t(key, vars));
    }
  }
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  if (document) {
    if (document.documentElement) document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = t("documentTitle");
    const select = document.getElementById?.("language-select");
    if (select) {
      select.value = language;
      select.setAttribute("aria-label", t("languageLabel"));
    }
  }
}

export function setLanguage(nextLanguage) {
  if (!isLanguage(nextLanguage)) return false;
  const changed = language !== nextLanguage;
  language = nextLanguage;
  try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language); }
  catch { /* Language changes still work without persistent storage. */ }
  applyLanguageText();
  if (changed) for (const listener of [...listeners]) listener(language);
  return true;
}

export function onLanguageChange(listener) {
  if (typeof listener !== "function") throw new TypeError("Language listener must be a function");
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The Worker returns stable Chinese messages; map them locally without restarting it.
const exactErrors = new Map(Object.entries(translations.zh)
  .filter(([key, value]) => key.startsWith("error") && !value.includes("{"))
  .map(([key, value]) => [value, key]));

export function translateError(error) {
  const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
  if (exactErrors.has(message)) return t(exactErrors.get(message));
  const status = /^测速(服务暂时不可用|请求失败)（(\d{3})）(?:，请稍后重试。)?$/.exec(message);
  if (status) return t(status[1] === "请求失败" ? "errorRequestStatus" : "errorServiceStatus", { code: status[2] });
  const streams = /^当前部署支持 1 至 (\d+) 条并行传输。$/.exec(message);
  if (streams) return t("errorStreams", { count: streams[1] });
  const connection = /^(下载|上传)测速(连接中断，请检查网络后重试。|没有收到有效数据，请检查连接后重试。)$/.exec(message);
  if (connection) return t(connection[2].startsWith("连接中断") ? "errorPhaseConnection" : "errorNoData", {
    direction: t(connection[1] === "下载" ? "downloadDirection" : "uploadDirection"),
  });
  for (const key of ["offline", "stopped", "hiddenStop"]) {
    if (message === translations.zh[key] || message === translations.en[key] || key === "stopped" && message === "测速已停止") return t(key);
  }
  if (error?.name === "AbortError") return t("stopped");
  if (error?.name === "TimeoutError") return t("errorTimeout");
  if (!message || error?.name === "TypeError") return t("transferError");
  return language === "en" && /[\u3400-\u9fff]/.test(message) ? t("errorIncomplete") : message;
}
