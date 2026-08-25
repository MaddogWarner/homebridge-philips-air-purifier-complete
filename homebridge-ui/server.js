'use strict';
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URLSearchParams, URL } = require('node:url');

const TENANT = '4_JGZWlP8eQHpEqkvQElolbA';
const CLIENT_ID = '-XsK7O6iEkLml77yDGDUi0ku';
const REDIRECT_URI = 'com.philips.air://loginredirect';
const OIDC_BASE = 'https://cdc.accounts.home.id/oidc/op/v1.0/' + TENANT;
const TOKEN_ENDPOINT = OIDC_BASE + '/token';
const AUTHORIZE_ENDPOINT = OIDC_BASE + '/authorize';
const GIGYA_BASE = 'https://cdc.accounts.home.id';
const OTP_SEND_ENDPOINT = '/accounts.auth.otp.email.sendCode';
const OTP_LOGIN_ENDPOINT = '/accounts.auth.otp.email.login';
const GET_IDS_ENDPOINT = '/socialize.getIDs';
const API_BASE = 'https://prod.eu-da.iot.versuni.com/api';
const USER_AGENT = 'okhttp/4.12.0 (Android 14; Pixel 7)';
const SCOPE =
  'openid email profile DI.Account.read DI.Account.write DI.AccountProfile.read DI.AccountProfile.write DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write DI.GeneralConsent.read subscriptions profile_extended consents DI.AccountSubscription.read DI.AccountSubscription.write';
const DEBUG_AUTH = process.env.PHILIPS_AIRPLUS_DEBUG === '1';

/**
 * Minimal cookie store for the CDC handshake.
 *
 * The OIDC authorise → getIDs → continue sequence only works if the session
 * cookies CDC sets along the way are replayed on the following requests, which
 * is what `http.cookiejar` does for scripts/airplus_setup.py. Cookies are keyed
 * by the exact host that set them and never sent anywhere else, so nothing can
 * leak to the Versuni device API.
 */
class HostCookieJar {
  constructor() {
    this._byHost = new Map();
  }

  store(hostname, setCookieHeader) {
    if (!hostname || !setCookieHeader) return;
    const jar = this._byHost.get(hostname) || new Map();
    for (const raw of [].concat(setCookieHeader)) {
      const pair = String(raw).split(';')[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;
      if (!value) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }
    this._byHost.set(hostname, jar);
  }

  header(hostname) {
    const jar = this._byHost.get(hostname);
    if (!jar || jar.size === 0) return null;
    return Array.from(jar, ([name, value]) => name + '=' + value).join('; ');
  }
}

class AirPlusSetupServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this._pkce = null;
    this._otp = null;
    this._tokens = null;
    this._cookies = new HostCookieJar();
    this.onRequest('/auth/init', this.handleInit.bind(this));
    this.onRequest('/auth/exchange', this.handleExchange.bind(this));
    this.onRequest('/auth/otp/send', this.handleOtpSend.bind(this));
    this.onRequest('/auth/otp/verify', this.handleOtpVerify.bind(this));
    this.onRequest('/auth/save', this.handleSave.bind(this));
    this.ready();
  }

  async handleInit() {
    const { verifier, challenge, state } = this._createPkce();

    this._pkce = { verifier, state };

    const authUrl = AUTHORIZE_ENDPOINT + '?' + this._buildAuthorizeParams(challenge, state).toString();
    return { url: authUrl };
  }

  async handleExchange(payload = {}) {
    const { redirectUrl } = payload;
    if (!this._pkce) {
      throw new Error('Authorisation flow has not been initialised');
    }
    if (!redirectUrl) {
      throw new Error('Redirect URL is required');
    }

    // The authorisation code lives in the URL the user copied — whether that is the
    // com.philips.air:// deep link or the accounts.home.id consent/proxy page that
    // many desktop browsers land on instead. Parse it directly (query → fragment →
    // regex), mirroring scripts/airplus_setup.py.
    let code = this._extractCode(redirectUrl);

    // Last resort: the user pasted a Philips consent page that did not carry the
    // code in its own URL. Fetch it and scan for an embedded deep link. This only
    // works if the page is reachable unauthenticated, so treat failure as benign.
    if (!code && redirectUrl.includes('accounts.home.id')) {
      try {
        const proxyUrl = new URL(redirectUrl);
        const html = await this._httpsGetRaw({
          hostname: proxyUrl.hostname,
          path: proxyUrl.pathname + proxyUrl.search,
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        });
        const m = html.match(/com\.philips\.air:\/\/loginredirect[^\s"'\\]*code=([^&\s"'\\]+)/);
        if (m) code = decodeURIComponent(m[1]);
      } catch (_) { /* fall through to descriptive error */ }
    }

    if (!code) {
      throw new Error(
        'No authorisation code found in that URL. After approving access, copy the ' +
        'full URL from your browser’s address bar and paste it here — it will start ' +
        'with either "com.philips.air://loginredirect?code=…" or an "accounts.home.id" ' +
        'address containing "code=…". If you only see a Philips confirmation page with ' +
        'no "code=" in its address, log in again and copy the URL the moment the page ' +
        'finishes loading.'
      );
    }

    return this._exchangeCodeAndListDevices(code, this._pkce.verifier);
  }

  async handleOtpSend(payload = {}) {
    const email = String(payload.email || '').trim();
    if (!email) {
      throw new Error('Email address is required');
    }

    const response = await this._gigyaPostJson(OTP_SEND_ENDPOINT, new URLSearchParams({
      apiKey: TENANT,
      email,
      format: 'json',
    }), 'OTP send');

    const vToken = response.vToken;
    if (!vToken) {
      throw new Error('OTP send did not return a verification token');
    }

    this._otp = { email, vToken, createdAt: Date.now() };
    return { sent: true };
  }

  async handleOtpVerify(payload = {}) {
    const code = String(payload.code || '').trim();
    if (!this._otp || !this._otp.email || !this._otp.vToken) {
      throw new Error('Verification flow has not been initialised. Send a code first.');
    }
    if (!code) {
      throw new Error('Verification code is required');
    }

    const loginResponse = await this._gigyaPostJson(OTP_LOGIN_ENDPOINT, new URLSearchParams({
      apiKey: TENANT,
      email: this._otp.email,
      code,
      vToken: this._otp.vToken,
      format: 'json',
    }), 'OTP verify');

    const loginToken = loginResponse.sessionInfo && loginResponse.sessionInfo.cookieValue;
    if (!loginToken) {
      throw new Error('OTP verification succeeded but no login token was returned');
    }

    const { verifier, challenge, state } = this._createPkce();
    const authUrl = new URL(AUTHORIZE_ENDPOINT);
    authUrl.search = this._buildAuthorizeParams(challenge, state, { prompt: 'none' }).toString();
    const authLocation = await this._getRedirectLocation(authUrl, 'OIDC authorise');
    const context = this._readUrlParam(authLocation, 'context', AUTHORIZE_ENDPOINT);
    if (!context) {
      throw new Error('OIDC authorise did not return a continuation context');
    }

    const idsResponse = await this._gigyaPostJson(GET_IDS_ENDPOINT, new URLSearchParams({
      APIKey: TENANT,
      includeTicket: 'true',
      format: 'json',
    }), 'Gigya getIDs');
    const gmidTicket = idsResponse.gmidTicket;
    if (!gmidTicket) {
      throw new Error('Gigya getIDs did not return gmidTicket');
    }

    // Resume the flow at the OIDC continue endpoint with exactly the parameters
    // scripts/airplus_setup.py sends. The authorise redirect can point at the hosted
    // login page rather than /continue, and that page does not accept the login_token
    // handshake, so the location is only read for its context parameter.
    const continueUrl = new URL(AUTHORIZE_ENDPOINT + '/continue');
    continueUrl.search = new URLSearchParams({
      context,
      login_token: loginToken,
      gmidTicket,
      client_id: CLIENT_ID,
    }).toString();
    const appRedirect = await this._getRedirectLocation(continueUrl, 'OIDC continue');
    const authCode = this._extractCode(appRedirect);
    if (!authCode) {
      throw new Error('OIDC continue did not return an Air+ authorisation code');
    }

    this._pkce = { verifier, state };
    const result = await this._exchangeCodeAndListDevices(authCode, verifier);
    this._otp = null;
    return result;
  }

  async handleSave(payload = {}) {
    const { uuid, name } = payload;
    if (!uuid) {
      throw new Error('Device UUID is required');
    }
    if (!this._tokens) {
      throw new Error('No Air+ token is available. Complete the login flow first.');
    }

    const tokenPath = path.join(os.homedir(), '.homebridge', 'philips-airplus-' + uuid + '.json');
    const { access_token, refresh_token, id_token, expires_in } = this._tokens;
    if (typeof id_token !== 'string' || !id_token.trim()) {
      throw new Error(
        'The stored Air+ token has no id_token; Air+ MQTT setup cannot continue. ' +
        'Log in again to obtain a complete token.'
      );
    }
    const tokenData = {
      access_token,
      refresh_token: refresh_token || '',
      id_token,
      client_id: CLIENT_ID,
      expires_at: Date.now() / 1000 + (expires_in || 3600),
    };

    const tmp = tokenPath + '.tmp';
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(tokenData, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, tokenPath);
    fs.chmodSync(tokenPath, 0o600);

    return { success: true, uuid, name: name || 'Philips Air Purifier', tokenFile: tokenPath };
  }

  _extractCode(redirectUrl) {
    const trimmed = String(redirectUrl || '').trim();
    if (!trimmed) return null;

    // Normalise the custom scheme so the URL parser accepts it.
    const normalised = trimmed.replace(/^com\.philips\.air:\/\//i, 'https://airplus.local/');
    let parsed = null;
    try { parsed = new URL(normalised); } catch (_) { parsed = null; }

    if (parsed) {
      const fromQuery = parsed.searchParams.get('code');
      if (fromQuery) return fromQuery;
      // OIDC may return the response in the URL fragment (#code=…&state=…).
      if (parsed.hash && parsed.hash.length > 1) {
        const fromFragment = new URLSearchParams(parsed.hash.slice(1)).get('code');
        if (fromFragment) return fromFragment;
      }
    }

    // Fallback for unusual encodings the URL parser may not split cleanly.
    const m = trimmed.match(/[?&#]code=([^&\s"'\\]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  _createPkce() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return { verifier, challenge, state };
  }

  _buildAuthorizeParams(challenge, state, extra = {}) {
    return new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: SCOPE,
      ...extra,
    });
  }

  async _exchangeCodeAndListDevices(code, verifier) {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });

    const tokenUrl = new URL(TOKEN_ENDPOINT);
    const tokenResponse = await this._httpsRequest(
      {
        hostname: tokenUrl.hostname,
        path: tokenUrl.pathname + tokenUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
      },
      tokenBody.toString()
    );

    const { access_token, refresh_token, expires_in, id_token } = tokenResponse;
    if (!access_token) {
      throw new Error('Philips did not return an access token.');
    }
    // philips_air_api.py derives the MQTT user ID from the identity token, so a token
    // file without one is unusable. Fail here rather than writing a dead token file.
    if (typeof id_token !== 'string' || !id_token.trim()) {
      throw new Error(
        'No id_token in token response; Air+ MQTT setup cannot continue. ' +
        'Log in again, and if it keeps happening use scripts/airplus_setup.py.'
      );
    }
    this._tokens = { access_token, refresh_token, id_token, expires_in };
    console.log('Air+ tokens received');

    const deviceUrl = new URL(API_BASE + '/da/user/self/device');
    const deviceResponse = await this._httpsRequest({
      hostname: deviceUrl.hostname,
      path: deviceUrl.pathname + deviceUrl.search,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + access_token,
        'User-Agent': USER_AGENT,
      },
    });

    let rawDevices;
    if (Array.isArray(deviceResponse)) {
      rawDevices = deviceResponse;
    } else if (deviceResponse.devices) {
      rawDevices = deviceResponse.devices;
    } else if (deviceResponse.data && deviceResponse.data.items) {
      rawDevices = deviceResponse.data.items;
    } else {
      rawDevices = [];
    }

    const devices = rawDevices.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      modelName: d.modelName,
    }));

    return { devices };
  }

  async _gigyaPostJson(pathname, formBody, label) {
    const raw = await this._httpsRaw({
      hostname: new URL(GIGYA_BASE).hostname,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    }, formBody.toString());

    let parsed;
    try {
      parsed = raw.body ? JSON.parse(raw.body) : {};
    } catch (_e) {
      throw new Error(label + ' returned invalid JSON: ' + raw.body.slice(0, 200));
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw new Error(label + ' failed (HTTP ' + raw.status + '): ' + raw.body);
    }
    if (parsed.errorCode != null && Number(parsed.errorCode) !== 0) {
      throw new Error(label + ' failed: ' + (parsed.errorMessage || parsed.errorDetails || parsed.errorCode));
    }
    return parsed;
  }

  async _getRedirectLocation(url, label) {
    const target = new URL(url);
    const raw = await this._httpsRaw({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
      },
    });
    const location = raw.headers.location;
    this._debugLocation(label, raw.status, location);
    if (!location || raw.status < 300 || raw.status >= 400) {
      throw new Error(label + ' did not return an HTTP redirect');
    }
    return location;
  }

  _readUrlParam(value, param, baseUrl) {
    try {
      const parsed = new URL(value, baseUrl);
      const fromQuery = parsed.searchParams.get(param);
      if (fromQuery) return fromQuery;
      if (parsed.hash && parsed.hash.length > 1) {
        return new URLSearchParams(parsed.hash.slice(1)).get(param);
      }
    } catch (_e) {
      // Fall through to regex for custom schemes and malformed relative URLs.
    }
    const match = String(value || '').match(new RegExp('[?&#]' + param + '=([^&\\s"\'\\\\]+)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  _debugLocation(label, status, location) {
    if (!DEBUG_AUTH) return;
    let safeLocation = location || '';
    try {
      const parsed = new URL(location, AUTHORIZE_ENDPOINT);
      for (const key of ['code', 'context', 'login_token', 'gmidTicket']) {
        if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[redacted]');
      }
      if (parsed.hash && parsed.hash.length > 1) {
        const hash = new URLSearchParams(parsed.hash.slice(1));
        for (const key of ['code', 'context', 'login_token', 'gmidTicket']) {
          if (hash.has(key)) hash.set(key, '[redacted]');
        }
        parsed.hash = hash.toString();
      }
      safeLocation = parsed.toString();
    } catch (_e) {
      safeLocation = String(location || '').replace(/(code|context|login_token|gmidTicket)=([^&\s]+)/g, '$1=[redacted]');
    }
    console.log('[Air+ auth debug] ' + label + ' HTTP ' + status + ' Location: ' + safeLocation);
  }

  _withCookies(options) {
    const cookie = this._cookies.header(options.hostname);
    if (!cookie) return options;
    return { ...options, headers: { ...(options.headers || {}), Cookie: cookie } };
  }

  _httpsRaw(options, postBody) {
    return new Promise((resolve, reject) => {
      const req = https.request(this._withCookies(options), (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          this._cookies.store(options.hostname, res.headers['set-cookie']);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.on('error', reject);

      if (postBody) {
        req.write(postBody);
      }
      req.end();
    });
  }

  _httpsRequest(options, postBody) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('HTTP ' + res.statusCode + ': ' + body));
          }
          try {
            resolve(JSON.parse(body));
          } catch (_e) {
            reject(new Error('Invalid JSON response: ' + body.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);

      if (postBody) {
        req.write(postBody);
      }
      req.end();
    });
  }

  _httpsGetRaw(options) {
    return new Promise((resolve, reject) => {
      const req = https.request(this._withCookies(options), (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          this._cookies.store(options.hostname, res.headers['set-cookie']);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
}

new AirPlusSetupServer();
