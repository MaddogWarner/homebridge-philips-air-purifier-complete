#!/usr/bin/env python3
"""
probe_devices.py — Standalone script to probe Philips air purifier devices
for local protocol compatibility.

Usage:
    python scripts/probe_devices.py 192.168.1.10 192.168.1.11 ...

For each IP, tries:
  - TCP connect on port 5683 (CoAP)
  - TCP connect on port 80 (HTTP)
  - HTTP GET /di/v1/products/0/security (DH/AES HTTP protocol)
  - HTTP GET /di/v1/products/0/device   (HomeID protocol probe)

Timeout: 2 seconds per check. No external deps — stdlib only.
"""

import socket
import sys
import urllib.request
import urllib.error
from typing import List, Tuple


TIMEOUT = 2  # seconds per check


def tcp_connect(host: str, port: int) -> bool:
    """Try a TCP connection. Returns True if successful."""
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT):
            return True
    except OSError:
        return False


def http_get(url: str) -> Tuple[bool, int, str]:
    """
    Try an HTTP GET. Returns (reachable, status_code, note).
    A 401 still counts as reachable — it means the device responded.
    """
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return True, r.status, "OK"
    except urllib.error.HTTPError as e:
        # HTTP errors (401, 404, etc.) still mean the device is reachable
        return True, e.code, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, 0, str(e.reason)
    except OSError as e:
        return False, 0, str(e)


def probe_device(host: str) -> dict:
    """Run all protocol probes against a single host."""
    results = {}

    # CoAP: port 5683/UDP — we test TCP as a basic reachability indicator only.
    # True CoAP requires aiocoap; this just checks if the port is open.
    results["coap_port_5683"] = tcp_connect(host, 5683)

    # HTTP port 80
    results["http_port_80"] = tcp_connect(host, 80)

    # DH/AES HTTP: GET /di/v1/products/0/security
    # A 200 or 401 means device is on this protocol
    if results["http_port_80"]:
        reachable, code, note = http_get(f"http://{host}/di/v1/products/0/security")
        results["http_security_endpoint"] = reachable
        results["http_security_status"] = code if reachable else None
        results["http_security_note"] = note
    else:
        results["http_security_endpoint"] = False
        results["http_security_status"] = None
        results["http_security_note"] = "port 80 closed"

    # HomeID: GET /di/v1/products/0/device (or /1/device)
    if results["http_port_80"]:
        reachable, code, note = http_get(f"http://{host}/di/v1/products/0/device")
        if not reachable:
            reachable, code, note = http_get(f"http://{host}/di/v1/products/1/device")
        results["homeid_device_endpoint"] = reachable
        results["homeid_device_status"] = code if reachable else None
        results["homeid_device_note"] = note
    else:
        results["homeid_device_endpoint"] = False
        results["homeid_device_status"] = None
        results["homeid_device_note"] = "port 80 closed"

    return results


def infer_protocol(r: dict) -> str:
    """Guess the most likely protocol from probe results."""
    guesses = []
    if r["coap_port_5683"]:
        guesses.append("coap (port 5683 open)")
    if r["homeid_device_endpoint"]:
        guesses.append("homeid-http")
    if r["http_security_endpoint"] and r.get("http_security_status") in (200, 401):
        guesses.append("http (DH/AES)")
    return ", ".join(guesses) if guesses else "unknown / unreachable"


def print_report(host: str, r: dict) -> None:
    """Print a formatted probe report for one host."""
    print(f"\n=== {host} ===")

    status = lambda ok: "PASS" if ok else "FAIL"

    print(f"  CoAP port 5683 (TCP)   : {status(r['coap_port_5683'])}")
    print(f"  HTTP port 80  (TCP)    : {status(r['http_port_80'])}")

    sec_ok = r["http_security_endpoint"]
    sec_code = r.get("http_security_status")
    sec_note = r.get("http_security_note", "")
    print(f"  HTTP /security endpoint: {status(sec_ok)}  (status={sec_code}, {sec_note})")

    dev_ok = r["homeid_device_endpoint"]
    dev_code = r.get("homeid_device_status")
    dev_note = r.get("homeid_device_note", "")
    print(f"  HomeID /device endpoint: {status(dev_ok)}  (status={dev_code}, {dev_note})")

    print(f"  --> Suggested protocol : {infer_protocol(r)}")


def main(hosts: List[str]) -> int:
    if not hosts:
        print("Usage: python scripts/probe_devices.py <ip1> [ip2] ...")
        print("\nProbes each IP for CoAP (port 5683), HTTP DH/AES, and HomeID protocol support.")
        return 1

    any_found = False
    for host in hosts:
        host = host.strip()
        if not host:
            continue
        r = probe_device(host)
        print_report(host, r)
        if any(v for k, v in r.items() if k.endswith("_endpoint") or k.endswith("_port_5683") or k.endswith("_port_80")):
            any_found = True

    print()
    return 0 if any_found else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
