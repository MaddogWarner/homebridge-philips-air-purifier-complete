# Security

## Supported versions

Only the latest major release (currently 5.x) receives security fixes.

## Reporting a vulnerability

Please report suspected security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/MaddogWarner/homebridge-philips-air-purifier-complete/security/advisories/new). Include the affected version, steps to reproduce and the expected behaviour. Do not include account tokens or other credentials.

## Known protocol limitations

The local CoAP protocol uses a fixed, publicly known key. Anyone on the LAN can send forged sensor readings. Put purifiers on a trusted or isolated network segment.

The HTTP and HomeID local APIs use AES-CBC with a zero IV, as the devices require, and HomeID over HTTPS accepts the device's self-signed certificate. These protect against casual observation only; they don't make an untrusted network safe.

## Bundled dependencies

`aiocoap` and `paho-mqtt` are bundled in `vendor/`, pinned with their published wheel hashes in `requirements.txt`. CI rebuilds `vendor/` from those hashes and fails on any difference, and Dependabot and pip-audit track them through `requirements.txt`.
