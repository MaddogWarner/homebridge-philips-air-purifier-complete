"""Bundled vendor/ packages win over system copies, and only CoAP needs aiocoap.

Each case runs in a fresh interpreter so sys.path and sys.modules start clean.
"""
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_python(code, extra_path=None):
    prelude = f"import sys\nsys.path.insert(0, {str(ROOT)!r})\n"
    if extra_path:
        prelude += f"sys.path.insert(0, {str(extra_path)!r})\n"
    return subprocess.run(
        [sys.executable, "-I", "-B", "-c", prelude + textwrap.dedent(code)],
        capture_output=True, text=True, timeout=60,
    )


class BundlingTests(unittest.TestCase):
    def test_vendor_wins_over_system_copies(self):
        with tempfile.TemporaryDirectory() as site:
            # Shadow packages that would be picked up if vendor/ didn't win.
            for package in ("aiocoap", "paho"):
                (Path(site) / package).mkdir()
                (Path(site) / package / "__init__.py").write_text("raise ImportError('system copy used')\n")
            result = run_python(
                """
                import aioairctrl, aiocoap, paho.mqtt.client
                print(aiocoap.__file__)
                print(paho.mqtt.client.__file__)
                """,
                extra_path=site,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        for line in result.stdout.splitlines():
            self.assertTrue(Path(line).resolve().is_relative_to(ROOT / "vendor"), line)

    def test_broken_aiocoap_only_disables_coap(self):
        result = run_python(
            """
            import builtins
            real_import = builtins.__import__
            def fake_import(name, *args, **kwargs):
                if name.startswith("aiocoap"):
                    raise ImportError("simulated broken aiocoap")
                return real_import(name, *args, **kwargs)
            builtins.__import__ = fake_import
            import philips_air_api as api
            assert api.COAP_AVAILABLE is False
            assert api._paho_mqtt is not None
            assert api.HomeIDAESCrypto.decrypt(api.HomeIDAESCrypto.encrypt({"pwr": "1"}, "00" * 16), "00" * 16)
            print("ok")
            """
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ok")

    def test_aes_import_does_not_load_aiocoap(self):
        result = run_python(
            """
            import aioairctrl.aes
            print("aiocoap" in sys.modules)
            """
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "False")


if __name__ == "__main__":
    unittest.main()
