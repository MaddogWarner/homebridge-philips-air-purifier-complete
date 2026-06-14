#!/usr/bin/env python3
"""
airplus_setup.py — One-time OAuth2/PKCE setup for the Philips Air+ cloud protocol.

Completes the OAuth2 authorisation code flow with PKCE, lists devices registered
in the Philips Air+ app, and saves tokens to ~/.homebridge/philips-airplus-{uuid}.json.

Usage:
    python scripts/airplus_setup.py

No external deps required — stdlib only.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time
import urllib.parse
import urllib.request
import urllib.error


# OAuth2 / OIDC constants
OIDC_ISSUER = "https://cdc.accounts.home.id/oidc/op/v1.0"
TENANT = "4_JGZWlP8eQHpEqkvQElolbA"
CLIENT_ID = "-XsK7O6iEkLml77yDGDUi0ku"
REDIRECT_URI = "com.philips.air://loginredirect"
SCOPES = (
    "openid email profile address "
    "DI.Account.read DI.Account.write "
    "DI.AccountProfile.read DI.AccountProfile.write "
    "DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write "
    "DI.GeneralConsent.read subscriptions profile_extended consents "
    "DI.AccountSubscription.read DI.AccountSubscription.write"
)

TOKEN_ENDPOINT = f"{OIDC_ISSUER}/{TENANT}/token"
AUTHORIZE_ENDPOINT = f"{OIDC_ISSUER}/{TENANT}/authorize"

API_BASE = "https://prod.eu-da.iot.versuni.com/api"
USER_AGENT = "okhttp/4.12.0 (Android 14; Pixel 7)"


def _pkce_pair() -> tuple[str, str]:
    """Generate a (code_verifier, code_challenge) PKCE pair."""
    code_verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return code_verifier, code_challenge


def _build_authorize_url(code_challenge: str, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return f"{AUTHORIZE_ENDPOINT}?{urllib.parse.urlencode(params)}"


def _exchange_code(code: str, code_verifier: str) -> dict:
    """Exchange an authorisation code for tokens."""
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": code_verifier,
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
    }).encode()
    req = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"Token exchange failed (HTTP {e.code}): {body}") from e


def _api_get(path: str, access_token: str) -> dict:
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {access_token}",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"API GET {path} failed (HTTP {e.code}): {body}") from e


def _save_tokens(uuid: str, access_token: str, refresh_token: str, expires_at: float) -> str:
    """Save token file to ~/.homebridge/philips-airplus-{uuid}.json with 0o600 permissions."""
    homebridge_dir = os.path.join(os.path.expanduser("~"), ".homebridge")
    os.makedirs(homebridge_dir, exist_ok=True)
    token_path = os.path.join(homebridge_dir, f"philips-airplus-{uuid}.json")
    payload = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
        "expires_at": expires_at,
    }
    tmp_path = token_path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(payload, f, indent=2)
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, token_path)
    os.chmod(token_path, 0o600)
    return token_path


def _extract_code_from_redirect(redirect_url: str) -> tuple[str, str]:
    """Extract the 'code' and 'state' params from the pasted redirect URL."""
    parsed = urllib.parse.urlparse(redirect_url.strip())
    # Handle both standard query string and fragment
    query_string = parsed.query or parsed.fragment
    params = urllib.parse.parse_qs(query_string)
    code_list = params.get("code")
    state_list = params.get("state")
    if not code_list:
        # Try regex fallback
        m = re.search(r"[?&#]code=([^&]+)", redirect_url)
        if m:
            code_list = [urllib.parse.unquote(m.group(1))]
    if not code_list:
        raise ValueError("Could not find 'code' parameter in the redirect URL.")
    code = code_list[0]
    state = state_list[0] if state_list else ""
    return code, state


def _print_devices(devices: list) -> None:
    print("\nDevices registered in Philips Air+:")
    print(f"  {'#':<4} {'Name':<30} {'UUID':<40} {'Type/Model'}")
    print(f"  {'-'*4} {'-'*30} {'-'*40} {'-'*20}")
    for i, d in enumerate(devices, 1):
        name = d.get("name") or d.get("friendlyName") or "(unknown)"
        uuid = d.get("uuid") or d.get("id") or "(none)"
        model = d.get("modelId") or d.get("type") or d.get("deviceType") or "(unknown)"
        print(f"  {i:<4} {name:<30} {uuid:<40} {model}")


def main() -> int:
    print("Philips Air+ OAuth2/PKCE Setup")
    print("=" * 40)

    # Step 1: Generate PKCE pair + state
    code_verifier, code_challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)

    # Step 2: Build and print the authorize URL
    auth_url = _build_authorize_url(code_challenge, state)
    print("\nStep 1: Open this URL in your browser and log in to your Philips account:")
    print(f"\n  {auth_url}\n")
    print("After logging in, the browser will try to open a URL starting with:")
    print(f"  {REDIRECT_URI}?code=...")
    print("It will fail to load (that's expected). Copy the full URL from the address bar.")

    # Step 3: Prompt for the redirect URL
    print()
    redirect_url = input("Paste the full redirect URL here: ").strip()
    if not redirect_url:
        print("ERROR: No URL provided.", file=sys.stderr)
        return 1

    # Step 4: Extract the authorisation code
    try:
        code, returned_state = _extract_code_from_redirect(redirect_url)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if returned_state and returned_state != state:
        print("WARNING: state mismatch — possible CSRF. Proceeding anyway.", file=sys.stderr)

    # Step 5: Exchange code for tokens
    print("\nExchanging authorisation code for tokens...")
    try:
        token_resp = _exchange_code(code, code_verifier)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    access_token = token_resp.get("access_token")
    refresh_token = token_resp.get("refresh_token")
    expires_in = token_resp.get("expires_in", 3600)
    expires_at = time.time() + expires_in

    if not access_token:
        print("ERROR: No access_token in token response.", file=sys.stderr)
        return 1

    print("Token acquired successfully.")

    # Step 6: Fetch device list
    print("\nFetching device list...")
    try:
        devices_resp = _api_get("/da/user/self/device", access_token)
    except RuntimeError as e:
        print(f"ERROR fetching devices: {e}", file=sys.stderr)
        return 1

    # Handle both list and wrapped responses
    if isinstance(devices_resp, list):
        devices = devices_resp
    elif isinstance(devices_resp, dict):
        devices = (
            devices_resp.get("devices")
            or devices_resp.get("data")
            or devices_resp.get("items")
            or []
        )
    else:
        devices = []

    if not devices:
        print("WARNING: No devices found in your account.")
        print("  Check that you are logged into the correct Philips account in the Air+ app.")

    # Step 7: Display and let user pick a device
    _print_devices(devices)

    if not devices:
        uuid = input("\nEnter the device UUID manually: ").strip()
    else:
        print()
        choice = input(
            f"Enter device UUID directly, or enter a number (1-{len(devices)}) to select: "
        ).strip()
        if choice.isdigit():
            idx = int(choice) - 1
            if 0 <= idx < len(devices):
                uuid = devices[idx].get("uuid") or devices[idx].get("id") or ""
            else:
                print(f"ERROR: Invalid selection {choice}.", file=sys.stderr)
                return 1
        else:
            uuid = choice

    if not uuid:
        print("ERROR: No UUID provided.", file=sys.stderr)
        return 1

    uuid = uuid.strip()

    # Step 8: Save tokens
    token_path = _save_tokens(uuid, access_token, refresh_token or "", expires_at)
    print(f"\nTokens saved to: {token_path}")
    print("File permissions set to 0600 (owner read/write only).")

    # Step 9: Print Homebridge config summary
    print("\n" + "=" * 40)
    print("Add this to your Homebridge config.json accessories array:")
    print()
    print(json.dumps({
        "accessory": "PhilipsAirPurifier",
        "name": "Air Purifier (Air+)",
        "host": "cloud",
        "protocol": "airplus-cloud",
        "airplusDeviceUuid": uuid,
        "airplusTokenFile": token_path,
    }, indent=2))
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
