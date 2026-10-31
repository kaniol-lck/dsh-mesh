# 鉴权与控制台

本文是 **dsh-mesh 的鉴权模型**与**网页控制台**的操作说明。适用于中枢 0.7.20（覆盖 0.7.3 起的控制台/鉴权能力，含 0.7.12 的 REST 判权与 0.7.16 的来源限制收紧）。

---

## 1. 身份模型

| 身份 | 谁持有 | 用途 | 存储 |
|---|---|---|---|
| **agent token**（`mesh_…`） | 每个节点自己 | 调 `/api/*`、`/mcp`，决定“我是谁” | 中枢只存 SHA-256 |
| **admin token** | 只放在管理机 / 中枢 env | 铸令牌、轮换、吊销、生成注册码、控制台管理 | `MESH_ADMIN_TOKEN` |
| **view token** | 只读观察者 | 控制台只读登录 | `MESH_VIEW_TOKEN` |
| **wake secret** | 每个节点（waker 自动取回） | 中枢 → 节点唤醒 ping 的 HMAC 签名 | `agents.wake_secret` |

要点：

- `token` 模式下 `X-Mesh-Agent` 头**一律忽略**，身份只由 token 决定，防止冒充；
- 每次认证成/败都进 `audit` 表；失败按来源 IP 限流（只慢失败请求，不锁整网）；
- wake secret 由中枢懒生成，节点用自己的 agent token 调 `GET /api/wake-secret` 取回并落盘（0600）；
- `GET /api/bootstrap` 是**唯一**免鉴权端点：只返回端点信息与（可选）CA 公钥，按来源 IP 限速 60 次/分钟（超限 429）；**不含**任何 token / wake_secret / 内部路径，可安全公开。

---

## 2. 令牌权限（scopes）

每个节点可授予 scopes 子集，**留空 = 全部**（升级前的节点继续可用）：

| scope | 允许 |
|---|---|
| `read` | 读收件箱、会话、黑板、成员列表 |
| `send` | `mesh_send` / `/api/send` |
| `board` | 黑板写 |
| `blob` | 文件上传/下载 |

### REST 面判权（0.7.12+）

越权调用返回明确错误：MCP 工具报 `mesh_send requires scope "send"; this agent has: read`；REST 端点返回
`403 {ok:false, error, required_scope}`（0.7.12 起 **MCP 与 REST 双面判权**，此前只有 MCP 工具检查）：

| REST 路径 | 需要的 scope |
|---|---|
| `/api/send`、`/api/message/<id>/pin` | `send` |
| `/api/inbox`、`/api/peers`、`/api/status`、`/api/register`、`/api/read`、`/api/wake-secret`、`/api/board/log`、`/api/conversations`、`/api/conversation`、`/api/message`、`/api/pinned`、blob 读 | `read` |
| `/api/board`（POST） | `board` |
| `/api/blob/*` 写（init/chunk/commit/delete）、`/api/blob` | `blob` |

## 3. IP 白名单与过期

### 令牌过期（`token_expires_at`）

- `allowed_cidrs`：逗号分隔 IPv4/CIDR，如 `192.168.1.0/24,10.8.0.0/16`；留空 = 不限来源。
- `token_expires_at`：毫秒时间戳；到期后该 token 返回 `401 token expired; rotate or re-enroll this agent`，审计记 `auth.expired`。可在控制台节点行设置/清除，或在 mint/rotate/enroll/注册码请求里传 `expires_at`（ISO 8601 或 epoch 毫秒）；省略 = `NULL`（永不过期，默认）。
- 反代/frp 场景需要在反代上透传真实来源地址，否则白名单看到的都是反代 IP。

---

## 4. 控制台（`GET /console`）

### 登录与会话

- `POST /console/login`（表单字段 `token`）：令牌匹配 admin → 角色 `admin`，匹配 view → 角色 `view`；
  成功返回 **303** 跳 `/console` 并下发 cookie，令牌不对返回 **401**（登录页带错误提示）；
- **失败限速**：同一来源 IP 连续 5 次错误 → 锁 60 秒，期间登录返回 **429**；
- **会话 cookie**：`mesh_console=<随机>`，属性 `HttpOnly; SameSite=Strict; Path=/console; Max-Age=43200`（**12 小时**）；
  服务端另存会话表，过期即失效；
- `POST /console/logout` → **303** 跳回登录页并 `Max-Age=0` 清 cookie；
- 也接受 `Authorization: Bearer <token>` 直接访问（不做浏览器会话），此时无需 CSRF。

### CSRF

- **cookie 会话**的写操作必须带 `x-mesh-csrf`，值来自页面内联（服务端为每个会话生成随机 token）；
  缺失/不符返回 `403 bad csrf token`；
- **bearer admin** 不依赖 ambient cookie，无 CSRF 可言，因此**免 CSRF**；
- 只读角色（view）做写操作一律 `403 admin role required`。

### 角色

| 令牌 | 角色 | 能做什么 |
|---|---|---|
| view token | 只读 | 看状态、成员、插件版本、权限、审计 |
| admin token | 管理员 | 以上 + **轮换/吊销令牌、改 scopes、改 IP 白名单、生成注册码、批准设备** |

- `MESH_VIEW_TOKEN` **未设置时回退为 `MESH_ADMIN_TOKEN`**：此时任何能登录控制台的人都拿到管理员权限；
  生产环境应显式设置独立的 view token。

### 来源限制（`MESH_CONSOLE_ALLOW`）

- 逗号分隔 IP/CIDR；**默认只允许 loopback**（`127.0.0.1`、`::1`）——0.7.16 起收紧，
  旧版本默认还包含 RFC1918 内网段；
- **迁移**：升级后若要从局域网访问控制台，必须显式设置 `MESH_CONSOLE_ALLOW=192.168.0.0/16,10.0.0.0/8`（按你的网段）；
  保持默认则只能经 SSH 转发 / 本机访问；
- 不在允许来源时返回 `403 console is not reachable from this address`，并记审计 `console_blocked`；
- 明文 HTTP 上只应在内网使用；跨网请加 TLS 或仅监听 loopback 并走 SSH 转发。

页面区块：概览卡片 · 成员与插件版本（含 `outdated` 标记）· **节点权限与令牌**（scopes 勾选、CIDR 输入、轮换、吊销、批准设备）· 审计。

---

## 5. 新增节点

### 方式 A：控制台生成注册码（推荐）

1. 管理员登录控制台；
2. 生成注册码（10 分钟有效、单次使用）；
3. 在新节点上执行：

```bash
curl -s -X POST http://<hub>:8790/api/enroll \
  -H 'content-type: application/json' \
  -d '{"code":"ABCD1234","name":"dsh-new-node","host":"192.168.1.50"}'
# → {"name":"dsh-new-node","token":"mesh_…"}
```

4. 把 token 写入节点 `~/.dsh/mesh-waker/token`（0600），配置 `tokenFile` 指向它，重载插件；
5. 用 `/api/peers` 或在控制台确认该节点 `online` 且插件版本正确。

### 方式 B：设备码配对（人在控制台批准）

1. 新节点请求配对（无需任何凭据）：

```bash
curl -s -X POST http://<hub>:8790/api/enroll/request \
  -H 'content-type: application/json' -d '{"name":"dsh-new-node","host":"192.168.1.50"}'
# → {"user_code":"ABCD-1234","device_code":"…","expires_in_seconds":600}
```

2. 管理员在控制台「待批准设备」点批准（或 `POST /api/admin/enroll/approve {"user_code":"…"}`，拒绝用 `/deny`）；
3. 节点轮询换 token（`device_code` 只给节点，控制台页面从不显示）：

```bash
curl -s -X POST http://<hub>:8790/api/enroll/token \
  -H 'content-type: application/json' -d '{"device_code":"…"}'
# 202 pending / 201 {"name","token"} / 403 denied / 410 expired
```

- 设备码 **10 分钟**、单次；请求按 IP 限速 5 次/分钟、轮询 10 次/分钟（超限 429）。

### 方式 C：管理员 API 直接铸令牌

```bash
curl -s -X POST http://<hub>:8790/api/admin/agents \
  -H "Authorization: Bearer $MESH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"dsh-new-node","host":"192.168.1.50"}'
```

token 只返回一次（同方式 A 第 4 步落地）。

### 方式 D：控制台轮换已有节点

控制台节点行点「轮换」→ 新 token 只显示一次 → 替换该节点 `token` 文件并重载插件。旧 token 立即失效。

> 节点侧不需要、也不应该持有 admin token。

---

## 6. 轮换与吊销

| 场景 | 操作 | 影响 |
|---|---|---|
| 定期轮换 | 控制台「轮换」或 `POST /api/admin/rotate {name}` | 旧 token 立即失效，节点需更新 token |
| 节点丢失 | 控制台「吊销」或 `DELETE /api/admin/agents?name=…` | `token_hash` 置空，该身份立即无法认证 |
| 重新上线 | 重新生成注册码 enroll，或再次 mint | 身份同名复活 |
| 泄露应急 | 轮换 + 检查审计 `auth.fail` / `auth.ip_blocked` | 建议同时收紧该节点 CIDR |

---

## 7. 排错表

| 返回 | 含义 | 处理 |
|---|---|---|
| `401 missing bearer token` | 请求没带 token | 检查客户端配置 |
| `401 invalid token` | token 不在库中或已被轮换/吊销 | 重新铸造并更新节点 |
| `401 token expired` | 过了 `token_expires_at` | 轮换或重新 enroll |
| `403 … allowlist` | 来源 IP 不在 `allowed_cidrs` | 改白名单或修正反代来源地址 |
| `403 scope …` | 该节点缺对应 scope | 控制台勾选相应 scope |
| `403 admin role required` | 用只读令牌做管理操作 | 用 admin token 登录 |
| `403 bad csrf token` | 管理写操作缺/错 CSRF | 用控制台页面操作，或带正确 `x-mesh-csrf` |
| `console is not reachable from this address` | `MESH_CONSOLE_ALLOW` 不含该来源 | 调整 env 或从内网访问 |
| `429 too many failed auth attempts` | 失败认证触发限流 | 等待窗口结束，先修好 token |

---

## 8. 安全边界（重要）

1. **admin token 只在管理机 / 中枢 env**，不下发节点；
2. **view token 与 admin token 必须不同**；`MESH_VIEW_TOKEN` 未设置时会回退成 admin token，控制台因此获得全部权限——生产环境务必显式设置独立的 view token；
3. 管理面默认只允许内网来源；跨互联网必须 TLS 或只监听 loopback + SSH 转发；
4. 插件设置页的「轮换本机令牌」需要节点本地 `admin-token` 文件，**推荐改用控制台轮换**，避免这个文件扩散；
5. 所有写操作查审计：`GET /api/admin/audit?limit=50` 或控制台「审计」区块。
