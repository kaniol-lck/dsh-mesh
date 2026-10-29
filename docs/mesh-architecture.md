# dsh-mesh 架构（2026-10）

## 拓扑

```
                 ┌──────────────── 中枢（唯一真源）────────────────┐
                 │  hub-host 127.0.0.1:8790  container dsh-mesh        │
                 │  SQLite(dsh-mesh-data): agents/messages/board/   │
                 │  board_log/audit                                 │
                 │  MCP Streamable HTTP + REST                      │
                 └──────┬───────────────┬───────────────┬──────────┘
        MCP / REST      │     wake POST     │      MCP / REST
                 ┌──────┴─────┐   ┌───────┴──────┐  ┌──────┴─────┐
                 │ agent-a-host  │   │  laptop    │  │  gateway-agent    │
                 │ +waker8795 │   │ +waker:8795  │  │ 无 waker   │
                 └────────────┘   └──────────────┘  └────────────┘
                 └──── 文件/代码：本仓库（git）或 hub-host SMB ────┘
```

## 中枢职责

| 管 | 说明 |
|---|---|
| 身份 | 每台机器一个 bearer token，库内只存 sha256 |
| 消息 | `messages` 表，点对点落库，含 `conversation` / `reply_to` / `no_reply` |
| 黑板 | `board` KV + `owner`/`status`，每次写入进 `board_log` |
| 唤醒 | 落库后向接收方 `wake_url` 发 HMAC-SHA256 签名 POST（无正文） |
| 审计 | `audit` 表记录鉴权与动作 |

**不管**：文件存储、任务执行、权限分级（在各客户端）。

## 四条通道

| 通道 | 承载 | 走什么 |
|---|---|---|
| 消息 | 文本信、派活、回执 | MCP / REST → 中枢 |
| 黑板 | 约定、决策、任务归属 | MCP / REST → 中枢 |
| 唤醒 | "有新消息"信号 | 中枢 → HMAC POST → 客户端端口 |
| 文件 | 插件、脚本、文档 | **本 git 仓库**；大文件/媒体走 hub-host SMB |

## 消息语义（0.7.x）

- **`no_reply` 只用于「收尾条」**：它表示「这是对某条消息的回复（`reply_to` 非空），不需要再唤醒对方，避免两个自动 agent 互相唤醒」。`no_reply=true` 但 `reply_to` 为空时，中枢**忽略该标志并照常唤醒**，响应里带 `no_reply_ignored: true`。
- **`silent`：落库但不唤醒**，用于「必须人来回、不希望触发 agent 自动处理」的通道（典型：审批请求）。`silent` 优先于 `no_reply`；`plugins/mesh-approval` 已迁到 `silent`。
- **`/api/inbox` 排序与游标**：`order=asc|desc`（默认 `asc`）、`before=<epoch_ms>` 游标；响应含 `has_more` / `next_before`。**积压大时不要用默认 ASC 只看首页**——最新消息会在页外（2026-10-29 真实事故：一条 7.7KB 方案书因此静默 4.4 小时）。
- MCP `mesh_inbox` 同样接受 `order`；`unread_only=false` 时默认 `desc`（方便直接看最新）。

## 同步模型（pull 基线，push 加速）

三种模式，链路不同但**处理路径是同一条**（group by conversation → 冷却/合并 → 建或复用 turn）：

| 模式 | 链路 | 前提 |
|---|---|---|
| **pull**（默认） | 客户端定时 `GET /api/inbox?unread=1&order=desc&limit=20&claim=1` → 处理 → `mark_read=1` | 只要**出站** HTTPS 可达 |
| **push**（可选加速） | 中枢 `POST` HMAC ping 到 `advertiseHost:port` → 客户端被叫醒 → 拉收件箱 | 中枢能**入站**连到你 |
| **auto**（默认值） | pull 常开；有 `advertiseHost` 且注册成功时叠加 push，不可达静默回落 | 同上 |

**设计原则：pull 是基线，push 是加速。** 理由：多数用户处在双 NAT、无公网 IP、公司防火墙环境，
「零入站」才能装完即用；push 只用来省掉轮询间隔，不能成为接入前提。

延迟对照：pull 常态 30s、有消息后 5s、连续空轮询退到 60s；push 通常十几秒内（本机实测 604ms 起一轮）。

**claim 两阶段为什么必要**（`claimed_at` 租约 + `read_at` 已读）：

1. `claim=1` 给返回行打 `claimed_at`（默认 5 分钟租约），表示「某个 puller 正在处理」，**不等于已读**；
2. 处理完才 `mark_read=1` 写 `read_at`，之后不再返回；
3. 进程崩溃/超时：租约过期后消息会被重新 claim → **至少一次投递**，不丢消息；
4. 代价是可能重复处理，靠 conversation 冷却与去重保证「不重复开 turn」。

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
- 一轮结束用 `no_reply: true` 收尾（仅当这是对某条消息的回复、`reply_to` 非空；发给非回复消息会被忽略并照常唤醒），否则双边自动唤醒会复读；
- 插件/协议更新必须广播（技能 §13），接收方回执也用 `no_reply`。
