# 变更记录

本文件记录 `dsh-mesh-waker` 的变更。格式仿 `hub/CHANGES.md`：每节写清改了什么、怎么复验。

> **发版状态**：最新发布为 `0.5.6`（`npm dist-tags` 的 `latest` 与 `next` 均指向它，tag 与 GitHub Release 已建）。
> `0.5.5` 未单独发布（版本号跳过）；后续发版由维护者通过 `scripts/release.py` 执行（先 `next`，验证后 `--promote`）。

复验方式：`node test/dynamic-id.test.js`（客户端 id 解析）、`node test/waker-endpoints.test.js`（本机会话端点 + 激活矩阵 + 回执 + 批次/liveness + 真实事件信封 + 标题解析 + `mesh_dispatch`/CLI 参数 + 结算基线 + 主题路由）。

---

## v0.5.8（2026-10-30，拒绝的主题投递不得消费消息；拒绝日志收敛）

| 项 | 内容 |
|---|---|
| 缺陷 | 真机 `ops/selftest-guarded`（`allowFrom` 外发送方）投递被拒后，消息 `read_at` 仍被写上（约 10s 后），运营者无法在收件箱审计「谁试图投递、投了什么」 |
| 定位 | waker 日志：`10:22:25.606 topic denied …` → `10:22:25.607 woke conversation … in 133ms`，期间**没有** `marked N message(s) read`；`read_at` 出现在 10s+ 后、同一批正常投递回合结束附近（该回合的 agent 侧 `mesh_inbox(mark_read)` 会清空整个未读收件箱）。waker 的拒绝分支原本就在任何 markRead 之前 return，本次把它写成**硬约束**并消除相邻触发面 |
| 修法 | ① 拒绝路径显式约定：不 claim、不 read、不注入、不建会话，消息保持 `read_at=null`（注释固化意图）；② 投递提示加强：内联消息时明确「无需调用 mesh_inbox，也不要把收件箱里其它消息标记为已读（不是本轮任务）」，减少 agent 顺手清箱；③ 拒绝日志收敛：按 `(label|sender|message id)` 去重，新消息立即记一条，重复拒绝累计，每 50 次才补一条 `suppressed` |
| 测试 | 共 49/49：拒绝用例改为跨**两次轮询**断言 `prompts=0 unread=1 read_at=null(true) deniedLines=1`（即无 `/api/read`、消息未消费、日志只一条）；新增「重复 label 只保留第一个定义」用例。原有 48 例全绿 |

## v0.5.7（2026-10-30，主题路由：远程按标签投递，不暴露会话 id/标题）

| 项 | 内容 |
|---|---|
| 为什么 | 远程需要把运维问题投到「对应本地会话」，但会话 id 是内部句柄且易失，运维会话能执行 shell——把 id 上报中枢等于开放提权面。改为上报/寻址**稳定标签** |
| 配置 | `topics: [{ label, titlePattern, allowFrom?, mode? }]`；`label` 须匹配 `^[a-z0-9][a-z0-9/_-]{1,40}$`（非法/重复/空 pattern 启动 WARN 并忽略）；远端把 `conversation` 写成 `label` 即可 |
| 绑定 | 启动时与每次投递前，按 `titlePattern`（精确或唯一子串）在**未归档**会话里解析并等价 `/mesh/bind` 自动绑定；绑定的会话归档/删除后，下次投递自动重绑到新同名会话；解析不到只记 `topic unresolved`，落回原有收件箱/新建兜底 |
| 白名单 | `allowFrom` 非空时只允许名单 peer；其他人投递不注入、消息保持未读，日志 `topic denied label=… peer=…`；不覆盖仍存活的用户手工绑定 |
| 对外 | `GET /mesh/status` 增 `topics: [{ label, bound, lastDeliveredAt }]`，**不含 session id 与标题**（本地细节仍在 `/mesh/admin/bindings`） |
| 兼容 | 不配 `topics` 时行为与 0.5.6 完全一致；`mode: steer` 可插当前轮，默认 queue |
| 测试 | +5（共 48/48）：标签命中 A（B 不受影响）、归档后重绑到同名新会话（id 不同）、allowFrom 外 sender 被拒且消息仍未读、非法 label 启动忽略、status 输出不含 `session-`/标题；零配置回归即原 43 例 |

## v0.5.6（2026-10-30，修复「注入发生在回合进行中时被上一轮 turn/end 提前结算」）

| 项 | 内容 |
|---|---|
| 事故 | 真机 17:15:05 把 T-130 注给正在跑 turn 36 的会话；17:15:59 turn 36 结束，插件就给 T-130 写了 `status=completed`，summary 是上一单 T-129 的内容，T-130 一行没做（`scripts/roadmap.gates.json` 不存在） |
| 根因 | `baselineTurn = maxTurnFor()` 取的是「已开始的最大 turn」，正在跑的回合也在内；结算条件用 `turn < baselineTurn`，于是 `36 < 36 === false` → 同一轮 turn/end 直接结算 |
| 修法 | ① 注入时看 liveness 的 `openTurn`：进行中 → `baselineTurn = openTurn` 且 `injectedDuringTurn=true`；空闲 → 沿用 `maxTurnFor`，`injectedDuringTurn=false`。② 结算改严格：`queue` 仅 `turn > baselineTurn`；`steer`（插进当前轮）`turn >= baselineTurn`；`baselineTurn === null` 保持任意 `turn/end` 可结算。③ 回执新增诊断字段 `baselineTurn / settledTurn / injectedDuringTurn`（不打印正文） |
| 测试 | 新增 3 例（真实信封 `{type,data}`，共 43/43）：**回归**——`turn/start{turn:5}` → queue 注入 → `turn/end{turn:5}` 不产生回执（`premature=0`）→ `turn/start{6}`+`turn/end{6}` 才结算且 `turn=6/baselineTurn=5/injectedDuringTurn=true`；steer 同轮结算（`turn=5`）；无回合历史仍第一次 `turn/end` 即结算（`baselineTurn=null`） |
| 版本 | 0.5.6；README 回执字段与说明同步；未 publish、未部署 |

## v0.5.5（2026-10-30，派活能力进插件：`mesh_dispatch` 工具 + `dsh-mesh-dispatch` CLI）

| 项 | 内容 |
|---|---|
| 为什么 | 以前派活靠本仓 `dsh-mesh-dispatch`，别的项目装了 waker 也没有这个能力；现在工具与 CLI 都随 npm 包发布 |
| 工具 | `mesh_dispatch`（`ctx.tools.register` + `@deepseek-ai/dsh-tools` 的 `defineTool`）：`target`/`text` 必填，`createIfMissing` 解析不到时按 target 当标题新建会话再投，`mode` queue/steer，可选 `taskId`（缺省 `T-<base36>`）、`batchId`（barrier）、`receipt`、`deadline`（`30m`/`2h`/`600s`）。返回 `{ok, sessionId, title, taskId, batchId, mode, created}`；描述写明「投递后不要轮询，回合结束写回执；要全部完成再叫就用 batchId」 |
| 兼容 | `@deepseek-ai/dsh-tools` 是可选 peer；链接安装解析不到时用同一份 JSON Schema 定义注册，插件不因 import 失败而挂掉 |
| CLI | `bin/dispatch.mjs` → `dsh-mesh-dispatch`（`bin` 已进 `files`）：零外部依赖（Node 内置 fetch），`--target/--text|--file/--mode/--task [id]/--batch [id]/--receipt/--deadline/--create/--json/--waker`；成功打印 `sent session=… task=… batch=…`，`--json` 结构化；连不上默认 8795 → 退出码 2；未知参数 → 退出码 1 + 用法 |
| 测试 | `node test/waker-endpoints.test.js` 新增 5 例：工具元数据（必填 target/text、描述含 batchId）、`createIfMissing=false` 报错含 createIfMissing、`createIfMissing=true` 调 create 后投递成功、taskId 自动 `T-` 前缀与显式透传、CLI 参数解析（`--deadline 30m`→1800000、裸 `--task` 自动生成、未知参数抛用法）；离线、不起真实 HTTP |
| 文档 | README 新增「多会话分工（任何项目可用）」：3 步示例（列会话 → 派活带 taskId → 读回执/批次）、工具与 CLI 对照表、`createIfMissing` 用途 |

## v0.5.4（2026-10-30，标题解析优先活跃会话；`/mesh/sessions?live=1`）

| 项 | 内容 |
|---|---|
| 修复 | 标题匹配歧义：`resolveLocalSession` 的标题匹配把**已归档**同名会话也算进候选，导致 `receiptTo` 永久歧义、聚合回执只能落文件。现在标题（精确与唯一子串）先只在**未归档**会话里找：恰好 1 个即命中；多个仍报错列候选；未归档 0 个但归档里唯一 1 个时允许退回 |
| 提示 | 歧义与找不到的报错文案补「可用 `GET /mesh/sessions` 查看 `archived` 字段，或直接配置 session id」 |
| 新增 | `GET /mesh/sessions?live=1` 只返回未归档会话（面板/脚本便捷过滤），默认行为不变 |
| 验证 | `node --check` exit 0；`node test/waker-endpoints.test.js` 35/35（新增 4 例：活跃 + 多个同名归档 → 命中活跃；全部归档且唯一 → 仍命中；两个活跃同名 → 400 且带 archived 提示；`?live=1` 只留未归档） |

## v0.5.3（2026-10-29，修复 session/event 信封层级）

| 项 | 内容 |
|---|---|
| 修复 | DSH 的 `ctx.on('session/event', (session, event))` 传来的是信封 `{ type, seq, time, data }`，`turn` / `reason` / `message` / `callId` / `jobId` / `approval` 全在 `event.data` 下。0.5.2 直接读 `event.*`，导致真机上回执 `turn:null`、`summary:""`，且 `waiting-tool` / `waiting-job` / `waiting-approval` 三态永远不触发 |
| 修法 | `handleSessionEvent` 顶部统一取 `const d = event.data ?? event`（真实信封优先，保留扁平对象兼容），所有字段改从 `d` 读取；`event.type` 仍取顶层 |
| 测试 | 新增 5 例真实信封形态：`turn/end data → turn=1/status=completed`、`assistant/message data → summary="OK"`、`tool/call data → waiting-tool(bash)`、`approval/asked data → waiting-approval(bash)`、`job/registered data → waiting-job(job-9)`；连同原有 26 例共 31/31 |
| 验证 | `node --check` 两文件 exit 0；`node test/waker-endpoints.test.js` 31/31；真机批次待本机进程重启到 0.5.3 后复验（安装目录同步需手动执行） |

## v0.5.2（2026-10-29，批次屏障 + 事件驱动 liveness）

| 项 | 内容 |
|---|---|
| 批次屏障 | `/mesh/inject` 的 `meta` 增 `batchId` / `deadlineMs`（响应回显 `batchId`）；`dsh-mesh-dispatch` 增 `--batch [id]`（缺省 `B-<base36>`，同 id 复用）与 `--deadline 2h\|90m\|600s`；全部任务结算 → **一条**聚合回执（文本 + JSONL `{kind:"batch",…, done, total}`），deadline 到点仍有关键未结 → 部分完成聚合，未结项带 liveness；批次内单任务只写自己的 JSONL、不 queue/wake；完成判定有 300ms grace，允许连续派发的下一单加入 |
| liveness | 每会话账本（openTurn / lastEventAt / openCalls / openJobs / openApprovals / lastLlmAt），事件面覆盖 `turn/start|end`、`step/*`、`assistant/message`、`tool/call|result`、`job/registered|settled`、`approval/asked|decided`、`llm/retry*`、`agent/error`；`deriveLivenessState` 纯函数按 `not-started → lost → waiting-approval → waiting-job → waiting-tool → stalled → idle → working` 判定 |
| 卡住先报 | 批次内任务处于 stalled / waiting-approval / waiting-job 且超过 `waitLongMs` → 发一次 `[BATCH-ALERT]`（同批次+任务+状态只发一次），不结算，继续等 `turn/end` 或 deadline |
| 持久化与端点 | 批次写入 `batchFile`（0600，启动恢复、>24h 清理；恢复时 open 任务按 `lost` 结算）；`GET /mesh/batches`、`GET /mesh/batches/<id>`（含逐任务 liveness）、`DELETE /mesh/batches/<id>`（取消且不再回执） |
| 配置 | `stallQuietMs` 300000 / `waitLongMs` 1800000 / `batchDeadlineMs` 7200000 / `barrierMode` wake / `alertMode` queue / `batchFile` `~/.dsh/mesh-waker/batches.json` |
| 状态 | `/mesh/status` 增 `pendingBatches`、`batchFile`、`barrierMode`；面板「任务回执」行追加批次数 |
| 验证 | `node test/waker-endpoints.test.js` 26/26：新增 4 例 liveness 派生（approval/job/tool/stalled）、batch 单次聚合（done=2/2、只剩一条 batch 行、批次清空）、deadline 部分完成（未结项 `not-started`）、stalled 告警只发一次且不结算、重启恢复按 `lost` 结算、`DELETE` 后无聚合；`node --check` 三文件 exit 0 |

## v0.5.1（2026-10-29，插件级任务回执）

| 项 | 内容 |
|---|---|
| meta 透传 | `/mesh/inject` 支持可选 `meta { taskId, receipt }`（不污染正文），响应回显 `taskId`；`dsh-mesh-dispatch` 新增 `--task [id]`（缺省自动 `T-<base36 时间戳>`，`--receipt` 隐含开启）与 `--receipt file\|queue\|wake`，成功输出打印 `task=<id>` |
| 结算 | 订阅 `ctx.on('session/event')`：`turn/start` 维护每个会话的最大 turn 并解除「未开工」判定，`assistant/message` 记住本 turn 最后一条文本，`turn/end` 按 `turn >= baselineTurn` 结算 pending 任务；一个 taskId 只结算一次 |
| 回执字段 | `taskId / sessionId / turn / status / reasonKind / reasonDetail / injectedAt / endedAt / durationMs / summary / receiptMode`；`status` 覆盖 `completed / aborted / blocked / error / max-tokens / interrupted / forked / not-started`；摘要按码点截断 |
| 三档去向 | `receiptMode=file`（默认，只追加 `receiptFile`）→ `queue`（再把 `[RECEIPT]` 注入 `receiptTo`）→ `wake`（再唤醒；无 `wakeSecret` 时降级 queue 并 WARN）；`receiptTo` 解析不到只写文件 + `lastError`，绝不打扰其他会话 |
| 未开工检测 | 注入后 `receiptStallMs`（默认 600000）内无 `turn/start` → `status:"not-started"` 并清理 pending；插件 dispose 时清理全部 pending 与计时器 |
| 可见性 | `/mesh/status` 增 `pendingTasks`、`lastReceipt`、`receiptMode`、`receiptFile`；面板设置区显示只读「任务回执」行（方式 + 最近一条 + 等待数） |
| 验证 | `node test/waker-endpoints.test.js` 17/17：新增 4 例（completed + 摘要截断、单次结算、error 带 `provider_error`、stall 1s → not-started）；另一轮手工实例写出 `receipts.jsonl` 且默认 file 模式未打扰任何会话 |

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

## v0.4.57（2026-10-28，可创建执行会话）

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
