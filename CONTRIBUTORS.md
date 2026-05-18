# Contributors

## Project Maintainer

**[MadDogWarner](https://github.com/MadDogWarner)**
Combined fork author. Bundled aioairctrl into the plugin, automated Python environment setup via npm postinstall, applied code quality and security fixes, authored streamlined Homebridge deployment, project versioning and maintenance.

## AI Assistance

**[Claude Sonnet 4.6](https://claude.ai)** (Anthropic)
Code review of aioairctrl (bug fixes, type annotation corrections, input validation), refactoring of homebridge plugin for the bundled architecture, postinstall automation, documentation authoring. Additional contributions: daemon readline listener leak fix, removal of orphaned CoAP Observe subscription from one-shot `get_status()`, `PYTHON_MIN_VERSION` single-source-of-truth refactor across JS and shell runtimes, removal of dead `SPEED_TO_MODE` entry and residual null guard.

**OpenAI Codex**
Python 3.12 and Node.js 24 compatibility review, runtime detection hardening, dependency range updates, ESLint flat config migration, and documentation updates.

## Original Authors

**[louiscrc](https://github.com/louiscrc)**
Original homebridge-philips-air-purifier author. Designed the CoAP Observe daemon architecture and Python/Node.js IPC protocol that this plugin is built upon.
See the original project: [louiscrc/homebridge-philips-air-purifier](https://github.com/louiscrc/homebridge-philips-air-purifier)

**[MadDogWarner](https://github.com/MadDogWarner)** (fork of louiscrc)
Homebridge 2.0+ and Node.js 24 compatibility, daemon auto-restart with exponential backoff, security hardening, sleep mode support.
See the fork: [MadDogWarner/homebridge-philips-air-purifier](https://github.com/MadDogWarner/homebridge-philips-air-purifier)

**[betaboon](https://github.com/betaboon)**
Original aioairctrl author. Reverse-engineered the Philips CoAP encryption protocol and built the Python library used for device communication.
See the original project: [betaboon/aioairctrl](https://github.com/betaboon/aioairctrl)
