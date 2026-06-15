# Changelog

All notable changes to this project are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.2.2] — 15/06/2026

### Fixed

- Fixed a Homebridge crash loop when restoring cached purifier accessories after the first
  successful v3 platform startup. Optional HomeKit characteristics are now reused instead of
  added again on restored services.
- Corrected package lockfile version metadata after the v3.2.1 release.

---

## [3.2.1] — 15/06/2026

### Fixed

- Replaced the broken native schema form device editor with a fully custom device manager UI.
  Config UI X v5.24.0 does not correctly load existing array item values into either `tabarray`
  or `array` layout types, making the native form unusable for editing saved devices. The new
  custom UI reads and writes the `devices[]` array directly via `homebridge.getPluginConfig()` /
  `updatePluginConfig()`, bypassing the schema form entirely.
- Clicking the "Plugin Config" button now opens the full custom UI (device manager + Air+ OAuth)
  instead of the broken native tabarray form. Requires `"customUi": true` in `config.schema.json`
  for Config UI X v5 to route through the custom UI.
- The "clicking Add Device creates new devices" UX bug is eliminated — the Add Device button is
  now a clearly labelled `+ Add Device` button at the bottom of the Devices panel.
- Each device card shows the correct name, protocol, host, and protocol-specific fields (HomeID
  credentials, Air+ UUID/token) loaded from the saved config.

### Changed

- `config.schema.json` gains `"customUi": true` (needed by Config UI X v5 to route Plugin Config
  clicks through the custom UI iframe, not the native schema form modal).
- `homebridge-ui/public/index.html` rewritten as a full device manager: per-device cards with
  collapsible forms, protocol-aware conditional fields, Add / Remove device support, and the
  existing Air+ OAuth flow.
- `headerDisplay` updated to point users to Plugin Settings for the full experience.
- `eslint.config.js` ignores `test-*.cjs` files (local Playwright test scripts).

---

## [3.2.0] — 15/06/2026

### Added

- Restored native Homebridge GUI device configuration for CoAP, HTTP, HomeID, and Air+ Cloud
  devices using a tabbed `devices[]` form with protocol-specific fields.
- Kept the Air+ OAuth login flow as a lightweight **Login with Air+ (cloud devices)** helper that
  writes the token file and adds the selected device to the native form.

### Changed

- Removed the **Additional Devices JSON** field from the GUI. Existing `additionalDevicesJson`
  configs continue to merge at runtime for v3.1 backwards compatibility.
- Stopped the custom UI from owning normal device add/edit/delete operations; the native schema
  form is now the single source of truth for saved device configuration.

---

## [3.1.1] — 14/06/2026

### Added

- Added an **Additional Devices JSON** fallback field to the normal Plugin Config modal so users can
  add or override purifier entries when Homebridge does not expose the custom Plugin Settings cog.

### Fixed

- Added clear validation errors for malformed **Additional Devices JSON** in the custom UI server.
- Replaced SHA-1 with SHA-256 for deterministic custom UI device row keys.

---

## [3.1.0] — 14/06/2026

### Added

- Replaced the Air+-only custom UI with a full **Plugin Settings** device manager for CoAP,
  HTTP, HomeID, and Air+ devices.
- Added add/edit/delete support for platform `devices[]` without using the broken Homebridge
  auto-generated nested array form.
- Added HomeID-aware settings in the custom UI, including HTTPS, client ID, client secret, and
  encryption key handling. Saved HomeID secrets are preserved without being returned to the
  browser unless replaced or explicitly cleared.
- Kept the Air+ OAuth setup flow inside the new device manager and now updates existing Air+
  devices when the same Air+ UUID is selected again.

### Changed

- Updated the config schema banner and README to direct users to **Plugin Settings** for device
  setup. The **JSON Config** tab remains supported for manual edits and bulk migration.
- Clarified the custom device editor submit button text and blocked Air+ setup while local device
  edits are staged but not saved.
- Documented that deleting an Air+ device from Plugin Settings removes the config entry but leaves
  the Air+ token file on disk for manual cleanup.

---

## [3.0.3] — 14/06/2026

### Fixed

- Removed `devices[]` from the config schema so the Homebridge visual Plugin Config form no
  longer renders an incorrect nested array editor. Devices are configured via the **JSON Config**
  tab; the visual form now only exposes the platform name. The `headerDisplay` banner and README
  are updated to direct users accordingly.

---

## [3.0.2] — 14/06/2026

### Fixed

- Expanded the README migration guide with before/after JSON examples for CoAP, HTTP/HomeID,
  and Air+ cloud configurations.

---

## [3.0.1] — 14/06/2026

### Fixed

- Restored temporary legacy accessory registration so existing `accessories[]` config entries
  continue to load during migration instead of producing `No plugin was found for the accessory`.
- Simplified the platform config schema rendering by removing the custom `devices[]` layout that
  could duplicate and overlap fields in the Homebridge UI.
- Stopped `airplus-cloud` devices without `airplusDeviceUuid` from entering a daemon restart loop.
  The plugin now logs a configuration warning and waits for the Air+ Setup Wizard or manual UUID
  configuration.

---

## [3.0.0] — 14/06/2026

### Breaking Changes

- Changed the plugin type from `accessory` to `platform`. Config migration is required:
  move each `accessories[]` entry into the platform `devices[]` array. See the README
  migration guide.
- HomeKit accessory identity will be lost after migration. Existing purifiers will appear
  as new accessories in the Home app and must be re-added to rooms, scenes, and automations.

### Added

- Platform plugin support so the Air+ Setup Wizard is accessible from the Homebridge UI
  plugin menu via Plugin Settings.
- Stable UUID generation: Air+ cloud devices are keyed on `airplusDeviceUuid`, while
  CoAP/HTTP/HomeID devices are keyed on `host`.
- Automatic stale accessory cleanup when a device is removed from the platform `devices`
  array and Homebridge restarts.
- Clean daemon shutdown for all configured devices when Homebridge shuts down.

---

## [2.4.1] — 14/06/2026

### Fixed

- Added a prominent callout in the per-accessory config form directing Air+ cloud users to the
  Air+ Setup Wizard (Plugin Settings → gear icon). The wizard was already present but not
  discoverable from the accessory configuration form.
- Corrected icon URL capitalisation in `config.schema.json` (MadDogWarner → MaddogWarner).

---

## [2.4.0] — 14/06/2026

### Added

- **Philips Air+ cloud MQTT protocol** (`airplus-cloud`) for devices registered in the
  Philips Air+ app (e.g. AC0650/10, AC1715). Uses OAuth2/PKCE → AWS IoT MQTT over WebSocket.
  State updates push within ~2 seconds via MQTT subscription.
- `scripts/airplus_setup.py` — interactive CLI to complete the OAuth2/PKCE flow, list registered
  devices, and save tokens to `~/.homebridge/philips-airplus-{uuid}.json`.
- `scripts/probe_devices.py` — standalone stdlib-only script that tests all three local protocols
  (CoAP port 5683, HTTP DH/AES, HomeID) against a list of device IPs and prints a pass/fail report.
- New `paho-mqtt>=2.1` Python runtime dependency (installed automatically by `postinstall.sh`).
- New config options `airplusDeviceUuid` and `airplusTokenFile` for `airplus-cloud` accessories.
- Air+ MQTT power field `D0310D` is now normalised to `D03102` in `parse_status()` so the same
  IPC shape is produced for all protocols.
- Homebridge UI wizard for Air+ cloud device setup — no SSH or terminal required. Accessible
  from the plugin's Settings page in the Homebridge web UI.

---

## [2.3.0] — 2026-05-24

### Added

- Added explicit `homeid-http` protocol support for HomeID/Condor local HTTP devices.
  This path supports HTTP or HTTPS, PhilipsCondor 401 challenge authentication, optional
  HomeID AES payload encryption, and merged polling of `status`, `air`, and `fltsts`.
- Added HomeID configuration fields: `useHttps`, `clientId`, `clientSecret`, and
  `encryptionKey`. HomeID secrets are passed to the Python daemon via environment
  variables rather than command-line arguments.
- Added `probe-homeid` CLI diagnostic command to probe HomeID HTTP/HTTPS endpoints
  without changing device state.
- Added focused Python unit tests for CoAP/HTTP/HomeID status normalisation,
  HomeID AES encryption, and PhilipsCondor authentication response generation.

### Fixed

- Restored the normalised `mode_name` field in Python sensor output while keeping
  `mode` compatible with the JavaScript HomeKit mapping.
- Added clearer HTTP diagnostics for endpoint status and decrypt failures without
  logging secrets or encrypted payloads.
- Replaced private `ssl._create_unverified_context()` with `ssl.create_default_context()`
  (`check_hostname=False`, `verify_mode=CERT_NONE`) for HomeID HTTPS devices with
  self-signed certificates.
- Removed duplicated HomeID mode mapping; both HTTP and HomeID control paths now share
  `HTTP_MODE_VALUES`.

---

## [2.2.0] — 2026-05-23

### Added

- HTTP protocol support for Philips AC1xxx-series devices (e.g. AC1715) that do not implement
  CoAP. Set `"protocol": "http"` in your Homebridge accessory configuration to use this mode.
  HTTP devices use 10-second polling instead of CoAP Observe push updates.
- New `protocol` config option (`"coap"` | `"http"`, default `"coap"`). Each accessory
  configures its protocol independently, so mixed households (AC1715 + AC3858) work without
  any shared state.

---

## [2.1.0] — 2026-05-18

### Changes

- Removed dead `mode !== null` predicate from `SPEED_TO_MODE.find()` in the RotationSpeed setter — redundant since the unreachable `{ max: 0, mode: null }` entry was removed in 2.0.3.
- Extended the `PYTHON_MIN_VERSION` single-source-of-truth fix to `preinstall.sh` and `postinstall.sh`: both scripts now derive the Python version tuple from `PYTHON_MIN_VERSION` using bash string operators (`%%.*` / `#*.`), eliminating the separate hardcoded `(3, 12)` tuples in `python_version_ok()` and the postinstall verify step.

---

## [2.0.5] — 2026-05-18

### Changes

- Made `PYTHON_MIN_VERSION` the single source of truth for Node-side Python runtime validation by deriving the embedded Python version tuple from the display string.

---

## [2.0.4] — 2026-05-18

### Changes

- Removed the CoAP Observe option from one-shot status reads in `aioairctrl/coap/client.py` so CLI diagnostics no longer create unused Observe subscriptions.
- Left the dedicated `observe_status()` path unchanged for the Homebridge daemon's real-time CoAP Observe updates.

---

## [2.0.3] — 2026-05-18

### Changes

- Changed `preinstall.sh` to warn about unsupported Node.js or Python versions without blocking npm/Homebridge UI installation.
- Extended Python discovery in `preinstall.sh` for Docker/NAS deployments: checks `PHILIPS_AIR_PYTHON`, npm's `--python` setting (`npm_config_python`), common absolute paths (`/opt/homebrew`, `/usr/local`, `/usr/bin`), and Synology-style paths.
- Added `PHILIPS_AIR_SKIP_PYTHON_PREINSTALL=1` environment variable to bypass the Python preinstall check in managed environments where `pythonPath` is configured after installation.
- Fixed listener leak in `DaemonHandler.start()`: `readyHandler` is now removed from the readline interface when the 20-second startup timeout fires.
- Removed unreachable `{ max: 0, mode: null }` entry from `SPEED_TO_MODE` in `index.js`.
- Updated README troubleshooting to explain expected preinstall warnings and how to provide an explicit Python path when npm has a restricted `PATH`.

---

## [2.0.2] — 2026-05-18

### Changes

- Excluded `.claude/` directory from npm package (contained only local tooling config, no secrets).

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
