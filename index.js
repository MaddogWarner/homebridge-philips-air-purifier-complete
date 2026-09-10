/**
 * Homebridge Philips Air Purifier Complete Plugin
 *
 * Controls Philips Air Purifiers via CoAP or HTTP using a persistent
 * Python daemon with CoAP Observe or HTTP polling for state updates.
 *
 * Architecture:
 * - Python daemon maintains a CoAP Observe subscription or HTTP polling loop
 * - Device pushes CoAP updates, while HTTP models are polled every 10 seconds
 * - Commands (power, mode, light, etc.) are sent directly and are fast
 * - State reads use cached data from observe or poll updates (instant)
 *
 * The aioairctrl Python library is bundled in the aioairctrl/ directory.
 * Only aiocoap and pycryptodomex need to be installed (done by postinstall.sh).
 */

const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Constants for device values
const MODE = {
  AUTO: 0,
  SLEEP: 17,
  TURBO: 18,
  MEDIUM: 19,
};

const MODE_NAME = {
  [MODE.AUTO]: 'auto',
  [MODE.SLEEP]: 'sleep',
  [MODE.TURBO]: 'turbo',
  [MODE.MEDIUM]: 'medium',
};

const LIGHT = {
  OFF: 0,
  DIM: 115,
  BRIGHT: 123,
};

// A scene/automation batch delivers TargetState and RotationSpeed within
// well under a second; on AC1715 the slider debounce adds another 400 ms.
const AUTO_SCENE_WINDOW_MS = 1500;

// A mode sent while the purifier is still powering on can be lost or
// overridden by the device's power-on default (AC1715 wakes up in Auto).
// Once the device reports power ON, re-send the requested mode if it did
// not stick — but only for a power-on we initiated this recently.
const POWER_ON_MODE_RETRY_MS = 60000;

// Hold any mode write this long after a power-on so the device has finished
// waking up before it sees the mode (the retry above is the backstop).
const POWER_ON_SETTLE_MS = 1500;

// Map rotation speed percentage to mode
const SPEED_TO_MODE = [
  { max: 33,  mode: 'sleep' },
  { max: 66,  mode: 'medium' },
  { max: 100, mode: 'turbo' },
];

// Map mode to rotation speed percentage
const MODE_TO_SPEED = {
  auto:   100,
  sleep:  16,
  medium: 50,
  turbo:  83,
};

// AC1715 (Air+ cloud) has three manual speeds: medium/fast/turbo.
// The slider maps ≤50 → medium, <100 → fast, 100 → turbo; these are the
// positions the slider snaps back to for each mode.
const AC1715_MODE_TO_SPEED = {
  medium: 50,
  fast: 75,
  turbo: 100,
};

const AC1715_MANUAL_MODES = new Set(Object.keys(AC1715_MODE_TO_SPEED));

// Restart backoff delays in ms
const RESTART_DELAYS = [5000, 10000, 30000, 60000];
const PYTHON_MIN_VERSION = '3.11';
const [PYTHON_MIN_MAJOR, PYTHON_MIN_MINOR] = PYTHON_MIN_VERSION.split('.').map(Number);
if (!Number.isInteger(PYTHON_MIN_MAJOR) || !Number.isInteger(PYTHON_MIN_MINOR)) {
  throw new Error(`Invalid PYTHON_MIN_VERSION: ${PYTHON_MIN_VERSION}`);
}
const PYTHON_RUNTIME_CHECK = `
import sys
if sys.version_info < (${PYTHON_MIN_MAJOR}, ${PYTHON_MIN_MINOR}):
    raise SystemExit(1)
import aiocoap, Cryptodome
`;

module.exports = (api) => {
  api.registerAccessory('PhilipsAirPurifier', PhilipsAirPurifierLegacyAccessory);
  api.registerPlatform('PhilipsAirPurifier', PhilipsAirPurifierPlatform);
};

function resolvePlatformDevices(config, log) {
  const devices = parseDeviceArray(config.devices, log, 'devices');
  const additionalDevices = parseDeviceArray(config.additionalDevicesJson, log, 'additionalDevicesJson');
  return mergeDeviceLists(devices, additionalDevices);
}

function parseDeviceArray(value, log, fieldName) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    log.warn(`[PhilipsAir] Ignoring ${fieldName}: expected a JSON array`);
  } catch (error) {
    log.warn(`[PhilipsAir] Ignoring ${fieldName}: invalid JSON (${error.message})`);
  }

  return [];
}

function mergeDeviceLists(baseDevices, additionalDevices) {
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

class PhilipsAirPurifierPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this._cachedAccessories = new Map();
    this._activeAccessories = [];

    api.on('didFinishLaunching', () => this._discoverDevices());
    api.on('shutdown', () => this._shutdownAll());
  }

  configureAccessory(platformAcc) {
    this._cachedAccessories.set(platformAcc.UUID, platformAcc);
  }

  _discoverDevices() {
    const devices = resolvePlatformDevices(this.config, this.log);
    const activeUUIDs = new Set();

    for (const deviceConfig of devices) {
      const seed = deviceConfig.airplusDeviceUuid || deviceConfig.host;
      if (!seed) {
        this.log.warn(`[PhilipsAir] Device "${deviceConfig.name || 'Unnamed'}" has no host or airplusDeviceUuid - skipping`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(seed);
      activeUUIDs.add(uuid);

      let platformAcc = this._cachedAccessories.get(uuid);
      if (platformAcc) {
        this.log.info(`[PhilipsAir] Restoring cached accessory: ${deviceConfig.name}`);
      } else {
        platformAcc = new this.api.platformAccessory(deviceConfig.name, uuid);
        this.api.registerPlatformAccessories(
          'homebridge-philips-air-purifier-complete',
          'PhilipsAirPurifier',
          [platformAcc]
        );
        this.log.info(`[PhilipsAir] Registering new accessory: ${deviceConfig.name}`);
      }

      platformAcc.context.device = { ...deviceConfig };
      const acc = new PhilipsAirPurifierAccessory(this.log, deviceConfig, this.api, platformAcc);
      this._activeAccessories.push(acc);
      this._cachedAccessories.set(uuid, platformAcc);
    }

    const staleAccessories = [];
    for (const [uuid, platformAcc] of this._cachedAccessories) {
      if (!activeUUIDs.has(uuid)) {
        staleAccessories.push([uuid, platformAcc]);
      }
    }

    for (const [uuid, platformAcc] of staleAccessories) {
      this.log.info(`[PhilipsAir] Removing stale accessory: ${platformAcc.displayName}`);
      this.api.unregisterPlatformAccessories(
        'homebridge-philips-air-purifier-complete',
        'PhilipsAirPurifier',
        [platformAcc]
      );
      this._cachedAccessories.delete(uuid);
    }
  }

  _shutdownAll() {
    for (const acc of this._activeAccessories) {
      acc.destroy();
    }
  }
}

/**
 * Daemon communication handler.
 *
 * The daemon uses CoAP Observe or HTTP polling to receive updates from the device.
 * State reads use cached data, commands are sent directly.
 */
class DaemonHandler {
  constructor(log, onUpdate, onExit, onModelId) {
    this.log = log;
    this.onUpdate = onUpdate;
    this.onExit = onExit;
    this.onModelId = onModelId;
    this.daemon = null;
    this.rl = null;
    this.connected = false;
    this.observing = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.commandTimeout = 15000;
  }

  async start(pythonPath, scriptPath, host, options = {}) {
    return new Promise((resolve, reject) => {
      const protocol = options.protocol || 'coap';
      const args = [scriptPath, host, '--daemon'];
      if (protocol !== 'coap') {
        args.push('--protocol', protocol);
      }
      if (protocol === 'homeid-http' && options.useHttps) {
        args.push('--use-https');
      }
      if (protocol === 'airplus-cloud') {
        args.push('--device-uuid', options.airplusDeviceUuid);
        args.push('--token-file', options.airplusTokenFile);
      }

      this.log.info(`Starting ${protocol} daemon: ${pythonPath} ${args.join(' ')}`);

      this.daemon = spawn(pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG || 'en_US.UTF-8',
          PYTHONUNBUFFERED: '1',
          PHILIPS_HOMEID_CLIENT_ID: options.homeIdClientId || '',
          PHILIPS_HOMEID_CLIENT_SECRET: options.homeIdClientSecret || '',
          PHILIPS_HOMEID_ENCRYPTION_KEY: options.homeIdEncryptionKey || '',
          // Ensure the bundled aioairctrl package is always importable
          PYTHONPATH: path.dirname(scriptPath),
        },
      });

      this.daemon.on('error', (err) => {
        this.log.error(`Daemon process error: ${err.message}`);
        this.connected = false;
        this.observing = false;
      });

      this.daemon.on('exit', (code, signal) => {
        this.log.warn(`Daemon exited (code=${code}, signal=${signal})`);
        this.connected = false;
        this.observing = false;
        this.daemon = null;

        for (const [, { reject: rej }] of this.pendingRequests) {
          rej(new Error('Daemon exited'));
        }
        this.pendingRequests.clear();

        if (this.onExit) this.onExit();
      });

      this.daemon.stderr.on('data', (data) => {
        this.log.debug(`Daemon stderr: ${data.toString().trim()}`);
      });

      this.rl = readline.createInterface({ input: this.daemon.stdout, terminal: false });
      this.rl.on('line', (line) => this.handleMessage(line));

      const timeout = setTimeout(() => {
        this.rl.removeListener('line', readyHandler);
        reject(new Error('Daemon startup timeout'));
      }, 20000);

      const readyHandler = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.type === 'ready') {
            clearTimeout(timeout);
            this.rl.removeListener('line', readyHandler);
            this.connected = response.connected;
            this._notifyModelId(response.model_id);
            if (response.connected) {
              this.log.info(`Daemon ready, waiting for first ${protocol === 'coap' ? 'observe' : 'poll'} update...`);
            } else {
              this.log.warn(`Daemon ready but not connected: ${response.error}`);
            }
            resolve(response.connected);
          }
        } catch (_error) {
          // Ignore non-JSON daemon output while waiting for the ready message.
        }
      };

      this.rl.on('line', readyHandler);
    });
  }

  stop() {
    this.onExit = null; // prevent restart callback on intentional stop
    if (this.daemon) {
      this.daemon.kill('SIGTERM');
      this.daemon = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.connected = false;
    this.observing = false;
  }

  _notifyModelId(modelId) {
    if (!modelId || !this.onModelId) return;
    try {
      this.onModelId(modelId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.error(`Model reconfiguration failed for ${modelId}: ${detail}`);
    }
  }

  handleMessage(line) {
    try {
      const message = JSON.parse(line);
      switch (message.type) {
        case 'update':
          this.observing = true;
          this.log.debug(`Observe update: pm25=${message.data?.pm25}`);
          if (this.onUpdate) this.onUpdate(message.data);
          this._notifyModelId(message.model_id);
          break;

        case 'log':
          this.log.debug(`Daemon [${message.event}]: ${message.message}`);
          break;

        case 'warning':
          this.log.warn(`Daemon [${message.event}]: ${message.message}`);
          break;

        case 'error':
          this.log.error(`Daemon error: ${message.error}`);
          break;

        case 'shutdown':
          this.connected = false;
          this.observing = false;
          break;

        default:
          if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(message.id);
            clearTimeout(timeout);
            this.pendingRequests.delete(message.id);
            if (message.success) resolve(message.data);
            else reject(new Error(message.error || 'Command failed'));
          }
      }
    } catch (_error) {
      this.log.debug(`Failed to parse daemon message: ${line}`);
    }
  }

  async execute(cmd, args = []) {
    if (!this.daemon) throw new Error('Daemon not running');

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command timeout: ${cmd}`));
      }, this.commandTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const request = JSON.stringify({ id, cmd, args });
      this.log.debug(`Sending: ${request}`);
      this.daemon.stdin.write(request + '\n');
    });
  }
}

/**
 * Main accessory class for Philips Air Purifier.
 */
class PhilipsAirPurifierAccessory {
  constructor(log, config, api, platformAcc) {
    this.log = log;
    this.api = api;
    this.platformAcc = platformAcc;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.name = config.name || 'Air Purifier';
    this.host = config.host;
    this.protocol = config.protocol || 'coap';
    this.homeIdClientId = config.clientId || '';
    this.homeIdClientSecret = config.clientSecret || '';
    this.homeIdEncryptionKey = config.encryptionKey || '';
    this.useHttps = Boolean(config.useHttps);
    this.airplusDeviceUuid = config.airplusDeviceUuid || '';
    this.airplusTokenFile = config.airplusTokenFile || '';

    if (this.protocol === 'airplus-cloud') {
      // host is unused for cloud protocol; use 'cloud' as a placeholder
      this.host = this.host || 'cloud';
      if (!this.airplusDeviceUuid) {
        this.log.warn('airplusDeviceUuid is required for airplus-cloud protocol. Run: python scripts/airplus_setup.py');
      }
      if (!this.airplusTokenFile) {
        this.airplusTokenFile = path.join(os.homedir(), `.homebridge/philips-airplus-${this.airplusDeviceUuid}.json`);
        this.log.debug(`airplusTokenFile not set, defaulting to: ${this.airplusTokenFile}`);
      }
    } else {
      if (!this.host) {
        throw new Error('host is required in config');
      }
      this.validateHost(this.host);
    }
    this.validateProtocol(this.protocol);

    const pluginDir = __dirname;
    this.apiScriptPath = config.apiScriptPath || path.join(pluginDir, 'philips_air_api.py');
    this.pythonPath = config.pythonPath || this.findPython(pluginDir);

    if (!this.apiScriptPath.endsWith('.py')) {
      throw new Error(`apiScriptPath must be a .py file: ${this.apiScriptPath}`);
    }
    if (!fs.existsSync(this.apiScriptPath)) {
      throw new Error(`Python API script not found at: ${this.apiScriptPath}`);
    }
    if (config.pythonPath) {
      this.validatePythonPath(this.pythonPath);
    }

    this.log.info(`Using Python: ${this.pythonPath}`);
    this.log.info(`Using API script: ${this.apiScriptPath}`);
    this.log.info(`Using protocol: ${this.protocol}`);

    this.state = {
      power: false,
      mode: 'auto',
      lightLevel: LIGHT.OFF,
      childLock: false,
      pm25: 0,
      iaql: 0,
      filterLifePercent: 100,
      cleanupPercent: 100,
      temperature: null,
      humidity: null,
    };

    this.deviceReachable = false;
    this.lastLightLevel = LIGHT.BRIGHT;
    this.lastUpdateTime = 0;
    this.lastPower = null;
    this.lastMode = null;
    this.lastManualMode = 'medium';
    this.lastNonSleepMode = 'auto';
    this._commandCount = 0;
    this._restartAttempt = 0;
    this._powerOnSentAt = 0;
    this._modeAfterPowerOn = null;

    // Model id persisted from a previous run; the airplus-cloud daemon
    // re-reports it on ready and on every update. Other protocols never
    // send one, so they always keep the default (model-agnostic) UI.
    this.modelId = platformAcc.context.modelId || '';

    this.daemon = new DaemonHandler(
      log,
      this.handleObserveUpdate.bind(this),
      this.handleDaemonExit.bind(this),
      this.handleModelId.bind(this)
    );

    this.setupServices();
    this.startDaemon();
  }

  findPython(pluginDir) {
    const candidates = [
      process.env.PHILIPS_AIR_PYTHON,
      process.env.PYTHON,
      process.env.PYTHON3,
      path.join(pluginDir, '.venv', 'bin', 'python3'),
      path.join(pluginDir, '.venv', 'bin', 'python3.12'),
      path.join(pluginDir, 'venv', 'bin', 'python3'),
      path.join(pluginDir, 'venv', 'bin', 'python3.12'),
      '/usr/local/opt/python@3.12/bin/python3.12',
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3.13',
      '/opt/homebrew/bin/python3.11',
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3.13',
      '/usr/local/bin/python3.11',
      '/usr/bin/python3.12',
      '/usr/bin/python3.13',
      '/usr/bin/python3.11',
      '/volume1/@appstore/Python3.12/usr/local/bin/python3.12',
      '/volume1/@appstore/py3k/usr/local/bin/python3',
      'python3.13',
      'python3.12',
      'python3.11',
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      'python3',
    ];

    for (const pythonPath of candidates) {
      if (!pythonPath) continue;
      const isCommandName = !pythonPath.includes(path.sep);
      if (!isCommandName && !fs.existsSync(pythonPath)) continue;
      try {
        // Check Python version plus CoAP and crypto deps. aioairctrl is bundled.
        execFileSync(pythonPath, ['-c', PYTHON_RUNTIME_CHECK], { stdio: 'ignore' });
        this.log.debug(`Found Python ${PYTHON_MIN_VERSION}+ with required dependencies: ${pythonPath}`);
        return pythonPath;
      } catch (_error) {
        // Try the next candidate; this one is missing the required runtime or modules.
      }
    }

    this.log.warn(`Could not find Python ${PYTHON_MIN_VERSION}+ with aiocoap and pycryptodomex installed. Run: bash postinstall.sh`);
    return 'python3';
  }

  validateHost(host) {
    const parts = host.split('.');
    const valid = parts.length === 4 &&
      parts.every(p => /^\d{1,3}$/.test(p) && parseInt(p, 10) <= 255);
    if (!valid) {
      throw new Error(`host must be a valid IPv4 address, got: "${host}"`);
    }
  }

  validateProtocol(protocol) {
    if (!['coap', 'http', 'homeid-http', 'airplus-cloud'].includes(protocol)) {
      throw new Error(`protocol must be "coap", "http", "homeid-http", or "airplus-cloud", got: "${protocol}"`);
    }
  }

  validatePythonPath(pythonPath) {
    if (/[;&|`$<>!]/.test(pythonPath)) {
      throw new Error(`pythonPath contains invalid characters: "${pythonPath}"`);
    }
    if (path.isAbsolute(pythonPath) && !fs.existsSync(pythonPath)) {
      throw new Error(`pythonPath does not exist: "${pythonPath}"`);
    }
    try {
      execFileSync(pythonPath, ['-c', PYTHON_RUNTIME_CHECK], { stdio: 'ignore' });
    } catch (error) {
      throw new Error(`pythonPath must point to Python ${PYTHON_MIN_VERSION}+ with aiocoap and pycryptodomex installed: "${pythonPath}"`, { cause: error });
    }
  }

  async startDaemon() {
    if (this.protocol === 'airplus-cloud' && !this.airplusDeviceUuid) {
      this.log.warn('airplus-cloud requires airplusDeviceUuid. Use Plugin Settings to run the Air+ Setup Wizard, or set airplusDeviceUuid manually.');
      this.deviceReachable = false;
      return;
    }

    try {
      const connected = await this.daemon.start(this.pythonPath, this.apiScriptPath, this.host, {
        protocol: this.protocol,
        useHttps: this.useHttps,
        homeIdClientId: this.homeIdClientId,
        homeIdClientSecret: this.homeIdClientSecret,
        homeIdEncryptionKey: this.homeIdEncryptionKey,
        airplusDeviceUuid: this.airplusDeviceUuid,
        airplusTokenFile: this.airplusTokenFile,
      });
      this.deviceReachable = connected;
      this._restartAttempt = 0;
      const updateType = this.protocol === 'coap' ? 'CoAP observe' : this.protocol === 'airplus-cloud' ? 'MQTT' : 'HTTP poll';
      this.log.info(`Daemon started, waiting for ${updateType} updates...`);
    } catch (error) {
      this.log.error(`Failed to start daemon: ${error.message}`);
      this.deviceReachable = false;
      this.scheduleDaemonRestart();
    }
  }

  handleDaemonExit() {
    this.deviceReachable = false;
    this.scheduleDaemonRestart();
  }

  scheduleDaemonRestart() {
    const delay = RESTART_DELAYS[Math.min(this._restartAttempt, RESTART_DELAYS.length - 1)];
    this._restartAttempt++;
    this.log.info(`Restarting daemon in ${delay / 1000}s (attempt ${this._restartAttempt})...`);
    setTimeout(() => this.startDaemon(), delay);
  }

  handleObserveUpdate(sensors) {
    if (this.commandLock) {
      this.log.debug('Skipping observe update - command in progress');
      return;
    }

    this.state.power = sensors.power;
    const observedMode = this.normalizeMode(sensors.mode);
    if (AC1715_MANUAL_MODES.has(observedMode)) this.lastManualMode = observedMode;
    if (observedMode !== 'sleep') this.lastNonSleepMode = observedMode;
    this.state.mode = observedMode;
    this.state.lightLevel = sensors.light_level;
    this.state.childLock = sensors.child_lock;
    this.state.pm25 = sensors.pm25 || 0;
    this.state.iaql = sensors.iaql || 0;
    this.state.filterLifePercent = sensors.filter_life_percent ?? 100;
    this.state.cleanupPercent = sensors.cleanup_percent ?? 100;
    this.state.temperature = sensors.temperature;
    this.state.humidity = sensors.humidity;

    if (this.state.lightLevel > 0) this.lastLightLevel = this.state.lightLevel;

    const wasReachable = this.deviceReachable;
    const powerChanged = this.lastPower !== this.state.power;
    const modeChanged = this.lastMode !== this.state.mode;

    if (!wasReachable) {
      this.deviceReachable = true;
      this.log.info(`Device connected: power=${this.state.power ? 'ON' : 'OFF'}, mode=${this.state.mode}, pm25=${this.state.pm25}`);
    } else if (powerChanged || modeChanged) {
      this.log.info(`Status changed: power=${this.state.power ? 'ON' : 'OFF'}, mode=${this.state.mode}`);
    }

    this.lastPower = this.state.power;
    this.lastMode = this.state.mode;
    this.lastUpdateTime = Date.now();

    this.reapplyModeAfterPowerOn();

    this.updatePurifierCharacteristics();
    this.updateLightCharacteristics();
    this.updateAirQualityCharacteristics();
    this.updateFilterCharacteristics();
    this.updateSleepCharacteristics();
  }

  setupServices() {
    const { Service, Characteristic } = this;

    // Accessory Information
    this.informationService = this.platformAcc.getService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(Characteristic.Model, 'Air Purifier')
      .setCharacteristic(Characteristic.SerialNumber, this.host);

    // Main Air Purifier Service
    this.purifierService =
      this.platformAcc.getService(Service.AirPurifier) ||
      this.platformAcc.addService(Service.AirPurifier, this.name);

    this.purifierService.getCharacteristic(Characteristic.Active)
      .onGet(() => this.state.power ? 1 : 0)
      .onSet(async (value) => {
        const on = value === 1;
        this.log.info(`[SET] Power: ${on ? 'ON' : 'OFF'}`);
        await this.executeCommand('power', [on ? 'on' : 'off'], { power: on });
        this.updatePurifierCharacteristics();
      });

    this.purifierService.getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() => this.state.power
        ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
        : Characteristic.CurrentAirPurifierState.INACTIVE);

    // Child Lock (LockPhysicalControls)
    this.purifierService.getCharacteristic(Characteristic.LockPhysicalControls)
      .onGet(() => this.state.childLock
        ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED)
      .onSet(async (value) => {
        const enabled = value === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
        this.log.info(`[SET] ChildLock: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        await this.executeCommand('childlock', [enabled ? 'on' : 'off'], { childLock: enabled });
      });

    // Air Quality Sensor
    this.airQualitySensor =
      this.platformAcc.getService(Service.AirQualitySensor) ||
      this.platformAcc.addService(Service.AirQualitySensor, 'Air Quality');
    this.airQualitySensor.getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.pm25ToAirQuality(this.state.pm25));
    this.airQualitySensor.getCharacteristic(Characteristic.PM2_5Density)
      .onGet(() => this.state.pm25 || 0);

    // HEPA Filter Maintenance
    this.hepaFilterService =
      this.platformAcc.getServiceById(Service.FilterMaintenance, 'hepa') ||
      this.platformAcc.addService(new Service.FilterMaintenance('HEPA Filter', 'hepa'));
    this.hepaFilterService.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => Math.round(this.state.filterLifePercent));
    this.hepaFilterService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.state.filterLifePercent < 10
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK);

    // Pre-Filter Maintenance
    this.preFilterService =
      this.platformAcc.getServiceById(Service.FilterMaintenance, 'pre') ||
      this.platformAcc.addService(new Service.FilterMaintenance('Pre-Filter', 'pre'));
    this.preFilterService.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => Math.round(this.state.cleanupPercent));
    this.preFilterService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.state.cleanupPercent < 10
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK);

    // Link secondary services to primary (light/sleep are linked in
    // setupModelDependentServices, which owns those services)
    this.purifierService.addLinkedService(this.airQualitySensor);
    this.purifierService.addLinkedService(this.hepaFilterService);
    this.purifierService.addLinkedService(this.preFilterService);

    this.setupModelDependentServices();
  }

  isAC1715() {
    return this.modelId.toUpperCase().startsWith('AC1715');
  }

  handleModelId(modelId) {
    if (!modelId || modelId === this.modelId) return;
    const wasAC1715 = this.isAC1715();
    this.modelId = modelId;
    this.platformAcc.context.modelId = modelId;
    if (this.platformAcc instanceof this.api.platformAccessory) {
      this.api.updatePlatformAccessories([this.platformAcc]);
    }
    if (this.isAC1715() !== wasAC1715) {
      this.log.info(`Model detected: ${modelId} — reconfiguring model-specific controls`);
      this.setupModelDependentServices();
    }
  }

  /**
   * (Re)configure the services whose behavior depends on the device model.
   * Runs at construction with the persisted model id (unknown on first
   * boot → default UI) and again if the daemon reports a different model.
   * onGet/onSet replace any previously installed handler, so re-running
   * is safe.
   *
   * AC1715: continuous fan slider mapping medium/fast/turbo, display
   * light as a plain on/off switch (the panel has no dim level), sleep
   * off restores the last non-sleep mode. All other models: original
   * behavior, unchanged.
   */
  setupModelDependentServices() {
    const { Service, Characteristic } = this;
    const ac1715 = this.isAC1715();

    this.purifierService.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(() => this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL)
      .onSet(async (value) => {
        const isAuto = value === Characteristic.TargetAirPurifierState.AUTO;
        const mode = isAuto ? 'auto' : (ac1715 ? this.lastManualMode : 'medium');
        this.log.info(`[SET] TargetState: ${isAuto ? 'AUTO' : 'MANUAL'}`);
        // Home app scenes/automations write every characteristic of the
        // accessory in one batch, so an "Auto" scene also replays the
        // RotationSpeed captured when it was created. Without this guard
        // that speed write lands after `mode auto` and flips the device
        // back to a manual mode. Remember the AUTO request so speed writes
        // in the same batch are ignored (see suppressSpeedForAuto).
        if (isAuto) {
          this._autoRequestedAt = Date.now();
          if (this._fanSpeedTimer) {
            clearTimeout(this._fanSpeedTimer);
            this._fanSpeedTimer = null;
          }
        } else {
          this._autoRequestedAt = 0;
        }
        if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
        if (ac1715) this.lastNonSleepMode = mode;
        await this.executeCommand('mode', [mode], { mode });
        this.updatePurifierCharacteristics();
        if (ac1715) this.updateSleepCharacteristics();
      });

    const rotationSpeed = this.purifierService.getCharacteristic(Characteristic.RotationSpeed);
    if (ac1715) {
      // Slider buckets: ≤50 → Medium, 51–99 → Fast, 100 → Turbo; reads
      // snap to 50/75/100 (AC1715_MODE_TO_SPEED).
      rotationSpeed.setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
        // Explicitly clear any previously cached three-value restriction.
        // HAP-NodeJS preserves old props unless they are set to null.
        validValues: null,
        validValueRanges: null,
      });

      this.log.debug(`RotationSpeed props: ${JSON.stringify(rotationSpeed.props)}`);

      const applyFanSpeed = async (speed) => {
        // The debounce means a failure can't propagate to HomeKit as a
        // write error, so roll back the optimistic state on failure and
        // resync the characteristics — the slider snaps back instead of
        // showing a speed the device never reached.
        const prior = {
          power: this.state.power,
          mode: this.state.mode,
          lastManualMode: this.lastManualMode,
          lastNonSleepMode: this.lastNonSleepMode,
        };
        try {
          if (speed === 0) {
            this.log.info('[SET] RotationSpeed: 0% -> POWER OFF');
            await this.executeCommand('power', ['off'], { power: false });
            return;
          }

          const mode =
            speed <= 50 ? 'medium' :
            speed < 100 ? 'fast' :
            'turbo';

          // Dedupe: device already in this mode -> nothing to send.
          if (this.state.power && this.state.mode === mode) {
            this.log.debug(`[SET] RotationSpeed: ${speed}% -> ${mode} (no change, skipped)`);
            return;
          }

          this.log.info(`[SET] RotationSpeed: ${speed}% -> ${mode.toUpperCase()}`);
          if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
          this.lastManualMode = mode;
          this.lastNonSleepMode = mode;
          await this.executeCommand('mode', [mode], { mode });
        } catch (err) {
          this.state.power = prior.power;
          this.state.mode = prior.mode;
          this.lastManualMode = prior.lastManualMode;
          this.lastNonSleepMode = prior.lastNonSleepMode;
          throw err;
        } finally {
          this.updatePurifierCharacteristics();
          this.updateSleepCharacteristics();
        }
      };

      rotationSpeed
        .onGet(() => this.state.power
          ? (AC1715_MODE_TO_SPEED[this.lastManualMode] ?? 50)
          : 0)
        .onSet((value) => {
          if (this.suppressSpeedForAuto(value)) return;
          // Debounce: the Home app streams writes while the slider is
          // dragged. Only act on the value it settles at.
          this._pendingFanSpeed = Number(value);
          if (this._fanSpeedTimer) clearTimeout(this._fanSpeedTimer);
          this._fanSpeedTimer = setTimeout(() => {
            this._fanSpeedTimer = null;
            if (this.suppressSpeedForAuto(this._pendingFanSpeed)) return;
            applyFanSpeed(this._pendingFanSpeed).catch((err) => {
              this.log.error(`RotationSpeed apply failed: ${err.message}`);
            });
          }, 400);
        });
    } else {
      rotationSpeed
        .onGet(() => MODE_TO_SPEED[this.state.mode] ?? 100)
        .onSet(async (value) => {
          if (this.suppressSpeedForAuto(value)) return;
          this.log.info(`[SET] RotationSpeed: ${value}%`);
          if (value === 0) {
            await this.executeCommand('power', ['off'], { power: false });
          } else {
            if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
            const entry = SPEED_TO_MODE.find(({ max }) => value <= max);
            const mode = entry ? entry.mode : 'medium';
            await this.executeCommand('mode', [mode], { mode });
          }
          this.updatePurifierCharacteristics();
        });
    }

    // Display Light: on/off Switch on AC1715 (its panel light has no dim
    // level), Lightbulb with Brightness everywhere else.
    if (ac1715) {
      const oldLightbulb = this.platformAcc.getService(Service.Lightbulb);
      if (oldLightbulb) {
        if (typeof this.purifierService.removeLinkedService === 'function') {
          this.purifierService.removeLinkedService(oldLightbulb);
        }
        this.platformAcc.removeService(oldLightbulb);
      }

      this.lightService =
        this.platformAcc.getServiceById(Service.Switch, 'display-light') ||
        this.platformAcc.addService(Service.Switch, 'Display Light', 'display-light');
      this.lightService.displayName = 'Display Light';
      this.lightService.setCharacteristic(Characteristic.Name, 'Display Light');
      this.lightService.getCharacteristic(Characteristic.On)
        .onGet(() => this.state.lightLevel > 0)
        .onSet(async (value) => {
          const level = value ? LIGHT.BRIGHT : LIGHT.OFF;
          this.log.info(`[SET] Display Light: ${value ? 'ON' : 'OFF'}`);
          await this.executeCommand('light', [level.toString()], { lightLevel: level });
          this.updateLightCharacteristics();
        });
    } else {
      const oldSwitch = this.platformAcc.getServiceById(Service.Switch, 'display-light');
      if (oldSwitch) {
        if (typeof this.purifierService.removeLinkedService === 'function') {
          this.purifierService.removeLinkedService(oldSwitch);
        }
        this.platformAcc.removeService(oldSwitch);
      }

      this.lightService =
        this.platformAcc.getService(Service.Lightbulb) ||
        this.platformAcc.addService(Service.Lightbulb, 'Display Light');
      this.lightService.getCharacteristic(Characteristic.On)
        .onGet(() => this.state.lightLevel > 0)
        .onSet(async (value) => {
          this.log.info(`[SET] Light: ${value ? 'ON' : 'OFF'}`);
          let level;
          if (value) {
            level = this.lastLightLevel > 0 ? this.lastLightLevel : LIGHT.BRIGHT;
          } else {
            if (this.state.lightLevel > 0) this.lastLightLevel = this.state.lightLevel;
            level = LIGHT.OFF;
          }
          await this.executeCommand('light', [level.toString()], { lightLevel: level });
          this.updateLightCharacteristics();
        });
      this.lightService.getCharacteristic(Characteristic.Brightness)
        .onGet(() => {
          if (this.state.lightLevel === LIGHT.DIM) return 50;
          if (this.state.lightLevel === LIGHT.OFF) return 0;
          return 100;
        })
        .onSet(async (value) => {
          this.log.info(`[SET] LightBrightness: ${value}%`);
          let level;
          if (value === 0) level = LIGHT.OFF;
          else if (value <= 50) level = LIGHT.DIM;
          else level = LIGHT.BRIGHT;
          if (level > 0) this.lastLightLevel = level;
          await this.executeCommand('light', [level.toString()], { lightLevel: level });
          this.updateLightCharacteristics();
        });
    }

    // Sleep Mode Switch
    // HomeKit's AirPurifier only has Auto/Manual — Sleep is exposed as a dedicated switch.
    this.sleepService =
      this.platformAcc.getServiceById(Service.Switch, 'sleep-mode') ||
      this.platformAcc.addService(Service.Switch, 'Sleep Mode', 'sleep-mode');
    this.sleepService.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.mode === 'sleep' && this.state.power)
      .onSet(async (value) => {
        this.log.info(`[SET] Sleep Mode: ${value ? 'ON' : 'OFF'}`);
        if (ac1715) {
          if (value) {
            // Remember what we were doing before Sleep.
            if (this.state.mode !== 'sleep') {
              this.lastNonSleepMode = this.state.mode;
              if (AC1715_MANUAL_MODES.has(this.state.mode)) {
                this.lastManualMode = this.state.mode;
              }
            }
            if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
            await this.executeCommand('mode', ['sleep'], { mode: 'sleep' });
          } else if (this.state.mode === 'sleep') {
            const restoreMode = this.lastNonSleepMode || 'auto';
            if (AC1715_MANUAL_MODES.has(restoreMode)) {
              this.lastManualMode = restoreMode;
            }
            await this.executeCommand('mode', [restoreMode], { mode: restoreMode });
          }
        } else {
          if (value) {
            if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
            await this.executeCommand('mode', ['sleep'], { mode: 'sleep' });
            if (this.state.lightLevel > 0) this.lastLightLevel = this.state.lightLevel;
            await this.executeCommand('light', ['0'], { lightLevel: LIGHT.OFF });
            this.updateLightCharacteristics();
          } else {
            await this.executeCommand('mode', ['auto'], { mode: 'auto' });
          }
        }
        this.updatePurifierCharacteristics();
        this.updateSleepCharacteristics();
      });

    const linkedModelServices = [this.lightService, this.sleepService];
    const previouslyLinked = this._linkedModelServices || [];
    for (const service of linkedModelServices) {
      if (!previouslyLinked.includes(service)) {
        this.purifierService.addLinkedService(service);
      }
    }
    this._linkedModelServices = linkedModelServices;
  }

  pm25ToAirQuality(pm25) {
    const { Characteristic } = this;
    if (!pm25) return Characteristic.AirQuality.UNKNOWN;
    if (pm25 <= 12) return Characteristic.AirQuality.EXCELLENT;
    if (pm25 <= 35) return Characteristic.AirQuality.GOOD;
    if (pm25 <= 55) return Characteristic.AirQuality.FAIR;
    if (pm25 <= 100) return Characteristic.AirQuality.INFERIOR;
    return Characteristic.AirQuality.POOR;
  }

  normalizeMode(mode) {
    if (typeof mode === 'string') return mode.toLowerCase();
    return MODE_NAME[mode] || 'auto';
  }

  get commandLock() {
    return this._commandCount > 0;
  }

  /**
   * True when a RotationSpeed write should be dropped because an AUTO
   * TargetState write arrived moments ago from the same scene/automation
   * batch. A user dragging the slider never writes TargetState first, so
   * manual control is unaffected. A 0% write (power off) is always honored.
   */
  suppressSpeedForAuto(value) {
    if (Number(value) === 0) return false;
    if (!this._autoRequestedAt || Date.now() - this._autoRequestedAt > AUTO_SCENE_WINDOW_MS) return false;
    this.log.info(`[SET] RotationSpeed: ${value}% ignored (AUTO requested by the same scene)`);
    this.updatePurifierCharacteristics();
    return true;
  }

  /**
   * Called from handleObserveUpdate once the device has reported a status.
   * If we powered the device on and then asked for a mode before it had
   * confirmed power ON, the mode may have been dropped or overridden by
   * the device's power-on default (see POWER_ON_MODE_RETRY_MS). Re-send
   * it once, only if the first status after power-on shows a different
   * mode. Anything the device reports after that is left alone so we
   * never fight a change made on the panel or in the Philips app.
   */
  reapplyModeAfterPowerOn() {
    if (!this._powerOnSentAt) return;
    const age = Date.now() - this._powerOnSentAt;
    if (!this.state.power) {
      if (age > POWER_ON_MODE_RETRY_MS) {
        this._powerOnSentAt = 0;
        this._modeAfterPowerOn = null;
      }
      return;
    }
    const mode = this._modeAfterPowerOn;
    this._powerOnSentAt = 0;
    this._modeAfterPowerOn = null;
    if (!mode || age > POWER_ON_MODE_RETRY_MS || this.state.mode === mode) return;
    this.log.info(`Device came up in ${this.state.mode}, re-sending requested mode ${mode}`);
    if (this.isAC1715()) {
      if (AC1715_MANUAL_MODES.has(mode)) this.lastManualMode = mode;
      if (mode !== 'sleep') this.lastNonSleepMode = mode;
    }
    this.executeCommand('mode', [mode], { mode })
      .then(() => {
        this.updatePurifierCharacteristics();
        if (this.isAC1715()) this.updateSleepCharacteristics();
      })
      .catch((err) => {
        this.log.error(`Re-sending mode ${mode} after power-on failed: ${err.message}`);
      });
  }

  async executeCommand(cmd, args, optimisticState = {}) {
    // A mode sent right after a power-on reaches a device that is still
    // waking up (power-on and mode travel on different Air+ channels).
    // Wait out POWER_ON_SETTLE_MS from the power-on before sending it.
    // A status report confirming power ON clears _powerOnSentAt early.
    if (cmd === 'mode' && this._powerOnSentAt) {
      const wait = POWER_ON_SETTLE_MS - (Date.now() - this._powerOnSentAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this._commandCount++;
    Object.assign(this.state, optimisticState);
    // Track a power-on we initiated so reapplyModeAfterPowerOn can
    // verify that a mode requested in the same batch actually stuck.
    if (cmd === 'power') {
      this._powerOnSentAt = args[0] === 'on' ? Date.now() : 0;
      this._modeAfterPowerOn = null;
    } else if (cmd === 'mode' && this._powerOnSentAt) {
      this._modeAfterPowerOn = args[0];
    }
    try {
      await this.daemon.execute(cmd, args);
      this.log.debug(`Command ${cmd} succeeded`);
    } catch (error) {
      this.log.error(`Command ${cmd} failed: ${error.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      setTimeout(() => { this._commandCount = Math.max(0, this._commandCount - 1); }, 500);
    }
  }

  updatePurifierCharacteristics() {
    const { Characteristic } = this;
    this.purifierService.updateCharacteristic(Characteristic.Active, this.state.power ? 1 : 0);
    this.purifierService.updateCharacteristic(
      Characteristic.CurrentAirPurifierState,
      this.state.power
        ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
        : Characteristic.CurrentAirPurifierState.INACTIVE
    );
    this.purifierService.updateCharacteristic(
      Characteristic.TargetAirPurifierState,
      this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL
    );
    this.purifierService.updateCharacteristic(
      Characteristic.RotationSpeed,
      this.isAC1715()
        ? (this.state.power ? (AC1715_MODE_TO_SPEED[this.lastManualMode] ?? 50) : 0)
        : (MODE_TO_SPEED[this.state.mode] ?? 100)
    );
    this.purifierService.updateCharacteristic(
      Characteristic.LockPhysicalControls,
      this.state.childLock
        ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED
    );
  }

  updateLightCharacteristics() {
    const { Characteristic } = this;
    this.lightService.updateCharacteristic(Characteristic.On, this.state.lightLevel > 0);
    if (this.isAC1715()) return; // on/off Switch has no Brightness
    let brightness = 100;
    if (this.state.lightLevel === LIGHT.OFF) brightness = 0;
    else if (this.state.lightLevel === LIGHT.DIM) brightness = 50;
    this.lightService.updateCharacteristic(Characteristic.Brightness, brightness);
  }

  updateAirQualityCharacteristics() {
    const { Characteristic } = this;
    this.airQualitySensor.updateCharacteristic(Characteristic.AirQuality, this.pm25ToAirQuality(this.state.pm25));
    this.airQualitySensor.updateCharacteristic(Characteristic.PM2_5Density, this.state.pm25 || 0);
  }

  updateFilterCharacteristics() {
    const { Characteristic } = this;
    this.hepaFilterService.updateCharacteristic(Characteristic.FilterLifeLevel, Math.round(this.state.filterLifePercent));
    this.hepaFilterService.updateCharacteristic(
      Characteristic.FilterChangeIndication,
      this.state.filterLifePercent < 10
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK
    );
    this.preFilterService.updateCharacteristic(Characteristic.FilterLifeLevel, Math.round(this.state.cleanupPercent));
    this.preFilterService.updateCharacteristic(
      Characteristic.FilterChangeIndication,
      this.state.cleanupPercent < 10
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK
    );
  }

  updateSleepCharacteristics() {
    const { Characteristic } = this;
    this.sleepService.updateCharacteristic(Characteristic.On, this.state.mode === 'sleep' && this.state.power);
  }

  identify() {
    this.log.info(`Identify requested for ${this.name}`);
  }

  destroy() {
    if (this._fanSpeedTimer) {
      clearTimeout(this._fanSpeedTimer);
      this._fanSpeedTimer = null;
    }
    this.daemon.stop();
  }
}

class PhilipsAirPurifierLegacyAccessory {
  constructor(log, config, api) {
    this.accessory = null;

    if (process.env.PHILIPS_AIR_ALLOW_LEGACY_ACCESSORY !== '1') {
      log.error('[PhilipsAir] Legacy accessories[] config detected and will not be loaded. Move this entry into platforms[].devices[] and remove the top-level accessories[] entry. Set PHILIPS_AIR_ALLOW_LEGACY_ACCESSORY=1 only as a temporary rollback.');
      return;
    }

    log.warn('[PhilipsAir] Legacy accessories[] config enabled by PHILIPS_AIR_ALLOW_LEGACY_ACCESSORY=1. This compatibility path is deprecated; migrate to platforms[].devices[].');
    this.accessory = new PhilipsAirPurifierAccessory(log, config, api, new LegacyPlatformAccessory(api));
  }

  getServices() {
    return this.accessory ? this.accessory.platformAcc.getServices() : [];
  }

  identify() {
    if (this.accessory) {
      this.accessory.identify();
    }
  }
}

class LegacyPlatformAccessory {
  constructor(api) {
    this.Service = api.hap.Service;
    this.services = [];
    this.context = {};
    this.informationService = new this.Service.AccessoryInformation();
    this.services.push(this.informationService);
  }

  getService(serviceType) {
    return this.services.find((service) => service instanceof serviceType);
  }

  getServiceById(serviceType, subtype) {
    return this.services.find((service) => service instanceof serviceType && service.subtype === subtype);
  }

  addService(serviceOrType, name, subtype) {
    const service = typeof serviceOrType === 'function'
      ? new serviceOrType(name, subtype)
      : serviceOrType;
    this.services.push(service);
    return service;
  }

  removeService(service) {
    const index = this.services.indexOf(service);
    if (index !== -1) this.services.splice(index, 1);
  }

  getServices() {
    return this.services;
  }
}

module.exports._DaemonHandler = DaemonHandler;
module.exports._PhilipsAirPurifierAccessory = PhilipsAirPurifierAccessory;
