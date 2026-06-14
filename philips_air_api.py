#!/usr/bin/env python3
"""
Philips Air Purifier API - Daemon mode for Homebridge integration.

Supports two modes:
1. CLI mode: philips_air_api.py <host> <command> [args...]
2. Daemon mode: philips_air_api.py <host> --daemon
   Uses CoAP Observe or HTTP polling depending on the selected protocol.

Note: aioairctrl is bundled in the aioairctrl/ directory alongside this script.
      aiocoap and pycryptodomex must be installed (handled by postinstall.sh).
"""
import asyncio
import argparse
import base64
import hashlib
import json
import os
import secrets
import ssl
import sys
import signal
import time
import urllib.error
import urllib.request
from typing import Dict, Any, Optional

try:
    from Cryptodome.Cipher import AES
    from Cryptodome.Util.Padding import pad, unpad
    CRYPTO_AVAILABLE = True
except ModuleNotFoundError:
    AES = None
    pad = None
    unpad = None
    CRYPTO_AVAILABLE = False

try:
    from aioairctrl.coap.client import Client
    COAP_AVAILABLE = True
except ModuleNotFoundError:
    Client = None
    COAP_AVAILABLE = False

try:
    import paho.mqtt.client as _paho_mqtt
except ImportError:
    _paho_mqtt = None


# Air+ cloud MQTT constants
_AIRPLUS_API_BASE = "https://prod.eu-da.iot.versuni.com/api"
_AIRPLUS_OIDC_TOKEN_URL = "https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA/token"
_AIRPLUS_CLIENT_ID = "-XsK7O6iEkLml77yDGDUi0ku"
_AIRPLUS_MQTT_HOST = "ats.prod.eu-da.iot.versuni.com"
_AIRPLUS_MQTT_PORT = 443
_AIRPLUS_MQTT_PATH = "/mqtt"
_AIRPLUS_USER_AGENT = "okhttp/4.12.0 (Android 14; Pixel 7)"


# Constants
PARAM_POWER = "D03102"
PARAM_MODE = "D0310C"
PARAM_LIGHT = "D03104"
PARAM_CHILD_LOCK = "D03103"

MODE_AUTO = 0
MODE_SLEEP = 17
MODE_MEDIUM = 19
MODE_TURBO = 18

LIGHT_OFF = 0
LIGHT_DIM = 115
LIGHT_BRIGHT = 123

HTTP_MODE_VALUES = {
    "auto": {"mode": "A"},
    "sleep": {"mode": "M", "om": "s"},
    "medium": {"mode": "M", "om": "2"},
    "turbo": {"mode": "M", "om": "t"},
}

HOMEID_PORT_STATUS = "status"
HOMEID_PORT_AIR = "air"
HOMEID_PORT_FLTSTS = "fltsts"
HOMEID_PORT_DEVICE = "device"
HOMEID_PORT_SECURITY = "security"
HOMEID_PORT_FIRMWARE = "firmware"

MODE_NAMES = {
    MODE_AUTO: "auto",
    1: "auto",       # Air+ MQTT AC0650 reports auto as 1 (not 0)
    MODE_SLEEP: "sleep",
    MODE_MEDIUM: "medium",
    MODE_TURBO: "turbo",
}

MODE_VALUES = {v: k for k, v in MODE_NAMES.items()}

_G = 0xA4
_P = int(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1"
    "29024E088A67CC74020BBEA63B139B22514A08798E3404DD"
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245"
    "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381"
    "FFFFFFFFFFFFFFFF",
    16,
)


def _require_crypto():
    if not CRYPTO_AVAILABLE:
        raise RuntimeError("pycryptodomex is required for Philips encrypted HTTP support")


def _require_coap():
    if not COAP_AVAILABLE:
        raise RuntimeError("aiocoap is required for Philips CoAP support")


def _first_value(status: Dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Return the first present status value from a list of protocol-specific keys."""
    for key in keys:
        if key in status:
            return status[key]
    return default


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if value is None:
        return False
    return str(value).lower() in ("1", "on", "true", "yes", "enabled")


def _as_number(value: Any, default: Any = None) -> Any:
    if value is None:
        return default
    try:
        return float(value) if "." in str(value) else int(value)
    except (TypeError, ValueError):
        return default


def _normalise_mode(status: Dict[str, Any]) -> tuple[Any, str]:
    mode_value = _first_value(status, PARAM_MODE, "mode", default=MODE_AUTO)
    if isinstance(mode_value, int):
        return mode_value, MODE_NAMES.get(mode_value, "unknown")

    mode_text = str(mode_value).lower()
    fan_speed = str(_first_value(status, "om", default="")).lower()

    if mode_text in ("a", "auto"):
        return mode_value, "auto"
    if mode_text in ("s", "sleep") or fan_speed in ("s", "sleep"):
        return mode_value, "sleep"
    if fan_speed in ("t", "turbo", "3"):
        return mode_value, "turbo"
    if mode_text in ("m", "manual") or fan_speed in ("1", "2", "medium"):
        return mode_value, "medium"
    return mode_value, mode_text or "unknown"


def _normalise_light(status: Dict[str, Any]) -> int:
    light_value = _first_value(status, PARAM_LIGHT, "aqil", default=LIGHT_OFF)
    if light_value in (LIGHT_OFF, LIGHT_DIM, LIGHT_BRIGHT):
        return int(light_value)

    numeric_value = _as_number(light_value, LIGHT_OFF)
    if numeric_value == 0:
        return LIGHT_OFF
    if numeric_value <= 50:
        return LIGHT_DIM
    return LIGHT_BRIGHT


def parse_status(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Parse raw device status into normalised sensor data."""
    # Normalise Air+ MQTT power field: D0310D → D03102 (same semantics)
    if "D0310D" in raw and "D03102" not in raw:
        raw = dict(raw)
        raw["D03102"] = raw["D0310D"]
    status = raw
    filter_total = status.get("D05408", 9600)
    filter_remaining = status.get("D0540E", filter_total)
    filter_life_percent = (filter_remaining / filter_total * 100) if filter_total > 0 else 0

    cleanup_max_interval = status.get("D05207", 720)
    cleanup_time_until_next = status.get("D0520D", cleanup_max_interval)
    cleanup_percent = (cleanup_time_until_next / cleanup_max_interval * 100) if cleanup_max_interval > 0 else 0

    mode_value, mode_name = _normalise_mode(status)

    return {
        "power": _as_bool(_first_value(status, PARAM_POWER, "pwr", default=0)),
        "mode": mode_name,
        "mode_name": mode_name,
        "pm25": _as_number(_first_value(status, "D03221", "pm25")),
        "iaql": _as_number(_first_value(status, "D03120", "iaql")),
        "tvoc": status.get("tvoc"),
        "light_level": _normalise_light(status),
        "child_lock": _as_bool(_first_value(status, PARAM_CHILD_LOCK, "cl", default=0)),
        "filter_life_percent": round(filter_life_percent, 1),
        "filter_life_hours": filter_remaining,
        "filter_total_hours": filter_total,
        "cleanup_percent": round(cleanup_percent, 1),
        "cleanup_hours_until_next": cleanup_time_until_next,
        "cleanup_max_interval": cleanup_max_interval,
        "temperature": status.get("temp"),
        "humidity": status.get("rh"),
        "runtime": status.get("Runtime"),
        "wifi_rssi": status.get("rssi"),
    }


class PhilipsAirHTTPClient:
    """HTTP client for AC1xxx devices using DH key exchange and AES-CBC payloads."""

    def __init__(self, host: str, port: int = 80):
        self.host = host
        self.port = port
        self._session_key: Optional[bytes] = None

    def _url(self, path: str) -> str:
        return f"http://{self.host}:{self.port}{path}"

    def _require_session_key(self) -> bytes:
        if not self._session_key:
            raise ConnectionError("HTTP session key is not established")
        return self._session_key

    def _encrypt(self, values: Dict[str, Any]) -> bytes:
        _require_crypto()
        data = "AA" + json.dumps(values)
        cipher = AES.new(self._require_session_key(), AES.MODE_CBC, iv=bytes(16))
        return base64.b64encode(cipher.encrypt(pad(data.encode(), 16, style="pkcs7")))

    def _decrypt(self, data: bytes) -> Dict[str, Any]:
        try:
            _require_crypto()
            cipher = AES.new(self._require_session_key(), AES.MODE_CBC, iv=bytes(16))
            decrypted = unpad(cipher.decrypt(base64.b64decode(data)), 16, style="pkcs7")[2:]
            return json.loads(decrypted)
        except Exception as e:
            raise ValueError(f"Failed to decrypt HTTP response from {self.host}: {e}") from e

    def _http(self, method: str, path: str, body: Optional[bytes] = None) -> bytes:
        request = urllib.request.Request(
            self._url(path),
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            raise ConnectionError(f"HTTP {method} {path} failed with status {e.code}") from e
        except urllib.error.URLError as e:
            raise ConnectionError(f"HTTP {method} {path} failed: {e.reason}") from e

    def connect(self):
        """Perform the DH key exchange and store the local HTTP session key."""
        private_key = secrets.randbits(256)
        public_key = pow(_G, private_key, _P)
        body = json.dumps({"diffie": format(public_key, "x")}).encode()
        raw = self._http("PUT", "/di/v1/products/0/security", body)
        response = json.loads(raw)
        server_public_key = int(response["hellman"], 16)
        shared_secret = pow(server_public_key, private_key, _P)
        shared_key = shared_secret.to_bytes(128, byteorder="big")[:16]

        encrypted_key = base64.b64decode(response["key"])
        _require_crypto()
        cipher = AES.new(shared_key, AES.MODE_CBC, iv=bytes(16))
        self._session_key = unpad(cipher.decrypt(encrypted_key), 16, style="pkcs7")[:16]

    def get_status(self) -> Dict[str, Any]:
        raw = self._http("GET", "/di/v1/products/1/air")
        return self._decrypt(raw)

    def set_values(self, values: Dict[str, Any]):
        self._http("PUT", "/di/v1/products/1/air", self._encrypt(values))


class PhilipsCondorAuth:
    """PhilipsCondor challenge/response authentication for HomeID local HTTP."""

    SCHEME_VARIANTS = ("PhilipsCondor", "PHILIPS-Condor", "Philips-Condor")
    MIN_CHALLENGE_SIZE = 8
    MAX_CHALLENGE_SIZE = 64

    @staticmethod
    def create_credentials(challenge_header: str, client_id: str, client_secret: str) -> str:
        challenge = challenge_header.strip()
        response_scheme = "PhilipsCondor"
        for variant in PhilipsCondorAuth.SCHEME_VARIANTS:
            if challenge.lower().startswith(variant.lower()):
                response_scheme = challenge[:len(variant)]
                challenge = challenge[len(variant):].strip()
                break

        challenge_bytes = base64.b64decode(challenge)
        if not (
            PhilipsCondorAuth.MIN_CHALLENGE_SIZE
            <= len(challenge_bytes)
            <= PhilipsCondorAuth.MAX_CHALLENGE_SIZE
        ):
            raise ValueError(f"Invalid PhilipsCondor challenge size: {len(challenge_bytes)} bytes")

        client_id_bytes = base64.b64decode(client_id)
        client_secret_bytes = base64.b64decode(client_secret)
        digest = hashlib.sha256(challenge_bytes + client_id_bytes + client_secret_bytes).digest()
        response = base64.b64encode(client_id_bytes + digest).decode("utf-8")
        return f"{response_scheme} {response}"


class HomeIDAESCrypto:
    """AES-CBC helper for HomeID local HTTP devices using a persistent hex key."""

    @staticmethod
    def _hex_to_key(hex_key: str) -> bytes:
        key = bytes.fromhex(hex_key.strip())
        if len(key) == 17 and key[0] == 0:
            key = key[1:]
        if len(key) != 16:
            raise ValueError(f"Invalid HomeID AES key length: {len(key)} bytes")
        return key

    @staticmethod
    def encrypt(values: Dict[str, Any], hex_key: str) -> bytes:
        _require_crypto()
        key = HomeIDAESCrypto._hex_to_key(hex_key)
        plaintext = json.dumps(values).encode("utf-8")
        cipher = AES.new(key, AES.MODE_CBC, iv=bytes(16))
        return base64.b64encode(cipher.encrypt(pad(plaintext, 16, style="pkcs7")))

    @staticmethod
    def decrypt(data: bytes, hex_key: str) -> str:
        _require_crypto()
        key = HomeIDAESCrypto._hex_to_key(hex_key)
        cipher = AES.new(key, AES.MODE_CBC, iv=bytes(16))
        plaintext = unpad(cipher.decrypt(base64.b64decode(data.strip())), 16, style="pkcs7")
        return plaintext.decode("utf-8")


class PhilipsHomeIDHTTPClient:
    """HomeID local HTTP/HTTPS client using PhilipsCondor auth and optional AES."""

    def __init__(
        self,
        host: str,
        use_https: bool = False,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        encryption_key: Optional[str] = None,
        product_id: int = 1,
        protocol_version: int = 1,
    ):
        self.host = host
        self.use_https = use_https
        self.client_id = client_id
        self.client_secret = client_secret
        self.encryption_key = encryption_key
        self.product_id = product_id
        self.protocol_version = protocol_version
        self._credentials: Optional[str] = None
        self._ssl_context = self._create_ssl_context() if use_https else None

    @staticmethod
    def _create_ssl_context() -> ssl.SSLContext:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context

    def _url(self, port_name: str, product_id: Optional[int] = None) -> str:
        scheme = "https" if self.use_https else "http"
        pid = self.product_id if product_id is None else product_id
        return f"{scheme}://{self.host}/di/v{self.protocol_version}/products/{pid}/{port_name}"

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        }
        if self._credentials:
            headers["Authorization"] = self._credentials
        return headers

    def _prepare_body(self, values: Optional[Dict[str, Any]]) -> Optional[bytes]:
        if values is None:
            return None
        if self.encryption_key:
            return HomeIDAESCrypto.encrypt(values, self.encryption_key)
        return json.dumps(values).encode("utf-8")

    def _decode_body(self, raw: bytes, port_name: str) -> Dict[str, Any]:
        text = raw.decode("utf-8")
        if self.encryption_key:
            try:
                text = HomeIDAESCrypto.decrypt(raw, self.encryption_key)
            except Exception as e:
                raise ValueError(f"Failed to decrypt HomeID {port_name} response: {e}") from e
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}

    def _request(
        self,
        method: str,
        port_name: str,
        values: Optional[Dict[str, Any]] = None,
        product_id: Optional[int] = None,
        retry_auth: bool = True,
    ) -> Optional[Dict[str, Any]]:
        request = urllib.request.Request(
            self._url(port_name, product_id),
            data=self._prepare_body(values),
            method=method,
            headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(request, timeout=10, context=self._ssl_context) as response:
                return self._decode_body(response.read(), port_name)
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry_auth:
                challenge = e.headers.get("WWW-Authenticate")
                if not (challenge and self.client_id and self.client_secret):
                    raise PermissionError(
                        f"HomeID {method} /{port_name} requires PhilipsCondor credentials"
                    ) from e
                self._credentials = PhilipsCondorAuth.create_credentials(
                    challenge,
                    self.client_id,
                    self.client_secret,
                )
                return self._request(method, port_name, values, product_id, retry_auth=False)
            if e.code == 429:
                raise ConnectionError(f"HomeID {method} /{port_name} failed: device busy (429)") from e
            if e.code in (404, 501):
                return None
            raise ConnectionError(f"HomeID {method} /{port_name} failed with status {e.code}") from e
        except urllib.error.URLError as e:
            raise ConnectionError(f"HomeID {method} /{port_name} failed: {e.reason}") from e

    def connect(self):
        """Validate reachability and fetch an encryption key when credentials allow it."""
        info = self.get_device_info()
        if info is None:
            status = self._request("GET", HOMEID_PORT_STATUS)
            if status is None:
                raise ConnectionError("HomeID device did not respond on device or status endpoints")
        if not self.encryption_key and self.client_id and self.client_secret:
            self.exchange_encryption_key()

    def exchange_encryption_key(self) -> Optional[str]:
        result = self._request("GET", HOMEID_PORT_SECURITY, product_id=0)
        if not result:
            return None
        key = result.get("raw") or result.get("key")
        if key:
            self.encryption_key = str(key).strip()
            return self.encryption_key
        return None

    def get_device_info(self) -> Optional[Dict[str, Any]]:
        return (
            self._request("GET", HOMEID_PORT_DEVICE, product_id=1)
            or self._request("GET", HOMEID_PORT_DEVICE, product_id=0)
        )

    def get_status(self) -> Dict[str, Any]:
        merged: Dict[str, Any] = {}
        got_data = False
        for port_name in (HOMEID_PORT_STATUS, HOMEID_PORT_AIR, HOMEID_PORT_FLTSTS):
            result = self._request("GET", port_name)
            if result:
                got_data = True
                merged.update(result)
        firmware = self._request("GET", HOMEID_PORT_FIRMWARE, product_id=0)
        if firmware:
            merged["firmware"] = firmware
        if not got_data:
            raise ConnectionError("HomeID status polling returned no status, air, or filter data")
        return merged

    def set_values(self, values: Dict[str, Any]):
        result = self._request("PUT", HOMEID_PORT_STATUS, values)
        if result is None:
            raise ConnectionError("HomeID control request returned no response")

    def probe(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "scheme": "https" if self.use_https else "http",
            "reachable": False,
            "endpoints": {},
        }
        for product_id in (1, 0):
            for port_name in (HOMEID_PORT_DEVICE, HOMEID_PORT_STATUS):
                url = self._url(port_name, product_id)
                request = urllib.request.Request(url, method="GET", headers={"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=5, context=self._ssl_context) as response:
                        result["reachable"] = True
                        result["endpoints"][f"{product_id}/{port_name}"] = response.status
                except urllib.error.HTTPError as e:
                    result["reachable"] = True
                    result["endpoints"][f"{product_id}/{port_name}"] = e.code
                except urllib.error.URLError:
                    result["endpoints"][f"{product_id}/{port_name}"] = None
        return result


class AirPlusCloudClient:
    """MQTT-over-WSS client for Philips Air+ cloud devices (AWS IoT)."""

    def __init__(self, device_uuid: str, token_file: str):
        if _paho_mqtt is None:
            raise ImportError(
                "paho-mqtt is required for airplus-cloud protocol. "
                "Run: pip install 'paho-mqtt>=2.1'"
            )
        self._uuid = device_uuid
        self._device_id = f"da-{device_uuid}" if not device_uuid.startswith("da-") else device_uuid
        self._token_file = token_file
        self._tokens: Dict[str, Any] = {}
        self._mqtt: Optional[_paho_mqtt.Client] = None
        self._connected = False
        import queue as _queue_module
        import threading
        self._state_queue: _queue_module.Queue = _queue_module.Queue()
        self._ready = threading.Event()

    def _load_tokens(self):
        with open(self._token_file) as f:
            self._tokens = json.load(f)

    def _save_tokens(self):
        tmp = self._token_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._tokens, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self._token_file)
        os.chmod(self._token_file, 0o600)

    def _api_get(self, path: str) -> Dict[str, Any]:
        req = urllib.request.Request(
            f"{_AIRPLUS_API_BASE}{path}",
            headers={
                "Authorization": f"Bearer {self._tokens['access_token']}",
                "User-Agent": _AIRPLUS_USER_AGENT,
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def _refresh_token(self):
        import urllib.parse
        data = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": self._tokens["refresh_token"],
            "client_id": self._tokens.get("client_id", _AIRPLUS_CLIENT_ID),
        }).encode()
        req = urllib.request.Request(
            _AIRPLUS_OIDC_TOKEN_URL,
            data=data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": _AIRPLUS_USER_AGENT,
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        self._tokens["access_token"] = resp["access_token"]
        if "refresh_token" in resp:
            self._tokens["refresh_token"] = resp["refresh_token"]
        self._tokens["expires_at"] = time.time() + resp.get("expires_in", 3600)
        self._save_tokens()

    def _ensure_token(self):
        expires_at = self._tokens.get("expires_at", 0)
        if time.time() + 300 > expires_at:  # refresh 5 minutes early
            self._refresh_token()

    def _fetch_signature(self) -> str:
        try:
            return self._api_get("/da/user/self/signature")["signature"]
        except Exception:
            self._refresh_token()
            return self._api_get("/da/user/self/signature")["signature"]

    def connect(self):
        self._load_tokens()
        self._ensure_token()
        signature = self._fetch_signature()

        client = _paho_mqtt.Client(
            client_id=f"hb-{self._uuid[:8]}",
            transport="websockets",
        )
        client.tls_set_context(ssl.create_default_context())
        client.ws_set_options(
            path=_AIRPLUS_MQTT_PATH,
            headers={
                "x-amz-customauthorizer-name": "CustomAuthorizer",
                "x-amz-customauthorizer-signature": signature,
                "tenant": "da",
                "token-header": f"Bearer {self._tokens['access_token']}",
                "Sec-WebSocket-Protocol": "mqtt",
            },
        )
        client.on_connect = self._on_connect
        client.on_message = self._on_message
        client.on_disconnect = self._on_disconnect
        client.connect(_AIRPLUS_MQTT_HOST, _AIRPLUS_MQTT_PORT, keepalive=60)
        client.loop_start()
        self._mqtt = client
        # Wait for connection (up to 15s)
        if not self._ready.wait(timeout=15):
            raise ConnectionError("MQTT connection timed out")

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            self._connected = True
            inbound = f"da_ctrl/{self._device_id}/from_ncp"
            client.subscribe(inbound, qos=0)
            # Request initial status
            client.publish(
                f"da_ctrl/{self._device_id}/to_ncp",
                '{"cn":"getPort","data":{"portName":"Status"}}',
                qos=0,
            )
            self._ready.set()
        else:
            self._connected = False

    def _on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode())
            payload = data.get("data", {})
            if isinstance(payload, dict):
                props = payload.get("properties", {})
                port = payload.get("portName", "")
                if port == "Status" and props:
                    self._state_queue.put(dict(props))
        except Exception:
            pass

    def _on_disconnect(self, client, userdata, rc, properties=None):
        self._connected = False

    def get_status_queue(self):
        return self._state_queue

    def set_values(self, values: Dict[str, Any]):
        if not self._mqtt or not self._connected:
            return
        control_topic = f"da_ctrl/{self._device_id}/to_ncp"
        shadow_topic = f"$aws/things/{self._device_id}/shadow/update"

        _MODE_TO_DCODE = {
            "auto": 1, "sleep": 17, "turbo": 18, "medium": 19,
        }

        props: Dict[str, Any] = {}
        for key, val in values.items():
            if key == "power":
                shadow = json.dumps({"state": {"desired": {"powerOn": bool(val)}}})
                self._mqtt.publish(shadow_topic, shadow, qos=0)
            elif key == "mode" and isinstance(val, str):
                code = _MODE_TO_DCODE.get(val.lower())
                if code is not None:
                    props["D0310C"] = code
            elif key == "light_level":
                props["D03104"] = int(val)
            elif key == "child_lock":
                props["D03103"] = 1 if val else 0

        if props:
            cmd = json.dumps({
                "cn": "setPort",
                "data": {"portName": "Control", "properties": props},
            })
            self._mqtt.publish(control_topic, cmd, qos=0)

    def disconnect(self):
        if self._mqtt:
            self._mqtt.loop_stop()
            self._mqtt.disconnect()
            self._mqtt = None


class ObserveDaemon:
    """Daemon using CoAP Observe for push updates from device."""

    def __init__(self, host: str, port: int = 5683):
        self.host = host
        self.port = port
        self._client: Optional[Client] = None
        self._connected = False
        self._observing = False
        self._cached_state: Optional[Dict[str, Any]] = None
        self._last_update: float = 0
        self._shutdown_event = asyncio.Event()
        self._observe_task: Optional[asyncio.Task] = None

    async def connect(self) -> bool:
        """Connect to the device."""
        _require_coap()
        if self._client and self._connected:
            return True
        if self._client:
            await self.disconnect()
        try:
            self._client = await Client.create(self.host, self.port)
            self._connected = True
            return True
        except Exception as e:
            self._client = None
            self._connected = False
            raise ConnectionError(f"Failed to connect: {e}")

    async def disconnect(self):
        """Disconnect from the device."""
        self._connected = False
        self._observing = False
        if self._observe_task:
            self._observe_task.cancel()
            try:
                await self._observe_task
            except asyncio.CancelledError:
                pass
            self._observe_task = None
        if self._client:
            try:
                await self._client.shutdown()
            except Exception:
                pass
            self._client = None

    async def _observe_loop(self):
        """Background task that receives observe notifications."""
        while not self._shutdown_event.is_set():
            try:
                if not self._connected:
                    await self.connect()
                self._observing = True
                self._log("observe", "Starting observation subscription")
                async for status in self._client.observe_status():
                    if self._shutdown_event.is_set():
                        break
                    self._cached_state = status
                    self._last_update = time.time()
                    sensors = parse_status(status)
                    print(json.dumps({
                        "type": "update",
                        "data": sensors,
                        "timestamp": self._last_update
                    }), flush=True)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._observing = False
                self._connected = False
                self._log("observe_error", f"Observation failed: {e}")
                if not self._shutdown_event.is_set():
                    await asyncio.sleep(5)
                    try:
                        await self.disconnect()
                    except Exception:
                        pass
        self._observing = False

    def _log(self, event: str, message: str):
        """Send log message to JS."""
        print(json.dumps({
            "type": "log",
            "event": event,
            "message": message
        }), flush=True)

    async def start(self):
        """Start the daemon."""
        try:
            await self.connect()
            print(json.dumps({
                "type": "ready",
                "connected": True,
                "host": self.host
            }), flush=True)
        except Exception as e:
            print(json.dumps({
                "type": "ready",
                "connected": False,
                "host": self.host,
                "error": str(e)
            }), flush=True)
        self._observe_task = asyncio.create_task(self._observe_loop())
        await self._process_commands()
        await self.disconnect()
        print(json.dumps({"type": "shutdown"}), flush=True)

    async def _process_commands(self):
        """Process commands from stdin."""
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        reader_protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

        while not self._shutdown_event.is_set():
            try:
                line_task = asyncio.create_task(reader.readline())
                shutdown_task = asyncio.create_task(self._shutdown_event.wait())
                done, pending = await asyncio.wait(
                    [line_task, shutdown_task],
                    return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                if self._shutdown_event.is_set():
                    break
                line = line_task.result()
                if not line:
                    break
                line = line.decode('utf-8').strip()
                if not line:
                    continue
                try:
                    request = json.loads(line)
                    await self._handle_request(request)
                except json.JSONDecodeError as e:
                    print(json.dumps({
                        "success": False,
                        "error": f"Invalid JSON: {e}"
                    }), flush=True)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(json.dumps({
                    "type": "error",
                    "error": str(e)
                }), flush=True)

    async def _handle_request(self, request: dict):
        """Handle a single request from stdin."""
        request_id = request.get("id")
        cmd = request.get("cmd", "")
        args = request.get("args", [])
        try:
            result = await self._execute_command(cmd, args)
            print(json.dumps({
                "id": request_id,
                "success": True,
                "data": result
            }), flush=True)
        except Exception as e:
            print(json.dumps({
                "id": request_id,
                "success": False,
                "error": str(e)
            }), flush=True)

    async def _execute_command(self, cmd: str, args: list) -> Any:
        """Execute a command."""
        if cmd == "sensors":
            if self._cached_state:
                return parse_status(self._cached_state)
            for _ in range(50):
                if self._cached_state:
                    return parse_status(self._cached_state)
                await asyncio.sleep(0.1)
            raise Exception("No state available yet - waiting for device")
        elif cmd == "status":
            if self._cached_state:
                return self._cached_state
            raise Exception("No state available yet")
        elif cmd == "power":
            if args:
                on = str(args[0]).lower() in ["on", "1", "true"]
                await self._send_control(PARAM_POWER, 1 if on else 0)
                return {"power": on}
            elif self._cached_state:
                return {"power": bool(self._cached_state.get(PARAM_POWER, 0))}
            raise Exception("No state available")
        elif cmd == "mode":
            if args:
                mode = str(args[0]).lower()
                if mode not in MODE_VALUES:
                    raise ValueError(f"Invalid mode: {mode}")
                await self._send_control(PARAM_MODE, MODE_VALUES[mode])
                return {"mode": mode}
            elif self._cached_state:
                mode_val = self._cached_state.get(PARAM_MODE, 0)
                return {"mode": MODE_NAMES.get(mode_val, "unknown")}
            raise Exception("No state available")
        elif cmd == "light":
            if args:
                level = int(args[0])
                if not (0 <= level <= 255):
                    raise ValueError(f"Light level must be 0-255, got {level}")
                if level == 0:
                    device_value = LIGHT_OFF
                elif level <= 50 or level == 115:
                    device_value = LIGHT_DIM
                else:
                    device_value = LIGHT_BRIGHT
                await self._send_control(PARAM_LIGHT, device_value)
                return {"light": device_value}
            elif self._cached_state:
                return {"light": self._cached_state.get(PARAM_LIGHT, 0)}
            raise Exception("No state available")
        elif cmd == "childlock":
            if args:
                enabled = str(args[0]).lower() in ["on", "1", "true", "enabled"]
                await self._send_control(PARAM_CHILD_LOCK, 1 if enabled else 0)
                return {"child_lock": enabled}
            elif self._cached_state:
                return {"child_lock": bool(self._cached_state.get(PARAM_CHILD_LOCK, 0))}
            raise Exception("No state available")
        elif cmd == "ping":
            return {
                "connected": self._connected,
                "observing": self._observing,
                "has_state": self._cached_state is not None,
                "last_update": self._last_update
            }
        else:
            raise ValueError(f"Unknown command: {cmd}")

    async def _send_control(self, key: str, value: int):
        """Send a control command to the device."""
        if not self._connected or not self._client:
            await self.connect()
        result = await self._client.set_control_value(key, value)
        if not result:
            raise Exception(f"Failed to set {key}={value}")

    def shutdown(self):
        """Signal shutdown."""
        self._shutdown_event.set()


class HTTPPollingDaemon:
    """Daemon using HTTP polling for devices without CoAP support."""

    POLL_INTERVAL = 10

    def __init__(self, host: str, port: int = 80):
        self.host = host
        self.port = port
        self._client = PhilipsAirHTTPClient(host, port)
        self._connected = False
        self._cached_state: Optional[Dict[str, Any]] = None
        self._last_update: float = 0
        self._shutdown_event = asyncio.Event()
        self._poll_task: Optional[asyncio.Task] = None

    async def connect(self) -> bool:
        await asyncio.to_thread(self._client.connect)
        self._connected = True
        return True

    def _log(self, event: str, message: str):
        """Send log message to JS."""
        print(json.dumps({
            "type": "log",
            "event": event,
            "message": message
        }), flush=True)

    async def start(self):
        """Start the daemon."""
        try:
            await self.connect()
            print(json.dumps({
                "type": "ready",
                "connected": True,
                "host": self.host
            }), flush=True)
        except Exception as e:
            self._connected = False
            print(json.dumps({
                "type": "ready",
                "connected": False,
                "host": self.host,
                "error": str(e)
            }), flush=True)

        self._poll_task = asyncio.create_task(self._poll_loop())
        await self._process_commands()
        await self.disconnect()
        print(json.dumps({"type": "shutdown"}), flush=True)

    async def disconnect(self):
        self._connected = False
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

    async def _poll_loop(self):
        while not self._shutdown_event.is_set():
            try:
                if not self._connected:
                    await self.connect()
                state = await asyncio.to_thread(self._client.get_status)
                self._cached_state = state
                self._last_update = time.time()
                print(json.dumps({
                    "type": "update",
                    "data": parse_status(state),
                    "timestamp": self._last_update
                }), flush=True)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._connected = False
                self._log("poll_error", f"HTTP poll failed: {e}")
                if not self._shutdown_event.is_set():
                    await asyncio.sleep(5)

            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=self.POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass

    async def _process_commands(self):
        """Process commands from stdin."""
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        reader_protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

        while not self._shutdown_event.is_set():
            try:
                line_task = asyncio.create_task(reader.readline())
                shutdown_task = asyncio.create_task(self._shutdown_event.wait())
                done, pending = await asyncio.wait(
                    [line_task, shutdown_task],
                    return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                if self._shutdown_event.is_set():
                    break
                line = line_task.result()
                if not line:
                    break
                line = line.decode('utf-8').strip()
                if not line:
                    continue
                try:
                    request = json.loads(line)
                    await self._handle_request(request)
                except json.JSONDecodeError as e:
                    print(json.dumps({
                        "success": False,
                        "error": f"Invalid JSON: {e}"
                    }), flush=True)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(json.dumps({
                    "type": "error",
                    "error": str(e)
                }), flush=True)

    async def _handle_request(self, request: dict):
        request_id = request.get("id")
        cmd = request.get("cmd", "")
        args = request.get("args", [])
        try:
            result = await self._execute_command(cmd, args)
            print(json.dumps({
                "id": request_id,
                "success": True,
                "data": result
            }), flush=True)
        except Exception as e:
            print(json.dumps({
                "id": request_id,
                "success": False,
                "error": str(e)
            }), flush=True)

    async def _execute_command(self, cmd: str, args: list) -> Any:
        if cmd == "sensors":
            if self._cached_state:
                return parse_status(self._cached_state)
            for _ in range(50):
                if self._cached_state:
                    return parse_status(self._cached_state)
                await asyncio.sleep(0.1)
            raise Exception("No state available yet - waiting for device")
        elif cmd == "status":
            if self._cached_state:
                return self._cached_state
            raise Exception("No state available yet")
        elif cmd == "power":
            if args:
                on = str(args[0]).lower() in ["on", "1", "true"]
                await self._send_control({"pwr": "1" if on else "0"})
                return {"power": on}
            elif self._cached_state:
                return {"power": parse_status(self._cached_state)["power"]}
            raise Exception("No state available")
        elif cmd == "mode":
            if args:
                mode = str(args[0]).lower()
                if mode not in HTTP_MODE_VALUES:
                    raise ValueError(f"Invalid mode: {mode}")
                await self._send_control(HTTP_MODE_VALUES[mode])
                return {"mode": mode}
            elif self._cached_state:
                return {"mode": parse_status(self._cached_state)["mode_name"]}
            raise Exception("No state available")
        elif cmd == "light":
            if args:
                level = int(args[0])
                if not (0 <= level <= 255):
                    raise ValueError(f"Light level must be 0-255, got {level}")
                if level == 0:
                    device_value = "0"
                    normalised = LIGHT_OFF
                elif level <= 50 or level == LIGHT_DIM:
                    device_value = "50"
                    normalised = LIGHT_DIM
                else:
                    device_value = "100"
                    normalised = LIGHT_BRIGHT
                await self._send_control({"aqil": device_value})
                return {"light": normalised}
            elif self._cached_state:
                return {"light": parse_status(self._cached_state)["light_level"]}
            raise Exception("No state available")
        elif cmd == "childlock":
            if args:
                enabled = str(args[0]).lower() in ["on", "1", "true", "enabled"]
                await self._send_control({"cl": "1" if enabled else "0"})
                return {"child_lock": enabled}
            elif self._cached_state:
                return {"child_lock": parse_status(self._cached_state)["child_lock"]}
            raise Exception("No state available")
        elif cmd == "ping":
            return {
                "connected": self._connected,
                "observing": False,
                "has_state": self._cached_state is not None,
                "last_update": self._last_update
            }
        else:
            raise ValueError(f"Unknown command: {cmd}")

    async def _send_control(self, values: Dict[str, Any]):
        if not self._connected:
            await self.connect()
        await asyncio.to_thread(self._client.set_values, values)
        if self._cached_state:
            self._cached_state.update(values)

    def shutdown(self):
        self._shutdown_event.set()


class HomeIDHTTPPollingDaemon(HTTPPollingDaemon):
    """Daemon using HomeID local HTTP/HTTPS polling."""

    def __init__(
        self,
        host: str,
        use_https: bool = False,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        encryption_key: Optional[str] = None,
    ):
        self.host = host
        self.port = 443 if use_https else 80
        self._client = PhilipsHomeIDHTTPClient(
            host,
            use_https=use_https,
            client_id=client_id,
            client_secret=client_secret,
            encryption_key=encryption_key,
        )
        self._connected = False
        self._cached_state: Optional[Dict[str, Any]] = None
        self._last_update: float = 0
        self._shutdown_event = asyncio.Event()
        self._poll_task: Optional[asyncio.Task] = None

    async def _execute_command(self, cmd: str, args: list) -> Any:
        if cmd == "sensors":
            if self._cached_state:
                return parse_status(self._cached_state)
            for _ in range(50):
                if self._cached_state:
                    return parse_status(self._cached_state)
                await asyncio.sleep(0.1)
            raise Exception("No state available yet - waiting for device")
        elif cmd == "status":
            if self._cached_state:
                return self._cached_state
            raise Exception("No state available yet")
        elif cmd == "power":
            if args:
                on = str(args[0]).lower() in ["on", "1", "true"]
                await self._send_control({"pwr": "1" if on else "0"})
                return {"power": on}
            elif self._cached_state:
                return {"power": parse_status(self._cached_state)["power"]}
            raise Exception("No state available")
        elif cmd == "mode":
            if args:
                mode = str(args[0]).lower()
                if mode not in HTTP_MODE_VALUES:
                    raise ValueError(f"Invalid mode: {mode}")
                await self._send_control(HTTP_MODE_VALUES[mode])
                return {"mode": mode}
            elif self._cached_state:
                return {"mode": parse_status(self._cached_state)["mode_name"]}
            raise Exception("No state available")
        elif cmd == "light":
            if args:
                level = int(args[0])
                if not (0 <= level <= 255):
                    raise ValueError(f"Light level must be 0-255, got {level}")
                if level == 0:
                    device_value = "0"
                    normalised = LIGHT_OFF
                elif level <= 50 or level == LIGHT_DIM:
                    device_value = "50"
                    normalised = LIGHT_DIM
                else:
                    device_value = "100"
                    normalised = LIGHT_BRIGHT
                await self._send_control({"aqil": device_value})
                return {"light": normalised}
            elif self._cached_state:
                return {"light": parse_status(self._cached_state)["light_level"]}
            raise Exception("No state available")
        elif cmd == "childlock":
            if args:
                enabled = str(args[0]).lower() in ["on", "1", "true", "enabled"]
                await self._send_control({"cl": enabled})
                return {"child_lock": enabled}
            elif self._cached_state:
                return {"child_lock": parse_status(self._cached_state)["child_lock"]}
            raise Exception("No state available")
        elif cmd == "ping":
            return {
                "connected": self._connected,
                "observing": False,
                "has_state": self._cached_state is not None,
                "last_update": self._last_update
            }
        else:
            raise ValueError(f"Unknown command: {cmd}")


class AirPlusCloudDaemon:
    """Daemon using Philips Air+ MQTT-over-WSS cloud API."""

    def __init__(self, device_uuid: str, token_file: str):
        self._uuid = device_uuid
        self._token_file = token_file
        self._client: Optional[AirPlusCloudClient] = None
        self._shutdown_event = asyncio.Event()

    def shutdown(self):
        self._shutdown_event.set()

    def _log(self, event: str, message: str):
        print(json.dumps({
            "type": "log",
            "event": event,
            "message": message,
        }), flush=True)

    async def start(self):
        try:
            self._client = AirPlusCloudClient(self._uuid, self._token_file)
            await asyncio.to_thread(self._client.connect)
            print(json.dumps({
                "type": "ready",
                "connected": True,
                "host": "cloud",
            }), flush=True)
        except Exception as e:
            print(json.dumps({
                "type": "ready",
                "connected": False,
                "host": "cloud",
                "error": str(e),
            }), flush=True)
            return

        await asyncio.gather(self._state_loop(), self._process_commands())
        if self._client:
            await asyncio.to_thread(self._client.disconnect)
        print(json.dumps({"type": "shutdown"}), flush=True)

    async def _state_loop(self):
        import queue as _queue_module
        q = self._client.get_status_queue()
        while not self._shutdown_event.is_set():
            try:
                raw = await asyncio.to_thread(q.get, True, 1.0)
                state = parse_status(raw)
                print(json.dumps({
                    "type": "update",
                    "data": state,
                    "timestamp": time.time(),
                }), flush=True)
            except _queue_module.Empty:
                pass
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._log("state_error", f"State processing error: {e}")
                await asyncio.sleep(0.1)

    async def _process_commands(self):
        """Process commands from stdin — same pattern as HTTPPollingDaemon."""
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        reader_protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

        while not self._shutdown_event.is_set():
            try:
                line_task = asyncio.create_task(reader.readline())
                shutdown_task = asyncio.create_task(self._shutdown_event.wait())
                done, pending = await asyncio.wait(
                    [line_task, shutdown_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if self._shutdown_event.is_set():
                    break
                line = line_task.result()
                if not line:
                    break
                line = line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    request = json.loads(line)
                    await self._handle_request(request)
                except json.JSONDecodeError as e:
                    print(json.dumps({
                        "success": False,
                        "error": f"Invalid JSON: {e}",
                    }), flush=True)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(json.dumps({
                    "type": "error",
                    "error": str(e),
                }), flush=True)

    async def _handle_request(self, request: dict):
        request_id = request.get("id")
        cmd = request.get("cmd", "")
        args = request.get("args", [])
        try:
            result = await self._execute_command(cmd, args)
            print(json.dumps({
                "id": request_id,
                "success": True,
                "data": result,
            }), flush=True)
        except Exception as e:
            print(json.dumps({
                "id": request_id,
                "success": False,
                "error": str(e),
            }), flush=True)

    async def _execute_command(self, cmd: str, args: list) -> Any:
        if cmd == "ping":
            return {
                "connected": self._client._connected if self._client else False,
                "observing": True,
                "has_state": True,
                "last_update": time.time(),
            }
        elif cmd == "power":
            if args:
                on = str(args[0]).lower() in ["on", "1", "true"]
                if self._client:
                    await asyncio.to_thread(self._client.set_values, {"power": on})
                return {"power": on}
            raise Exception("No args provided for power command")
        elif cmd == "mode":
            if args:
                mode = str(args[0]).lower()
                if mode not in MODE_VALUES:
                    raise ValueError(f"Invalid mode: {mode}")
                if self._client:
                    await asyncio.to_thread(self._client.set_values, {"mode": mode})
                return {"mode": mode}
            raise Exception("No args provided for mode command")
        elif cmd == "light":
            if args:
                level = int(args[0])
                if self._client:
                    await asyncio.to_thread(self._client.set_values, {"light_level": level})
                return {"light": level}
            raise Exception("No args provided for light command")
        elif cmd == "childlock":
            if args:
                enabled = str(args[0]).lower() in ["on", "1", "true", "enabled"]
                if self._client:
                    await asyncio.to_thread(self._client.set_values, {"child_lock": enabled})
                return {"child_lock": enabled}
            raise Exception("No args provided for childlock command")
        else:
            raise ValueError(f"Unknown command: {cmd}")


async def run_daemon(
    host: str,
    protocol: str = "coap",
    use_https: bool = False,
    client_id: Optional[str] = None,
    client_secret: Optional[str] = None,
    encryption_key: Optional[str] = None,
):
    """Run the selected daemon protocol."""
    if protocol == "homeid-http":
        daemon = HomeIDHTTPPollingDaemon(
            host,
            use_https=use_https,
            client_id=client_id,
            client_secret=client_secret,
            encryption_key=encryption_key,
        )
    elif protocol == "http":
        daemon = HTTPPollingDaemon(host)
    else:
        daemon = ObserveDaemon(host)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, daemon.shutdown)
        except NotImplementedError:
            pass
    await daemon.start()


# ============== CLI Mode ==============

class PhilipsAirPurifier:
    """Simple client for CLI mode."""

    def __init__(self, host: str, port: int = 5683):
        self.host = host
        self.port = port
        self._client: Optional[Client] = None

    async def connect(self):
        _require_coap()
        self._client = await Client.create(self.host, self.port)

    async def disconnect(self):
        if self._client:
            await self._client.shutdown()
            self._client = None

    async def get_sensors(self) -> Dict[str, Any]:
        status = await self._client.get_status()
        return parse_status(status)

    async def get_status(self) -> Dict[str, Any]:
        return await self._client.get_status()

    async def set_power(self, on: bool):
        await self._client.set_control_value(PARAM_POWER, 1 if on else 0)

    async def set_mode(self, mode: str):
        if mode.lower() not in MODE_VALUES:
            raise ValueError(f"Invalid mode: {mode}")
        await self._client.set_control_value(PARAM_MODE, MODE_VALUES[mode.lower()])

    async def set_light(self, level: int):
        if level == 0:
            value = LIGHT_OFF
        elif level <= 50 or level == 115:
            value = LIGHT_DIM
        else:
            value = LIGHT_BRIGHT
        await self._client.set_control_value(PARAM_LIGHT, value)

    async def set_child_lock(self, enabled: bool):
        await self._client.set_control_value(PARAM_CHILD_LOCK, 1 if enabled else 0)


async def handle_cli_command(host: str, command: str, *args):
    """Handle a single CLI command."""
    purifier = PhilipsAirPurifier(host)
    try:
        await purifier.connect()
        if command == "status":
            result = await purifier.get_status()
            print(json.dumps(result, indent=2))
        elif command == "sensors":
            result = await purifier.get_sensors()
            print(json.dumps(result, indent=2))
        elif command == "power":
            if args:
                on = args[0].lower() in ["on", "1", "true"]
                await purifier.set_power(on)
                print(f"Power set to {'ON' if on else 'OFF'}")
            else:
                sensors = await purifier.get_sensors()
                print(f"Power: {'ON' if sensors['power'] else 'OFF'}")
        elif command == "mode":
            if args:
                await purifier.set_mode(args[0])
                print(f"Mode set to {args[0]}")
            else:
                sensors = await purifier.get_sensors()
                print(f"Mode: {sensors['mode_name']}")
        elif command == "light":
            if args:
                level = int(args[0])
                await purifier.set_light(level)
                print(f"Light level set to {level}")
            else:
                sensors = await purifier.get_sensors()
                print(f"Light level: {sensors['light_level']}")
        elif command == "childlock":
            if args:
                enabled = args[0].lower() in ["on", "1", "true", "enabled"]
                await purifier.set_child_lock(enabled)
                print(f"Child lock {'enabled' if enabled else 'disabled'}")
            else:
                sensors = await purifier.get_sensors()
                print(f"Child lock: {'ON' if sensors['child_lock'] else 'OFF'}")
        else:
            print(f"Unknown command: {command}")
            print("\nAvailable commands:")
            print("  status                         - Get full device status")
            print("  sensors                        - Get all sensor readings")
            print("  power [on|off]                 - Get/set power state")
            print("  mode [auto|sleep|medium|turbo] - Get/set mode")
            print("  light [0|115|123]              - Get/set light (0=off, 115=dim, 123=bright)")
            print("  childlock [on|off]             - Get/set child lock")
            print("\nDaemon mode:")
            print("  --daemon                       - Run as observe daemon")
            return 1
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    finally:
        await purifier.disconnect()


async def handle_homeid_probe(host: str, use_https: bool = False):
    """Probe HomeID local HTTP endpoints without authenticating or changing state."""
    client = PhilipsHomeIDHTTPClient(host, use_https=use_https)
    result = await asyncio.to_thread(client.probe)
    print(json.dumps(result, indent=2))
    return 0 if result.get("reachable") else 1


def main():
    parser = argparse.ArgumentParser(description="Philips Air Purifier API helper")
    parser.add_argument("host")
    parser.add_argument("command", nargs="?", default="sensors")
    parser.add_argument("args", nargs="*")
    parser.add_argument("--daemon", action="store_true", help="run as a Homebridge daemon")
    parser.add_argument(
        "--protocol",
        choices=["coap", "http", "homeid-http", "airplus-cloud"],
        default="coap",
    )
    parser.add_argument("--use-https", action="store_true", help="use HTTPS for HomeID local API")
    parser.add_argument(
        "--device-uuid",
        help="Air+ device UUID (airplus-cloud protocol only)",
    )
    parser.add_argument(
        "--token-file",
        help="Path to token JSON file (airplus-cloud protocol only)",
    )
    parsed = parser.parse_args()

    if parsed.daemon or parsed.command == "--daemon":
        if parsed.protocol == "airplus-cloud":
            if not parsed.device_uuid or not parsed.token_file:
                sys.exit("--device-uuid and --token-file are required for airplus-cloud protocol")
            daemon = AirPlusCloudDaemon(parsed.device_uuid, parsed.token_file)
            loop = asyncio.get_event_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, daemon.shutdown)
                except NotImplementedError:
                    pass
            asyncio.run(daemon.start())
        else:
            asyncio.run(run_daemon(
                parsed.host,
                parsed.protocol,
                use_https=parsed.use_https,
                client_id=os.environ.get("PHILIPS_HOMEID_CLIENT_ID"),
                client_secret=os.environ.get("PHILIPS_HOMEID_CLIENT_SECRET"),
                encryption_key=os.environ.get("PHILIPS_HOMEID_ENCRYPTION_KEY"),
            ))
    elif parsed.command == "probe-homeid":
        exit_code = asyncio.run(handle_homeid_probe(parsed.host, parsed.use_https))
        sys.exit(exit_code)
    else:
        exit_code = asyncio.run(handle_cli_command(parsed.host, parsed.command, *parsed.args))
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
