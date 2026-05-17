#!/bin/bash
# postinstall.sh
# Automatically run by npm after install.
# Creates a Python virtual environment and installs CoAP dependencies.
# aioairctrl is bundled in this package - no separate pip install needed.

PLUGIN_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
VENV_DIR="$PLUGIN_DIR/.venv"

warn() {
    echo "  WARNING: $1"
    echo "  To retry manually: bash \"$PLUGIN_DIR/postinstall.sh\""
}

echo ""
echo "homebridge-philips-air-purifier-complete: Setting up Python environment..."

# Check Python3
if ! command -v python3 &> /dev/null; then
    warn "Python 3 not found. Please install Python 3 first:"
    echo "    macOS:   brew install python3"
    echo "    Ubuntu:  sudo apt install python3 python3-venv"
    echo ""
    exit 0  # Don't fail npm install - homebridge still loads, just won't connect
fi

PYTHON_VERSION=$(python3 --version 2>&1)
echo "  Found: $PYTHON_VERSION"

# Create venv
if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    if [ $? -ne 0 ]; then
        warn "Failed to create virtual environment."
        echo "    On Debian/Ubuntu you may need: sudo apt install python3-venv"
        echo ""
        exit 0
    fi
fi

# Install Python dependencies
# aioairctrl is bundled in this package - only CoAP and crypto libs needed
echo "  Installing Python dependencies (aiocoap, pycryptodomex)..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install "aiocoap==0.4.1" pycryptodomex --quiet

if [ $? -ne 0 ]; then
    warn "Failed to install Python dependencies."
    echo ""
    exit 0
fi

# Verify the setup works
if "$VENV_DIR/bin/python3" -c "import aiocoap, Cryptodome" 2>/dev/null; then
    echo "  Python dependencies installed successfully."
else
    warn "Dependencies installed but import check failed - check your Python environment."
fi

echo ""
echo "  Setup complete. Plugin is ready to use."
echo "  Add to Homebridge config.json:"
echo '    { "accessory": "PhilipsAirPurifier", "name": "Air Purifier", "host": "192.168.1.100" }'
echo ""
