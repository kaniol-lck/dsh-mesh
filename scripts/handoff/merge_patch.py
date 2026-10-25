#!/usr/bin/env python3
"""Merge plugin entries from an old cordis.patch.yml backup into the current one.

Used to recover a profile after a crash wiped/disabled its config: keeps everything the
current file already has (so a freshly reinstalled plugin wins) and re-adds the missing
top-level entries from a backup — e.g. agent-default-model (model priority), llm-* provider
entries, ui-* display settings.

Entries containing "@local/" are skipped on purpose: that alias caused the duplicate client
module registration crash and must not come back.

    python merge_patch.py --backup OLD.yml --current cordis.patch.yml --out merged.yml [--apply]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ENTRY_START = re.compile(r"^-\s")
KEY_LINE = re.compile(r"^\s*-?\s*(id|name)\s*:\s*(.+?)\s*$")


def split_entries(text: str):
    header, entries = [], []
    current = None
    for line in text.splitlines(keepends=True):
        if ENTRY_START.match(line):
            if current is not None:
                entries.append(current)
            current = [line]
        elif current is None:
            header.append(line)
        else:
            current.append(line)
    if current is not None:
        entries.append(current)
    return header, ["".join(entry) for entry in entries]


def entry_key(entry: str) -> str:
    ident = None
    for line in entry.splitlines():
        match = KEY_LINE.match(line)
        if not match:
            continue
        if match.group(1) == "id":
            ident = match.group(2).strip().strip("'\"")
            break
    if ident:
        return ident
    for line in entry.splitlines():
        match = KEY_LINE.match(line)
        if match and match.group(1) == "name":
            return "name:" + match.group(2).strip().strip("'\"")
    return "entry:" + str(abs(hash(entry)) % 100000)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup", required=True)
    parser.add_argument("--current", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--apply", action="store_true", help="overwrite --current with the merge result")
    args = parser.parse_args(argv)

    current_text = Path(args.current).read_text(encoding="utf-8")
    backup_text = Path(args.backup).read_text(encoding="utf-8")

    header, current_entries = split_entries(current_text)
    _, backup_entries = split_entries(backup_text)

    current_map = {entry_key(entry): entry for entry in current_entries}
    added, kept = [], list(current_map)

    local_name = re.compile(r"(?m)^\s*-?\s*name\s*:\s*['\"]?@local/")
    for entry in backup_entries:
        # only drop an entry that actually installs a @local/* package; a comment that
        # merely mentions @local/ must not take a whole provider block with it
        if local_name.search(entry):
            continue
        key = entry_key(entry)
        if key in current_map:
            continue
        current_entries.append(entry)
        current_map[key] = entry
        added.append(key)

    out_text = "".join(header) + "".join(current_entries)
    Path(args.out).write_text(out_text, encoding="utf-8", newline="")

    print(f"current entries: {len(kept)}")
    print(f"added from backup: {len(added)} -> {added}")
    print(f"skipped @local entries: {sum(1 for e in backup_entries if local_name.search(e))}")
    print(f"written: {args.out}")

    if args.apply:
        Path(args.current).write_text(out_text, encoding="utf-8", newline="")
        print("applied over", args.current)
    return 0


if __name__ == "__main__":
    sys.exit(main())
