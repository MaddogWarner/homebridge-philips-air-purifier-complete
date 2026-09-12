'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const plugin = require(path.join(__dirname, '..', '..', 'index.js'));
const { _PhilipsAirPurifierAccessory: Accessory } = plugin;

// Drive the accessory's power-on/mode bookkeeping without a daemon: stub
// the pieces executeCommand and handleObserveUpdate touch.
function makeAccessory({ ac1715 = true } = {}) {
  const acc = Object.create(Accessory.prototype);
  acc.log = { info: (m) => acc.infos.push(m), error: (m) => acc.errors.push(m), debug() {}, warn() {} };
  acc.infos = [];
  acc.errors = [];
  acc.sent = [];
  acc.state = { power: false, mode: 'auto', lightLevel: 0, childLock: false };
  acc.deviceReachable = true;
  acc.lastPower = false;
  acc.lastMode = 'auto';
  acc.lastManualMode = 'medium';
  acc.lastNonSleepMode = 'auto';
  acc._commandCount = 0;
  acc._powerOnSentAt = 0;
  acc._modeAfterPowerOn = null;
  acc.daemon = { execute: async (cmd, args) => { acc.sent.push([cmd, ...args]); } };
  acc.isAC1715 = () => ac1715;
  acc.normalizeMode = (m) => m;
  acc.updatePurifierCharacteristics = () => {};
  acc.updateLightCharacteristics = () => {};
  acc.updateAirQualityCharacteristics = () => {};
  acc.updateFilterCharacteristics = () => {};
  acc.updateSleepCharacteristics = () => {};
  return acc;
}

const status = (power, mode) => ({ power, mode, light_level: 0, child_lock: false, pm25: 3 });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Send power on, then pretend the 1.5 s settle has already elapsed so the
// mode writes in the tests below go out immediately.
async function powerOn(acc) {
  await acc.executeCommand('power', ['on'], { power: true });
  acc._powerOnSentAt -= 1500;
}

test('a mode write is held 1.5 s after a power-on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  await acc.executeCommand('power', ['on'], { power: true });
  const pending = acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  await Promise.resolve();
  assert.deepEqual(acc.sent, [['power', 'on']]);

  t.mock.timers.tick(1400);
  await Promise.resolve();
  assert.equal(acc.sent.length, 1);

  t.mock.timers.tick(100);
  await pending;
  assert.deepEqual(acc.sent.at(-1), ['mode', 'turbo']);
});

test('a mode write goes out at once when no power-on preceded it', async () => {
  const acc = makeAccessory();
  acc.state.power = true;
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  assert.deepEqual(acc.sent, [['mode', 'turbo']]);
});

test('a status confirming power ON releases the hold early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  await acc.executeCommand('power', ['on'], { power: true });
  acc._commandCount = 0;
  acc.handleObserveUpdate(status(true, 'auto'));
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  assert.deepEqual(acc.sent, [['power', 'on'], ['mode', 'turbo']]);
});

test('a mode requested during power-on is re-sent when the device wakes up in Auto', async () => {
  const acc = makeAccessory();

  // 22:00 automation: Power ON, TargetState MANUAL, RotationSpeed 100%.
  await powerOn(acc);
  await acc.executeCommand('mode', ['medium'], { mode: 'medium' });
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  assert.deepEqual(acc.sent, [['power', 'on'], ['mode', 'medium'], ['mode', 'turbo']]);
  acc._commandCount = 0; // the 500 ms unlock, without waiting for it

  // Device comes up in its power-on default.
  acc.handleObserveUpdate(status(true, 'auto'));
  await tick();

  assert.deepEqual(acc.sent.at(-1), ['mode', 'turbo']);
  assert.equal(acc.sent.length, 4);
  assert.equal(acc.state.mode, 'turbo');
  assert.equal(acc.lastManualMode, 'turbo');
  assert.equal(acc.lastNonSleepMode, 'turbo');
  assert.ok(acc.infos.some((m) => m.includes('re-sending requested mode turbo')));

  // Later reports are left alone — no fighting the panel or the app.
  acc.handleObserveUpdate(status(true, 'auto'));
  await tick();
  assert.equal(acc.sent.length, 4);
});

test('nothing is re-sent when the requested mode stuck', async () => {
  const acc = makeAccessory();
  await powerOn(acc);
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  acc._commandCount = 0;

  acc.handleObserveUpdate(status(true, 'turbo'));
  await tick();
  assert.equal(acc.sent.length, 2);
  assert.equal(acc._powerOnSentAt, 0);
});

test('a mode change on an already-running purifier is never re-sent', async () => {
  const acc = makeAccessory();
  acc.state.power = true;
  acc.lastPower = true;
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  acc._commandCount = 0;

  // Someone switches it to Auto on the panel a moment later.
  acc.handleObserveUpdate(status(true, 'auto'));
  await tick();
  assert.equal(acc.sent.length, 1);
  assert.equal(acc.state.mode, 'auto');
});

test('a power-off cancels any pending re-send', async () => {
  const acc = makeAccessory();
  await powerOn(acc);
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  await acc.executeCommand('power', ['off'], { power: false });
  acc._commandCount = 0;

  acc.handleObserveUpdate(status(true, 'auto'));
  await tick();
  assert.equal(acc.sent.length, 3);
});

test('a stale power-on is forgotten instead of re-sending an old mode', async () => {
  const acc = makeAccessory();
  await powerOn(acc);
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  acc._commandCount = 0;
  acc._powerOnSentAt = Date.now() - 120000;

  acc.handleObserveUpdate(status(true, 'auto'));
  await tick();
  assert.equal(acc.sent.length, 2);
  assert.equal(acc._modeAfterPowerOn, null);
});

test('an Auto request after power-on is re-sent too', async () => {
  const acc = makeAccessory();
  await powerOn(acc);
  await acc.executeCommand('mode', ['auto'], { mode: 'auto' });
  acc._commandCount = 0;

  acc.handleObserveUpdate(status(true, 'turbo'));
  await tick();
  assert.deepEqual(acc.sent.at(-1), ['mode', 'auto']);
  assert.equal(acc.lastManualMode, 'turbo');
  assert.equal(acc.lastNonSleepMode, 'auto');
});
