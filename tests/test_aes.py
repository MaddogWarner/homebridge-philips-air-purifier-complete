"""Pin the bundled pure-Python AES to published vectors and to pycryptodomex.

tests/fixtures/aes_vectors.json was recorded from pycryptodomex and the
v4.3.0 (Cryptodome-based) plugin crypto code, so passing these proves the
replacement is byte-for-byte compatible on every path the plugin uses.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aioairctrl.aes import AES, pad, unpad  # noqa: E402
from aioairctrl.coap.encryption import EncryptionContext  # noqa: E402
import philips_air_api  # noqa: E402
from philips_air_api import HomeIDAESCrypto, PhilipsAirHTTPClient  # noqa: E402

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "aes_vectors.json").read_text())


class PublishedVectorTests(unittest.TestCase):
    def test_fips197_appendix_c(self):
        plaintext = bytes.fromhex("00112233445566778899aabbccddeeff")
        cases = [
            ("000102030405060708090a0b0c0d0e0f", "69c4e0d86a7b0430d8cdb78070b4c55a"),
            ("000102030405060708090a0b0c0d0e0f1011121314151617", "dda97ca4864cdfe06eaf70a0ec0d7191"),
            ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
             "8ea2b7ca516745bfeafc49904b496089"),
        ]
        for key, expected in cases:
            with self.subTest(key_bits=len(key) * 4):
                # One CBC block with a zero IV is a single raw AES block.
                key_bytes = bytes.fromhex(key)
                self.assertEqual(AES.new(key_bytes, AES.MODE_CBC, iv=bytes(16)).encrypt(plaintext).hex(), expected)
                self.assertEqual(
                    AES.new(key_bytes, AES.MODE_CBC, iv=bytes(16)).decrypt(bytes.fromhex(expected)), plaintext
                )

    def test_sp800_38a_f21_cbc_aes128(self):
        key = bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c")
        iv = bytes(range(16))
        plaintext = bytes.fromhex(
            "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51"
            "30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710"
        )
        ciphertext = bytes.fromhex(
            "7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2"
            "73bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7"
        )
        self.assertEqual(AES.new(key, AES.MODE_CBC, iv=iv).encrypt(plaintext), ciphertext)
        self.assertEqual(AES.new(key, AES.MODE_CBC, iv=iv).decrypt(ciphertext), plaintext)


class RecordedVectorTests(unittest.TestCase):
    def test_cbc_matches_pycryptodomex(self):
        for case in VECTORS["cbc"]:
            key, iv = bytes.fromhex(case["key"]), bytes.fromhex(case["iv"])
            plaintext, ciphertext = bytes.fromhex(case["plaintext"]), bytes.fromhex(case["ciphertext"])
            with self.subTest(key_bits=len(key) * 8, blocks=len(plaintext) // 16):
                self.assertEqual(AES.new(key, AES.MODE_CBC, iv=iv).encrypt(plaintext), ciphertext)
                self.assertEqual(AES.new(key, AES.MODE_CBC, iv=iv).decrypt(ciphertext), plaintext)

    def test_pkcs7_cbc_matches_pycryptodomex(self):
        for case in VECTORS["pkcs7_cbc_zero_iv"]:
            key = bytes.fromhex(case["key"])
            plaintext, ciphertext = bytes.fromhex(case["plaintext"]), bytes.fromhex(case["ciphertext"])
            with self.subTest(length=len(plaintext)):
                encrypted = AES.new(key, AES.MODE_CBC, iv=bytes(16)).encrypt(pad(plaintext, 16, style="pkcs7"))
                self.assertEqual(encrypted, ciphertext)
                decrypted = AES.new(key, AES.MODE_CBC, iv=bytes(16)).decrypt(ciphertext)
                self.assertEqual(unpad(decrypted, 16, style="pkcs7"), plaintext)

    def test_coap_encryption_context_matches_v4(self):
        for case in VECTORS["coap_encryption_context"]:
            with self.subTest(client_key=case["client_key"]):
                ctx = EncryptionContext()
                ctx.set_client_key(case["client_key"])
                self.assertEqual(ctx.encrypt(case["payload"]), case["encrypted"])
                self.assertEqual(EncryptionContext().decrypt(case["encrypted"]), case["payload"])

    def test_homeid_crypto_matches_v4(self):
        for case in VECTORS["homeid"]:
            with self.subTest(hex_key=case["hex_key"]):
                encrypted = HomeIDAESCrypto.encrypt(case["values"], case["hex_key"])
                self.assertEqual(encrypted.decode(), case["encrypted"])
                self.assertEqual(json.loads(HomeIDAESCrypto.decrypt(encrypted, case["hex_key"])), case["values"])


    def test_http_dh_client_matches_v4(self):
        # Full HTTP path: DH key exchange + session-key unwrap, then the
        # "AA"-prefixed command encryption and the 2-byte-prefixed replies.
        for case in VECTORS["http_dh_client"]:
            with self.subTest(session_key=case["session_key"]):
                client = PhilipsAirHTTPClient("192.0.2.1")
                with mock.patch.object(philips_air_api.secrets, "randbits",
                                       return_value=int(case["client_private_key"], 16)), \
                        mock.patch.object(client, "_http", return_value=case["security_response"].encode()):
                    client.connect()
                self.assertEqual(client._session_key.hex(), case["session_key"])
                self.assertEqual(client._encrypt(case["values"]).decode(), case["encrypted"])
                self.assertEqual(client._decrypt(case["device_reply"].encode()), case["decrypted_reply"])


class ErrorHandlingTests(unittest.TestCase):
    def test_rejects_bad_key_iv_and_unaligned_data(self):
        with self.assertRaises(ValueError):
            AES.new(bytes(15), AES.MODE_CBC, iv=bytes(16))
        with self.assertRaises(ValueError):
            AES.new(bytes(16), AES.MODE_CBC, iv=bytes(8))
        with self.assertRaises(ValueError):
            AES.new(bytes(16), AES.MODE_CBC, iv=bytes(16)).encrypt(bytes(17))
        with self.assertRaises(ValueError):
            AES.new(bytes(16), 1, iv=bytes(16))

    def test_rejects_non_bytes_input(self):
        # bytes(16) would silently become an all-zero key.
        for bad in (16, "0" * 16, None):
            with self.subTest(value=bad), self.assertRaises(TypeError):
                AES.new(bad, AES.MODE_CBC, iv=bytes(16))
        with self.assertRaises(TypeError):
            AES.new(bytes(16), AES.MODE_CBC, iv=16)
        with self.assertRaises(TypeError):
            AES.new(bytes(16), AES.MODE_CBC, iv=bytes(16)).encrypt(32)
        with self.assertRaises(TypeError):
            pad(16, 16)
        with self.assertRaises(TypeError):
            unpad(16, 16)
        # bytearray and memoryview are still accepted.
        AES.new(bytearray(16), AES.MODE_CBC, iv=memoryview(bytes(16))).encrypt(bytearray(16))

    def test_unpad_rejects_corrupt_padding(self):
        for bad in (b"", bytes(15), bytes(15) + b"\x00", bytes(15) + b"\x11", bytes(14) + b"\x01\x02"):
            with self.subTest(data=bad.hex()), self.assertRaises(ValueError):
                unpad(bad, 16, style="pkcs7")


if __name__ == "__main__":
    unittest.main()
