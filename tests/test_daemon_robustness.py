"""Regression tests: CoAP mode values, CoAP timeouts, observe-task survival,
daemon exit on stdin EOF, single-write IPC lines, Air+ token handling,
observe watchdog and supervisor, command deadlines, client-key wrap, CLI
rejection exit codes and Air+ malformed-message logging."""

import asyncio
import contextlib
import io
import json
import os
import queue
import sys
import threading
import time
import types
import unittest
import urllib.error
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import philips_air_api as api  # noqa: E402
from aioairctrl.coap import client as coap_client  # noqa: E402


# ---------------------------------------------------------------- fakes

class FakeCoapClient:
    """Stands in for aioairctrl's Client inside ObserveDaemon."""

    instances = []
    # Per-instance behaviour, consumed in creation order.
    observe_plan = []

    def __init__(self, fail_observe=False):
        self.fail_observe = fail_observe
        self.sent = []
        self.closed = False

    @classmethod
    def reset(cls, observe_plan=()):
        cls.instances = []
        cls.observe_plan = list(observe_plan)

    @classmethod
    async def create(cls, host, port=5683):
        fail = cls.observe_plan.pop(0) if cls.observe_plan else False
        inst = cls(fail_observe=fail)
        cls.instances.append(inst)
        return inst

    async def observe_status(self):
        if self.fail_observe:
            raise OSError("observation lost")
        yield {"D03102": 1, "D0310C": 0}
        await asyncio.Event().wait()

    async def set_control_value(self, key, value):
        self.sent.append((key, value))
        return True

    async def shutdown(self):
        self.closed = True


@contextlib.contextmanager
def eof_stdin():
    """Replace sys.stdin with a pipe whose writer is already closed."""
    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    stdin = os.fdopen(read_fd, "rb")
    try:
        with mock.patch.object(sys, "stdin", stdin):
            yield
    finally:
        stdin.close()


def _messages(buf):
    return [json.loads(line) for line in buf.getvalue().splitlines()]


# ---------------------------------------------------------------- fix 1

class CoapModeValueTests(unittest.TestCase):
    def test_mode_values_are_coap_values(self):
        self.assertEqual(api.MODE_VALUES["auto"], 0)
        self.assertEqual(api.MODE_VALUES, {"auto": 0, "sleep": 17, "medium": 19, "turbo": 18})

    def test_coap_daemon_encodes_auto_as_zero(self):
        daemon = api.ObserveDaemon("192.0.2.1")
        daemon._client = FakeCoapClient()
        daemon._connected = True

        for mode in ("auto", "sleep", "medium", "turbo"):
            asyncio.run(daemon._execute_command("mode", [mode]))

        self.assertEqual(daemon._client.sent, [
            (api.PARAM_MODE, 0), (api.PARAM_MODE, 17),
            (api.PARAM_MODE, 19), (api.PARAM_MODE, 18),
        ])

    def test_cli_encodes_auto_as_zero(self):
        purifier = api.PhilipsAirPurifier("192.0.2.1")
        purifier._client = FakeCoapClient()
        asyncio.run(purifier.set_mode("AUTO"))
        self.assertEqual(purifier._client.sent, [(api.PARAM_MODE, 0)])


# ---------------------------------------------------------------- fix 2

class _FakeEncryption:
    def encrypt(self, payload):
        return "encrypted"

    def decrypt(self, payload):
        return json.dumps({"state": {"reported": {"D03102": 1}}})

    def set_client_key(self, key):
        pass


class _FakeContext:
    """aiocoap Context whose responses are produced by ``responder``."""

    def __init__(self, responder):
        self.responder = responder
        self.shut_down = False

    def request(self, message):
        return self.responder(message)

    async def shutdown(self):
        self.shut_down = True


def _never_responds(message):
    return types.SimpleNamespace(response=asyncio.get_running_loop().create_future())


def _delayed(payload, delay):
    fut = asyncio.get_running_loop().create_future()
    response = types.SimpleNamespace(payload=payload)
    asyncio.get_running_loop().call_later(
        delay, lambda: fut.done() or fut.set_result(response))
    return fut


def _client_with(responder):
    client = coap_client.Client("192.0.2.1")
    client._client_context = _FakeContext(responder)
    client._encryption_context = _FakeEncryption()
    return client


class CoapTimeoutTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(coap_client.Client, "REQUEST_TIMEOUT", 0.05)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_lost_control_reply_raises_timeout(self):
        async def run():
            client = _client_with(_never_responds)
            started = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "No CoAP response"):
                await client.set_control_value(api.PARAM_POWER, 1)
            return time.monotonic() - started

        self.assertLess(asyncio.run(run()), 1)

    def test_lost_status_reply_raises_timeout(self):
        async def run():
            with self.assertRaises(TimeoutError):
                await _client_with(_never_responds).get_status()

        asyncio.run(run())

    def test_create_times_out_and_releases_context(self):
        context = _FakeContext(_never_responds)

        async def create_context():
            return context

        async def run():
            with mock.patch.object(
                coap_client.Context, "create_client_context", create_context
            ):
                with self.assertRaises(TimeoutError):
                    await coap_client.Client.create("192.0.2.1")

        asyncio.run(run())
        self.assertTrue(context.shut_down, "failed connect leaked its CoAP context")

    def test_retries_are_bounded_by_overall_deadline(self):
        def failing(message):
            if message.opt.uri_path[-1] == "sync":
                return types.SimpleNamespace(response=_delayed(b"ABCD1234", 0.04))
            return types.SimpleNamespace(response=_delayed(b'{"status":"failed"}', 0.04))

        async def run():
            client = _client_with(failing)
            started = time.monotonic()
            with mock.patch.object(coap_client.Client, "REQUEST_TIMEOUT", 1), \
                    mock.patch.object(coap_client.Client, "CONTROL_DEADLINE", 0.2):
                with self.assertRaisesRegex(TimeoutError, "not acknowledged"):
                    await client.set_control_value(api.PARAM_POWER, 1)
            return time.monotonic() - started

        # Unbounded, 6 attempts x (control + resync) x 40ms would take ~0.5s.
        self.assertLess(asyncio.run(run()), 0.4)

    def test_observation_itself_is_not_timed_out(self):
        class _Observation:
            def __init__(self):
                self.sent = False

            def __aiter__(self):
                return self

            async def __anext__(self):
                if self.sent:
                    raise StopAsyncIteration
                # Much longer than REQUEST_TIMEOUT: a quiet device is normal.
                await asyncio.sleep(0.2)
                self.sent = True
                return types.SimpleNamespace(payload=b"x")

        def observe(message):
            return types.SimpleNamespace(
                response=_delayed(b"x", 0), observation=_Observation())

        async def run():
            return [s async for s in _client_with(observe).observe_status()]

        self.assertEqual(len(asyncio.run(run())), 2)


# ---------------------------------------------------------------- fix 3

class ObserveTaskSurvivalTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(api, "Client", FakeCoapClient)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_command_during_backoff_keeps_observe_task_alive(self):
        # First connection's observation fails; the command's fresh
        # connection observes successfully.
        FakeCoapClient.reset(observe_plan=[True, False])

        async def run():
            daemon = api.ObserveDaemon("192.0.2.1")
            daemon._OBSERVE_RETRY_SECONDS = 0.3
            task = daemon._observe_task = asyncio.create_task(daemon._observe_loop())

            await asyncio.sleep(0.05)  # observation failed; loop is backing off
            self.assertTrue(FakeCoapClient.instances[0].closed)
            self.assertFalse(daemon._connected)

            await daemon._handle_request({"id": 1, "cmd": "power", "args": ["on"]})
            self.assertFalse(task.done(), "command cancelled the observe task")
            self.assertEqual(FakeCoapClient.instances[1].sent, [(api.PARAM_POWER, 1)])

            await asyncio.sleep(0.5)  # back-off over; loop resumes observing
            self.assertIs(daemon._observe_task, task)
            self.assertFalse(task.done(), "observe loop cancelled itself")
            self.assertTrue(daemon._observing)
            self.assertIsNotNone(daemon._cached_state)
            # The loop reused the command's connection rather than closing it.
            self.assertEqual(len(FakeCoapClient.instances), 2)
            self.assertFalse(FakeCoapClient.instances[1].closed)

            daemon.shutdown()
            await daemon.disconnect()
            self.assertTrue(task.done())
            self.assertTrue(FakeCoapClient.instances[1].closed)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(run())
        events = [m.get("event") for m in _messages(buf)]
        self.assertNotIn("observe_restart", events)
        self.assertIn({"id": 1, "success": True, "data": {"power": True}}, _messages(buf))

    def test_command_restarts_dead_observe_task(self):
        FakeCoapClient.reset()

        async def run():
            daemon = api.ObserveDaemon("192.0.2.1")

            async def died():
                raise RuntimeError("boom")

            dead = asyncio.create_task(died())
            await asyncio.sleep(0)
            daemon._observe_task = dead

            await daemon._handle_request({"id": 2, "cmd": "ping"})
            self.assertIsNot(daemon._observe_task, dead)
            await asyncio.sleep(0.05)
            self.assertTrue(daemon._observing)

            daemon.shutdown()
            await daemon.disconnect()

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(run())
        self.assertIn("observe_restart", [m.get("event") for m in _messages(buf)])


# ---------------------------------------------------------------- fix 4

class DaemonExitOnEofTests(unittest.TestCase):
    def _run(self, daemon):
        buf = io.StringIO()
        with eof_stdin(), contextlib.redirect_stdout(buf):
            asyncio.run(asyncio.wait_for(daemon.start(), timeout=3))
        types_seen = [m.get("type") for m in _messages(buf)]
        self.assertEqual(types_seen[0], "ready")
        self.assertEqual(types_seen[-1], "shutdown")

    def test_airplus_daemon_exits_on_stdin_eof(self):
        class _StubClient:
            def __init__(self, uuid, token_file):
                self._connected = True
                self._queue = queue.Queue()

            def connect(self):
                pass

            def disconnect(self):
                pass

            def get_status_queue(self):
                return self._queue

            def get_model_id(self):
                return "AC0650"

        with mock.patch.object(api, "AirPlusCloudClient", _StubClient):
            self._run(api.AirPlusCloudDaemon("uuid-1", "/nonexistent-token-file"))

    def test_coap_daemon_exits_on_stdin_eof(self):
        FakeCoapClient.reset()
        with mock.patch.object(api, "Client", FakeCoapClient):
            self._run(api.ObserveDaemon("192.0.2.1"))
        self.assertTrue(FakeCoapClient.instances[0].closed)

    def test_http_daemon_exits_on_stdin_eof(self):
        daemon = api.HTTPPollingDaemon("192.0.2.1")
        daemon._client = types.SimpleNamespace(
            connect=lambda: None, get_status=lambda: {"pwr": "1"})
        self._run(daemon)


# ---------------------------------------------------------------- fix 5

class EmitTests(unittest.TestCase):
    def test_emit_writes_one_complete_line_per_message(self):
        writes = []
        fake_stdout = types.SimpleNamespace(write=writes.append, flush=lambda: None)
        with mock.patch.object(sys, "stdout", fake_stdout):
            api._emit({"type": "log", "message": "hello"})
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0].endswith("\n"))
        self.assertEqual(writes[0].count("\n"), 1)
        self.assertEqual(json.loads(writes[0]), {"type": "log", "message": "hello"})

    def test_concurrent_emits_do_not_interleave(self):
        class _SlowStdout:
            """Splits each write in two with a pause, inviting interleaving."""

            def __init__(self):
                self.chunks = []

            def write(self, text):
                half = len(text) // 2
                self.chunks.append(text[:half])
                time.sleep(0.0005)
                self.chunks.append(text[half:])

            def flush(self):
                pass

        out = _SlowStdout()

        def worker(n):
            for i in range(25):
                api._emit({"type": "update", "thread": n, "i": i})

        with mock.patch.object(sys, "stdout", out):
            threads = [threading.Thread(target=worker, args=(n,)) for n in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        lines = "".join(out.chunks).splitlines()
        self.assertEqual(len(lines), 150)
        for line in lines:
            json.loads(line)


# ---------------------------------------------------------------- fix 6

class _FakeHTTPResponse:
    def __init__(self, body):
        self._body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _http_error(code):
    return urllib.error.HTTPError(
        "https://example.invalid", code, "error", {}, io.BytesIO(b"{}"))


class AirPlusTokenHandlingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        with mock.patch.object(api, "_paho_mqtt", object()):
            self.client = api.AirPlusCloudClient(
                "uuid-1", str(Path(self._tmp.name) / "tokens.json"))
        self.client._tokens = {
            "access_token": "tok-1",
            "refresh_token": "refresh-1",
            "expires_at": time.time() + 3600,
        }

    def test_signature_network_error_does_not_refresh(self):
        for error in (urllib.error.URLError("dns failure"), _http_error(503)):
            with self.subTest(error=type(error).__name__), \
                    mock.patch.object(self.client, "_refresh_token") as refresh, \
                    mock.patch.object(api.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(type(error)):
                    self.client._fetch_signature()
                refresh.assert_not_called()

    def test_signature_401_refreshes_once_and_retries(self):
        responses = [_http_error(401), _FakeHTTPResponse({"signature": "sig-2"})]
        with mock.patch.object(self.client, "_refresh_token") as refresh, \
                mock.patch.object(api.urllib.request, "urlopen", side_effect=responses):
            self.assertEqual(self.client._fetch_signature(), "sig-2")
        refresh.assert_called_once_with()

    def test_api_get_refreshes_expired_token_first(self):
        self.client._tokens["expires_at"] = 0
        seen = []

        def fake_urlopen(request, timeout):
            if request.full_url == api._AIRPLUS_OIDC_TOKEN_URL:
                return _FakeHTTPResponse({"access_token": "tok-2", "expires_in": 3600})
            seen.append(request.get_header("Authorization"))
            return _FakeHTTPResponse([])

        with mock.patch.object(api.urllib.request, "urlopen", fake_urlopen):
            self.client._api_get("/da/user/self/device")
        self.assertEqual(seen, ["Bearer tok-2"])

    def test_concurrent_ensure_token_refreshes_once(self):
        self.client._tokens["expires_at"] = 0
        refreshes = []

        def slow_refresh(request, timeout):
            refreshes.append(threading.get_ident())
            time.sleep(0.1)
            return _FakeHTTPResponse({"access_token": "tok-2", "expires_in": 3600})

        with mock.patch.object(api.urllib.request, "urlopen", slow_refresh):
            threads = [threading.Thread(target=self.client._ensure_token) for _ in range(3)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=3)

        self.assertEqual(len(refreshes), 1)
        saved = json.loads((Path(self._tmp.name) / "tokens.json").read_text())
        self.assertEqual(saved["access_token"], "tok-2")


# ---------------------------------------------------------------- observe watchdog

class _SilentAfterFirstClient(FakeCoapClient):
    """Delivers one notification, then goes quiet without an error."""

    async def observe_status(self):
        yield {"D03102": 1}
        await asyncio.Event().wait()


class _ChattyClient(FakeCoapClient):
    """Notifies every 30ms, i.e. never idle."""

    async def observe_status(self):
        while True:
            yield {"D03102": 1}
            await asyncio.sleep(0.03)


class ObserveWatchdogTests(unittest.TestCase):
    def _run_loop(self, client_cls, seconds):
        client_cls.reset()

        async def run():
            daemon = api.ObserveDaemon("192.0.2.1")
            daemon._OBSERVE_IDLE_SECONDS = 0.1
            daemon._OBSERVE_RETRY_SECONDS = 0.02
            daemon._ensure_observe_task()
            await asyncio.sleep(seconds)
            observing = daemon._observing
            daemon.shutdown()
            await daemon.disconnect()
            return observing

        buf = io.StringIO()
        with mock.patch.object(api, "Client", client_cls), contextlib.redirect_stdout(buf):
            observing = asyncio.run(run())
        return observing, _messages(buf)

    def test_silent_observation_is_dropped_and_resubscribed(self):
        observing, messages = self._run_loop(_SilentAfterFirstClient, 0.2)
        events = [m.get("event") for m in messages]
        self.assertIn("observe_stale", events)
        self.assertNotIn("observe_error", events)
        # The stale client was closed and a fresh one subscribed.
        self.assertGreaterEqual(len(_SilentAfterFirstClient.instances), 2)
        self.assertTrue(_SilentAfterFirstClient.instances[0].closed)
        self.assertTrue(observing)
        self.assertGreaterEqual(events.count("observe"), 2)

    def test_regular_notifications_keep_the_watchdog_quiet(self):
        observing, messages = self._run_loop(_ChattyClient, 0.35)
        self.assertNotIn("observe_stale", [m.get("event") for m in messages])
        self.assertEqual(len(_ChattyClient.instances), 1)
        self.assertTrue(observing)


class ObserveSupervisorTests(unittest.TestCase):
    def test_supervisor_restarts_dead_observe_task_without_commands(self):
        FakeCoapClient.reset()

        async def run():
            daemon = api.ObserveDaemon("192.0.2.1")
            daemon._SUPERVISE_SECONDS = 0.03

            async def died():
                raise RuntimeError("boom")

            dead = daemon._observe_task = asyncio.create_task(died())
            daemon._supervisor_task = asyncio.create_task(daemon._supervise_observe())
            await asyncio.sleep(0.1)
            self.assertIsNot(daemon._observe_task, dead)
            self.assertTrue(daemon._observing)

            supervisor = daemon._supervisor_task
            daemon.shutdown()
            await daemon.disconnect()
            self.assertTrue(supervisor.done())

        buf = io.StringIO()
        with mock.patch.object(api, "Client", FakeCoapClient), contextlib.redirect_stdout(buf):
            asyncio.run(run())
        self.assertIn("observe_restart", [m.get("event") for m in _messages(buf)])


# ---------------------------------------------------------------- command deadlines

def _past_deadline():
    return (time.time() - 1) * 1000


def _future_deadline(seconds=30):
    return (time.time() + seconds) * 1000


class _RecordingHTTPClient:
    def __init__(self, delay=0):
        self.delay = delay
        self.sent = []
        self.deadlines = []

    def connect(self, deadline=None):
        pass

    def set_values(self, values, deadline=None):
        time.sleep(self.delay)
        self.sent.append(values)
        self.deadlines.append(deadline)


class _RecordingAirPlusClient(_RecordingHTTPClient):
    _connected = True

    def ensure_model_id(self):
        return "AC0650"


def _http_daemon(client):
    daemon = api.HTTPPollingDaemon("192.0.2.1")
    daemon._client = client
    daemon._connected = True
    return daemon


def _homeid_daemon(client):
    daemon = api.HomeIDHTTPPollingDaemon("192.0.2.1")
    daemon._client = client
    daemon._connected = True
    return daemon


def _airplus_daemon(client):
    daemon = api.AirPlusCloudDaemon("uuid-1", "/nonexistent-token-file")
    daemon._client = client
    return daemon


class CommandDeadlineTests(unittest.TestCase):
    def _handle(self, daemon, request):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(daemon._handle_request(request))
        return [m for m in _messages(buf) if "id" in m]

    def test_expired_commands_are_not_sent(self):
        expired = {"id": 7, "cmd": "power", "args": ["on"], "deadline": _past_deadline()}
        reply = {"id": 7, "success": False, "error": api.EXPIRED_COMMAND_ERROR}

        coap = api.ObserveDaemon("192.0.2.1")
        coap._client = FakeCoapClient()
        coap._connected = True
        coap._observe_task = mock.Mock(done=lambda: False)  # don't start observing
        self.assertEqual(self._handle(coap, expired), [reply])
        self.assertEqual(coap._client.sent, [])

        for make in (_http_daemon, _homeid_daemon, _airplus_daemon):
            with self.subTest(daemon=make.__name__):
                client = (_RecordingAirPlusClient if make is _airplus_daemon
                          else _RecordingHTTPClient)()
                self.assertEqual(self._handle(make(client), expired), [reply])
                self.assertEqual(client.sent, [])

    def test_commands_within_deadline_or_without_one_still_run(self):
        for deadline in (_future_deadline(), None, True, "soon"):
            for make in (_http_daemon, _airplus_daemon):
                with self.subTest(deadline=deadline, daemon=make.__name__):
                    client = (_RecordingAirPlusClient if make is _airplus_daemon
                              else _RecordingHTTPClient)()
                    request = {"id": 8, "cmd": "power", "args": ["on"]}
                    if deadline is not None:
                        request["deadline"] = deadline
                    replies = self._handle(make(client), request)
                    self.assertEqual(replies, [{"id": 8, "success": True,
                                                "data": {"power": True}}])
                    self.assertEqual(len(client.sent), 1)
                    # The worker thread is handed a monotonic deadline.
                    self.assertGreater(client.deadlines[0], time.monotonic())

    def test_slow_threaded_command_replies_failure_by_the_deadline(self):
        client = _RecordingHTTPClient(delay=0.5)
        request = {"id": 9, "cmd": "power", "args": ["on"], "deadline": _future_deadline(0.15)}
        daemon = _http_daemon(client)

        async def run():
            started = time.monotonic()
            await daemon._handle_request(request)
            # Measured inside the loop: asyncio.run then waits for the thread.
            return time.monotonic() - started

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertLess(asyncio.run(run()), 0.45)
        replies = [m for m in _messages(buf) if "id" in m]
        self.assertEqual(replies[0]["success"], False)
        self.assertIn("did not complete", replies[0]["error"])

    def test_coap_command_is_bounded_by_the_deadline(self):
        class _Hangs(FakeCoapClient):
            async def set_control_value(self, key, value):
                await asyncio.Event().wait()

        daemon = api.ObserveDaemon("192.0.2.1")
        daemon._client = _Hangs()
        daemon._connected = True
        daemon._observe_task = mock.Mock(done=lambda: False)
        request = {"id": 10, "cmd": "power", "args": ["on"], "deadline": _future_deadline(0.1)}
        replies = self._handle(daemon, request)
        self.assertEqual(replies[0]["success"], False)
        self.assertIn("did not complete", replies[0]["error"])


class ThreadDeadlineTests(unittest.TestCase):
    """Worker threads cannot be cancelled, so they must not start a request late."""

    def test_homeid_does_not_retry_auth_after_deadline(self):
        client = api.PhilipsHomeIDHTTPClient(
            "192.0.2.1", client_id="aWQ=", client_secret="c2VjcmV0")
        deadline = time.monotonic() + 0.05
        calls = []

        def slow_401(request, timeout, context):
            calls.append(timeout)
            time.sleep(0.1)
            raise urllib.error.HTTPError(
                "http://x", 401, "auth", {"WWW-Authenticate": "PhilipsCondor AAAAAAAAAAA="},
                None)

        with mock.patch.object(api.urllib.request, "urlopen", slow_401):
            with self.assertRaisesRegex(TimeoutError, "deadline passed"):
                client.set_values({"pwr": "1"}, deadline)
        self.assertEqual(len(calls), 1)
        self.assertLessEqual(calls[0], 0.05)

    def test_http_request_is_not_started_after_deadline(self):
        client = api.PhilipsAirHTTPClient("192.0.2.1")
        client._session_key = bytes(16)
        with mock.patch.object(api.urllib.request, "urlopen") as urlopen:
            with self.assertRaises(TimeoutError):
                client.set_values({"pwr": "1"}, time.monotonic() - 1)
        urlopen.assert_not_called()

    def test_airplus_publishes_nothing_after_deadline(self):
        with mock.patch.object(api, "_paho_mqtt", object()):
            client = api.AirPlusCloudClient("uuid-1", "/nonexistent-token-file")
        client._mqtt = mock.Mock()
        client._connected = True
        client._model_id = "AC0650"
        with self.assertRaises(TimeoutError):
            client.set_values({"power": True, "mode": "auto"}, time.monotonic() - 1)
        client._mqtt.publish.assert_not_called()


# ---------------------------------------------------------------- client key, CLI, MQTT

class ClientKeyWrapTests(unittest.TestCase):
    def test_client_key_wraps_at_32_bits(self):
        from aioairctrl.coap.encryption import EncryptionContext

        ctx = EncryptionContext()
        ctx.set_client_key("FFFFFFFF")
        ctx._increment_client_key()
        self.assertEqual(ctx._client_key, "00000000")
        ctx._increment_client_key()
        self.assertEqual(ctx._client_key, "00000001")


class _RejectingCoapClient(FakeCoapClient):
    async def set_control_value(self, key, value):
        self.sent.append((key, value))
        return False


class CliRejectionTests(unittest.TestCase):
    def test_philips_cli_exits_non_zero_when_device_rejects(self):
        for command, arg in (("power", "on"), ("mode", "auto"), ("light", "0"),
                             ("childlock", "on")):
            _RejectingCoapClient.reset()
            out, err = io.StringIO(), io.StringIO()
            with self.subTest(command=command), \
                    mock.patch.object(api, "Client", _RejectingCoapClient), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = asyncio.run(api.handle_cli_command("192.0.2.1", command, arg))
                self.assertEqual(code, 1)
                self.assertIn("Device rejected", err.getvalue())
                self.assertNotIn(" set to ", out.getvalue())

    def test_aioairctrl_cli_exits_non_zero_when_device_rejects(self):
        from aioairctrl import cli

        class _Rejecting:
            @classmethod
            async def create(cls, host, port):
                return cls()

            async def set_control_values(self, data):
                return False

            async def shutdown(self):
                pass

        args = types.SimpleNamespace(
            debug=False, host="192.0.2.1", port=5683, command="set",
            values=["D03102=1"], value_as_int=True)
        out = io.StringIO()
        with mock.patch.object(cli, "parse_args", return_value=args), \
                mock.patch.object(cli, "CoAPClient", _Rejecting), \
                contextlib.redirect_stdout(out):
            self.assertEqual(asyncio.run(cli.async_main()), 1)
        self.assertIn("Device rejected", out.getvalue())


class AirPlusMessageErrorTests(unittest.TestCase):
    def test_bad_messages_are_logged_by_type_only_and_rate_limited(self):
        with mock.patch.object(api, "_paho_mqtt", object()):
            client = api.AirPlusCloudClient("uuid-1", "/nonexistent-token-file")
        secret = b'{"data": "secret-payload-detail"'  # truncated JSON
        msg = types.SimpleNamespace(payload=secret)
        clock = [1000.0]

        buf = io.StringIO()
        with mock.patch.object(api.time, "monotonic", lambda: clock[0]), \
                contextlib.redirect_stdout(buf):
            client._on_message(None, None, msg)
            client._on_message(None, None, msg)      # within 60s: suppressed
            clock[0] += 61
            client._on_message(None, None, msg)

        logs = _messages(buf)
        self.assertEqual(len(logs), 2)
        for log in logs:
            self.assertEqual(log["event"], "mqtt_message_error")
            self.assertIn("JSONDecodeError", log["message"])
            self.assertNotIn("secret-payload-detail", log["message"])
        self.assertTrue(client._state_queue.empty())


if __name__ == "__main__":
    unittest.main(verbosity=2)


class UrlopenSchemeTests(unittest.TestCase):
    def test_non_http_schemes_are_refused_before_opening(self):
        import urllib.request
        with mock.patch.object(urllib.request, "urlopen") as urlopen:
            for url in ("file:///etc/passwd", "ftp://example.com/x"):
                with self.assertRaises(ValueError):
                    api._urlopen(urllib.request.Request(url))
            urlopen.assert_not_called()

    def test_http_and_https_are_passed_through(self):
        import urllib.request
        with mock.patch.object(urllib.request, "urlopen", return_value="ok") as urlopen:
            for url in ("http://192.0.2.1/di/v1/products/1/air", "https://example.com/token"):
                self.assertEqual(api._urlopen(urllib.request.Request(url), timeout=1), "ok")
            self.assertEqual(urlopen.call_count, 2)
