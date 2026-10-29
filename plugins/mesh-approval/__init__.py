"""Mesh approval transport for Gateway agent.

Two-mode behaviour:
  * real chat-gateway sessions (Telegram/QQ/Discord...): raise so the host falls
    back to its built-in gateway prompt (``transport_fallback: builtin``), i.e.
    the user approves on their phone;
  * everything else (api_server relay turns, cron, CLI one-shots): present the
    approval in the dsh-mesh inbox (no wake, so no agent can auto-approve) and
    block until the user replies or the host timeout expires (-> deny).
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

from hermes_cli.approval_transport import ApprovalDecision

HUB = os.environ.get("MESH_HUB", "http://127.0.0.1:8790").rstrip("/")
PEER = os.environ.get("MESH_APPROVAL_PEER", "")
POLL_SECONDS = float(os.environ.get("MESH_APPROVAL_POLL", "3"))
MAX_WAIT_SECONDS = float(os.environ.get("MESH_APPROVAL_MAX_WAIT", "240"))

CHOICES = (
    ("approve", "once"), ("同意", "once"), ("allow", "once"),
    ("always", "always"), ("始终", "always"),
    ("session", "session"), ("会话", "session"),
    ("deny", "deny"), ("reject", "deny"), ("拒绝", "deny"),
)


def _token() -> str:
    for path in ("<agent-home>/.mesh-token", os.path.expanduser("~/.mesh-token")):
        try:
            with open(path, encoding="utf-8") as fh:
                value = fh.read().strip()
            if value:
                return value
        except OSError:
            continue
    return os.environ.get("MESH_TOKEN", "")


def _call(method: str, path: str, token: str, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        HUB + path,
        data=data,
        method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def _deny(request) -> ApprovalDecision:
    return ApprovalDecision(request.request_id, request.digest, "deny")


def _gateway_session() -> bool:
    """True when the host's own gateway prompt can reach a human."""
    try:
        from tools.approval_context import _is_gateway_approval_context
        return bool(_is_gateway_approval_context())
    except Exception:
        return False


def present(request) -> ApprovalDecision:
    # Gateway sessions keep their native prompt (Telegram `/approve`); the host
    # rewrites the error into a fallback when transport_fallback: builtin.
    if _gateway_session():
        raise RuntimeError("gateway session: defer to builtin approval prompt")

    token = _token()
    if not token:
        return _deny(request)

    conversation = "conv/approval-" + request.request_id[:8]
    body = "\n".join(
        [
            "命令：`" + request.command + "`",
            "类别：" + (request.description or request.pattern_key or "dangerous command"),
            "",
            "回复本条消息（可直接改这段文字）表达决定：",
            "  approve  = 仅本次允许",
            "  session  = 本会话内允许",
            "  always   = 永久允许",
            "  deny     = 拒绝（默认，超时也拒绝）",
            "",
            "request_id: " + request.request_id,
            "超时：" + str(int(min(float(request.timeout_seconds or 120), MAX_WAIT_SECONDS))) + " 秒",
            "",
            "注意：此消息不唤醒任何 agent，必须由用户本人回复。",
        ]
    )
    try:
        _call(
            "POST",
            "/api/send",
            token,
            {
                "to": PEER,
                "subject": "⚠️ 审批请求：" + (request.description or request.pattern_key or "危险命令")[:40],
                "body": body,
                "conversation": conversation,
                # silent, not no_reply: the approval must be stored without waking the
                # agent (otherwise it could approve itself), and no_reply without a
                # reply_to is now ignored by the hub.
                "silent": True,
            },
        )
    except Exception:
        return _deny(request)

    deadline = time.time() + min(float(request.timeout_seconds or 120), MAX_WAIT_SECONDS)
    while time.time() < deadline:
        time.sleep(POLL_SECONDS)
        try:
            inbox = _call("GET", "/api/inbox?unread=1&limit=20&order=desc", token)
        except Exception:
            continue
        for message in inbox.get("messages", []):
            text = (message.get("body") or "").lower()
            if request.request_id not in text and request.request_id[:8] not in text:
                continue
            choice = None
            for word, mapped in CHOICES:
                if word in text:
                    choice = mapped
                    break
            if choice is None:
                continue
            if choice not in request.allowed_choices:
                choice = "deny"
            try:
                _call("POST", "/api/read", token, {"ids": [message["id"]]})
            except Exception:
                pass
            return ApprovalDecision(request.request_id, request.digest, choice)
    return _deny(request)


def register(ctx) -> None:
    ctx.register_approval_transport("mesh", present)
