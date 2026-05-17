# Changelog

All notable changes to this project are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

Changes made in [MaddogWarner/homebridge-philips-air-purifier](https://github.com/MaddogWarner/homebridge-philips-air-purifier) before this combined release are not repeated here. That repo's history serves as the prior changelog.
