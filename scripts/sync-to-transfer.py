#!/usr/bin/env python3
"""Mirror this repository into the private transfer repo (one way: public -> transfer).

The transfer repo is downstream: it holds a copy of the source tree plus a few private
files (refs/, REFS.md, skills/lan-ops/, docs/plugin-release.md). This script copies only
the public side and never deletes anything downstream, so private additions survive.

Usage:
    python scripts/sync-to-transfer.py              # dry run, prints the plan
    python scripts/sync-to-transfer.py --apply      # write the files
    python scripts/sync-to-transfer.py --apply --dest D:/path/to/transfer
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent

EXCLUDE_DIRS = {".git", "node_modules", "refs", "__pycache__", ".venv", "data", "certs"}
EXCLUDE_FILES = {
    "REFS.md",
    ".npmrc",
    # Repository-specific files: the transfer copy has its own README, AGENTS.md,
    # .gitignore and a Dockerfile with the build-cache note. Mirroring over them would
    # destroy private content, so they stay excluded and are maintained by hand.
    "README.md",
    "README.en.md",
    "AGENTS.md",
    ".gitignore",
    "Dockerfile",
    "package.json",
    "CHANGES.md",
}


def iter_files(root: Path):
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        parts = set(relative.parts[:-1])
        if parts & EXCLUDE_DIRS:
            continue
        if path.is_dir():
            continue
        if path.name in EXCLUDE_FILES:
            continue
        yield relative


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Mirror the public repo into the transfer repo")
    parser.add_argument("--dest", default=str(SRC.parent / "transfer"), help="transfer repo root")
    parser.add_argument("--apply", action="store_true", help="actually write files (default: dry run)")
    args = parser.parse_args(argv)

    dest = Path(args.dest).resolve()
    if not dest.is_dir():
        print(f"destination not found: {dest}")
        return 2

    copied = 0
    unchanged = 0
    for relative in iter_files(SRC):
        source = SRC / relative
        target = dest / relative
        if target.exists() and filecmp.cmp(source, target, shallow=False):
            unchanged += 1
            continue
        action = "update" if target.exists() else "create"
        print(f"{action:>6}  {relative}")
        if args.apply:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        copied += 1

    mode = "applied" if args.apply else "dry-run"
    print(f"\n{mode}: {copied} file(s) to sync, {unchanged} unchanged, destination {dest}")
    if not args.apply and copied:
        print("re-run with --apply to write")
    return 0


if __name__ == "__main__":
    sys.exit(main())
