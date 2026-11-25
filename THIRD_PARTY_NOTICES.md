# Third-party notices

This package bundles the following unmodified third-party Python packages in `vendor/`, so
users don't need to install them. Versions and published wheel sha256 hashes are pinned in
`requirements.txt`. `scripts/vendor.py` installs those wheels with `pip --require-hashes` and
checks every file against the wheel's RECORD; CI rebuilds `vendor/` and fails on any difference.

| Package | Version | Licence | Upstream | Licence text |
|---|---|---|---|---|
| aiocoap | 0.4.17 | MIT AND BSD-3-Clause | https://github.com/chrysn/aiocoap | `vendor/LICENSES/aiocoap/` |
| paho-mqtt | 2.2.0 | EPL-2.0 OR BSD-3-Clause (Eclipse Distribution License 1.0); used here under EDL-1.0 | https://github.com/eclipse-paho/paho.mqtt.python | `vendor/LICENSES/paho-mqtt/` (`LICENSE.txt`, `edl-v10`, `epl-v20`) |

The plugin also includes, in `aioairctrl/`, a modified copy of
[aioairctrl](https://github.com/betaboon/aioairctrl) (MIT). See [README.md](README.md#credits-and-attribution).

`aioairctrl/aes.py` is original code for this project (MIT, same as the plugin). It implements
AES as specified in FIPS-197 and is tested against FIPS-197 and NIST SP 800-38A vectors.
