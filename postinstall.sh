#!/bin/bash
# postinstall.sh
# Automatically run by npm after install.
# Creates a Python virtual environment and installs CoAP dependencies.
# aioairctrl is bundled in this package - no separate pip install needed.

PLUGIN_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
VENV_DIR="$PLUGIN_DIR/.venv"
PYTHON_MIN_VERSION="3.12"

python_version_ok() {
    "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null
}

find_python() {
    for candidate in python3.12 python3.13 python3; do
        if command -v "$candidate" > /dev/null 2>&1 && python_version_ok "$candidate"; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

warn() {
    echo "  WARNING: $1"
    echo "  To retry manually: bash \"$PLUGIN_DIR/postinstall.sh\""
}

echo ""
echo "homebridge-philips-air-purifier-complete: Setting up Python environment..."

# Check Python 3.12+
PYTHON_BIN="$(find_python)"
if [ -z "$PYTHON_BIN" ]; then
    warn "Python $PYTHON_MIN_VERSION or newer not found. Please install Python $PYTHON_MIN_VERSION+ first:"
    echo "    macOS:   brew install python@3.12"
    echo "    Ubuntu:  sudo apt install python3.12 python3.12-venv"
    echo ""
    exit 0  # Don't fail npm install - homebridge still loads, just won't connect
fi

PYTHON_VERSION=$("$PYTHON_BIN" --version 2>&1)
echo "  Found: $PYTHON_VERSION"

if [ -x "$VENV_DIR/bin/python3" ] && ! python_version_ok "$VENV_DIR/bin/python3"; then
    echo "  Existing virtual environment uses Python older than $PYTHON_MIN_VERSION; recreating..."
    rm -rf "$VENV_DIR"
fi

# Create venv
if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating virtual environment..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    if [ $? -ne 0 ]; then
        warn "Failed to create virtual environment."
        echo "    On Debian/Ubuntu you may need: sudo apt install python3.12-venv"
        echo ""
        exit 0
    fi
fi

# Install Python dependencies
# aioairctrl is bundled in this package - only CoAP and crypto libs needed
echo "  Installing Python dependencies (aiocoap, pycryptodomex)..."
"$VENV_DIR/bin/python3" -m pip install --upgrade pip --quiet
"$VENV_DIR/bin/python3" -m pip install "aiocoap>=0.4.17,<0.5" "pycryptodomex>=3.23,<4" --quiet

if [ $? -ne 0 ]; then
    warn "Failed to install Python dependencies."
    echo ""
    exit 0
fi

# Verify the setup works
if "$VENV_DIR/bin/python3" -c "import sys; assert sys.version_info >= (3, 12); import aiocoap, Cryptodome" 2>/dev/null; then
    echo "  Python dependencies installed successfully."
else
    warn "Dependencies installed but import check failed - check your Python environment."
fi

echo ""
echo "  Setup complete. Plugin is ready to use."
echo "  Add to Homebridge config.json:"
echo '    { "accessory": "PhilipsAirPurifier", "name": "Air Purifier", "host": "192.168.1.100" }'
echo ""
