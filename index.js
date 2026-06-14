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

// Restart backoff delays in ms
const RESTART_DELAYS = [5000, 10000, 30000, 60000];
const PYTHON_MIN_VERSION = '3.12';
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
  api.registerAccessory('PhilipsAirPurifier', PhilipsAirPurifierAccessory);
};

/**
 * Daemon communication handler.
 *
 * The daemon uses CoAP Observe or HTTP polling to receive updates from the device.
 * State reads use cached data, commands are sent directly.
 */
class DaemonHandler {
  constructor(log, onUpdate, onExit) {
    this.log = log;
    this.onUpdate = onUpdate;
    this.onExit = onExit;
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

  handleMessage(line) {
    try {
      const message = JSON.parse(line);
      switch (message.type) {
        case 'update':
          this.observing = true;
          this.log.debug(`Observe update: pm25=${message.data?.pm25}`);
          if (this.onUpdate) this.onUpdate(message.data);
          break;

        case 'log':
          this.log.debug(`Daemon [${message.event}]: ${message.message}`);
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
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
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
    this._commandCount = 0;
    this._restartAttempt = 0;

    this.daemon = new DaemonHandler(
      log,
      this.handleObserveUpdate.bind(this),
      this.handleDaemonExit.bind(this)
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
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3.13',
      '/usr/bin/python3.12',
      '/usr/bin/python3.13',
      '/volume1/@appstore/Python3.12/usr/local/bin/python3.12',
      '/volume1/@appstore/py3k/usr/local/bin/python3',
      'python3.13',
      'python3.12',
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
    } catch (_error) {
      throw new Error(`pythonPath must point to Python ${PYTHON_MIN_VERSION}+ with aiocoap and pycryptodomex installed: "${pythonPath}"`);
    }
  }

  async startDaemon() {
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
    this.state.mode = this.normalizeMode(sensors.mode);
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

    this.updatePurifierCharacteristics();
    this.updateLightCharacteristics();
    this.updateAirQualityCharacteristics();
    this.updateFilterCharacteristics();
    this.updateSleepCharacteristics();
  }

  setupServices() {
    const { Service, Characteristic } = this;

    // Accessory Information
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(Characteristic.Model, 'Air Purifier')
      .setCharacteristic(Characteristic.SerialNumber, this.host);

    // Main Air Purifier Service
    this.purifierService = new Service.AirPurifier(this.name);

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

    this.purifierService.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(() => this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL)
      .onSet(async (value) => {
        const isAuto = value === Characteristic.TargetAirPurifierState.AUTO;
        const mode = isAuto ? 'auto' : 'medium';
        this.log.info(`[SET] TargetState: ${isAuto ? 'AUTO' : 'MANUAL'}`);
        if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
        await this.executeCommand('mode', [mode], { mode });
        this.updatePurifierCharacteristics();
      });

    this.purifierService.addCharacteristic(Characteristic.RotationSpeed)
      .onGet(() => MODE_TO_SPEED[this.state.mode] ?? 100)
      .onSet(async (value) => {
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

    // Child Lock (LockPhysicalControls)
    this.purifierService.addCharacteristic(Characteristic.LockPhysicalControls)
      .onGet(() => this.state.childLock
        ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED)
      .onSet(async (value) => {
        const enabled = value === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
        this.log.info(`[SET] ChildLock: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        await this.executeCommand('childlock', [enabled ? 'on' : 'off'], { childLock: enabled });
      });

    // Air Quality Sensor
    this.airQualitySensor = new Service.AirQualitySensor('Air Quality');
    this.airQualitySensor.getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.pm25ToAirQuality(this.state.pm25));
    this.airQualitySensor.addCharacteristic(Characteristic.PM2_5Density)
      .onGet(() => this.state.pm25 || 0);

    // HEPA Filter Maintenance
    this.hepaFilterService = new Service.FilterMaintenance('HEPA Filter', 'hepa-filter');
    this.hepaFilterService.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => Math.round(this.state.filterLifePercent));
    this.hepaFilterService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.state.filterLifePercent < 10
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK);

    // Pre-Filter Maintenance
    this.preFilterService = new Service.FilterMaintenance('Pre-Filter', 'pre-filter');
    this.preFilterService.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => Math.round(this.state.cleanupPercent));
    this.preFilterService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.state.cleanupPercent < 10
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK);

    // Display Light
    this.lightService = new Service.Lightbulb('Display Light');
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
    this.lightService.addCharacteristic(Characteristic.Brightness)
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

    // Sleep Mode Switch
    // HomeKit's AirPurifier only has Auto/Manual — Sleep is exposed as a dedicated switch.
    this.sleepService = new Service.Switch('Sleep Mode', 'sleep-mode');
    this.sleepService.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.mode === 'sleep' && this.state.power)
      .onSet(async (value) => {
        this.log.info(`[SET] Sleep Mode: ${value ? 'ON' : 'OFF'}`);
        if (value) {
          if (!this.state.power) await this.executeCommand('power', ['on'], { power: true });
          await this.executeCommand('mode', ['sleep'], { mode: 'sleep' });
          if (this.state.lightLevel > 0) this.lastLightLevel = this.state.lightLevel;
          await this.executeCommand('light', ['0'], { lightLevel: LIGHT.OFF });
          this.updateLightCharacteristics();
        } else {
          await this.executeCommand('mode', ['auto'], { mode: 'auto' });
        }
        this.updatePurifierCharacteristics();
        this.updateSleepCharacteristics();
      });

    // Link secondary services to primary
    this.purifierService.addLinkedService(this.airQualitySensor);
    this.purifierService.addLinkedService(this.hepaFilterService);
    this.purifierService.addLinkedService(this.preFilterService);
    this.purifierService.addLinkedService(this.lightService);
    this.purifierService.addLinkedService(this.sleepService);
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

  async executeCommand(cmd, args, optimisticState = {}) {
    this._commandCount++;
    Object.assign(this.state, optimisticState);
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
    this.purifierService.updateCharacteristic(Characteristic.RotationSpeed, MODE_TO_SPEED[this.state.mode] ?? 100);
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

  getServices() {
    return [
      this.informationService,
      this.purifierService,
      this.airQualitySensor,
      this.hepaFilterService,
      this.preFilterService,
      this.lightService,
      this.sleepService,
    ];
  }
}
