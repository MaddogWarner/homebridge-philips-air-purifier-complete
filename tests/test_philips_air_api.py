import asyncio
import base64
import contextlib
import hashlib
import io
import json
import queue
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from philips_air_api import (  # noqa: E402
    AirPlusCloudClient,
    AirPlusCloudDaemon,
    CRYPTO_AVAILABLE,
    HomeIDAESCrypto,
    PhilipsCondorAuth,
    _airplus_control_message,
    _airplus_light_key,
    _airplus_mode_to_dcode,
    parse_status,
)


class ParseStatusTests(unittest.TestCase):
    def test_coap_status_keeps_normalised_mode_name(self):
        sensors = parse_status({
            "D03102": 1,
            "D0310C": 18,
            "D03104": 123,
            "D03103": 0,
            "D03221": 8,
            "D03120": 2,
        })

        self.assertTrue(sensors["power"])
        self.assertEqual(sensors["mode"], "turbo")
        self.assertEqual(sensors["mode_name"], "turbo")
        self.assertEqual(sensors["pm25"], 8)
        self.assertEqual(sensors["iaql"], 2)
        self.assertEqual(sensors["light_level"], 123)
        self.assertFalse(sensors["child_lock"])

    def test_dh_http_status_uses_short_field_names(self):
        sensors = parse_status({
            "pwr": "1",
            "mode": "M",
            "om": "s",
            "pm25": "12",
            "iaql": "4",
            "aqil": "50",
            "cl": "1",
        })

        self.assertTrue(sensors["power"])
        self.assertEqual(sensors["mode"], "sleep")
        self.assertEqual(sensors["mode_name"], "sleep")
        self.assertEqual(sensors["pm25"], 12)
        self.assertEqual(sensors["iaql"], 4)
        self.assertEqual(sensors["light_level"], 115)
        self.assertTrue(sensors["child_lock"])

    def test_homeid_merged_status_defaults_missing_filter_data_to_ok(self):
        sensors = parse_status({
            "pwr": "1",
            "mode": "A",
            "pm25": 5,
            "aqil": "100",
            "cl": False,
            "temp": 22,
            "rh": 48,
        })

        self.assertEqual(sensors["mode"], "auto")
        self.assertEqual(sensors["filter_life_percent"], 100)
        self.assertEqual(sensors["cleanup_percent"], 100)
        self.assertEqual(sensors["temperature"], 22)
        self.assertEqual(sensors["humidity"], 48)


class AirPlusParsStatusTests(unittest.TestCase):
    def test_airplus_d0310d_normalised_to_power(self):
        """D0310D (Air+ MQTT power) is normalised to D03102 so parse_status picks it up."""
        raw = {"D0310D": 1, "D0310C": 18, "D03221": 8}
        result = parse_status(raw)
        self.assertTrue(result["power"])
        self.assertEqual(result["mode"], "turbo")
        self.assertEqual(result["pm25"], 8)

    def test_airplus_ac0650_auto_mode_value_1(self):
        """AC0650 reports auto as D0310C=1, not 0 — must parse as 'auto' not 'unknown'."""
        raw = {"D0310D": 1, "D0310C": 1, "D03221": 5}
        result = parse_status(raw)
        self.assertTrue(result["power"])
        self.assertEqual(result["mode"], "auto")
        self.assertEqual(result["pm25"], 5)

    def test_airplus_d0310d_does_not_overwrite_existing_d03102(self):
        """If D03102 is already present, D0310D must not clobber it."""
        raw = {"D0310D": 0, "D03102": 1, "D0310C": 19}
        result = parse_status(raw)
        # D03102=1 wins; D0310D=0 is ignored
        self.assertTrue(result["power"])
        self.assertEqual(result["mode"], "medium")

    def test_airplus_ac1715_uses_model_specific_mode_values(self):
        raw = {
            "D0310D": 1,
            "D0310C": 1,
            "D03105": 100,
            "D03221": 8,
        }

        result = parse_status(
            raw,
            model_id="AC1715/11",
        )

        self.assertTrue(result["power"])
        self.assertEqual(result["mode"], "medium")
        self.assertEqual(result["pm25"], 8)
        self.assertEqual(result["light_level"], 123)

        raw["D0310C"] = 2
        result = parse_status(
            raw,
            model_id="AC1715/11",
        )
        self.assertEqual(result["mode"], "fast")

    def test_airplus_ac1715_control_profile(self):
        self.assertEqual(
            _airplus_mode_to_dcode("auto", "AC1715/11"),
            0,
        )
        self.assertEqual(
            _airplus_mode_to_dcode("medium", "AC1715/11"),
            1,
        )
        self.assertEqual(
            _airplus_mode_to_dcode("fast", "AC1715/11"),
            2,
        )
        self.assertEqual(
            _airplus_mode_to_dcode("auto", "AC0650"),
            1,
        )
        self.assertEqual(
            _airplus_light_key("AC1715/11"),
            "D03105",
        )
        self.assertEqual(
            _airplus_light_key("AC0650"),
            "D03104",
        )

        command, qos = _airplus_control_message(
            {"D0310C": 2},
            "AC1715/11",
        )
        payload = json.loads(command)

        self.assertEqual(qos, 1)
        self.assertEqual(payload["type"], "command")
        self.assertEqual(payload["ct"], "mobile")
        self.assertEqual(
            payload["data"]["properties"]["D0310C"],
            2,
        )


class AirPlusModelIdRecoveryTests(unittest.TestCase):
    def test_ensure_model_id_retries_fetch_when_unknown(self):
        # Bypass __init__: it requires paho-mqtt, which ensure_model_id
        # does not need.
        client = AirPlusCloudClient.__new__(AirPlusCloudClient)
        client._model_id = None
        client._tokens = {"model_id": "AC1715/11"}

        self.assertIsNone(client.get_model_id())
        self.assertEqual(client.ensure_model_id(), "AC1715/11")
        self.assertEqual(client.get_model_id(), "AC1715/11")

    def test_fetch_model_id_reads_ctn_field(self):
        # Real /da/user/self/device response (observed 2026-08-22): a bare
        # list of devices whose only model field is "ctn" (commercial type
        # number, e.g. "AC1715/11") — no modelId/type/deviceType keys.
        client = AirPlusCloudClient.__new__(AirPlusCloudClient)
        client._uuid = "00000000-0000-4000-8000-000000000000"
        client._tokens = {}
        client._api_get = lambda path: [
            {
                "id": "00000000-0000-4000-8000-000000000000",
                "ctn": "AC1715/11",
                "friendlyName": "Bedroom",
                "isOwner": True,
                "macAddress": "aa:bb:cc:dd:ee:ff",
                "role": "owner",
                "thingName": "da-00000000-0000-4000-8000-000000000000",
            }
        ]
        client._save_tokens = lambda: None

        self.assertEqual(client._fetch_model_id(), "AC1715/11")
        self.assertEqual(client._tokens["model_id"], "AC1715/11")

    def test_fetch_model_id_warns_without_leaking_error_details(self):
        client = AirPlusCloudClient.__new__(AirPlusCloudClient)
        client._uuid = "uuid-1"
        client._tokens = {}

        def fail_lookup(path):
            raise ConnectionError("secret-upstream-detail")

        client._api_get = fail_lookup

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertIsNone(client._fetch_model_id())

        warning = json.loads(output.getvalue())
        self.assertEqual(warning["type"], "warning")
        self.assertEqual(warning["event"], "airplus_model_lookup_failed")
        self.assertIn("ConnectionError", warning["message"])
        self.assertNotIn("secret-upstream-detail", warning["message"])

    def test_mode_command_recovers_model_id_before_validation(self):
        daemon = AirPlusCloudDaemon("uuid-1", "/nonexistent-token-file")
        set_calls = []
        ensure_threads = []
        event_loop_thread = threading.get_ident()

        class _StubClient:
            def get_model_id(self):
                return None

            def ensure_model_id(self):
                ensure_threads.append(threading.get_ident())
                return "AC1715/11"

            def set_values(self, values):
                set_calls.append(values)

        daemon._client = _StubClient()

        result = asyncio.run(daemon._execute_command("mode", ["fast"]))

        self.assertEqual(result, {"mode": "fast"})
        self.assertEqual(set_calls, [{"mode": "fast"}])
        self.assertEqual(len(ensure_threads), 1)
        self.assertNotEqual(ensure_threads[0], event_loop_thread)

    def test_mode_command_warns_before_using_generic_fallback(self):
        daemon = AirPlusCloudDaemon("uuid-1", "/nonexistent-token-file")
        set_calls = []

        class _StubClient:
            def ensure_model_id(self):
                return None

            def set_values(self, values):
                set_calls.append(values)

        daemon._client = _StubClient()

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = asyncio.run(daemon._execute_command("mode", ["auto"]))

        warning = json.loads(output.getvalue())
        self.assertEqual(warning["type"], "warning")
        self.assertEqual(warning["event"], "airplus_model_unknown")
        self.assertEqual(result, {"mode": "auto"})
        self.assertEqual(set_calls, [{"mode": "auto"}])


class AirPlusTokenFileTests(unittest.TestCase):
    def test_concurrent_token_writes_are_serialised(self):
        import philips_air_api as api

        with TemporaryDirectory() as tmp_dir:
            token_file = str(Path(tmp_dir) / "tokens.json")
            with mock.patch.object(api, "_paho_mqtt", object()):
                client = AirPlusCloudClient("uuid-1", token_file)

            client._tokens = {
                "access_token": "access-1",
                "refresh_token": "refresh-1",
                "id_token": "id-1",
                "expires_at": 1_000_000,
            }

            real_dump = json.dump
            active_lock = threading.Lock()
            start = threading.Barrier(3)
            errors = []
            active_writers = 0
            max_active_writers = 0

            def slow_dump(*args, **kwargs):
                nonlocal active_writers, max_active_writers
                with active_lock:
                    active_writers += 1
                    max_active_writers = max(max_active_writers, active_writers)
                try:
                    threading.Event().wait(0.05)
                    return real_dump(*args, **kwargs)
                finally:
                    with active_lock:
                        active_writers -= 1

            def save_tokens():
                try:
                    start.wait()
                    client._save_tokens()
                except Exception as error:
                    errors.append(error)

            threads = [threading.Thread(target=save_tokens) for _ in range(2)]
            with mock.patch.object(api.json, "dump", side_effect=slow_dump):
                for thread in threads:
                    thread.start()
                start.wait()
                for thread in threads:
                    thread.join(timeout=2)

            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(errors, [])
            self.assertEqual(max_active_writers, 1)

            saved = json.loads(Path(token_file).read_text())
            self.assertEqual(saved["refresh_token"], "refresh-1")
            self.assertTrue(saved["refresh_token"])


class AirPlusCloudDaemonMessageTests(unittest.TestCase):
    def test_cloud_daemon_update_includes_model_id(self):
        daemon = AirPlusCloudDaemon("uuid-1", "/nonexistent-token-file")
        raw = {"D0310D": 1, "D0310C": 1, "D03105": 100, "D03221": 8}

        class _StubQueue:
            def __init__(self):
                self._served = False

            def get(self, block=True, timeout=None):
                if self._served:
                    daemon.shutdown()
                    raise queue.Empty
                self._served = True
                return raw

        class _StubClient:
            def __init__(self):
                self._queue = _StubQueue()
                # _state_loop consults this before publishing an update.
                self._connected = True

            def get_status_queue(self):
                return self._queue

            def get_model_id(self):
                return "AC1715/11"

        daemon._client = _StubClient()

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(daemon._state_loop())

        messages = [json.loads(line) for line in buf.getvalue().splitlines()]
        updates = [m for m in messages if m["type"] == "update"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["model_id"], "AC1715/11")
        self.assertEqual(updates[0]["data"]["mode"], "medium")

    def test_cloud_daemon_ready_includes_model_id(self):
        import philips_air_api as api

        class _StubClient:
            def __init__(self, uuid, token_file):
                pass

            def connect(self):
                pass

            def disconnect(self):
                pass

            def get_status_queue(self):
                return queue.Queue()

            def get_model_id(self):
                return "AC1715/11"

        daemon = AirPlusCloudDaemon("uuid-1", "/nonexistent-token-file")
        daemon.shutdown()

        async def _no_commands():
            pass

        daemon._process_commands = _no_commands

        original = api.AirPlusCloudClient
        api.AirPlusCloudClient = _StubClient
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                asyncio.run(daemon.start())
        finally:
            api.AirPlusCloudClient = original

        messages = [json.loads(line) for line in buf.getvalue().splitlines()]
        ready = [m for m in messages if m["type"] == "ready"]
        self.assertEqual(len(ready), 1)
        self.assertTrue(ready[0]["connected"])
        self.assertEqual(ready[0]["model_id"], "AC1715/11")


class HomeIDCryptoTests(unittest.TestCase):
    def test_homeid_aes_round_trip(self):
        if not CRYPTO_AVAILABLE:
            self.skipTest("pycryptodomex is not installed in this Python environment")

        key = "00112233445566778899aabbccddeeff"
        payload = {"pwr": "1", "mode": "A"}

        encrypted = HomeIDAESCrypto.encrypt(payload, key)
        decrypted = HomeIDAESCrypto.decrypt(encrypted, key)

        self.assertEqual(decrypted, '{"pwr": "1", "mode": "A"}')

    def test_philips_condor_auth_response(self):
        challenge = b"12345678"
        client_id = b"client-id-123456"
        client_secret = b"client-secret-123456"
        challenge_header = "PHILIPS-Condor " + base64.b64encode(challenge).decode()
        client_id_b64 = base64.b64encode(client_id).decode()
        client_secret_b64 = base64.b64encode(client_secret).decode()

        response = PhilipsCondorAuth.create_credentials(
            challenge_header,
            client_id_b64,
            client_secret_b64,
        )

        expected_digest = hashlib.sha256(challenge + client_id + client_secret).digest()
        expected = "PHILIPS-Condor " + base64.b64encode(client_id + expected_digest).decode()
        self.assertEqual(response, expected)


if __name__ == "__main__":
    unittest.main()
