import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('deploy/manage.sh');
const managerSource = readFileSync(script);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'testspeed-deployment-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'root');
  const paths = {
    binary: join(root, 'opt/testspeed/testspeed'), manager: join(root, 'opt/testspeed/manage.sh'),
    config: join(root, 'etc/testspeed/testspeed.env'), unit: join(root, 'etc/systemd/system/testspeed.service'),
    version: join(root, 'opt/testspeed/VERSION'),
  };
  const state = join(directory, 'state.json');
  writeFileSync(state, JSON.stringify({ active: false, enabled: false, failRestart: 0 }));
  const systemctl = join(directory, 'fake-systemctl');
  writeFileSync(systemctl, `#!/usr/bin/env node
import fs from 'node:fs';
const file=process.env.FAKE_STATE, state=JSON.parse(fs.readFileSync(file));
const args=process.argv.slice(2), command=args[0];
fs.appendFileSync(process.env.FAKE_SYSTEM_LOG,JSON.stringify(args)+'\\n');
if(command==='is-active') process.exit(state.active?0:3);
if(command==='is-enabled') process.exit(state.enabled?0:1);
if(command==='enable') state.enabled=true;
if(command==='disable') {state.enabled=false;if(args.includes('--now'))state.active=false;}
if(command==='stop')state.active=false;
if(command==='restart'){if(state.failRestart){state.failRestart-=1;fs.writeFileSync(file,JSON.stringify(state));process.exit(1);}state.active=true;state.version=fs.readFileSync(process.env.TASK_TEST_ROOT+'/opt/testspeed/VERSION','utf8').trim();}
fs.writeFileSync(file,JSON.stringify(state));
`, { mode: 0o755 });
  const curl = join(directory, 'fake-curl');
  writeFileSync(curl, `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2), url=args.at(-1);
fs.appendFileSync(process.env.FAKE_CURL_LOG,JSON.stringify(args)+'\\n');
const output=args.indexOf('--output');
if(output>=0){fs.copyFileSync(url.endsWith('SHA256SUMS')?process.env.FAKE_CHECKSUMS:process.env.FAKE_ARCHIVE,args[output+1]);process.exit(0);}
if(process.env.FAKE_BAD_HEALTH==='1')process.exit(22);
if(process.env.FAKE_BAD_HEALTH==='html'){process.stdout.write('<html>ready</html>');process.exit(0);}
const state=JSON.parse(fs.readFileSync(process.env.FAKE_STATE));
process.stdout.write(JSON.stringify(state.version==='v0.1.0'?{status:'ok'}:{status:'ok',version:state.version}));
`, { mode: 0o755 });
  const environment = {
    ...process.env, TASK_TEST_ROOT: root, TESTSPEED_SYSTEMCTL: systemctl, TESTSPEED_CURL: curl,
    FAKE_STATE: state, FAKE_SYSTEM_LOG: join(directory, 'systemctl.jsonl'), FAKE_CURL_LOG: join(directory, 'curl.jsonl'),
  };
  function packageRelease(version, { oldPackage = false } = {}) {
    const payload = join(directory, 'package-' + version); mkdirSync(payload);
    writeFileSync(join(payload, 'testspeed'), `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o755 });
    writeFileSync(join(payload, 'testspeed.service'), '[Service]\nExecStart=/opt/testspeed/testspeed\n');
    writeFileSync(join(payload, 'testspeed.env.example'), 'ADDR=:8080\nTEST_TRANSPORT=websocket\nMEASUREMENT_PORTS=\nMAX_TEST_STREAMS=30\n');
    const members = ['testspeed', 'testspeed.service', 'testspeed.env.example'];
    if (!oldPackage) {
      writeFileSync(join(payload, 'manage.sh'), managerSource, { mode: 0o755 });
      writeFileSync(join(payload, 'VERSION'), version + '\n'); members.push('manage.sh', 'VERSION');
    }
    const archive = join(directory, 'archive-' + version + '.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', payload, ...members], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const checksum = join(directory, 'checksums-' + version);
    const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64';
    writeFileSync(checksum, createHash('sha256').update(readFileSync(archive)).digest('hex') + `  testspeed-linux-${architecture}.tar.gz\n`);
    environment.FAKE_ARCHIVE = archive; environment.FAKE_CHECKSUMS = checksum;
    return { archive, checksum };
  }
  function invoke(args, extra = {}) {
    return spawnSync('bash', [script, ...args], { env: { ...environment, ...extra }, encoding: 'utf8', timeout: 25000 });
  }
  function success(args, extra) {
    const result = invoke(args, extra); assert.equal(result.status, 0, result.stdout + result.stderr); return result;
  }
  return { directory, root, paths, state, environment, packageRelease, invoke, success };
}

test('installer verifies latest package and repeated install restarts the active old service', t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  assert.equal(statSync(f.paths.binary).mode & 0o777, 0o755);
  assert.equal(readFileSync(f.paths.version, 'utf8'), 'v0.1.1\n');
  const oldDescriptor = openSync(f.paths.binary, 'r'); t.after(() => closeSync(oldDescriptor));
  f.packageRelease('v0.1.2'); f.success(['install', 'v0.1.2']);
  const oldBytes = Buffer.alloc(100); const received = readSync(oldDescriptor, oldBytes, 0, oldBytes.length, 0);
  assert.match(oldBytes.subarray(0, received).toString(), /v0\.1\.1/);
  assert.match(readFileSync(f.paths.binary, 'utf8'), /v0\.1\.2/);
  const commands = readFileSync(f.environment.FAKE_SYSTEM_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(commands.filter(args => args[0] === 'restart').length, 2);
  assert.ok(readFileSync(f.environment.FAKE_CURL_LOG, 'utf8').includes('/releases/latest/download/'));
});

test('update preserves custom configuration and unit, including literal shell expressions', t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  const marker = join(f.directory, 'must-not-exist');
  const custom = `ADDR=:8500\nMAX_TEST_STREAMS=24\nNODE_NAME=$(touch ${marker})\nTLS_CERT_FILE=/private/cert.pem\nTLS_KEY_FILE=/private/key.pem\nPUBLIC_ORIGIN=https://speed.example.com:8443\n`;
  writeFileSync(f.paths.config, custom); const customUnit = 'custom administrator unit\n'; writeFileSync(f.paths.unit, customUnit);
  f.packageRelease('v0.1.2'); f.success(['update'], { TESTSPEED_HEALTH_CA: '/private/ca.pem' });
  assert.equal(readFileSync(f.paths.config, 'utf8'), custom);
  assert.equal(readFileSync(f.paths.unit, 'utf8'), customUnit);
  const requests = readFileSync(f.environment.FAKE_CURL_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(args => args.at(-1) === 'https://speed.example.com:8443/healthz' && args.includes('--cacert')));
  assert.ok(requests.every(args => !args.includes('-k') && !args.includes('--insecure')));
  assert.equal(spawnSync('test', ['-e', marker]).status, 1);
});

test('bad checksum rejects a package before replacing files or restarting', t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  const before = readFileSync(f.paths.binary); f.packageRelease('v0.1.2');
  const original = createHash('sha256').update(readFileSync(f.environment.FAKE_ARCHIVE)).digest('hex');
  writeFileSync(f.environment.FAKE_CHECKSUMS, (original[0] === '0' ? '1' : '0') + original.slice(1) + '  testspeed-linux-' + (process.arch === 'arm64' ? 'arm64' : 'amd64') + '.tar.gz\n');
  const result = f.invoke(['update']); assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(f.paths.binary), before);
  assert.equal(readFileSync(f.paths.version, 'utf8'), 'v0.1.1\n');
});

test('restart failure rolls back binary, metadata and previous active service', t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  const before = readFileSync(f.paths.binary); const config = readFileSync(f.paths.config);
  const state = JSON.parse(readFileSync(f.state)); state.failRestart = 1; writeFileSync(f.state, JSON.stringify(state));
  f.packageRelease('v0.1.2'); const result = f.invoke(['update']); assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(f.paths.binary), before); assert.deepEqual(readFileSync(f.paths.config), config);
  assert.equal(readFileSync(f.paths.version, 'utf8'), 'v0.1.1\n');
  assert.equal(JSON.parse(readFileSync(f.state)).active, true);
});

test('failed health check rolls back explicit mode migration and retains custom address', { timeout: 25000 }, t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  const custom = 'ADDR=:8500\nMAX_TEST_STREAMS=24\nMEASUREMENT_PORTS=8081,8082,8083,8084\n'; writeFileSync(f.paths.config, custom);
  const result = f.invoke(['mode', 'websocket'], { FAKE_BAD_HEALTH: 'html' }); assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.paths.config, 'utf8'), custom);
  f.success(['mode', 'websocket']); const updated = readFileSync(f.paths.config, 'utf8');
  assert.match(updated, /^ADDR=:8500$/m); assert.match(updated, /^MAX_TEST_STREAMS=30$/m);
  assert.match(updated, /^TEST_TRANSPORT=websocket$/m); assert.match(updated, /^MEASUREMENT_PORTS=$/m);
});

test('offline update still checks hashes and old package keeps installed manager', t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  const manager = readFileSync(f.paths.manager); const old = f.packageRelease('v0.1.0', { oldPackage: true });
  f.success(['update', 'v0.1.0'], { TESTSPEED_ARCHIVE: old.archive, TESTSPEED_CHECKSUMS: old.checksum });
  assert.deepEqual(readFileSync(f.paths.manager), manager); assert.equal(readFileSync(f.paths.version, 'utf8'), 'v0.1.0\n');
  assert.notEqual(f.invoke(['update'], { TESTSPEED_ARCHIVE: old.archive }).status, 0);
});

test('uninstall keeps config and purge removes only managed files, leaving unrelated data', t => {
  const f = fixture(t); f.packageRelease('v0.1.1'); f.success(['install']);
  const certificate = join(dirname(f.paths.config), 'private-ca.pem'); writeFileSync(certificate, 'keep');
  const unrelated = join(dirname(f.paths.binary), 'unrelated'); writeFileSync(unrelated, 'keep');
  const configuration = readFileSync(f.paths.config);
  f.success(['uninstall']); assert.deepEqual(readFileSync(f.paths.config), configuration);
  assert.equal(spawnSync('test', ['-e', f.paths.binary]).status, 1);
  f.success(['purge']); assert.equal(spawnSync('test', ['-e', f.paths.config]).status, 1);
  assert.equal(readFileSync(certificate, 'utf8'), 'keep'); assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
});
