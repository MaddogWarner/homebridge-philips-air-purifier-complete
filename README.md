# homebridge-philips-air-purifier-complete

<p align="center">
  <img src="https://raw.githubusercontent.com/MadDogWarner/homebridge-philips-air-purifier-complete/main/icon.png" width="200" alt="Philips Air Purifier">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-philips-air-purifier-complete"><img src="https://img.shields.io/npm/v/homebridge-philips-air-purifier-complete" alt="npm"></a>
  <a href="https://homebridge.io"><img src="https://img.shields.io/badge/homebridge-%3E%3D2.0.0-blue" alt="Homebridge"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

Control your Philips Air Purifier from Apple HomeKit via Homebridge — **with no separate Python package install required**.

This plugin bundles the [aioairctrl](https://github.com/betaboon/aioairctrl) CoAP library directly. Installing the plugin is all you need; the Python environment is set up automatically for Python 3.12 or newer.

---

## Features

- **Power On/Off** — Turn your air purifier on or off
- **4 Fan Modes** — Auto, Sleep, Medium, Turbo (via rotation speed slider)
- **Sleep Mode Switch** — Dedicated HomeKit switch that sets Sleep mode and dims the display
- **Air Quality Sensor** — Real-time PM2.5 readings with derived AQI rating
- **Display Light Control** — Toggle and 3-level brightness (Off / Dim / Bright)
- **Child Lock** — Lock or unlock physical controls on the device
- **HEPA Filter Status** — Filter life percentage and change alert
- **Pre-Filter Status** — Cleanup cycle percentage and change alert
- **Real-time Updates** — CoAP Observe push updates from the device (~every 30s or on change)
- **Auto-reconnect** — Daemon restarts automatically with exponential backoff if the device drops off

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| [Homebridge](https://homebridge.io) | >= 2.0.0 |
| Node.js | >= 24.0.0 |
| Python 3 | >= 3.12 |
| Your Philips Air Purifier's **IP address** | — |

Python 3.12 or newer must be installed on the system running Homebridge. On most platforms:

```bash
# macOS
brew install python@3.12

# Raspberry Pi / Ubuntu / Debian
sudo apt install python3.12 python3.12-venv
```

The install hook creates a plugin-local virtual environment and installs:

| Python package | Supported range |
|----------------|-----------------|
| `aiocoap` | `>=0.4.17,<0.5` |
| `pycryptodomex` | `>=3.23,<4` |

---

## Installation

### Via Homebridge UI (recommended)

1. Open the Homebridge UI
2. Go to **Plugins**
3. Search for `homebridge-philips-air-purifier-complete`
4. Click **Install**

The plugin automatically sets up a Python virtual environment and installs its CoAP dependencies during install. No extra steps needed.

The npm `preinstall` check fails early if Node.js 24+ or Python 3.12+ is not available on the host.

### Via npm

```bash
npm install -g homebridge-philips-air-purifier-complete
```

If the automatic setup fails (e.g., Python 3.12+ wasn't installed yet), re-run it manually:

```bash
bash $(npm root -g)/homebridge-philips-air-purifier-complete/postinstall.sh
```

---

## Configuration

Add to your Homebridge `config.json` under `"accessories"`:

```json
{
  "accessories": [
    {
      "accessory": "PhilipsAirPurifier",
      "name": "Living Room Air Purifier",
      "host": "192.168.1.100"
    }
  ]
}
```

Or configure via the Homebridge UI — just fill in the **Name** and **IP Address** fields.

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `name` | Yes | — | Name shown in HomeKit |
| `host` | Yes | — | IPv4 address of your air purifier |
| `pythonPath` | No | Auto-detected | Path to Python 3.12 or newer with `aiocoap` and `pycryptodomex` installed. Leave blank to use the plugin's bundled virtual environment. |

---

## Connectivity Check (optional)

Before configuring Homebridge, you can verify the plugin can reach your device:

```bash
# Activate the plugin's virtual environment
source $(npm root -g)/homebridge-philips-air-purifier-complete/.venv/bin/activate

# Run a sensor query
python $(npm root -g)/homebridge-philips-air-purifier-complete/philips_air_api.py 192.168.1.100 sensors
```

You should see a JSON payload with PM2.5, filter life, temperature, and so on. CoAP can be flaky on the first connection — re-run if you get a timeout.

---

## HomeKit Tiles

Once configured, your air purifier appears in the Apple Home app with:

| Tile | What It Controls |
|------|-----------------|
| Air Purifier | Power, Auto/Manual mode, fan speed (Sleep / Medium / Turbo) |
| Sleep Mode | Switch that activates Sleep mode and dims the display |
| Air Quality | PM2.5 density and derived AQI rating |
| Display Light | On/off toggle and 3-level brightness |
| Child Lock | Lock/unlock physical controls on the device |
| HEPA Filter | Remaining filter life percentage, change alert below 10% |
| Pre-Filter | Cleanup cycle status, change alert below 10% |

---

## Architecture

```
Homebridge (Node.js)
    │
    │  stdin/stdout JSON
    │
    ▼
philips_air_api.py  ─── aioairctrl/ (bundled) ──► aiocoap ──► Philips device (CoAP)
    │
    │  CoAP Observe (push)
    │  ≈ every 30s or on change
    ▼
State cache ──► HomeKit characteristics
```

- The Python daemon maintains a **CoAP Observe** subscription to the device
- The device pushes state updates; no polling
- Commands (power, mode, light) are sent directly and complete in ~100–300ms
- The Node.js plugin communicates with the daemon over stdin/stdout JSON
- If the daemon exits for any reason, Homebridge restarts it with exponential backoff (5s → 10s → 30s → 60s)

---

## CLI Tool

The bundled Python script can be used standalone for diagnostics:

```bash
python3.12 philips_air_api.py 192.168.1.100 sensors
python3.12 philips_air_api.py 192.168.1.100 status
python3.12 philips_air_api.py 192.168.1.100 power on
python3.12 philips_air_api.py 192.168.1.100 power off
python3.12 philips_air_api.py 192.168.1.100 mode auto
python3.12 philips_air_api.py 192.168.1.100 mode sleep
python3.12 philips_air_api.py 192.168.1.100 mode medium
python3.12 philips_air_api.py 192.168.1.100 mode turbo
python3.12 philips_air_api.py 192.168.1.100 light 0      # off
python3.12 philips_air_api.py 192.168.1.100 light 115    # dim
python3.12 philips_air_api.py 192.168.1.100 light 123    # bright
python3.12 philips_air_api.py 192.168.1.100 childlock on
python3.12 philips_air_api.py 192.168.1.100 childlock off
```

---

## Troubleshooting

**Plugin loads but device is "No Response" in HomeKit**
- Verify the IP address is correct and the device is on the same network
- Run the connectivity check above
- Check Homebridge logs for daemon error messages

**Python setup failed during install**
- Ensure Python 3.12+ and the matching `venv` package are installed, then re-run `bash postinstall.sh`

**Install fails during preinstall**
- Confirm `node --version` reports v24.0.0 or newer
- Confirm `python3.12 --version` or `python3 --version` reports Python 3.12 or newer

**Persistent CoAP timeouts**
- CoAP (UDP) can be blocked by some network configurations; ensure UDP is allowed between Homebridge and the device
- Assign a static IP to the device in your router's DHCP settings

---

## Versioning

This project follows [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits and Attribution

This project is a combined and enhanced fork of two open-source projects:

| Project | Author | Licence |
|---------|--------|---------|
| [louiscrc/homebridge-philips-air-purifier](https://github.com/louiscrc/homebridge-philips-air-purifier) | [louiscrc](https://github.com/louiscrc) | MIT |
| [betaboon/aioairctrl](https://github.com/betaboon/aioairctrl) | [betaboon](https://github.com/betaboon) | MIT |

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the full contributor list.

---

## Support

- **Issues:** [GitHub Issues](https://github.com/MadDogWarner/homebridge-philips-air-purifier-complete/issues)
- **Homebridge community:** [homebridge.io](https://homebridge.io)
