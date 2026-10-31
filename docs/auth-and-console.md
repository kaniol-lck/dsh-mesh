# 鉴权与控制台

本文是 **dsh-mesh 的鉴权模型**与**网页控制台**的操作说明。适用于中枢 0.7.9+。

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

越权调用返回明确错误：`mesh_send requires scope "send"; this agent has: read`。

## 3. IP 白名单与过期

- `allowed_cidrs`：逗号分隔 IPv4/CIDR，如 `192.168.1.0/24,10.8.0.0/16`；留空 = 不限来源。
- `token_expires_at`：毫秒时间戳；到期后该 token 返回 `401 token expired; rotate or re-enroll this agent`，审计记 `auth.expired`。可在控制台节点行设置/清除，或在 mint/rotate/enroll/注册码请求里传 `expires_at`（ISO 8601 或 epoch 毫秒）；省略 = `NULL`（永不过期，默认）。
- 反代/frp 场景需要在反代上透传真实来源地址，否则白名单看到的都是反代 IP。

---

## 4. 控制台（`GET /console`）

登录用哪类令牌决定角色：

| 令牌 | 角色 | 能做什么 |
|---|---|---|
| view token | 只读 | 看状态、成员、插件版本、权限、审计 |
| admin token | 管理员 | 以上 + **轮换/吊销令牌、改 scopes、改 IP 白名单、生成注册码** |

安全设计：

- **来源限制** `MESH_CONSOLE_ALLOW`：逗号分隔 IP/CIDR；默认 `loopback + RFC1918`（127.0.0.1、::1、10/8、172.16/12、192.168/16）；
- 登录换 **HttpOnly + SameSite=Strict** cookie，12 小时；
- 写操作要求 **CSRF token**（页面内 `x-mesh-csrf`），只读角色写操作返回 403；
- 连续 5 次错误令牌锁 60 秒；所有管理动作进审计；
- 明文 HTTP 上只应在内网使用；跨网请加 TLS 或仅监听 loopback 并走 SSH 转发。

页面区块：概览卡片 · 成员与插件版本（含 `outdated` 标记）· **节点权限与令牌**（scopes 勾选、CIDR 输入、轮换、吊销）· 审计。

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

### 方式 B：管理员 API 直接铸令牌

```bash
curl -s -X POST http://<hub>:8790/api/admin/agents \
  -H "Authorization: Bearer $MESH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"dsh-new-node","host":"192.168.1.50"}'
```

token 只返回一次（同方式 A 第 4 步落地）。

### 方式 C：控制台轮换已有节点

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
2. **view token 与 admin token 必须不同**；只有 admin token 时控制台会获得全部权限，务必显式设置 view token；
3. 管理面默认只允许内网来源；跨互联网必须 TLS 或只监听 loopback + SSH 转发；
4. 插件设置页的「轮换本机令牌」需要节点本地 `admin-token` 文件，**推荐改用控制台轮换**，避免这个文件扩散；
5. 所有写操作查审计：`GET /api/admin/audit?limit=50` 或控制台「审计」区块。
