import { getLanguage, onLanguageChange, setLanguage } from './i18n.js';
import { MAX_STABILITY_SAMPLES, stabilityCSV } from './stability-worker.js';

const text = {
  zh: {
    title: '连接稳定性', documentTitle: 'TESTSPEED · 连接稳定性', language: '语言',
    intro: '持续测量当前节点的 HTTP 往返时间，观察延迟波动和请求失败。',
    settings: '测试设置', duration: '持续时间', duration60: '1 分钟', duration120: '2 分钟', duration300: '5 分钟', interval: '请求间隔', threshold: '延迟提醒', disabled: '关闭',
    start: '开始测试', stop: '停止', export: '导出 CSV', current: '当前延迟', average: '平均延迟', jitter: '相邻延迟抖动', failure: '请求失败率', metrics: '测量结果',
    chart: '延迟变化', chartTitle: 'HTTP 往返时间', chartDescription: '绿线显示成功请求的延迟，红点显示失败请求。', empty: '收到实际请求结果后显示曲线', success: '成功请求', failed: '失败请求', minimum: '最低', maximum: '最高',
    caption: '这是 HTTP 请求的往返时间，包含浏览器和服务器处理；请求失败率不代表网络丢包率。失败请求不计入延迟分布，抖动仅计算相邻的成功请求。',
    traffic: '每次仅请求当前测速节点的小型响应，不进行下载或上传测速。每次只有一个请求；慢请求会降低采样频率。页面进入后台、离线或点击停止时立即终止。',
    back: '返回测速', guide: '部署教程', idle: '点击开始，记录真实请求的延迟。', running: '正在测量 · 剩余 {seconds} 秒', requests: '{count} 次请求 · {failures} 次失败',
    durationDone: '测试完成。', stopped: '测试已停止。', hidden: '页面进入后台，测试已停止。返回后可重新开始。', offline: '网络已断开，测试已停止。', workerError: '无法运行测试工作线程，请重新开始。',
    thresholdExceeded: '当前延迟 {latency} ms，超过提醒阈值 {threshold} ms。', lastFailed: '最近一次 HTTP 请求未成功。',
  },
  en: {
    title: 'Connection stability', documentTitle: 'TESTSPEED · Connection stability', language: 'Language',
    intro: 'Watch real HTTP round-trip times, latency variations and request failures to the current node.',
    settings: 'Test settings', duration: 'Duration', duration60: '1 minute', duration120: '2 minutes', duration300: '5 minutes', interval: 'Request interval', threshold: 'Latency alert', disabled: 'Off',
    start: 'Start test', stop: 'Stop', export: 'Export CSV', current: 'Current latency', average: 'Average latency', jitter: 'Adjacent jitter', failure: 'Request failures', metrics: 'Measured results',
    chart: 'Latency over time', chartTitle: 'HTTP round-trip time', chartDescription: 'The green line shows successful request latency. Red dots show failed requests.', empty: 'The chart appears after actual request results', success: 'Successful request', failed: 'Failed request', minimum: 'Minimum', maximum: 'Maximum',
    caption: 'These are HTTP round-trip times, including browser and server processing. Request failures do not measure network packet loss. Failures are excluded from latency percentiles; jitter uses adjacent successful requests.',
    traffic: 'Each request reads a small response from this test node, without a download or upload speed test. Only one request runs at a time; slow requests reduce the sample rate. Hiding the page, going offline or stopping aborts the test immediately.',
    back: 'Back to speed test', guide: 'Deployment guide', idle: 'Start a test to record real request latency.', running: 'Measuring · {seconds} s remaining', requests: '{count} requests · {failures} failed',
    durationDone: 'Test complete.', stopped: 'Test stopped.', hidden: 'The test stopped when this page moved to the background. Return to start again.', offline: 'Your network disconnected. The test stopped.', workerError: 'The test worker could not run. Please start again.',
    thresholdExceeded: 'Current latency is {latency} ms, above the {threshold} ms alert threshold.', lastFailed: 'The most recent HTTP request failed.',
  },
};
const element = id => document.getElementById(id);
const format = value => Number.isFinite(value) ? value.toLocaleString(getLanguage() === 'zh' ? 'zh-CN' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—';
const translate = (key, variables = {}) => (text[getLanguage()]?.[key] || text.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? `{${name}}`));
const state = { worker: null, running: false, samples: [], metrics: null, elapsedMs: 0, remainingMs: 60000, config: null, reason: 'idle', exportURL: null };

function renderChart() {
  const samples = state.samples;
  // Grow with elapsed time so short or stopped runs remain readable.
  const duration = samples.length ? Math.max(1000, state.elapsedMs) : state.config?.durationMs || Number(element('stability-duration').value) || 60000;
  const maxLatency = Math.max(10, ...samples.filter(sample => sample.ok && Number.isFinite(sample.latencyMs)).map(sample => sample.latencyMs));
  const ceiling = Math.max(10, Math.ceil(maxLatency / 10) * 10);
  let line = '';
  let failures = '';
  let previousSuccess = false;
  for (const sample of samples) {
    const x = Math.max(0, Math.min(960, sample.elapsedMs * 960 / duration));
    if (sample.ok && Number.isFinite(sample.latencyMs)) {
      const y = 200 - Math.min(1, sample.latencyMs / ceiling) * 180;
      line += `${previousSuccess ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
      // An isolated successful sample must still be visible.
      if (!previousSuccess) line += `l.01 0`;
      previousSuccess = true;
    } else {
      failures += `M${x.toFixed(2)} 211a3 3 0 1 0 .01 0Z`;
      previousSuccess = false;
    }
  }
  element('stability-line').setAttribute('d', line);
  element('stability-failures').setAttribute('d', failures);
  element('stability-chart-empty').hidden = samples.length > 0;
  element('stability-chart-max').hidden = samples.length === 0;
  element('stability-chart-max').textContent = `${ceiling.toLocaleString()} ms`;
  element('stability-chart-end').textContent = `${Number((duration / 1000).toFixed(1)).toLocaleString()} s`;
}

function render() {
  const metrics = state.metrics;
  const mapping = { current: 'currentMs', average: 'averageMs', jitter: 'jitterMs', failure: 'failurePercent', minimum: 'minimumMs', maximum: 'maximumMs', p50: 'p50Ms', p95: 'p95Ms', p99: 'p99Ms' };
  for (const [id, key] of Object.entries(mapping)) {
    element(`stability-${id}`).textContent = format(metrics?.[key]);
    if (Number.isFinite(metrics?.[key])) element(`stability-${id}`).dataset.value = String(metrics[key]);
    else delete element(`stability-${id}`).dataset.value;
  }
  element('stability-requests').textContent = translate('requests', { count: metrics?.requests || 0, failures: metrics?.failures || 0 });
  element('stability-status').textContent = state.running ? translate('running', { seconds: Math.ceil(state.remainingMs / 1000) }) : translate({ duration: 'durationDone', pagehide: 'stopped' }[state.reason] || state.reason);
  element('stability-status').dataset.state = state.running ? 'running' : state.reason;
  element('stability-fields').disabled = state.running;
  element('stability-start').disabled = state.running;
  element('stability-stop').hidden = !state.running;
  element('stability-export').disabled = state.samples.length === 0;
  const threshold = Number(element('stability-threshold').value);
  const exceeds = threshold > 0 && Number.isFinite(metrics?.currentMs) && metrics.currentMs > threshold;
  const lastFailed = state.samples.length > 0 && !state.samples.at(-1).ok;
  element('stability-alert').hidden = !exceeds && !lastFailed;
  element('stability-alert').textContent = exceeds ? translate('thresholdExceeded', { latency: format(metrics.currentMs), threshold }) : lastFailed ? translate('lastFailed') : '';
  renderChart();
}

function renderLanguage() {
  document.documentElement.lang = getLanguage() === 'zh' ? 'zh-CN' : 'en';
  document.title = translate('documentTitle');
  element('language-select').value = getLanguage();
  for (const node of document.querySelectorAll('[data-stability-text]')) node.textContent = translate(node.dataset.stabilityText);
  element('stability-chart-title').textContent = translate('chartTitle');
  element('stability-chart-description').textContent = translate('chartDescription');
  render();
}

function stop(reason = 'stopped') {
  if (!state.running) return;
  // The Worker acknowledges after clearing all timers and aborting the request.
  state.worker?.postMessage({ type: 'stop', reason });
  state.reason = reason;
}

function start(event) {
  event.preventDefault();
  if (state.running || document.hidden || !navigator.onLine) return;
  state.samples = [];
  state.metrics = null;
  state.elapsedMs = 0;
  state.config = { durationMs: Number(element('stability-duration').value), intervalMs: Number(element('stability-interval').value), timeoutMs: 5000 };
  state.remainingMs = state.config.durationMs;
  state.running = true;
  state.reason = 'running';
  state.worker?.terminate();
  try {
    const worker = new Worker(new URL('./stability-worker.js', import.meta.url), { type: 'module' });
    state.worker = worker;
    worker.onmessage = ({ data }) => {
      if (state.worker !== worker) return;
      if (data?.type === 'error') {
        state.running = false;
        state.reason = 'workerError';
        worker.terminate();
      } else if (['started', 'update', 'complete'].includes(data?.type)) {
        state.config = data.config;
        state.metrics = data.metrics;
        state.elapsedMs = data.elapsedMs;
        state.remainingMs = data.remainingMs;
        if (Array.isArray(data.samples)) state.samples.push(...data.samples.slice(0, MAX_STABILITY_SAMPLES - state.samples.length));
        if (data.type === 'complete') {
          state.running = false;
          state.reason = data.reason;
          worker.terminate();
        }
      }
      render();
    };
    worker.onerror = event => {
      event.preventDefault();
      if (state.worker !== worker) return;
      state.running = false;
      state.reason = 'workerError';
      worker.terminate();
      render();
    };
    worker.postMessage({ type: 'start', config: state.config });
  } catch {
    state.running = false;
    state.reason = 'workerError';
  }
  render();
}

function exportCSV() {
  if (!state.samples.length) return;
  if (state.exportURL) URL.revokeObjectURL(state.exportURL);
  state.exportURL = URL.createObjectURL(new Blob([stabilityCSV(state.samples)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = state.exportURL;
  link.download = `testspeed-stability-${new Date().toISOString().replaceAll(':', '-')}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
}

element('stability-settings').addEventListener('submit', start);
element('stability-stop').addEventListener('click', () => stop());
element('stability-export').addEventListener('click', exportCSV);
element('stability-duration').addEventListener('change', () => { if (!state.samples.length) renderChart(); });
element('stability-threshold').addEventListener('change', render);
element('language-select').addEventListener('change', event => setLanguage(event.target.value));
document.addEventListener('visibilitychange', () => { if (document.hidden) stop('hidden'); });
window.addEventListener('offline', () => stop('offline'));
window.addEventListener('pagehide', () => { stop('pagehide'); if (state.exportURL) URL.revokeObjectURL(state.exportURL); });
onLanguageChange(renderLanguage);
renderLanguage();
