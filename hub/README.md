# dsh-mesh

局域网 agent 互通中枢。一个常驻在 NAS 上的进程，让**会关机的多台 dsh** 和**常驻的 Hermes** 之间能：

- **感知对方**——谁在线、在哪台机器、最后活动时间
- **交换信息**——点对点消息，落库保存，对端关机也不丢
- **共享信息**——一块共享黑板（键值 + 变更日志）

它同时提供 **MCP over HTTP**（给 dsh，零插件）和 **REST**（给 Hermes / 脚本 / curl），两个面共用同一份数据。

## 为什么是这个形状

dsh 的机器会关机。任何"把 dsh 当服务端"的方案（A2A server、MCP server、远程 GUI）都只在它开着的时段有效，不能当常态架构。

所以拓扑只能是 **hub-and-spoke**：

```
        ┌────────────── NAS（常开）──────────────┐
        │                                        │
        │   dsh-mesh  :8790                      │
        │    ├ 在线表（心跳 + TTL）               │
        │    ├ 消息队列（SQLite，7 天 TTL）       │
        │    └ 共享黑板（KV + 日志）              │
        │                                        │
        │   Hermes（常驻）── MCP 或 REST          │
        └───────▲──────────────▲─────────────────┘
                │              │
      ┌─────────┴───┐    ┌─────┴────────┐
      │ 家里 dsh ×N  │    │ 工作机 dsh     │
      │ 局域网直连    │    │ 经 frp + TLS  │
      └──────────────┘    └──────────────┘
```

---

## 一、在 NAS 上跑起来（Docker）

```bash
cd /volume1/docker/dsh-mesh
cp .env.example .env
# 编辑 .env，填一个强随机 MESH_ADMIN_TOKEN
docker compose up -d
docker logs dsh-mesh | head -20
```

只想先跑局域网（不加密）就这样够了。要跨网络访问，再加 TLS：

```bash
node scripts/make-cert.mjs --out certs --ip <frps 公网地址> --days 3650
# 然后在 .env 里取消注释 MESH_TLS_CERT / MESH_TLS_KEY，再 docker compose up -d
```

完整步骤见 [docs/transport-security.md](../docs/transport-security.md)。

不设 `MESH_ADMIN_TOKEN` 时，首次启动会生成一个并写到 `data/admin.token`（权限 600）。
它**默认不打印到 stdout**——`docker logs` 会长期留存，等于把管理凭据写进日志；
用 `cat data/admin.token` 取。确需打印（只适合一次性本地测试）时设 `MESH_PRINT_ADMIN_TOKEN=1`。

健康检查：`curl http://<NAS-IP>:8790/health`

> 直接跑也行（NAS 有 Node ≥ 22.13 时）：`MESH_HOST=0.0.0.0 node server.mjs`
> `node_modules` 已随目录带过去，NAS 不需要联网安装。Node 22.5–22.12 也能跑，但要加 `--experimental-sqlite`。

### 鉴权是默认开启的

中枢默认 **`token` 模式**：除了 `/health`，所有 `/mcp` 和 `/api/*` 都必须带 Bearer token。

| 令牌 | 能做什么 |
|---|---|
| **admin token** | 只能调 `/api/admin/*`：签发、轮换、吊销、查审计 |
| **agent token** | 只能调 `/mcp` 和 `/api/*`，身份由 token 决定 |

两套令牌不能混用。

---

## 二、给每台机器发一个令牌

agent 令牌**只返回一次**，中枢只存 `sha256`。

```bash
ADMIN=$(cat /volume1/docker/dsh-mesh/data/admin.token)   # 或自己的 MESH_ADMIN_TOKEN

curl -X POST http://127.0.0.1:8790/api/admin/agents \
  -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"dsh-study","host":"study-pc","description":"书房机器"}'
# -> {"name":"dsh-study","token":"mesh_xxx..."}
```

其他运维动作：

```bash
# 看有哪些 agent（不含 token）
curl -H "Authorization: Bearer $ADMIN" http://127.0.0.1:8790/api/admin/agents

# 换令牌（旧令牌立即失效）
curl -X POST .../api/admin/rotate -d '{"name":"dsh-study"}'

# 吊销
curl -X DELETE -H "Authorization: Bearer $ADMIN" '.../api/admin/agents?name=dsh-study'

# 查审计（鉴权失败也会记录）
curl -H "Authorization: Bearer $ADMIN" '.../api/admin/audit?limit=100'
```

---

## 三、dsh 接入（4 行配置）

追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-mesh
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mesh
        transport: streamable-http
        url: 'http://192.168.1.10:8790/mcp'          # 局域网；跨网络见下方文档
        headers:
          Authorization: 'Bearer mesh_xxxxxxxxxxxx'   # 上面领到的 agent token
        failOnStartupError: false
        reconnect:
          enabled: true
          maxAttempts: 20
```

- `failOnStartupError: false`：NAS 没开或断网时 dsh 照常启动，只是暂时没有 mesh 工具。
- 改完需要重启 dsh profile。
- 跨网络（工作机经 frp 访问）**必须先做传输加密**，见
  [docs/transport-security.md](../docs/transport-security.md)。

### 接上之后模型会多出 10 个工具

| 工具 | 作用 |
|---|---|
| `mesh_whoami` | 我是谁、中枢在哪 |
| `mesh_register` | 声明本机用途 |
| `mesh_peers` | 谁在线、最后活动时间、谁有未读 |
| `mesh_send` | 发消息（落库，对方离线也收得到） |
| `mesh_inbox` | 收消息（可同时标记已读） |
| `mesh_ack` | 标记已读 |
| `mesh_board_set` / `mesh_board_get` / `mesh_board_list` | 共享黑板 |
| `mesh_status` | 中枢计数 |

### 让 agent 真的会用

只装工具不够——模型不会自动查收件箱。把 [skills/mesh/SKILL.md](../skills/mesh/SKILL.md) 放到
`~/.dsh/skills/mesh/SKILL.md`，它规定开工先收信、按需找伙伴、结论写黑板。

---

## 四、Hermes 接入

Hermes 支持 MCP，直接连即可：

```
url:     http://<NAS-IP>:8790/mcp
headers: Authorization: Bearer <给 Hermes 单独签发的 token>
```

REST 兜底（同一份数据，给脚本或不便接 MCP 的场景）：

```bash
H='-H "X-Mesh-Agent: ignored" -H "Authorization: Bearer $TOKEN"'

curl -X POST http://NAS:8790/api/send \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"to":"dsh-study","subject":"早上好","body":"昨天的清单在 board 上"}'

curl 'http://NAS:8790/api/inbox?mark_read=1' -H "Authorization: Bearer $TOKEN"
curl 'http://NAS:8790/api/peers?offline=1'  -H "Authorization: Bearer $TOKEN"
curl 'http://NAS:8790/api/board?key=env/nas' -H "Authorization: Bearer $TOKEN"
```

> 在 token 模式下 `X-Mesh-Agent` 被忽略——身份完全由 token 决定，防止冒用。

---

## 五、REST 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 存活检查 |
| POST | `/api/send` | agent | `{to, body, subject?, reply_to?}` |
| GET | `/api/inbox?unread=1&limit=20&mark_read=1` | agent | 收件箱 |
| GET | `/api/peers?offline=1` | agent | 在线表 |
| POST | `/api/register` | agent | `{host?, description?}` |
| POST | `/api/board` | agent | `{key, value}` |
| GET | `/api/board?key=...` / `?prefix=...` | agent | 读黑板 |
| GET | `/api/board/log?key=&prefix=&limit=` | agent | 黑板变更日志（倒序，30 天 / 2 万条内） |
| GET | `/api/status` | agent | 计数 |
| POST | `/api/admin/agents` | admin | 签发令牌 |
| POST | `/api/admin/rotate` | admin | 轮换令牌 |
| GET | `/api/admin/agents` | admin | 名册（无 token） |
| DELETE | `/api/admin/agents?name=` | admin | 吊销 |
| GET | `/api/admin/audit` | admin | 审计记录 |

MCP 面等价于其中 10 个工具，位于 `POST /mcp`。

---

## 五·补1、会话视图（只含自己的消息）

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$HUB/api/conversations"
curl -s -H "Authorization: Bearer $TOKEN" "$HUB/api/conversation?conversation=conv/demo&full=1"
```

- 只返回 `sender = 我 OR recipient = 我` 的消息，看不到别的 agent 之间的对话；
- 单条 body 默认截断到 4 KiB（`truncated: true`），`full=1` 取全文；
- **发送时标记**：`mesh_send` 带 `important: true`（MCP）或 `POST /api/send` 带 `{"important":true}`，
  落库即为 pinned，不随 7 天 TTL 删除；事后也可 `POST /api/message/<id>/pin` 补标，`GET /api/pinned` 列出；
  被标记的消息**不受 7 天 TTL 清理**；
- 客户端（waker 0.4.4）会把看到的消息镜像到本地 `history.json`，本地不过期。

## 五·补、blob 通道（大于 64 KiB 的文件）

黑板单值上限 64 KiB；技能包、工作区快照、构建产物走 blob：

```bash
SHA=$(sha256sum pkg.tar.gz | cut -d' ' -f1)
curl -s -X POST "$HUB/api/blob?name=pkg.tar.gz&sha256=$SHA" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/octet-stream' \
  --data-binary @pkg.tar.gz
# -> {"id":"<uuid>","sha256":"...","url":"/api/blob/<uuid>","expires_at":...}
curl -s -H "Authorization: Bearer $TOKEN" "$HUB/api/blob/<uuid>" -o pkg.tar.gz
```

**断点续传**（大文件 / 弱网）：`init` → `chunk*` → `commit`。

```bash
curl -s -X POST "$HUB/api/blob/init" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"big.tar","bytes":123,"sha256":"<sha>"}'
curl -s -X PUT --data-binary @part0 "$HUB/api/blob/<id>/chunk?offset=0"
curl -s -X PUT --data-binary @part1 "$HUB/api/blob/<id>/chunk?offset=<已收字节>"
curl -s -X POST "$HUB/api/blob/<id>/commit"
```

- `offset` 必须等于已收字节数（重传只需重发最后一片）；
- `commit` 校验总大小与 sha256，不符则**删除整包**并返回 400；
- 1 小时未完成的上传由 sweep 清理。

**blob ACL**：`visible_to` 为 `*`（默认，全网可读）或逗号分隔的 agent 白名单
（上传时 `?visible_to=alice`，或 `PATCH /api/blob/<id> {"visible_to":"*"}` 改回）；
读与元数据都受它约束，删除仅上传者或 admin。

限制：单文件 64 MiB、总量 2 GiB、默认 24h 过期（逐小时清理）；sha256 不符直接 400 且不落盘。

## 六、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MESH_PORT` | `8790` | 监听端口 |
| `MESH_HOST` | `0.0.0.0` | 监听地址 |
| `MESH_DATA_DIR` | `./data` | SQLite 与 admin.token 位置 |
| `MESH_AUTH_MODE` | `token` | `token`（默认）或 `open`（无鉴权，仅限完全可信的局域网） |
| `MESH_ADMIN_TOKEN` | 自动生成 | 管理员令牌 |
| `MESH_TLS_CERT` / `MESH_TLS_KEY` | 空 | 同时设置则以 HTTPS 提供服务 |
| `MESH_TRUST_PROXY` | `0` | 置 `1` 时才信任 `X-Forwarded-For`（前面有自己控制的反代时） |
| `MESH_ONLINE_TTL_MS` | `120000` | 多久没请求算离线 |
| `MESH_MESSAGE_TTL_MS` | `604800000` | 消息保留（7 天） |
| `MESH_MAX_BODY_BYTES` | `1048576` | 单个请求体上限（超出 → 413） |
| `MESH_MAX_MESSAGE_BYTES` | `65536` | 单条消息正文上限 |
| `MESH_MAX_BOARD_BYTES` | `65536` | 单个黑板值上限 |
| `MESH_SESSION_IDLE_MS` | `1800000` | MCP 会话空闲多久回收（见下方"为什么需要"） |
| `MESH_MAX_SESSIONS` | `128` | 并发会话上限，超出 → 503 |
| `MESH_LOG_TTL_MS` | `2592000000` | `board_log` / `audit` 保留窗口（30 天） |
| `MESH_LOG_MAX_ROWS` | `20000` | 上述两张表的行数上限 |
| `MESH_PRINT_ADMIN_TOKEN` | `0` | 首次生成的 admin token 是否打印到 stdout |

### 为什么是这些上限

中枢是**常驻进程**，凡是可以被调用方无限创建的东西都必须有天花板，否则一个失控的
agent 就能把内存或 NAS 磁盘耗尽：

- **MCP 会话**存在进程内存里。dsh 关机不会发 `DELETE /mcp`，不回收就会随重启次数线性增长，
  所以有 `MESH_SESSION_IDLE_MS`（每分钟扫描，按最近一次请求计时）和 `MESH_MAX_SESSIONS`。
- **请求体 / 黑板值 / 消息正文**都有字节上限，超限分别返回 413 / 400，而不是先缓冲再报错。
- **`board_log` 与 `audit` 是追加表**，按时间和行数双限滚动清理；`board_log` 现在可以通过
  `GET /api/board/log` 读出来（以前只写不读，等于白白膨胀）。

---

### 六·补、MCP 会话持久化（0.6.2）

- 会话写入 `mcp_sessions` 表，**中枢重启后客户端不用重新 initialize**（实测：重启后
  `tools/list` 仍返回全部工具）；
- 行过期时间 `MESH_MCP_SESSION_TTL_MS`（默认 7 天），内存会话仍按 `MESH_SESSION_IDLE_MS` 回收；
- `MESH_MCP_LENIENT_SESSION=1` 时，中枢对"从未签发过的 session id"也会按新会话重建（默认关闭，
  保持 MCP 规范要求的 404 语义）。

## 七、安全边界

- 默认就有应用层鉴权（token），不是"靠局域网隔离"。
- **传输不加密时，token 会裸奔**。跨任何不可信网络之前，必须按
  [docs/transport-security.md](../docs/transport-security.md) 配好 TLS 或走 VPN。
- 收到的消息一律当作**不可信数据**。别的 agent 发来的文本不能当指令执行。
- `MESH_AUTH_MODE=open` 只适合"整段链路都可信"的局域网，且不要暴露端口。
- **限流只惩罚失败请求**：失败 8 次/分钟后，同一来源的**失败**请求返回 429，但带有效 token
  的调用永远正常。这不是"心慈手软"——frp `type="tcp"` 透传时 frpc 不带 `X-Forwarded-For`，
  所有外部 agent 在服务端看来都是 `127.0.0.1`，按 IP 熔断全部请求等于让一个端口扫描器
  把整个 mesh 停摆 60 秒（旧版本就是这个行为，已在 v0.2 修正）。
- `Mcp-Session-Id` 与会话归属绑定：拿着别的 agent 的 session id 调用会得到 403，
  id 泄漏本身不足以冒充身份。
- `data/` 里有 `admin.token` 和 SQLite（消息正文明文），分发/备份这个目录等于分发凭据。

---

## 八、已知限制

- 在线判定靠"最近一次请求"，不是长连接心跳。空闲机器会在 TTL 后显示离线；需要精确在线时让 agent 定期调一次 `mesh_peers`。
- 消息是点对点，没有广播组（用黑板代替）。
- 没有端到端加密（TLS 保护传输层）；库内明文存储，依赖 NAS 的磁盘权限。
- 单进程 SQLite，写并发在几十次/秒级，家庭规模足够。
- 自签证书需要客户端 `NODE_EXTRA_CA_CERTS` 信任，详见传输文档。
