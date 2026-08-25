"""Regression tests: the Air+ cloud daemon must die when Homebridge stops it.

``main()`` used to register the SIGINT/SIGTERM handlers on the loop returned
by ``asyncio.get_event_loop()`` and then run the daemon on the *different*
loop created by ``asyncio.run()``. Signal handlers belong to the loop they
were added to, so the callback was queued on a loop that never ran — while
the registration had already replaced the process-default disposition. The
signal was therefore swallowed rather than acted on, and every Homebridge
restart stranded another daemon holding the previous MQTT session.

These tests drive ``main()`` itself, since that is where the two loops were
created, and assert against the loop the daemon actually runs on.
"""

import asyncio
import os
import signal
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import philips_air_api  # noqa: E402

DAEMON_ARGV = [
    "philips_air_api.py",
    "cloud",  # index.js passes 'cloud' as the unused host placeholder
    "--daemon",
    "--protocol",
    "airplus-cloud",
    "--device-uuid",
    "test-uuid",
    "--token-file",
    "/tmp/token.json",
]

POSIX_SIGNALS = sys.platform != "win32"


class RecordingDaemon:
    """Stands in for AirPlusCloudDaemon and inspects its own event loop."""

    instances = []

    def __init__(self, device_uuid, token_file):
        self.device_uuid = device_uuid
        self.token_file = token_file
        self.handlers_on_running_loop = {}
        self.shutdown_calls = 0
        RecordingDaemon.instances.append(self)

    def shutdown(self):
        self.shutdown_calls += 1

    async def start(self):
        loop = asyncio.get_running_loop()
        # remove_signal_handler() reports whether *this* loop owns a handler
        # for the signal, which is precisely what the bug got wrong.
        for sig in (signal.SIGINT, signal.SIGTERM):
            self.handlers_on_running_loop[sig] = loop.remove_signal_handler(sig)


class SelfSignallingDaemon(RecordingDaemon):
    """Sends itself SIGTERM and waits for the handler to answer."""

    async def start(self):
        self._done = asyncio.Event()
        os.kill(os.getpid(), signal.SIGTERM)
        # If the handler landed on a loop that never runs, the signal is
        # swallowed and this times out instead of killing the test runner.
        await asyncio.wait_for(self._done.wait(), timeout=5)

    def shutdown(self):
        super().shutdown()
        self._done.set()


class AirPlusDaemonShutdownTest(unittest.TestCase):
    def setUp(self):
        RecordingDaemon.instances = []

    def _run_main(self, daemon_cls):
        with mock.patch.object(philips_air_api, "AirPlusCloudDaemon", daemon_cls), \
                mock.patch.object(sys, "argv", DAEMON_ARGV):
            philips_air_api.main()
        self.assertEqual(len(daemon_cls.instances), 1)
        return daemon_cls.instances[0]

    @unittest.skipUnless(POSIX_SIGNALS, "POSIX signal handling only")
    def test_shutdown_handlers_are_bound_to_the_daemons_own_loop(self):
        daemon = self._run_main(RecordingDaemon)
        self.assertEqual(daemon.device_uuid, "test-uuid")
        self.assertEqual(daemon.token_file, "/tmp/token.json")
        self.assertTrue(
            daemon.handlers_on_running_loop[signal.SIGTERM],
            "SIGTERM handler was not registered on the loop running the daemon",
        )
        self.assertTrue(
            daemon.handlers_on_running_loop[signal.SIGINT],
            "SIGINT handler was not registered on the loop running the daemon",
        )

    @unittest.skipUnless(POSIX_SIGNALS, "POSIX signal handling only")
    def test_sigterm_reaches_shutdown_and_the_daemon_returns(self):
        daemon = self._run_main(SelfSignallingDaemon)
        self.assertEqual(daemon.shutdown_calls, 1)


if __name__ == "__main__":
    unittest.main()
