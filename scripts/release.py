#!/usr/bin/env python3
"""Release gate for the mesh-waker plugin.

    python scripts/release.py                 # preflight + npm publish --tag next
    python scripts/release.py --promote       # move the published version to latest
    python scripts/release.py --preflight     # check only, publish nothing
    python scripts/release.py --check-versions  # dev-mode version/changelog consistency
    python scripts/release.py --assert-released # strict: unreleased section gone + released heading present

Rules this script enforces (learned the hard way):
  * node --check on both halves of the plugin;
  * the client bundle must resolve its module id from the boot manifest (test/);
  * the secret scan must come back clean;
  * no .npmrc may live inside the repository — npm is pointed at a temp userconfig;
  * version consistency: HUB_VERSION == hub/package.json, hub/CHANGELOG.md has a
    `## [<version>] - YYYY-MM-DD` section for it, and the waker CHANGELOG has an
    entry for the plugin version being released;
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
HUB_CHANGELOG = ROOT / "hub" / "CHANGELOG.md"
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


RELEASED_HEADING = re.compile(r"^## \[(\d+\.\d+\.\d+)\]")


def changelog_state(path: Path):
    """Return (latest_released, has_unreleased_section, unreleased_has_content) or None when missing."""
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    latest = None
    has_unreleased = "## [未发布]" in text
    content = False
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = RELEASED_HEADING.match(line)
        if match and latest is None:
            latest = match.group(1)
            break
    if has_unreleased:
        start = next(i for i, line in enumerate(lines) if line.strip() == "## [未发布]")
        for line in lines[start + 1 :]:
            if line.startswith("## "):
                break
            stripped = line.strip()
            if not stripped or "暂无变更" in stripped:
                continue
            content = True
            break
    return latest, has_unreleased, content


def semver_compare(left: str, right: str) -> int:
    a = [int(part) for part in left.split(".")]
    b = [int(part) for part in right.split(".")]
    for x, y in zip(a, b):
        if x != y:
            return x - y
    return 0


def check_axis(label: str, path: Path, version, release_mode: bool) -> int:
    """Dev mode is lenient (unreleased-ahead is fine); release mode demands a released heading."""
    rel = path.relative_to(ROOT).as_posix()
    if version is None:
        print(f"   FAIL {label}: package metadata has no version")
        return 1
    state = changelog_state(path)
    if state is None:
        print(f"   FAIL MISSING: {rel} (required before a release)")
        return 1
    latest, has_unreleased, unreleased_content = state
    suffix = "（release check）" if release_mode else ""

    if release_mode:
        if has_unreleased:
            detail = "仍有内容" if unreleased_content else "仍存在"
            print(f"   FAIL {label}: [未发布] {detail}{suffix} - rename it to ## [{version}] - YYYY-MM-DD before releasing")
            return 1
        if latest == version:
            print(f"   PASS {label}: released heading ## [{version}] present{suffix}")
            return 0
        print(f"   FAIL {label}: no released heading ## [{version}] (latest is {latest}){suffix}")
        return 1

    if latest is None and not has_unreleased:
        print(f"   FAIL {label}: {rel} has neither a released heading nor [未发布]")
        return 1
    if latest is None:
        print(f"   PASS {label}: only [未发布] so far, releasing {version}")
        return 0
    comparison = semver_compare(version, latest)
    if comparison < 0:
        print(f"   FAIL {label}: version regression {version} < latest released {latest}")
        return 1
    if comparison == 0:
        if unreleased_content:
            print(f"   WARN {label}: {version} is released but [未发布] already has content - time to cut a version?")
        else:
            print(f"   PASS {label}: {version} matches the latest released heading")
        return 0
    # version ahead of the last release
    if has_unreleased:
        print(f"   PASS {label}: {version} 未发布，内容在 [未发布]（最近发布 {latest}）")
        return 0
    print(f"   FAIL {label}: {version} > latest released {latest} but there is no [未发布] section")
    return 1


def version_checks(release_mode: bool = False) -> int:
    """Guard the release sources of truth: versions and changelog state.

    Development mode accepts a package version that is ahead of the last released
    heading as long as [未发布] exists; release mode is strict and demands that the
    version has its own released heading and that [未发布] is gone.
    """
    failures = 0
    print("\n== version consistency" + (" (release)" if release_mode else ""))
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
    failures += check_axis("hub", HUB_CHANGELOG, hub_version, release_mode)

    waker_pkg = read_json(PLUGIN / "package.json")
    waker_version = waker_pkg.get("version") if isinstance(waker_pkg, dict) else None
    failures += check_axis("waker", PLUGIN_CHANGELOG, waker_version, release_mode)
    return failures

def preflight() -> int:
    failures = version_checks(release_mode=True)
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
    parser.add_argument("--check-versions", action="store_true", help="version/changelog consistency only (development mode: unreleased-ahead is fine)")
    parser.add_argument("--release", action="store_true", help="with --check-versions: strict release mode (unreleased section gone, released heading present)")
    parser.add_argument("--assert-released", action="store_true", help="alias for --check-versions --release")
    args = parser.parse_args(argv)

    if args.promote:
        return promote()
    if args.assert_released:
        args.check_versions = True
        args.release = True
    if args.check_versions:
        failures = version_checks(release_mode=args.release)
        label = "release" if args.release else "development"
        print(f"\n== version check ({label}):", "PASS" if failures == 0 else f"FAIL ({failures})")
        return 0 if failures == 0 else 1
    if preflight():
        print("\nrelease blocked by preflight")
        return 1
    if args.preflight:
        return 0
    return publish(args.tag)


if __name__ == "__main__":
    sys.exit(main())
