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
 * The aioairctrl Python library is bundled in the aioairctrl/ directory and
 * its dependencies in vendor/, so only Python 3.11+ is needed (no install step).
 */

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  PYTHON_MIN_VERSION,
  describeRejection,
  findPython,
  inspectPython,
  pythonInstallHint,
  pythonPathError,
} = require('./python-runtime');

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
const POWER_OFF_SCENE_WINDOW_MS = 1500;

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
// Python discovery runs blocking subprocesses, so do it once per plugin
// directory rather than once per accessory.
const pythonByPluginDir = new Map();
function findPythonCached(accessory, pluginDir) {
  if (!pythonByPluginDir.has(pluginDir)) pythonByPluginDir.set(pluginDir, accessory.findPython(pluginDir));
  return pythonByPluginDir.get(pluginDir);
}

module.exports = (api) => {
  api.registerPlatform('PhilipsAirPurifier', PhilipsAirPurifierPlatform);
};

/**
 * Default Air+ token path: Homebridge's storage directory, so the token is
 * included in Homebridge backups and survives container re-creation.
 * Falls back to the pre-4.3 location (~/.homebridge) when a token exists
 * only there, so existing setups keep working without re-running setup.
 */
function defaultAirplusTokenFile(api, deviceUuid) {
  const fileName = `philips-airplus-${deviceUuid}.json`;
  const legacyPath = path.join(os.homedir(), '.homebridge', fileName);
  const storagePath = typeof api?.user?.storagePath === 'function' ? api.user.storagePath() : '';
  if (!storagePath) return legacyPath;
  const storageFile = path.join(storagePath, fileName);
  if (!fs.existsSync(storageFile) && fs.existsSync(legacyPath)) return legacyPath;
  return storageFile;
}

/** Python bytecode cache under the Homebridge storage dir, or '' if unknown. */
function pycachePrefix(api) {
  const storagePath = typeof api?.user?.storagePath === 'function' ? api.user.storagePath() : '';
  return storagePath ? path.join(storagePath, 'philips-air-purifier', 'pycache') : '';
}

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

      const cachedAcc = this._cachedAccessories.get(uuid);
      const platformAcc = cachedAcc || new this.api.platformAccessory(deviceConfig.name, uuid);

      // One misconfigured device must not stop the others from loading.
      // A cached accessory is kept (not treated as stale) so a config typo
      // doesn't wipe its rooms and automations; a new one is only
      // registered once it has been set up successfully.
      let acc;
      try {
        acc = new PhilipsAirPurifierAccessory(this.log, deviceConfig, this.api, platformAcc);
      } catch (error) {
        this.log.error(`[PhilipsAir] Device "${deviceConfig.name || 'Unnamed'}" not loaded: ${error.message}`);
        continue;
      }

      if (cachedAcc) {
        this.log.info(`[PhilipsAir] Restoring cached accessory: ${deviceConfig.name}`);
      } else {
        this.api.registerPlatformAccessories(
          'homebridge-philips-air-purifier-complete',
          'PhilipsAirPurifier',
          [platformAcc]
        );
        this.log.info(`[PhilipsAir] Registering new accessory: ${deviceConfig.name}`);
      }

      platformAcc.context.device = { ...deviceConfig };
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
    // Never leave an earlier process running behind a new one.
    if (this.daemon) this._killChild(this.daemon);

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

      const child = spawn(pythonPath, args, {
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
          // Keep bytecode caches out of the plugin directory (Homebridge
          // Verified: write only inside the storage directory).
          ...(options.pycachePrefix
            ? { PYTHONPYCACHEPREFIX: options.pycachePrefix }
            : { PYTHONDONTWRITEBYTECODE: '1' }),
        },
      });
      this.daemon = child;

      // Startup settles exactly once: on ready, on timeout, or when the
      // process dies first. A pre-ready failure is reported only through
      // the rejection (the caller schedules the restart), never also
      // through onExit, so a crash-looping daemon gets one restart chain.
      let settled = false;
      const settle = (error, connected) => {
        if (settled) return;
        settled = true;
        if (this._startingChild === child) {
          this._startingChild = null;
          this._abortStart = null;
        }
        clearTimeout(timeout);
        rl.removeListener('line', readyHandler);
        if (error) reject(error);
        else resolve(connected);
      };

      child.stdin.on('error', (err) => {
        this.log.debug(`Daemon stdin error: ${err.message}`);
      });

      child.on('error', (err) => {
        this.log.error(`Daemon process error: ${err.message}`);
        if (this.daemon !== child) return;
        if (!settled) {
          this._detachChild();
          settle(err);
        }
      });

      child.on('exit', (code, signal) => {
        // Exit of a process that was stopped or replaced: nothing to do.
        if (this.daemon !== child) return;
        this.log.warn(`Daemon exited (code=${code}, signal=${signal})`);
        this._detachChild();
        if (!settled) {
          settle(new Error(`Daemon exited before ready (code=${code}, signal=${signal})`));
          return;
        }
        if (this.onExit) this.onExit();
      });

      child.stderr.on('data', (data) => {
        this.log.debug(`Daemon stderr: ${data.toString().trim()}`);
      });

      const rl = readline.createInterface({ input: child.stdout, terminal: false });
      this.rl = rl;
      rl.on('line', (line) => {
        if (this.daemon === child) this.handleMessage(line);
      });

      const timeout = setTimeout(() => {
        settle(new Error('Daemon startup timeout'));
        if (this.daemon === child) this._killChild(child);
      }, 20000);

      const readyHandler = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.type === 'ready') {
            this.connected = response.connected;
            this._notifyModelId(response.model_id);
            if (response.connected) {
              this.log.info(`Daemon ready, waiting for first ${protocol === 'coap' ? 'observe' : 'poll'} update...`);
            } else {
              this.log.warn(`Daemon ready but not connected: ${response.error}`);
            }
            settle(null, response.connected);
          }
        } catch (_error) {
          // Ignore non-JSON daemon output while waiting for the ready message.
        }
      };

      rl.on('line', readyHandler);

      // Lets stop() or a newer start() settle this start if they kill the
      // process before it reports ready.
      this._startingChild = child;
      this._abortStart = (error) => settle(error);
    });
  }

  stop() {
    this.onExit = null; // prevent restart callback on intentional stop
    if (this.daemon) this._killChild(this.daemon);
  }

  // Forget the current process: reject its in-flight requests and close
  // its reader. Its exit event is then ignored as stale.
  _detachChild() {
    this.daemon = null;
    this.connected = false;
    this.observing = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    for (const [, { reject: rej, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      rej(new Error('Daemon exited'));
    }
    this.pendingRequests.clear();
  }

  _killChild(child) {
    if (this._startingChild === child) this._abortStart(new Error('Daemon stopped before ready'));
    this._detachChild();
    child.kill('SIGTERM');
    // Escalate if the process ignores SIGTERM (e.g. wedged in a blocking call).
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    escalate.unref?.();
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
    if (!this.daemon || !this.daemon.stdin.writable) throw new Error('Daemon not running');

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command timeout: ${cmd}`));
      }, this.commandTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // The daemon handles commands one at a time; the deadline lets it drop
      // a command that has waited past this timeout, after which the
      // accessory has already rolled back its optimistic state.
      const deadline = Date.now() + this.commandTimeout;
      const request = JSON.stringify({ id, cmd, args, deadline });
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
        this.airplusTokenFile = defaultAirplusTokenFile(api, this.airplusDeviceUuid);
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
    this.pythonPath = config.pythonPath || findPythonCached(this, pluginDir);

    if (!this.apiScriptPath.endsWith('.py')) {
      throw new Error(`apiScriptPath must be a .py file: ${this.apiScriptPath}`);
    }
    if (!fs.existsSync(this.apiScriptPath)) {
      throw new Error(`Python API script not found at: ${this.apiScriptPath}`);
    }
    if (config.pythonPath) {
      this.validatePythonPath(this.pythonPath);
    }

    if (this.pythonPath) this.log.info(`Using Python: ${this.pythonPath}`);
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
    this._pendingCommands = new Map();
    this._restartAttempt = 0;
    this._autoRequestedAt = 0;
    this._powerOffRequestedAt = 0;
    this._powerOffGeneration = 0;
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

  /** Returns a usable Python path, or null (after logging how to fix it). */
  findPython(pluginDir) {
    const { found, rejected } = findPython(pluginDir);
    if (found) {
      this.log.debug(`Found Python ${found.version}: ${found.path}`);
      return found.path;
    }
    const tooOld = rejected.some((r) => r.reason === 'too-old');
    const why = rejected.length ? ` Checked: ${rejected.map(describeRejection).join('; ')}.` : '';
    const fix = tooOld
      ? `Install Python ${PYTHON_MIN_VERSION}+ alongside it and set "pythonPath" to it in the plugin settings`
      : `Install it (${pythonInstallHint()}) and restart Homebridge, or set "pythonPath" in the plugin settings`;
    this.log.error(
      `No usable Python ${PYTHON_MIN_VERSION}+ was found, so Philips devices cannot connect.${why} ${fix}. ` +
      'The Environment check in the plugin settings shows what was found.'
    );
    return null;
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
    const syntaxError = pythonPathError(pythonPath);
    if (syntaxError) throw new Error(syntaxError);
    const result = inspectPython(pythonPath, __dirname);
    if (!result.ok) {
      throw new Error(`pythonPath is not usable: ${describeRejection({ path: pythonPath, ...result })}`);
    }
  }

  async startDaemon() {
    if (this._destroyed) return;
    if (!this.pythonPath) {
      // Already logged with the fix. Retrying can't help until Python is
      // installed, so stay unresponsive instead of looping on restarts.
      this.deviceReachable = false;
      return;
    }
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
        pycachePrefix: pycachePrefix(this.api),
      });
      if (this._destroyed) {
        this.daemon.stop();
        return;
      }
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
    if (this._destroyed || this._restartTimer) return;
    const delay = RESTART_DELAYS[Math.min(this._restartAttempt, RESTART_DELAYS.length - 1)];
    this._restartAttempt++;
    this.log.info(`Restarting daemon in ${delay / 1000}s (attempt ${this._restartAttempt})...`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.startDaemon();
    }, delay);
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
      .setCharacteristic(Characteristic.SerialNumber, (this.protocol === 'airplus-cloud' && this.airplusDeviceUuid) || this.host);

    // Main Air Purifier Service
    this.purifierService =
      this.platformAcc.getService(Service.AirPurifier) ||
      this.platformAcc.addService(Service.AirPurifier, this.name);

    this.purifierService.getCharacteristic(Characteristic.Active)
      .onGet(() => this.readWhenReachable(() => this.state.power ? 1 : 0))
      .onSet(async (value) => {
        const on = value === 1;
        this.log.info(`[SET] Power: ${on ? 'ON' : 'OFF'}`);
        await this.executeCommand('power', [on ? 'on' : 'off'], { power: on });
        this.updatePurifierCharacteristics();
      });

    this.purifierService.getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() => this.readWhenReachable(() => this.state.power
        ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
        : Characteristic.CurrentAirPurifierState.INACTIVE));

    // Air Quality Sensor
    this.airQualitySensor =
      this.platformAcc.getService(Service.AirQualitySensor) ||
      this.platformAcc.addService(Service.AirQualitySensor, 'Air Quality');
    this.airQualitySensor.getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.readWhenReachable(() => this.pm25ToAirQuality(this.state.pm25)));
    this.airQualitySensor.getCharacteristic(Characteristic.PM2_5Density)
      .onGet(() => this.readWhenReachable(() => this.state.pm25 || 0));

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
   * light as a plain on/off switch (the panel has no dim level), no child lock, sleep
   * off restores the last non-sleep mode. All other models: original
   * behavior, unchanged.
   */
  setupModelDependentServices() {
    const { Service, Characteristic } = this;
    const ac1715 = this.isAC1715();

    // AC1715 has no child lock. Remove a cached characteristic as well as
    // one exposed before the daemon identified the model on first setup.
    if (ac1715) {
      if (this.purifierService.testCharacteristic(Characteristic.LockPhysicalControls)) {
        this.purifierService.removeCharacteristic(
          this.purifierService.getCharacteristic(Characteristic.LockPhysicalControls)
        );
      }
    } else {
      this.purifierService.getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => this.state.childLock
          ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED)
        .onSet(async (value) => {
          const enabled = value === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
          this.log.info(`[SET] ChildLock: ${enabled ? 'ENABLED' : 'DISABLED'}`);
          await this.executeCommand('childlock', [enabled ? 'on' : 'off'], { childLock: enabled });
        });
    }

    this.purifierService.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(() => this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL)
      .onSet(async (value) => {
        const isAuto = value === Characteristic.TargetAirPurifierState.AUTO;
        const mode = isAuto ? 'auto' : (ac1715 ? this.lastManualMode : 'medium');
        this.log.info(`[SET] TargetState: ${isAuto ? 'AUTO' : 'MANUAL'}`);
        if (this.suppressModeForPowerOff('TargetState')) return;
        const powerOffGeneration = this._powerOffGeneration || 0;
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
        if (powerOffGeneration !== (this._powerOffGeneration || 0)) return;
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
        const powerOffGeneration = this._powerOffGeneration || 0;
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
          if (powerOffGeneration !== (this._powerOffGeneration || 0)) return;
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
          if (Number(value) !== 0 && this.suppressModeForPowerOff('RotationSpeed')) return;
          if (this.suppressSpeedForAuto(value)) return;
          // Debounce: the Home app streams writes while the slider is
          // dragged. Only act on the value it settles at.
          this._pendingFanSpeed = Number(value);
          if (this._fanSpeedTimer) clearTimeout(this._fanSpeedTimer);
          this._fanSpeedTimer = setTimeout(() => {
            this._fanSpeedTimer = null;
            if (this._pendingFanSpeed !== 0 && this.suppressModeForPowerOff('RotationSpeed')) return;
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
          if (Number(value) !== 0 && this.suppressModeForPowerOff('RotationSpeed')) return;
          if (this.suppressSpeedForAuto(value)) return;
          this.log.info(`[SET] RotationSpeed: ${value}%`);
          if (value === 0) {
            await this.executeCommand('power', ['off'], { power: false });
          } else {
            const powerOffGeneration = this._powerOffGeneration || 0;
            if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
            if (powerOffGeneration !== (this._powerOffGeneration || 0)) return;
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
        .onGet(() => this.state.power && this.state.lightLevel > 0)
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

  /**
   * Serve a cached value only while the device is reachable; otherwise
   * make HomeKit show "No Response" rather than stale state. Applied to
   * the tile-level characteristics the Home app uses for status.
   */
  readWhenReachable(read) {
    if (!this.deviceReachable) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return read();
  }

  get commandLock() {
    return this._commandCount > 0;
  }

  /**
   * True when a RotationSpeed write should be dropped because an AUTO
   * TargetState write arrived moments ago from the same scene/automation
   * batch. A manual slider write immediately after choosing Auto is also
   * suppressed by this time window. A 0% write (power off) is always honored.
   */
  suppressSpeedForAuto(value) {
    if (Number(value) === 0) return false;
    if (!this._autoRequestedAt || Date.now() - this._autoRequestedAt > AUTO_SCENE_WINDOW_MS) return false;
    this.log.info(`[SET] RotationSpeed: ${value}% ignored (AUTO requested by the same scene)`);
    this.updatePurifierCharacteristics();
    return true;
  }

  // HomeKit can replay a saved mode and speed just after Active=OFF.
  // Those writes describe the scene's old running state, so keep OFF as
  // the intent for this short batch. A later explicit Active=ON clears it.
  suppressModeForPowerOff(source) {
    if (!this._powerOffRequestedAt || Date.now() - this._powerOffRequestedAt > POWER_OFF_SCENE_WINDOW_MS) return false;
    this.log.info(`[SET] ${source} ignored (power OFF requested by the same scene)`);
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
    if (cmd === 'power') {
      if (args[0] === 'off') {
        this._powerOffRequestedAt = Date.now();
        this._powerOffGeneration = (this._powerOffGeneration || 0) + 1;
        if (this._fanSpeedTimer) {
          clearTimeout(this._fanSpeedTimer);
          this._fanSpeedTimer = null;
        }
      } else {
        this._powerOffRequestedAt = 0;
      }
    }
    if (cmd === 'power') this._pendingCommands.delete('mode');
    if (cmd !== 'mode' && cmd !== 'childlock') {
      return this.sendCommand(cmd, args, optimisticState);
    }

    const pending = this._pendingCommands.get(cmd);
    if (pending?.value === args[0]) {
      this.log.debug(`Command ${cmd} ${args[0]} already pending; sharing result`);
      return pending.promise;
    }
    // Keep mode requests pending through both the power-on delay and the
    // daemon write. Scene TargetState and RotationSpeed can request the same
    // mode before either has updated the optimistic state.
    const command = { value: args[0] };
    const send = async () => {
      if (cmd === 'childlock' && this.isAC1715()) {
        this.log.debug('Command childlock skipped (unsupported on AC1715)');
        return;
      }
      if (cmd === 'childlock' && this.state.childLock === (args[0] === 'on')) {
        this.log.debug(`Command childlock ${args[0]} skipped (no change)`);
        return;
      }
      const priorChildLock = this.state.childLock;
      try {
        await this.sendCommand(cmd, args, optimisticState);
      } catch (error) {
        if (cmd === 'childlock') this.state.childLock = priorChildLock;
        throw error;
      }
    };
    // Queue opposite lock writes in request order. Check for an unchanged
    // value only after earlier writes (including failure rollback) finish.
    const result = cmd === 'childlock' && pending
      ? pending.promise.catch(() => {}).then(send)
      : send();
    command.promise = result.finally(() => {
      if (this._pendingCommands.get(cmd) === command) this._pendingCommands.delete(cmd);
    });
    this._pendingCommands.set(cmd, command);
    return command.promise;
  }

  async sendCommand(cmd, args, optimisticState = {}) {
    // Lock before waiting so an observe update during the settle delay
    // cannot clear the power-on retry before we record the requested mode.
    this._commandCount++;
    const powerOffGeneration = this._powerOffGeneration || 0;
    // A mode sent right after a power-on reaches a device that is still
    // waking up (power-on and mode travel on different Air+ channels).
    // Wait out POWER_ON_SETTLE_MS from the power-on before sending it.
    // A power ON report received before this command avoids the hold.
    if (cmd === 'mode' && this._powerOnSentAt) {
      const wait = POWER_ON_SETTLE_MS - (Date.now() - this._powerOnSentAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (cmd === 'mode' && powerOffGeneration !== (this._powerOffGeneration || 0)) {
      this.log.debug(`Command mode ${args[0]} cancelled after power OFF`);
      setTimeout(() => { this._commandCount = Math.max(0, this._commandCount - 1); }, 500);
      return;
    }
    // Remember what the optimistic write replaces so a failed command can
    // be undone; otherwise HomeKit keeps showing a state the device never
    // reached (CoAP only pushes on change, so it may never be corrected).
    const priorState = {};
    for (const key of Object.keys(optimisticState)) priorState[key] = this.state[key];
    const priorPowerOnSentAt = this._powerOnSentAt;
    const priorModeAfterPowerOn = this._modeAfterPowerOn;
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
      if (cmd === 'power') this.updateLightCharacteristics();
    } catch (error) {
      this.log.error(`Command ${cmd} failed: ${error.message}`);
      Object.assign(this.state, priorState);
      this._powerOnSentAt = priorPowerOnSentAt;
      this._modeAfterPowerOn = priorModeAfterPowerOn;
      this.updatePurifierCharacteristics();
      this.updateLightCharacteristics();
      this.updateSleepCharacteristics();
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
    if (!this.isAC1715()) {
      this.purifierService.updateCharacteristic(
        Characteristic.LockPhysicalControls,
        this.state.childLock
          ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED
      );
    }
  }

  updateLightCharacteristics() {
    const { Characteristic } = this;
    // The device can report its remembered light level while powered off.
    const on = this.state.lightLevel > 0 && (!this.isAC1715() || this.state.power);
    this.lightService.updateCharacteristic(Characteristic.On, on);
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
    this._destroyed = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._fanSpeedTimer) {
      clearTimeout(this._fanSpeedTimer);
      this._fanSpeedTimer = null;
    }
    this.daemon.stop();
  }
}

module.exports._DaemonHandler = DaemonHandler;
module.exports._PhilipsAirPurifierAccessory = PhilipsAirPurifierAccessory;
module.exports._defaultAirplusTokenFile = defaultAirplusTokenFile;
module.exports._pycachePrefix = pycachePrefix;
