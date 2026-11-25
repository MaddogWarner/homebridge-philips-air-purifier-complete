'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../../python-runtime');
const plugin = require('../../index.js');
const { _PhilipsAirPurifierAccessory: Accessory } = plugin;

const pluginDir = path.join(__dirname, '..', '..');

// Environment test: needs a Python 3.11+ on the machine (CI installs one).
test('a system Python loads the bundled packages with nothing pip-installed', () => {
  const { found } = runtime.findPython(pluginDir);
  assert.ok(found, 'expected a Python 3.11+ on this machine');
  const [major, minor] = found.version.split('.').map(Number);
  const [minMajor, minMinor] = runtime.PYTHON_MIN_VERSION.split('.').map(Number);
  assert.ok(major > minMajor || (major === minMajor && minor >= minMinor), found.version);
});

test('inspectPython distinguishes missing, too old and import failure', (t) => {
  assert.equal(runtime.inspectPython(path.join(pluginDir, 'no-such-python'), pluginDir).reason, 'missing');

  // A fake interpreter: prints an old version and exits like the real check.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-python-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  if (process.platform !== 'win32') {
    const old = runtime.inspectPython(fake('python3.10', 'echo 3.10.12; exit 3'), pluginDir);
    assert.deepEqual(old, { ok: false, version: '3.10.12', reason: 'too-old' });
    assert.match(runtime.describeRejection({ path: 'p', ...old }), /Python 3\.10\.12, older than 3\.11/);

    const broken = runtime.inspectPython(fake('python3.12', 'echo 3.12.1; exit 1'), pluginDir);
    assert.equal(broken.reason, 'import-failed');
    assert.equal(broken.version, '3.12.1');
  }
});

test('pythonPathError accepts paths and command names but refuses shell metacharacters', () => {
  for (const ok of ['/usr/bin/python3', 'python3.12', 'pypy3', 'bin/python3', 'C:\\Python312\\python.exe']) {
    assert.equal(runtime.pythonPathError(ok), '', ok);
  }
  for (const bad of ['', 'python3; rm -rf /', 'python3 && x', '$(id)', 'a`b`', 'x'.repeat(5000)]) {
    assert.notEqual(runtime.pythonPathError(bad), '', bad);
  }
});

test('install hints are platform-specific', () => {
  assert.match(runtime.pythonInstallHint('darwin'), /brew install python/);
  assert.match(runtime.pythonInstallHint('win32'), /python\.org/);
  assert.match(runtime.pythonInstallHint('linux'), /apt install python3/);
});

test('without a usable Python the accessory logs one actionable error and returns null', () => {
  const accessory = Object.create(Accessory.prototype);
  const errors = [];
  accessory.log = { error: (msg) => errors.push(msg), debug() {} };
  // A plugin dir without the bundled packages fails the import check on
  // every interpreter, which is exactly the "no usable Python" case.
  assert.equal(accessory.findPython(path.join(pluginDir, 'no-such-dir')), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No usable Python 3\.11\+ was found/);
  assert.match(errors[0], /Checked: .*could not load the plugin's bundled packages/);
  assert.match(errors[0], /pythonPath/);
  assert.match(errors[0], /Environment check/);
});

test('Python discovery runs once per plugin dir, however many devices there are', (t) => {
  const listeners = {};
  const api = {
    on: (event, fn) => { listeners[event] = fn; },
    hap: { uuid: { generate: (seed) => `uuid-${seed}` } },
    platformAccessory: class { constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; } },
    registerPlatformAccessories() {},
    unregisterPlatformAccessories() {},
  };
  const calls = t.mock.method(Accessory.prototype, 'findPython', () => null);
  t.mock.method(Accessory.prototype, 'setupServices', () => {});
  t.mock.method(Accessory.prototype, 'startDaemon', () => {});

  let PlatformClass;
  plugin({ registerPlatform: (_name, cls) => { PlatformClass = cls; } });
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  new PlatformClass(log, {
    devices: [
      { name: 'A', host: '10.0.0.2' },
      { name: 'B', host: '10.0.0.3' },
      { name: 'C', host: '10.0.0.4' },
    ],
  }, api);
  listeners.didFinishLaunching();
  // node --test runs each file in its own process, so nothing earlier in
  // this file has filled the module-level cache.
  assert.equal(calls.mock.callCount(), 1);
});

test('without Python the daemon is never started or retried', async () => {
  const accessory = Object.create(Accessory.prototype);
  accessory.pythonPath = null;
  let started = 0;
  let restarts = 0;
  accessory.daemon = { start: () => { started++; } };
  accessory.scheduleDaemonRestart = () => { restarts++; };
  await accessory.startDaemon();

  assert.equal(started, 0);
  assert.equal(restarts, 0);
  assert.equal(accessory.deviceReachable, false);
});
