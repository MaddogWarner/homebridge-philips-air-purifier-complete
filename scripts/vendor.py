#!/usr/bin/env python3
"""Build or verify the bundled pure-Python dependencies in vendor/.

The plugin ships aiocoap and paho-mqtt inside the npm package so users need
no pip, venv or install script. requirements.txt is the single source of
truth: exact versions plus the sha256 of each published wheel (Dependabot and
pip-audit read it too).

  python3 scripts/vendor.py            # rebuild vendor/ from requirements.txt
  python3 scripts/vendor.py --check    # rebuild into a temp dir and fail on ANY difference

Both install the pinned wheels with `pip --require-hashes`, so vendor/ is
provably the published wheels. Every copied file is also checked against its
wheel's RECORD sha256, and compiled extensions are rejected.

`--site-packages DIR` uses an existing install instead of pip (offline use;
this skips the wheel-hash check, so CI never uses it).

Files that aren't in the wheels (vendor/README.md, licence texts a wheel only
points to) live in scripts/vendor-extra/ and are copied in on every build.
"""
import argparse
import base64
import csv
import filecmp
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
EXTRA = Path(__file__).resolve().parent / "vendor-extra"
REQUIREMENTS = ROOT / "requirements.txt"
# distribution name -> top-level import package it installs
PACKAGES = {"aiocoap": "aiocoap", "paho-mqtt": "paho"}
_PIN = re.compile(r"^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$")
_HASH = re.compile(r"^--hash=sha256:[0-9a-f]{64}$")


def read_pins():
    """Return {name: version}; every requirement must be an exact, hashed pin."""
    text = REQUIREMENTS.read_text().replace("\\\n", " ")
    pins = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        spec, *hashes = line.split()
        match = _PIN.match(spec)
        if not match or not hashes or not all(_HASH.match(h) for h in hashes):
            raise SystemExit(f"requirements.txt: expected 'name==version --hash=sha256:...', got: {line}")
        pins[match.group(1).lower()] = match.group(2)
    if set(pins) != set(PACKAGES):
        raise SystemExit(f"requirements.txt must pin exactly {sorted(PACKAGES)}, got {sorted(pins)}")
    return pins


def _dist_info(site, name, version):
    path = site / f"{name.replace('-', '_')}-{version}.dist-info"
    if not path.is_dir():
        raise SystemExit(f"{name}=={version} not found in {site}")
    return path


def _verify_record(site, dist_info, package):
    """Check every file of `package` against its RECORD hash; return the file list."""
    files = []
    with (dist_info / "RECORD").open(newline="") as handle:
        for rel, digest, _size in csv.reader(handle):
            if not rel.startswith(f"{package}/") or "__pycache__" in rel:
                continue
            if rel.endswith((".so", ".pyd", ".dylib")):
                raise SystemExit(f"{rel} is a compiled extension; only pure-Python packages may be bundled")
            algo, _, expected = digest.partition("=")
            if algo != "sha256":
                raise SystemExit(f"{rel}: unsupported RECORD hash {algo!r}")
            actual = base64.urlsafe_b64encode(hashlib.sha256((site / rel).read_bytes()).digest()).rstrip(b"=")
            if actual.decode() != expected:
                raise SystemExit(f"{rel}: sha256 does not match the wheel RECORD")
            files.append(rel)
    if not files:
        raise SystemExit(f"No files for {package} in {dist_info / 'RECORD'}")
    return files


def build(site, dest):
    """Assemble the complete vendor/ tree from installed packages into `dest`."""
    pins = read_pins()
    for name, package in PACKAGES.items():
        dist_info = _dist_info(site, name, pins[name])
        for rel in _verify_record(site, dist_info, package):
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(site / rel, target)
        licences = [p for p in (dist_info / "licenses").rglob("*") if p.is_file()]
        if not licences:
            raise SystemExit(f"{name}: wheel ships no licence files; add them to scripts/vendor-extra/")
        for licence in licences:
            target = dest / "LICENSES" / name / licence.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(licence, target)
    for extra in EXTRA.rglob("*"):
        if extra.is_file():
            target = dest / extra.relative_to(EXTRA)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(extra, target)
    (dest / "VERSIONS.txt").write_text("".join(f"{n}=={pins[n]}\n" for n in sorted(pins)))
    # Normal permissions regardless of the umask/mkdtemp mode.
    for path in [dest, *dest.rglob("*")]:
        os.chmod(path, 0o755 if path.is_dir() else 0o644)


def _pip_install(target):
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps", "--only-binary=:all:",
         "--require-hashes", "--target", str(target), "-r", str(REQUIREMENTS)],
        check=True,
    )


def _tree(root):
    return {
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    }


def check(site):
    with tempfile.TemporaryDirectory(prefix="vendor-check-") as tmp:
        expected = Path(tmp) / "vendor"
        expected.mkdir()
        build(site, expected)
        want, have = _tree(expected), _tree(VENDOR)
        problems = [f"missing: {p}" for p in sorted(want - have)]
        problems += [f"unexpected: {p}" for p in sorted(have - want)]
        problems += [
            f"modified: {p}" for p in sorted(want & have)
            if not filecmp.cmp(expected / p, VENDOR / p, shallow=False)
        ]
    if problems:
        print("\n".join(problems), file=sys.stderr)
        raise SystemExit("vendor/ does not match requirements.txt. Run: python3 scripts/vendor.py")
    print(f"vendor/ matches requirements.txt ({len(want)} files)")


def refresh(site):
    staged = Path(tempfile.mkdtemp(prefix="vendor-"))
    try:
        build(site, staged)
        shutil.rmtree(VENDOR, ignore_errors=True)
        shutil.move(str(staged), str(VENDOR))
    finally:
        shutil.rmtree(staged, ignore_errors=True)
    print("vendor/ rebuilt from requirements.txt")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail if vendor/ differs from a fresh build")
    parser.add_argument("--site-packages", type=Path, help="use an existing install instead of pip (offline)")
    args = parser.parse_args()
    action = check if args.check else refresh

    if args.site_packages:
        action(args.site_packages.resolve())
        return
    with tempfile.TemporaryDirectory(prefix="vendor-pip-") as target:
        _pip_install(Path(target))
        action(Path(target))


if __name__ == "__main__":
    main()
