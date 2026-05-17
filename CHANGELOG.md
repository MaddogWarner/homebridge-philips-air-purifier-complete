# Changelog

All notable changes to this project are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.1] — 2026-05-18

### Breaking Changes

- Raised the supported Node.js runtime to Node.js 24 or newer.
- Raised the supported Python runtime to Python 3.12 or newer.

### Changes

- Updated the installer to find Python 3.12+, create/recreate the plugin virtual environment with that runtime, and verify the runtime before reporting success.
- Added a `preinstall` check that fails npm install early when Node.js 24+ or Python 3.12+ is not available.
- Replaced the old `aiocoap==0.4.1` pin with `aiocoap>=0.4.17,<0.5` and added an explicit `pycryptodomex>=3.23,<4` range for Python 3.12 compatibility.
- Replaced shell-based Python dependency probing in `index.js` with `execFileSync()` argument-based execution, improving compatibility with paths containing spaces and reducing shell injection risk.
- Added Python runtime validation for user-supplied `pythonPath` values.
- Updated development lint tooling to ESLint 9 flat config for modern Node.js compatibility.
- Updated README requirements, compatibility notes, CLI examples, and Homebridge UI schema text for Node.js 24 and Python 3.12+.
- Added OpenAI Codex as a contributor.

---

## [1.0.1] — 2026-05-17

### Changes

- Added plugin icon (`icon.png`) — displays in the Homebridge UI plugin settings panel and on the npm package page
- Excluded source icon file from npm package to reduce published package size

---

## [1.0.0] — 2026-05-17

Initial release of `homebridge-philips-air-purifier-complete`.

### Highlights

- **Bundled aioairctrl** — The [betaboon/aioairctrl](https://github.com/betaboon/aioairctrl) CoAP library is included in the plugin package. Users no longer need to separately `pip install aioairctrl`.
- **Automated Python environment setup** — An npm `postinstall` hook creates a virtual environment and installs `aiocoap` and `pycryptodomex` automatically on `npm install` or Homebridge UI install.
- **Simplified configuration** — Only `name` and `host` are required. `pythonPath` and `apiScriptPath` are retained as optional advanced overrides.

### Features (from prior forks)

- Power on/off, Auto/Manual/Sleep/Medium/Turbo fan modes
- Sleep Mode as a dedicated HomeKit switch (sets Sleep mode, dims display)
- Real-time PM2.5 air quality sensor with AQI rating
- Display light control (Off / Dim / Bright)
- Child lock
- HEPA filter and pre-filter life percentage with change alerts
- CoAP Observe push updates — no polling
- Daemon auto-restart with exponential backoff (5s → 10s → 30s → 60s)
- Homebridge 2.0+ and Node.js 18+ compatible

### Bug Fixes (in bundled aioairctrl)

- **`encryption.py`** — Added minimum-length validation in `decrypt()` to prevent silent corruption on short payloads
- **`encryption.py`** — `DigestMismatchException` now includes key and digest values in its message for easier debugging
- **`client.py`** — Fixed return type annotation: `set_control_value` and `set_control_values` annotated as `-> bool` (were incorrectly `-> None`)
- **`client.py`** — `_sync()` now raises `ValueError` on empty client key response instead of silently proceeding
- **`cli.py`** — Fixed `e.split("=")` → `e.split("=", 1)` in the `set` command to correctly handle values containing `=` characters

### Bug Fixes (in philips_air_api.py)

- Fixed `status, _ = await self._client.get_status()` — `get_status()` returns a single `dict`, not a tuple. The incorrect unpacking would raise `ValueError` in CLI mode. Fixed to `status = await self._client.get_status()`.

---

## Prior History

Changes made in [MadDogWarner/homebridge-philips-air-purifier](https://github.com/MadDogWarner/homebridge-philips-air-purifier) before this combined release are not repeated here. That repo's history serves as the prior changelog.
