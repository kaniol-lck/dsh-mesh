# dsh-mesh-waker

DSH 客户端插件：[dsh-mesh](https://github.com/kaniol-lck/dsh-mesh) 局域网 agent 中枢的接入端。

默认是 **pull 模式**：本机按间隔向中枢 `GET /api/inbox?claim=1` 拉信，所以**不需要公网 IP、不需要入站端口、不需要 `NODE_EXTRA_CA_CERTS`**。有入站能力时再叠加 push（中枢发 HMAC 签名的 `/mesh/wake` ping），把延迟从「一个轮询间隔」压到「一次 HTTP」；两条路径共用同一套 conversation 冷却与去重，不会重复开 turn。

## 安装

```bash
dsh plugin add dsh-mesh-waker
dsh plugin --profile web add dsh-mesh-waker
```

装完打开 **设置 → Mesh**，填两样就能接入：

1. `hubUrl`，例如 `http://<NAS-IP>:8790` 或 `https://mesh.example.com`；
2. `joinCode`（中枢控制台/管理员发的 8 位一次性注册码）。

启动时插件 `GET /api/bootstrap` 取服务信息（以及可选 CA），再 `POST /api/enroll` 换回自己的 agent token，按 `0600` 写进 `tokenFile`；日志里只出现 `token fp=<前6位>… len=<n>`，重启后不再需要 `joinCode`。

> 不用中枢也能跑：**不填 `hubUrl` 就是 standalone**，只起本机 `127.0.0.1:8795` 的五个本地端点，供同一 DSH 里的会话互相 inject。

## 它提供什么

- **唤醒端点**：`/mesh/wake`，校验 HMAC 与时间窗；错误签名直接拒绝，不消耗会话；
- **设置页**：中枢地址、信任级别（strict / normal / full）、按设备信任、收件箱目录、投递方式、启动补收；
- **收件箱**：右栏「开始」里的「Mesh 信箱」卡片 + 左侧侧边栏整页视图，按会话聚合、悬停预览、点击跳转、按收发着色；
- **本地历史缓存**：中枢只保留 7 天消息，插件把见过的消息镜像到本地 `history.json`，不过期；
- **会话绑定**：会话 ↔ mesh conversation 的映射分「唤醒路由」与「面板显示」两个字段，互不干扰；
- **pull 循环**（默认）：`claim=1` → 按 conversation 分组 → 走现有唤醒路径 → `mark_read`；间隔自适应（有信 5s / 常态 30s / 连续 3 次空 60s），失败按 `5s × 2^n` 退避（上限 5 分钟）；
- **自举接入**：`hubUrl` + `joinCode` → 取 CA → 换 token → 写 `tokenFile`（0600），全程不打印密钥；
- **standalone**：没有 `hubUrl` 时只起本机监听，`/mesh/status.mode="standalone"`，不发任何网络请求。

## 配置

全部可选；写在 profile 的 cordis patch 里（或 `~/.dsh/mesh-waker/config.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `hubUrl` | — | 中枢地址；留空 = standalone |
| `token` / `tokenFile` | — | agent token；优先读 `tokenFile`（自举会把换到的 token 写进去） |
| `joinCode` | — | 一次性注册码；有它且没有 token 时自动换 token |
| `wakeSecret` / `wakeSecretFile` | — | **只有 push 需要**；pull 模式缺它不报错、不阻塞 |
| `mode` | `auto` | `auto`（pull 常开，push 叠加）/ `pull` / `push` |
| `listenHost` | `127.0.0.1` | 只有 push 才需要改 `0.0.0.0` 或 LAN 地址 |
| `listenPort` | `8795` | 本地面板与会话端口 |
| `advertiseHost` | — | push 时告诉中枢的可达地址（决定 `wakeUrl`） |
| `caFile` | — | 额外 CA PEM，用于出站 TLS（替代 `NODE_EXTRA_CA_CERTS`） |
| `caSha256` | — | 可选指纹钉扎；与 `caFile` 或 bootstrap 返回的 `tls.ca_sha256` 比对，不符即拒绝连接 |
| `pollIntervalMs` | `30000` | 常态轮询间隔（下限 5000，上限 600000） |
| `pollBusyIntervalMs` | `5000` | 拉到消息后的快档间隔 |
| `pollIdleIntervalMs` | `60000` | 连续 3 次空轮询后的慢档间隔 |
| `claimTtlMs` | `300000` | claim 租约；puller 崩溃后由中枢自动回收 |

**激活矩阵**：

| hubUrl | token | joinCode | 行为 |
|---|---|---|---|
| 无 | 任意 | 任意 | **standalone**：只绑 `listenHost:listenPort`，不发任何网络请求 |
| 有 | 有 | 任意 | 正常启动，`mode` 决定 pull / push / auto |
| 有 | 无 | 有 | **自举**：`/api/bootstrap` → `/api/enroll` → token 写 `tokenFile`(0600) → 继续启动 |
| 有 | 无 | 无 | standalone，且 `lastError="missing token (provide joinCode or tokenFile)"`（不静默退出） |

CA 只记 sha256 前 16 位，token 只记 `fp=<前6位>… len=<n>`；任何日志都不打印密钥。


## 本机会话协作（不经过中枢）

同机、同一个 DSH 里的多个会话可以直接互相派活：waker 在 `127.0.0.1:8795` 暴露会话发现与注入接口，全程本地、毫秒级、离线可用。所有端点**只接受 loopback 请求**。

| 端点 | 作用 |
|---|---|
| `GET /mesh/sessions` | 列出本机会话（最多 80 条，按最后活动排序）：`id` / `title` / `cwd` / `workspace` / `last_active` / `live` / `archived` |
| `POST /mesh/inject` | 向已有会话投一轮任务：按 `session`（完整 id）→ 精确标题 → 标题唯一子串寻址；歧义或找不到返回 400。`mode` 为 `queue`（默认，等当前回合）或 `steer`（打断当前回合） |
| `POST /mesh/sessions/create` | 新建会话并绑定工作区，可选首轮 `prompt`；返回 `sessionId` / `workspaceId` / `workspacePath` / `prompted` |
| `POST /mesh/sessions/archive` | 归档会话：日志保留、侧栏隐藏；存活的会话会被宿主拒绝（`workspace/session-active`） |
| `POST /mesh/sessions/delete` | 删除会话：先停掉在跑的 agent（`sessionController.cancel` + 宿主 dispose 钩子），摘掉 `conversations.json` 里指向它的绑定，再删会话目录；停不下来的返回 **409**，不会假报成功 |

可直接复制：

```powershell
# 1. 看看有哪些会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 2. 给某个会话派活（按标题寻址；同名会 400 而不是随便挑一个）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' -d '{"title":"hub 文档维护","text":"列出 README 与实现不一致处，只列不改"}'

# 3. 新建执行会话并立刻投首轮任务（cwd 指向具体仓库根）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/create -H 'content-type: application/json' -d '{"title":"mesh · 临时工","cwd":"D:\\Libraries\\Documents\\projects\\dsh-mesh\\public","prompt":"先读 hub/README.md，列出与 docs 不一致处"}'

# 4. 归档 / 删除（都按完整 id）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/archive -H 'content-type: application/json' -d '{"session":"session-…"}'
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/delete -H 'content-type: application/json' -d '{"session":"session-…"}'
```

`delete` 只删 waker 能发现的会话（id 必须出现在 `GET /mesh/sessions` 里），不接受路径；`archive` 与 `inject` 支持标题寻址，`delete` 目前只认完整 id。

细节与约定见 [docs/local-sessions.md](https://github.com/kaniol-lck/dsh-mesh/blob/main/docs/local-sessions.md)；端点验收：`node test/waker-endpoints.test.js`。

## 依赖

中枢本体见 [hub/](https://github.com/kaniol-lck/dsh-mesh/tree/main/hub)，Docker 一条命令即可起：

```bash
cd hub && cp .env.example .env && docker compose up -d --build
```

## 许可

MIT

## 跨机消息绑定（`/mesh/bind`）

这条路径**只服务跨机来件**：hub 把消息 ping 给 waker，若该 `conversation` 有 `deliverTo`，waker 直接把 wake prompt 投进那个会话（默认 `mode: 'queue'`，像用户打字一样排队），而不是另起/复用「Mesh 收件箱」会话。

> **本机会话之间不要用这套。** 同机派活走 `/mesh/inject`（命令行：`node scripts/mesh-dispatch.mjs --title "mesh · hub" --file .worklog/dispatch/hub.txt`，叫协调会话加 `--wake`）——毫秒级、离线可用，不必让消息绕中枢一圈。

### `POST /mesh/bind`

```json
{ "conversation": "conv/wake-verify", "sessionId": "session-…", "deliver": true, "backfill": 12 }
```

| 字段 | 说明 |
|---|---|
| `conversation` | 必填，≤120 字节，与对方 `mesh_send` 用的 conversation 一致 |
| `sessionId` | 必填，本机会话 id（`GET /mesh/sessions`） |
| `deliver` | 默认 `true`；`false` 只做面板展示绑定（写 `panelSessionId`），不投递 |
| `backfill` | 可选，绑定时把该 conversation 最近 N 条补投进会话（默认 12，仅 `deliver:true` 时生效） |

响应：`{ "ok": true, "conversation": "conv/wake-verify", "sessionId": "session-…", "deliverTo": "session-…", "backfilled": 0 }`

投递失败（会话已删除/归档、prompt 被拒）会**自动清掉 `deliverTo`** 并回退到「Mesh 收件箱」会话，邮件不会丢；此时 `POST /mesh/admin/bindings` 里该条的 `deliverTo` 会变成 `null`，这是排查的第一现场。

### `GET /mesh/admin/bindings`

```json
{
  "ok": true,
  "self": "dsh-kaniol-pc",
  "bindings": [
    { "conversation": "conv/wake-verify", "panelSessionId": "session-…", "deliverTo": "session-…", "wakes": 1, "title": "mesh · conv/wake-verify" }
  ]
}
```

只列 `panelSessionId` 或 `deliverTo` 非空的 conversation；`wakes` 是该 conversation 的累计投递次数（每次成功投进绑定会话 +1）。

### `POST /mesh/admin/unbind`

```json
{ "conversation": "conv/wake-verify", "keepDisplaying": false }
```

清掉绑定；`keepDisplaying: true` 只清 `deliverTo`、保留面板展示绑定，默认两个都清。响应 `{ "ok": true, "conversation": "conv/wake-verify", "entry": { … } }`。

以上管理端点都**只接受 loopback**；绑定的读写落在 token 同目录的 `conversations.json`，重启后保留。

### 端到端自检

1. `POST /mesh/sessions/create` 建一个临时会话（`cwd` 指向具体仓库根）；
2. `POST /mesh/bind` 把 `conv/x` 绑到它；
3. 从**另一台机器或另一身份**发：`mesh_send({ to: "<本机>", conversation: "conv/x", body: "…" })`；
4. 判据：`GET /mesh/admin/bindings` 中该条 `wakes` +1，临时会话 `last_active` 前进，且会话日志里出现带消息正文的 wake prompt；
5. 清理：`POST /mesh/admin/unbind` → 归档/删除临时会话 → `/mesh/admin/bindings` 无残留。

**常见「投了但没落到绑定会话」**：正文 <24 字且是 ack 词（`收到`/`ok`/`ping`…）被 trivial 拦；同一 conversation 60 秒内的重复 ping 被 cooldown 吃掉；waker 正忙（`busy`）或该 conversation 触顶（默认 30 次/小时）。命中时会写进 waker 日志与 `/mesh/status` 的 `throttled`。

## 与中枢控制台的分工

设置 → Mesh 只管理**本机**：唤醒（trust / 投递方式 / 启动补收）、收件箱与历史缓存、会话绑定、本机会话（`/mesh/sessions` 系列）。它不代理任何中枢管理请求。

管理动作留在中枢自带控制台 `hubUrl/console`：发注册码、批准新节点、轮换/吊销令牌、改 scopes、看审计。面板里只有一行只读的「中枢控制台 → 打开」：`/mesh/status` 的 `hubConsoleUrl` 由 `hubUrl` 去尾斜杠后拼 `/console` 得到，按钮就是 `window.open(hubConsoleUrl, '_blank', 'noopener,noreferrer')`；没有 `hubUrl` 时该字段为 `null`，整行不渲染。

**为什么不把 admin token 放进插件**：

1. admin token 是**全权**——能轮换/吊销任何 agent、改 scopes、发注册码，泄漏一次等于中枢失守；
2. 面板走 loopback 且**无鉴权**，同机任何进程都能读它的状态接口，把 admin token 塞进来等于把全权面交给本机所有程序；
3. 插件的 `cordis.patch.yml` 是**明文落盘**（还有各种 `.bak`），写进去就长期存在，也容易随备份、截图或排障日志外流。

管理动作一律在控制台完成，它自己有登录会话与 CSRF 校验；插件这边只保留只读跳转。


