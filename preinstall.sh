#!/bin/bash
# preinstall.sh
# Warns if the host runtime does not meet plugin requirements.

PYTHON_MIN_VERSION="3.12"
NODE_MIN_MAJOR=24

warn() {
    echo ""
    echo "homebridge-philips-air-purifier-complete: preinstall warning"
    echo "  WARNING: $1"
    echo ""
}

python_version_ok() {
    "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null
}

resolve_python_candidate() {
    if [ -z "$1" ]; then
        return 1
    fi
    if [ -x "$1" ] && python_version_ok "$1"; then
        echo "$1"
        return 0
    fi
    if command -v "$1" > /dev/null 2>&1; then
        candidate_path="$(command -v "$1")"
        if python_version_ok "$candidate_path"; then
            echo "$candidate_path"
            return 0
        fi
    fi
    return 1
}

find_python() {
    for candidate in \
        "$PHILIPS_AIR_PYTHON" \
        "$npm_config_python" \
        "$PYTHON" \
        "$PYTHON3" \
        python3.13 \
        python3.12 \
        python3 \
        /opt/homebrew/bin/python3.13 \
        /opt/homebrew/bin/python3.12 \
        /usr/local/bin/python3.13 \
        /usr/local/bin/python3.12 \
        /usr/bin/python3.13 \
        /usr/bin/python3.12 \
        /usr/local/opt/python@3.12/bin/python3.12 \
        /volume1/@appstore/Python3.12/usr/local/bin/python3.12 \
        /volume1/@appstore/py3k/usr/local/bin/python3; do
        resolved="$(resolve_python_candidate "$candidate")"
        if [ -n "$resolved" ]; then
            echo "$resolved"
            return 0
        fi
    done
    return 1
}

echo ""
echo "homebridge-philips-air-purifier-complete: Checking runtime requirements..."

if ! command -v node > /dev/null 2>&1; then
    warn "Node.js $NODE_MIN_MAJOR or newer is required, but node was not found in PATH. npm will continue, but Homebridge may not be able to run this plugin."
else
    NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
    if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
        NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
        warn "Node.js $NODE_MIN_MAJOR or newer is required. Found: $NODE_VERSION. npm will continue, but this plugin is unsupported on this Node.js version."
    else
        echo "  Found Node.js $(node --version)"
    fi
fi

if [ "$PHILIPS_AIR_SKIP_PYTHON_PREINSTALL" = "1" ]; then
    echo "  WARNING: Skipping Python preinstall check because PHILIPS_AIR_SKIP_PYTHON_PREINSTALL=1."
    echo "  Configure pythonPath in Homebridge or run postinstall.sh with PHILIPS_AIR_PYTHON set before starting Homebridge."
    echo ""
    exit 0
fi

PYTHON_BIN="$(find_python)"
if [ -z "$PYTHON_BIN" ]; then
    warn "Python $PYTHON_MIN_VERSION or newer was not found. npm will continue, but postinstall may not be able to create the Python environment and the plugin will not connect until Python $PYTHON_MIN_VERSION+ is available."
    echo "  To use a Python binary outside npm's PATH, set PHILIPS_AIR_PYTHON=/absolute/path/to/python3.12."
    echo ""
    exit 0
fi

echo "  Found $($PYTHON_BIN --version 2>&1)"
echo "  Runtime requirement check complete."
echo ""
