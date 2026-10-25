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
- 一轮结束用 `no_reply: true` 收尾，否则双边自动唤醒会复读；
- 插件/协议更新必须广播（技能 §13），接收方回执也用 `no_reply`。
