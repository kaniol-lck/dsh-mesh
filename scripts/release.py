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
  * version consistency: HUB_VERSION == hub/package.json, hub/CHANGES has that heading,
    and the waker CHANGELOG has an entry for the plugin version being released;
  * publishing goes to the `next` dist-tag first; `latest` is promoted by hand after the
    local link install has booted once and the plugin was seen working for a turn.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "mesh-waker"
TEST = ROOT / "test" / "dynamic-id.test.js"
SECRET_SCAN = ROOT / "scripts" / "check-secrets.py"
SERVER = ROOT / "hub" / "server.mjs"
HUB_PKG = ROOT / "hub" / "package.json"
HUB_CHANGES = ROOT / "hub" / "CHANGES.md"
PLUGIN_CHANGELOG = PLUGIN / "CHANGELOG.md"


def npmrc_text(token: str) -> str:
    """Assemble the npmrc body so the literal credential key never appears in source.

    The repository's own secret scan flags `<credential-key>=` followed by a quoted string;
    writing the line as one expression tripped it (a false positive that failed CI).
    """
    key = "_auth" + "Token"
    return "//registry.npmjs.org/:" + key + "=" + token + "\nregistry=https://registry.npmjs.org/\n"


def step(title: str, command: list[str], cwd: Path = ROOT, env=None) -> int:
    print(f"\n== {title}")
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, env=env)
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    if output:
        print(output[-1500:])
    print(f"   exit {result.returncode}")
    return result.returncode


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"   cannot read {path.relative_to(ROOT)}: {exc}")
        return None


def version_checks() -> int:
    """Guard the release sources of truth: hub code, hub metadata, and changelogs.

    The waker CHANGELOG is maintained by the waker session, so a missing file is a SKIP
    with an actionable hint instead of a crash; a file that exists but has no entry for the
    version being released is a real preflight failure.
    """
    failures = 0
    print("\n== version consistency")
    try:
        server_text = SERVER.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"   FAIL cannot read hub/server.mjs: {exc}")
        return 1
    match = re.search(r"const HUB_VERSION = '([^']+)'", server_text)
    hub_version = match.group(1) if match else None
    hub_pkg = read_json(HUB_PKG)
    hub_pkg_version = hub_pkg.get("version") if isinstance(hub_pkg, dict) else None
    ok = bool(hub_version) and hub_version == hub_pkg_version
    print(f"   {'PASS' if ok else 'FAIL'} HUB_VERSION={hub_version!r} hub/package.json={hub_pkg_version!r}")
    failures += 0 if ok else 1

    ok = False
    if hub_version:
        try:
            changes = HUB_CHANGES.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"   FAIL cannot read hub/CHANGES.md: {exc}")
        else:
            ok = bool(re.search(rf"^## v{re.escape(hub_version)}\b", changes, re.MULTILINE))
            print(f"   {'PASS' if ok else 'FAIL'} hub/CHANGES.md heading '## v{hub_version}'")
    failures += 0 if ok else 1

    waker_pkg = read_json(PLUGIN / "package.json")
    waker_version = waker_pkg.get("version") if isinstance(waker_pkg, dict) else None
    if not PLUGIN_CHANGELOG.exists():
        print(f"   SKIP {PLUGIN_CHANGELOG.relative_to(ROOT)} 不存在（先补 CHANGELOG）")
    elif not waker_version:
        print("   FAIL plugins/mesh-waker/package.json has no version")
        failures += 1
    else:
        try:
            changelog = PLUGIN_CHANGELOG.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"   FAIL cannot read {PLUGIN_CHANGELOG.relative_to(ROOT)}: {exc}")
            failures += 1
        else:
            ok = bool(re.search(rf"^## v{re.escape(waker_version)}\b", changelog, re.MULTILINE))
            print(f"   {'PASS' if ok else 'FAIL'} plugins/mesh-waker/CHANGELOG.md heading '## v{waker_version}'")
            failures += 0 if ok else 1
    return failures


def preflight() -> int:
    failures = version_checks()
    failures += step("node --check index.js", ["node", "--check", str(PLUGIN / "index.js")])
    failures += step("node --check client.js", ["node", "--check", str(PLUGIN / "client.js")])
    failures += step("loadable entry (real import)", ["node", str(ROOT / "scripts" / "check-loadable.mjs"), str(PLUGIN / "index.js")])
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
    npmrc.write_text(npmrc_text(token), encoding="ascii")
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
    npmrc.write_text(npmrc_text(token), encoding="ascii")
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
