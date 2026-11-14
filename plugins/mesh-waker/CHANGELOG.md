# Changelog

本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。

> 最新发布：`0.8.0`（npm `latest`）。

## [未发布]

### Added

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

### Fixed

- 旧工作区（只有 `coordinator` 字段）读取时自动迁移成一条已批准的 legacy 成员，不再被当成空工作区而让任意会话 claim 后自动批准。
- 跨机任务正文按 hub 的真实契约解析（`/api/blob/<id>` 是原始文件流而非 JSON）；失败信息改为粘性并在 `/mesh/status.tasksPoll` 暴露 `lastErrorAt`，不再被下一轮成功清空。
- 结算请求改用 hub 契约的 `status` 字段（此前误发 `result`，真实 hub 一律 400、任务永远结算不了）；测试的 fake hub 同步校验字段，避免同类偏差再被掩盖。
- `mesh_dispatch` 的 `createIfMissing` 不再把新会话建到收件箱工作区：默认继承调用方工作区，显式 `workspacePath` 跨区时直接拒绝，拿不到工作区时拒绝并给出路。
- 注入类消息的 `FROM` 不再裸 `unknown`：`/mesh/inject` 按 `callerSession/origin/workspace` 回退来源，CLI 未传 `--requester` 时默认用 `DSH_SESSION_ID`；`TASK` 表头改为注册后渲染，始终是真实 id。
- 队列任务不再被无关回合误结算成 completed：一个 `turn/end` 只结算该回合开始时已排队、或 steer 插入本回合的任务，跨回合积压按队列位置计算。
- 未绑定 conversation 的跨机消息不再自动新建「Mesh 收件箱」会话并消费：消息保持 unread 等人工 `/mesh/bind`，已有绑定/面板绑定继续投递且不会被覆盖；投递失败保留绑定并延后，不再静默改投入收件箱。
- 会话标题以 DSH 实际标题为准（`/mesh/sessions` 带 `titleSource`/`titleStale`）：索引标题过期时按标题投递会被拒绝并提示改用 session id，不再把消息投进改过名的会话。

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
