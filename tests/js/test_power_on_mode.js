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
  acc._pendingCommands = new Map();
  acc.api = { hap: { HapStatusError: Error, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'communication failed' } } };
  acc._autoRequestedAt = 0;
  acc._powerOnSentAt = 0;
  acc._modeAfterPowerOn = null;
  acc.daemon = { execute: async (cmd, args) => { acc.sent.push([cmd, ...args]); } };
  acc.isAC1715 = () => ac1715;
  acc.normalizeMode = (m) => m;
  acc.purifierUpdates = 0;
  acc.updatePurifierCharacteristics = () => { acc.purifierUpdates++; };
  acc.updateLightCharacteristics = () => {};
  acc.updateAirQualityCharacteristics = () => {};
  acc.updateFilterCharacteristics = () => {};
  acc.updateSleepCharacteristics = () => {};
  return acc;
}

// Capture the actual onSet handlers so scene tests exercise both model
// branches, including the AC1715 slider debounce.
function wireModelControls(acc, { cachedChildLock = false } = {}) {
  const makeService = () => {
    const characteristics = new Map();
    return {
      getCharacteristic(key) {
        if (!characteristics.has(key)) {
          characteristics.set(key, {
            onGet(handler) { this.get = handler; return this; },
            onSet(handler) { this.set = handler; return this; },
            setProps(props) { this.props = props; return this; },
          });
        }
        return characteristics.get(key);
      },
      setCharacteristic() { return this; },
      addLinkedService() {},
      testCharacteristic(key) { return characteristics.has(key); },
      removeCharacteristic(characteristic) {
        for (const [key, value] of characteristics) {
          if (value === characteristic) characteristics.delete(key);
        }
      },
      updateCharacteristic(key, value) { this.getCharacteristic(key).value = value; },
    };
  };
  acc.Service = { Switch: 'Switch', Lightbulb: 'Lightbulb' };
  acc.Characteristic = {
    TargetAirPurifierState: { AUTO: 1, MANUAL: 0 },
    RotationSpeed: 'RotationSpeed',
    On: 'On',
    Name: 'Name',
    Brightness: 'Brightness',
    Active: 'Active',
    CurrentAirPurifierState: { PURIFYING_AIR: 2, INACTIVE: 0 },
    LockPhysicalControls: { CONTROL_LOCK_ENABLED: 1, CONTROL_LOCK_DISABLED: 0 },
  };
  acc.purifierService = makeService();
  if (cachedChildLock) acc.purifierService.getCharacteristic(acc.Characteristic.LockPhysicalControls);
  acc.platformAcc = {
    context: {},
    getService() {},
    getServiceById() {},
    addService: makeService,
  };
  acc.setupModelDependentServices();
  return {
    target: acc.purifierService.getCharacteristic(acc.Characteristic.TargetAirPurifierState),
    speed: acc.purifierService.getCharacteristic(acc.Characteristic.RotationSpeed),
  };
}

const status = (power, mode) => ({ power, mode, light_level: 0, child_lock: false, pm25: 3 });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('AC1715 LED switch follows local power changes without extra light commands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  wireModelControls(acc);
  acc.updateLightCharacteristics = Accessory.prototype.updateLightCharacteristics;
  acc.state.power = true;
  acc.state.lightLevel = 123;
  acc.lastLightLevel = 123;
  const led = acc.lightService.getCharacteristic(acc.Characteristic.On);
  acc.updateLightCharacteristics();
  assert.equal(led.value, true);

  await acc.executeCommand('power', ['off'], { power: false });
  assert.equal(led.value, false);
  assert.equal(led.get(), false);
  assert.equal(acc.state.lightLevel, 123);
  assert.equal(acc.lastLightLevel, 123);

  await acc.executeCommand('power', ['on'], { power: true });
  assert.equal(led.value, true);
  assert.equal(led.get(), true);
  assert.deepEqual(acc.sent, [['power', 'off'], ['power', 'on']]);
});

test('AC1715 LED switch stays off when an off device reports its remembered light level', () => {
  const acc = makeAccessory();
  wireModelControls(acc);
  acc.updateLightCharacteristics = Accessory.prototype.updateLightCharacteristics;
  const led = acc.lightService.getCharacteristic(acc.Characteristic.On);

  acc.handleObserveUpdate({ ...status(false, 'auto'), light_level: 123 });
  assert.equal(led.value, false);
  assert.equal(led.get(), false);
  acc.handleObserveUpdate({ ...status(true, 'auto'), light_level: 123 });
  assert.equal(led.value, true);
  assert.equal(led.get(), true);
});

test('powering AC1715 on uses the reported LED setting without forcing a light change', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  wireModelControls(acc);
  acc.updateLightCharacteristics = Accessory.prototype.updateLightCharacteristics;
  await acc.executeCommand('power', ['on'], { power: true });
  const led = acc.lightService.getCharacteristic(acc.Characteristic.On);
  assert.equal(led.value, false);
  assert.equal(led.get(), false);
  assert.deepEqual(acc.sent, [['power', 'on']]);

  // If the device enables its LED during startup, its report updates HomeKit.
  t.mock.timers.tick(500);
  acc.handleObserveUpdate({ ...status(true, 'auto'), light_level: 123 });
  assert.equal(led.value, true);
  assert.equal(led.get(), true);
  assert.deepEqual(acc.sent, [['power', 'on']]);
});

test('a repeated power-on does not overwrite a manually disabled LED on a running AC1715', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  wireModelControls(acc);
  acc.updateLightCharacteristics = Accessory.prototype.updateLightCharacteristics;
  acc.state.power = true;
  acc.state.lightLevel = 0;
  await acc.executeCommand('power', ['on'], { power: true });
  const led = acc.lightService.getCharacteristic(acc.Characteristic.On);
  assert.equal(led.value, false);
  assert.equal(led.get(), false);
});

test('an explicit LED-off during power-on is preserved when the power command completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  wireModelControls(acc);
  acc.updateLightCharacteristics = Accessory.prototype.updateLightCharacteristics;
  acc.state.lightLevel = 123;
  let finishPowerOn;
  acc.daemon.execute = (cmd, args) => {
    acc.sent.push([cmd, ...args]);
    if (cmd === 'power') return new Promise((resolve) => { finishPowerOn = resolve; });
    return Promise.resolve();
  };
  const powerOn = acc.executeCommand('power', ['on'], { power: true });
  const led = acc.lightService.getCharacteristic(acc.Characteristic.On);
  await led.set(false);
  finishPowerOn();
  await powerOn;
  assert.equal(led.value, false);
  assert.equal(led.get(), false);
  assert.deepEqual(acc.sent, [['power', 'on'], ['light', '0']]);
});

test('0% fan speed also refreshes the AC1715 LED switch to off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  const { speed } = wireModelControls(acc);
  acc.updateLightCharacteristics = Accessory.prototype.updateLightCharacteristics;
  acc.state.power = true;
  acc.state.lightLevel = 123;
  acc.updateLightCharacteristics();
  await speed.set(0);
  t.mock.timers.tick(400);
  await tick();
  assert.equal(acc.lightService.getCharacteristic(acc.Characteristic.On).value, false);
  assert.deepEqual(acc.sent, [['power', 'off']]);
});

for (const modelId of ['AC1715/10', 'AC1715/11']) {
  test(`${modelId} removes cached child lock, does not restore it on update, and ignores writes`, async () => {
    const acc = makeAccessory();
    delete acc.isAC1715;
    acc.modelId = modelId;
    wireModelControls(acc, { cachedChildLock: true });
    const lock = acc.Characteristic.LockPhysicalControls;
    assert.equal(acc.purifierService.testCharacteristic(lock), false);

    Accessory.prototype.updatePurifierCharacteristics.call(acc);
    assert.equal(acc.purifierService.testCharacteristic(lock), false);
    await acc.executeCommand('childlock', ['on'], { childLock: true });
    await acc.executeCommand('childlock', ['off'], { childLock: false });
    assert.deepEqual(acc.sent, []);
    assert.equal(acc.state.childLock, false);
  });
}

test('late AC1715 detection removes the child lock and ignores a stale handler', async () => {
  const acc = makeAccessory();
  delete acc.isAC1715;
  acc.modelId = '';
  acc.api.platformAccessory = class {};
  wireModelControls(acc);
  const lock = acc.Characteristic.LockPhysicalControls;
  const staleControl = acc.purifierService.getCharacteristic(lock);
  assert.equal(acc.purifierService.testCharacteristic(lock), true);

  acc.handleModelId('AC1715/11');
  assert.equal(acc.purifierService.testCharacteristic(lock), false);
  await staleControl.set(lock.CONTROL_LOCK_ENABLED);
  assert.deepEqual(acc.sent, []);
});

test('other models retain a working child-lock control and skip unchanged writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory({ ac1715: false });
  wireModelControls(acc);
  const lock = acc.Characteristic.LockPhysicalControls;
  assert.equal(acc.purifierService.testCharacteristic(lock), true);
  const control = acc.purifierService.getCharacteristic(lock);
  await control.set(lock.CONTROL_LOCK_DISABLED);
  await control.set(lock.CONTROL_LOCK_ENABLED);
  await control.set(lock.CONTROL_LOCK_ENABLED);
  Accessory.prototype.updatePurifierCharacteristics.call(acc);
  assert.deepEqual(acc.sent, [['childlock', 'on']]);
  assert.equal(control.value, lock.CONTROL_LOCK_ENABLED);
});

test('a queued child-lock write is dropped if the model becomes AC1715', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory({ ac1715: false });
  let finish;
  acc.daemon.execute = (cmd, args) => {
    acc.sent.push([cmd, ...args]);
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = acc.executeCommand('childlock', ['on'], { childLock: true });
  const second = acc.executeCommand('childlock', ['off'], { childLock: false });
  acc.isAC1715 = () => true;
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(acc.sent, [['childlock', 'on']]);
});

test('a power-on scene sends medium once for MANUAL and 47% and skips unchanged child lock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  const { target, speed } = wireModelControls(acc);
  await acc.executeCommand('power', ['on'], { power: true });
  await acc.executeCommand('childlock', ['off'], { childLock: false });
  const manual = target.set(acc.Characteristic.TargetAirPurifierState.MANUAL);
  await speed.set(47);
  t.mock.timers.tick(400);
  await tick();
  t.mock.timers.tick(1100);
  await manual;
  await tick();

  assert.deepEqual(acc.sent, [['power', 'on'], ['mode', 'medium']]);
  assert.equal(acc.state.mode, 'medium');
  t.mock.timers.tick(500);
  assert.equal(acc.commandLock, false);
  acc.handleObserveUpdate(status(true, 'medium'));
  assert.equal(acc.sent.length, 2);
});

test('different modes requested during power-on are not deduplicated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  await acc.executeCommand('power', ['on'], { power: true });
  const medium = acc.executeCommand('mode', ['medium'], { mode: 'medium' });
  const turbo = acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  t.mock.timers.tick(1500);
  await Promise.all([medium, turbo]);
  assert.deepEqual(acc.sent, [['power', 'on'], ['mode', 'medium'], ['mode', 'turbo']]);
  assert.equal(acc._modeAfterPowerOn, 'turbo');
});

test('identical in-flight mode requests share a failure and can be retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  let rejectSend;
  acc.daemon.execute = (cmd, args) => {
    acc.sent.push([cmd, ...args]);
    return new Promise((_, reject) => { rejectSend = reject; });
  };
  const first = acc.executeCommand('mode', ['medium'], { mode: 'medium' });
  const second = acc.executeCommand('mode', ['medium'], { mode: 'medium' });
  const outcomes = Promise.allSettled([first, second]);
  assert.deepEqual(acc.sent, [['mode', 'medium']]);
  rejectSend(new Error('offline'));
  assert.deepEqual((await outcomes).map((result) => result.status), ['rejected', 'rejected']);
  t.mock.timers.tick(500);
  assert.equal(acc.commandLock, false);
  acc.daemon.execute = async (cmd, args) => { acc.sent.push([cmd, ...args]); };
  await acc.executeCommand('mode', ['medium'], { mode: 'medium' });
  assert.equal(acc.sent.length, 2);
});

test('child lock skips matching state but sends actual toggles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory({ ac1715: false });
  await acc.executeCommand('childlock', ['off'], { childLock: false });
  await acc.executeCommand('childlock', ['on'], { childLock: true });
  await acc.executeCommand('childlock', ['on'], { childLock: true });
  await acc.executeCommand('childlock', ['off'], { childLock: false });
  assert.deepEqual(acc.sent, [['childlock', 'on'], ['childlock', 'off']]);
});

test('a failed child lock write is reported to duplicate callers and can be retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory({ ac1715: false });
  let rejectSend;
  acc.daemon.execute = (cmd, args) => {
    acc.sent.push([cmd, ...args]);
    return new Promise((_, reject) => { rejectSend = reject; });
  };
  const first = acc.executeCommand('childlock', ['on'], { childLock: true });
  const second = acc.executeCommand('childlock', ['on'], { childLock: true });
  const outcomes = Promise.allSettled([first, second]);
  assert.equal(acc.sent.length, 1);
  rejectSend(new Error('offline'));
  assert.deepEqual((await outcomes).map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(acc.state.childLock, false);
  acc.daemon.execute = async (cmd, args) => { acc.sent.push([cmd, ...args]); };
  await acc.executeCommand('childlock', ['on'], { childLock: true });
  assert.equal(acc.sent.length, 2);
  assert.equal(acc.state.childLock, true);
});

test('rapid child lock on/off/on requests preserve the final requested setting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory({ ac1715: false });
  let finish;
  acc.daemon.execute = (cmd, args) => {
    acc.sent.push([cmd, ...args]);
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = acc.executeCommand('childlock', ['on'], { childLock: true });
  const second = acc.executeCommand('childlock', ['off'], { childLock: false });
  const third = acc.executeCommand('childlock', ['on'], { childLock: true });
  assert.deepEqual(acc.sent, [['childlock', 'on']]);
  finish();
  await first;
  await tick();
  assert.deepEqual(acc.sent.at(-1), ['childlock', 'off']);
  finish();
  await second;
  await tick();
  assert.deepEqual(acc.sent.at(-1), ['childlock', 'on']);
  finish();
  await third;
  assert.equal(acc.sent.length, 3);
  assert.equal(acc.state.childLock, true);
});

test('a queued child lock request uses the restored state after a failed write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory({ ac1715: false });
  let rejectSend;
  acc.daemon.execute = (cmd, args) => {
    acc.sent.push([cmd, ...args]);
    return new Promise((_, reject) => { rejectSend = reject; });
  };
  const first = acc.executeCommand('childlock', ['on'], { childLock: true });
  const second = acc.executeCommand('childlock', ['off'], { childLock: false });
  const outcomes = Promise.allSettled([first, second]);
  rejectSend(new Error('offline'));
  assert.deepEqual((await outcomes).map((result) => result.status), ['rejected', 'fulfilled']);
  assert.deepEqual(acc.sent, [['childlock', 'on']]);
  assert.equal(acc.state.childLock, false);
});

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

test('a power ON status received before a mode request avoids the hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  await acc.executeCommand('power', ['on'], { power: true });
  acc._commandCount = 0;
  acc.handleObserveUpdate(status(true, 'auto'));
  await acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });
  assert.deepEqual(acc.sent, [['power', 'on'], ['mode', 'turbo']]);
});

test('an observe update during the settle delay cannot disarm the mode retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const acc = makeAccessory();
  await acc.executeCommand('power', ['on'], { power: true });
  const pending = acc.executeCommand('mode', ['turbo'], { mode: 'turbo' });

  // The power command's lock expires at 500 ms. The waiting mode must
  // keep the lock until its send and cooldown have completed.
  t.mock.timers.tick(750);
  acc.handleObserveUpdate(status(true, 'auto'));
  assert.equal(acc.commandLock, true);
  assert.equal(acc._powerOnSentAt, 1_000_000);
  assert.deepEqual(acc.sent, [['power', 'on']]);

  t.mock.timers.tick(750);
  await pending;
  assert.equal(acc._modeAfterPowerOn, 'turbo');
  t.mock.timers.tick(500);
  assert.equal(acc.commandLock, false);

  acc.handleObserveUpdate(status(true, 'auto'));
  await tick();
  assert.deepEqual(acc.sent, [['power', 'on'], ['mode', 'turbo'], ['mode', 'turbo']]);
  assert.equal(acc.state.mode, 'turbo');

  t.mock.timers.tick(500);
  acc.handleObserveUpdate(status(true, 'auto'));
  assert.equal(acc.sent.length, 3);
});

for (const ac1715 of [true, false]) {
  const model = ac1715 ? 'AC1715' : 'generic model';

  test(`${model}: AUTO suppresses a nonzero scene speed 100 ms later and refreshes HomeKit`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const acc = makeAccessory({ ac1715 });
    acc.state.power = true;
    const { target, speed } = wireModelControls(acc);
    await target.set(acc.Characteristic.TargetAirPurifierState.AUTO);
    const updates = acc.purifierUpdates;

    t.mock.timers.tick(100);
    await speed.set(100);
    assert.equal(acc.purifierUpdates, updates + 1);
    t.mock.timers.tick(400);
    await tick();
    assert.deepEqual(acc.sent, [['mode', 'auto']]);
    assert.equal(acc.state.mode, 'auto');
  });

  test(`${model}: a speed write 2 seconds after AUTO applies normally`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const acc = makeAccessory({ ac1715 });
    acc.state.power = true;
    const { target, speed } = wireModelControls(acc);
    await target.set(acc.Characteristic.TargetAirPurifierState.AUTO);

    t.mock.timers.tick(2000);
    await speed.set(100);
    t.mock.timers.tick(400);
    await tick();
    assert.deepEqual(acc.sent, [['mode', 'auto'], ['mode', 'turbo']]);
    assert.equal(acc.state.mode, 'turbo');
  });

  test(`${model}: a 0% speed write inside the AUTO window still powers off`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const acc = makeAccessory({ ac1715 });
    acc.state.power = true;
    const { target, speed } = wireModelControls(acc);
    await target.set(acc.Characteristic.TargetAirPurifierState.AUTO);

    t.mock.timers.tick(100);
    await speed.set(0);
    t.mock.timers.tick(400);
    await tick();
    assert.deepEqual(acc.sent, [['mode', 'auto'], ['power', 'off']]);
    assert.equal(acc.state.power, false);
  });
}

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
