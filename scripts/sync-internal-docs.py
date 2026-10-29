#!/usr/bin/env python3
"""Sync .worklog/docs-internal/** into the private mirror repo (../transfer/docs/internal).

Internal docs never enter the public repo: they live in the ignored .worklog/ tree and
are mirrored to the private transfer repo. Dry-run by default; --apply writes, commits
and (unless --no-push) pushes.

Exit codes: 0 ok / no changes, 1 argument or safety failure, 2 git failure.
"""
import argparse
import datetime
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = REPO / ".worklog" / "docs-internal"
TRANSFER = REPO.parent / "transfer"
DST_DIR = TRANSFER / "docs" / "internal"


def git(args, cwd):
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)


def list_files(root: Path):
    if not root.is_dir():
        return {}
    return {p.relative_to(root).as_posix(): p for p in sorted(root.rglob("*")) if p.is_file()}


def scan_secrets(paths):
    if not paths:
        return 0
    proc = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "check-secrets.py"), *[str(p) for p in paths]],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print((proc.stdout or proc.stderr).strip(), file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="mirror .worklog/docs-internal into ../transfer/docs/internal")
    parser.add_argument("--apply", action="store_true", help="write, commit and push (default: dry-run)")
    parser.add_argument("--no-push", action="store_true", help="commit but do not push")
    parser.add_argument("--prune", action="store_true", help="delete target files missing from the source")
    parser.add_argument("--message", help="custom commit message")
    args = parser.parse_args()

    if not (TRANSFER / ".git").exists():
        print(f"not a git repo: {TRANSFER}", file=sys.stderr)
        return 1

    source = list_files(SRC)
    target = list_files(DST_DIR)
    added = sorted(set(source) - set(target))
    updated = sorted(name for name in set(source) & set(target) if source[name].read_bytes() != target[name].read_bytes())
    deleted = sorted(set(target) - set(source))

    print(f"source: {SRC}")
    print(f"target: {DST_DIR}")
    for name in added:
        print(f"  add     {name}")
    for name in updated:
        print(f"  update  {name}")
    for name in deleted:
        print(f"  delete  {name}" + ("" if args.prune else "  (skipped: pass --prune)"))
    if not added and not updated and not deleted:
        print("无变更")
        return 0

    if not args.apply:
        print("dry-run: no files written (pass --apply to sync)")
        return 0

    status = git(["status", "--porcelain"], TRANSFER)
    if status.returncode != 0:
        print(f"git status failed in {TRANSFER}: {status.stderr.strip()}", file=sys.stderr)
        return 2
    if status.stdout.strip():
        print("refusing to sync: ../transfer has uncommitted changes", file=sys.stderr)
        print(status.stdout.strip(), file=sys.stderr)
        return 1

    code = scan_secrets([source[name] for name in added + updated])
    if code != 0:
        print("refusing to sync: potential credential(s) in internal docs", file=sys.stderr)
        return 1

    for name in added + updated:
        dest = DST_DIR / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source[name], dest)
    if args.prune:
        for name in deleted:
            (DST_DIR / name).unlink()

    add = git(["add", "docs/internal"], TRANSFER)
    if add.returncode != 0:
        print(f"git add failed: {add.stderr.strip()}", file=sys.stderr)
        return 2
    staged = git(["diff", "--cached", "--name-only"], TRANSFER)
    if not staged.stdout.strip():
        print("无变更")
        return 0

    message = args.message or f"internal docs: sync {datetime.datetime.now():%Y-%m-%d %H:%M}"
    commit = git(["commit", "-m", message], TRANSFER)
    if commit.returncode != 0:
        print(f"git commit failed: {commit.stderr.strip()}", file=sys.stderr)
        return 2
    print(f"committed: {message}")

    if not args.no_push:
        push = git(["push"], TRANSFER)
        if push.returncode != 0:
            print(f"git push failed: {push.stderr.strip()}", file=sys.stderr)
            return 2
        print("pushed to transfer remote")
    return 0


if __name__ == "__main__":
    sys.exit(main())
