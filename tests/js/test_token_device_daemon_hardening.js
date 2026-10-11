'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let server;
let daemon;
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@homebridge/plugin-ui-utils') {
    return { HomebridgePluginUiServer: class {
      constructor() { this.routes = {}; server = this; }
      onRequest(route, handler) { this.routes[route] = handler; }
      ready() {}
    } };
  }
  if (request === 'node:child_process') {
    return { ...realLoad.call(this, request, ...rest), spawn: () => daemon };
  }
  return realLoad.call(this, request, ...rest);
};
let DaemonHandler;
try {
  require('../../homebridge-ui/server.js');
  ({ _DaemonHandler: DaemonHandler } = require('../../index.js'));
} finally {
  Module._load = realLoad;
}

test('/auth/save rejects invalid device IDs before creating files or directories', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'philips-invalid-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const mkdir = t.mock.method(fs, 'mkdirSync', () => { throw new Error('unexpected mkdir'); });
  server._tokens = { access_token: 'access', refresh_token: 'refresh', id_token: 'identity' };
  for (const uuid of ['../x', 'a/b', '..', '', 'a'.repeat(129), 'a.b', 'a\\b', 'valid\n', null, 123]) {
    await assert.rejects(server.routes['/auth/save']({ uuid }), /Device UUID/);
    assert.deepEqual(fs.readdirSync(home), []);
  }
  assert.equal(mkdir.mock.callCount(), 0);
});

test('/auth/save preserves valid device IDs and owner-only token files', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'philips-valid-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  server._tokens = { access_token: 'access', refresh_token: 'refresh', id_token: 'identity' };
  for (const uuid of ['device-uuid-1', '00000000-0000-4000-8000-000000000000', 'AIRPLUS_DEVICE_UUID', 'a'.repeat(128)]) {
    const result = await server.routes['/auth/save']({ uuid, name: 'Living Room' });
    assert.equal(result.uuid, uuid);
    assert.equal(result.tokenFile, path.join(home, '.homebridge', `philips-airplus-${uuid}.json`));
    assert.equal(fs.statSync(result.tokenFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(result.tokenFile, 'utf8')).id_token, 'identity');
  }
});

test('daemon stdin errors are handled and logged after spawn', async (t) => {
  daemon = new EventEmitter();
  daemon.stdin = new PassThrough();
  daemon.stdout = new PassThrough();
  daemon.stderr = new PassThrough();
  const messages = [];
  const handler = new DaemonHandler({ debug: (message) => messages.push(message), info() {}, warn() {}, error() {} });
  t.after(() => {
    handler.rl.close();
    daemon.stdin.destroy();
    daemon.stdout.destroy();
    daemon.stderr.destroy();
  });
  const started = handler.start('python3', '/test/daemon.py', '127.0.0.1');
  daemon.stdout.write('{"type":"ready","connected":true}\n');
  assert.equal(await started, true);
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.equal(daemon.stdin.listenerCount('error'), 1);
  assert.doesNotThrow(() => daemon.stdin.emit('error', error));
  assert.deepEqual(messages, ['Daemon stdin error: write EPIPE']);
});

test('execute rejects a non-writable stdin without writing or queuing a request', async () => {
  const handler = new DaemonHandler({ debug() {} });
  let writes = 0;
  handler.daemon = { stdin: { writable: false, write() { writes++; } } };
  await assert.rejects(handler.execute('status'), /^Error: Daemon not running$/);
  assert.equal(writes, 0);
  assert.equal(handler.pendingRequests.size, 0);
  assert.equal(handler.requestId, 0);
  handler.daemon = null;
  await assert.rejects(handler.execute('status'), /^Error: Daemon not running$/);
});

test('execute still sends commands and resolves daemon responses on writable stdin', async (t) => {
  const handler = new DaemonHandler({ debug() {} });
  const requests = [];
  handler.daemon = { stdin: { writable: true, write: (data) => requests.push(data) } };
  t.after(() => {
    for (const { timeout } of handler.pendingRequests.values()) clearTimeout(timeout);
  });
  const command = handler.execute('status');
  assert.deepEqual(requests, ['{"id":1,"cmd":"status","args":[]}\n']);
  handler.handleMessage('{"type":"response","id":1,"success":true,"data":{"pm25":7}}');
  assert.deepEqual(await command, { pm25: 7 });
  assert.equal(handler.pendingRequests.size, 0);
});
