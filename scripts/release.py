#!/usr/bin/env python3
"""Release gate for the mesh-waker plugin.

    python scripts/release.py                 # preflight + npm publish --tag next
    python scripts/release.py --promote       # move the published version to latest
    python scripts/release.py --preflight     # check only, publish nothing

Rules this script enforces (learned the hard way):
  * node --check on both halves of the plugin;
  * the client bundle must resolve its module id from the boot manifest (test/);
  * the secret scan must come back clean;
  * no .npmrc may live inside the repository — npm is pointed at a temp userconfig;
  * publishing goes to the `next` dist-tag first; `latest` is promoted by hand after the
    local link install has booted once and the plugin was seen working for a turn.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "mesh-waker"
TEST = ROOT / "test" / "dynamic-id.test.js"
SECRET_SCAN = ROOT / "scripts" / "check-secrets.py"


def step(title: str, command: list[str], cwd: Path = ROOT, env=None) -> int:
    print(f"\n== {title}")
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, env=env)
    output = (result.stdout + result.stderr).strip()
    if output:
        print(output[-1500:])
    print(f"   exit {result.returncode}")
    return result.returncode


def preflight() -> int:
    failures = 0
    failures += step("node --check index.js", ["node", "--check", str(PLUGIN / "index.js")])
    failures += step("node --check client.js", ["node", "--check", str(PLUGIN / "client.js")])
    failures += step("client bundle id test", ["node", str(TEST)])
    if SECRET_SCAN.exists():
        failures += step("secret scan", [sys.executable, str(SECRET_SCAN)])
    stray = sorted(p for p in ROOT.rglob(".npmrc") if ".git" not in p.parts)
    if stray:
        print("\n== stray npmrc files:", [str(p.relative_to(ROOT)) for p in stray])
        failures += 1
    print("\n== preflight:", "PASS" if failures == 0 else f"FAIL ({failures})")
    return failures


def npm(args: list[str], npmrc: Path | None = None) -> int:
    base = ["npm.cmd" if os.name == "nt" else "npm"]
    if npmrc is not None:
        base += ["--userconfig", str(npmrc)]
    return step("npm " + " ".join(args), base + args, cwd=PLUGIN)


def publish(tag: str) -> int:
    token = os.environ.get("NPM_TOKEN")
    if not token:
        print("NPM_TOKEN is not set (load the vault first)")
        return 1
    pkg = json.loads((PLUGIN / "package.json").read_text(encoding="utf-8"))
    if pkg.get("private"):
        print("package.json is marked private — refusing to publish")
        return 1
    workdir = Path(tempfile.mkdtemp(prefix="mesh-waker-release-"))
    npmrc = workdir / ".npmrc"
    npmrc.write_text(
        "//registry.npmjs.org/:_authToken=" + token + "\nregistry=https://registry.npmjs.org/\n",
        encoding="ascii",
    )
    try:
        code = npm(["publish", "--access", "public", "--tag", tag], npmrc)
    finally:
        try:
            npmrc.unlink()
            workdir.rmdir()
        except OSError:
            pass
    if code == 0:
        version = pkg["version"]
        print(f"\npublished {pkg['name']}@{version} on dist-tag '{tag}'")
        if tag != "latest":
            print("after one local boot + one working turn, promote with:")
            print(f"  python scripts/release.py --promote")
            print(f"or: npm dist-tag add {pkg['name']}@{version} latest")
    return code


def promote() -> int:
    token = os.environ.get("NPM_TOKEN")
    if not token:
        print("NPM_TOKEN is not set (load the vault first)")
        return 1
    pkg = json.loads((PLUGIN / "package.json").read_text(encoding="utf-8"))
    workdir = Path(tempfile.mkdtemp(prefix="mesh-waker-promote-"))
    npmrc = workdir / ".npmrc"
    npmrc.write_text(
        "//registry.npmjs.org/:_authToken=" + token + "\nregistry=https://registry.npmjs.org/\n",
        encoding="ascii",
    )
    try:
        return npm(["dist-tag", "add", f"{pkg['name']}@{pkg['version']}", "latest"], npmrc)
    finally:
        try:
            npmrc.unlink()
            workdir.rmdir()
        except OSError:
            pass


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="next", help="dist-tag to publish under (default next)")
    parser.add_argument("--promote", action="store_true", help="point latest at the current version")
    parser.add_argument("--preflight", action="store_true", help="run the gate only")
    args = parser.parse_args(argv)

    if args.promote:
        return promote()
    if preflight():
        print("\nrelease blocked by preflight")
        return 1
    if args.preflight:
        return 0
    return publish(args.tag)


if __name__ == "__main__":
    sys.exit(main())
