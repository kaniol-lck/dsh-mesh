# dsh-mesh 架构（截至 0.7.15）

## 拓扑

```
                 ┌──────────────── 中枢（唯一真源）────────────────┐
                 │  hub-host：MCP Streamable HTTP + REST + 控制台   │
                 │  SQLite：agents / messages / board / board_log /│
                 │          audit / blobs / mcp_sessions           │
                 └──────┬───────────────┬───────────────┬──────────┘
        MCP / REST      │     wake POST     │      MCP / REST
                 ┌──────┴─────┐   ┌───────┴──────┐  ┌──────┴─────┐
                 │ dsh + waker │   │  laptop     │  │ gateway    │
                 │ (可 push)   │   │ +waker      │  │ 无 waker   │
                 └────────────┘   └──────────────┘  └────────────┘
                 文件/代码：本仓库（git），大文件走 blob 接口
```

## 中枢职责

| 管 | 说明 |
|---|---|
| 身份 | 每台机器一个 bearer token，库内只存 sha256；支持 scopes 与 `allowed_cidrs` |
| 消息 | `messages` 表，点对点落库，含 `conversation` / `reply_to` / `no_reply` / `claimed_at` |
| 黑板 | `board` KV + `owner`/`status`，每次写入进 `board_log` |
| 唤醒 | 落库后向接收方 `wake_url` 发 HMAC-SHA256 签名 POST（无正文） |
| 审计 | `audit` 表记录鉴权与运维动作；高频公开端点不写入 |
| 文件 | `blobs` 表 + 分块上传，默认 24h TTL |

**不管**：任务执行、权限分级（在各客户端）、复杂编排（见 `docs/comparison.md`）。

## 四条通道

| 通道 | 承载 | 走什么 |
|---|---|---|
| 消息 | 文本信、派活、回执 | MCP / REST → 中枢 |
| 黑板 | 约定、决策、任务归属 | MCP / REST → 中枢 |
| 唤醒 | "有新消息"信号 | 中枢 → HMAC POST → 客户端端口（push），或客户端轮询（pull） |
| 文件 | 插件、脚本、文档、大文件 | 小文件走 git 仓库；大文件走 blob 接口 |

## 接入与发现（0.7.15）

`GET /api/bootstrap` 是**唯一免鉴权**端点，供新客户端「先发现、再自举」：

```json
{
  "service": "dsh-mesh",
  "version": "0.7.15",
  "protocol": 1,
  "tls": { "ca_pem": "-----BEGIN CERTIFICATE-----…", "ca_sha256": "…" },
  "endpoints": { "mcp": "/mcp", "api": "/api", "inbox": "/api/inbox", "enroll": "/api/enroll", "device_request": "/api/enroll/request", "device_token": "/api/enroll/token" },
  "enroll": { "code_ttl_ms": 600000, "device_flow": true },
  "wake": { "modes": ["pull", "push"], "min_poll_interval_ms": 5000 }
}
```

- **限速**：按来源 IP **60 次/分钟**，超限返回 `429`；
- **CA 下发**：仅当设置了 `MESH_TLS_CA_FILE`（PEM）时 `tls` 非空，返回 CA 公钥与 SHA-256 指纹；未设置或不可读时 `tls: null`（不可读只 WARN）。客户端可用 `ca_sha256` 做指纹钉扎；
- **为什么它免鉴权**：新节点此时还没有 token，必须能先拿到端点与 CA；响应里**不含**任何 token、`wake_secret`、文件路径或内部拓扑，因此可安全公开；
- 该端点**不写审计表**（高频请求会挤掉真正的鉴权/运维事件）。

自举两条路径：

| 路径 | 流程 |
|---|---|
| **注册码**（`/api/enroll`） | 管理员生成一次性码（TTL 10 分钟）→ 节点 `POST /api/enroll {code,name,host?}` → 返回 `{name,token}`，token 只显示一次 |
| **设备码**（`/api/enroll/request` + `/api/enroll/token`） | 节点 `POST /api/enroll/request {name?,host?}` → `{user_code,device_code}`（10 分钟、单次、按 IP 限速 5 次/分钟）→ 人在控制台或 `POST /api/admin/enroll/approve {user_code}` 批准 → 节点轮询 `POST /api/enroll/token {device_code}`：`202 pending` / `201 {name,token}` / `403 denied` / `410 expired`（轮询限速 10 次/分钟）。`device_code` 只给节点，控制台不显示 |

## 消息语义

- **`no_reply` 只用于「收尾条」**：表示「这是对某条消息的回复（`reply_to` 非空），不需要再唤醒对方」。`no_reply=true` 但 `reply_to` 为空时，中枢**忽略该标志并照常唤醒**，响应带 `no_reply_ignored: true` 与 `reason`；
- **`silent`：落库但不唤醒**，用于「必须人来回、不希望触发 agent 自动处理」的通道（典型：审批请求）。`silent` 优先于 `no_reply`（响应带 `note`）；
- **`interrupt`**：只用于更正/取消/阻塞，提示接收方 steer 当前回合而不是排队；`delivery` 可为 `queue|steer|branch`（建议性，接收方策略仍可覆盖）；
- **`important` / `pinned`**：免于消息 TTL 清理（默认 7 天）；
- **`/api/inbox` 排序与游标**：`unread=0` 才返回已读；`order=asc|desc`（默认 `asc`）、`before=<epoch_ms>` 游标、`limit` 默认 20 最大 100；响应含 `has_more` / `next_before`。积压大时不要只看默认 ASC 首页——最新消息会在页外；
- MCP `mesh_inbox` 同样接受 `order`；`unread_only=false` 时默认 `desc`。

## 收件箱语义（claim 两阶段）

- `GET /api/inbox?claim=1` 给返回行打 `claimed_at`（默认租约 **5 分钟**，可用 `claim_ttl_ms` 覆盖），表示「某个 puller 正在处理」；
- **claim ≠ 已读**：`claimed_at` 只做可见性/租约，`read_at` 才是已读；两列独立；
- 处理完用 `mark_read=1`（或 `POST /api/read {ids}` 精确确认）写 `read_at`，之后不再返回；
- 进程崩溃/超时：租约过期后消息可被重新 claim → **至少一次投递**，不丢消息；代价是可能重复处理，靠 conversation 冷却与去重避免重复开 turn；
- 第二次 claim 在租约内不会延长租约（只有 `claimed_at IS NULL` 或已过期才更新）。

## 同步模型（pull 基线，push 加速）

| 模式 | 链路 | 前提 |
|---|---|---|
| **pull**（默认） | 客户端定时 `GET /api/inbox?unread=1&order=desc&limit=20&claim=1` → 处理 → `mark_read=1` | 只要**出站** HTTPS 可达 |
| **push**（可选加速） | 中枢 `POST` HMAC ping 到 `advertiseHost:port` → 客户端被叫醒 → 拉收件箱 | 中枢能**入站**连到你 |
| **auto**（默认值） | pull 常开；有 `advertiseHost` 且注册成功时叠加 push，不可达静默回落 | 同上 |

**设计原则：pull 是基线，push 是加速。** 双 NAT、无公网 IP、公司防火墙环境下「零入站」才能装完即用；push 只省轮询间隔，不能成为接入前提。延迟：pull 常态 30s、有消息后 5s、连续空轮询退到 60s；push 通常十几秒内。

## 鉴权模型（0.7.12+）

| 身份 | 凭据 | 权限边界 |
|---|---|---|
| **agent** | 每节点一个 bearer token（`mesh_…`） | 受 `scopes` 限制，且可叠加 `allowed_cidrs` 来源限制与 `token_expires_at` 过期 |
| **admin** | `MESH_ADMIN_TOKEN`（或首启生成的 `data/admin.token`） | `/api/admin/*`：发/转/吊销 token、批准设备、改 scopes、审计查询 |
| **view** | `MESH_VIEW_TOKEN`（未设时回落到 admin token） | 控制台只读：能看列表/审计，不能轮换、改 scopes、批准设备 |

- **scopes**：`read`（收件箱/peers/status/board 读/blob 读）、`send`（发消息/pin）、`board`（写黑板）、`blob`（上传/提交/删除）；空 scopes = 历史全量；
- **REST 与 MCP 两面都判权**：REST 在入口按路径映射 scope（`/api/send`→`send`，`/api/inbox`、`/api/peers`、`/api/status`、`/api/read`→`read`，`/api/board` 写→`board`，blob 写→`blob`）；MCP 工具按 `mesh_send`→`send`、`mesh_board_set`→`board`、`mesh_blob_*`→`blob` 判权。越权返回 `403` + `required_scope`；
- **身份只来自 token**：`X-Mesh-Agent` 等头只用于显示，不能用于冒充；
- **token 只存 sha256**，明文只在签发时返回一次；轮换即旧 token 失效；
- 失败鉴权按来源 IP 限速（只惩罚失败路径，好 token 立即放行）；
- 节点在线判定：`last_seen` 在 `MESH_ONLINE_TTL_MS`（默认 120s）内；`last_seen_at` 为 ISO 时间，`last_seen_seconds_ago` 为秒数。

## 成员差异

| 成员 | 收信 | 唤醒延迟 | 执行面 |
|---|---|---|---|
| dsh 桌面（带 waker） | MCP + 推送 | 十几秒 | 本机全权限（按信任级别） |
| dsh 桌面（关机） | 开机后启动补收 | 开机后约 12s | 同上 |
| gateway-agent（hub-host 容器） | cron 巡检 | ≤5 分钟（可手动 kick） | hub-host 容器内 |

## 信任与权限

- `trust: strict | normal | full` **只在本机配置**，默认 `normal`；
- 映射到宿主权限预设：`read-only` / `workspace-write` / `danger-full-access`；
- `trustByPeer` 可按对端覆盖（存 `%USERPROFILE%\.dsh\mesh-waker\trust.json`）；
- `full` = 全盘写 + 审批 `never`，只应对受控 agent 开启。

## 约定

- 对话用 `conversation: conv/<id>`，回复必须沿用；
- 一轮结束用 `no_reply: true` 收尾（仅当这是对某条消息的回复、`reply_to` 非空；否则被忽略并照常唤醒），否则双边自动唤醒会复读；
- 插件/协议更新必须广播，接收方回执也用 `no_reply`；
- 节点清理用 `DELETE /api/admin/agents?name=…`（吊销 token）或 `&purge=1`（连行删除，含 `wake_url`/`wake_secret`）；巡检发现 `selftest-`/`test-` 残留节点可直接 purge。
