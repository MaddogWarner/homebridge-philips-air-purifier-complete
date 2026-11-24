# v5.0.0 plan — zero-touch install, Homebridge Verified, no feature loss

Status: implemented on `feat/v5-easy-install` (24/11/2026), not yet released. Approved with the
recommended defaults (remove legacy accessory mode; pure-Python AES).

Deviations from this plan:
- AES is original code in `aioairctrl/aes.py`, not bundled `pyaes`. This avoided pulling in an
  unmaintained package. It's pinned by FIPS-197 and SP 800-38A vectors plus vectors recorded
  from pycryptodomex (`tests/test_aes.py`).
- Homebridge 2.0.2 behaviour checked in source (`server.js` loadAccessories): an unregistered
  `accessories` entry logs an error and Homebridge continues. Not fatal.
- Phase 1.2: the `sys.path` edit lives once in `aioairctrl/__init__.py`, not in each script.
- Phase 1.5: `--check` rebuilds `vendor/` from hash-pinned wheels and compares every file
  (added after review), rather than only comparing versions.
- Phase 3.2: the custom UI does **not** detect old `accessories` entries. Homebridge itself logs
  the leftover entry, and the README and CHANGELOG explain the fix.
- Added after an independent review: CoAP transports pinned to the v4 set, bytecode cache moved
  to the storage dir, `homebridge` moved to devDependencies, schema-level `required`, `homepage`,
  rejection reasons in logs and the UI, an aggregate `build` CI job for branch protection, and a
  daemon smoke test from the packed tarball on Linux and macOS.
- Still open: confirming the Python version on the Homebridge Docker and Raspberry Pi images
  (Docker unavailable locally), Python 3.11 runs (CI only), and live-device parity checks.

## Goal

A user installs the plugin from the Homebridge UI, enters an IP address (or runs the
Air+ wizard), and it works. No pip, no venv, no SSH, no install scripts. Every existing
feature, protocol and config key keeps working.

## Findings that drive the plan

| Finding | Evidence | Consequence |
|---|---|---|
| Install-time scripts break the Verified rule "no post-install scripts that modify the user's system" | `package.json` `preinstall`/`postinstall` → `postinstall.sh` builds `.venv` + pip installs | Remove both scripts |
| Only one Python dependency is native code | `aiocoap` 0.4.17 (pure Python, no deps, Python ≥3.10), `paho-mqtt` 2.1.0 (pure Python, no deps, Python ≥3.7), `pycryptodomex` (native, 12 MB) | Bundle the two pure-Python packages; replace pycryptodomex |
| pycryptodomex is only used for AES-CBC + PKCS7 | `aioairctrl/coap/encryption.py:3-4`, `philips_air_api.py:33-34` | A pure-Python AES is enough (implemented in `aioairctrl/aes.py`); payloads are ~1 KB so speed doesn't matter |
| SHA256, DH, HTTPS, JSON already use the standard library | `hashlib`, `pow()`, `ssl`, `urllib` | No other dependencies needed |
| Air+ login UI is pure Node | `homebridge-ui/server.js` makes no Python calls | Unaffected |
| `engines.node` is `>=24` | `package.json` | Verified needs Node 22, 24, 26. No Node-24-only APIs found in `index.js` / `server.js` |
| A legacy accessory is registered alongside the platform | `index.js:108` | Verified requires a dynamic platform only |
| Secrets/tokens already go to the storage dir | `defaultAirplusTokenFile()`, `server.js` token write | Already compliant; the `~/.homebridge` fallback only reads an existing token |
| Missing Python → `findPython` returns `'python3'` and the daemon retries every 5–60 s | `index.js:648-650`, `RESTART_DELAYS` | Logs repeat errors forever; replace with one clear message and no retry loop |
| Three Philips air plugins are already verified | `homebridge/plugins` `verified-plugins.json`: `@atdr/homebridge-philipsair-platform` (CoAP only, needs user-installed Python), `homebridge-philips-airplus-cloud`, `homebridge-philips-air` | Submission must lead with HTTP (DH/AES) + HomeID + all protocols in one plugin |

## Phase 0 — Safety net before touching anything

1. **Feature parity checklist** (the "no loss" contract), each item mapped to a test or a live check:
   - Protocols: `coap`, `http`, `homeid-http` (incl. `useHttps`), `airplus-cloud`
   - Commands: power, mode, light, childlock, sensors, status, ping
   - HomeKit: AirPurifier (auto/manual, speed→mode), Sleep switch, AirQualitySensor (PM2.5/AQI),
     Lightbulb (3 levels), Child Lock switch, HEPA + pre-filter FilterMaintenance,
     model-dependent services (AC0650/AC1715 differences)
   - Config keys: `name`, `devices[]`, `additionalDevicesJson`, `protocol`, `host`, `useHttps`,
     `clientId`, `clientSecret`, `encryptionKey`, `airplusDeviceUuid`, `airplusTokenFile`,
     `pythonPath`, `apiScriptPath`
   - Behaviour: CoAP Observe push, 10 s HTTP polling, optimistic state + 500 ms command lock,
     reconnect backoff, power-on mode re-apply, Air+ token refresh/reconnect
   - Tools: `philips_air_api.py` CLI, `scripts/airplus_setup.py`, `scripts/probe_devices.py`
2. **Golden crypto vectors**: generate AES-CBC encrypt/decrypt fixtures with pycryptodomex for the
   CoAP path (`encryption.py`), HTTP DH/AES and HomeID AES, and commit them as test fixtures.
3. Record the existing test suite passing on the current code as the baseline.

## Phase 1 — Remove all install-time work

1. Delete `preinstall.sh`, `postinstall.sh` and their `package.json` scripts.
2. Bundle `aiocoap==0.4.17` and `paho-mqtt==2.1.0` under `vendor/`, prepended to `sys.path`
   at the top of `philips_air_api.py` and the two scripts. Keep `aiocoap_monkeypatch.py`
   unchanged — the pin is now enforced by the bundled copy.
3. Replace `Cryptodome` imports with a pure-Python AES-CBC + PKCS7 module (originally planned as
   bundled `pyaes`; see Deviations). It must pass the Phase 0 vectors byte for byte.
4. `PYTHON_RUNTIME_CHECK` → version check plus importing the bundled modules.
5. `requirements.txt` stays as the manifest of bundled versions (pip-audit + Dependabot keep
   alerting). Add `scripts/vendor.py` to refresh `vendor/` from it with hash checks, and a CI
   step that fails if `vendor/` and `requirements.txt` disagree.
6. Add `THIRD_PARTY_NOTICES.md` (aiocoap MIT/BSD-3, paho-mqtt EDL-1.0 option)
   and add `vendor/` to `package.json` `files`.

## Phase 2 — Make the remaining setup self-service

The only remaining prerequisite is Python ≥3.11 itself.

1. `findPython`: drop the `.venv`/`venv` candidates; keep the env vars and system paths.
2. When no usable Python is found: log one error with the platform-specific fix
   (`brew install python` on macOS, `apt install python3` on Debian), mark accessories
   unresponsive, and **don't** start the restart loop. Re-check on the next Homebridge restart.
3. Custom UI **Environment check** panel. A new `server.js` endpoint runs the fixed runtime
   check (`execFile`, no user-supplied args except a validated `pythonPath`) and shows:
   Python found/version, bundled imports OK, and the exact fix for the detected OS.
4. README: rewrite Prerequisites/Installation — "Python 3.11+ (already included on the
   Homebridge Raspberry Pi and Docker images)". Confirm that claim in Phase 4 first.

## Phase 3 — Verified compliance

1. `engines.node`: `^22 || ^24 || ^26`; README updated.
2. Remove `registerAccessory` and the `Legacy*` classes (`index.js:1449-1510`). Migration:
   CHANGELOG + README section; the custom UI detects old `accessories` entries and shows how to
   move them. **To verify:** how Homebridge 2.x behaves when an `accessories` block names an
   unregistered accessory (log only, or refuse to start).
3. Audit for unhandled promise rejections and thrown errors in event handlers.
4. Add a README section comparing against the three verified Philips plugins.
5. Major version bump to **5.0.0** (removes accessory mode, raises nothing else).

## Phase 4 — Prove it

1. CI matrix: Node 22/24/26 × Python 3.11/3.14. Tests run with **no** `pip install` of
   runtime deps, which proves the bundled path works on its own.
2. Packaging test: `npm pack`, then install the tarball into a clean `homebridge/homebridge`
   Docker container and a Debian container. Confirm the plugin loads and the daemon starts
   with no manual steps. Record each image's Python version.
3. Live devices: run the parity checklist on each protocol you have hardware for.
4. Release v5.0.0 via the normal process, then open the Verified issue on `homebridge/plugins`.

## Success criteria

- [ ] `npm install` runs no lifecycle scripts; the package installs on Linux, macOS and Windows
- [ ] Fresh Homebridge Docker/RPi image: install from the UI, add an IP, and it works with no shell access
- [ ] All existing Python and JS tests pass, plus the new crypto vector tests
- [ ] Every item in the Phase 0 parity checklist is ticked (test or live check)
- [ ] Missing Python produces one actionable log line and a UI diagnosis, with no retry spam
- [ ] CI green on Node 22, 24, 26
- [ ] Nothing written at runtime outside the Homebridge storage directory (including `__pycache__`)

## Decisions needed

1. **Legacy accessory mode:** remove in v5 (recommended, required for Verified) or keep it one more release.
2. **AES implementation:** bundled pure-Python `pyaes` (recommended: simple, portable) or
   `ctypes` into OpenSSL (fast, but finding the library path differs by platform).
3. **Live test coverage:** which protocols do you have working hardware for? HomeID has no
   live device today (`issues.md`), so its parity can only be proven by unit tests.

## Risks

- The AES module is original code. Mitigation: FIPS-197 and SP 800-38A vectors, recorded v4.3.0
  vectors for every protocol path, and a 3,000-case differential test against pycryptodomex
  during review. The CoAP key is a published protocol constant, so timing side
  channels don't add risk.
- Bundled code isn't auto-updated. Mitigation: `requirements.txt` + pip-audit + CI consistency check.
- macOS users still need `brew install python` (system Python is 3.9). Only a full
  TypeScript port removes that step.
- Verification may still be refused on the duplicate-functionality rule. That's a reviewer judgement.
