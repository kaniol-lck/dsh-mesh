"""Fail if staged/tracked content looks like a credential.

Usage:  python scripts/check-secrets.py [path ...]
        (no args = scan every tracked file)

Patterns are intentionally broad: a false positive is cheaper than a leak.
"""
import re
import subprocess
import sys

PATTERNS = [
    (re.compile(r"mesh_[A-Za-z0-9]{16,}"), "mesh agent token"),
    (re.compile(r"Bearer\s+[A-Za-z0-9._\-]{16,}"), "bearer token"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "github token"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "api key"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws key"),
    # A value that starts with / is a path (e.g. '/api/enroll/token') and a value that
    # starts with http(s):// is a URL: neither can be the credential itself.
    (re.compile(r"(?i)(password|passwd|secret|token)\s*[:=]\s*['\"](?!/|https?://)[^'\"]{8,}['\"]"), "inline credential"),
]

# Files that legitimately contain documentation about secrets.
ALLOW = (".gitignore", "check-secrets.py", "docs/", "README.md")


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line.strip()]


# Shell substitutions and obvious test fixtures are documentation, not secrets.
FALSE_POSITIVE_MARKERS = (
    "$(", "${", '"$', "=$", "`",
    "totally_wrong", "example", "dummy", "xxxx", "REDACTED", "your_token",
)


def is_false_positive(matched: str) -> bool:
    return any(marker in matched for marker in FALSE_POSITIVE_MARKERS)


def main():
    targets = sys.argv[1:] or tracked_files()
    bad = 0
    for path in targets:
        if any(marker in path for marker in ALLOW):
            continue
        try:
            with open(path, encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except OSError:
            continue
        for pattern, label in PATTERNS:
            for match in pattern.finditer(text):
                if is_false_positive(match.group(0)):
                    continue
                line = text.count("\n", 0, match.start()) + 1
                print(f"LEAK {path}:{line}: {label} -> {match.group(0)[:12]}…")
                bad += 1
    if bad:
        print(f"\n{bad} potential credential(s) found — refusing to commit.")
        return 1
    print("no credentials detected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
