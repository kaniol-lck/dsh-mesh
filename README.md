# dsh-mesh

[![npm](https://img.shields.io/npm/v/dsh-mesh-waker.svg)](https://www.npmjs.com/package/dsh-mesh-waker)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A small LAN agent hub**: one Node service stores messages between agents, wakes the
recipient when one arrives, and keeps a shared blackboard — so DSH instances, scripts and
even non-DSH agents (anything that speaks HTTP or MCP) can hand work to each other without
exposing a shell on every machine.

```
        ┌──────────────────────────── hub (this repo, hub/) ────────────────────────────┐
        │  MCP (/mcp) + REST (/api/*)   SQLite: messages · board · blobs · audit         │
        └───────▲───────────────────────────────▲──────────────────────────────▲────────┘
                │ bearer token                  │ bearer token                 │ HMAC wake
        ┌───────┴────────┐              ┌───────┴────────┐              ┌──────┴────────┐
        │  agent A (DSH) │              │  agent B (DSH) │              │ gateway agent │
        │  waker plugin  │              │  waker plugin  │              │ (any HTTP)    │
        └────────────────┘              └────────────────┘              └───────────────┘
```

## What you get

- **Durable messages** — the hub stores them; a machine that is asleep still receives them
  when it wakes up.
- **Wake push** — a content-free, HMAC-signed ping to the recipient's local endpoint; the
  agent then reads its own inbox. A leaked wake URL can cost a turn, not forge a message.
- **Conversations** — replies can share a `conversation` id, so a dialogue keeps one
  session instead of scattering across new ones.
- **Shared blackboard** — small JSON/text values plus an append-only log, for state the
  whole team should see.
- **Blob channel** — files up to 64 MiB (resumable, sha256-checked, per-blob ACL) for
  anything that does not belong in a message body.
- **Approval relay** (optional, `plugins/mesh-approval`) — forward a coding agent's
  dangerous-command approval prompt to a human over the mesh.

## Quick start (5 minutes)

Requirements: Node.js ≥ 22.5 (for `node:sqlite`) or Docker.

### 1. Run the hub

```bash
cd hub
cp .env.example .env
# set MESH_ADMIN_TOKEN to a long random string
docker compose up -d --build
curl http://127.0.0.1:8790/health
```

Without Docker:

```bash
cd hub && npm install --omit=dev
MESH_ADMIN_TOKEN=change-me MESH_DATA_DIR=./data node server.mjs
```

### 2. Create one token per agent

```bash
curl -s -X POST http://127.0.0.1:8790/api/admin/agents \
  -H "Authorization: Bearer $MESH_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"agent-a"}'
# -> {"name":"agent-a","token":"mesh_..."}   store it; the hub keeps only its hash
```

### 3. Connect an agent

Any MCP client:

```yaml
- id: mcp-mesh
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mesh
    transport: streamable-http
    url: 'http://127.0.0.1:8790/mcp'
    headers:
      Authorization: 'Bearer mesh_...'
```

Any HTTP client:

```bash
curl -s http://127.0.0.1:8790/api/inbox?unread=1 -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:8790/api/send \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"agent-b","subject":"build","body":"please rebuild","conversation":"conv/build"}'
```

### 4. Optional: wake push (DSH client plugin)

`plugins/mesh-waker` turns a hub wake ping into a real session turn: install it into a DSH
profile, point it at the hub with that agent's token, and the agent keeps handling mail even
when nobody is looking at the window. `plugins/mesh-approval` routes a Hermes-style approval
prompt through the mesh instead of blocking on the terminal.

```bash
# the client plugin is on npm; the hub itself runs from hub/ in this repo
dsh plugin add dsh-mesh-waker          # desktop profile: use the app's own terminal
dsh plugin --profile web add dsh-mesh-waker
```

After installing, open **Settings → Mesh**, set the hub URL and paste this machine's agent
token; the plugin keeps the token in an owner-only file, not in the profile patch.

## API surface (short)

| Endpoint | Purpose |
|---|---|
| `POST /api/send` | send (`to`, `body`, `subject?`, `conversation?`, `important?`, `no_reply?`) |
| `GET /api/inbox` | my messages (`unread=1`, `mark_read=1`) |
| `POST /api/read` | acknowledge specific message ids |
| `GET/POST /api/board` | blackboard get/set (`key`, `value`, `owner?`, `status?`) |
| `GET /api/peers`, `GET /api/status` | roster and hub state |
| `POST /api/blob` · `GET /api/blob/<id>` | file channel (resumable: `POST /api/blob/init` → `PUT .../chunk` → `POST .../commit`) |
| `GET /api/conversations` · `GET /api/conversation` | my dialogues |
| `/mcp` | MCP tools: `mesh_send`, `mesh_inbox`, `mesh_board_get/set`, `mesh_peers`, … |

## Security model

- One bearer token per agent; the hub stores only a SHA-256 hash. Tokens can be rotated and
  revoked.
- Wake pings are HMAC-SHA256 signed with **per-agent** secrets, with a 120 s timestamp
  window and a debounce.
- Reads are scoped to the caller: conversation views only return messages the caller sent or
  received; blob reads honor a per-blob allowlist.
- Transport encryption is **required** across any network you do not control — put the hub
  behind TLS (`MESH_TLS_CERT` / `MESH_TLS_KEY`) or a tunnel.
- Nothing secret belongs in this repo; `scripts/check-secrets.py` runs in CI.

## Updating

- **Source**: `git pull` (or a GitHub Release tarball) → rebuild → `docker compose up -d`.
- **Clients**: the plugins are ordinary npm packages; once published,
  `dsh plugin add <package>` updates a machine without copying files by hand.
- **Between machines that cannot reach GitHub**: send a tarball through the blob channel; a
  `git bundle` works the same way when history matters.

## Repository layout

```
hub/                    the hub itself (single-file server, Dockerfile, smoke test)
plugins/mesh-waker/     DSH client plugin: wake endpoint -> session turn
plugins/mesh-approval/  approval transport plugin (Hermes-compatible)
skills/mesh/            agent-facing usage guide (send/read/board conventions)
docs/mesh-architecture.md
scripts/                secret scan + small REST client helpers
```

## License

MIT — see [LICENSE](LICENSE).
