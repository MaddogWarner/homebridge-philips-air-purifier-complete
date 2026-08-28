'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const plugin = require(path.join(__dirname, '..', '..', 'index.js'));
const { _DaemonHandler: DaemonHandler } = plugin;

test('model reconfiguration errors are logged without suppressing state updates', () => {
  const updates = [];
  const errors = [];
  const debug = [];
  const log = {
    debug: (message) => debug.push(message),
    error: (message) => errors.push(message),
    info() {},
    warn() {},
  };
  const handler = new DaemonHandler(
    log,
    (data) => updates.push(data),
    null,
    () => {
      throw new Error('reconfigure boom');
    },
  );

  handler.handleMessage(JSON.stringify({
    type: 'update',
    data: { pm25: 7 },
    model_id: 'AC1715/11',
  }));

  assert.deepEqual(updates, [{ pm25: 7 }]);
  assert.deepEqual(errors, [
    'Model reconfiguration failed for AC1715/11: reconfigure boom',
  ]);
  assert.equal(
    debug.some((message) => message.startsWith('Failed to parse daemon message:')),
    false,
  );
});
