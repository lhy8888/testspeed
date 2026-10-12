import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
for (const modulePath of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(modulePath); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE to its installed module path.');

export async function launchBrowser() {
  return playwright.chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
    args: ['--no-sandbox'],
  });
}

// A Playwright route enables Fetch interception for every request, including
// large upload bodies. DevTools URL blocking leaves healthy uploads untouched.
export async function blockWorkerURLs(context, page, urls) {
  const cdp = await context.newCDPSession(page);
  const failures = [];
  const workerErrors = [];
  const pending = new Map();
  let nextCommand = 1;
  function workerCommand(sessionId, method, params = {}) {
    const id = nextCommand++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        pending.delete(id);
        reject(error);
      });
    });
  }
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const packet = JSON.parse(message);
    if (packet.id && pending.has(packet.id)) {
      const command = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) command.reject(new Error(packet.error.message));
      else command.resolve(packet.result);
    } else if (packet.method === 'Network.loadingFailed') failures.push(packet.params);
  });
  cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== 'worker') return;
    try {
      await workerCommand(sessionId, 'Network.enable', { maxPostDataSize: 0 });
      await workerCommand(sessionId, 'Network.setBlockedURLs', { urls });
    } catch (error) {
      workerErrors.push(error.message);
    } finally {
      await workerCommand(sessionId, 'Runtime.runIfWaitingForDebugger').catch(error => workerErrors.push(error.message));
    }
  });
  await cdp.send('Network.enable', { maxPostDataSize: 0 });
  cdp.on('Network.loadingFailed', event => failures.push(event));
  await cdp.send('Network.setBlockedURLs', { urls });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: [{ type: 'worker', exclude: false }, { exclude: true }] });
  return { cdp, failures, workerErrors };
}

// Worker Network.emulateNetworkConditions is unsupported in Chromium. A global
// URL rule on the owning page applies to its network factories, including its
// dedicated worker. Worker protocol events separately prove where bytes move.
export async function shapeWorkerNetwork(context, page, { downloadMbps, uploadMbps, latencyMs }) {
  const cdp = await context.newCDPSession(page);
  const pending = new Map();
  const requests = new Map();
  const workerErrors = [];
  const attachedWorkers = new Set();
  const pageRequests = [];
  let nextCommand = 1;
  function workerCommand(sessionId, method, params = {}) {
    const id = nextCommand++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        pending.delete(id);
        reject(error);
      });
    });
  }
  cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const packet = JSON.parse(message);
    if (packet.id && pending.has(packet.id)) {
      const command = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) command.reject(new Error(packet.error.message));
      else command.resolve(packet.result);
      return;
    }
    const { method, params } = packet;
    if (!params?.requestId) return;
    const key = `${sessionId}:${params.requestId}`;
    if (method === 'Network.requestWillBeSent') {
      requests.set(key, { worker: sessionId, url: params.request.url, method: params.request.method, startedAt: params.timestamp, receivedBytes: 0, dataEvents: 0 });
    } else if (requests.has(key)) {
      const request = requests.get(key);
      if (method === 'Network.responseReceived') {
        request.status = params.response.status;
        request.headers = params.response.headers;
        request.protocol = params.response.protocol;
      } else if (method === 'Network.dataReceived') {
        request.receivedBytes += params.dataLength;
        request.dataEvents += 1;
        request.firstDataAt ??= params.timestamp;
        request.lastDataAt = params.timestamp;
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        request.endedAt = params.timestamp;
        request.error = params.errorText;
      }
    }
  });
  cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== 'worker') return;
    attachedWorkers.add(sessionId);
    try {
      await workerCommand(sessionId, 'Network.enable', { maxTotalBufferSize: 1048576, maxResourceBufferSize: 262144, maxPostDataSize: 0 });
      await workerCommand(sessionId, 'Runtime.runIfWaitingForDebugger');
    } catch (error) {
      workerErrors.push(error.message);
    }
  });
  cdp.on('Network.requestWillBeSent', ({ request }) => pageRequests.push({ url: request.url, method: request.method }));
  await cdp.send('Network.enable');
  const conditions = { latency: latencyMs, downloadThroughput: downloadMbps * 1000000 / 8, uploadThroughput: uploadMbps * 1000000 / 8, connectionType: 'ethernet' };
  const { ruleIds } = await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', ...conditions }] });
  await cdp.send('Network.overrideNetworkState', { offline: false, ...conditions });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: [{ type: 'worker', exclude: false }, { exclude: true }] });
  return { cdp, requests, pageRequests, workerErrors, attachedWorkers, ruleIds, workerCommand };
}

export async function readMetrics(page) {
  return page.evaluate(() => {
    const numeric = id => {
      const element = document.getElementById(id);
      return element.dataset.mbps !== undefined ? Number(element.dataset.mbps) : Number(element.textContent.replace(/[,\s]/g, ''));
    };
    return {
      downloadMbps: numeric('download-value'), uploadMbps: numeric('upload-value'),
      idleMs: numeric('idle-latency-value'), jitterMs: numeric('jitter-value'),
      downloadLoadedMs: numeric('download-loaded-value'), uploadLoadedMs: numeric('upload-loaded-value'),
      failureRate: document.getElementById('failure-rate-value') ? numeric('failure-rate-value') : undefined,
      streams: document.getElementById('streams-value')?.textContent,
      tcp: document.getElementById('tcp-value')?.textContent,
      tcpDetails: { ...document.getElementById('tcp-value')?.dataset },
      protocol: document.getElementById('protocol-value')?.textContent,
    };
  });
}

export async function openDetails(page) {
  const toggle = page.locator('#more-info-button');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function waitPhase(page, text, timeout = 90000) {
  const phaseKey = { '正在测量下载': 'download', '正在测量上传': 'upload', '测速完成': 'complete', '测速已停止': 'stopped', '正在连接': 'latency', '准备就绪': 'ready' }[text];
  await page.waitForFunction(({ expected, phaseKey }) => {
    const phase = document.querySelector('#phase-label');
    return (phaseKey && phase.dataset.phase === phaseKey) || phase.textContent.includes(expected) || !document.querySelector('#error-message').hidden;
  }, { expected: text, phaseKey }, { timeout });
  const state = await page.evaluate(() => ({ phase: document.querySelector('#phase-label').textContent, key: document.querySelector('#phase-label').dataset.phase, error: document.querySelector('#error-message').textContent }));
  if (!(phaseKey && state.key === phaseKey) && !state.phase.includes(text)) throw new Error(`Expected phase ${text}; got ${state.phase}: ${state.error}`);
}
