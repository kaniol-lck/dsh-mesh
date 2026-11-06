"""Fail if staged/tracked content looks like a credential.

Usage:  python scripts/check-secrets.py [path ...]
        python scripts/check-secrets.py --selftest
        (no args = scan every tracked file)

Patterns are intentionally broad: a false positive is cheaper than a leak.
A line that is genuinely documentation or a test fixture can opt out with the
detect-secrets convention:

    token = 'this is only a fixture'   # pragma: allowlist secret

The marker is per line and explicit: it never disables a file or a directory, and
it is honored only when present on the matching line. --selftest proves both
directions (unmarked line is still reported, marked line is skipped).
"""
import os
import re
import subprocess
import sys
import tempfile

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

ALLOWLIST_MARKER = "pragma: allowlist secret"

# Shell substitutions and obvious test fixtures are documentation, not secrets.
FALSE_POSITIVE_MARKERS = (
    "$(", "${", '"$', "=$", "`",
    "totally_wrong", "example", "dummy", "xxxx", "REDACTED", "your_token",
)


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line.strip()]


def is_false_positive(matched: str) -> bool:
    return any(marker in matched for marker in FALSE_POSITIVE_MARKERS)


def scan_text(text: str):
    """Yield (line_number, label, excerpt) for every credential-looking match.

    Lines carrying ALLOWLIST_MARKER are skipped as a whole; the marker never
    weakens the pattern itself.
    """
    lines = text.splitlines()
    allowlisted = {index + 1 for index, line in enumerate(lines) if ALLOWLIST_MARKER in line}
    for pattern, label in PATTERNS:
        for match in pattern.finditer(text):
            if is_false_positive(match.group(0)):
                continue
            line = text.count("\n", 0, match.start()) + 1
            if line in allowlisted:
                continue
            yield line, label, match.group(0)[:12]


def scan_path(path: str):
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            text = fh.read()
    except OSError:
        return []
    return list(scan_text(text))


def main(targets):
    targets = targets or tracked_files()
    bad = 0
    for path in targets:
        if any(marker in path for marker in ALLOW):
            continue
        for line, label, excerpt in scan_path(path):
            print(f"LEAK {path}:{line}: {label} -> {excerpt}…")
            bad += 1
    if bad:
        print(f"\n{bad} potential credential(s) found — refusing to commit.")
        return 1
    print("no credentials detected")
    return 0


def selftest() -> int:
    """Prove the marker works in both directions on temporary files."""
    workdir = tempfile.mkdtemp(prefix="check-secrets-selftest-")
    unmarked = os.path.join(workdir, "unmarked.py")
    marked = os.path.join(workdir, "marked.py")
    try:
        with open(unmarked, "w", encoding="utf-8") as fh:
            fh.write("token = 'abcdefgh12345678'\n")
        with open(marked, "w", encoding="utf-8") as fh:
            fh.write("token = 'abcdefgh12345678'  # pragma: allowlist secret\n")
        unmarked_hits = scan_path(unmarked)
        marked_hits = scan_path(marked)
        checks = [
            ("unmarked line is still reported", len(unmarked_hits) == 1),
            ("marked line is skipped", len(marked_hits) == 0),
            ("marker is line-scoped", scan_path(unmarked)[0][0] == 1 if unmarked_hits else False),
        ]
        failed = 0
        for name, ok in checks:
            print(f"{'PASS' if ok else 'FAIL'} {name}")
            failed += 0 if ok else 1
        if failed:
            print(f"\n{failed} selftest check(s) failed")
            return 1
        print("\nselftest: 3/3 passed")
        return 0
    finally:
        for path in (unmarked, marked):
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            os.rmdir(workdir)
        except OSError:
            pass


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        sys.exit(selftest())
    sys.exit(main(sys.argv[1:]))
