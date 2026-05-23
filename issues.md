# Known Issues

## HomeID childlock field type

**Affects:** `homeid-http` protocol only  
**Status:** Unverified — needs a live HomeID device to test

`HomeIDHTTPPollingDaemon._execute_command` sends `{"cl": True/False}` (Python boolean) for child lock commands. The DH/AES HTTP path sends `{"cl": "1"/"0"}` (strings). It is unknown which representation HomeID firmware expects. If child lock commands have no effect on a HomeID device, try changing the `set_values` call to use `"1"`/`"0"` strings instead.

**Location:** [philips_air_api.py](philips_air_api.py) — `HomeIDHTTPPollingDaemon._execute_command`, childlock branch (around line 1053)

---

## HomeID filter life always shows 100%

**Affects:** `homeid-http` protocol only  
**Status:** Needs live device `fltsts` response to map field names

`parse_status()` reads filter life from CoAP-specific keys (`D05408`, `D0540E`) which are absent in HomeID `fltsts` responses. Until the actual HomeID field names are known, filter life and pre-filter life always default to 100%.

To fix: capture a raw `fltsts` response from a HomeID device (`probe-homeid` or direct `curl`), identify the field names, and add them to `parse_status()` alongside the existing CoAP keys.

**Location:** [philips_air_api.py](philips_air_api.py) — `parse_status()` filter section (around line 174)
