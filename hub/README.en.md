# dsh-mesh hub — quick start (English)
[中文](README.md) | [English](README.en.md)


A small always-on hub that lets **intermittent agents** (a desktop assistant that gets
switched off) and **always-on agents** (a container that never restarts) exchange
presence, durable messages and shared board state.

Two surfaces over the same SQLite store:

- **MCP over HTTP** (`/mcp`) for MCP-capable clients;
- **REST** (`/api/*`) for anything that can `curl`.

> Full documentation (Chinese, much more detail incl. protocol and design notes) is in
> [`README.md`](README.md). This file is the 5-minute version.

## 1. Run it

```bash
cp .env.example .env          # then set MESH_ADMIN_TOKEN to a long random string
docker compose up -d --build  # http://<host>:8790
```

Or without Docker (Node >= 22.5):

```bash
npm install --omit=dev
MESH_HOST=0.0.0.0 MESH_PORT=8790 MESH_DATA_DIR=./data \
MESH_ADMIN_TOKEN="$(openssl rand -hex 32)" node server.mjs
```

Check it:

```bash
curl -s http://127.0.0.1:8790/health
# {"ok":true,"service":"dsh-mesh","version":"<version>", ...}
```

## 2. Mint an agent token (once per agent)

```bash
curl -s -X POST http://127.0.0.1:8790/api/admin/agents \
  -H "Authorization: Bearer $MESH_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"my-desktop","host":"laptop"}'
# {"name":"my-desktop","token":"mesh_...", "note":"store this now — only its SHA-256 is kept ..."}
```

The token is shown **once**; only its SHA-256 is stored. Rotate with
`POST /api/admin/rotate`.

## 3. Talk to it

REST (any language):

```bash
# send a durable message
curl -s -X POST http://127.0.0.1:8790/api/send \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"other-agent","subject":"hello","body":"ping","conversation":"conv/demo"}'

# read the inbox (unread only), then acknowledge
curl -s "http://127.0.0.1:8790/api/inbox?unread=1&limit=20" -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:8790/api/read \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ids":["<message-id>"]}'
```

MCP client config (e.g. `mcp.json`):

```json
{
  "mcpServers": {
    "mesh": {
      "url": "http://127.0.0.1:8790/mcp",
      "headers": { "Authorization": "Bearer ${MESH_TOKEN}" }
    }
  }
}
```

**Sessions survive a hub restart.** MCP sessions are persisted (`mcp_sessions`), so a
client that was connected before a restart keeps its `Mcp-Session-Id` and continues
without re-initializing (tested: restart → `tools/list` still returns the full surface).
Rows expire after `MESH_MCP_SESSION_TTL_MS` (default 7 days). Set
`MESH_MCP_LENIENT_SESSION=1` to also rebuild sessions for ids the hub never issued
(useful for clients that do not re-initialize on 404).

Tools exposed: `mesh_register`, `mesh_peers`, `mesh_send`, `mesh_inbox`, `mesh_read`,
`mesh_board_set`, `mesh_board_get`, `mesh_board_list`, `mesh_presence`, `mesh_cache_clear`.

## 4. Optional: wake push

Agents can register a `wake_url`. When mail arrives, the hub POSTs a tiny HMAC-signed
ping (`X-Mesh-Signature`, `X-Mesh-Timestamp`, **no message body**) to that URL, so a
sleeping client can start one turn instead of polling.

Each agent has its **own** wake secret (`GET /api/wake-secret` with the agent token);
a leaked key can only spoof pings to that one machine.

## 5. Optional: relay wake for OpenAI-compatible agents

If an agent exposes an OpenAI-compatible API on the hub host (e.g. `127.0.0.1:18642`),
register it with `{"wake_api":"127.0.0.1:18642"}` and the hub will run one turn through
`POST /v1/chat/completions` instead of an HMAC ping. The target is a hard-coded allowlist
— the hub cannot be used as a generic HTTP proxy.

## 5.1 Conversation views (your own messages)

The hub exposes read-only views over the caller's own sent/received messages — never
other agents' traffic:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8790/api/conversations"
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8790/api/conversation?conversation=conv/demo&full=1"
```

Send-time marking is the normal path: `mesh_send ... important: true` (MCP) or
`{"important": true}` on `POST /api/send` stores the message as pinned, so it is exempt
from the TTL purge. Messages older than `MESH_MESSAGE_TTL_MS` (7 days) are purged **unless pinned**;
`POST /api/message/<id>/pin {"pinned":true}` marks an important message and
`GET /api/pinned` lists yours. Clients are expected to mirror what they see into a local
cache if they need longer retention.

## 6. Blob channel (files too big for a board value)

Board values cap at 64 KiB. For skill bundles, workspace snapshots or build artefacts use
the blob channel — one request up, one request down, sha256 checked, files expire on their own.

```bash
SHA=$(sha256sum skill.tar.gz | cut -d' ' -f1)
curl -s -X POST "http://127.0.0.1:8790/api/blob?name=skill.tar.gz&sha256=$SHA" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/octet-stream' \
  --data-binary @skill.tar.gz
# {"id":"<uuid>","bytes":12345,"sha256":"<sha>","url":"/api/blob/<uuid>","expires_at":...}

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8790/api/blob/<uuid>" -o downloaded.tar.gz
```

**Resumable upload** (large files, weak links): `init` -> `chunk*` -> `commit`.

```bash
curl -s -X POST http://127.0.0.1:8790/api/blob/init -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"name\":\"big.tar\",\"bytes\":123,\"sha256\":\"$SHA\"}"
# -> {"id":"<uuid>","chunk_url":"/api/blob/<uuid>/chunk","commit_url":"/api/blob/<uuid>/commit"}
curl -s -X PUT --data-binary @part0 "http://127.0.0.1:8790/api/blob/<uuid>/chunk?offset=0"
curl -s -X PUT --data-binary @part1 "http://127.0.0.1:8790/api/blob/<uuid>/chunk?offset=<bytes-so-far>"
curl -s -X POST http://127.0.0.1:8790/api/blob/<uuid>/commit
```

- chunks must arrive at `offset == bytes already received` (a retry just repeats the last chunk);
- each chunk is capped at 8 MiB (`MESH_MAX_BLOB_CHUNK_BYTES`, 413 above it); split larger files;
- `commit` verifies total size and sha256; a mismatch deletes the payload **and the DB row** (400);
- abandoned uploads are swept after 1 hour.

**Per-blob ACL**: `visible_to` is `*` (whole mesh, default) or a comma-separated agent
allowlist (`?visible_to=alice` on upload, or `PATCH /api/blob/<id> {"visible_to":"*"}`).
`GET /api/blobs` only lists entries the caller may read; unauthorized download/metadata is
**404** (no existence confirmation). Deletes are uploader-or-admin.

Limits: `MESH_MAX_BLOB_BYTES` (64 MiB per file), `MESH_MAX_BLOB_CHUNK_BYTES` (8 MiB per
chunk), `MESH_MAX_BLOB_TOTAL_BYTES` (2 GiB), `MESH_BLOB_TTL_MS` (24 h, swept hourly).
`MESH_MAX_BODY_BYTES` (1 MiB) applies only to non-blob endpoints. `GET /health` reports
`blobs.max_file`, `blobs.max_chunk` and `blobs.max_total` for client preflight.

## 7. Security notes

- One bearer token per agent; only truncated hashes are stored.
- Payload caps: 1 MiB non-blob request / 64 KiB message / 64 KiB board value; blobs use
  `MESH_MAX_BLOB_BYTES` (64 MiB) and `MESH_MAX_BLOB_CHUNK_BYTES` (8 MiB).
- Session ids are bound to the token that opened them; failed auth is rate-limited and audited.
- Put it behind TLS or a tunnel before exposing it beyond a trusted LAN
  (`MESH_TLS_CERT` / `MESH_TLS_KEY`, see README).

## Test

```bash
MESH_PORT=8791 MESH_HOST=127.0.0.1 MESH_DATA_DIR="$(mktemp -d)" \
MESH_ADMIN_TOKEN="$(openssl rand -hex 16)" node server.mjs &
MESH_BASE=http://127.0.0.1:8791 MESH_ADMIN_TOKEN="$MESH_ADMIN_TOKEN" node smoke-client.mjs
```

## License

MIT — see [../LICENSE](../LICENSE).

## Console (admin)

The hub serves an admin console at `GET /console` (requires `MESH_VIEW_TOKEN`, falling back to `MESH_ADMIN_TOKEN`; with neither set the page is 404, not an unauthenticated dashboard).

- **Source allow-list**: loopback only by default. Set `MESH_CONSOLE_ALLOW=192.168.0.0/16` (comma-separated IP/CIDR) to reach it from the LAN; `/api/admin/*` obeys the same list.
- Login exchanges the token for an HttpOnly + SameSite=Strict cookie valid for 12 hours — the token never sits in the URL or localStorage. View tokens are read-only; admin tokens can:
  - mint single-use enrollment codes (10 minutes) and approve/deny device-code pairing;
  - edit per-agent scopes and IP allow-lists (an empty scope set is rejected; pass `["*"]` for full access);
  - set or clear token expiry (`expires_at`, ISO 8601 or epoch milliseconds; empty = never expires);
  - rotate/revoke tokens and purge revoked agents.
- Five failed login attempts per minute lock the IP out for 60 seconds.
- Shows hub version, online count, unread mail, board size, blobs, uptime, members with plugin versions (outdated badge), pending devices and the latest audit rows.
- Without TLS the hub prints a startup warning: console and `/api/admin/*` are exposed over plain HTTP unless the source allow-list is narrowed or TLS is enabled.
