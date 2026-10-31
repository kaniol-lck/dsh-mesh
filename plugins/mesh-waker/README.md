# dsh-mesh-waker

DSH 客户端插件：[dsh-mesh](https://github.com/kaniol-lck/dsh-mesh) 局域网 agent 中枢的接入端。

默认是 **pull 模式**：本机按间隔向中枢 `GET /api/inbox?claim=1` 拉信，所以**不需要公网 IP、不需要入站端口、不需要 `NODE_EXTRA_CA_CERTS`**。有入站能力时再叠加 push（中枢发 HMAC 签名的 `/mesh/wake` ping），把延迟从「一个轮询间隔」压到「一次 HTTP」；两条路径共用同一套 conversation 冷却与去重，不会重复开 turn。

## 安装

```bash
dsh plugin add dsh-mesh-waker
dsh plugin --profile web add dsh-mesh-waker
```

装完打开 **设置 → Mesh**，填两样就能接入：

1. `hubUrl`，例如 `http://<HUB-HOST>:8790` 或 `https://mesh.example.com`；
2. `joinCode`（中枢控制台/管理员发的 8 位一次性注册码）。

启动时插件 `GET /api/bootstrap` 取服务信息（以及可选 CA），再 `POST /api/enroll` 换回自己的 agent token，按 `0600` 写进 `tokenFile`；日志里只出现 `token fp=<前6位>… len=<n>`，重启后不再需要 `joinCode`。

> 不用中枢也能跑：**不填 `hubUrl` 就是 standalone**，只起本机 `127.0.0.1:8795` 的五个本地端点，供同一 DSH 里的会话互相 inject。

## 开发模式：本机 link（不是 npm 安装）

本仓库维护者跑的是**开发态**：DSH profile 的 `node_modules/@local/dsh-mesh-waker` 是指向本机 checkout 的 link，而不是 registry 上的 npm 包。这与发布态是两件事，混在一起就会出现「改了仓库为什么没生效」。

| 形态 | 谁用 | 安装方式 | 改动如何生效 |
|---|---|---|---|
| 发布态 | 外部用户 | `dsh plugin add dsh-mesh-waker` | 重新 `npm install` / 升级版本 |
| 开发态 | 维护本仓库的人 | DSH profile 的 `node_modules/@local/dsh-mesh-waker` **link** 到本机 checkout | 同步文件 + 重启 DSH |

**为什么开发态要 link**：npm 安装的是 registry 上的版本，改本地 checkout 不会影响已安装副本；link 让 profile 直接加载 checkout 里的文件，才能边改边验。

开发态的同步三步（`<checkout>` 是本机 clone 路径，`<link-target>` 是 profile 里 `@local/dsh-mesh-waker` 指向的目录）：

1. **同步文件**：把 `plugins/mesh-waker/` 下的 `index.js`、`client.js`、`locale/*`、`icon.svg`、`README/CHANGELOG` 复制到 `<link-target>`（Windows 示例：`Copy-Item "<checkout>\plugins\mesh-waker\index.js" "<link-target>\index.js" -Force`）；
2. **保护 link 目标的 `package.json`**：`name` 必须是 `@local/dsh-mesh-waker`，`dsh.bundle.patch` 必须是 `./cordis.patch.yml`。**不要用仓库的 `package.json` 覆盖它**——覆盖后宿主会按 npm 形态解析，插件加载失败、客户端也可能崩；
3. **重启 DSH 并确认**：`curl http://127.0.0.1:8795/mesh/status`，`pluginVersions.process` 应等于新版本；若 `stale=true`，说明文件已换但进程还跑旧代码。

**常见故障**：

- `process` 版本没变 → 没重启 DSH，或状态里 `stale=true` 说明进程仍是旧的；
- 插件完全不加载、8795 无响应 → 先查 profile 的 cordis patch 里是否有 `disabled: true` 的 waker 条目，再查 `<link-target>/package.json` 的 `exports` 是否包含 `./package.json` 与 `./cordis.patch.yml`（缺了会 `ERR_PACKAGE_PATH_NOT_EXPORTED`）；
- 开发态与发布态混淆 → 对照上表：`@local/dsh-mesh-waker` 是 link 的开发态，`dsh-mesh-waker` 是 npm 发布态，两者可共存但加载的是不同副本。

> 本仓库所有验证都在开发态（link）下完成；发布态用户按上面「安装」一节即可，不需要做这些步骤。

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

全部可选；写在 profile 的 cordis patch 里（或 `~/.dsh/mesh-waker/config.json`）。按用途分组，每组一张表。

### 中枢连接

| 键 | 默认 | 说明 |
|---|---|---|
| `hubUrl` | — | 中枢地址；留空 = standalone |
| `token` | — | agent token 明文；优先级低于 `tokenFile` |
| `tokenFile` | — | token 文件路径（自举会把换到的 token 写进去，0600） |
| `joinCode` | — | 一次性注册码；有它且没有 token 时自动换 token |
| `agentName` | — | 自举/注册时用的节点名（`[A-Za-z0-9_-]{1,32}`）；不填由中枢分配 |
| `agentPreset` | — | 该节点的权限预设名（交给宿主解释） |
| `mode` | `auto` | `auto`（pull 常开，push 叠加）/ `pull` / `push` |
| `caFile` | — | 额外 CA PEM，用于出站 TLS（替代 `NODE_EXTRA_CA_CERTS`） |
| `caSha256` | — | 可选指纹钉扎；与 `caFile` 或 bootstrap 的 `tls.ca_sha256` 不符即拒绝连接 |

### 唤醒与轮询

| 键 | 默认 | 说明 |
|---|---|---|
| `wakeSecret` | — | **只有 push 需要**的 HMAC 密钥明文 |
| `wakeSecretFile` | — | 密钥文件路径；与 `wakeSecret` 二选一 |
| `listenHost` | `127.0.0.1` | 只有 push 才需要改 `0.0.0.0` 或 LAN 地址 |
| `listenPort` | `8795` | 本地面板与会话端口 |
| `advertiseHost` | — | push 时告诉中枢的可达地址（决定 `wakeUrl`） |
| `wakePath` | `/mesh/wake` | 唤醒端点路径 |
| `pollIntervalMs` | `30000` | 常态轮询间隔（下限 5000，上限 600000） |
| `pollBusyIntervalMs` | `5000` | 拉到消息后的快档间隔 |
| `pollIdleIntervalMs` | `60000` | 连续 3 次空轮询后的慢档间隔 |
| `claimTtlMs` | `300000` | claim 租约；puller 崩溃后由中枢自动回收 |
| `registerIntervalMs` | `300000` | 向中枢重报 `wakeUrl` 的间隔 |
| `historySyncIntervalMs` | `600000` | 面板历史同步间隔（下限 60000） |

### 投递与会话

| 键 | 默认 | 说明 |
|---|---|---|
| `boundDeliveryMode` | `queue` | 绑定会话的默认投递：`queue` / `steer` / `branch` |
| `allowSenderDeliveryMode` | `true` | 是否允许发送方按消息指定投递模式 |
| `delivery` | — | 单条消息的投递覆盖（`queue`/`steer`/`branch`），非插件级配置 |
| `sessionTitle` | `mesh 收件箱` | 收件箱会话标题 |
| `sessionCwd` | — | 收件箱会话的工作目录 |
| `workspacePath` | — | 收件箱会话绑定到的工作区路径 |
| `workspaceTitle` | `Mesh 收件箱` | 侧栏里该工作区的显示名 |
| `branchReuseHours` | `12` | branch 侧会话复用窗口（小时） |
| `branchTitlePrefix` | `mesh · ` | branch 侧会话标题前缀 |
| `resetAfterHours` | `12` | 收件箱会话闲置多久后重置 |
| `maxWakes` | `50` | 单个会话累计唤醒次数上限 |
| `maxSteerPerWindow` | `1` | 每窗口允许的 steer 次数 |
| `steerWindowMs` | `60000` | steer 计数窗口 |
| `maxInlineBytes` | `4096` | 单条正文内联进唤醒回合的 UTF-8 字节上限；超出时按字符边界截断并**在正文末尾标注**「正文已截断：原文 N 字节…完整内容请用 mesh_inbox 读取」（收件箱原文不变） |

### 补收与冷却

| 键 | 默认 | 说明 |
|---|---|---|
| `catchUpOnStart` | `true` | 启动时补收离线期间的消息 |
| `catchUpDelayMs` | `12000` | 启动后延迟多久开始补收 |
| `catchUpMaxConversations` | `3` | 一次补收最多覆盖几个会话 |
| `cooldownMs` | `1500` | 同一会话两轮之间的最小间隔 |
| `conversationCooldownMs` | `60000` | 同一 conversation 的冷却窗口 |

### 限速与节流

| 键 | 默认 | 说明 |
|---|---|---|
| `throttleMaxWakesPerWindow` | `30` | 每窗口最多唤醒次数 |
| `throttleWindowMs` | `3600000` | 节流窗口（1 小时） |
| `minMessageChars` | `24` | 短于该长度的消息不单独起一轮（合并处理） |

### 主题路由

| 键 | 默认 | 说明 |
|---|---|---|
| `topics` | `[]` | 主题路由表：每项 `{label, title, allowFrom}`，把远端标签解析到本地会话 |
| `allowFrom` | `[]` | 允许向该主题/桥发消息的 peer 白名单（空 = 不限制） |

### 审批桥（approvalBridge）

| 键 | 默认 | 说明 |
|---|---|---|
| `approvalBridge` | 关 | 远程审批桥配置对象（下同） |
| `enabled` | `false` | 是否启用 |
| `to` | — | 审批消息发给哪个 peer |
| `allowFrom` | `[]` | 只接受这些 peer 的回复（空 = 任何 peer，不推荐） |
| `timeoutSeconds` | `120` | 等待决定的秒数（1–3600），超时按拒绝 |
| `conversationPrefix` | `approval/` | 审批对话的 conversation 前缀 |
| `pollMs` | `2000` | 轮询回复间隔（250–60000） |
| `diag` | `false` | 打印诊断日志（含消息形状，不含正文） |

### 提问桥（questionBridge）

| 键 | 默认 | 说明 |
|---|---|---|
| `questionBridge` | 关 | 向人提问的桥配置对象（下同） |
| `enabled` | `false` | 是否启用 |
| `to` | — | 提问消息发给哪个 peer |
| `allowFrom` | `[]` | 只接受这些 peer 的回复 |
| `timeoutSeconds` | `300` | 等待回答的秒数（1–3600） |
| `conversationPrefix` | `question/` | 提问对话的 conversation 前缀 |
| `pollMs` | `2000` | 轮询回复间隔（250–60000） |
| `diag` | `false` | 诊断日志 |

### 面板与日志

| 键 | 默认 | 说明 |
|---|---|---|
| `logFile` | `<tmpdir>/mesh-waker.log` | 日志文件；推荐 `~/.dsh/mesh-waker/waker.log`（重启不丢） |
| `logMaxBytes` | `2097152`（2 MiB） | 超过即滚动为 `<logFile>.1`（只留 1 份历史），下限 1 KiB |
| `injectHeader` | `true` | 注入正文前加一行 `[TASK …]` 表头；设 `false` 退回逐字投递 |
| `tasksRetentionDays` | `30` | 任务库保留天数（启动时裁掉更旧的记录） |
| `tasksMaxRows` | `5000` | 任务库最多保留条数（超量裁最旧） |
| `entryLabel` | `Mesh 信箱` | 信箱入口显示名（侧栏 tooltip、页面标题、设置页跳转文案共用；≤40 字） |

### 信任与权限

| 键 | 默认 | 说明 |
|---|---|---|
| `trust` | `normal` | 本机默认信任档：`strict` / `normal` / `full`（见下节） |
| `trustByPeer` | `{}` | 按发送方覆盖信任档，如 `{"<peer>":"strict"}` |
| `permissionPresetByTrust` | 见下节 | 信任档 → DSH 权限预设的映射 |

**激活矩阵**：

| hubUrl | token | joinCode | 行为 |
|---|---|---|---|
| 无 | 任意 | 任意 | **standalone**：只绑 `listenHost:listenPort`，不发任何网络请求 |
| 有 | 有 | 任意 | 正常启动，`mode` 决定 pull / push / auto |
| 有 | 无 | 有 | **自举**：`/api/bootstrap` → `/api/enroll` → token 写 `tokenFile`(0600) → 继续启动 |
| 有 | 无 | 无 | standalone，且 `lastError="missing token (provide joinCode or tokenFile)"`（不静默退出） |

CA 只记 sha256 前 16 位，token 只记 `fp=<前6位>… len=<n>`；任何日志都不打印密钥。

## 信任与权限

**信任档只在本机设置，中枢与对端都不能提升它**（代码注释原话：a remote message can never turn this machine into an unapproved execution surface）。远端能做的只有：在本机允许的档位内发消息。

| 档位 | 被远程唤醒的这一轮允许做什么 |
|---|---|
| `strict` | 只读：只读取、只回复；不写文件、不执行命令、不装东西。要动手的事写进回信请人批准 |
| `normal`（默认） | 能直接办的就办；写文件/装插件/改系统/提权这类先申请批准 |
| `full` | 按完全信任执行，不停下来征求批准；只有不可逆操作才先确认 |

- `trustByPeer` 按发送方覆盖默认档（存 `<tokenFile 目录>/trust.json`，或用 `POST /mesh/trust` 修改，**仅 loopback**）；
- `permissionPresetByTrust` 把信任档映射到 DSH 权限预设，默认 `strict → read-only`、`normal → workspace-write`、`full → danger-full-access`；只有宿主的预设名不同或你想让某档更保守时才需要改；
- `normal`/`strict` 下的「申请批准」走审批桥（`approvalBridge`，fail-closed、超时按拒绝），不是聊天问答；审批桥没启用时，危险操作会停在本机提示上等人处理。

## 任务回执（0.5.1）

`/mesh/inject` 可以带 `meta.taskId`（不污染正文）：插件在该会话的回合结束时写**恰好一条**回执，一个 taskId 只结算一次；配合 `dsh-mesh-dispatch` 使用：

```bash
npx dsh-mesh-dispatch --title "<session-title>" --file task.txt --task T-20261029-hub
npx dsh-mesh-dispatch --title "<session-title>" --file task.txt --task --receipt queue
```

`--task` 不带值时自动生成 `T-<base36 时间戳>`；`--receipt` 可覆盖全局默认（并隐含开启 task）。

| 键 | 默认 | 说明 |
|---|---|---|
| `receiptMode` | `file` | `file` 只写 JSONL；`queue` 再把 `[RECEIPT]` 注入 `receiptTo`（mode=queue）；`wake` 额外唤醒（需 `wakeSecret`，否则降级 queue 并记 WARN） |
| `receiptFile` | `~/.dsh/mesh-waker/receipts.jsonl` | 追加写，一行一条 JSON（0600） |
| `receiptTo` | 空 | 接收回执的会话：标题（如 `<session-title>`）或 `session-…`；为空则只写文件 |
| `receiptSummaryChars` | `300` | 摘要按**码点**截断，不会切出半个字符 |
| `receiptStallMs` | `600000` | 注入后这么久仍无 `turn/start`，判 `not-started` |

回执字段：`taskId / sessionId / turn / status / reasonKind / reasonDetail / injectedAt / endedAt / durationMs / summary / receiptMode / baselineTurn / settledTurn / injectedDuringTurn`。`status` ∈ `completed | aborted | blocked | error | max-tokens | interrupted | forked | not-started`；`reasonDetail` 放 `error.code` 或 abort 原因。`baselineTurn`/`settledTurn` 是结算诊断：`queue` 注入发生在回合进行中时 `baselineTurn` 等于该回合，只有更晚回合的 `turn/end` 才会结算（`settledTurn > baselineTurn`），`steer` 则同一回合即可。注入给接收方的正文首行是 `[RECEIPT] <taskId> <status> <durationMs>ms`，第二行是摘要。

**回执投递给谁（0.7.7）**：优先投给**派活方**（requester），否则 `receiptTo`，都没有才只写文件。

1. `requester`（`/mesh/inject` 的 body 字段或 `mesh_dispatch` 的工具参数，CLI `--requester` 会带）解析成功 → 只投给该会话；`mesh_dispatch` 被模型调用时若宿主把调用方 session 传给 handler（`_extra`/第二参数），自动用它；
2. requester 解析失败 → 记录 `lastError`（`requester not resolved … falling back to receiptTo`）后回退 `receiptTo`；
3. 都没有 → 只写文件，`lastError` 说明原因。

batch 聚合通知（以及 batch alert）投给该 batch 的**第一个 requester**；batch 内混有多个 requester 时，其余记日志与回执行（`batch … mixed requesters`）。`/mesh/status` 的 `pendingTaskList` 每行带 `requester`/`requesterSessionId`、`injectedAtTurn`/`sameTurnInjected`/`baselineTurn`，`lastReceipt.deliveredTo` 是实际投到的会话 id。

**同一轮内注入多个任务（0.7.9 收紧）**：`queue` 任务的 prompt 各占一个后续回合，所以同一开放轮内先后注入的第二个任务会等到更晚的一轮（`baselineTurn` 按同轮队列位次+1），**不会被第一个任务的 `turn/end` 带走**；位次判断不确定时宁可保持 pending（等 `receiptStallMs` 报 `not-started`），也不发假回执。`steer` 仍按插入当前轮处理。

> 回执只走**本机** inject，绝不推到 hub；`receiptTo` 解析不到时只写文件并置 `lastError`，不会去打扰别的会话。日志与回执里没有 token、密钥。

## 任务库（0.7.11）

派活的任务正文与生命周期会落盘，事后可查「这单到底要求了什么」，也能把 task → 回执 → 目标会话串起来。

**存储**（`~/.dsh/mesh-waker/`，0600）：

- `tasks.jsonl`：append-only，一行一条；字段 `taskId / batchId / requester / targetSessionId / targetTitle / subject（正文首行 ≤120 字）/ textBytes / createdAt / deadlineMs / status / settledAt / durationMs / receiptRef / receiptSummary / refs[]`；
- 正文 ≤8 KiB 直接存 `text`；>8 KiB 落 `tasks/<taskId>.md`，jsonl 只记 `textPath`；
- **保留策略**：`tasksRetentionDays`（默认 30 天）与 `tasksMaxRows`（默认 5000 条），启动时按「超龄或超量」裁最旧的，并压实 jsonl（被裁任务的正文文件一并清理）；
- **正文隐私**：日志只打 `textBytes` 与 `subject`，**从不打印正文**；列表 API 不含正文，只有详情 API 返回全文。

**API**（仅本机 loopback）：

| 端点 | 用途 |
|---|---|
| `GET /mesh/tasks?status=&session=&batch=&limit=&offset=` | 列表（不含正文；默认 `limit=50`、`createdAt` 倒序、返回 `total`；`session` 同时匹配目标会话与 requester） |
| `GET /mesh/tasks/:id` | 详情：全文 + 回执摘要（`receiptSummary`/`receiptRef`）+ 目标会话 `{sessionId, title, live}` |
| `DELETE /mesh/tasks/:id` | 仅 `pending` 可取消（→ `cancelled`）；已 settled/stalled 返回 **409**，历史不改写 |

**状态流转（0.7.14 起含 `started`）**：派活写 `pending` → 目标会话的 `turn/start` 且该 turn 归属此任务时写 `started`（含 `startedAt`）→ 结算写 `settled`（补 `settledAt/durationMs/receiptRef/receiptSummary`）；超时未动写 `stalled`（即回执的 `not-started`）；`DELETE` 或批次取消写 `cancelled`。取消/停滞可以发生在 `pending` 或 `started`。**`durationMs` 口径**：任务库的 `durationMs` 从 `startedAt` 算起（未被观测到开始的从 `createdAt` 算），回执里的 `durationMs` 仍从投递时算。`refs[]` 由派活方经 `meta.refs` 传入（只存字符串，waker 不解析 `.worklog`）。

**面板**：任务面板在「Mesh 信箱」页面顶部标签「派活任务」里（与「信箱」并列）；设置页只保留一行跳转说明。**左右分栏**：左栏按批次聚合（组头 `B-xxx · done/total · 总耗时`，可折叠；无 batchId 归「未分组」置底），行内 `ID / 状态 / 耗时(人读) / 目标会话`；右栏为选中任务详情（创建→开始→结束时间线、正文全文、回执摘要、refs、打开会话/取消任务），空态「选择左侧任务查看详情」；窄屏（<900px）退化为上下布局。顶部统计 `pending/进行中/今日完成/停滞`，支持状态与目标会话过滤；右栏 tab 顶部还有一条「派活任务：N 条待办/进行中」入口摘要。入口名可用 `entryLabel` 配置（默认 `Mesh 信箱`）。

## 设置页（0.7.13）

设置页按功能分五章、每章可折叠：**接入**（中枢登记/控制台/唤醒端口/接入向导占位）、**唤醒行为**（信任级别、投递方式、`maxWakes`、`resetAfterHours`、启动补收、投递模式、发送方指定、按设备信任）、**界面**（`entryLabel`、收件箱目录、本机会话归档）、**任务与回执**（回执状态、任务库保留策略、去任务面板）、**维护**（本地缓存、清缓存、轮换令牌、右栏状态）。

- **可编辑**：`saveConfig` 白名单内的字段（`trust` / `delivery` / `maxWakes` / `resetAfterHours` / `catchUpOnStart` / `boundDeliveryMode` / `allowSenderDeliveryMode` / `workspacePath` 等）在 UI 里直接改，保存走 `POST /mesh/config`，成功提示「已保存」、失败显示服务端原文；保存后重新拉 `/mesh/status`，控件值以服务端为准。
- **只读**：不在白名单里的项（如 `entryLabel`、`tasksRetentionDays`、`tasksMaxRows`）灰显并在 tooltip 标注「需改配置文件并重启」，不做成假可编辑。
- 布局：每行 flex（`min-height:32px`、`gap:16px`），标题/说明 `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`，控件 `flex-shrink:0`，完整文本放行级 `title`。

## 批次与进度判定（0.5.2）

**batch**：一次派 N 单，全部结束才通知一次。`dsh-mesh-dispatch` 加 `--batch [id]`（同 id 的多次调用归同一批，不带值自动生成 `B-<base36>`）与 `--deadline 2h|90m|600s`：

```bash
npx dsh-mesh-dispatch --title "<session-title>"  --file t1.txt --batch B-20261029 --deadline 90m
npx dsh-mesh-dispatch --title "<session-title>" --file t2.txt --batch B-20261029
```

批次内单任务**不单独打扰**（回执按 `file` 处理），只有聚合回执走 `barrierMode`：

```
[BATCH] B-20261029 3/3 done in 42m
✅ T-114 hub bootstrap        8m  completed
❌ T-115 waker pull          12m  error(provider_error)
⏳ T-116 docs onboarding         not-started
```

JSONL：`{kind:"batch", batchId, tasks:[{taskId,status,durationMs,summary}], startedAt, endedAt, done, total}`。deadline 到点仍有未结 → 发一次「部分完成」聚合，未结项带**当前 liveness**；随后清批次。

**liveness**：每个会话从事件流派生状态（`session/event`），判定顺序固定：

| state | 判据 | detail 示例 |
|---|---|---|
| `not-started` | 有 pending 任务但从未收到 `turn/start` | `no turn/start since injection` |
| `lost` | 插件重启时 pending 仍开着（多半打断了回合） | `plugin restarted while the turn was open` |
| `waiting-approval` | 有未决 `approval/asked` | `bash 2m` |
| `waiting-job` | 有未结算 `job/registered` | `job-7 1m` |
| `waiting-tool` | 有未返回 `tool/call` | `read_file 3m` |
| `stalled` | turn 开着、无 job/approval/tool 且静默超过 `stallQuietMs` | `quiet 6m (turn 4)` |
| `idle` | `openTurn === null` | — |
| `working` | 其余（turn 开着且有近期事件） | `turn 4` |

批次进行中，某任务处于 `stalled`/`waiting-approval`/`waiting-job` 且已挂起超过 `waitLongMs` → 发**一次** `[BATCH-ALERT]`（同批次同任务同状态只发一次），**不结算**该任务，批次继续等 `turn/end` 或 deadline。

| 键 | 默认 | 说明 |
|---|---|---|
| `stallQuietMs` | `300000` | 静默多久判 `stalled` |
| `waitLongMs` | `1800000` | 挂起多久发「挂了很久」提醒 |
| `batchDeadlineMs` | `7200000` | 批次兜底 deadline |
| `barrierMode` | `wake` | 聚合回执投递方式 `file|queue|wake` |
| `alertMode` | `queue` | 中途告警方式 |
| `batchFile` | `~/.dsh/mesh-waker/batches.json` | 批次持久化（0600，启动恢复，>24h 清理） |

HTTP（loopback）：`GET /mesh/batches`、`GET /mesh/batches/<id>`（含每个任务的 liveness）、`DELETE /mesh/batches/<id>`（取消，不再回执）。

## 本机会话协作（不经过中枢）

同机、同一个 DSH 里的多个会话可以直接互相派活：waker 在 `127.0.0.1:8795` 暴露会话发现与注入接口，全程本地、毫秒级、离线可用。所有端点**只接受 loopback 请求**。

| 端点 | 作用 |
|---|---|
| `GET /mesh/sessions` | 列出本机会话（按最后活动排序）：`id` / `title` / `cwd` / `workspace` / `last_active` / `live` / `archived`。分页参数 `limit`（默认 80，夹取到 1–500）、`offset`（默认 0）、`archived`（`1`/`0`/省略）、`cwd`（精确匹配）、`q`（标题子串，大小写不敏感）；响应含 `{ ok, total, limit, offset, sessions }`，`total` 是过滤后总数。`?live=1` 仍只返回未归档会话 |
| `POST /mesh/inject` | 向已有会话投一轮任务：按 `session`（完整 id）→ 精确标题 → 标题唯一子串寻址；歧义或找不到返回 400。`mode` 为 `queue`（默认，等当前回合）或 `steer`（打断当前回合） |
| `POST /mesh/sessions/create` | 新建会话并绑定工作区，可选首轮 `prompt`；返回 `sessionId` / `workspaceId` / `workspacePath` / `prompted` |
| `POST /mesh/sessions/archive` | 归档会话：日志保留、侧栏隐藏；存活的会话会被宿主拒绝（`workspace/session-active`） |
| `POST /mesh/sessions/delete` | 删除会话：支持 `session`（id，可省略 `session-` 前缀）或 `title`（精确/唯一子串）寻址，标题歧义返回 400 并列出候选；先停掉在跑的 agent（`sessionController.cancel` + 宿主 dispose 钩子），摘掉 `conversations.json` 里指向它的绑定，再删会话目录；停不下来的返回 **409**，不会假报成功 |

可直接复制：

```powershell
# 1. 看看有哪些会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 2. 给某个会话派活（按标题寻址；同名会 400 而不是随便挑一个）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' -d '{"title":"hub 文档维护","text":"列出 README 与实现不一致处，只列不改"}'

# 3. 新建执行会话并立刻投首轮任务（cwd 指向具体仓库根）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/create -H 'content-type: application/json' -d '{"title":"<session-title>","cwd":"<workspace>","prompt":"先读 hub/README.md，列出与 docs 不一致处"}'

# 4. 归档 / 删除（都按完整 id）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/archive -H 'content-type: application/json' -d '{"session":"session-…"}'
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/delete -H 'content-type: application/json' -d '{"session":"session-…"}'
```

`delete` 只删 waker 能发现的会话（目标必须出现在 `GET /mesh/sessions` 里），不接受路径；`inject`、`archive`、`delete` 都支持 `session`（id）或 `title`（精确 / 唯一子串）寻址，歧义时返回 400 并列出候选。

细节与约定见 [docs/local-sessions.md](https://github.com/kaniol-lck/dsh-mesh/blob/main/docs/local-sessions.md)；端点验收：`node test/waker-endpoints.test.js`。

## 多会话分工（任何项目可用）

派活能力长在插件里：装了 waker 的项目，模型可以直接调 `mesh_dispatch` 工具，CLI 也行——**不需要**本仓的 `dsh-mesh-dispatch`。

**3 步示例**（任何项目根目录）：

```bash
# 1. 看本机有哪些会话（?live=1 只看未归档；id/title/archived 都在返回里）
curl.exe -s "http://127.0.0.1:8795/mesh/sessions?live=1"

# 2. 派活（带 taskId 才会写回执；同一批用同一个 batchId，全部结束只叫一次）
dsh-mesh-dispatch --target "<session-title>" --file task.txt --task --batch B-20261030 --deadline 90m
# → sent session=session-… task=T-mf3k… batch=B-20261030

# 3. 读回执（默认 ~/.dsh/mesh-waker/receipts.jsonl；批次的聚合行 kind="batch"）
tail -n 2 ~/.dsh/mesh-waker/receipts.jsonl
```

模型入口（工具）参数与 CLI 一一对应：

| 工具参数 | CLI | 说明 |
|---|---|---|
| `target`（必填） | `--target` | 会话 id、完整标题或唯一标题子串 |
| `text`（必填） | `--text` / `--file` | 原文投递，≤64 KiB；注入时正文前会加一行 `[TASK <id> · BATCH <id> · FROM <requester>] <时间>` 表头（`injectHeader:false` 可关），账本里可直接引用该 taskId |
| `createIfMissing` | `--create` | 解析不到时按 `target` 当标题**新建会话**再投递（新会话用 `sessionCwd`/默认工作区） |
| `mode` | `--mode` | `queue`（默认，等当前回合）或 `steer`（打断） |
| `taskId` | `--task [id]` | 不传自动 `T-<base36>`；不带值也自动生成 |
| `batchId` | `--batch [id]` | 同批次 barrier：全部结束只回执一次 |
| `receipt` | `--receipt` | `file`/`queue`/`wake`，覆盖插件默认 |
| `deadline` | `--deadline` | `30m`/`2h`/`600s`，默认 `batchDeadlineMs` |
| `subject` | `--subject` | 任务库/面板显示的可读标题（≤120 字）；省略时由正文首行清洗（优先加粗片段、去掉 `任务（…）：`/`【…】` 前缀与 `**`） |

工具描述里明确写了：投递后**不要轮询等待**，插件会在回合结束时写回执；要「全部完成再叫我」就用同一个 `batchId`。

**任务 ID 会随正文交给会话**：注入到目标会话的正文前有一行 `[TASK <id> · BATCH <id> · FROM <requester>] <本地时间>` 表头（默认开启，`injectHeader: false` 关闭），正文本身逐字不变；会话可以直接在自己的账本/WORKLOG 里引用该 taskId，不用再从派活正文里猜。

**自查工具是否注册成功**：`GET /mesh/status` 的 `tools` 字段给出 `{dispatch, ask}` 两个布尔值，失败原因在 `toolsError`（例如 `host exposes no tools service`）。工具注册会等待宿主 tools 服务就绪（最多重试 5 次、每次 500ms），每次成功/失败都写一行到 waker 日志；模型说「工具未注册」时先看这两个字段，不要猜。

```bash
# 新建一个执行会话并投第一单（--create 的典型用法）
dsh-mesh-dispatch --target "worker-a" --create --text "先读 README，列出与实现不一致处" --task --batch B-a
```

CLI 只依赖 Node 内置 `fetch`，通过 `--waker` 指向本机 waker（默认 `http://127.0.0.1:8795`）；连不上时退出码 2。

## 主题路由（topics，0.5.7）

远程不掌握本机的会话 id，也不该掌握：**用稳定标签投递**，由 waker 在本机解析成当前匹配的会话。

```yaml
# cordis.patch.yml / 插件配置
topics:
  - label: "ops/frontend"       # 对外的稳定标签，也用作 conversation
    titlePattern: "web 运维"     # 本地解析：标题唯一子串（也接受精确标题）
    allowFrom: ["dsh-kaniol-pc"] # 可选：只允许这些 peer 投递；空/缺省=不限制
    mode: "queue"                # 可选，默认 queue；steer 插当前轮
```

远端（跨机）发消息时把 `conversation` 写成标签即可：

```json
POST /api/send { "to": "<本机 agent 名>", "conversation": "ops/frontend", "body": "…" }
```

行为与边界：

- **自动绑定/重绑**：启动时和每次投递前按 `titlePattern` 找未归档会话（精确或唯一子串）；绑定的会话被归档/删除后，下次投递自动改绑到新会话。解析不到只记 `topic unresolved label=… pattern=…`，不报错，落回原有「收件箱 / 按 conversation 新建」兜底。
- **不覆盖手工绑定**：`/mesh/bind` 绑到仍存活会话时，topic 不会改动它。
- **allowFrom**：非空时只允许名单里的 sender；其他人投递**不注入**、消息留在收件箱未读，本地日志记 `topic denied label=… peer=…`。这是投递闸门，不是收件箱规则——agent 仍能在收件箱看到它。
- **标签校验**：`^[a-z0-9][a-z0-9/_-]{1,40}$`；非法或重复的 label 启动时 WARN 并忽略该条。
- **对外最少暴露**：`GET /mesh/status` 只给 `topics: [{ label, bound, lastDeliveredAt }]`，**不含会话 id/标题**（本地细节看 `/mesh/admin/bindings`）。会话 id 是内部句柄且易失，运维会话能执行 shell，暴露 id 等于开放提权面。
- **零配置兼容**：不配 `topics` 时行为与 0.5.6 完全一致。

## 远程审批（approvalBridge，0.6.0）

人不在电脑前时，让 DSH 的审批请求走 mesh：危险命令触发 `approval/request` → waker 给 owner 的 peer 发一条**静默消息** → owner 回 `approve` / `deny` → 命令放行或被拒。

```yaml
approvalBridge:
  enabled: true                 # 默认 false：不配就完全不接管（零影响）
  to: 'dsh-kaniol-pc'           # 审批请求发给谁
  allowFrom: ['dsh-kaniol-pc']  # 只接受这些 sender 的回复；空=只通知、不接受回复
  timeoutSeconds: 120           # 超时后 next() 交回本地提示框，绝不自动放行
  conversationPrefix: 'approval/'
  pollMs: 2000
  diag: false                   # true 时打印请求字段名/类型（不含命令全文），用于核对内核形状
```

消息长这样（`conversation: approval/<callId 前 8 位>`，`silent: true`）：

```
【审批请求】bash · 会话「mesh · hub」
摘要：run a dangerous command
request_id：call-12345678
回复方式：approve 放行 / deny 拒绝（只回一个词即可）。
120s 内未回复则转本地提示框；超时不会自动放行。
```

- **判定**：`approve/allow/同意/批准/放行` → `allowed-once`；`deny/reject/拒绝/不同意/驳回` → `rejected`；同时出现两边词或其它内容 → **rejected（fail-closed）**。
- **超时**：一律 `next()` 透传本地提示框——不自动放行，也不静默拒绝。无人值守时误杀一个长任务比多问一次更糟。
- **为什么 silent**：唤醒 agent 等于把「批准权」交给可能被注入的 agent；silent 只落收件箱，`allowFrom` 之外的人回复会被忽略并保持未读。
- **防自批**：审批会话（`approval/` 前缀）由 bridge 独占消费，pull 循环不会把它注入任何会话；bridge 正在等待的会话会跳过消费，避免抢答。
- **审计**：每次决定写一行 `approval decision call=… by=… outcome=… ms=…`，不含命令全文。

## 向人提问（mesh_ask / questionBridge，0.7.0）

**提问是商量，不是安全闸门**：危险命令放行仍走 approval（fail-closed）；`mesh_ask` 只承载「发不发版 / 选哪个方案 / 继续还是停」这类协调决策，超时返回**未回答**，绝不替调用者挑默认值。

```yaml
questionBridge:
  enabled: true                # 默认 false；控制 user-questions 接缝与默认收件人
  to: 'dsh-kaniol-pc'
  allowFrom: ['dsh-kaniol-pc'] # 只接受这些 peer 的回复；空=不等待，直接 unanswered
  timeoutSeconds: 300          # 1–3600（建议 ≥30）
  pollMs: 2000
  conversationPrefix: 'question/'
  diag: false
```

模型侧直接调工具（也可只传 `to`，不依赖 enabled）：

```js
mesh_ask({
  question: '这版要不要现在发到 npm？',
  options: ['现在发', '等 CI 绿了再发', '先不发'],
  timeoutSeconds: 300,
})
// → { status: 'answered', answer: '等 CI 绿了再发', by: 'dsh-kaniol-pc', ms: 41230, questionId: 'q-…' }
// 超时 → { status: 'unanswered', timeoutSeconds: 300, questionId: 'q-…' }
```

- **消息**：`silent: true`（不唤醒任何 agent）、`conversation = question/<id 前 10 位>`，正文是问题 + 编号选项 + 「回 1/2/3 或直接回复文字」+ 超时说明。
- **回答**：纯数字命中选项 → 返回该选项文本；否则原样返回文字（去首尾空白、截 2000）。
- **超时**：`unanswered`，不带任何选项；调用方自己决定怎么继续。
- **隔离**：`question/` 会话由提问工具独占消费（claim + read），pull/push/catch-up 都不注入、不建会话；桥在发送**之前**就登记该会话，避免消息落库瞬间被常规 wake 抢走。`allowFrom` 外的回复忽略并保持未读（日志 `question ignored`，按消息去重）。
- **遗留清理**：历史上被误建的 `mesh · question/…` 会话（0.7.3 之前）请运营者手工归档；插件不会自动删除，以免误删真实会话。
- **可选接缝**：运行时若存在 `ctx.userQuestions` 服务才挂 `user-questions/request`（形状不认识或超时一律 `next()` 交回本地 UI）；没有接缝只记一行 `user-questions seam absent; mesh_ask only`，工具照常可用。插件**不 import** `@deepseek-ai/dsh-user-questions` 或 `dsh-user-approval`，缺包不影响加载。

### `/mesh/status` 的待办字段（0.7.2）

运营者不用翻日志就能发现「现在有东西在等我」，`GET /mesh/status`（仅本机）新增：

| 字段 | 形如 | 说明 |
|---|---|---|
| `pendingQuestions` | `[{conversation, askedAt, expiresAt, preview, options}]` | 正在等待回答的 `mesh_ask` 问题；`preview` 单行 ≤80 字符；回答或超时后自动消失；无则为 `[]` |
| `pendingApprovals` | `[{conversation, askedAt, expiresAt, preview, toolName}]` | 正在等待决定的审批请求；`preview` 形如 `bash · <摘要>`；无则为 `[]` |

两个字段都只在本机 status 输出里；`conversation` 可以直接用来在收件箱里定位原消息（问题/审批消息本身仍按各自桥的隔离规则处理）。

## 日志与取证（0.7.5）

- **路径**：默认 `<tmpdir>/mesh-waker.log`（重启/清临时目录会丢）；生产建议 `logFile: ~/.dsh/mesh-waker/waker.log`。
- **滚动**：单文件超过 `logMaxBytes`（默认 2 MiB）时改名为 `<logFile>.1`，新文件从空开始；只保留 1 份历史，不引第三方库。
- **状态**：`/mesh/status` 的 `logFile` / `logBytes` 可直接确认「插件在写、写在哪、多大」。
- **定位重复报错**：

```bash
grep -c "pull failed" ~/.dsh/mesh-waker/waker.log     # 同类错误出现次数
tail -n 50 ~/.dsh/mesh-waker/waker.log                # 最近上下文
```

## 面板操作（0.7.6）

设置页「本机会话」列表（数据来自 `GET /mesh/sessions`）：

- **归档可见**：`archived: true` 的行置灰（opacity 0.55）并显示「已归档」标签，不给归档按钮；
- **归档操作**：活跃会话行有「归档」按钮，调 `POST /mesh/sessions/archive`，成功后刷新列表；
- **删除只走 CLI**：面板**不提供删除**，避免误删会话目录。需要删除时用
  `curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/delete -H 'content-type: application/json' -d '{"session":"session-…"}'`
  （标题寻址也支持，歧义会 400 并列候选）。

**已知限制（宿主无归档移除 API）**：插件可见的 `ctx.workspaceRegistry` 只有 `archiveSession` / `deleteKnown` / `archivedSessionIds`，没有 unarchive 或从归档集合删除 id 的接口（`unarchiveSession` 只在 workspace-controller 的命令/远程面，插件拿不到）。因此删除一个**已归档**会话后，宿主归档集合里会永久留着那个 id；waker 用本地 tombstone（`~/.dsh/mesh-waker/archived-tombstones.json`，0600）在 `/mesh/sessions` 输出里把它减掉——删除后归档视图不再显示该 id；若同一 id 被重新归档，tombstone 自动清除。

## 依赖

中枢本体见 [hub/](https://github.com/kaniol-lck/dsh-mesh/tree/main/hub)，Docker 一条命令即可起：

```bash
cd hub && cp .env.example .env && docker compose up -d --build
```

## 许可

MIT

## 跨机消息绑定（`/mesh/bind`）

这条路径**只服务跨机来件**：hub 把消息 ping 给 waker，若该 `conversation` 有 `deliverTo`，waker 直接把 wake prompt 投进那个会话（默认 `mode: 'queue'`，像用户打字一样排队），而不是另起/复用「Mesh 收件箱」会话。

> **本机会话之间不要用这套。** 同机派活走 `/mesh/inject`（命令行：`npx dsh-mesh-dispatch --title "<session-title>" --file task.txt`，需要唤醒时加 `--wake`）——毫秒级、离线可用，不必让消息绕中枢一圈。

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
    { "conversation": "conv/wake-verify", "panelSessionId": "session-…", "deliverTo": "session-…", "wakes": 1, "title": "conv/wake-verify" }
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


