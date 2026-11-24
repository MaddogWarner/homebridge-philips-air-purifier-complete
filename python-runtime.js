/**
 * Finds a Python interpreter that can run the bundled daemon.
 *
 * Shared by index.js (the plugin) and homebridge-ui/server.js (the
 * Environment check panel). Only Python itself is required: aiocoap and
 * paho-mqtt are bundled in vendor/, and AES is pure Python (aioairctrl/aes.py).
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Single source of truth for the minimum Python version.
const PYTHON_MIN_VERSION = '3.11';
const [PYTHON_MIN_MAJOR, PYTHON_MIN_MINOR] = PYTHON_MIN_VERSION.split('.').map(Number);
if (!Number.isInteger(PYTHON_MIN_MAJOR) || !Number.isInteger(PYTHON_MIN_MINOR)) {
  throw new Error(`Invalid PYTHON_MIN_VERSION: ${PYTHON_MIN_VERSION}`);
}

// sys.argv[1] is the plugin directory. Prints the version first so a
// too-old interpreter can be reported by version. Importing aioairctrl puts
// vendor/ on sys.path, so this proves the bundled packages load here.
const EXIT_TOO_OLD = 3;
const PYTHON_RUNTIME_CHECK = `
import platform, sys
print(platform.python_version())
sys.stdout.flush()
if sys.version_info < (${PYTHON_MIN_MAJOR}, ${PYTHON_MIN_MINOR}):
    raise SystemExit(${EXIT_TOO_OLD})
sys.path.insert(0, sys.argv[1])
import aioairctrl, paho.mqtt.client
`;

const CHECK_TIMEOUT_MS = 15000;

function pythonCandidates() {
  return [
    process.env.PHILIPS_AIR_PYTHON,
    process.env.PYTHON,
    process.env.PYTHON3,
    '/usr/local/opt/python@3.12/bin/python3.12',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.11',
    '/usr/bin/python3.12',
    '/usr/bin/python3.13',
    '/usr/bin/python3.11',
    '/volume1/@appstore/Python3.12/usr/local/bin/python3.12',
    '/volume1/@appstore/py3k/usr/local/bin/python3',
    'python3.13',
    'python3.12',
    'python3.11',
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    'python3',
    // Windows installs from python.org provide `python`, not `python3`.
    // Anything older than the minimum (e.g. Python 2) fails the check.
    'python',
    // Windows py launcher (runs the newest installed Python 3).
    'py',
  ];
}

/**
 * Checks whether `pythonPath` can run the daemon.
 * Returns `{ ok, version, reason }`; reason is one of
 * 'ok' | 'missing' | 'too-old' | 'import-failed' | 'timeout'.
 */
function inspectPython(pythonPath, pluginDir) {
  try {
    // -I: ignore PYTHONPATH, user site-packages and the current directory, so
    // the result depends only on the interpreter and pluginDir.
    // -B: don't write __pycache__ into the plugin directory.
    const out = execFileSync(pythonPath, ['-I', '-B', '-c', PYTHON_RUNTIME_CHECK, pluginDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CHECK_TIMEOUT_MS,
    });
    return { ok: true, version: out.trim().split('\n')[0], reason: 'ok' };
  } catch (error) {
    const version = String(error.stdout || '').trim().split('\n')[0] || '';
    if (error.code === 'ENOENT' || error.code === 'EACCES') return { ok: false, version, reason: 'missing' };
    if (error.code === 'ETIMEDOUT' || error.signal) return { ok: false, version, reason: 'timeout' };
    if (error.status === EXIT_TOO_OLD) return { ok: false, version, reason: 'too-old' };
    // Any other exit (including Python 2 rejecting -I) means it can't run the daemon.
    return { ok: false, version, reason: 'import-failed' };
  }
}

/** Returns the Python version string if `pythonPath` can run the daemon, else null. */
function checkPython(pythonPath, pluginDir) {
  const result = inspectPython(pythonPath, pluginDir);
  return result.ok ? result.version : null;
}

/**
 * Searches the candidates. Returns `{ found, rejected }`: `found` is
 * `{ path, version }` or null; `rejected` lists interpreters that exist but
 * can't be used, as `{ path, version, reason }`, so callers can say why.
 */
function findPython(pluginDir) {
  const rejected = [];
  for (const candidate of pythonCandidates()) {
    if (!candidate) continue;
    const isCommandName = !candidate.includes(path.sep);
    if (!isCommandName && !fs.existsSync(candidate)) continue;
    const result = inspectPython(candidate, pluginDir);
    if (result.ok) return { found: { path: candidate, version: result.version }, rejected };
    if (result.reason !== 'missing') rejected.push({ path: candidate, version: result.version, reason: result.reason });
  }
  return { found: null, rejected };
}

/** Human-readable reason an interpreter was rejected. */
function describeRejection({ path: pythonPath, version, reason }) {
  switch (reason) {
    case 'too-old':
      return `${pythonPath} is Python ${version}, older than ${PYTHON_MIN_VERSION}`;
    case 'timeout':
      return `${pythonPath} did not respond within ${CHECK_TIMEOUT_MS / 1000} s`;
    case 'missing':
      return `${pythonPath} does not exist or cannot be run`;
    default:
      return `${pythonPath}${version ? ` (Python ${version})` : ''} could not load the plugin's bundled packages`;
  }
}

/**
 * Validates a configured pythonPath (absolute path, relative path or a
 * command name on PATH, as v4 accepted). It is only ever run with execFile,
 * never a shell, but shell metacharacters are still refused. Returns an
 * error message, or '' if acceptable. Shared by the plugin and settings UI.
 */
function pythonPathError(pythonPath) {
  if (typeof pythonPath !== 'string' || !pythonPath || pythonPath.length > 4096) {
    return 'pythonPath must be a non-empty string';
  }
  if (/[;&|`$<>!\n\r]/.test(pythonPath)) return `pythonPath contains invalid characters: "${pythonPath}"`;
  return '';
}

/** One-line, platform-specific install instruction. */
function pythonInstallHint(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return 'macOS: run "brew install python" (the built-in python3 is too old)';
    case 'win32':
      return 'Windows: install Python from https://www.python.org/downloads/';
    default:
      return 'Debian, Ubuntu or Raspberry Pi OS: run "sudo apt install python3"';
  }
}

module.exports = {
  PYTHON_MIN_VERSION,
  PYTHON_RUNTIME_CHECK,
  checkPython,
  describeRejection,
  findPython,
  inspectPython,
  pythonCandidates,
  pythonInstallHint,
  pythonPathError,
};
