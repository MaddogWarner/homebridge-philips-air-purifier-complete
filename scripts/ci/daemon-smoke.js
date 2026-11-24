// CI smoke test: start the real Python daemon through the plugin's own
// DaemonHandler (same spawn env as in Homebridge) for each local protocol,
// against a closed port, and require a "ready" handshake.
// Usage: node scripts/ci/daemon-smoke.js <installed plugin dir> [python]
// Without [python] it uses the plugin's own auto-detection.
const path = require('node:path');

const pluginDir = path.resolve(process.argv[2] || '.');
const { _DaemonHandler: DaemonHandler } = require(path.join(pluginDir, 'index.js'));
// Default to the interpreter the plugin itself would auto-detect.
const python = process.argv[3] || require(path.join(pluginDir, 'python-runtime.js')).findPython(pluginDir).found?.path;
if (!python) {
  console.error('No usable Python found');
  process.exit(1);
}
console.log(`Using ${python}`);
const log = { info: console.log, warn: console.log, error: console.log, debug() {} };

async function smoke(protocol) {
  const daemon = new DaemonHandler(log, () => {}, () => {}, null);
  const timer = setTimeout(() => { console.error(`${protocol}: no ready within 60 s`); process.exit(1); }, 60000);
  try {
    const connected = await daemon.start(python, path.join(pluginDir, 'philips_air_api.py'), '127.0.0.1', { protocol });
    console.log(`${protocol}: ready (connected=${connected})`);
  } finally {
    clearTimeout(timer);
    daemon.stop();
  }
}

(async () => {
  for (const protocol of ['coap', 'http', 'homeid-http']) await smoke(protocol);
  setTimeout(() => process.exit(0), 500);
})().catch((error) => { console.error(error); process.exit(1); });
