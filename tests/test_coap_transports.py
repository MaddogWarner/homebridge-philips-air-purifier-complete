"""The CoAP client must not depend on optional packages installed on the host.

v5 runs on the system Python instead of an isolated venv, so aiocoap's default
transport probing would see whatever the host has installed.
"""
import asyncio
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import aioairctrl  # noqa: E402,F401  (puts vendor/ on sys.path)
import aiocoap  # noqa: E402
from aioairctrl.coap import client as coap_client  # noqa: E402


class TransportPinningTests(unittest.TestCase):
    def test_vendored_aiocoap_is_used(self):
        vendor = Path(__file__).resolve().parents[1] / "vendor"
        self.assertTrue(Path(aiocoap.__file__).resolve().is_relative_to(vendor))

    def test_client_context_ignores_an_old_system_websockets(self):
        # An old websockets has no websockets.asyncio; with default transport
        # probing aiocoap would add "ws" and fail to create the context.
        fake = types.ModuleType("websockets")
        saved = sys.modules.get("websockets")
        sys.modules["websockets"] = fake
        self.addCleanup(
            lambda: sys.modules.__setitem__("websockets", saved) if saved else sys.modules.pop("websockets", None)
        )

        async def create_and_close():
            ctx = await aiocoap.Context.create_client_context(transports=coap_client.CLIENT_TRANSPORTS)
            await ctx.shutdown()

        asyncio.run(create_and_close())

    def test_transports_match_the_v4_isolated_venv(self):
        expected_udp = "udp6" if sys.platform == "linux" else "simple6"
        self.assertEqual(coap_client.CLIENT_TRANSPORTS, ["tcpclient", "tlsclient", expected_udp])


if __name__ == "__main__":
    unittest.main()
