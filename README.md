# dsh-mesh

[中文](README.md) | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-mesh-waker.svg)](https://www.npmjs.com/package/dsh-mesh-waker)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**一个局域网内的 agent 中枢**：一个 Node 服务负责在 agent 之间存消息、在来信时唤醒收件方，并维护一块共享黑板。DSH 实例、脚本、以及任何会讲 HTTP / MCP 的非 DSH agent，都能借此互相派活，而不必在每台机器上开放 shell。

```
        ┌──────────────────────── hub（本仓库 hub/） ─────────────────────────┐
        │  MCP (/mcp) + REST (/api/*)   SQLite：消息 · 黑板 · blob · 审计       │
        └───────▲───────────────────────────────▲──────────────────────────▲────┘
                │ bearer token                  │ bearer token             │ HMAC 唤醒
        ┌───────┴────────┐              ┌───────┴────────┐          ┌──────┴────────┐
        │  agent A (DSH) │              │  agent B (DSH) │          │ 网关 agent     │
        │  唤醒插件       │              │  唤醒插件       │          │ （任意 HTTP）  │
        └────────────────┘              └────────────────┘          └───────────────┘
```

## 它能给你什么

- **持久化消息**：消息落库，机器睡着也能在醒来后收到；
- **唤醒推送**：向收件方本机端点发一个不含正文、带 HMAC 签名的 ping，agent 自己再去读收件箱。唤醒地址泄漏最多浪费一个回合，无法伪造消息；
- **会话（conversation）**：回信可以带上同一个 `conversation` id，一段对话始终落在同一个会话里，而不是散成许多新会话；
- **共享黑板**：小体积 JSON / 文本 KV，外加一条只追加的日志，适合存整个团队都该看到的任务状态；
- **blob 通道**：单文件最大 64 MiB，支持断点续传、sha256 校验、按 blob 的 ACL，放不适合塞进消息体的东西；
- **审批转发**（可选，`plugins/mesh-approval`）：把编码 agent 的"危险命令待批准"提示转发给人，经 mesh 回复 approve / deny。

## 快速开始（5 分钟）

环境要求：Node.js ≥ 22.5（用到 `node:sqlite`）或 Docker。

### 1. 起中枢

```bash
cd hub
cp .env.example .env
# 把 MESH_ADMIN_TOKEN 设成一串足够长的随机值
docker compose up -d --build
curl http://127.0.0.1:8790/health
```

不用 Docker：

```bash
cd hub && npm install --omit=dev
MESH_ADMIN_TOKEN=change-me MESH_DATA_DIR=./data node server.mjs
```

### 2. 给每个 agent 建一个 token

```bash
curl -s -X POST http://127.0.0.1:8790/api/admin/agents \
  -H "Authorization: Bearer $MESH_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"agent-a"}'
# -> {"name":"agent-a","token":"mesh_..."}  自己存好；中枢只留它的哈希
```

### 3. 接入一个 agent

任意 MCP 客户端：

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

任意 HTTP 客户端：

```bash
curl -s http://127.0.0.1:8790/api/inbox?unread=1 -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:8790/api/send \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"agent-b","subject":"构建","body":"麻烦重新构建一次","conversation":"conv/build"}'
```

### 4. 可选：唤醒推送（DSH 插件）

`plugins/mesh-waker` 把中枢的唤醒 ping 变成真正的会话回合：装进 DSH profile、填上中枢地址和该 agent 的 token，即使没人在看窗口，agent 也会自己处理来信。`plugins/mesh-approval` 则把 Hermes 风格的审批提示改成经 mesh 转发给人。

```bash
# 客户端插件已发布到 npm；中枢本体用本仓库 hub/ 起
dsh plugin add dsh-mesh-waker          # desktop profile 要用应用自带终端
dsh plugin --profile web add dsh-mesh-waker
```

装好后打开 **设置 → Mesh**，填中枢地址和本机 agent token；token 由插件存到仅本人可读的文件，
不写进 profile patch。

## API 一览（简表）

| 端点 | 用途 |
|---|---|
| `POST /api/send` | 发信（`to`、`body`、`subject?`、`conversation?`、`important?`、`no_reply?`） |
| `GET /api/inbox` | 我的收件箱（`unread=1`、`mark_read=1`） |
| `POST /api/read` | 按 id 标记已读 |
| `GET/POST /api/board` | 黑板读写（`key`、`value`、`owner?`、`status?`） |
| `GET /api/peers`、`GET /api/status` | 成员列表与中枢状态 |
| `POST /api/blob` · `GET /api/blob/<id>` | 文件通道（断点续传：`POST /api/blob/init` → `PUT .../chunk` → `POST .../commit`） |
| `GET /api/conversations` · `GET /api/conversation` | 我的会话列表与消息流 |
| `/mcp` | MCP 工具：`mesh_send`、`mesh_inbox`、`mesh_board_get/set`、`mesh_peers` 等 |

## 安全模型

- 每个 agent 一把 bearer token，中枢只存 SHA-256；支持轮换与吊销；
- 唤醒 ping 用**逐 agent** 的密钥做 HMAC-SHA256 签名，带 120 秒时间窗与去抖；
- 读取按调用者隔离：会话视图只返回自己发过或收到的消息；blob 读取受 per-blob 白名单约束；
- **任何不受你控制的网络都必须加密**：给中枢配 TLS（`MESH_TLS_CERT` / `MESH_TLS_KEY`）或走隧道；
- 每节点可限制 `read / send / board / blob` scopes、来源 IP 段与令牌有效期（0.7.9+）；
- 网页控制台分只读/管理员两种角色，管理面受 `MESH_CONSOLE_ALLOW` 来源限制并有 CSRF 防护；
- 仓库里不放任何凭据，`scripts/check-secrets.py` 已在 CI 中运行。

## 更新方式

- **源码**：`git pull`（或下载 GitHub Release 的 tar.gz）→ 重新构建 → `docker compose up -d`；
- **Node 客户端插件**（目前只有 `mesh-waker`）：是普通 npm 包，`dsh plugin add dsh-mesh-waker` 即可升级，不用手工拷文件；`mesh-approval` 是 Python 独立插件，不走 npm，需从源码安装（见 `plugins/mesh-approval/README.md`）；
- **到不了 GitHub 的机器**：把 tar.gz 走 blob 通道传过去；需要保留历史时改用 `git bundle`，同样是单个文件。

## npm 包名边界（重要）

- 本项目在 npm **只发布 `dsh-mesh-waker`**；
- `hub/` 的 `package.json` 是 `private: true`，**不上架**；
- **不要 `npm i dsh-mesh`**：npm 上的 `dsh-mesh`（Wang-Lin-Chang 的文件消息队列）与 `@baixianger/dsh-mesh`（Iroh P2P）都是第三方项目，与本仓无关。

## 文档

- [中枢部署与配置](hub/README.md) · [English](hub/README.en.md)
- [架构说明](docs/mesh-architecture.md)
- [鉴权与控制台](docs/auth-and-console.md)（token 生命周期、scopes、IP 白名单、注册码派发、控制台角色）
- [本机会话协作](docs/local-sessions.md)（会话发现与定向注入，不经过中枢）
- [多会话协作手册](docs/multi-session-playbook.md)（协调/执行分工、派活模板、故障清理）（token 生命周期、scopes、IP 白名单、注册码派发、控制台角色）
- [客户端插件 mesh-waker](plugins/mesh-waker/README.md)
- [给 agent 的协作约定](skills/mesh/SKILL.md)

## 工作区交接

`scripts/handoff/` 提供交接工具：把工作区 + 上下文摘要 + 依赖清单打成带 sha256 的 bundle，
经 blob 通道发给另一台机器；接收方解包后自动校验依赖，缺什么按
`needs → delta / instructions → accepted` 协议回问补全（最多两轮）。
详见 [scripts/handoff/README.md](scripts/handoff/README.md)。

## 目录结构

```
hub/                    中枢本体（单文件服务、Dockerfile、冒烟测试）
plugins/mesh-waker/     DSH 客户端插件：唤醒端点 -> 会话回合
plugins/mesh-approval/  审批转发插件（兼容 Hermes）
skills/mesh/            给 agent 看的协作说明（发信/读信/黑板约定）
docs/mesh-architecture.md
scripts/                密钥扫描 + 几个小型 REST 客户端脚本
```

## License

MIT，见 [LICENSE](LICENSE)。
