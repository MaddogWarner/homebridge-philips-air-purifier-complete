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
const PLATFORM_ALIAS = 'PhilipsAirPurifier';
const DEFAULT_PLATFORM_NAME = 'Philips Air Purifiers';
const SUPPORTED_PROTOCOLS = new Set(['coap', 'http', 'homeid-http', 'airplus-cloud']);

class AirPlusSetupServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this._pkce = null;
    this._tokens = null;
    this.onRequest('/config/get', this.handleConfigGet.bind(this));
    this.onRequest('/config/save', this.handleConfigSave.bind(this));
    this.onRequest('/auth/init', this.handleInit.bind(this));
    this.onRequest('/auth/exchange', this.handleExchange.bind(this));
    this.onRequest('/auth/save', this.handleSave.bind(this));
    this.ready();
  }

  async handleConfigGet() {
    const platformConfig = await this._loadPlatformConfig();
    return { config: this._publicConfig(platformConfig) };
  }

  async handleConfigSave(payload = {}) {
    const platformConfig = await this._loadPlatformConfig();
    const existingDevices = this._resolveDevices(platformConfig);
    const devices = this._normaliseDevices(payload.devices || [], existingDevices);

    platformConfig.platform = PLATFORM_ALIAS;
    platformConfig.name = this._cleanString(payload.name || payload.platformName) || DEFAULT_PLATFORM_NAME;
    platformConfig.devices = devices;
    delete platformConfig.additionalDevicesJson;

    await this._writePlatformConfig(platformConfig);
    return { success: true, config: this._publicConfig(platformConfig) };
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
    fs.writeFileSync(tmp, JSON.stringify(tokenData, null, 2), { encoding: 'utf8' });
    fs.renameSync(tmp, tokenPath);
    fs.chmodSync(tokenPath, 0o600);

    const platformConfig = await this._loadPlatformConfig();
    platformConfig.devices = this._resolveDevices(platformConfig);
    delete platformConfig.additionalDevicesJson;
    const existing = platformConfig.devices.find((d) => d.airplusDeviceUuid === uuid);
    if (existing) {
      existing.name = name || existing.name || 'Philips Air Purifier';
      existing.host = 'cloud';
      existing.protocol = 'airplus-cloud';
      existing.airplusDeviceUuid = uuid;
      existing.airplusTokenFile = tokenPath;
    } else {
      platformConfig.devices.push({
        name: name || 'Philips Air Purifier',
        host: 'cloud',
        protocol: 'airplus-cloud',
        airplusDeviceUuid: uuid,
        airplusTokenFile: tokenPath,
      });
    }

    await this._writePlatformConfig(platformConfig);

    return { success: true, tokenPath, uuid };
  }

  async _loadPlatformConfig() {
    const configs = await this.getPluginConfig();
    const platformConfig = configs[0] || {};
    return {
      ...platformConfig,
      platform: PLATFORM_ALIAS,
      name: platformConfig.name || DEFAULT_PLATFORM_NAME,
      devices: this._resolveDevices(platformConfig),
    };
  }

  async _writePlatformConfig(platformConfig) {
    const configToWrite = {
      ...platformConfig,
      platform: PLATFORM_ALIAS,
      name: platformConfig.name || DEFAULT_PLATFORM_NAME,
      devices: Array.isArray(platformConfig.devices) ? platformConfig.devices : [],
    };
    delete configToWrite.additionalDevicesJson;

    await this.updatePluginConfig([
      configToWrite,
    ]);
    await this.savePluginConfig();
  }

  _publicConfig(platformConfig) {
    return {
      name: platformConfig.name || DEFAULT_PLATFORM_NAME,
      devices: (platformConfig.devices || []).map((device, index) => this._publicDevice(device, index)),
    };
  }

  _publicDevice(device, index) {
    return {
      _uiKey: this._deviceUiKey(device, index),
      name: device.name || 'Air Purifier',
      host: device.host || '',
      protocol: device.protocol || 'coap',
      useHttps: Boolean(device.useHttps),
      clientId: device.clientId || '',
      hasClientSecret: Boolean(device.clientSecret),
      hasEncryptionKey: Boolean(device.encryptionKey),
      airplusDeviceUuid: device.airplusDeviceUuid || '',
      airplusTokenFile: device.airplusTokenFile || '',
      pythonPath: device.pythonPath || '',
      apiScriptPath: device.apiScriptPath || '',
    };
  }

  _normaliseDevices(submittedDevices, existingDevices) {
    if (!Array.isArray(submittedDevices)) {
      throw new Error('devices must be an array');
    }
    const existingByKey = new Map(
      existingDevices.map((device, index) => [this._deviceUiKey(device, index), device])
    );

    return submittedDevices.map((device, index) => {
      const existing = existingByKey.get(device._uiKey) || {};
      return this._normaliseDevice(device, existing, index);
    });
  }

  _resolveDevices(platformConfig) {
    const devices = this._parseDeviceArray(platformConfig.devices, 'devices');
    const additionalDevices = this._parseDeviceArray(platformConfig.additionalDevicesJson, 'additionalDevicesJson');
    return this._mergeDeviceLists(devices, additionalDevices);
  }

  _parseDeviceArray(value, fieldName) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];

    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      throw new Error('expected a JSON array');
    } catch (error) {
      throw new Error(`${fieldName} must be a valid JSON array (${error.message})`);
    }
  }

  _mergeDeviceLists(baseDevices, additionalDevices) {
    const merged = [];
    const byKey = new Map();

    for (const device of [...baseDevices, ...additionalDevices]) {
      if (!device || typeof device !== 'object' || Array.isArray(device)) continue;
      const key = device.airplusDeviceUuid ? `airplus:${device.airplusDeviceUuid}` : device.host ? `host:${device.host}` : '';
      if (key && byKey.has(key)) {
        merged[byKey.get(key)] = device;
      } else {
        if (key) byKey.set(key, merged.length);
        merged.push(device);
      }
    }

    return merged;
  }

  _normaliseDevice(device, existing, index) {
    const protocol = this._cleanString(device.protocol || existing.protocol || 'coap');
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      throw new Error(`Device ${index + 1}: unsupported protocol "${protocol}"`);
    }

    const normalised = { ...existing };
    delete normalised.accessory;
    delete normalised._uiKey;

    normalised.name = this._cleanString(device.name) || existing.name || 'Air Purifier';
    normalised.protocol = protocol;

    if (protocol === 'airplus-cloud') {
      normalised.host = this._cleanString(device.host) || 'cloud';
      normalised.airplusDeviceUuid = this._cleanString(device.airplusDeviceUuid);
      if (!normalised.airplusDeviceUuid) {
        throw new Error(`Device "${normalised.name}": Air+ device UUID is required`);
      }
      normalised.airplusTokenFile = this._cleanString(device.airplusTokenFile) ||
        normalised.airplusTokenFile ||
        path.join(os.homedir(), `.homebridge/philips-airplus-${normalised.airplusDeviceUuid}.json`);
      delete normalised.useHttps;
      delete normalised.clientId;
      delete normalised.clientSecret;
      delete normalised.encryptionKey;
    } else {
      normalised.host = this._cleanString(device.host);
      if (!this._isValidIpv4(normalised.host)) {
        throw new Error(`Device "${normalised.name}": host must be a valid IPv4 address`);
      }
      delete normalised.airplusDeviceUuid;
      delete normalised.airplusTokenFile;

      if (protocol === 'homeid-http') {
        normalised.useHttps = this._toBoolean(device.useHttps);
        this._assignOptionalString(normalised, 'clientId', device.clientId);
        this._assignSecret(normalised, 'clientSecret', device.clientSecret, device.clearClientSecret);
        this._assignSecret(normalised, 'encryptionKey', device.encryptionKey, device.clearEncryptionKey);
      } else {
        delete normalised.useHttps;
        delete normalised.clientId;
        delete normalised.clientSecret;
        delete normalised.encryptionKey;
      }
    }

    this._assignOptionalString(normalised, 'pythonPath', device.pythonPath);
    this._assignOptionalString(normalised, 'apiScriptPath', device.apiScriptPath);
    return normalised;
  }

  _assignOptionalString(target, key, value) {
    const cleaned = this._cleanString(value);
    if (cleaned) target[key] = cleaned;
    else delete target[key];
  }

  _assignSecret(target, key, value, clear) {
    if (this._toBoolean(clear)) {
      delete target[key];
      return;
    }
    const cleaned = this._cleanString(value);
    if (cleaned) target[key] = cleaned;
  }

  _deviceUiKey(device, index) {
    const source = JSON.stringify([
      index,
      device.airplusDeviceUuid || '',
      device.host || '',
      device.protocol || 'coap',
      device.name || '',
    ]);
    return crypto.createHash('sha1').update(source).digest('hex').slice(0, 16);
  }

  _cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  _isValidIpv4(host) {
    const parts = host.split('.');
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }

  _toBoolean(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
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
