#!/usr/bin/env python3
"""One command to close a round: refresh the roadmap, run every gate, sync internal docs.

Order matters: the roadmap is refreshed and verified first, then the path/secret gates,
then internal docs are mirrored (and pushed) to the private transfer repo.

Exit codes: 0 all green, 1 a step failed (the failing step is printed).
"""
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

STEPS = [
    ("roadmap --write", ["node", "scripts/roadmap.mjs", "--write"]),
    ("roadmap --check", ["node", "scripts/roadmap.mjs", "--check"]),
    ("check-paths", ["node", "scripts/check-paths.mjs"]),
    ("check-secrets", [sys.executable, "scripts/check-secrets.py"]),
    ("sync internal docs", [sys.executable, "scripts/sync-internal-docs.py", "--apply"]),
]


def main() -> int:
    for label, command in STEPS:
        print(f"==> {label}")
        proc = subprocess.run(command, cwd=REPO)
        if proc.returncode != 0:
            print(f"ROUND CLOSE FAILED at step: {label} (exit {proc.returncode})", file=sys.stderr)
            return 1
    print("ROUND CLOSE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
