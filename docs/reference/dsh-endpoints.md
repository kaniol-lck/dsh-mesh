<!-- drift: waker=* hub=* owner=docs -->
# DSH 当前可用端点清单（waker 本机 + DSH 宿主）

> 2026-11-14 · `mesh · L1 参考资料与评估`（T-474）· 只读核对，不改实现。
> 用途：回答「我们要调一个端点（尤其**会话改名**）时，到底有什么可用」。
> 计数口径：**waker 55 个端点**（51 个 `if` 分支 + 4 个共用分支的第二个动词）· **DSH Session Remote 26 个方法** · **DSH HTTP 具名路由：无公开清单，宿主自身只暴露 `/` 与 `/api`**。

## 结论

| 问题 | 结论 |
|---|---|
| waker 有 `/mesh/sessions/rename` 吗 | **没有**。51 个 `/mesh/*` 分支里没有 rename；实测 `GET /mesh/sessions/rename` → **404 `{"error":"not found"}`** |
| DSH 有「改名」能力吗 | **有**，但是 **Cordis/Typert Remote 方法 `session/rename`**（入参 `{sessionId,title}`，返回 `{title,seq}`），走宿主的 **`/api`** 端点，**不是 REST 路径** |
| 能直接用 curl 改名吗 | **不能**。`/api` 需要认证（实测未带凭据 → **401 `unauthorized`**），且是 WebSocket + 流式帧协议，不是「POST 一个 JSON 就完事」 |
| 最小可行路径 | 给 waker 加一条 loopback 路由 `/mesh/sessions/rename`，内部调 `ctx.sessionController.rename()`——与 `/mesh/sessions/archive` 同级；**不要**改 projcache 文件 |

## 一、取证方式与环境

| 项 | 值 |
|---|---|
| DSH 版本 | `@deepseek-ai/dsh` **0.2.2-rc.3**（`<DSH 安装目录>/package.json`） |
| 形态 | Desktop 打包（`profile=desktop`），代码在 `app.asar` 内 |
| asar 读取 | 普通 `node`/`rg`/`ls` **读不到 asar**；用 `ELECTRON_RUN_AS_NODE=1 <DSH 可执行文件> <script.mjs>`（Electron 自带 asar 感知文件系统），逐个目录列 + 单文件读，**未解包** |
| waker 实例 | `127.0.0.1:8795`，实测在线（357 个会话可见） |
| DSH Web | `127.0.0.1:14832`，实测 `/` 与 `/api` 均 **401** |
| 时间 | 2026-11-14 19:0x |

## 二、waker 本机端点（`plugins/mesh-waker/index.js`）

鉴权口径：`loopback` = 仅本机回环（`fromLoopback(req)`，非回环 403）；`ownerToken` = 另需 owner 令牌（`isOwnerTokenValid`）。

### 2.1 会话

| method | path | 用途 | 入参 | 鉴权 | 来源 | 实测 |
|---|---|---|---|---|---|---|
| GET | `/mesh/sessions` | 列本机会话（含 `archived`/`live`/`titleSource`/`titleStale`） | query `live,limit,offset,archived,cwd,q` | loopback | `index.js:6215` | ✅ 200，`{ok,total:357,…}` |
| POST | `/mesh/sessions/create` | 建本地会话（create + rename + 可选 prompt） | body `title,workspacePath,cwd,workspaceTitle,prompt,mode` | loopback | `index.js:7346` | |
| POST | `/mesh/sessions/archive` | 归档会话（不删数据） | body `session`/`title` | loopback | `index.js:6923` | |
| POST | `/mesh/sessions/delete` | 删除会话（寻址同 `/mesh/inject`） | body `session`/`title` | loopback | `index.js:6831` | |
| GET | `/mesh/session/identity` | 「我是谁的 primary 路由」权威答案 | query `session` | loopback | `index.js:6946` | |
| POST | `/mesh/inject` | 向会话投递提示词 | body `text,mode,meta,requester,subject,thread,routedTo,session,title,callerSession,origin,workspace` | loopback | `index.js:7420` | |
| POST | `/mesh/cancel` | 停掉某任务/会话当前回合（不删会话） | body `task,session,reason` | loopback | `index.js:7313` | |

### 2.2 任务与批次

| method | path | 用途 | 入参 | 鉴权 | 来源 |
|---|---|---|---|---|---|
| GET | `/mesh/tasks` | 列任务（按 taskId 取末行语义） | query `status,session,batch,limit,offset,include` | loopback | `index.js:6680` |
| GET | `/mesh/tasks/:id` | 单任务详情 | path id | loopback | `index.js:6748` |
| DELETE | `/mesh/tasks/:id` | 取消**未结算**任务（已结算历史不可变） | path id | loopback | `index.js:6748` |
| POST | `/mesh/tasks/ack` | 签收（只落板，不产生回执、不注入） | body `ids,by,force` | loopback | `index.js:6717` |
| POST | `/mesh/tasks/complete` | 脚本结算任务（同 `mesh_complete`） | body `taskId,status,summary,detail` 等 | loopback | `index.js:6599` |
| POST | `/mesh/tasks/hub-ref` | 记录跨机任务引用行（只存引用，不存正文） | body `taskId,textRef,targetAgent,originWs,textBytes,subject,expect,requester,thread,batchId` | loopback | `index.js:6527` |
| GET | `/mesh/batches` | 列批次 | — | loopback | `index.js:6797` |
| GET | `/mesh/batches/:id` | 单批次详情 | path id | loopback | `index.js:6807` |
| DELETE | `/mesh/batches/:id` | 取消整批 | path id | loopback | `index.js:6807` |

### 2.3 工作区 / 路由位 / 锁

| method | path | 用途 | 入参 | 鉴权 | 来源 |
|---|---|---|---|---|---|
| GET | `/mesh/workspaces` | 只读注册表（谁在本机、哪个工作区拥有哪个 cwd） | — | loopback | `index.js:6302` |
| POST | `/mesh/workspaces/reload` | 显式重载注册表 + 失败元数据 | — | loopback | `index.js:6577` |
| POST | `/mesh/workspaces/workers` | 写一个角色 worker 绑定 | body `slug,cwd,role,sessionId,scopes` | loopback | `index.js:6388` |
| POST | `/mesh/coordinator/claim` | 认领 primary 路由位 | body `session,slug,ownerToken,channel` | loopback + ownerToken | `index.js:7021` |
| POST | `/mesh/coordinator/approve` | 批准他人的认领 | body `session,slug,by,ownerToken` | loopback + ownerToken | `index.js:7101` |
| POST | `/mesh/coordinator/reject` | 驳回认领 | 同上 | loopback + ownerToken | `index.js:7101` |
| POST | `/mesh/coordinator/release` | 释放路由位（释放自己免令牌，释放他人要令牌） | body `session,slug,ownerToken` | loopback + ownerToken | `index.js:7177` |
| POST | `/mesh/coordinator/heartbeat` | 续租 | body `session,slug` | loopback | `index.js:7222` |
| GET | `/mesh/workspace/lock` | 读某个工作区的建议性锁（空闲为 `null`） | query `workspace` | loopback | `index.js:7254` |
| POST | `/mesh/workspace/lock` | 取锁（`ttlMs`，默认 10 分钟） | body `sessionId,workspace,ownerLabel,reason,ttlMs` | loopback | `index.js:7273` |
| POST | `/mesh/workspace/unlock` | 释放锁 | body `sessionId,workspace` | loopback | `index.js:7273` |

### 2.4 消息 / 历史 / 线程 / 信任

| method | path | 用途 | 入参 | 鉴权 | 来源 |
|---|---|---|---|---|---|
| GET | `/mesh/threads` | 列线程绑定 | — | loopback | `index.js:6630` |
| POST | `/mesh/threads/subscribe` | 订阅线程 | body `sessionId,thread` | loopback | `index.js:6644` |
| POST | `/mesh/threads/release` | 释放线程 | 同上 | loopback | `index.js:6644` |
| GET | `/mesh/history/conversations` | 会话历史目录 | — | loopback | `index.js:7764` |
| GET | `/mesh/history/thread` | 追一条对话（先拉中枢副本） | query `conversation,live` | loopback | `index.js:7774` |
| POST | `/mesh/history/sync` | 同步历史到中枢 | — | loopback | `index.js:7807` |
| POST | `/mesh/history/pin` | 置顶消息 | body `id,pinned` | loopback | `index.js:7817` |
| POST | `/mesh/history/read` | 标记已读 | body `ids` | loopback | `index.js:7832` |
| POST | `/mesh/send` | 经中枢发消息给另一个 agent | body `to,body,subject,conversation,important` | loopback | `index.js:7921` |
| POST | `/mesh/bind` | 把对话绑定到本机会话（可直接投递 + 回填） | body `conversation,sessionId,deliver,backfill` | loopback | `index.js:7963` |
| GET | `/mesh/peers` | 列在线 peer | — | loopback | `index.js:7847` |
| POST | `/mesh/trust` | 设对端信任档 | body `peer,level` | loopback | `index.js:7886` |

### 2.5 诊断 / 维护 / 中枢转发

| method | path | 用途 | 入参 | 鉴权 | 来源 |
|---|---|---|---|---|---|
| GET | `/mesh/status` | 运行态（版本、代码指纹、pull 模式、`stale`） | query `refresh=1` | **无**（刻意：不含秘密，带 `access-control-allow-origin: *`） | `index.js:7549` |
| GET | `/mesh/logs` | 分层日志只读合并视图 | query `day,scope,tail` | loopback | `index.js:6244` |
| GET | `/mesh/dirs` | 列目录（设置页选路径） | query `path` | loopback | `index.js:7695` |
| GET | `/mesh/pick-dir` | 打开本机目录选择框 | — | loopback | `index.js:7869` |
| POST | `/mesh/config` | 写插件配置补丁 | body = 任意 config patch | loopback | `index.js:7710` |
| POST | `/mesh/ui-state` | 浏览器半边上报右栏 tab 状态 | body `rightTab` | loopback | `index.js:7735` |
| POST | `/mesh/hub/blob` | 把一段文本作为 blob 传到中枢 | query `name`；body 原文 | loopback | `index.js:6452` |
| POST | `/mesh/hub/tasks` | 把任务转发到中枢 | body = 中枢任务 draft | loopback | `index.js:6493` |
| GET | `/mesh/admin/bindings` | 列绑定（维护） | — | loopback（父分支 `index.js:8014` 统一校验） | `index.js:8032` |
| POST | `/mesh/admin/unbind` | 解绑 | body `conversation,keepDisplaying` | 同上 | `index.js:8045` |
| GET | `/mesh/admin/cache` | 缓存状态 | — | 同上 | `index.js:8062` |
| POST | `/mesh/admin/cache/clear` | 清缓存 | — | 同上 | `index.js:8072` |
| GET | `/mesh/admin/throttle` | 限流状态 | — | 同上 | `index.js:8085` |
| POST | `/mesh/admin/throttle/raise` | 只放行最新一条被拦消息 | body `conversation,cap` | 同上 | `index.js:8096` |
| POST | `/mesh/admin/throttle/dismiss` | 丢弃被拦消息 | body `conversation` | 同上 | `index.js:8126` |
| POST | `/mesh/admin/token/rotate` | 轮换本机 agent token（需磁盘上的 admin token） | body `{name?}` | 同上 + 需 `admin-token` 文件 | `index.js:8147` |

**waker 端点的两个结构性事实**：①除 `/mesh/status` 外全部要求 loopback，非回环一律 403 `{"error":"loopback only"}`；②未知 path 一律 404 `{"error":"not found"}`（实测 `/mesh/sessions/rename` 即此）。

## 三、DSH 宿主端点

### 3.1 HTTP 面

| 端点 | 状态 | 说明 |
|---|---|---|
| `GET /` | 401 | Web 壳；未带会话凭据时返回 `dsh web authentication required; reopen the URL printed by dsh web.` |
| `/api` | 401 | **Typert Remote 的唯一 HTTP/WebSocket 端点**；所有 Session 方法都在这里按方法名分发，不按 REST 路径 |

宿主 HTTP 由 `@deepseek-ai/dsh-host-webserver`（`node:http`/`node:https`）提供「具名路由 + upgrade + 一个 fallback」；它**本身不做认证**，由注册路由的插件（如连接层）各自实施。因此**没有一份可枚举的 `/api/xxx` 清单**：方法名是 RPC 描述符，不是路径。

### 3.2 Session Remote 方法（26 个）

来源：`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js` 的描述符表（`'session/xxx': { description, … }`）。全部经 `/api` 调用，需已认证连接；`dsh-api-remote-access` 负责「非 owner 谁能到哪个方法」。

`session/attachment` · `session/cancel` · `session/canOpenWorkspacePath` · `session/control` · `session/create` · `session/events` · `session/follow` · `session/fork` · `session/initializeDefaultModel` · `session/list` · `session/modelCatalog` · `session/observeEvent` · `session/observeProjections` · `session/observeState` · `session/openWorkspacePath` · `session/page` · `session/projections` · `session/prompt` · **`session/rename`** · `session/search` · `session/selectModel` · `session/state` · `session/updateQueue` · `session/wait` · `session/workspacePathApplications` · `skills/list`

### 3.3 其他可用面

| 面 | 形态 | 与我们的关系 |
|---|---|---|
| `ctx.sessionController.rename({sessionId,title})` | 插件内 Cordis 服务调用 | **waker 已经这么做**（建会话时设标题）；协议层 `lib/index.js:792` 与 `session/rename` 同一实现 |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | **stdio JSON-RPC**（给进程外 SDK） | 可脚本化驱动会话，但不是 HTTP，也不等价于「改名 API」 |
| `@deepseek-ai/dsh-session-title` | 标题服务：三条来源（首条用户消息 / 异步生成 / 显式 rename），最新者胜 | 「显式 rename 会**钉住**标题，自动生成停止调度」——改名不是纯展示动作 |

## 四、「会话改名」专节

**结论：DSH 有改名能力（`session/rename`，Remote 方法），waker 没有把它暴露成 HTTP 端点。**

证据链（三层互相印证）：

1. **线协议**：`dsh-api-session-controller/lib/typert.host.js:2450` 有描述符 `'session/rename': { description: 'Rename one Session after explicitly resuming it.', … }`，参数 schema = `SessionRenameRequest { sessionId, title }`，返回 `SessionRenameValue { title, seq }`（同文件 3818–3823）。
2. **服务实现**：同包 `lib/index.js:792 async rename(request)`，内部 `titles.rename(agent.session, request.title)`，失败抛 `gateway/internal`。
3. **传输**：`@deepseek-ai/dsh-api-gateway/lib/client.node.js` 里所有调用都是 `connection.rpc.call('/api', <endpoint>, {args})`，事件流端点是 `$events`——即「一个 `/api` + 方法名」，不是每个方法一个 URL。
4. **实测**：`GET http://127.0.0.1:14832/` → **401**（要求 `dsh web` 打印的凭据）；`GET /api` → **401 unauthorized**；`GET http://127.0.0.1:8795/mesh/sessions/rename` → **404**（waker 无此路由）。
5. **行为侧证**：waker 的 `/mesh/sessions` 每个会话带 `titleSource: dsh|cached` 与 `titleStale`——正因为**在 DSH UI 改名不会更新 waker 的 sessions-index**（`lib/session-titles.mjs` 注释与 T-429）。本会话即为实例：`titleSource=dsh`，`titleIndex` 是旧标题。

### 可行替代与风险

| 路径 | 可行性 | 代价 / 风险 | 建议 |
|---|---|---|---|
| A. waker 新增 loopback `POST /mesh/sessions/rename`，内部 `ctx.sessionController.rename` | **最低成本**：照 `/mesh/sessions/archive` 抄一条路由（~30 行），鉴权同级 | 需改 `plugins/mesh-waker/`（归属 waker）；rename 会**钉住**标题、停止自动生成 | ✅ **推荐** |
| B. 直连 DSH `/api` 调 `session/rename` | 存在但门槛高：需认证 + WebSocket 帧协议 + 先显式 resume 冷会话 | 脚本要复刻 gateway 客户端；一旦 DSH 版本变，帧协议无兼容承诺 | 仅在需要「不经过 waker」时考虑 |
| C. 新建会话（`/mesh/sessions/create` 带 `title`）+ 归档旧的 | 现在就能用，零改动 | **session id 变化**：任务、回执、路由位、`wake-target.txt` 全部指向旧 id；历史不迁移 | 只在会话**无在飞任务**时用 |
| D. 直接改 `storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val` | **不要** | 那是宿主投影缓存的快照：宿主内存有状态，下次写入会覆盖；waker 侧还有按 mtime 的读取缓存；属于「改别人的缓存冒充真相」 | ❌ 禁止 |

### 若要落地 A，验收话

- `POST /mesh/sessions/rename {sessionId|session, title}` → 200 `{ok:true, sessionId, title}`；非 loopback → 403；空标题/超长 → 400；
- 改名后 `GET /mesh/sessions?q=<title>` 能命中，且该会话 `titleSource=dsh`（不再 `titleStale`）；
- 冷会话（已归档/未 resume）改名返回明确错误，不静默失败——`session/rename` 本身要求「显式 resume」，路由必须把这个前置条件翻译成错误信息。

## 五、未验证 / 限制

- **没有实测真正的改名调用**：需要已认证的 `/api` 连接（`dsh web` 打印的凭据），本单是只读核对，未建立认证连接；因此「改名成功」只有源码与协议描述符证据，没有端到端实测。
- **未枚举宿主全部具名路由**：`dsh-host-webserver` 只提供注册机制，路由由各插件在启动时注册；要拿全量清单需运行时挂 `cordis_inspect`（本会话无该工具）或读每个插件源码。本文件给出的是「可读到的」两层：waker 全量 + DSH 自身 `/`、`/api`。
- **版本敏感**：以上行号与描述符属于 **0.2.2-rc.3**；升级后需重跑本文件的取证脚本（`.worklog/dispatch/tmp-*.mjs`，一次性产物）。

## 六、证据

| 结论 | 命令 / 文件 |
|---|---|
| waker 路由数 = 55 | `node .worklog/dispatch/tmp-extract-routes.mjs` → `routeLines=51`（+4 个共用分支第二动词） |
| 无 rename 路由 | 同上输出无 `/mesh/sessions/rename`；`GET :8795/mesh/sessions/rename` → 404 |
| waker 在线 | `GET :8795/mesh/sessions?limit=1` → 200，`total=357` |
| DSH 版本 | `<DSH 安装目录>/package.json` → `0.2.2-rc.3` |
| `session/rename` 存在 | `dsh-api-session-controller/lib/typert.host.js:2450`；`lib/index.js:792` |
| 26 个 Remote 方法 | `node .worklog/dispatch/tmp-dsh-remotes.mjs` → `descriptorCount=26` |
| `/api` 需认证 | `GET :14832/api` → 401 `unauthorized`；`GET :14832/` → 401 |
| asar 不可被普通工具读 | `rg` 读 asar 内文件 → `os error 3`；改用 `ELECTRON_RUN_AS_NODE=1` 脚本成功 |
| 改名的行为副作用 | `dsh-session-title/src/types.ts:36`「Explicit user rename: pins the title — automatic generation stops scheduling.」 |
