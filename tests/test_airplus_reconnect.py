"""Regression tests: Air+ cloud MQTT recovery after access-token expiry.

Philips OIDC access tokens live 3600s, and AWS IoT drops the WebSocket
connection when the handshake token expires — so before the fix the
plugin went silent after ~1 hour: Paho's auto-reconnect re-ran the WS
handshake with a stale token snapshot and was rejected forever, while
set_values() silently no-oped.

The fake broker below models that: handshakes succeed only with a
currently-valid token, and live connections are dropped on expiry.
The client must recover by presenting freshly refreshed credentials on
the reconnect handshake, and commands while disconnected must fail
loudly instead of pretending to succeed.
"""

import json
import io
import sys
import types
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import philips_air_api  # noqa: E402
from philips_air_api import AirPlusCloudClient  # noqa: E402

TOKEN_LIFETIME = 3600


class FakeClock:
    def __init__(self, start=1_000_000.0):
        self.now = start

    def advance(self, seconds):
        self.now += seconds


class FakeBroker:
    """AWS-IoT-ish broker: handshake succeeds only with a currently-valid
    token, and live connections are dropped when their token expires."""

    def __init__(self, clock):
        self.clock = clock
        self.valid_tokens = {}          # token -> expires_at
        self.connected_clients = {}     # FakePahoClient -> token used
        self.published = []             # (topic, payload)
        self.handshake_log = []         # (time, token, accepted)

    def issue(self, token):
        self.valid_tokens[token] = self.clock.now + TOKEN_LIFETIME

    def token_ok(self, token):
        return self.valid_tokens.get(token, 0) > self.clock.now

    def handshake(self, client, headers):
        token = headers.get("token-header", "").removeprefix("Bearer ")
        ok = self.token_ok(token)
        self.handshake_log.append((self.clock.now, token, ok))
        if ok:
            self.connected_clients[client] = token
        return ok

    def drop_expired(self):
        """Broker side of the 1-hour symptom: kill connections whose
        handshake token has expired."""
        for client, token in list(self.connected_clients.items()):
            if not self.token_ok(token):
                del self.connected_clients[client]
                client._broker_dropped()


class FakePahoClient:
    """Minimal stand-in for paho.mqtt.client.Client over websockets."""

    def __init__(self, client_id=None, transport=None, **kwargs):
        self.client_id = client_id
        self.on_connect = None
        self.on_message = None
        self.on_disconnect = None
        self._headers_cb = None
        self._broker = FakePahoModule.broker
        self._sock_up = False

    def tls_set_context(self, ctx):
        pass

    def ws_set_options(self, path=None, headers=None):
        self._headers_cb = headers

    def _handshake(self):
        headers = self._headers_cb(dict(_DEFAULT_WS_HEADERS))
        return self._broker.handshake(self, headers)

    def connect(self, host, port, keepalive=60):
        if not self._handshake():
            raise ConnectionRefusedError("WebSocket handshake rejected (403)")
        self._sock_up = True

    def loop_start(self):
        if self._sock_up and self.on_connect:
            self.on_connect(self, None, {}, 0)

    def loop_stop(self):
        pass

    def subscribe(self, topic, qos=0):
        pass

    def publish(self, topic, payload, qos=0):
        if self in self._broker.connected_clients:
            self._broker.published.append((topic, payload))

    def disconnect(self):
        self._broker.connected_clients.pop(self, None)
        self._sock_up = False

    # --- broker/paho internals -------------------------------------
    def _broker_dropped(self):
        self._sock_up = False
        if self.on_disconnect:
            self.on_disconnect(self, None, 1)
        # Paho's network thread now retries the connection itself,
        # re-running the WS handshake with the same stored options.
        for _ in range(5):
            if self._handshake():
                self._sock_up = True
                if self.on_connect:
                    self.on_connect(self, None, {}, 0)
                return


_DEFAULT_WS_HEADERS = {"Origin": "https://example"}


class FakePahoModule(types.SimpleNamespace):
    broker = None
    Client = FakePahoClient


class FakeHTTPResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.payload


class AirPlusReconnectTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.broker = FakeBroker(self.clock)
        FakePahoModule.broker = self.broker

        self._tmp = TemporaryDirectory()
        self.token_file = str(Path(self._tmp.name) / "tokens.json")
        self.broker.issue("tok-1")
        Path(self.token_file).write_text(json.dumps({
            "access_token": "tok-1",
            "refresh_token": "refresh-1",
            "id_token": "idt-1",
            "mqtt_user_id": "user-1",
            "expires_at": self.clock.now + TOKEN_LIFETIME,
        }))

        self._orig = {
            "paho": philips_air_api._paho_mqtt,
            "time": philips_air_api.time,
            "sig": AirPlusCloudClient._fetch_signature,
            "refresh": AirPlusCloudClient._refresh_token,
        }
        philips_air_api._paho_mqtt = FakePahoModule
        philips_air_api.time = types.SimpleNamespace(
            time=lambda: self.clock.now, sleep=lambda s: None)
        AirPlusCloudClient._fetch_signature = lambda self_: "sig"

        clock, broker, refresh_count = self.clock, self.broker, [0]
        self.refresh_count = refresh_count

        def fake_refresh(client_self):
            # Faithful stand-in for the OIDC refresh_token grant.
            refresh_count[0] += 1
            new_token = f"tok-{refresh_count[0] + 1}"
            broker.issue(new_token)
            client_self._tokens["access_token"] = new_token
            client_self._tokens["expires_at"] = clock.now + TOKEN_LIFETIME
            client_self._save_tokens()

        AirPlusCloudClient._refresh_token = fake_refresh

    def tearDown(self):
        philips_air_api._paho_mqtt = self._orig["paho"]
        philips_air_api.time = self._orig["time"]
        AirPlusCloudClient._fetch_signature = self._orig["sig"]
        AirPlusCloudClient._refresh_token = self._orig["refresh"]
        self._tmp.cleanup()

    def test_recovers_after_token_expiry_disconnect(self):
        client = AirPlusCloudClient("da-test-uuid", self.token_file)
        client.connect()
        self.assertTrue(client._connected, "sanity: initial connect works")

        # One hour passes: the handshake token expires and the broker
        # drops the connection (the user's "after an hour it stops
        # responding" moment).
        self.clock.advance(TOKEN_LIFETIME + 1)
        self.broker.drop_expired()

        self.assertTrue(
            client._connected,
            "client never re-established the MQTT connection after the "
            f"token-expiry drop; handshakes={self.broker.handshake_log}",
        )
        fresh = [t for _, t, ok in self.broker.handshake_log if ok and t != "tok-1"]
        self.assertTrue(fresh, "reconnect never used a refreshed token")

        # And commands must reach the broker again.
        before = len(self.broker.published)
        client.set_values({"mode": "auto"})
        self.assertGreater(
            len(self.broker.published), before,
            "set_values() was silently dropped after the disconnect",
        )

    def test_set_values_raises_while_disconnected(self):
        client = AirPlusCloudClient("da-test-uuid", self.token_file)
        client.connect()
        client._connected = False
        with self.assertRaises(ConnectionError):
            client.set_values({"mode": "auto"})

    def test_get_id_401_refreshes_tokens_and_retries_once(self):
        client = AirPlusCloudClient("da-test-uuid", self.token_file)
        client._tokens = {
            "access_token": "tok-1",
            "refresh_token": "refresh-1",
            "id_token": "idt-1",
            "expires_at": self.clock.now + TOKEN_LIFETIME,
        }
        requests = []

        def fake_urlopen(request, timeout):
            requests.append(request)
            if len(requests) == 1:
                raise urllib.error.HTTPError(
                    request.full_url,
                    401,
                    "Unauthorised",
                    {},
                    io.BytesIO(b'{"access_token":"must-not-reach-logs"}'),
                )
            if len(requests) == 2:
                return FakeHTTPResponse({
                    "access_token": "tok-2",
                    "refresh_token": "refresh-2",
                    "id_token": "idt-2",
                    "expires_in": TOKEN_LIFETIME,
                })
            return FakeHTTPResponse({"userId": "user-refreshed"})

        AirPlusCloudClient._refresh_token = self._orig["refresh"]
        with mock.patch.object(philips_air_api.urllib.request, "urlopen", fake_urlopen):
            user_id = client._fetch_mqtt_user_id()

        self.assertEqual(user_id, "user-refreshed")
        self.assertEqual(len(requests), 3)
        first_get_id = json.loads(requests[0].data)
        retried_get_id = json.loads(requests[2].data)
        self.assertEqual(first_get_id["idToken"], "idt-1")
        self.assertEqual(retried_get_id["idToken"], "idt-2")
        self.assertEqual(requests[2].get_header("Authorization"), "Bearer tok-2")

        saved_tokens = json.loads(Path(self.token_file).read_text())
        self.assertEqual(saved_tokens["id_token"], "idt-2")
        self.assertEqual(saved_tokens["mqtt_user_id"], "user-refreshed")

    def test_get_id_401_without_refreshed_id_token_requires_setup(self):
        client = AirPlusCloudClient("da-test-uuid", self.token_file)
        client._tokens = {
            "access_token": "tok-1",
            "refresh_token": "refresh-1",
            "id_token": "idt-1",
            "expires_at": self.clock.now + TOKEN_LIFETIME,
        }
        requests = []

        def fake_urlopen(request, timeout):
            requests.append(request)
            if len(requests) == 1:
                raise urllib.error.HTTPError(
                    request.full_url,
                    401,
                    "Unauthorised",
                    {},
                    io.BytesIO(b'{"error":"expired id_token"}'),
                )
            if len(requests) == 2:
                return FakeHTTPResponse({
                    "access_token": "tok-2",
                    "refresh_token": "refresh-2",
                    "expires_in": TOKEN_LIFETIME,
                })
            self.fail("get-id was retried with an unchanged id_token")

        AirPlusCloudClient._refresh_token = self._orig["refresh"]
        with mock.patch.object(philips_air_api.urllib.request, "urlopen", fake_urlopen):
            with self.assertRaisesRegex(
                RuntimeError,
                "rerun scripts/airplus_setup.py",
            ):
                client._fetch_mqtt_user_id()

        get_id_requests = [
            request for request in requests if request.full_url.endswith("/da/user/self/get-id")
        ]
        self.assertEqual(len(get_id_requests), 1)
        self.assertEqual(client._tokens["id_token"], "idt-1")

    def test_get_id_error_omits_upstream_response_body(self):
        client = AirPlusCloudClient("da-test-uuid", self.token_file)
        client._tokens = {
            "access_token": "tok-1",
            "refresh_token": "refresh-1",
            "id_token": "idt-1",
        }
        secret_body = b'{"id_token":"must-not-reach-logs"}'
        error = urllib.error.HTTPError(
            "https://example.invalid/get-id",
            500,
            "Internal Server Error",
            {},
            io.BytesIO(secret_body),
        )

        with mock.patch.object(
            philips_air_api.urllib.request,
            "urlopen",
            side_effect=error,
        ):
            with self.assertRaisesRegex(ConnectionError, "HTTP 500") as caught:
                client._fetch_mqtt_user_id()

        self.assertNotIn("must-not-reach-logs", str(caught.exception))

    def test_mqtt_auth_error_keeps_safe_diagnostics_and_omits_body(self):
        secret = "must-not-reach-logs"
        error = urllib.error.HTTPError(
            "https://example.invalid/signature",
            503,
            "Service Unavailable",
            {},
            io.BytesIO(f'{{"access_token":"{secret}"}}'.encode()),
        )

        def fail_signature(_client):
            raise error

        AirPlusCloudClient._fetch_signature = fail_signature
        client = AirPlusCloudClient("da-test-uuid", self.token_file)
        output = io.StringIO()

        with redirect_stdout(output):
            with self.assertRaises(ConnectionError) as caught:
                client.connect()

        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn(secret, str(caught.exception))
        self.assertIn("HTTPError", output.getvalue())
        self.assertIn("HTTP 503", output.getvalue())
        self.assertIn("HTTPError", str(caught.exception))
        self.assertIn("HTTP 503", str(caught.exception))
        self.assertIn("upstream response omitted", output.getvalue())
        error.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
