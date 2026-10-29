#!/usr/bin/env python3
"""Merge list entries from a backup YAML file into the current one.

Generic version: keeps every entry already present in --current (the freshly installed
version wins) and re-adds top-level entries from --backup that are missing, keyed by
`id:` (or `name:` when there is no id). Useful to recover configuration after a reinstall.

    python merge_patch.py --backup old.yml --current current.yml --out merged.yml [--apply]

Only the standard library is used; the parser is line-oriented and expects a YAML list of
top-level entries that start with "- ".
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ENTRY_START = re.compile(r"^-\s")
KEY_LINE = re.compile(r"^\s*-?\s*(id|name)\s*:\s*(.+?)\s*$")


def split_entries(text: str):
    header, entries, current = [], [], None
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
    for wanted in ("id", "name"):
        for line in entry.splitlines():
            match = KEY_LINE.match(line)
            if match and match.group(1) == wanted:
                return f"{wanted}:{match.group(2).strip().strip(chr(39) + chr(34))}"
    return "entry:" + str(abs(hash(entry)) % 100000)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="merge YAML list entries (current wins, backup fills gaps)")
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
    added = []
    for entry in backup_entries:
        key = entry_key(entry)
        if key in current_map:
            continue
        current_entries.append(entry)
        current_map[key] = entry
        added.append(key)

    out_text = "".join(header) + "".join(current_entries)
    Path(args.out).write_text(out_text, encoding="utf-8", newline="")

    print(f"current entries: {len(current_map) - len(added)}")
    print(f"added from backup: {len(added)} -> {added}")
    print(f"written: {args.out}")

    if args.apply:
        Path(args.current).write_text(out_text, encoding="utf-8", newline="")
        print("applied over", args.current)
    return 0


if __name__ == "__main__":
    sys.exit(main())
