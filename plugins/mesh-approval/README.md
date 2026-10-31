# mesh-approval：审批转发参考实现

把「危险命令待批准」转进 dsh-mesh 收件箱，等人回复后再决定放行或拒绝。这是**唯一参考实现**：照着它可以把同一套机制接到别的 agent harness 上（见「改造成别的 harness」）。

## 1. 用途与边界

- **审批是执行层的硬闸门**，不是聊天问答：宿主在真正执行命令前阻塞，直到拿到 `approve|session|always|deny` 之一；超时一律按 `deny` 处理（fail-closed）。
- 只适合「**执行/不执行**」这类二值决策。
- **不适用于**「要不要现在发版」「这个方案怎么样」这类商量——那属于提问桥/普通消息，不该阻塞执行。
- Hermes 的 chat-gateway 会话（Telegram/QQ/Discord 等）保留宿主自带提示：插件直接抛错让宿主回退到内置审批，人在手机上点。

## 2. 安装

这是 **Hermes 侧 Python 插件**，不是 npm 包，`dsh plugin add` 装不了。

1. 把 `plugins/mesh-approval/` 目录放到 Hermes 的插件目录（目录名保持 `mesh-approval`，内含 `__init__.py` 与 `plugin.yaml`）；
2. `plugin.yaml` 声明 `kind: standalone`（本插件依赖宿主提供 `hermes_cli.approval_transport`）；
3. 在 Hermes 侧注册 transport：

```python
# __init__.py 末尾
def register(ctx) -> None:
    ctx.register_approval_transport("mesh", present)
```

4. 配好下面的环境变量后在 Hermes 里启用该插件；用 `python plugins/mesh-approval/test_transport_contract.py` 可跑契约测试。

## 3. 配置

| 变量 | 默认 | 作用 |
|---|---|---|
| `MESH_HUB` | `http://127.0.0.1:8790` | 中枢地址；带路径前缀时不要带尾部 `/` |
| `MESH_APPROVAL_PEER` | **必填** | 审批消息发给哪个 mesh agent（人在那台机器上收） |
| `MESH_APPROVAL_POLL` | `3`（秒） | 轮询收件箱间隔 |
| `MESH_APPROVAL_MAX_WAIT` | `240`（秒） | 最长等待；实际取 `min(宿主给的 timeout, 该值)` |

**token 来源**（按顺序取第一个非空值）：

1. `<agent-home>/.mesh-token`
2. `~/.mesh-token`
3. 环境变量 `MESH_TOKEN`

拿不到 token 时直接 `deny`（不阻断启动，但审批一律拒绝）。

## 4. 消息语义

- **必须 `silent: true`**：审批消息落库但**不唤醒任何 agent**。若用普通消息，接收方 agent 可能自己读到并「批准自己」——审批就失去意义。不要用 `no_reply` 代替（没有 `reply_to` 时中枢会忽略它并照常唤醒）。
- **超时一律 `deny`**（fail-closed）：网络错误、发送失败、轮询失败、等待超时都返回 deny；宁可挡住命令，也不静默放行。
- **请求与回复的匹配**：审批消息正文带 `request_id`；回复正文里出现完整 `request_id` 或前 8 位即视为匹配。会话 id 用 `conv/approval-<request_id 前 8 位>`，方便把同一请求的往来归组。
- **`allowed_choices` 收窄**：回复映射到 `once|session|always|deny` 后，若不在宿主给的 `allowed_choices` 里，**强制降级为 `deny`**。
- **词表**（不区分大小写，按顺序匹配第一个命中）：

| 回复词 | 决定 | 含义 |
|---|---|---|
| `approve` / `同意` / `allow` | `once` | 仅本次允许 |
| `session` / `会话` | `session` | 本会话内允许 |
| `always` / `始终` | `always` | 永久允许 |
| `deny` / `reject` / `拒绝` | `deny` | 拒绝（默认） |

- 匹配成功后会 `POST /api/read` 确认该条消息，避免下一轮重复处理。

## 5. 改造成别的 harness（三步）

### 第 1 步：接缝——找到宿主的审批钩子

不同 harness 的钩子不同，但形状都是「同步回调 + 返回决定或交还本地提示」：

| 宿主 | 接缝 |
|---|---|
| DSH | `ctx.on('approval/request', (req, next) => …)`，返回 `allowed-once` / `rejected`，或 `next()` 交回本地提示 |
| Hermes（本实现） | `ctx.register_approval_transport("mesh", present)`，返回 `ApprovalDecision(request_id, digest, choice)` |
| 其他 | 在「执行前拦截」处拿到命令、请求 id、超时、允许选项 |

### 第 2 步：发消息

```http
POST /api/send
Authorization: Bearer <token>
Content-Type: application/json

{ "to": "<审批人所在的 agent>", "subject": "⚠️ 审批请求：…", "body": "命令… request_id: …",
  "conversation": "conv/approval-<id 前 8 位>", "silent": true }
```

`silent: true` 是硬要求；`conversation` 让同一请求的往来落在一个会话里。

### 第 3 步：解析回复并映射决定

轮询 `GET /api/inbox?unread=1&limit=20&order=desc`，找到正文含 `request_id` 的消息，按词表映射；不在 `allowed_choices` 里 → `deny`；命中后 `POST /api/read {ids:[…]}`；等到超时仍未命中 → **交给本地提示**（Hermes 的 `transport_fallback: builtin`），不要静默拒绝后又假装已处理。

## 6. 安全清单

- **token 不进对话**：只放文件或环境变量，日志里只打印前缀/长度；
- **只发给指定 peer**：审批消息只发给 `MESH_APPROVAL_PEER` 这一个 agent，不要广播 `to:"*"`；
- **注意 `visible_to` 的适用范围**：它作用于 blob，不是消息；消息的收件人隔离靠 token 与 peer 选择；
- **审计留痕**：审批消息会进中枢库（`messages`），`/api/read` 的时间戳就是「人何时看过」的证据；
- **`silent` 不可省**：省略它等于允许 agent 自批；
- **超时/异常一律 deny**，且日志里写明原因（发送失败、无 token、超时），便于事后对账。
