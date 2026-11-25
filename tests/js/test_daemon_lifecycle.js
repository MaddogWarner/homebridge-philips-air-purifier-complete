'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const path = require('node:path');

// Replace spawn with a factory of fake child processes before index.js
// captures it.
const children = [];
function makeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); };
  child.die = (code = 1) => {
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  children.push(child);
  return child;
}

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node:child_process') {
    return { ...realLoad.call(this, request, ...rest), spawn: () => makeChild() };
  }
  return realLoad.call(this, request, ...rest);
};
let plugin;
try {
  plugin = require(path.join(__dirname, '..', '..', 'index.js'));
} finally {
  Module._load = realLoad;
}
const { _DaemonHandler: DaemonHandler, _PhilipsAirPurifierAccessory: Accessory } = plugin;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

test('a daemon that dies before ready rejects start() and does not also call onExit', async () => {
  let exits = 0;
  const handler = new DaemonHandler(quietLog, null, () => { exits++; }, null);
  const started = handler.start('python3', '/x/philips_air_api.py', '10.0.0.1');
  children.at(-1).die(1);
  await assert.rejects(started, /exited before ready/);
  assert.equal(exits, 0);
  assert.equal(handler.daemon, null);
});

test('after ready, an unexpected exit calls onExit exactly once and rejects in-flight commands', async () => {
  let exits = 0;
  const handler = new DaemonHandler(quietLog, null, () => { exits++; }, null);
  const started = handler.start('python3', '/x/philips_air_api.py', '10.0.0.1');
  const child = children.at(-1);
  child.stdout.write(JSON.stringify({ type: 'ready', connected: true }) + '\n');
  assert.equal(await started, true);
  const pending = handler.execute('power', ['on']);
  child.die(1);
  await assert.rejects(pending, /Daemon exited/);
  assert.equal(exits, 1);
});

test('startup timeout kills the process and its later exit is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let exits = 0;
  const handler = new DaemonHandler(quietLog, null, () => { exits++; }, null);
  const started = handler.start('python3', '/x/philips_air_api.py', '10.0.0.1');
  const child = children.at(-1);
  t.mock.timers.tick(20000);
  await assert.rejects(started, /startup timeout/);
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.die(0);
  assert.equal(exits, 0);
  t.mock.timers.tick(5000);
  assert.deepEqual(child.signals, ['SIGTERM'], 'no SIGKILL once the process has exited');
});

test('a replaced process cannot clear the new daemon reference', async () => {
  const handler = new DaemonHandler(quietLog, null, null, null);
  handler.start('python3', '/x/philips_air_api.py', '10.0.0.1').catch(() => {});
  const first = children.at(-1);
  const started = handler.start('python3', '/x/philips_air_api.py', '10.0.0.1');
  const second = children.at(-1);
  assert.deepEqual(first.signals, ['SIGTERM']);
  first.die(0);
  assert.equal(handler.daemon, second);
  second.stdout.write(JSON.stringify({ type: 'ready', connected: true }) + '\n');
  assert.equal(await started, true);
});

function makeAccessory() {
  const acc = Object.create(Accessory.prototype);
  acc.log = quietLog;
  acc.state = { power: false, mode: 'auto', lightLevel: 0, childLock: false };
  acc._commandCount = 0;
  acc._powerOffGeneration = 0;
  acc._powerOnSentAt = 0;
  acc._modeAfterPowerOn = null;
  acc.api = { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
  acc.updates = 0;
  acc.updatePurifierCharacteristics = () => { acc.updates++; };
  acc.updateLightCharacteristics = () => {};
  acc.updateSleepCharacteristics = () => {};
  return acc;
}

test('a failed command rolls back its optimistic state and resyncs HomeKit', async () => {
  const acc = makeAccessory();
  acc.daemon = { execute: async () => { throw new Error('device gone'); } };
  await assert.rejects(acc.sendCommand('power', ['on'], { power: true }));
  assert.equal(acc.state.power, false);
  assert.equal(acc._powerOnSentAt, 0);
  assert.ok(acc.updates > 0);
});

test('a successful command keeps its optimistic state', async () => {
  const acc = makeAccessory();
  acc.daemon = { execute: async () => {} };
  await acc.sendCommand('power', ['on'], { power: true });
  assert.equal(acc.state.power, true);
});

test('reads report No Response while the device is unreachable', () => {
  const acc = makeAccessory();
  acc.deviceReachable = false;
  assert.throws(() => acc.readWhenReachable(() => 1), acc.api.hap.HapStatusError);
  acc.deviceReachable = true;
  assert.equal(acc.readWhenReachable(() => 1), 1);
});

test('destroy cancels a pending restart so no daemon starts after shutdown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const acc = makeAccessory();
  acc._restartAttempt = 0;
  let starts = 0;
  acc.startDaemon = () => { starts++; };
  acc.daemon = { stop() {} };
  acc.scheduleDaemonRestart();
  acc.scheduleDaemonRestart(); // a second request while one is pending is ignored
  acc.destroy();
  t.mock.timers.tick(60000);
  assert.equal(starts, 0);
  assert.equal(acc._restartAttempt, 1);
});

test('one invalid device does not stop the others from loading', (t) => {
  const registered = [];
  const errors = [];
  const constructed = [];
  const log = { ...quietLog, error: (m) => errors.push(m) };
  const listeners = {};
  class FakePlatformAccessory {
    constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; }
  }
  const api = {
    on: (event, fn) => { listeners[event] = fn; },
    hap: { uuid: { generate: (seed) => `uuid-${seed}` } },
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories: (_p, _n, accs) => registered.push(...accs.map((a) => a.UUID)),
    unregisterPlatformAccessories() {},
  };
  // Skip Python discovery, HomeKit services and the daemon; host and
  // protocol validation still run for real.
  t.mock.method(Accessory.prototype, 'findPython', () => 'python3');
  t.mock.method(Accessory.prototype, 'setupServices', function () { constructed.push(this.host); });
  t.mock.method(Accessory.prototype, 'startDaemon', () => {});

  let PlatformClass;
  plugin({ registerAccessory() {}, registerPlatform: (_name, cls) => { PlatformClass = cls; } });
  new PlatformClass(log, {
    devices: [
      { name: 'Bad', host: 'purifier.local' },
      { name: 'Good', host: '10.0.0.2' },
    ],
  }, api);
  listeners.didFinishLaunching();

  assert.deepEqual(constructed, ['10.0.0.2']);
  assert.deepEqual(registered, ['uuid-10.0.0.2']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"Bad" not loaded: host must be a valid IPv4 address/);
});

test('Air+ token defaults to Homebridge storage, falling back to an existing legacy file', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { _defaultAirplusTokenFile: defaultTokenFile } = plugin;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'philips-home-'));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'philips-storage-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  });
  t.mock.method(os, 'homedir', () => home);
  const api = { user: { storagePath: () => storage } };
  const legacy = path.join(home, '.homebridge', 'philips-airplus-dev1.json');
  const current = path.join(storage, 'philips-airplus-dev1.json');

  assert.equal(defaultTokenFile(api, 'dev1'), current);

  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{}');
  assert.equal(defaultTokenFile(api, 'dev1'), legacy);

  fs.writeFileSync(current, '{}');
  assert.equal(defaultTokenFile(api, 'dev1'), current);
});
