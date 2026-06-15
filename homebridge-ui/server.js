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
const API_BASE = 'https://prod.eu-da.iot.versuni.com/api';
const USER_AGENT = 'okhttp/4.12.0 (Android 14; Pixel 7)';
const SCOPE =
  'openid email profile DI.Account.read DI.Account.write DI.AccountProfile.read DI.AccountProfile.write DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write DI.GeneralConsent.read subscriptions profile_extended consents DI.AccountSubscription.read DI.AccountSubscription.write';

class AirPlusSetupServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this._pkce = null;
    this._tokens = null;
    this.onRequest('/auth/init', this.handleInit.bind(this));
    this.onRequest('/auth/exchange', this.handleExchange.bind(this));
    this.onRequest('/auth/save', this.handleSave.bind(this));
    this.ready();
  }

  async handleInit() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    this._pkce = { verifier, state };

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: SCOPE,
    });

    const authUrl = AUTHORIZE_ENDPOINT + '?' + params.toString();
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

    // Replace custom scheme with https:// so URL can parse it
    const parseable = redirectUrl.replace('com.philips.air://', 'https://x/');
    const parsed = new URL(parseable);
    const code = parsed.searchParams.get('code');
    if (!code) {
      throw new Error('No authorisation code found in redirect URL');
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: this._pkce.verifier,
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

    const { access_token, refresh_token, expires_in } = tokenResponse;
    this._tokens = { access_token, refresh_token, expires_in };
    console.log('tokens received');

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

  async handleSave(payload = {}) {
    const { uuid, name } = payload;
    if (!uuid) {
      throw new Error('Device UUID is required');
    }
    if (!this._tokens) {
      throw new Error('No Air+ token is available. Complete the login flow first.');
    }

    const tokenPath = path.join(os.homedir(), '.homebridge', 'philips-airplus-' + uuid + '.json');
    const { access_token, refresh_token, expires_in } = this._tokens;
    const tokenData = {
      access_token,
      refresh_token,
      client_id: CLIENT_ID,
      expires_at: Date.now() / 1000 + expires_in,
    };

    const tmp = tokenPath + '.tmp';
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(tokenData, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, tokenPath);
    fs.chmodSync(tokenPath, 0o600);

    return { success: true, uuid, name: name || 'Philips Air Purifier', tokenFile: tokenPath };
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
}

new AirPlusSetupServer();
