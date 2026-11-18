"""Exercise the real CoAP command/readback paths with no device connection."""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import philips_air_api as api


class CoapModeTests(unittest.IsolatedAsyncioTestCase):
    async def test_daemon_sends_canonical_codes_for_both_affected_families(self):
        for model in ("AC2220/10", "AC0950/10"):
            daemon = api.ObserveDaemon("offline.invalid")
            daemon._cached_state = {"D01S05": model, "D03102": 0, "D0310C": 19}
            daemon._send_control = mock.AsyncMock()
            for mode, code in (("auto", 0), ("sleep", 17), ("medium", 19), ("turbo", 18)):
                with self.subTest(model=model, mode=mode):
                    result = await daemon._execute_command("mode", [mode])
                    daemon._send_control.assert_awaited_with("D0310C", code)
                    self.assertEqual(result, {"mode": mode})

    async def test_cli_auto_sends_zero(self):
        client = api.PhilipsAirPurifier("offline.invalid")
        client._client = mock.AsyncMock()
        await client.set_mode("AUTO")
        client._client.set_control_value.assert_awaited_once_with("D0310C", 0)

    async def test_daemon_cached_sensors_and_mode_agree(self):
        daemon = api.ObserveDaemon("offline.invalid")
        for code, expected in ((0, "auto"), (1, "unknown"), (19, "medium"), (255, "unknown")):
            with self.subTest(code=code):
                daemon._cached_state = {"D03102": 1, "D0310C": code}
                sensors = await daemon._execute_command("sensors", [])
                mode = await daemon._execute_command("mode", [])
                self.assertEqual(sensors["mode"], expected)
                self.assertEqual(sensors["mode_name"], expected)
                self.assertEqual(mode, {"mode": expected})

    async def test_sensors_waiting_for_first_report_uses_coap_mapping(self):
        daemon = api.ObserveDaemon("offline.invalid")

        async def deliver_status(_delay):
            daemon._cached_state = {"D03102": 1, "D0310C": 1}

        with mock.patch.object(api.asyncio, "sleep", side_effect=deliver_status):
            result = await daemon._execute_command("sensors", [])
        self.assertEqual(result["mode"], "unknown")

    async def test_observe_updates_use_coap_mapping(self):
        daemon = api.ObserveDaemon("offline.invalid")

        async def reports():
            for code in (1, 0, 19):
                yield {"D03102": 1, "D0310C": code}
            daemon._shutdown_event.set()

        daemon._connected = True
        daemon._client = mock.Mock()
        daemon._client.observe_status = reports
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            await daemon._observe_loop()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        modes = [m["data"]["mode"] for m in messages if m.get("type") == "update"]
        self.assertEqual(modes, ["unknown", "auto", "medium"])

    async def test_cli_sensor_read_uses_coap_mapping(self):
        client = api.PhilipsAirPurifier("offline.invalid")
        client._client = mock.AsyncMock()
        client._client.get_status.return_value = {"D03102": 1, "D0310C": 1}
        result = await client.get_sensors()
        self.assertEqual(result["mode"], "unknown")


class ProtocolIsolationTests(unittest.TestCase):
    def test_cloud_alias_does_not_leak_into_coap_readback(self):
        status = {"D0310C": 1}
        self.assertEqual(api.parse_status(status)["mode"], "auto")
        self.assertEqual(api.parse_status(status, protocol="coap")["mode"], "unknown")
        self.assertEqual(api.parse_status(status, "AC1715/11")["mode"], "medium")

    def test_cloud_commands_keep_their_model_specific_auto_codes(self):
        self.assertEqual(api._airplus_mode_to_dcode("auto", "AC0650"), 1)
        self.assertEqual(api._airplus_mode_to_dcode("auto", "AC1715/11"), 0)

    def test_http_modes_are_unchanged(self):
        self.assertEqual(api.parse_status({"pwr": "1", "mode": "A"})["mode"], "auto")
        self.assertEqual(api.parse_status({"pwr": "1", "mode": "M", "om": "2"})["mode"], "medium")


if __name__ == "__main__":
    unittest.main()
