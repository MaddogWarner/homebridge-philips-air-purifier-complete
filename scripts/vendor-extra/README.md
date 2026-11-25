# Bundled Python dependencies

Pure-Python packages shipped inside the npm package so the plugin needs no
pip, virtualenv or install script — only Python 3.11+ and its standard library.

Do not edit these files: CI rebuilds this folder from the hashed pins in `requirements.txt`
and fails on any difference. To change a version, edit `requirements.txt`, then run:

```bash
python3 scripts/vendor.py
```

The wheels are installed with `pip --require-hashes`, and every file is checked against its
wheel's RECORD. Licences are in `LICENSES/`. This README and licence texts that a wheel only
refers to come from `scripts/vendor-extra/`.
