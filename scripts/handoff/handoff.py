#!/usr/bin/env python3
"""mesh handoff — package a workspace + its context, ship it over the dsh-mesh blob channel,
and negotiate missing prerequisites with the sender.

Subcommands
    pack     workspace -> handoff.tar.gz (+ handoff/manifest.json)
    send     upload the bundle (resumable) and notify the peer
    receive  download + verify sha256 + extract + verify requirements
    verify   check a received bundle against its manifest (no network)
    msg      send a protocol message (needs / accepted / instructions / release / delta)

Environment
    MESH_HUB_URL   hub base URL            (default http://127.0.0.1:8790)
    MESH_TOKEN     this agent's token      (default: ~/.dsh/mesh-waker/token)

Exit codes: 0 ok, 2 verification found missing prerequisites, 1 other error.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_EXCLUDES = [
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    "*.log", "*.env", ".env*", "token", "token*", "wake-secret", "*.secret",
    "conversations.json", "trust.json",
]
SECRET_PATTERNS = [
    r"mesh_[A-Za-z0-9_-]{20,}", r"npm_[A-Za-z0-9]{20,}", r"sk-[A-Za-z0-9]{20,}",
    r"ghp_[A-Za-z0-9]{20,}", r"Bearer [A-Za-z0-9._-]{20,}",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
]


# --------------------------------------------------------------------------- config
def hub_url() -> str:
    return os.environ.get("MESH_HUB_URL", "http://127.0.0.1:8790").rstrip("/")


def token() -> str:
    value = os.environ.get("MESH_TOKEN")
    if value:
        return value.strip()
    path = Path(os.environ.get("MESH_TOKEN_FILE", Path.home() / ".dsh" / "mesh-waker" / "token"))
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    sys.exit("no token: set MESH_TOKEN or MESH_TOKEN_FILE")


def opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path: str, payload=None, method: str = None, ctype: str = "application/json", timeout: int = 60):
    url = hub_url() + path
    data = None
    if payload is not None:
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Authorization": "Bearer " + token(), "Content-Type": ctype},
        method=method or ("POST" if data is not None else "GET"),
    )
    try:
        with opener().open(req, timeout=timeout) as resp:
            body = resp.read()
            return json.loads(body.decode()) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        raise SystemExit(f"hub HTTP {error.code}: {detail}")


# --------------------------------------------------------------------------- helpers
def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def excluded(rel: str, patterns) -> bool:
    parts = rel.split("/")
    for pattern in patterns:
        if any(fnmatch.fnmatch(part, pattern) for part in parts):
            return True
        if fnmatch.fnmatch(rel, pattern):
            return True
    return False


def scan_secrets(root: Path) -> list[str]:
    hits = []
    for path in root.rglob("*"):
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pattern in SECRET_PATTERNS:
            if re.search(pattern, text):
                hits.append(str(path.relative_to(root)))
                break
    return hits


def detect_requirements(workspace: Path) -> dict:
    requirements = {"commands": [], "python": [], "dshPlugins": [], "skills": [], "env": []}
    if (workspace / "package.json").exists():
        requirements["commands"].append({"name": "node", "minVersion": "20", "blocking": True})
        requirements["commands"].append({"name": "npm", "blocking": False})
    if (workspace / "requirements.txt").exists() or any(workspace.rglob("*.py")):
        requirements["commands"].append({"name": "python", "minVersion": "3.10", "blocking": True})
    for candidate in ("manifest.json", "handoff.requires.json"):
        path = workspace / candidate
        if path.exists():
            try:
                extra = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            for key in requirements:
                requirements[key].extend(extra.get(key, []))
            break
    return requirements


# --------------------------------------------------------------------------- commands
def cmd_pack(args) -> int:
    workspace = Path(args.workspace).resolve()
    out = Path(args.out).resolve()
    if not workspace.is_dir():
        return fail(f"workspace not found: {workspace}")

    patterns = DEFAULT_EXCLUDES + [p for p in (args.exclude or "").split(",") if p]
    hits = scan_secrets(workspace)
    if hits and not args.force:
        return fail("refusing to pack: possible secrets in " + ", ".join(hits[:5]) + " (use --force to override)")

    manifest = {
        "handoffId": args.id or time.strftime("%Y%m%d-%H%M%S"),
        "from": args.from_agent or os.environ.get("MESH_AGENT", "unknown"),
        "createdAt": int(time.time() * 1000),
        "conversation": args.conversation,
        "round": 0,
        "workspace": {"root": "workspace/", "git": git_head(workspace)},
        "requirements": args.requirements
        and json.loads(Path(args.requirements).read_text(encoding="utf-8"))
        or detect_requirements(workspace),
        "nextSteps": [s for s in (args.next or "").split("|") if s],
        "installHints": {},
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out, "w:gz") as tar:
        for path in sorted(workspace.rglob("*")):
            rel = path.relative_to(workspace).as_posix()
            if excluded(rel, patterns):
                continue
            tar.add(path, arcname="workspace/" + rel)
        blob = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
        info = tarfile.TarInfo("handoff/manifest.json")
        info.size = len(blob)
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(blob))

    size = out.stat().st_size
    digest = sha256_file(out)
    print(json.dumps({"bundle": str(out), "bytes": size, "sha256": digest, "handoffId": manifest["handoffId"],
                      "requirements": manifest["requirements"]}, ensure_ascii=False, indent=2))
    return 0


def git_head(workspace: Path):
    try:
        result = subprocess.run(["git", "-C", str(workspace), "rev-parse", "HEAD"],
                                capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return {"commit": result.stdout.strip()}
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def upload(path: Path, visible_to: str) -> dict:
    size = path.stat().st_size
    digest = sha256_file(path)
    init = api("/api/blob/init", {
        "name": path.name, "bytes": size, "sha256": digest, "visible_to": visible_to,
    })
    chunk_size = 1024 * 1024
    with path.open("rb") as handle:
        offset = 0
        while offset < size:
            block = handle.read(chunk_size)
            api(f"/api/blob/{init['id']}/chunk?offset={offset}", block, method="PUT",
                ctype="application/octet-stream", timeout=120)
            offset += len(block)
    commit = api(f"/api/blob/{init['id']}/commit", {})
    return {"id": commit["id"], "sha256": commit["sha256"], "bytes": commit["bytes"],
            "url": commit["url"], "name": path.name}


def cmd_send(args) -> int:
    path = Path(args.file).resolve()
    if not path.exists():
        return fail(f"file not found: {path}")
    visible = args.visible_to or f"{os.environ.get('MESH_AGENT', '')},{args.to}".strip(",")
    receipt = upload(path, visible)
    body = {
        "type": args.type,
        "handoffId": args.id,
        "conversation": args.conversation,
        "blob": receipt,
        "nextSteps": [s for s in (args.next or "").split("|") if s],
        "round": args.round,
        "note": args.message or "",
    }
    message = api("/api/send", {
        "to": args.to,
        "subject": f"handoff.{args.type} {args.id}".strip(),
        "body": json.dumps(body, ensure_ascii=False),
        "conversation": args.conversation,
        "important": True,
    })
    print(json.dumps({"uploaded": receipt, "message": message}, ensure_ascii=False, indent=2))
    return 0


def cmd_receive(args) -> int:
    target = Path(args.dir).resolve()
    target.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(hub_url() + f"/api/blob/{args.id}",
                                 headers={"Authorization": "Bearer " + token()})
    with opener().open(req, timeout=180) as response:
        payload = response.read()
    digest = hashlib.sha256(payload).hexdigest()
    if args.sha256 and digest != args.sha256:
        return fail(f"sha256 mismatch: expected {args.sha256}, got {digest}")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        try:
            tar.extractall(target, filter="data")
        except TypeError:
            tar.extractall(target)
    result = verify(target)
    result["bundle_sha256"] = digest
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result["missing"] else 0


def version_tuple(text: str):
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", text or "")
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def command_version(name: str) -> str | None:
    for flag in ("--version", "-v", "version"):
        try:
            result = subprocess.run([name, flag], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return None
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode == 0 and output.strip():
            return output.strip().splitlines()[0]
    return None


def verify(root: Path) -> dict:
    manifest_path = root / "handoff" / "manifest.json"
    if not manifest_path.exists():
        return {"ok": False, "error": "manifest missing", "missing": [], "checked": []}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    requirements = manifest.get("requirements", {})
    vendor = root / "vendor" / "bin"
    search_path = os.environ.get("PATH", "")
    if vendor.is_dir():
        os.environ["PATH"] = str(vendor) + os.pathsep + search_path

    ok, missing, checked = [], [], []

    for entry in requirements.get("commands", []):
        name = entry["name"]
        found = shutil.which(name)
        version = command_version(name) if found else None
        need = entry.get("minVersion")
        blocking = entry.get("blocking", True)
        if not found:
            missing.append({"kind": "command", "name": name, "need": need, "blocking": blocking,
                            "hint": entry.get("hint")})
            continue
        if need:
            have = version_tuple(version or "")
            want = version_tuple(need)
            if have and want and have < want:
                missing.append({"kind": "command", "name": name, "have": version, "need": need,
                                "blocking": blocking, "hint": entry.get("hint")})
                continue
        ok.append({"kind": "command", "name": name, "version": version})

    import importlib.util
    for entry in requirements.get("python", []):
        module = entry["module"] if isinstance(entry, dict) else entry
        blocking = entry.get("blocking", True) if isinstance(entry, dict) else True
        found = importlib.util.find_spec(module) is not None
        if found:
            ok.append({"kind": "python", "name": module})
        else:
            missing.append({"kind": "python", "name": module, "blocking": blocking,
                            "hint": entry.get("hint") if isinstance(entry, dict) else None})

    for entry in requirements.get("dshPlugins", []):
        name = entry["name"] if isinstance(entry, dict) else str(entry)
        blocking = entry.get("blocking", True) if isinstance(entry, dict) else True
        installed = any(Path(p).exists() for p in (
            Path.home() / ".dsh" / "profiles" / "desktop" / "node_modules" / name,
            Path.home() / ".dsh" / "profiles" / "web" / "node_modules" / name,
        ))
        (ok if installed else missing).append({"kind": "dshPlugin", "name": name, "blocking": blocking,
                                               "hint": entry.get("hint") if isinstance(entry, dict) else None})

    for entry in requirements.get("skills", []):
        name = entry["name"] if isinstance(entry, dict) else str(entry)
        blocking = entry.get("blocking", True) if isinstance(entry, dict) else True
        installed = (Path.home() / ".dsh" / "skills" / name).exists()
        (ok if installed else missing).append({"kind": "skill", "name": name, "blocking": blocking})

    for entry in requirements.get("env", []):
        name = entry["name"] if isinstance(entry, dict) else str(entry)
        blocking = entry.get("blocking", True) if isinstance(entry, dict) else True
        (ok if name in os.environ else missing).append({"kind": "env", "name": name, "blocking": blocking})

    checked.append({"handoffId": manifest.get("handoffId"), "round": manifest.get("round", 0)})
    blocking_missing = [item for item in missing if item.get("blocking", True)]
    return {
        "ok": not blocking_missing,
        "handoffId": manifest.get("handoffId"),
        "conversation": manifest.get("conversation"),
        "nextSteps": manifest.get("nextSteps", []),
        "checked": checked,
        "satisfied": ok,
        "missing": missing,
        "blockingMissing": blocking_missing,
    }


def cmd_verify(args) -> int:
    result = verify(Path(args.dir).resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result["blockingMissing"] else 0


def cmd_msg(args) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    payload = {
        "type": args.type,
        "handoffId": args.id,
        "round": args.round,
        "missing": json.loads(args.missing) if args.missing else None,
        "note": body,
    }
    message = api("/api/send", {
        "to": args.to,
        "subject": f"handoff.{args.type} {args.id}".strip(),
        "body": json.dumps(payload, ensure_ascii=False),
        "conversation": args.conversation,
        "important": True,
    })
    print(json.dumps(message, ensure_ascii=False, indent=2))
    return 0


def fail(message: str) -> int:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return 1


# --------------------------------------------------------------------------- cli
def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="handoff", description="dsh-mesh workspace handoff")
    sub = parser.add_subparsers(dest="cmd", required=True)

    pack = sub.add_parser("pack", help="workspace -> bundle")
    pack.add_argument("--workspace", required=True)
    pack.add_argument("--out", required=True)
    pack.add_argument("--exclude", default="")
    pack.add_argument("--id", default="")
    pack.add_argument("--from-agent", default="")
    pack.add_argument("--conversation", default="")
    pack.add_argument("--next", default="")
    pack.add_argument("--requirements", default="")
    pack.add_argument("--force", action="store_true")
    pack.set_defaults(func=cmd_pack)

    send = sub.add_parser("send", help="upload + notify")
    send.add_argument("--file", required=True)
    send.add_argument("--to", required=True)
    send.add_argument("--conversation", required=True)
    send.add_argument("--id", required=True)
    send.add_argument("--visible-to", default="")
    send.add_argument("--type", default="package")
    send.add_argument("--round", type=int, default=0)
    send.add_argument("--message", default="")
    send.add_argument("--next", default="")
    send.set_defaults(func=cmd_send)

    receive = sub.add_parser("receive", help="download + extract + verify")
    receive.add_argument("--id", required=True)
    receive.add_argument("--dir", required=True)
    receive.add_argument("--sha256", default="")
    receive.set_defaults(func=cmd_receive)

    verify_cmd = sub.add_parser("verify", help="verify an extracted bundle")
    verify_cmd.add_argument("--dir", required=True)
    verify_cmd.set_defaults(func=cmd_verify)

    msg = sub.add_parser("msg", help="send a protocol message")
    msg.add_argument("--type", required=True,
                     choices=["needs", "accepted", "instructions", "release", "delta"])
    msg.add_argument("--to", required=True)
    msg.add_argument("--conversation", required=True)
    msg.add_argument("--id", required=True)
    msg.add_argument("--round", type=int, default=0)
    msg.add_argument("--missing", default="")
    msg.add_argument("--body", default="")
    msg.add_argument("--body-file", default="")
    msg.set_defaults(func=cmd_msg)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
