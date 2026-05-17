#!/usr/bin/env python3
"""
Philips Air Purifier API - Daemon mode with CoAP Observe for Homebridge integration.

Supports two modes:
1. CLI mode: philips_air_api.py <host> <command> [args...]
2. Daemon mode: philips_air_api.py <host> --daemon
   Uses CoAP Observe to receive push updates from device.
   Commands are sent directly (fast), state is received via subscription.

Note: aioairctrl is bundled in the aioairctrl/ directory alongside this script.
      aiocoap and pycryptodomex must be installed (handled by postinstall.sh).
"""
import asyncio
import json
import sys
import signal
import time
from typing import Dict, Any, Optional

from aioairctrl.coap.client import Client


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

MODE_NAMES = {
    MODE_AUTO: "auto",
    MODE_SLEEP: "sleep",
    MODE_MEDIUM: "medium",
    MODE_TURBO: "turbo",
}

MODE_VALUES = {v: k for k, v in MODE_NAMES.items()}


def parse_status(status: Dict[str, Any]) -> Dict[str, Any]:
    """Parse raw device status into normalised sensor data."""
    filter_total = status.get("D05408", 9600)
    filter_remaining = status.get("D0540E", 0)
    filter_life_percent = (filter_remaining / filter_total * 100) if filter_total > 0 else 0

    cleanup_max_interval = status.get("D05207", 720)
    cleanup_time_until_next = status.get("D0520D", 0)
    cleanup_percent = (cleanup_time_until_next / cleanup_max_interval * 100) if cleanup_max_interval > 0 else 0

    mode_value = status.get(PARAM_MODE, 0)
    mode_name = MODE_NAMES.get(mode_value, "unknown")

    return {
        "power": bool(status.get(PARAM_POWER, 0)),
        "mode": mode_value,
        "mode_name": mode_name,
        "pm25": status.get("D03221"),
        "iaql": status.get("D03120"),
        "tvoc": status.get("tvoc"),
        "light_level": status.get(PARAM_LIGHT, 0),
        "child_lock": bool(status.get(PARAM_CHILD_LOCK, 0)),
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


async def run_daemon(host: str):
    """Run the observe daemon."""
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


def main():
    if len(sys.argv) < 3:
        print("Usage: philips_air_api.py <host> <command> [args...]")
        print("       philips_air_api.py <host> --daemon")
        sys.exit(1)
    host = sys.argv[1]
    command = sys.argv[2]
    args = sys.argv[3:]
    if command == "--daemon":
        asyncio.run(run_daemon(host))
    else:
        exit_code = asyncio.run(handle_cli_command(host, command, *args))
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
