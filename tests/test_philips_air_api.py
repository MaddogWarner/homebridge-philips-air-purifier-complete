import base64
import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from philips_air_api import (  # noqa: E402
    CRYPTO_AVAILABLE,
    HomeIDAESCrypto,
    PhilipsCondorAuth,
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
