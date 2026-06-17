#!/usr/bin/env python3
"""
airplus_setup.py — One-time OAuth2/PKCE setup for the Philips Air+ cloud protocol.

Completes the OAuth2 authorisation code flow with PKCE, lists devices registered
in the Philips Air+ app, and saves tokens to ~/.homebridge/philips-airplus-{uuid}.json.

Usage:
    python scripts/airplus_setup.py

No external deps required — stdlib only.
"""

import argparse
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
CDC_BASE = "https://cdc.accounts.home.id"
OTP_SEND_ENDPOINT = f"{CDC_BASE}/accounts.auth.otp.email.sendCode"
OTP_LOGIN_ENDPOINT = f"{CDC_BASE}/accounts.auth.otp.email.login"
GET_IDS_ENDPOINT = f"{CDC_BASE}/accounts.socialize.getIDs"

API_BASE = "https://prod.eu-da.iot.versuni.com/api"
USER_AGENT = "okhttp/4.12.0 (Android 14; Pixel 7)"


def _pkce_pair() -> tuple[str, str]:
    """Generate a (code_verifier, code_challenge) PKCE pair."""
    code_verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return code_verifier, code_challenge


def _build_authorize_url(code_challenge: str, state: str, prompt: str | None = None) -> str:
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    if prompt:
        params["prompt"] = prompt
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


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_no_redirect(req: urllib.request.Request) -> tuple[int, dict, bytes]:
    opener = urllib.request.build_opener(_NoRedirectHandler)
    try:
        with opener.open(req, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        body = e.read()
        if 300 <= e.code < 400:
            return e.code, dict(e.headers), body
        raise


def _post_form_json(url: str, data: dict, label: str) -> dict:
    encoded = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url,
        data=encoded,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        status, _headers, body = _open_no_redirect(req)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"{label} failed (HTTP {e.code}): {body}") from e

    text = body.decode(errors="replace")
    if status < 200 or status >= 300:
        raise RuntimeError(f"{label} failed (HTTP {status}): {text}")
    try:
        parsed = json.loads(text or "{}")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{label} returned invalid JSON: {text[:200]}") from e
    error_code = parsed.get("errorCode")
    try:
        failed = error_code is not None and int(error_code) != 0
    except (TypeError, ValueError):
        failed = error_code is not None
    if failed:
        msg = parsed.get("errorMessage") or parsed.get("errorDetails") or parsed.get("errorCode")
        raise RuntimeError(f"{label} failed: {msg}")
    return parsed


def _get_redirect_location(url: str, label: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
        },
    )
    try:
        status, headers, _body = _open_no_redirect(req)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"{label} failed (HTTP {e.code}): {body}") from e

    location = headers.get("Location") or headers.get("location")
    if not location or status < 300 or status >= 400:
        raise RuntimeError(f"{label} did not return an HTTP redirect")
    print(f"{label}: HTTP {status} redirect with parameters: {_describe_location(location)}")
    return location


def _describe_location(location: str) -> str:
    """Describe redirect parameters without printing auth codes or login tickets."""
    try:
        parsed = urllib.parse.urlparse(location)
        params = urllib.parse.parse_qs(parsed.query or parsed.fragment)
        names = ", ".join(sorted(params)) or "none"
        path = parsed.path or parsed.netloc or parsed.scheme
        return f"{path} ({names})"
    except Exception:
        return "(unparseable redirect)"


def _read_url_param(value: str, param: str) -> str:
    parsed = urllib.parse.urlparse(value)
    params = urllib.parse.parse_qs(parsed.query or parsed.fragment)
    if params.get(param):
        return params[param][0]
    match = re.search(r"[?&#]" + re.escape(param) + r"=([^&\s\"'\\]+)", value)
    return urllib.parse.unquote(match.group(1)) if match else ""


def _send_otp(email: str) -> str:
    response = _post_form_json(
        OTP_SEND_ENDPOINT,
        {
            "apiKey": TENANT,
            "email": email,
            "format": "json",
        },
        "OTP send",
    )
    v_token = response.get("vToken")
    if not v_token:
        raise RuntimeError("OTP send did not return a verification token.")
    return v_token


def _verify_otp(email: str, code: str, v_token: str) -> str:
    response = _post_form_json(
        OTP_LOGIN_ENDPOINT,
        {
            "apiKey": TENANT,
            "email": email,
            "code": code,
            "vToken": v_token,
            "format": "json",
        },
        "OTP verify",
    )
    session_info = response.get("sessionInfo") or {}
    login_token = session_info.get("cookieValue")
    if not login_token:
        raise RuntimeError("OTP verification succeeded but no login token was returned.")
    return login_token


def _get_gmid_ticket() -> str:
    response = _post_form_json(
        GET_IDS_ENDPOINT,
        {
            "APIKey": TENANT,
            "includeTicket": "true",
            "format": "json",
        },
        "Gigya getIDs",
    )
    gmid_ticket = response.get("gmidTicket")
    if not gmid_ticket:
        raise RuntimeError("Gigya getIDs did not return gmidTicket.")
    return gmid_ticket


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


def _browser_login() -> dict:
    """Run the fallback browser redirect-copy flow and return the token response."""
    code_verifier, code_challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)

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
        raise RuntimeError("No URL provided.")

    # Step 4: Extract the authorisation code
    code, returned_state = _extract_code_from_redirect(redirect_url)

    if returned_state and returned_state != state:
        print("WARNING: state mismatch — possible CSRF. Proceeding anyway.", file=sys.stderr)

    print("\nExchanging authorisation code for tokens...")
    return _exchange_code(code, code_verifier)


def _otp_login() -> dict:
    """Run the default email + verification code flow and return the token response."""
    email = input("\nPhilips account email: ").strip()
    if not email:
        raise RuntimeError("No email address provided.")

    print("Sending verification code...")
    v_token = _send_otp(email)
    print("Verification code sent. Check your Philips account email.")

    code = input("Verification code: ").strip()
    if not code:
        raise RuntimeError("No verification code provided.")

    print("Verifying code...")
    login_token = _verify_otp(email, code, v_token)

    code_verifier, code_challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)
    auth_url = _build_authorize_url(code_challenge, state, prompt="none")
    auth_location = _get_redirect_location(auth_url, "OIDC authorise")
    context = _read_url_param(auth_location, "context")
    if not context:
        raise RuntimeError("OIDC authorise did not return a continuation context.")

    gmid_ticket = _get_gmid_ticket()
    continue_params = urllib.parse.urlencode({
        "context": context,
        "login_token": login_token,
        "gmidTicket": gmid_ticket,
        "client_id": CLIENT_ID,
    })
    continue_url = f"{AUTHORIZE_ENDPOINT}/continue?{continue_params}"
    app_redirect = _get_redirect_location(continue_url, "OIDC continue")
    auth_code, _returned_state = _extract_code_from_redirect(app_redirect)

    print("\nExchanging authorisation code for tokens...")
    return _exchange_code(auth_code, code_verifier)


def _devices_from_response(devices_resp) -> list:
    if isinstance(devices_resp, list):
        return devices_resp
    if isinstance(devices_resp, dict):
        data = devices_resp.get("data")
        if isinstance(data, dict):
            data = data.get("items")
        return (
            devices_resp.get("devices")
            or data
            or devices_resp.get("items")
            or []
        )
    return []


def _save_selected_device(token_resp: dict) -> int:
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

    devices = _devices_from_response(devices_resp)

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
    print("Add this to your Homebridge config.json platforms array:")
    print()
    print(json.dumps({
        "platform": "PhilipsAirPurifier",
        "name": "Philips Air Purifiers",
        "devices": [
            {
                "name": "Air Purifier (Air+)",
                "host": "cloud",
                "protocol": "airplus-cloud",
                "airplusDeviceUuid": uuid,
                "airplusTokenFile": token_path,
            },
        ],
    }, indent=2))
    print()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="One-time Philips Air+ setup for Homebridge."
    )
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Use the legacy browser redirect-copy flow instead of email verification code.",
    )
    args = parser.parse_args()

    print("Philips Air+ Setup")
    print("=" * 40)

    try:
        token_resp = _browser_login() if args.browser else _otp_login()
    except (RuntimeError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    return _save_selected_device(token_resp)


if __name__ == "__main__":
    sys.exit(main())
