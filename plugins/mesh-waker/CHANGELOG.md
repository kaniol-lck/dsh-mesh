# Changelog

本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。

> 最新发布：`0.8.0`（npm `latest`）。

## [0.9.0] - 2026-11-28

### Added

- `mesh_dispatch` 成为**唯一发放入口**并在实现内部分流（T-487）：`target` 是本机会话 → 本地注入；是已注册的远端 agent → 自动走 hub（正文上传为 blob、任务行带 `text_ref`、再落本地引用行，与 `dsh-mesh-dispatch --transport hub` 等价）；是本机自己的 agent 名 → 直接拒绝并指向本地会话。此前要把活交给"本机另一个会话"，只能在这些工具之间自行猜测，3 周内 5 次误用 `mesh_send` 打自己而被 hub 拒绝。
- 未读对账看门狗（T-486）：定期读信箱，把「未读且超过 `unreadOverdueMs`（默认 30 分钟）仍未唤醒」的消息数写进 `/mesh/status.overdueUnread`，并记 `WARN unread overdue`。此前没有任何东西能回答「信箱里有未读、却没被唤醒」；`ops-check` 的 `waker-unread` 直接读该字段判红。
- 唤醒抑制改为**延后补发**（T-486）：`busy` 时不再丢弃，改为合并记忆一次并在当前唤醒结束后重跑；入口冷却与 throttle cap 不再静默 `return`，而是按剩余时间重排一次唤醒（每 `(conversation, reason)` 只留一个定时器）。`/mesh/status` 新增 `wakeSuppressed` / `wakeDeferred` / `wakeFailed` 计数。

### Fixed

- **`sourceUpdatedAt` 定为不透明字符串，禁止数值化**（T-mwzwrgg5，契约补丁）：`team.json.updatedAt` 是**人读的日期字符串**（现为 `"2026-11-19"`），而原实现按时间戳处理——`Number("2026-11-19")` 是 `NaN`，`Number.isFinite` 再把它落成 `0`。后果是整条链在真机上无效：`rotate-session` 每次真实轮换推上来的投影都存成 `sourceUpdatedAt: 0`，仓库侧 gate 用 `String(proj.sourceUpdatedAt) !== String(team.updatedAt)` 比对，永远不等，于是**永远判「投影过期」**。根因是契约没定类型（派单示例写的是 `1795…` 那种时间戳样子），两边各自假设了不同的一种。现在类型钉死为 `String | null`：原样存、原样回，不进 `Number()`、不进 `parseInt`、不转时间戳；`null`/不传/纯空白一律存 `null`（不是 `0`、不是 `"null"`、不是 `""`）。`POST /mesh/roles` 的响应、`GET /mesh/roles`、`/mesh/status.roleProjection.sourceUpdatedAt` 三处都返回同一原值，且旧数据里的 `0` 会在下次读取时被修成 `null` 而不是继续当作 `"0"` 参与比对。
- **`since` 保持数字，与 `sourceUpdatedAt` 规则不同，这是有意的**（T-mwzwrgg5）：`since` 的契约是毫秒数字（`rotate-session` 发 `Date.parse(active.since) || 0`），round-trip 后仍是同一数字；`sourceUpdatedAt` 是不透明日期字符串，数值化会毁掉它。两者相邻但是两类值，代码与注释都写清了区别，避免下一个人「统一一下」把它们改成一样的。
- **角色投影并入 `workspaces.json`，不再新增第三份映射**（T-mwzvjvwz，owner 2026-11-28 定「方案 2」）：`team.json`（工作区级，`rotate-session` 是唯一写者）与 `workspaces.json`（机器级，waker 是唯一写者）本来就各存一份「角色 → 当前会话」，再建 `roles.json` 就是第三份，而且会让仓库脚本直写 `~/.dsh`（越权）、多工作区并发轮换时抢同一个文件。现在由 `rotate-session` **通过 loopback 通告**，waker 把映射写进它本来就拥有的工作区条目：`roleSessions`（`{role: {sessionId, since, pushedAt}}`）与 `roleProjection`（`{source, sourceUpdatedAt, pushedAt, pushedBy, unresolved}`）。写入是**在原文件上的定点补丁**：只在原始 JSON 上改这两个键，同一条目的 `cwd`/`coordinator`/`workers`/`coordinators`/`roles`/`rolesUnrecognized` 逐字节不变（用归一化器会把这些字段重写，所以没走它）。
- **新端点 `POST /mesh/roles`**（T-mwzvjvwz，loopback only）：非 loopback → 403；`workspace` 空 / `roleSessions` 非对象 / sessionId 非字符串 → 400；工作区 slug 不存在 → 409（**绝不自动建工作区**，否则拼错 slug 会留下一个被所有读者当成真的幽灵条目）；sessionId 解析不到活会话 → **仍然接受**（200）但放进 `roleProjection.unresolved` 并 `fileLog(WARN …)`，因为推送是对另一个工作区意图的陈述，丢掉就再也没有「某个角色指向了死会话」的记录。写盘失败 → 500 且日志说明，**不静默**（静默失败会让推送方以为投影已落地）。
- **新端点 `GET /mesh/roles?workspace=<slug>`**（T-mwzvjvwz，loopback only）：返回 `{ok, workspace, roleSessions, roleProjection}`，未知 slug → 404；`roleSessions`/`roleProjection` 恒为对象而非 null，消费方不必先判空再读字段。
- **投递时按角色自动接力**（T-mwzvjvwz）：`conversations[conv]` 可带 `deliverRole`（`mesh_rebind` 也接受，空串清除）。判定顺序：`deliverTo` 活着 → 投它（**现状不变**）；`deliverTo` 死了且**有角色** → 查该工作区 `roleSessions[role].sessionId`，活着就改绑并记 `conversation=<c> rebound old=<old> new=<new> by role=<r>`、`state.roleHandoffs++`；解析不到 → **park**（`reason=role-unresolved`），**绝不回落收件箱、绝不自动建会话**；都没有 → 维持原 unbound 路径。工作区判定按「会话绑定的工作区 → 本进程工作区 → 唯一声明该角色的工作区」三档，都不中就不猜。
- **`/mesh/status` 新增 `roleProjection` 与 `roleHandoffs`**（T-mwzvjvwz）：`roleProjection` 为当前工作区的 `{workspace, sourceUpdatedAt, pushedAt, roles, unresolved}`（没有投影时全 0，**字段恒在**，让「没有投影」与「字段缺失」可区分）；`roleHandoffs` 是累计接力次数，便于验收时确认它真的发生过；`lastRoleHandoff` 记最后一次改绑的 `{conversation, role, from, to, at}`。
- **修复两个在实现中被测试抓到的真缺陷**（T-mwzvjvwz）：① `normalizeWorkspaceEntry` 是白名单，`roleSessions`/`roleProjection` 不加进去就会出现「写进去、下一次读取时静默丢掉」——投影类数据最坏的失败形态，因为它看起来像已生效；② `pushedAt` 必须由落盘方按「本机何时听到」打时间戳，照抄请求会把每行留成 0，而调用方的 `since` 是「角色何时换手」的另一件事，混用会让重发的旧投影看起来像新轮换。
- **配置表补齐三行**（T-mwzvjvwz）：`unboundDeliveryMode`、`unboundAutoCreateMaxPerHour`（T-mwzfxyb7 引入但未入表）与 `restartGraceMs`（更早遗漏）。`check-config-docs` 现为 112 键全覆盖、`NOT-IN-TABLE 0`。
- **未绑定的入站对话会新建会话并绑定**（T-mwzfxyb7，owner 2026-11-28 决定，推翻 T-426 的止血）：T-426 当年禁掉自动建会话是**止血**，因为投递失败会清掉绑定 → 对话变「未绑定」→ 下一步掉进新建的收件箱会话，每次重试都炸一个（全机 19 个「mesh 收件箱」会话，12 个集中在 2026-10-22 一天）。那一步已修好（投递失败**保留绑定**、标 deferred、留未读），所以按 owner 决定恢复：`unboundDeliveryMode` 默认 `'auto-create'`，未绑定对话在收件箱工作区建**一个**会话、标题取对话名、绑定并打 `deliverToAuto={workspacePath,title,autoCreatedBy:'unbound'}`；同一对话后续消息复用该会话。防爆炸：`unboundAutoCreateMaxPerHour`（默认 6，跨越重启持久化在 `unbound-auto-create.json`），超限退回 park 并 `WARN`。**没有收件箱工作区就直接 park，不猜路径。**升级时**不重放**历史 `unbound.jsonl` 积压（那会一次性炸一批会话），重放只走显式路径。
- **新工具 `mesh_rebind`**（T-mwzfxyb7）：`mesh_rebind({conversation, to?, replay?})`。不传 `to` 绑到**调用方会话**（自动建成会话发现「这不该投我」时自行交接）；传 `to` 绑到指定会话（解析不到**明确报错**，不静默）；`replay:true` 把该对话在 `unbound.jsonl` 的积压投进新目标并出队、标已读（投递失败则**保留队列行**，不丢信）。改绑已绑定到活会话的对话**允许**（agent 可自决）但**永不静默**：`fileLog` 记 old→new 与调用方，`/mesh/status` 可见。与 `mesh_thread` 的界线写在描述里（thread=任务同一线，rebind=入站对话投递目标）。
- **`/mesh/status` 新增自动创建视图**（T-mwzfxyb7）：`unboundAutoCreated`（累计）、`unboundAutoCreatedLastHour`（近一小时，上限依据）、`lastAutoCreated{conversation,sessionId,at}`、`tools.rebind`；既有 `unboundPending` 语义不变。
- **自动创建的会话收到一句来历说明**（T-mwzfxyb7）：提示本会话由哪个 conversation 创建、以及该投别处时用 `mesh_rebind({conversation})` 改绑（一行，不写长）。
- 修掉一条既有测试泄漏（T-mwzfxyb7 发现）：`test/waker-endpoints.test.js` 打印 `402/402 passed` 后**进程不退出**（句柄转储显示 3 个 `Server` 与 1 个 socket 未关），`node --test` 因此永远等它，全量跑表现为「该文件失败」——与本次改动无关（`git stash` 掉实现后同样挂起）。全量验证改用 `--test-force-exit`；泄漏本身未修，属既有缺陷，已记入 todo。
- **回执送错人：读了一个任务行从不存在的字段**（T-mwxx12b8，owner 2026-11-27 问「虾酱工作区最近几次完工都没有回执」）：`settleRowByDeclaration()` 投递回执时读 `updated.requesterSessionId`——但 `requesterSessionId` 只存在于**内存任务对象**，磁盘任务行从来没有（实测本机 8 个 `tasks.jsonl` 共 766 行，750 行有 `requester`、**0 行**有 `requesterSessionId`）。于是它恒为 `null`：`deliverReceipt()` 跳过 digest 分支，`deliverNotice()` 的 targetId 为空，最后落到 `config.receiptTo`。虾酱 3 条完工回执（`T-MWXUBFXE`/`T-MWXU3R66`/`T-MWXVXD4F`）就是这样全部投给了 `session-7fa21aa4`（`mesh · 协调`，本仓历史会话），真正的派单方 `session-9127441f` 永远收不到。现在改用文件里已有的 `resolveRequesterSessionId(updated.requester)`（它同时处理「requester 是 id」和「requester 是标题」，解析不到返回 `null` 而不抛），与 `routeForSessions()` 的用法一致。
- 同一形状的另外三处一并修正（T-mwxx12b8）：`notifyRefusedDeclaration()` 里 `row.requesterSessionId` 两处（重复声明的 advisory 因此一直被强制降级为 file 模式，即使派单方完全可解析）、启动时 `receipt-digest migration` 计数器的过滤条件（恒 falsy，所以**一直报 0**，把迁移积压藏了起来——修后能数出真实条数）。**逐一判定过**：`batch.requesterSessionId`（批次对象，`saveBatches()` 会持久化该字段）、`task.requesterSessionId`（`pendingTasks` 内存对象，`registerPendingTask` 设置）都是**真字段**，不用改。
- 顺带修掉一条间歇性失败的测试（T-mwxx12b8，协调 11-26 深夜见过一次 263/264）：`restart: a deferred row is not re-stalled by the claim sweep` 等 3 条宽限期用例用固定 `sleep()` 对齐 `restartGraceMs`，单跑够、全量并发下 timer 可能晚于 sleep，于是断言看到的是复查**之前**的状态。改为 `waitFor()` 轮询可观测事实（deferral 被释放 / 行被判 lost），不再赌时钟。
- **`not-started` 告警不再堵死结算**（T-mwxn99u7，本单自身踩到）：`mesh_complete` 判「可声明」只看行状态（`lost`/`pending`/`started`/`waiting-lock`），而 `settleTask()` 把 `not-started` 这条**咨询性告警**落成 `status: 'stalled'` 且**同时写 `settledAt`**——于是「等待 turn/start 超时」看起来像终态，`mesh_complete` 回 `alreadySettled:true`，worker 干完的活无处登记。实测就是本单：`T-mwxn99u7` 被标 `not-started` 后声明被拒（账本行 `status=stalled` + `settledAt` 有值 + `receiptStatus=not-started`）。现在 `receiptStatus === 'not-started'` 的行与那四种状态一样可被声明结算；回执措辞也如实说明「曾被判 not-started（咨询性告警，非终态），worker 后续仍在推进」，**不再**谎称「运行时状态已丢失」。真正终态（`settled` 且 `receiptStatus` 非 `not-started`）仍拒收并有测试守着。
- **worker 不再需要问人「我该回给哪个会话」**（T-mwxn99u7，owner 2026-11-26 两问）：`mesh_tasks` 工具自己的投影白名单漏了身份字段——任务行一直存着 `requester`，`lib/task-registry.mjs` 的 `taskRowForApi` 也一直输出它，只有 `meshTasks()` 那份投影把它丢了。收件方只能看到「目标是我」（`targetTitle`），看不到「谁派的」，于是只能回去问 owner。现在每行都带 `requester`（回信的地址）、`requesterTitle`（给人看的标题，会话已归档/不存在时为 `null`，**不编造、不抛错**）与 `targetSessionId`（审计时两端可比对）；字段名与 `taskRowForApi` 保持一致，两套投影不会再各说各话。整页只列一次会话表并复用，不是每行查一遍；会话列举失败时降级为全 `null` 并记日志，绝不让一整块任务板因为解析标题失败而消失。
- 注入头加了**一行**回信指引（T-mwxn99u7）：`FROM` 只说了谁派单，没说怎么回，于是 worker 要么猜，要么被 `mesh_` 前缀骗去用 hub 的 `mesh_send`（本地会话根本不在 hub 里，发不出去）。现在 `[TASK …]` 行之后多一行 `REPLY:`，用**真实 taskId** 指出回信 = `mesh_complete({taskId:'…'})`（回执直接投给派单方）、查看自己的单用 `mesh_tasks`，并明确写「不要用 `mesh_send`／`mesh_inbox`——那是跨机 hub agent 通道，本地会话不在其中」。只加一行：注入正文越长，worker 越容易略过真正的工作内容。无 taskId 的 `POST /mesh/inject` 也有一行同等指引（不给 `mesh_complete` 假承诺）。
- 三处工具描述补边界说明（T-mwxn99u7）：`mesh_tasks` 说明返回含 `requester`；`mesh_ack` 写明它是**任务签收**、与 hub 那个同名的「消息已读」是两回事；`mesh_complete` 写明不要为说一句话去造任务、也不要把进度叙事塞进 summary/detail（本地便条原语尚未提供，如实说明而不是承诺一个不存在的工具）。`docs/tools-reference.md` 已由 `gen-tool-reference.mjs` 重新生成。
- **重启不再等于任务死了**（T-mwxjfvwn，owner 2026-11-26 直接问「会话还没结束，只是出现了请求重试就投递了 lost 回执？」；同类第 3 次）：`reconcileOrphanTasks()` 用一条事实判死——「本进程内存里没有这行」——但那说的是**内存**，不是**任务**。DSH 会话是持久化的，重启后它还在、还能继续干活。`T-MWXHO5U1` 在 12:30:02 被判 `lost`，会话 12:35:39 仍在活动，回执却写着「session restarted before this task finished; resend if still needed」——一句假话，换来一次真实的重派。
  - **实测前提**（不是推理）：重启那一刻，持久化会话报告 `live=false`、`turnOpen=false`、`lastActivityAt=null`，要等它被恢复并发出第一个事件才有信号。所以「启动时用 live 判死」本身也不成立，改成两阶段：
  - **判活只认三条**（T-mwxmcynk 收窄）：`live === true`、`turnOpen === true`、`lastActivityAt > processStartedAt`（**本进程启动之后**仍有活动）。首版还有一条 `lastActivityAt > row.createdAt`，被退回——它几乎恒真，而且描述的正是**重启之前**发生的事，恰是重启无法与「任务已死」区分的那类证据；留着它会让所有安静行永久判活、复查路径变成死代码（`T-mwxmcynk` 实测：宽限期后仍安静的行永远 `pending`、不发回执）。
  - **boot 阶段**只判有证据的：会话不存在 / 已归档 → `lost`（照旧）；判活三条命中 → `defer`（回 `pending`，记 `deferredAt` + `deferredReason: 'session-alive-after-restart'`，**不发回执**）；其余 → **hold**（`deferredReason: 'awaiting-restart-grace'`），**不判死**。
  - **recheck 阶段**（`restartGraceMs`，默认 5 分钟，一次性不循环）：到点后仍无任何生命迹象才算证据，判 `lost` 并发回执；期间恢复的则清掉 deferred 字段留在 `pending`。**两种 boot 结论都会进复查**（`awaiting-restart-grace` 与 `session-alive-after-restart`）——首版只复查前者，被 `defer` 的行写一次就再没人看，属同一类「安静行泄漏」。
  - **探针失败**（`listLocalSessions()` 抛错）→ 整轮跳过 + `WARN`，**一行都不判**。从失败的探针推出「死了」是同一个错误换了件衣服。
- **有证据地复活历史误判**（T-mwxjfvwn）：`lost` + `reasonDetail === 'host restart'` + 会话 `live` + **`lastActivityAt > settledAt`**（被判死之后还活过）→ 回 `pending` + `resurrectedAt`/`resurrectedReason: 'session-active-after-lost'`。`lastActivityAt > lostAt` 是硬条件，达不到的一律不动；非 `host restart` 的 `lost` 不参与。11-25 从 `stalled` 恢复、11-26 又被判 `lost` 的 5 条属于这一类。
- **批次恢复同源缺陷**（T-mwxjfvwn，由新门禁抓出）：`restoreBatches()` 重启后把每个开放批次任务直接 `settleTask(..., status: 'lost')`。现在先问 `sessionAlive()`，活着或探针不可知就保留 `pending` 并记日志，交给 restart reconciliation 判。
- 新增门禁 `scripts/check-no-memory-only-death.mjs`（T-mwxjfvwn）：写 `status: 'lost'|'stalled'` 的行级判定，若同一函数内没有活性证据（`live`/`turnOpen`/`lastActivityAt`/`probeSessions`…）且判定行本身或紧邻上一行没有 `death-allowed: <理由>` → 红。**无文件级豁免**；注释不算证据（词边界匹配，且检查前剥离注释）；`buildReceipt({status:'lost'})` 是描述而非判定，不计入。已接入 `.github/workflows/plugin-check.yml`。**红检 5/5**（函数内判死 / 顶层判死 / 有别的变量但无活性探测 / 空理由标记 / 标记隔两行），并自带 9 例测试 `test/check-no-memory-only-death.test.mjs`。
- 任务行新增 `deferredAt` / `deferredReason` / `resurrectedAt` / `resurrectedReason` 四个字段并暴露到 `/mesh/tasks`（T-mwxjfvwn）：重启后「为什么这行还是 pending」不必翻日志。
- 新增配置 `restartGraceMs`（默认 300000，clamp 500–3600000）：重启后判定孤儿任务的宽限期。
- **标题不再当身份**（T-mwwdyc7i，owner 已纠正两次）：`inferRequesterFromWorkspace()` 原先按「同 cwd 下标题像协调的会话」推断派单方。`.worklog/WORKLOG.md:594`（11-19）已记过 `coord-scope` 犯同一个错并只修了那一个脚本；4 天后同一正则在这里原样发作——旧会话 `session-7fa21aa4`（标题 `mesh · 协调`、未归档）成了仓库根下唯一「协调」标题会话，于是**所有未署名回执全推给它**。现在先读注册表真源（`coordinators[]` 里 `status=approved` 且 `permanent` 或 `leaseUntil` 未过期）；注册表说「多个都合格」就保持 `ambiguous` + file-only，不按活跃时间挑一个；只有注册表**没有任何有效声明**时才退到标题匹配，且打 `WARN … by TITLE (deprecated, source=title-fallback)`。日志显式区分 `source=registry` / `source=title-fallback`。
- 顺带修掉一处同源的隐式选择：启动对账里的 `syncPrimary()` 会在「多个 live 声明但没有 primary」时按 `claimedAt` 强行推一个赢家，等于替调用方选了人。现在只有「恰好一个 primary」或「至多一个 live 声明」时才推导；多声明无 primary 时保持原样，由 `liveRequesterOf()` 如实回答 `no-primary`。
- `roles` / `role` 降级为显示与兼容（T-mwwdyc7i）：`classifyRoleCandidates` 的标题推导不再覆盖注册表。条目已有显式 `roles` 时以它为准，标题推导出的角色只进 `rolesUnrecognized` 并在日志里说明「not applied」；`GET /mesh/session/identity` 的 `role` 改为优先读 `workers[role].sessionId`，并新增 `roleSource`（`registry`/`registry-ambiguous`/`title-fallback`/`none`）说明这个值是怎么来的。
- 新增门禁 `scripts/check-no-title-identity.mjs`（T-mwwdyc7i，**T-mwwfvvzw 返工**）：扫 `plugins/mesh-waker/**`，把 `isCoordinatorTitle(` / `classifyRoleCandidates(` / `titleRoleCandidate(` 变成判断而同一函数体内没有 `accounting`/`display`/`fallback` 标记的调用点判红；支持 `--json` / `--help`（零副作用）；已接入 `.github/workflows/plugin-check.yml`。**这是「彻底」的关键**——11-19 的教训是一处一修必然复发。
  - **返工原因（教训）**：首版是**假绿**。它有两处过于宽松：① `FILE_ALLOWLIST` 整文件豁免，`index.js` 因此**从未被扫描**，而它恰好含 2 处真实身份使用；② 允许标记扫**整个外层函数体**，一个 300 行函数里任意位置出现 `fallback` 就放行其中所有标题调用。协调用三种插针形状实测（顶层调用 / 函数体内 / 类方法内）**全部漏报**。
  - **现在的判据（行级）**：调用行若本身是 `function x(` 声明行或在 `export { … }` 列表里 → 视为定义，放行；否则必须在**调用行本身或紧邻的上一行**出现 `title-identity-allowed: <非空理由>`。没有文件级豁免，没有「函数体内任意位置」豁免。行号漂移即红，逼人维护。
  - 5 处真实使用逐条加就近标记并写明理由（`index.js` 两处为 `display`：只喂 `roleSource`/`rolesUnrecognized`；`receipt-flow` 一处为 `fallback`：仅在注册表无有效声明时到达；`session.mjs` 两处为 `definition`：该文件本身就是唯一标题解析器）。
  - 门禁自带测试 `test/check-no-title-identity.test.mjs`（11 例，用 `--root` 指向临时树跑**真实门禁**）：定义放行、函数内无标记判红、就近标记通过、标记在调用行也通过、空理由不算标记、远处 `fallback` 不豁免、无整文件豁免、协调的三种插针形状全部判红、标记行漂移判红、注释里提到函数名不算使用、真实树恰好 5 标记 3 定义。
- `stalled` 判据按「怎么被接单的」分档（T-mwurolzr，`T-mwumb28l` 实测 acked 早于 stalled 59 分钟）：已签收但未结算的行**不再被判 `stalled`**——那是「认领了没交付」，不是「没人看见」。现在记 `unfulfilledAt` + `stalledReason: 'acked-not-settled'` 并打不同措辞的 `WARN digest task unfulfilled`；真正无人认领才标 `stalled`（`stalledReason: 'unclaimed'`）。恢复也分档：`startedAt > stalledAt` → `resumedReason: 'started-after-stall'`（稍晚认领）；`ackedAt > 0` → `resumedReason: 'acked-not-delivered'`；两者皆无则保持 stalled。
- `stalled` 不再是单向门（L2-20261124-03，L2 自己就是受害者：19:51 派给 L1 的单被看门狗判 stalled，21:38 认领后状态永远停在 stalled，`verify-task` 至今判 FAIL）。根因：`claimSweep()` 只写 `stalled`，全仓无任何写回路径，而取消接口把 `stalled` 与 `settled`/`cancelled` 并列当终态——于是「已被接单却显示卡住」的行既不会自愈也关不掉（全机 7 条 stalled 里 5 条已有 `startedAt`/`ackedAt`）。现在 sweep 先做一次正向检查：`stalled` 且（`startedAt > 0` 或 `ackedAt > 0`）且未结算 → 恢复 `pending` + 记 `resumedAt`，日志 `digest task resumed … reason=started|acked`；`stalledAt` 保留为历史，`claimState` 视它「已升级过」，因此恢复后的行不会被下一轮立刻标回。已 settled 的 stalled 行（历史遗留）不动。
- digest 任务的 `started` 状态此前只写 `startedAt`、不写 `status`（L2-20261124-03）：状态字段说 `pending`，而「这条到底有没有被接」只能靠字段猜。现在打开回合即写 `status: 'started'`，**结算仍是 declared-only**（T-459 不变）；同时对齐 digest 候选判定——`declaredOnly` 的 `started` 行仍留在 digest 里（否则一开始干活就静默从摘要中消失）。
- 任务行恢复记录投递模式（`mode: steer|queue`，T-mwnpxik9）：`recordTaskPending` 里这段代码曾被压成单行注释而从未执行（任务库 320 行命中 0 次），事后无法区分「插队更正」与「排队跟进」；现在任务行与 `/mesh/tasks` 都可见，`mesh_dispatch` 日志也带 `mode=`。
- 工具说明不再固化平台专有路径（T-mwp3tahc）：`mesh_dispatch.workspacePath` 的描述原先把示例写成 Windows 盘符路径，生成到 `docs/tools-reference.md` 后被 `check-paths` 拦下，也不适合面向全平台的插件；改为 `/path/to/workspace` 的写法（并说明 Windows 可用盘符形式的绝对路径）。生成器不再需要 `<workspace>` 兜底。
- 不再向「工作目录已不存在」的会话派活（T-mws1zens）：`git worktree remove` 之后会话仍在、cwd 已消失，派活会返回 `ok:true` 并把任务写进机器账本，谁也不会去跑（实测 9 单里 4 单如此，其中 3 单最后 `aborted`）。现在 `mesh_dispatch` 与 `/mesh/inject` 在写任务行**之前**校验目标 cwd，缺失则 409 并给出会话 id/标题、那个路径与「归档该会话或改派主树会话」的建议；cwd 未知/UNC 不可判定时不拒绝但**在响应里带 warning**，不再静默。`ensureWorkspace()` 也不再为不存在的目录新注册工作区（已有条目不删）。
- 新增 `POST /mesh/workspaces/prune`（T-mws1zens，loopback）：清掉 cwd 已消失的僵尸工作区。**默认 dry-run**，`{apply:true}` 才写，写前把注册表备份成 `workspaces.json.bak-prune-<时间戳>`；保守判据——UNC 路径一律跳过（离线笔记本上的真实共享不能当删除）、`ephemeral` 跳过、有 `workers`/`coordinators` 成员的要求 `force:true`；每条都带 `reason`。
- `GET /mesh/workspaces` 每条新增 `cwdExists`（true/false，不可判定为 `null`）与 `cwdExistsReason`（T-mws1zens）：运维侧不必自己扫盘就能发现僵尸工作区。
- `createIfMissing` 新建会话的**首单**落进机器账本（T-mwtaoe4s，dogfood 2026-11-23 实测）：会话建在自己的工作区里，但第一个任务写进了 `local/tasks.jsonl`（`scope=machine`、`scopeUncertain:true`），而响应只报 workspace、没提这件事。根因是两处 cwd 来源不一致——派发侧已经算好 `targetCwd`，任务行却在 `registerPendingTask` 里又用 `sessionCwdOf()` 查了一次，而新会话还没进宿主索引，返回 null。现在派发把已解析的 cwd 传进生命周期（`{targetCwd}`），任务行直接用它；同时 `mesh_dispatch` 返回体新增 `ledgerScope`/`ledgerWorkspace`，并在真的落到机器账本时加一条 warning，不再让人以为活在自己工作区。
- `mesh_complete` 对**未结算**的行误报 `alreadySettled:true`（T-mwtaoe4s）：任务行还是 `pending`/`started`/`waiting-lock`（宿主重启或插件重载后 `pendingTasks` 为空、账本里还躺着未结算行），声明却被当成「已经结算过」丢弃并只写一行日志，worker 因此以为活已完，成果再无人登记。现在 `lost` 之外这三种未结算状态也允许被声明结算，且不伪造 `lostAt`/`recoveredAt`；`settled`/`cancelled`/`stalled` 等终态仍回 `alreadySettled:true` 并发 advisory，`lost` 的「无需重派」措辞与时间戳语义保持不变。
- 修 claim 看门狗误报：startedAt 已落的行不再判 unclaimed（T-485 addendum，实测 XJ-SPAWN-01 一边输出 started=yes acked=yes 一边报 unclaimed）——startedAt 与 ackedAt 语义相反，前者证明任务已被接单；未开始的任务仍由该看门狗盯。- digest 任务未声明完成的看门狗（T-mwgtchp6）：`declaredOnly` 任务通知后超过 `digestClaimWarnMs`（默认 30min）未 `mesh_complete` 时记 WARN 并给派单方 advisory `unclaimed` 回执（不结算），2× 窗口标 `stalled` 保留行；`claimSweepMs` 控制扫描，重启后继续。`createTaskLifecycle` 的依赖补传 `taskRows`（漏传会让 host 因 `deps.taskRows is not iterable` 退出）。
- 跨机任务消费（默认关闭）：开启后按自己的节奏拉取、认领、续租并结算对端派来的任务，正文按内容哈希取回，不落本地副本；`/mesh/status` 的 `tasksPoll` 报告开关、最近拉取时间与错误。
- 跨机派活（`dsh-mesh-dispatch --transport hub --to <agent>`）：正文上传为 blob、任务落到 hub，本机只留一行引用（不含正文、不建会话）；`--dry-run` 零网络，hub 失败时退出码非 0 且不留引用行。
- 会话身份端点 `GET /mesh/session/identity?session=<id>`：以工作区注册表为准回答「是不是本区协调」（不看标题），waker 自建会话的首个 prompt 带一行 `[身份]` 头。
- 多协调认领协议：`POST /mesh/coordinator/{claim,approve,reject,release,heartbeat}`，`coordinators[]` 支持多协调同时在线（上限可配）、待批准 TTL、租约与 primary 顺位；空工作区首任按 bootstrap 规则批准（配置 owner token 时必须带）。
- 新增任务取消（`POST /mesh/cancel` 与 `mesh_cancel` 工具）：先停掉目标会话的 turn 再结算 `aborted` 回执，面板「取消任务」不再只改状态；停 turn 不删会话。
- 回执/批次汇总可选带 worker 的末轮摘要：全局 `receiptNoticeSummary` 或单次 `receiptSummary`（工具参数 / `meta.receiptSummary` / CLI `--receipt-summary`），默认仍只发状态行；批次 body 超 min(`maxInlineBytes`, 8 KiB) 时截断并提示。
- 派活回执带 git 上下文与派生产物清单：`mesh_dispatch` 返回派发时刻的 `git:{cwd,branch,head,dirty}`，回执带结算时刻快照、`artifacts:[{path,exists,sizeBytes,mtimeMs}]`（缺失也列出）与 `warnings`（`expectBranch` 不一致只提示不阻断）；插件不创建 worktree、不切分支、不加树锁。
- 工作区 advisory 锁（`POST /mesh/workspace/lock`、`/unlock`、`mesh_lock`）：持锁期间向该 workspace 的派活以 `waiting-lock` 排队，锁释放或 TTL 过期后自动投递；锁被他人持有时返回 409；锁只在进程内，重启即清空。不建 worktree、不切分支、不阻止读操作。
- 可选的「收单钩子」：配置 `settleHookCommand` 后，任务结算会触发一次本地脚本（`--settle-tasks <ids>`，窗口内合并、可配超时、不阻塞结算）；默认关闭，不配置时行为与之前一致。
- 可选的「任务 digest + 签收」：开启 `digestDelivery` 后，派单只上任务板，回合结束后注入一条 `[TASK-DIGEST]` 摘要；`mesh_tasks` 查正文、`mesh_ack` 批量签收（板标记，不产生回执、不代表完成）。默认关闭。
- 可选的「回执 digest」：开启 `receiptDigest` 后，任务回执不再逐条排队注入——会话空闲或回合结束后收到一条 `[RECEIPT-DIGEST]` 合并通知，`mesh_tasks` 可列未签收回执，`mesh_ack` 签收后不再提醒。默认关闭。
- 身份自查改用「primary 路由位」的说法：`GET /mesh/session/identity` 新增 `routingRole` / `isPrimaryRouter` / `primaryRouterSessionId`，注入的身份头同样用新名；`isCoordinator` / `coordinatorSessionId` 保留为弃用别名（下个主题版本移除）。
- 按目标会话标题自动附角色卡（`roleInstructions`）：配好后派活与新建会话会把 `.worklog/roles/<role>.md` 追加到注入文本末尾，不必再靠派活正文手写；默认关闭，不配置时行为不变。
- 咨询类任务可以交付答案了：`mesh_complete` 新增可选 `answer`（上限 2 万码点），完整正文写进回执并可由 `GET /mesh/tasks/<id>` 的 `receiptAnswer` 读取，通知里加一行指向全文；不传时行为逐字不变。
- 文档更正（T-487）：同机回信不是没有通道——`mesh_dispatch` 到派单方 session id 通，`mesh_send` 只面向 agent（机器）故同机被拒；咨询类交付建议走 `mesh_complete({answer})`（回执通道）而不是再开一条任务。
- 只读存活查询（T-488）：`GET /mesh/sessions/:id` 返回 `turnOpen`/`turn`/`lastActivityAt`/`lastTurnStartedAt`/`pendingTaskCount`（未知 id → 404），`GET /mesh/sessions` 列表每条新增 `turnOpen`/`lastActivityAt`；`mesh_cancel({dryRun:true})` 零副作用地报告回合状态——确认「它还在跑吗」不再需要把回合停掉。
- 永久协调不再被 approve 降级：claim 的 `permanent` 现在存进成员并持久化，approve 只在非永久时写有限租约（此前轮换必然把永久 primary 变成 10 分钟成员，租约到期后被剪、`coordinator` 变空，消息回流退役会话）。
- 未读对账看门狗此前从未真正运行（T-mwmcxog4）：两个配置项漏传 `max` 参数被算成 `NaN`、首次执行又借用 `catchUpDelayMs`（默认 10 分钟），而且 `/mesh/status` 根本没输出这个字段。现在配置正确、首次对账在 hub 起来 5 秒后独立调度、状态里能看到 `checkedAt`/`attemptedAt`/`lastError`。

### Fixed

- 旧工作区（只有 `coordinator` 字段）读取时自动迁移成一条已批准的 legacy 成员，不再被当成空工作区而让任意会话 claim 后自动批准。
- 跨机任务正文按 hub 的真实契约解析（`/api/blob/<id>` 是原始文件流而非 JSON）；失败信息改为粘性并在 `/mesh/status.tasksPoll` 暴露 `lastErrorAt`，不再被下一轮成功清空。
- 结算请求改用 hub 契约的 `status` 字段（此前误发 `result`，真实 hub 一律 400、任务永远结算不了）；测试的 fake hub 同步校验字段，避免同类偏差再被掩盖。
- `mesh_dispatch` 的 `createIfMissing` 不再把新会话建到收件箱工作区：默认继承调用方工作区，显式 `workspacePath` 跨区时直接拒绝，拿不到工作区时拒绝并给出路。
- 注入类消息的 `FROM` 不再裸 `unknown`：`/mesh/inject` 按 `callerSession/origin/workspace` 回退来源，CLI 未传 `--requester` 时默认用 `DSH_SESSION_ID`；`TASK` 表头改为注册后渲染，始终是真实 id。
- 队列任务不再被无关回合误结算成 completed：一个 `turn/end` 只结算该回合开始时已排队、或 steer 插入本回合的任务，跨回合积压按队列位置计算。
- 未绑定 conversation 的跨机消息不再自动新建「Mesh 收件箱」会话并消费：消息保持 unread 等人工 `/mesh/bind`，已有绑定/面板绑定继续投递且不会被覆盖；投递失败保留绑定并延后，不再静默改投入收件箱。
- 会话标题以 DSH 实际标题为准（`/mesh/sessions` 带 `titleSource`/`titleStale`）：索引标题过期时按标题投递会被拒绝并提示改用 session id，不再把消息投进改过名的会话。
- 开启任务 digest 后 `steer`（插队）仍然立即注入正文：digest 只影响 `queue` 排队投递，steer 任务也不会被列进 digest 摘要。
- 空闲会话不再漏收任务通知：开启 digest 后，任务落板会在 `digestIdleDebounceMs`（默认 3 秒）后触发一条 digest，不必等下一个回合；忙会话仍在 `turn/end` 后通知，日志把落板记为 `digest-queued` 而不是 `injected`。
- 修复 digest 通知偶发不再投递：同一会话投过一次后，后续派单可能一直停在 pending（现改为投递前占位、失败即释放、超时自愈，并对每次延后/跳过记日志；超过 `digestNotifyWarnMs` 未投出记 WARN 并重试）。
- 协调认领支持 `permanent:true`：获批后 `leaseUntil:null`，不参与租约过期，适合固定 primary（L1 综合管理）；heartbeat 对永久项保持 null。
- coordinator 不再从会话标题（`mesh · 协调`）派生：只认 `coordinators[]`（claim/approve）或旧文件标量；标题只做显示；旧标量指向归档/不存在会话时清空。
- `scripts/mesh-dispatch.mjs` 移除 `--title` 与标题版 `--target`：只接受 session id（`--role`/`--coordinator` 由注册表解析）；`/mesh/inject` 的 title 默认拒绝（`allowTitleAddressing:false`），仅旧客户端显式开启；使用标题时记 `WARN title addressing deprecated`。
- 回执通知不再因为目标会话正在回合中而丢失：推迟的通知会自己重试，超过 `receiptNotifyWarnMs`（默认 90 秒）仍未投出时记 WARN 并立即补投一次；任务行以 `receiptNotifyCount: 0` 明确表示「尚未通知」，与「已通知待签收」区分开。
- 重启后被标 `lost` 的任务可以补交了：worker 事后调用 `mesh_complete` 会把行恢复为已完成并通知派单方「无需重派」；重复声明仍幂等拒收，但拒收会发一条 `[RECEIPT-ADVISORY]` 而不是只写日志。
- digest claim 看门狗被 `mesh_ack` 废掉：`claimState` 把 `ackedAt` 当成已解决，而 worker 按角色卡第一步就是签收，于是「已通知但从不声明」永远不告警。现在只有 `settledAt`（或派单方的显式 `claimDismissedAt`）能停看门狗；新增 `mesh_ack({dismissClaim:true})` 供派单方免打扰（worker 不能关自己的告警）。

### Changed

- 未投递的唤醒不再记为「已唤醒」（T-490）：`recordWake` 只在**真正注入会话**时计入限流窗口，`parked`/`deferred`/`skipped`/`denied` 改为单独计数。此前 `woke conversation … in 9ms` 这类日志把「尝试」写成「投递」，导致 3649 次限流拦截与 0 次真实投递可以同时存在而无人察觉。
- 未绑定对话改为**落盘队列**而非永远未读（T-490，owner 2026-11-18 选 B）：消息标记已读并写入 `unbound.jsonl`（保留 id / 发送方 / 主题引用），`/mesh/status.unboundPending` 报告待绑定对话数，`ops-check` 的 `waker-unbound` 判红。原 T-426 的「保持未读直到人工绑定」会让 pull 每 5 秒重新领取同一批消息、每轮 defer 而不投递（实测两个对话 62 轮、0 投递、无告警）；绑定后 `backfill` 从 hub 历史回放正文，不依赖 `read_at`，因此标记已读不会让消息失联。

- 角色卡注入改为按工作区注册表的 `workers[<role>].sessionId` 反查，不再解析会话标题；`workspaces.json` 的 workers 也不再由标题自动派生，必须显式登记（`POST /mesh/workspaces/workers` 或 `rotate-session --role`）。标题只是显示名：改名不再影响角色卡，也不再把任意同名标题会话误绑成 worker。
- 回执默认改为通知：`receiptMode` 的插件默认值从 `file` 改为 `queue`——不显式传 `receipt` 的派单，派单方现在会收到回执通知（开启 `receiptDigest` 时走合并通知）；`file` 保留为显式的安静选项，只写 JSONL、不通知。

## [0.8.0] - 2026-11-02

### Added

- 设置页按章节聚合（收件箱 / 投递 / 回执 / 任务 / 诊断），字段改完即生效。
- 「派活任务」面板：批次聚合、人读耗时、左右分栏详情、取消任务、打开会话。
- 任务库：`GET /mesh/tasks` 列表与详情、`DELETE /mesh/tasks/:id` 取消，任务正文与回执可事后查。
- 任务显示可读标题（可显式传 `subject`，否则从正文首行清洗）。
- 任务状态增加「进行中」（`started` / `startedAt`）。
- 线程身份：`mesh_dispatch` 的 `thread` 参数可续派到同一会话，任务头带 `THREAD`，`GET /mesh/threads` 查看绑定。
- `mesh_thread` 工具：`list` / `subscribe` / `release`，worker 可主动接管或交回线索。
- 重启后自动把上一进程遗留的任务标为 `lost` 并通知派活方，不再无声消失。
- 任务可由执行会话主动声明完成：`mesh_complete`（`done` / `partial` / `blocked`），回执标注 `(declared)`；未声明的任务仍按回合结束自动结算并标注 `(observed)`。
- 回执可投给派活方（`requester`），而不是只投全局 `receiptTo`。
- `bin/dispatch.mjs` 支持 `--thread`，命令行派活可加入同一线程。
- `bin/dispatch.mjs` 支持 `--requester`，命令行派活可指定回执收件人。

### Changed

- 日志按工作区分层（`local/logs/` 与 `ws/<slug>/logs/`）并按本地日期切分，旧 `waker.log` 保留为 `legacy-waker.log`；`registered` / `history sync` 心跳只在变化或每小时记一次。
- 工作区注册表自动收敛：slug 用项目名（`…\public` → `dsh-mesh`）、coordinator 取最近活跃并标记过期、临时测试工作区不再占位，旧 `ws/` 目录随 slug 迁移。
- 任务与回执按工作区分层存放（区内 `ws/<slug>/`、跨区 `local/`），旧单文件首次启动自动迁移并保留 `.legacy.jsonl`；README 与 `GET /mesh/tasks` 等接口仍按聚合结果工作。
- 注入的回执通知默认只发状态行（`error` / `lost` 附一行原因）；需要摘要时设 `receiptNoticeSummary: true`。
- 任务面板按钮统一为主/次/危险三档样式。

### Fixed

- 带编号的协调会话（如「协调 2」）能正确参与工作区登记与回执兜底路由。
- 磁盘代码更新后（即使版本号未变）会明确提示需要重启。
- 同一会话排队的长任务不再被误判为「未开工」，误判后也能恢复跟踪。
- `mesh_dispatch` 从未注册成功（output schema 用了宿主不支持的 `type` 数组）。
- 「打开会话」点了没反应（未注入 `ui-workspace`；现可真正切换）。
- 「打开任务面板」/「去任务面板」入口点了没反应（现切主视图并落在任务标签）。
- 回执静默丢失：file 模式也会写日志，无投递目标时给出 WARN；requester 缺失时按目标会话工作区推断协调会话。
- 同一 `taskId` 在 24 小时内复用会在任务记录里标记 `reusedId`。
- 回执摘要混入思考/工具块，或抓到上一个回合的正文（现在只取本任务开始后的答复）。
- 重启前未完成的任务不再一直等待（启动补发 `lost` 回执，并按任务记录的回执模式投递）。
- 归档会话在列表中置灰标注，删除后不再残留归档 id。
- 工作区注册表里的角色名只保留已知角色，标题中「·」后的其它片段不再被当成角色（改存 `rolesUnrecognized`，便于日后按需扩白名单）。
- 跨工作区任务的回执不再丢失：回执与任务行落在同一层，历史错层数据在启动时自动搬移。
- 重复的任务编号会被拒绝（HTTP 409），不再静默覆盖别人的任务；跨区裸单号会给出命名空间警告。

### Known limitations

- 面板、设置页等客户端改动需要重启 DSH 宿主（并在安装目录同步插件）后才可见。

## [0.7.5] - 2026-10-31

### Added

- `/mesh/sessions` 支持分页、标题/工作区过滤与 `archived` 过滤。
- 插件日志可写入独立文件并按大小滚动，`/mesh/status` 显示日志路径与大小。

## [0.7.4] - 2026-10-31

### Fixed

- 插件清单 `exports` 缺项导致宿主 loader 读不到客户端/CLI 入口。

## [0.7.3] - 2026-10-31

### Fixed

- 桥会话在发送回复前先预留，避免拉取/推送循环把问题或回复抢走。

## [0.7.2] - 2026-10-30

### Added

- `/mesh/status` 暴露待答问题与待批审批，面板可一眼看到卡住的事。

## [0.7.1] - 2026-10-30

### Fixed

- `mesh_ask` 把自己的提问误当成回答返回。

## [0.7.0] - 2026-10-30

### Added

- 提问桥：agent 运行中可通过 mesh 收件箱向人提问并等待回答（超时不猜默认值）。

## [0.6.0] - 2026-10-30

### Added

- 远程审批：通过 mesh 收件箱回复 approve/deny 即可应答审批请求（fail-closed）。

## [0.5.8] - 2026-10-30

### Fixed

- 被主题路由拒绝的消息不再被误消费，拒绝原因记入日志。

## [0.5.7] - 2026-10-30

### Added

- 主题路由：远程按标签投递，不暴露会话 id 或标题。

## [0.5.6] - 2026-10-30

### Fixed

- 注入发生在回合进行中时，不再被上一轮 `turn/end` 提前结算成完成。

## [0.5.5] - 2026-10-30

### Added

- 派活能力进插件：`mesh_dispatch` 工具与 `dsh-mesh-dispatch` CLI。

## [0.5.4] - 2026-10-30

### Changed

- 标题解析优先活跃会话；`/mesh/sessions?live=1` 只列运行中的会话。

## [0.5.2] - 2026-10-29

### Added

- 批次屏障：同一 `batchId` 的多个任务全部结束只回执一次；事件驱动的会话活跃度。

## [0.5.1] - 2026-10-29

### Added

- 插件级任务回执：任务结束时生成结构化回执（状态、耗时、摘要）。

## [0.5.0] - 2026-10-29

### Added

- 以 pull 为主要收信方式，支持 joinCode 自举接入与完全 standalone 运行。

## 早期版本（0.1.0–0.4.x）

### Added

- 本机唤醒端点：中枢发来「有信」信号即在运行中的 DSH 里创建/唤醒会话并投递。
- 中枢注册、断线追信与多会话协同（收件箱、主题、回复、peer 列表）。
- 设置面板：连接配置、本机会话列表与进程内注入。
- 会话管理：创建执行会话、绑定工作区、删除与归档标记。
