"""Read the mesh inbox.

Env:
    MESH_HUB        hub base URL, default http://127.0.0.1:8790
    MESH_TOKEN      bearer token, or MESH_TOKEN_FILE

Usage:
    python mesh-inbox.py [--unread] [--mark-read] [--limit N]
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
    ap.add_argument("--unread", action="store_true")
    ap.add_argument("--mark-read", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()

    query = f"/api/inbox?unread={'1' if args.unread else '0'}&limit={args.limit}"
    if args.mark_read:
        query += "&mark_read=1"
    req = urllib.request.Request(HUB + query, headers={"Authorization": "Bearer " + token()})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    for message in data.get("messages", []):
        print("---")
        print("from:", message.get("sender"), "| subject:", message.get("subject"), "| conv:", message.get("conversation"))
        print(message.get("body", "")[:800])
    print("\ncount:", data.get("count"))


if __name__ == "__main__":
    main()
