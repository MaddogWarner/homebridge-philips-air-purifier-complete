#!/bin/bash
# preinstall.sh
# Fails npm install early if the host runtime does not meet plugin requirements.

PYTHON_MIN_VERSION="3.12"
NODE_MIN_MAJOR=24

fail() {
    echo ""
    echo "homebridge-philips-air-purifier-complete: preinstall check failed"
    echo "  ERROR: $1"
    echo ""
    exit 1
}

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

echo ""
echo "homebridge-philips-air-purifier-complete: Checking runtime requirements..."

if ! command -v node > /dev/null 2>&1; then
    fail "Node.js $NODE_MIN_MAJOR or newer is required, but node was not found in PATH."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
    NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
    fail "Node.js $NODE_MIN_MAJOR or newer is required. Found: $NODE_VERSION"
fi

PYTHON_BIN="$(find_python)"
if [ -z "$PYTHON_BIN" ]; then
    fail "Python $PYTHON_MIN_VERSION or newer is required. Install Python $PYTHON_MIN_VERSION+ before installing this plugin."
fi

echo "  Found Node.js $(node --version)"
echo "  Found $($PYTHON_BIN --version 2>&1)"
echo "  Runtime requirements satisfied."
echo ""
