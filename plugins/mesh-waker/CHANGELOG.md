# 变更记录

本文件记录 `dsh-mesh-waker` 的变更。格式仿 `hub/CHANGES.md`：每节写清改了什么、怎么复验。

> **发版状态**：`0.4.56`–`0.5.0` 目前只在本仓，尚未发布到 npm（`latest` 仍是 0.4.41，
> `next` 是 0.4.55）；0.4.60 与 0.5.0 的发布仍需 owner 确认，`npm publish` 由协调会话执行。

复验方式：`node test/dynamic-id.test.js`（客户端 id 解析）、`node test/waker-endpoints.test.js`（本机会话端点 + 0.5.0 激活矩阵）。

---

## v0.5.0（2026-10-29，pull 默认 + 自举接入 + standalone）

| 项 | 内容 |
|---|---|
| pull 默认 | 新增 pull 循环：`GET /api/inbox?unread=1&order=desc&limit=20&claim=1&claim_ttl_ms=…` → 按 conversation 分组 → **复用现有唤醒路径**（冷却、去重、`mark_read`）→ 间隔自适应（有信 `pollBusyIntervalMs` / 连续 3 次空 `pollIdleIntervalMs` / 其余 `pollIntervalMs`），失败按 `5s × 2^n` 退避、上限 5 分钟；push 与 pull 并存时共用同一套去重，不重复开 turn |
| 自举接入 | `hubUrl` + `joinCode` 且无 token 时：`GET /api/bootstrap`（含可选 CA）→ `POST /api/enroll {code,name,host}` → token 写 `tokenFile`（0600）→ 继续启动；没配 `tokenFile` 直接报错要求配置 |
| standalone | 无 `hubUrl` 只监听本机（默认 `127.0.0.1`），`/mesh/status.mode="standalone"`，**不发任何网络请求**；有 `hubUrl` 但 token 与 joinCode 都缺时同样降级，`lastError` 写明 `missing token (provide joinCode or tokenFile)`，不静默退出 |
| CA 信任 | `caFile` 走 `tls.setDefaultCACertificates`（不依赖 `NODE_EXTRA_CA_CERTS`）；bootstrap 返回 `tls.ca_pem` 且未配 `caFile` 时自动采用（仅内存）；`caSha256` 指纹钉扎，不符即拒绝联网；日志只记 sha256 前 16 位 |
| 状态与面板 | `/mesh/status` 增 `mode`、`lastPullAt`、`pollIntervalMs`、`nextPollIn`、`caFingerprint`、`hubConnected`；面板状态区显示「同步方式」「上次拉取」，standalone 时提示填 `hubUrl` + `joinCode` |
| wakeSecret | 从「必需」降为**仅 push 需要**；pull 模式缺它不报错、不阻塞 |
| 验证 | `node test/waker-endpoints.test.js` 11/11（含 standalone 零网络请求、缺凭据 lastError、`caSha256` 不匹配、joinCode 自举 + pull 真拉信、间隔自适应）；手工 bootstrap 实测：token 落盘且与签发值一致，日志只有 `fp=tok-ma… len=24`，未出现完整 token |

## v0.4.60（2026-10-29，设置面板「打开中枢控制台」）

| 项 | 内容 |
|---|---|
| 新增 | 设置 → Mesh 在「中枢登记」下多一行「中枢控制台 → 打开」，只做跳转：`window.open(hubConsoleUrl, '_blank', 'noopener,noreferrer')`；`/mesh/status` 新增只读字段 `hubConsoleUrl`（由 `hubUrl` 去尾斜杠拼 `/console` 派生，未配置 `hubUrl` 时为 `null`，此时整行不渲染） |
| 不引入 | 不改 `editable()` 白名单、不新增任何端点、不碰 token / wakeSecret 的暴露方式：admin token 是全权凭据，面板走 loopback 且无鉴权，cordis patch 明文落盘，管理动作留在中枢控制台（会话鉴权 + CSRF） |
| 验证 | `node test/waker-endpoints.test.js` 全过；面板可见性自测：`hubConsoleUrl=null` 时无该行，有值时按钮的 `window.open` 参数为 `[url, '_blank', 'noopener,noreferrer']` |

## v0.4.59（2026-10-28，会话删除、archived 标记、cwd 指引）

| 项 | 内容 |
|---|---|
| 新增 | `POST /mesh/sessions/delete { session }`：删除本机会话——先停掉在跑的 agent、摘掉 `conversations.json` 里指向它的绑定，再删会话目录；停不下来的返回 409（本轮修复随本批未发布版本一起交付） |
| 会话列表 | `GET /mesh/sessions` 每条新增 `archived` 字段（来自 `workspaceRegistry.archivedSessionIds`，旧宿主降级为恒 `false`） |
| 文档 | `docs/local-sessions.md` 增加「cwd 必须指向具体仓库根」的说明（两个仓并存时见过踩坑） |
| 验证 | 删除后 `GET /mesh/sessions` 不再列出该 id；`node test/waker-endpoints.test.js` 的 delete 用例覆盖失败路径与绑定清理 |

## v0.4.58（2026-10-28，created 会话绑定工作区；新增归档）

| 项 | 内容 |
|---|---|
| 修复 | `POST /mesh/sessions/create` 生成的会话原先没有 workspaceId，侧栏（按工作区分组）看不到；现在先 `resolveByPath`、找不到再 `create`，并把 workspaceId 交给 `sessionController.create` |
| 新增 | `POST /mesh/sessions/archive { session }`：归档会话（文件保留、侧栏隐藏）；存活会话由宿主拒绝 |
| 验证 | 创建后侧栏出现在对应工作区；归档后列表 `archived=true` 且不再出现在侧栏 |

## v0.4.57（2026-10-28，协调会话可创建执行会话）

| 项 | 内容 |
|---|---|
| 新增 | `POST /mesh/sessions/create { title, cwd?, prompt?, mode? }`：新建会话 → rename → 可选首轮 prompt（`queue` / `steer`）；返回 `sessionId` / `title` / `workspaceId` / `workspacePath` / `prompted` |
| 验证 | 空 `prompt` 返回 201 且 `GET /mesh/sessions` 立即可见；带 `prompt` 时目标会话真的跑一轮 |

## v0.4.56（2026-10-28，本机会话列表与进程内注入）

| 项 | 内容 |
|---|---|
| 新增 | `GET /mesh/sessions`：枚举 `~/.dsh/sessions/<workspace>/<session-id>/`，标题从会话日志的 zstd 帧恢复并缓存在 `sessions-index.json`；返回 `id` / `title` / `cwd` / `workspace` / `last_active` / `live` |
| 新增 | `POST /mesh/inject { session\|title, text, mode? }`：向已加载或冷会话投一轮任务（`queue` 等回合结束 / `steer` 打断），冷会话自动 `agents.resume` |
| 安全 | 两个端点都只接受 loopback（`fromLoopback`）；正文上限 `MAX_BODY` |
| 验证 | `curl /mesh/sessions` 列出现有会话；按标题注入进入目标会话；同名标题返回 400 且不投递；`node test/waker-endpoints.test.js` |
