import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyLanguageText, detectInitialLanguage, getLanguage, initialLang, LANGUAGE_STORAGE_KEY,
  localizeCountry, onLanguageChange, setLanguage, supportedLanguages, t, translateError, translations,
} from '../web/i18n.js';

function replaceGlobal(context, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

class TextElement {
  constructor(attributes = {}, text = '') {
    this.attributes = { ...attributes };
    this.textContent = text;
    this.value = '';
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matches() { return Object.keys(this.attributes).some(name => name.startsWith('data-i18n') && name !== 'data-i18n-vars'); }
  querySelectorAll() { return []; }
  set innerHTML(_) { throw new Error('Translations must never write HTML'); }
}

function page(elements, select = new TextElement()) {
  const document = {
    nodeType: 9,
    documentElement: { lang: '' },
    title: '',
    querySelectorAll: () => elements.filter(element => element.matches()),
    getElementById: id => id === 'language-select' ? select : null,
  };
  for (const element of elements) element.ownerDocument = document;
  return { document, select };
}

test('initial language prefers a valid saved choice and safely falls back to browser language', () => {
  assert.ok(supportedLanguages.includes(initialLang));
  assert.equal(getLanguage(), initialLang);
  for (const saved of ['zh', 'en']) {
    assert.equal(detectInitialLanguage({ storage: { getItem: key => {
      assert.equal(key, LANGUAGE_STORAGE_KEY);
      return saved;
    } }, navigatorLanguage: saved === 'zh' ? 'en-US' : 'zh-CN' }), saved);
  }
  assert.equal(detectInitialLanguage({ storage: { getItem: () => 'fr' }, navigatorLanguage: 'zh-Hant-TW' }), 'zh');
  assert.equal(detectInitialLanguage({ storage: { getItem: () => { throw new Error('Storage denied'); } }, navigatorLanguage: 'en-GB' }), 'en');
  assert.equal(detectInitialLanguage({ storage: null, navigatorLanguage: 'ZH-cn' }), 'zh');
  for (const navigatorLanguage of ['de-DE', '', null, undefined]) {
    assert.equal(detectInitialLanguage({ storage: null, navigatorLanguage }), 'en');
  }
});

test('dynamic translations preserve numeric values, units and missing placeholders', () => {
  setLanguage('en');
  assert.equal(t('streamsAdjusted', { from: 30, to: 4 }), 'Concurrency for this test was adjusted from 30 to 4.');
  assert.equal(t('statusTransfer', { direction: t('downloadDirection'), seconds: 7 }), 'Measuring download · 7 s remaining');
  assert.equal(t('secondsUnit', { seconds: 2.416 }), '2.416 s');
  assert.equal(t('previousResult', { time: '10/12, 09:30', download: '1.25 Gbps', upload: '956.2 Mbps' }), 'Previous test 10/12, 09:30 · Download 1.25 Gbps · Upload 956.2 Mbps');
  assert.equal(t('durationOption'), '{seconds} s / phase');
  assert.equal(t('durationOption', Object.create({ seconds: 999 })), '{seconds} s / phase');
  assert.equal(t('unknown-key'), 'unknown-key');
  assert.equal(t('constructor'), 'constructor');
  setLanguage('zh');
  assert.equal(t('secondsUnit', { seconds: 2.416 }), '2.416 秒');
  assert.equal(t('streamsAdjusted', { from: 30, to: 4 }), '本次并发已从 30 路调整为 4 路。');
});

test('manual selection persists independently, rejects invalid codes and notifies without resetting data', context => {
  const writes = [];
  replaceGlobal(context, 'localStorage', { setItem: (key, value) => writes.push([key, value]) });
  replaceGlobal(context, 'document', undefined);
  setLanguage('zh');
  const result = Object.freeze({ downloadMbps: 1250.42, uploadMbps: 19.38 });
  const notifications = [];
  const unsubscribe = onLanguageChange(language => notifications.push({ language, result }));
  assert.equal(setLanguage('en'), true);
  assert.deepEqual(writes.at(-1), [LANGUAGE_STORAGE_KEY, 'en']);
  assert.deepEqual(notifications, [{ language: 'en', result }]);
  assert.equal(setLanguage('en'), true);
  assert.equal(notifications.length, 1, 'unchanged language does not trigger another model render');
  assert.equal(setLanguage('en-US'), false);
  assert.equal(getLanguage(), 'en');
  assert.equal(notifications.length, 1);
  unsubscribe();
  setLanguage('zh');
  assert.equal(notifications.length, 1);
  assert.deepEqual(result, { downloadMbps: 1250.42, uploadMbps: 19.38 });
});

test('language selection remains usable when localStorage access is blocked', context => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  replaceGlobal(context, 'document', undefined);
  assert.doesNotThrow(() => setLanguage('en'));
  assert.equal(getLanguage(), 'en');
  assert.doesNotThrow(() => setLanguage('zh'));
  assert.equal(getLanguage(), 'zh');
});

test('static application uses textContent and controlled attributes, leaving measured numbers intact', context => {
  const payload = '<img src=x onerror=alert(1)>';
  const heading = new TextElement({ 'data-i18n': 'pageTitle' });
  const message = new TextElement({ 'data-i18n': 'concurrencyCount', 'data-i18n-vars': JSON.stringify({ count: payload }) });
  const control = new TextElement({ 'data-i18n-title': 'start', 'data-i18n-aria-label': 'stop', 'data-i18n-placeholder': 'automatic', onclick: 'unchanged' });
  const broken = new TextElement({ 'data-i18n': 'chartTitle', 'data-i18n-vars': '{broken' });
  const measured = new TextElement({ 'data-mbps': '1250.42' }, '1.25');
  const { document, select } = page([heading, message, control, broken, measured]);
  replaceGlobal(context, 'document', document);
  setLanguage('en');
  assert.equal(heading.textContent, 'Your internet speed');
  assert.equal(message.textContent, `${payload} concurrent`, 'substitutions are text rather than parsed markup');
  assert.equal(control.attributes.title, 'Start test');
  assert.equal(control.attributes['aria-label'], 'Stop');
  assert.equal(control.attributes.placeholder, 'Automatic');
  assert.equal(control.attributes.onclick, 'unchanged');
  assert.equal(broken.textContent, 'Measured speed over time');
  assert.equal(measured.textContent, '1.25');
  assert.equal(measured.attributes['data-mbps'], '1250.42');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.title, 'Light Speed · Internet speed test');
  assert.equal(select.value, 'en');
  assert.equal(select.attributes['aria-label'], 'Choose interface language');
  setLanguage('zh');
  assert.equal(heading.textContent, '你的网速');
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(document.title, '轻测速 · 网络测速');
  assert.equal(select.value, 'zh');
  assert.equal(select.attributes['aria-label'], '选择界面语言');
  assert.equal(measured.textContent, '1.25');
});

test('static application supports a marked root and missing keys without touching unrelated content', () => {
  setLanguage('en');
  const root = new TextElement({ 'data-i18n': 'durationOption', 'data-i18n-vars': '{"seconds":20}' });
  applyLanguageText(root);
  assert.equal(root.textContent, '20 s / phase');
  const missing = new TextElement({ 'data-i18n': 'missing-localization-key' });
  applyLanguageText(missing);
  assert.equal(missing.textContent, 'missing-localization-key');
  assert.doesNotThrow(() => applyLanguageText(null));
});

test('Worker errors translate direction, HTTP status and limits without losing diagnostic values', () => {
  setLanguage('en');
  assert.equal(translateError(new Error('测速请求失败（503）')), 'Test request failed (503)');
  assert.equal(translateError(new Error('测速服务暂时不可用（429），请稍后重试。')), 'The test service is temporarily unavailable (429). Please try again later.');
  assert.equal(translateError(new Error('当前部署支持 1 至 30 条并行传输。')), 'This deployment supports 1 to 30 parallel transfers.');
  assert.equal(translateError(new Error('上传测速没有收到有效数据，请检查连接后重试。')), 'The upload test received no measurement data. Check your connection and try again.');
  assert.equal(translateError(new Error('下载测速连接中断，请检查网络后重试。')), 'The download test connection was interrupted. Check your connection and try again.');
  assert.equal(translateError(new Error('WebSocket 测速连接提前关闭')), 'The WebSocket test connection closed early');
  assert.equal(translateError(new Error(translations.zh.offline)), translations.en.offline);
  assert.equal(translateError(new DOMException('测速已停止', 'AbortError')), translations.en.stopped);
  assert.equal(translateError(new Error('尚未记录的新错误')), translations.en.errorIncomplete);
  assert.equal(translateError(new Error('Session expired (404)')), 'Session expired (404)');
  setLanguage('zh');
  assert.equal(translateError(new Error('上传测速没有收到有效数据，请检查连接后重试。')), '上传测速没有收到有效数据，请检查连接后重试。');
  assert.equal(translateError(new Error(translations.en.offline)), translations.zh.offline);
});

test('country codes translate from cached network information without changing configured labels', () => {
  const cached = Object.freeze({ countryCode: 'US', country: 'United States', label: 'A privately configured server location' });
  setLanguage('en');
  assert.equal(localizeCountry(cached.countryCode, cached.country), 'United States');
  assert.equal(localizeCountry('gb', 'United Kingdom'), 'United Kingdom');
  setLanguage('zh');
  assert.equal(localizeCountry(cached.countryCode, cached.country), '美国');
  assert.equal(localizeCountry('gb', 'United Kingdom'), '英国');
  for (const invalid of ['', null, undefined, 'USA', '<script>', '12']) {
    assert.equal(localizeCountry(invalid, cached.label), cached.label);
  }
  assert.equal(localizeCountry('ZZ', cached.label), cached.label);
  assert.equal(cached.label, 'A privately configured server location');
});

test('network information labels distinguish unavailable, private and approximate locations in both languages', () => {
  setLanguage('zh');
  assert.equal(t('networkLoading'), '正在获取…');
  assert.equal(t('networkPrivate'), '内网');
  assert.equal(t('networkLocationUnavailable'), '位置暂不可用');
  assert.equal(t('networkLocationDisabled'), '未启用定位');
  assert.ok(t('networkServerApproximate').includes('出口 IP'));
  setLanguage('en');
  assert.equal(t('networkLoading'), 'Loading…');
  assert.equal(t('networkPrivate'), 'Private network');
  assert.equal(t('networkLocationUnavailable'), 'Location unavailable');
  assert.equal(t('networkLocationDisabled'), 'Location lookup disabled');
  assert.ok(t('networkServerApproximate').includes('outbound IP'));
  assert.ok(t('networkClientApproximate').includes('actual location may differ'));
});

test('both dictionaries cover all declared UI keys and keep technical units unchanged', async () => {
  assert.deepEqual(Object.keys(translations.zh).sort(), Object.keys(translations.en).sort());
  const [html, app] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
  ]);
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([A-Za-z0-9]+)"/g)].map(match => match[1]),
    ...[...app.matchAll(/(?:\bt|\bsetStatus)\("([A-Za-z0-9]+)"/g)].map(match => match[1]),
    ...['phaseIdle', 'phaseLatency', 'phaseDownload', 'phaseUpload', 'phaseComplete', 'phaseStopped', 'phaseError'],
  ]);
  for (const language of supportedLanguages) {
    setLanguage(language);
    for (const key of used) assert.notEqual(t(key), key, `${language}: missing ${key}`);
    const formatted = t('previousResult', { time: '10/12', download: '1.25 Gbps', upload: '950 Mbps' });
    assert.ok(formatted.includes('1.25 Gbps'));
    assert.ok(formatted.includes('950 Mbps'));
  }
});
