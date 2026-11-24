import os
import sys

# Bundled pure-Python dependencies (aiocoap, paho-mqtt) live in ../vendor.
# Put them first so the pinned, patch-validated versions win over any copy
# installed on the system. See vendor/README.md.
_VENDOR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)


def __getattr__(name):
    # Imported lazily so `aioairctrl.aes` (used by the HTTP, HomeID and Air+
    # paths) doesn't load aiocoap: a CoAP problem then can't break them.
    if name == "CoAPClient":
        from aioairctrl.coap.client import Client

        return Client
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
