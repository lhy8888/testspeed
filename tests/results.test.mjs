import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HISTORY_KEY, HISTORY_LIMIT, SETTINGS_KEY, appendHistory, clearHistory, csvCell, normalizeLatency,
  normalizePhase, normalizeResult, normalizeSettings, readHistory, readSettings, resultJSON, resultsCSV, toShareRecord,
} from '../web/results.js';

const stats = { medianMs: 212, jitterMs: 8, samples: 8, failed: 0, attempts: 8 };
const phase = { mbps: 100, durationMs: 10000, measuredBytes: 125000000, totalBytes: 130000000, completionReason: 'duration', complete: true, budgetOvershootBytes: 0, connections: { peak: 8 } };
function result(overrides = {}) {
  return {
    schemaVersion: 1, completedAt: '2026-10-12T12:00:00.000Z', node: { id: 'single', name: 'Test node', baseUrl: 'http://secret.example' },
    testType: 'full', measurementPolicy: 'fixed', transport: { transport: 'websocket', reason: 'configured-origins' }, mode: 'manual', maxBytes: 0,
    download: { ...phase }, upload: { ...phase, mbps: 50, measuredBytes: 62500000, totalBytes: 70000000 },
    latency: { idle: { ...stats }, download: { ...stats }, upload: { ...stats } },
    client: { ip: '192.0.2.25', isp: 'PRIVATE', token: 'NEVER_EXPORT' }, ...overrides,
  };
}
class Storage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

test('settings migrate v3 without changing defaults and reject corrupted or unsupported values', () => {
  assert.deepEqual(normalizeSettings(), { mode: 'manual', streams: 8, durationMs: null, testType: 'full', measurementPolicy: 'fixed', maxBytes: 0 });
  const storage = new Storage();
  storage.setItem('light-speed:settings:v3', JSON.stringify({ mode: 'auto', streams: 30, durationMs: 20000 }));
  assert.deepEqual(readSettings(storage), { saved: true, settings: { mode: 'auto', streams: 30, durationMs: 20000, testType: 'full', measurementPolicy: 'fixed', maxBytes: 0 } });
  storage.setItem(SETTINGS_KEY, JSON.stringify({ mode: 'wrong', streams: -1, durationMs: 42, testType: 'latency', measurementPolicy: 'adaptive', maxBytes: 1073741824 }));
  assert.deepEqual(readSettings(storage).settings, { mode: 'manual', streams: 8, durationMs: null, testType: 'latency', measurementPolicy: 'adaptive', maxBytes: 1073741824 });
  assert.equal(normalizeSettings({ streams: 100 }).streams, 30);
  assert.equal(normalizeSettings({ maxBytes: Infinity }).maxBytes, 0);
  storage.setItem(SETTINGS_KEY, '{broken');
  assert.equal(readSettings(storage).saved, false);
  assert.deepEqual(readSettings({ getItem() { throw Error('blocked'); } }).settings, normalizeSettings());
});

test('normalization retains actual measurements and an explicit allowlist without network or credential data', () => {
  const normalized = normalizeResult(result());
  assert.equal(normalized.download.mbps, 100);
  assert.equal(normalized.download.totalBytes, 130000000);
  assert.equal(normalized.transport, 'websocket');
  assert.deepEqual(normalized.connections, { downloadPeak: 8, uploadPeak: 8 });
  assert.deepEqual(normalizeResult(normalized), normalized);
  const json = resultJSON(result());
  for (const secret of ['192.0.2.25', 'PRIVATE', 'NEVER_EXPORT', 'secret.example', 'baseUrl']) assert.equal(json.includes(secret), false);
  assert.equal(JSON.parse(json).schemaVersion, 1);
});

test('skipped phases stay null for download and latency-only records, with no invented zero rates', () => {
  const download = normalizeResult(result({ testType: 'download', upload: null, latency: { idle: stats, download: stats, upload: null } }));
  assert.equal(download.upload, null);
  assert.equal(download.latency.upload, null);
  const latency = normalizeResult(result({ testType: 'latency', transport: null, download: null, upload: null, latency: { idle: stats, download: null, upload: null } }));
  assert.equal(latency.transport, null);
  assert.equal(latency.download, null);
  assert.equal(latency.upload, null);
  assert.equal(toShareRecord(latency).transport, null);
  assert.equal(normalizeResult(result({ testType: 'latency' })), null);
  assert.equal(normalizeResult(result({ testType: 'download' })), null);
});

test('a budget exhausted during warm-up is a partial record with a null rate and actual consumed bytes', () => {
  const limited = result({ maxBytes: 1073741824, download: { ...phase, complete: false, mbps: null, measuredBytes: 0, durationMs: 0, totalBytes: 1073745920, completionReason: 'budget', budgetOvershootBytes: 4096 } });
  const normalized = normalizeResult(limited);
  assert.equal(normalized.download.mbps, null);
  assert.equal(normalized.download.complete, false);
  assert.equal(normalized.download.incompleteReason, 'budget-before-measurement');
  assert.equal(normalized.download.totalBytes, 1073745920);
  assert.equal(normalized.download.budgetOvershootBytes, 4096);
  assert.equal(normalized.maxBytes, 1073741824);
  assert.equal(normalizePhase({ ...limited.download, mbps: '0' }), null);
  assert.equal(normalizePhase({ ...limited.download, complete: undefined }), null);
});

test('single-sample latency has unknown jitter, while inconsistent attempts and bogus rates are rejected', () => {
  assert.deepEqual(normalizeLatency({ medianMs: 10, jitterMs: null, samples: 1, failed: 0, attempts: 1 }), { medianMs: 10, jitterMs: null, samples: 1, failed: 0, attempts: 1 });
  assert.deepEqual(normalizeLatency({ medianMs: null, jitterMs: null, samples: 0, failed: 1, attempts: 1 }), { medianMs: null, jitterMs: null, samples: 0, failed: 1, attempts: 1 });
  assert.equal(normalizeLatency({ ...stats, attempts: 1 }), null);
  assert.equal(normalizeLatency({ ...stats, medianMs: '12' }), null);
  for (const mbps of [-1, NaN, Infinity, '100']) assert.equal(normalizeResult(result({ download: { ...phase, mbps } })), null);
  assert.equal(normalizeResult(result({ completedAt: 'invalid' })), null);
  assert.equal(normalizeResult(result({ completedAt: '2026' })), null);
  assert.equal(normalizeResult(result({ schemaVersion: 2 })), null);
  assert.equal(normalizeResult(result({ latency: { idle: { medianMs: null, jitterMs: null, samples: 0, failed: 8, attempts: 8 } } })), null);
  assert.equal(normalizeResult(result({ download: { ...phase, measuredBytes: phase.totalBytes + 1 } })), null);
});

test('share payload matches the server allowlist and strips local budget diagnostics and all extras', () => {
  const shared = toShareRecord(result({ maxBytes: 5368709120, download: { ...phase, completionReason: 'budget', budgetOvershootBytes: 8192 } }));
  assert.deepEqual(Object.keys(shared).sort(), ['schemaVersion', 'completedAt', 'node', 'testType', 'measurementPolicy', 'transport', 'mode', 'download', 'upload', 'latency', 'connections'].sort());
  assert.deepEqual(Object.keys(shared.download).sort(), ['mbps', 'durationMs', 'measuredBytes', 'totalBytes', 'completionReason', 'complete'].sort());
  assert.equal(shared.download.completionReason, 'budget');
  assert.equal(shared.maxBytes, undefined);
  assert.equal(shared.client, undefined);
  assert.equal(shared.node.baseUrl, undefined);
});

test('history stays bounded, newest first, replaces duplicate timestamps and survives blocked writes', () => {
  const storage = new Storage();
  let records = [];
  for (let i = 0; i < 80; i++) records = appendHistory(records, result({ completedAt: new Date(Date.UTC(2026, 9, 12, 12, 0, i)).toISOString() }), storage).records;
  assert.equal(records.length, HISTORY_LIMIT);
  assert.equal(records[0].completedAt, '2026-10-12T12:01:19.000Z');
  assert.deepEqual(readHistory(storage), records);
  const repeated = appendHistory(records, { ...records[0], node: { id: 'single', name: 'Updated' } }, storage);
  assert.equal(repeated.records.length, HISTORY_LIMIT);
  assert.equal(repeated.records[0].node.name, 'Updated');
  const blocked = appendHistory([], result(), { setItem() { throw Error('quota exceeded'); } });
  assert.equal(blocked.saved, false);
  assert.equal(blocked.records.length, 1);
  assert.equal(appendHistory(records, { cancelled: true }, storage).records.length, HISTORY_LIMIT);
  assert.equal(appendHistory(records, { cancelled: true }, storage).saved, false);
});

test('corrupted, enormous and invalid local history cannot break startup or exceed the retained bound', () => {
  const storage = new Storage();
  for (const raw of ['{', '{}', 'null', '"text"', 'x'.repeat(1024 * 1024 + 1)]) {
    storage.setItem(HISTORY_KEY, raw);
    assert.deepEqual(readHistory(storage), []);
  }
  storage.setItem(HISTORY_KEY, JSON.stringify([null, {}, { ...result(), completedAt: 'bad' }, result()]));
  assert.equal(readHistory(storage).length, 1);
  assert.deepEqual(readHistory({ getItem() { throw Error('blocked'); } }), []);
  storage.setItem('light-speed:last-result', JSON.stringify(result()));
  assert.equal(clearHistory(storage), true);
  assert.equal(storage.getItem(HISTORY_KEY), null);
  assert.equal(storage.getItem('light-speed:last-result'), null);
  assert.equal(clearHistory({ removeItem() { throw Error('blocked'); } }), false);
});

test('CSV quoting neutralizes formulas and keeps skipped rates empty instead of a misleading zero', () => {
  for (const value of ['=HYPERLINK("evil")', '+cmd', '-2+2', '@SUM(1)', '  =1', '\tvalue', '\rvalue']) assert.equal(csvCell(value).startsWith('"\''), true);
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(0), '"0"');
  const csv = resultsCSV(result({ node: { id: 'single', name: '=HYPERLINK("evil")' }, testType: 'download', upload: null, latency: { idle: stats, download: stats, upload: null } }));
  assert.equal(csv.startsWith('\uFEFF"completed_at"'), true);
  assert.equal(csv.includes('"\'=HYPERLINK(""evil"")"'), true);
  assert.equal(csv.includes('"websocket","100","","212"'), true);
  assert.equal(csv.includes('192.0.2.25'), false);
  assert.equal(csv.includes('budget_bytes_per_direction'), true);
  assert.equal(csv.endsWith('\r\n'), true);
});
