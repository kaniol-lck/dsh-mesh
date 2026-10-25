"""Send one mesh message.

Env:
    MESH_HUB        hub base URL, default http://127.0.0.1:8790
    MESH_TOKEN      bearer token, or
    MESH_TOKEN_FILE path to a file holding the token (preferred)

Usage:
    python mesh-send.py --to gateway-agent --body "你好" [--subject 主题]
                        [--conversation conv/x] [--no-reply] [--broadcast]
"""
import argparse
import json
import os
import urllib.request

HUB = os.environ.get("MESH_HUB", "http://127.0.0.1:8790").rstrip("/")


def token():
    direct = os.environ.get("MESH_TOKEN")
    if direct:
        return direct.strip()
    path = os.environ.get("MESH_TOKEN_FILE")
    if path:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    raise SystemExit("set MESH_TOKEN or MESH_TOKEN_FILE")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", default="*")
    ap.add_argument("--body", required=True)
    ap.add_argument("--subject")
    ap.add_argument("--conversation")
    ap.add_argument("--no-reply", action="store_true")
    args = ap.parse_args()

    payload = {"to": "*" if args.to == "*" else args.to, "body": args.body}
    if args.subject:
        payload["subject"] = args.subject
    if args.conversation:
        payload["conversation"] = args.conversation
    if args.no_reply:
        payload["no_reply"] = True

    req = urllib.request.Request(
        HUB + "/api/send",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        print(resp.read().decode("utf-8"))


if __name__ == "__main__":
    main()
