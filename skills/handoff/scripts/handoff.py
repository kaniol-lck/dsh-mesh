#!/usr/bin/env python3
"""Workspace handoff: package a workspace + context, ship it over a mesh hub, and
negotiate missing prerequisites with the sender.

Generic, dependency-free (Python standard library only). Works with any mesh hub that
implements the blob channel (`/api/blob/*`) and the message API (`/api/send`).

Subcommands
    pack     workspace -> handoff.tar.gz (+ handoff/manifest.json), secret-scanned
    send     upload the bundle (resumable) and notify the peer
    receive  fetch a bundle (remote id or local file) + verify sha256 + extract + verify deps
    verify   check an extracted bundle against its manifest (no network)
    msg      send a protocol message (needs / accepted / instructions / release / delta)

Configuration (no built-in defaults; nothing is hard-coded):
    MESH_HUB        hub base URL, e.g. https://<hub-url>
    MESH_TOKEN      this agent's token (or MESH_TOKEN_FILE pointing at a 0600 file)
    MESH_AGENT      this agent's name, used in manifests and visible_to
    --hub / --token-file override the environment per command.

Exit codes: 0 ok, 2 verification found blocking missing prerequisites, 1 other error.
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
import ssl
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# Never packed by default: VCS, dependencies, build output, credentials.
DEFAULT_EXCLUDES = [
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "build*",
    "*.log", "*.env", ".env*", "token", "token*", "wake-secret", "*.secret",
    "*.key", "*.pem", "conversations.json", "trust.json",
    # Vendored runtimes and build artifacts are binary; they never belong in a handoff
    # bundle and reading them as text is what produced the false secret hits.
    "*.exe", "*.dll", "*.so", "*.dylib", "*.pyc", "*.jar",
    "*.png", "*.jpg", "*.jpeg", "*.zip", "*.gz", "*.woff2",
]
BINARY_EXTENSIONS = {
    ".exe", ".dll", ".so", ".dylib", ".pyc", ".jar", ".class", ".o", ".a", ".lib",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip", ".gz", ".7z", ".woff", ".woff2",
    ".ttf", ".otf", ".bin", ".dat", ".dylib", ".pyd",
}
MAX_SECRET_SCAN_BYTES = 2_000_000
# Documentation may quote example keys ("-----BEGIN ... PRIVATE KEY-----", sample passwords).
DOC_SUFFIXES = {".md", ".markdown", ".html", ".htm", ".txt", ".rst"}


def plausible_secret_value(value: str) -> bool:
    """Reject obvious non-secrets so vendored code/docs do not block a pack.

    "prompt='Password: '", 'token=" + repr(raw)' and "${{ secrets.TOKEN }}" are code,  # pragma: allowlist secret
    not credentials: a real literal has no spaces, braces, quotes or concatenation.
    """
    if len(value) < 16 or value.startswith(("/", "http://", "https://")):
        return False
    return re.fullmatch(r"[^\s{}`'+\"']+", value) is not None
# Broad on purpose: a false positive is cheaper than leaking a credential.
SECRET_PATTERNS = [
    r"mesh_[A-Za-z0-9_-]{20,}",
    r"npm_[A-Za-z0-9]{20,}",
    r"sk-[A-Za-z0-9]{20,}",
    r"gh[pousr]_[A-Za-z0-9]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"Bearer [A-Za-z0-9._-]{20,}",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"(?i)(password|passwd|secret|token)\s*[:=]\s*['\"](?!/|https?://)([^'\"]{8,})['\"]",
]


# --------------------------------------------------------------------------- config
def hub_url(args) -> str:
    value = getattr(args, "hub", None) or os.environ.get("MESH_HUB")
    if not value:
        sys.exit("no hub: pass --hub <url> or set MESH_HUB")
    return value.rstrip("/")


def token(args) -> str:
    value = os.environ.get("MESH_TOKEN")
    if value:
        return value.strip()
    path = Path(getattr(args, "token_file", None) or os.environ.get("MESH_TOKEN_FILE", ""))
    if str(path) and path.exists():
        return path.read_text(encoding="utf-8").strip()
    sys.exit("no token: set MESH_TOKEN, MESH_TOKEN_FILE or pass --token-file")


def normalize_sha(value: str) -> str:
    """Same normalisation as the waker's caSha256: hex only, lowercase."""
    return re.sub(r"[^0-9a-fA-F]", "", value or "").lower()


def ca_context(args):
    """SSL context trusting --ca / $MESH_CA_FILE, or None for the system trust store.

    A self-signed hub is reached through an frp TCP tunnel, so the CA must be
    delivered out of band: /api/bootstrap is itself behind TLS, and NODE_EXTRA_CA_CERTS
    only affects Node, not Python.
    """
    ca_file = getattr(args, "ca", None) or os.environ.get("MESH_CA_FILE", "")
    expected = getattr(args, "ca_sha256", None) or os.environ.get("MESH_CA_SHA256", "")
    if not ca_file:
        if expected:
            sys.exit("--ca-sha256 needs --ca (or MESH_CA_FILE): cannot check a fingerprint without the file")
        return None
    path = Path(ca_file)
    if not path.is_file():
        sys.exit(f"CA file not found: {path}")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected:
        wanted = normalize_sha(expected)
        if wanted != actual:
            sys.exit(f"CA fingerprint mismatch: expected {wanted[:16]}… actual {actual[:16]}…")
    return ssl.create_default_context(cafile=str(path))


def opener(args=None) -> urllib.request.OpenerDirector:
    context = ca_context(args) if args is not None else None
    if context is None:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))


def api(args, path: str, payload=None, method: str = None, ctype: str = "application/json", timeout: int = 60):
    data = None
    if payload is not None:
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    request = urllib.request.Request(
        hub_url(args) + path,
        data=data,
        headers={"Authorization": "Bearer " + token(args), "Content-Type": ctype},
        method=method or ("POST" if data is not None else "GET"),
    )
    try:
        with opener(args).open(request, timeout=timeout) as response:
            body = response.read()
            return json.loads(body.decode()) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        raise SystemExit(f"hub HTTP {error.code}: {detail}")
    except urllib.error.URLError as error:
        reason = error.reason
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise SystemExit(
                "TLS verification failed: the hub certificate is not trusted. "
                "For a self-signed hub pass --ca <ca.crt> (or MESH_CA_FILE); "
                "the CA cannot be downloaded from /api/bootstrap because that endpoint is also behind TLS."
            )
        raise SystemExit(f"cannot reach hub: {reason}")


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


def secret_hit(text: str, suffix: str) -> bool:
    """True when any pattern matches, with the false-positive filters applied."""
    for index, pattern in enumerate(SECRET_PATTERNS):
        match = re.search(pattern, text)
        if not match:
            continue
        if index == 7:
            line_start = text.rfind("\n", 0, match.start()) + 1
            line_text = text[line_start:text.find("\n", match.start())]
            if line_text.lstrip().startswith("#"):
                continue
            if not plausible_secret_value(match.group(2)):
                continue
        if index == 6 and suffix in DOC_SUFFIXES:
            continue
        return True
    return False


def stream_has_secret(path: Path) -> bool:
    """Chunked scan for files above MAX_SECRET_SCAN_BYTES; never loads the whole file."""
    suffix = path.suffix.lower()
    overlap = ""
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            text = overlap + chunk.decode("utf-8", errors="ignore")
            if secret_hit(text, suffix):
                return True
            overlap = text[-4096:]
    return False


def scan_secrets(root: Path, patterns, allow_large: bool = False) -> dict:
    """Scan what would actually be packed, and decide what a large file means.

    Excluded paths are never read. Binaries are skipped by extension or a NUL byte in the
    first 8 KiB. Files above MAX_SECRET_SCAN_BYTES are excluded from the bundle by default
    (excludedLargeFiles, with a sample) — not silently scanned-and-dropped; --allow-large
    keeps them but requires a streaming scan first, so size never bypasses the check.
    """
    hits = []
    excluded_binary = 0
    excluded_large = 0
    large_sample = []
    contains_large = False
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if excluded(rel, patterns):
            continue
        try:
            size = path.stat().st_size
            with path.open("rb") as handle:
                head = handle.read(8192)
        except OSError:
            continue
        if path.suffix.lower() in BINARY_EXTENSIONS or b"\x00" in head:
            excluded_binary += 1
            continue
        if size > MAX_SECRET_SCAN_BYTES:
            if not allow_large:
                excluded_large += 1
                if len(large_sample) < 10:
                    large_sample.append(rel)
                continue
            contains_large = True
            try:
                if stream_has_secret(path):
                    hits.append(rel)
            except OSError:
                continue
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if secret_hit(text, path.suffix.lower()):
            hits.append(rel)
    return {
        "hits": hits,
        "excludedBinaryFiles": excluded_binary,
        "excludedLargeFiles": excluded_large,
        "excludedLargeSample": large_sample,
        "containsLargeFiles": contains_large,
    }

def detect_requirements(workspace: Path) -> dict:
    requirements = {"commands": [], "python": [], "env": []}
    if (workspace / "package.json").exists():
        requirements["commands"].append({"name": "node", "minVersion": "20", "blocking": True})
        requirements["commands"].append({"name": "npm", "blocking": False})
    if (workspace / "requirements.txt").exists() or any(workspace.rglob("*.py")):
        requirements["commands"].append({"name": "python", "minVersion": "3.10", "blocking": True})
    custom = workspace / "handoff.requires.json"
    if custom.exists():
        try:
            extra = json.loads(custom.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return requirements
        for key in requirements:
            value = extra.get(key) or []
            if isinstance(value, dict):
                value = [{"name": name, "minVersion": version} for name, version in value.items()]
            requirements[key].extend(value)
    return requirements


def git_head(workspace: Path):
    try:
        result = subprocess.run(["git", "-C", str(workspace), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return {"commit": result.stdout.strip()}
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def fail(message: str) -> int:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return 1


# --------------------------------------------------------------------------- pack
def cmd_pack(args) -> int:
    workspace = Path(args.workspace).resolve()
    out = Path(args.out).resolve()
    if not workspace.is_dir():
        return fail(f"workspace not found: {workspace}")

    patterns = DEFAULT_EXCLUDES + [item for item in (args.exclude or "").split(",") if item]
    scan = scan_secrets(workspace, patterns, allow_large=bool(args.allow_large))
    if scan["hits"]:
        print(json.dumps({
            "ok": False,
            "error": "refusing to pack: possible secrets",
            "files": scan["hits"][:20],
            "excludedBinaryFiles": scan["excludedBinaryFiles"],
            "excludedLargeFiles": scan["excludedLargeFiles"],
            "excludedLargeSample": scan["excludedLargeSample"],
        }, ensure_ascii=False, indent=2))
        return 1

    manifest = {
        "handoffId": args.id or time.strftime("%Y%m%d-%H%M%S"),
        "from": args.from_agent or os.environ.get("MESH_AGENT", "unknown"),
        "createdAt": int(time.time() * 1000),
        "conversation": args.conversation,
        "round": 0,
        "workspace": {"root": "workspace/", "git": git_head(workspace)},
        "requirements": json.loads(Path(args.requirements).read_text(encoding="utf-8"))
        if args.requirements
        else detect_requirements(workspace),
        "nextSteps": [step for step in (args.next or "").split("|") if step],
        "containsLargeFiles": scan["containsLargeFiles"],
        "excludedLargeFiles": scan["excludedLargeFiles"],
        "excludedBinaryFiles": scan["excludedBinaryFiles"],
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    packed = 0
    with tarfile.open(out, "w:gz") as tar:
        for path in sorted(workspace.rglob("*")):
            # Files only: adding a directory makes tar recurse into it, and rglob then
            # adds the same children again (duplicate entries in the bundle).
            if not path.is_file():
                continue
            rel = path.relative_to(workspace).as_posix()
            if excluded(rel, patterns):
                continue
            try:
                too_large = path.stat().st_size > MAX_SECRET_SCAN_BYTES
            except OSError:
                too_large = False
            if too_large and not args.allow_large:
                continue
            tar.add(path, arcname="workspace/" + rel)
            packed += 1
        blob = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
        info = tarfile.TarInfo("handoff/manifest.json")
        info.size = len(blob)
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(blob))

    size = out.stat().st_size
    if args.max_bytes and size > args.max_bytes:
        return fail(f"bundle is {size} bytes, above --max-bytes {args.max_bytes}; trim the workspace or raise the hub limit")
    digest = sha256_file(out)
    print(json.dumps(
        {"bundle": str(out), "bytes": size, "sha256": digest, "handoffId": manifest["handoffId"],
         "fileCount": packed,
         "excludedBinaryFiles": scan["excludedBinaryFiles"],
         "excludedLargeFiles": scan["excludedLargeFiles"],
         "excludedLargeSample": scan["excludedLargeSample"],
         "containsLargeFiles": scan["containsLargeFiles"],
         "requirements": manifest["requirements"]},
        ensure_ascii=False, indent=2,
    ))
    return 0


# --------------------------------------------------------------------------- send
def upload(args, path: Path, visible_to: str) -> dict:
    size = path.stat().st_size
    digest = sha256_file(path)
    init = api(args, "/api/blob/init", {"name": path.name, "bytes": size, "sha256": digest, "visible_to": visible_to})
    chunk_size = 1024 * 1024
    with path.open("rb") as handle:
        offset = 0
        while offset < size:
            block = handle.read(chunk_size)
            api(args, f"/api/blob/{init['id']}/chunk?offset={offset}", block, method="PUT", ctype="application/octet-stream", timeout=120)
            offset += len(block)
    commit = api(args, f"/api/blob/{init['id']}/commit", {})
    return {"id": commit["id"], "sha256": commit["sha256"], "bytes": commit["bytes"], "url": commit.get("url"), "name": path.name}


def cmd_send(args) -> int:
    path = Path(args.file).resolve()
    if not path.exists():
        return fail(f"file not found: {path}")
    visible = args.visible_to or f"{os.environ.get('MESH_AGENT', '')},{args.to}".strip(",")
    receipt = upload(args, path, visible)
    body = {
        "type": args.type,
        "handoffId": args.id,
        "conversation": args.conversation,
        "blob": receipt,
        "nextSteps": [step for step in (args.next or "").split("|") if step],
        "round": args.round,
        "note": args.message or "",
    }
    message = api(args, "/api/send", {
        "to": args.to,
        "subject": f"handoff.{args.type} {args.id}".strip(),
        "body": json.dumps(body, ensure_ascii=False),
        "conversation": args.conversation,
        "important": True,
    })
    print(json.dumps({"uploaded": receipt, "message": message}, ensure_ascii=False, indent=2))
    return 0


# --------------------------------------------------------------------------- receive / verify
def extract_bundle(payload: bytes, target: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        try:
            tar.extractall(target, filter="data")
        except TypeError:
            tar.extractall(target)


def cmd_receive(args) -> int:
    target = Path(args.dir).resolve()
    target.mkdir(parents=True, exist_ok=True)
    if args.bundle:
        payload = Path(args.bundle).read_bytes()
    else:
        request = urllib.request.Request(hub_url(args) + f"/api/blob/{args.id}", headers={"Authorization": "Bearer " + token(args)})
        with opener().open(request, timeout=180) as response:
            payload = response.read()
    digest = hashlib.sha256(payload).hexdigest()
    if args.sha256 and digest != args.sha256:
        return fail(f"sha256 mismatch: expected {args.sha256}, got {digest}")
    extract_bundle(payload, target)
    result = verify(target)
    result["bundle_sha256"] = digest
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result["blockingMissing"] else 0


def version_tuple(text: str):
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", text or "")
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def command_version(name: str):
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
        return {"ok": False, "error": "manifest missing", "satisfied": [], "missing": [], "blockingMissing": []}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    requirements = manifest.get("requirements", {})
    vendor = root / "vendor" / "bin"
    if vendor.is_dir():
        os.environ["PATH"] = str(vendor) + os.pathsep + os.environ.get("PATH", "")

    satisfied, missing = [], []
    for entry in requirements.get("commands", []):
        name = entry["name"]
        found = shutil.which(name)
        version = command_version(name) if found else None
        need = entry.get("minVersion")
        blocking = entry.get("blocking", True)
        if not found:
            missing.append({"kind": "command", "name": name, "need": need, "blocking": blocking, "hint": entry.get("hint")})
            continue
        if need:
            have = version_tuple(version or "")
            want = version_tuple(need)
            if have and want and have < want:
                missing.append({"kind": "command", "name": name, "have": version, "need": need, "blocking": blocking, "hint": entry.get("hint")})
                continue
        satisfied.append({"kind": "command", "name": name, "version": version})

    import importlib.util
    for entry in requirements.get("python", []):
        module = entry["module"] if isinstance(entry, dict) else entry
        blocking = entry.get("blocking", True) if isinstance(entry, dict) else True
        if importlib.util.find_spec(module) is not None:
            satisfied.append({"kind": "python", "name": module})
        else:
            missing.append({"kind": "python", "name": module, "blocking": blocking, "hint": entry.get("hint") if isinstance(entry, dict) else None})

    for entry in requirements.get("env", []):
        name = entry["name"] if isinstance(entry, dict) else str(entry)
        blocking = entry.get("blocking", True) if isinstance(entry, dict) else True
        (satisfied if name in os.environ else missing).append({"kind": "env", "name": name, "blocking": blocking})

    blocking_missing = [item for item in missing if item.get("blocking", True)]
    return {
        "ok": not blocking_missing,
        "handoffId": manifest.get("handoffId"),
        "conversation": manifest.get("conversation"),
        "nextSteps": manifest.get("nextSteps", []),
        "satisfied": satisfied,
        "missing": missing,
        "blockingMissing": blocking_missing,
    }


def cmd_verify(args) -> int:
    result = verify(Path(args.dir).resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result["blockingMissing"] else 0


# --------------------------------------------------------------------------- msg
def cmd_msg(args) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    missing = None
    if args.missing_file:
        missing = json.loads(Path(args.missing_file).read_text(encoding="utf-8"))
    elif args.missing == "-":
        missing = json.loads(sys.stdin.read())
    elif args.missing:
        missing = json.loads(args.missing)
    payload = {"type": args.type, "handoffId": args.id, "round": args.round, "missing": missing, "note": body}
    message = api(args, "/api/send", {
        "to": args.to,
        "subject": f"handoff.{args.type} {args.id}".strip(),
        "body": json.dumps(payload, ensure_ascii=False),
        "conversation": args.conversation,
        "important": True,
    })
    print(json.dumps(message, ensure_ascii=False, indent=2))
    return 0


# --------------------------------------------------------------------------- cli
def add_hub_args(parser) -> None:
    parser.add_argument("--hub", default="", help="hub base URL (default: $MESH_HUB)")
    parser.add_argument("--token-file", default="", help="token file (default: $MESH_TOKEN_FILE)")
    parser.add_argument(
        "--ca",
        default="",
        help="PEM file of the CA to trust (default: $MESH_CA_FILE). Use the hub's ca.crt for a "
        "self-signed hub; it is the same file the waker configures as caFile. The CA cannot be "
        "fetched from /api/bootstrap because that endpoint is itself behind TLS, so it must be "
        "delivered out of band.",
    )
    parser.add_argument(
        "--ca-sha256",
        default="",
        help="expected SHA-256 of the CA file, hex (default: $MESH_CA_SHA256); a mismatch exits 1. "
        "Same value as the waker's caSha256.",
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="handoff", description="workspace handoff over a mesh hub (generic)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    pack = sub.add_parser("pack", help="workspace -> bundle (secret-scanned)")
    pack.add_argument("--workspace", required=True, help="directory to package")
    pack.add_argument("--out", required=True, help="output .tar.gz path")
    pack.add_argument("--exclude", default="", help="extra comma-separated glob patterns")
    pack.add_argument("--id", default="")
    pack.add_argument("--from-agent", default="")
    pack.add_argument("--conversation", default="")
    pack.add_argument("--next", default="", help='next steps, "|"-separated')
    pack.add_argument("--requirements", default="", help="JSON file with requirements (overrides auto-detect)")
    pack.add_argument("--max-bytes", type=int, default=0, help="refuse bundles larger than this")
    pack.add_argument(
        "--allow-large",
        action="store_true",
        help="include files over 2 MB (stream-scanned first; a secret hit still refuses the pack)",
    )
    pack.epilog = (
        "Counts: fileCount = entries packed; excludedBinaryFiles = binary by extension or NUL byte "
        "(never packed); excludedLargeFiles = over 2 MB, not packed unless --allow-large "
        "(paths in excludedLargeSample, first 10); containsLargeFiles = true only when "
        "--allow-large packed at least one large file."
    )
    pack.set_defaults(func=cmd_pack)

    send = sub.add_parser("send", help="upload + notify the peer")
    send.add_argument("--file", required=True)
    send.add_argument("--to", required=True)
    send.add_argument("--conversation", required=True)
    send.add_argument("--id", required=True)
    send.add_argument("--visible-to", default="")
    send.add_argument("--type", default="package")
    send.add_argument("--round", type=int, default=0)
    send.add_argument("--message", default="")
    send.add_argument("--next", default="")
    add_hub_args(send)
    send.set_defaults(func=cmd_send)

    receive = sub.add_parser("receive", help="download (or read local bundle) + extract + verify")
    receive.add_argument("--id", default="", help="blob id on the hub (omit with --bundle)")
    receive.add_argument("--bundle", default="", help="local bundle file (no network)")
    receive.add_argument("--dir", required=True)
    receive.add_argument("--sha256", default="")
    add_hub_args(receive)
    receive.set_defaults(func=cmd_receive)

    verify_cmd = sub.add_parser("verify", help="verify an extracted bundle")
    verify_cmd.add_argument("--dir", required=True)
    verify_cmd.set_defaults(func=cmd_verify)

    msg = sub.add_parser("msg", help="send a protocol message")
    msg.add_argument("--type", required=True, choices=["needs", "accepted", "instructions", "release", "delta"])
    msg.add_argument("--to", required=True)
    msg.add_argument("--conversation", required=True)
    msg.add_argument("--id", required=True)
    msg.add_argument("--round", type=int, default=0)
    msg.add_argument("--missing", default="", help="JSON inline; '-' reads stdin")
    msg.add_argument("--missing-file", default="")
    msg.add_argument("--body", default="")
    msg.add_argument("--body-file", default="")
    add_hub_args(msg)
    msg.set_defaults(func=cmd_msg)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
