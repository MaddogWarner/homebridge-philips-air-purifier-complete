# Security

## Reporting a vulnerability

Please report suspected security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/MaddogWarner/homebridge-philips-air-purifier-complete/security/advisories/new). Include the affected version, steps to reproduce and the expected behaviour. Do not include account tokens or other credentials.

## Known protocol limitations

The local CoAP protocol uses a fixed, publicly known key. Anyone on the LAN can send forged sensor readings. Put purifiers on a trusted or isolated network segment.
