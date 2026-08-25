'use strict';

/**
 * Regression tests for the Air+ setup wizard backend (homebridge-ui/server.js).
 *
 * The wizard drives the same CDC/OIDC handshake as scripts/airplus_setup.py, so
 * these tests pin the parts that silently diverged from it: the Gigya endpoint,
 * the session cookies, the continue endpoint, and the identity token that ends up
 * in the token file.
 *
 * The HTTPS layer is replaced with a scripted fake, so nothing here touches the
 * network or a Philips account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const TENANT = '4_JGZWlP8eQHpEqkvQElolbA';
const CDC_HOST = 'cdc.accounts.home.id';
const API_HOST = 'prod.eu-da.iot.versuni.com';
const AUTHORIZE_PATH = '/oidc/op/v1.0/' + TENANT + '/authorize';

// --- Load server.js with a stand-in for the Homebridge UI base class ----------

const instances = [];

class FakeUiServer {
  constructor() {
    this.routes = {};
  }
  onRequest(route, handler) {
    this.routes[route] = handler;
  }
  ready() {
    this.isReady = true;
  }
}

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@homebridge/plugin-ui-utils') {
    return {
      HomebridgePluginUiServer: class extends FakeUiServer {
        constructor() {
          super();
          instances.push(this);
        }
      },
    };
  }
  return realLoad.call(this, request, ...rest);
};

require(path.join(__dirname, '..', '..', 'homebridge-ui', 'server.js'));
Module._load = realLoad;

assert.equal(instances.length, 1, 'server.js should construct the setup server on load');
const AirPlusSetupServer = Object.getPrototypeOf(instances[0]).constructor;

// --- Scripted HTTPS fake -----------------------------------------------------

/**
 * Replace https.request with a fake that answers from `respond(call)` and records
 * every request. Returns the recorded calls; `restore()` puts the real one back.
 */
function fakeHttps(respond) {
  const calls = [];
  const realRequest = https.request;

  https.request = (options, callback) => {
    const written = [];
    return {
      on() {},
      write(chunk) {
        written.push(String(chunk));
      },
      end() {
        const call = {
          hostname: options.hostname,
          path: options.path,
          method: options.method || 'GET',
          headers: options.headers || {},
          body: written.join(''),
        };
        calls.push(call);
        const reply = respond(call);
        assert.ok(reply, 'unexpected request: ' + call.method + ' ' + call.hostname + call.path);
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = reply.status;
          res.headers = reply.headers || {};
          callback(res);
          setImmediate(() => {
            if (reply.body) res.emit('data', Buffer.from(reply.body));
            res.emit('end');
          });
        });
      },
    };
  };

  calls.restore = () => {
    https.request = realRequest;
  };
  return calls;
}

const TOKEN_RESPONSE = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  id_token: 'identity-1',
  expires_in: 3600,
};

/** Happy-path answers for the whole email + verification code flow. */
function otpFlowResponder(overrides = {}) {
  const tokenResponse = { ...TOKEN_RESPONSE, ...overrides };
  if (overrides.id_token === undefined && 'id_token' in overrides) delete tokenResponse.id_token;

  return (call) => {
    if (call.hostname === CDC_HOST && call.path === '/accounts.auth.otp.email.sendCode') {
      return {
        status: 200,
        headers: { 'set-cookie': ['gmid=gmid-1; Path=/; HttpOnly'] },
        body: JSON.stringify({ vToken: 'vtoken-1', errorCode: 0 }),
      };
    }
    if (call.hostname === CDC_HOST && call.path === '/accounts.auth.otp.email.login') {
      return {
        status: 200,
        headers: { 'set-cookie': ['glt=login-cookie-1; Path=/'] },
        body: JSON.stringify({ errorCode: 0, sessionInfo: { cookieValue: 'login-token-1' } }),
      };
    }
    if (call.hostname === CDC_HOST && call.path.startsWith(AUTHORIZE_PATH + '/continue')) {
      return {
        status: 302,
        headers: { location: 'com.philips.air://loginredirect?code=auth-code-1&state=state-1' },
      };
    }
    if (call.hostname === CDC_HOST && call.path.startsWith(AUTHORIZE_PATH + '?')) {
      return {
        status: 302,
        headers: {
          location: 'https://' + CDC_HOST + '/login?context=context-1',
          'set-cookie': ['ctx=context-cookie-1; Path=/'],
        },
      };
    }
    if (call.hostname === CDC_HOST && call.path === '/socialize.getIDs') {
      return {
        status: 200,
        body: JSON.stringify({ errorCode: 0, gmidTicket: 'gmid-ticket-1' }),
      };
    }
    if (call.hostname === CDC_HOST && call.path.endsWith('/token')) {
      return { status: 200, body: JSON.stringify(tokenResponse) };
    }
    if (call.hostname === API_HOST && call.path === '/api/da/user/self/device') {
      return {
        status: 200,
        body: JSON.stringify({
          devices: [{ uuid: 'device-uuid-1', name: 'Living Room', modelName: 'AC1715' }],
        }),
      };
    }
    return null;
  };
}

/** Run the wizard's OTP flow against the fake and return the server plus recorded calls. */
async function runOtpFlow(t, overrides) {
  const server = new AirPlusSetupServer();
  const calls = fakeHttps(otpFlowResponder(overrides));
  t.after(() => calls.restore());

  await server.handleOtpSend({ email: 'user@example.com' });
  const result = await server.handleOtpVerify({ code: '123456' });
  return { server, calls, result };
}

/** Point os.homedir() at a scratch directory for the duration of the test. */
function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airplus-ui-test-'));
  const realHomedir = os.homedir;
  os.homedir = () => home;
  t.after(() => {
    os.homedir = realHomedir;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

const findCall = (calls, predicate) => calls.find(predicate);

// --- Tests -------------------------------------------------------------------

test('registers the routes the wizard calls', () => {
  const server = new AirPlusSetupServer();
  assert.deepEqual(Object.keys(server.routes).sort(), [
    '/auth/exchange',
    '/auth/init',
    '/auth/otp/send',
    '/auth/otp/verify',
    '/auth/save',
  ]);
});

test('getIDs is requested from the socialize namespace', async (t) => {
  const { calls } = await runOtpFlow(t);
  const getIds = findCall(calls, (c) => c.path.includes('getIDs'));

  assert.ok(getIds, 'the flow must call getIDs');
  // /accounts.socialize.getIDs is not a valid Gigya method and CDC answers it with
  // "Permission denied", which stops setup dead at the verification code step.
  assert.equal(getIds.path, '/socialize.getIDs');
});

test('the login handshake resumes at the OIDC continue endpoint', async (t) => {
  const { calls } = await runOtpFlow(t);
  const resume = findCall(calls, (c) => c.path.startsWith(AUTHORIZE_PATH + '/continue'));

  assert.ok(resume, 'the flow must call the continue endpoint, not the hosted login page');
  const params = new URLSearchParams(resume.path.split('?')[1]);
  assert.equal(params.get('context'), 'context-1');
  assert.equal(params.get('login_token'), 'login-token-1');
  assert.equal(params.get('gmidTicket'), 'gmid-ticket-1');
  assert.ok(params.get('client_id'));
});

test('CDC session cookies are replayed and never leak to the device API', async (t) => {
  const { calls } = await runOtpFlow(t);

  const resume = findCall(calls, (c) => c.path.startsWith(AUTHORIZE_PATH + '/continue'));
  const cookie = resume.headers.Cookie || '';
  assert.match(cookie, /gmid=gmid-1/);
  assert.match(cookie, /glt=login-cookie-1/);
  assert.match(cookie, /ctx=context-cookie-1/);

  const deviceCall = findCall(calls, (c) => c.hostname === API_HOST);
  assert.ok(deviceCall);
  assert.equal(deviceCall.headers.Cookie, undefined);
});

test('the device list is returned to the wizard', async (t) => {
  const { result } = await runOtpFlow(t);
  assert.deepEqual(result.devices, [
    { uuid: 'device-uuid-1', name: 'Living Room', modelName: 'AC1715' },
  ]);
});

test('the saved token file carries the id_token the daemon needs', async (t) => {
  const home = fakeHome(t);
  const { server } = await runOtpFlow(t);

  const saved = await server.handleSave({ uuid: 'device-uuid-1', name: 'Living Room' });
  const tokenPath = path.join(home, '.homebridge', 'philips-airplus-device-uuid-1.json');

  assert.equal(saved.tokenFile, tokenPath);
  const written = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  assert.equal(written.id_token, 'identity-1');
  assert.equal(written.access_token, 'access-1');
  assert.equal(written.refresh_token, 'refresh-1');
  assert.ok(written.client_id);
  assert.ok(written.expires_at > Date.now() / 1000);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
});

test('a token response without an id_token fails before anything is saved', async (t) => {
  const home = fakeHome(t);

  for (const badToken of [undefined, '', '   ']) {
    const server = new AirPlusSetupServer();
    const calls = fakeHttps(otpFlowResponder({ id_token: badToken }));

    await server.handleOtpSend({ email: 'user@example.com' });
    await assert.rejects(server.handleOtpVerify({ code: '123456' }), /id_token/);
    await assert.rejects(server.handleSave({ uuid: 'device-uuid-1' }), /token/);

    calls.restore();
    assert.equal(fs.existsSync(path.join(home, '.homebridge')), false);
  }
});
