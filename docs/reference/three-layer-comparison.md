<!-- drift: waker=* hub=* owner=docs -->
# 三层结构参照评估：L1 出活 / L2 异常 / L3 worker

> 2026-11-14 · 作者：`mesh · L1 参考资料与评估` · 这是**评估**，不是实现；建议条目落在 `.worklog/todo/eval.md`，由 L1 综合管理派单。
> 外部结论一律带 URL + 抓取日期，可脱离本机核对；本仓事实一律带命令或文件位置。

## 结论（一句话：有条件做——改工具，不改分层）

1. **分层站得住，不是自创**：L1/L2/L3 与三类成熟结构同构——orchestrator-worker（Anthropic Research）、监督者 + 双账本（Magentic-One）、值班指挥与执行分离（Google SRE）；三者都把「派活的人」「动手的人」「异常归口」拆开。
2. **两个已知失败模式我们已有实例**：「L1 互不知道对方在做什么」（同一测试文件 1 分钟内被两个会话各改一次、`T-434` 双号）与「告警不分级」（所有红线都叫 L2）。前者已用脚本取号 + workspace 锁做成结构，后者**还只靠约定**。
3. **缺的是信息面，不是层级**：缺「谁在做什么」的共享视图、缺空转检测、缺告警分级与抑制。三条建议全部落在 `.worklog/bin/`（L1 工具区），不动 `plugins/`、`hub/`，可单条回滚。

## 一、事实基线：我们现在的三层

| 层 | 会话 | 结构位置 | 已有机制（可当既有事实引用） |
|---|---|---|---|
| L1 | `mesh · L1 综合管理` | `workspaces.json.coordinator`（primary） | `dispatch-brief.mjs`（原子取号 / workspace 锁 / 网络重试 / 自动记账）、`verify-task.mjs`、推送与 CI 核验 |
| L1 | `mesh · L1 参考资料与评估` | 普通成员 | 本文件、`docs/reference/` 索引 |
| L2 | `mesh · L2 异常协调` | `.worklog/dispatch/wake-target.txt`（`l2-scan` 红线唤醒目标） | `l2-scan.mjs`（收单即扫 + 日检 + 红线唤醒，同组 6 小时防抖）、`rotate-session` + 交接件 |
| L3 | `docs` / `waker` / `hub` / `ops` | 按 `TH-<role>` 线程订阅 | 回执（`receipts.jsonl`）、`digestDelivery`（queue 落板，空闲 3s 合并一条 `[TASK-DIGEST]`）、`mesh_tasks` / `mesh_ack` |

三个不值得重造的既有事实（评估它们时直接用）：

- **锁是建议性的**：`workspaceLockTtlMs` 默认 600000（10 分钟），只串行「会改 git」的任务，不阻塞读；撞锁默认立刻退出 3，把「等还是换」交回人（`plugins/mesh-waker/index.js` 配置项 + `dispatch-brief.mjs --help`）。
- **digest 是合并而非阻断**：`digestIdleDebounceMs` 默认 3000；`ack` 只是板标记，不产生回执，任务只有 worker 主动 `mesh_complete` 才结算。
- **验收与初筛分离**：`progress-watch` 只判「有没有产物」，`verify-task` 出机械事实，好坏由 L1 判——这条与 Anthropic「别把回合结束当任务完成」是同一个教训。

## 二、外部可对照结构

### 2.1 委派契约：orchestrator-worker（Anthropic，2025-06-13）

- **它是什么**：lead agent 拆解任务、并行派给 subagent，subagent 各自持有独立上下文，最后回传发现。
- **对应我们的什么**：`dispatch-brief.mjs` = 委派契约；L1 = lead；L3 = subagent；`expect` = 验收判据。
- **实测结论（原文）**：每个 subagent 需要「目标、输出格式、工具与来源指引、清晰的任务边界」；否则**重复劳动、漏项、找不到信息**。作者给的具体实例是：一个 subagent 查 2021 汽车芯片危机，另外两个重复查 2025 供应链。我们的 brief 目前只有 `subject`（目标）/ `expect`（判据）/ `text`（正文），**没有输出格式（产物路径）与边界（不许改哪些路径）的结构字段**。
- **失败模式**：①委派含糊 → 重复；②**同步等待**——lead 等一组 subagent 完成才能继续，期间不能 steer，subagent 之间也不能协调，单个慢 subagent 能卡住全队；③成本：单 agent 约 4× token，多 agent 约 **15×**。
- **对我们的量化含义**：多拆一个 L1/L2 不是线性代价；「再加一层」必须有明确收益，不能靠感觉。

### 2.2 双账本与空转检测（Magentic-One，MSR 2024-11-07）

- **它是什么**：一个 Orchestrator + 专用 agent（WebSurfer / FileSurfer / Coder / ComputerTerminal）的通用系统。
- **对应我们的什么**：Orchestrator = L1 综合管理；外层 **task ledger**（全局计划与事实）= 我们的 `queue.md` + `WORKLOG.md`；内层 **progress ledger** = 我们的 `verify-task` / `progress-watch`。
- **可复用结论**：progress ledger 每一步必答五个问题——**任务完成了吗 / 团队在打转吗 / 有进展吗 / 下一个该谁说话 / 要问什么**；打转计数超阈值就跳出内层、更新 task ledger 重规划。这是把「孤儿任务」「重复开工」变成机械判据，而不是靠人盯。
- **失败模式**：①Orchestrator 是单点，它卡住则全队停；②每次重规划要清空所有 agent 上下文，否则旧计划污染新执行；③它自己也会被「看似有进展」骗过——所以计数必须由结构化事实（产物、回执、文件）提供，不能由报告文本判断。

### 2.3 分级、抑制与指挥分离（Alertmanager + Google SRE）

- **Alertmanager（Prometheus）**：核心职责 dedup / grouping / routing / inhibition / silence。相似告警合并成一条通知；**根因告警在响时抑制症状告警**；按标签路由到不同接收方；静默带匹配器与时限；重复提醒用 `repeat_interval` 节流。设计目标是「只把可行动的那一条送到人手上」。
- **Google SRE 事故管理**：角色拆成 Incident Command / Operational Work / Communication / Planning，分工可递归委托；**指挥者不修问题**（书里明确的反模式）；必须有可读的实时状态文档；交接要显式确认「你现在是指挥」。
- **对应我们的什么**：L2 = 指挥 + Planning（只裁决、只安排，不代做）；L3 = Ops（唯一动系统的人）；`workspace lock` 是「Ops 是唯一改生产的人」的结构化等价物；`digestDelivery` = grouping；`mesh_ack` ≈ silence（**但没有时限、没有匹配器**）；`l2-scan` 红线唤醒 = routing（**但只有一条路由：全部给 L2**）。
- **对我们的含义**：「L2 变成瓶颈」不是我们独有的问题，SRE 的解法不是「让 L2 更快」，而是 ①**缩小送进来的量**（routing + inhibition）②**允许再委托**（L2 判完把活退回 L1）③**显式交接**（rotate-session 已有交接件与确认语义）。

## 三、失败模式对照

| 失败模式 | 别人的处理 | 我们现状 | 判定 |
|---|---|---|---|
| 委派含糊 → 重复劳动 / 漏项 | 强制四件套（目标 / 输出格式 / 工具 / 边界） | brief 有目标与判据，**缺产物与边界字段**；`verify-task` 的 artifacts 只在回执自带清单时才检查，否则 SKIP | **缺口（建议 1）** |
| L1 互不知道对方在做什么 | task ledger 是全队单一事实源（Magentic-One） | `queue.md` 人工维护，按会话的 waker 台账分散；实测已出现同文件 1 分钟内被两次改写、`T-434` 双号 | **缺口（建议 2）** |
| 团队在打转 / 无人认领 | progress ledger 五问 + 打转计数（Magentic-One） | 有 `unacked ≥2 次` 红线与 `progress-watch` 初筛，但**没有「同一单反复派/无产物」的计数** | 部分 |
| 告警不分级 → 收件人过载 | routing tree + inhibition + severity（Alertmanager） | 所有红线都 `--wake-l2`；无 severity、无抑制 | **缺口（建议 3）** |
| 指挥者下场修问题 → 丢全局视野 | 明确反模式 + 指挥者持有未委托职位 | L2 边界已写死（「只给裁决与落账，不代做」），但**没有机械判据**，靠自觉 | 有防线，弱 |
| 单点：L2 离线无人接 | 显式交接 + 备岗 | `rotate-session` 有交接件；L2 无副手、无超时升级 | 部分 |
| 同步等待卡全队 | Anthropic 承认这是瓶颈，异步是已知代价 | L1 等回执照样卡；digest 只减少了往返次数 | 结构性，暂不改 |

## 四、我们缺什么（别人有 / 我们没有）

| 能力 | 别人 | 我们 | 差距等级 |
|---|---|---|---|
| 委派四件套（含产物路径、边界） | Anthropic 必需 | brief 缺两件 | 高（成本最低） |
| 共享「在飞任务」视图 | Magentic-One task ledger | 账本有，聚合视图无 | 高 |
| 打转计数 / 重派检测 | progress ledger + 阈值 | 无 | 中 |
| 告警分级（page / ticket） | Alertmanager routing | 单一路由 | 高 |
| 根因抑制症状 | inhibition | 无 | 中 |
| 静默带时限与匹配器 | silence | `ack` 永久生效、只按 taskId | 中 |
| 值班交接确认 | SRE 显式 handoff | 交接件 + 脚本，无确认回执 | 低 |

**反向清点：这些我们有而别人没有**（别被「别人更成熟」带偏）——①取号与锁是**脚本写者**而非约定，撞号从约定变成结构；②「回执 ≠ 完成」被拆成初筛 + 机械清单 + 人工判断三段；③`digest` 在空闲窗口合并，不打断正在跑的回合。

## 五、建议（3 条，均有机械验收）

### 建议 1：`dispatch-brief` 增加 `artifacts` 字段，`verify-task` 优先从派单登记读

- **做什么**：brief 增 `artifacts: string[]`（仓库相对路径，≤10），派单时写进 `queue.md` 该行与正文表头；`verify-task` 的 artifacts 检查顺序改为「回执清单 → 派单登记 → `--expect-artifacts`」，都没有才 SKIP。
- **为什么**：目前 worker 不回执 artifacts 时，验收项直接 SKIP——「当事人无从自查」的典型形态（取不到就当 0，结论看起来完全合理）。
- **归属**：`.worklog/bin/dispatch-brief.mjs` + `.worklog/bin/verify-task.mjs`（L1 工具区，不碰 `plugins/`）。
- **验收**：①`dispatch-brief --help` 列出 `artifacts`；②派一单带 `artifacts:["docs/x.md"]` 且 worker 不回执 artifacts，`verify-task --task <id>` 输出 `[FAIL] artifacts 缺失`；③补上文件后同命令 `[PASS]`；④不带 artifacts 的老单仍 SKIP（不回退）。

### 建议 2：派发前打印「同工作区在飞任务」，把派活账本变成共享视图

- **做什么**：`dispatch-brief` 在真实派发与 `--dry-run` 时都打印 `inflight[]`——来自 `queue.md` 中同 workspace、状态为 `dispatched|started` 的行（可选叠加 waker `/mesh/tasks`，不可达时降级不报错）；`--json` 输出同名字段。
- **为什么**：同文件被两次改写（2026-11-13）不是纪律问题，是**没有共享视图**；锁只保护「会改 git」的任务，文档类并行改同一文件仍会撞。
- **归属**：`.worklog/bin/dispatch-brief.mjs`。
- **验收**：①在 `queue.md` 造两条 `started` 行（不同会话），`--dry-run` 输出含这两条 id；②`--dry-run` 仍零写盘（`git status --short` 不变、`.alloc-reserved` 不变）；③无在飞任务时输出 `inflight: []` 而非缺字段。

### 建议 3：`l2-scan` 红线分级 + 抑制，只有 `page` 才唤醒 L2

- **做什么**：每条红线带 `severity: page|ticket`（page = 门禁红 / hub 不可达 / 安全 / P0；ticket = unacked 超时、轮换建议、CI 慢红）；根因红线在响时给症状红线打 `inhibitedBy`；`--wake-l2` 只对 page 生效，按根因 id 去重。
- **为什么**：现在「所有红线 → 一个会话」，L2 的输入量没有上限，这就是 SRE 书里说的指挥者过载；抑制规则比合并更能降噪，因为它处理的是**根因-症状**关系。
- **归属**：`.worklog/bin/l2-scan.mjs`。
- **验收**：①`--json` 每条红线含 `severity`（`inhibitedBy` 为可选字段）；②用 fixture 注入「hub 不可达 + 3 条 worker 超时」→ 输出 1 条 page + 3 条 ticket（`inhibitedBy` 指向 hub 条目），`--wake-l2` 只触发 1 次；③移除 hub 条件后 3 条 worker 项变为 page（证明可恢复，抑制不是永久静音）；④`--help` 写清分级口径。

## 六、明确不采用

| 候选 | 为什么不 |
|---|---|
| Alertmanager 式多级 routing tree（按标签、按接收方、按时间段） | 我们只有 3 类角色 + 1 个 L2，树状路由的复杂度换不来收益；做到「page/ticket 两级」就够 |
| SRE 的四角色（IC / Ops / Comms / Planning）全量照搬 | 每多一个角色就多一份 15× 量级的协调成本（REF-001），3 人团队摊薄上下文反而更差 |
| Magentic-One 的「每步清空上下文」 | 我们靠会话隔离 + 交接件达到同类效果，清空会丢正在跑的工具结果 |
| 事件总线替代 digest | 现有 `digestDelivery` 已验证（queue 落板 + 空闲 3s 合并），换总线属重写而非改进 |

## 七、证据

**外部来源**（抓取日期均为 2026-11-14）：

- REF-001 <https://www.anthropic.com/engineering/multi-agent-research-system>（2025-06-13；本机直接抓取 HTTP 200，正文含「Without detailed task descriptions, agents duplicate work」「Synchronous execution creates bottlenecks」「15× tokens」原句）
- REF-002 <https://arxiv.org/abs/2411.04468>（2024-11-07 提交；摘要页 HTTP 200。task ledger / progress ledger 五问与打转阈值见正文 §3 与 HTML 版）
- REF-003 <https://prometheus.io/docs/alerting/latest/alertmanager/> 与 <https://prometheus.io/docs/alerting/latest/configuration/>（本机直接抓取 HTTP 200；含 grouping / inhibition / silence / `repeat_interval`）
- REF-004 <https://sre.google/sre-book/managing-incidents/>（**取证方式：检索结果页摘要**——该域本机直连两次失败，按「抓取失败一次即换路」未重试；原文公开可访问，关键句为「Recursive Separation of Responsibilities」与「a clear separation of responsibilities allows individuals more autonomy」）

**本仓事实**（命令 / 文件）：

| 事实 | 出处 |
|---|---|
| brief 字段与判定口径、退出码 | `node .worklog/bin/dispatch-brief.mjs --help`（0 成功 / 1 brief 非法 / 2 网络 / 3 撞号） |
| artifacts 当前只在回执里生效，否则 SKIP | `.worklog/bin/verify-task.mjs` 的 artifacts 分支 + `--help` |
| 锁 TTL 10 分钟、digest 空闲 3s | `plugins/mesh-waker/index.js` 的 `workspaceLockTtlMs` / `digestIdleDebounceMs` 默认值 |
| 红线单路由 + 同组 6 小时防抖 | `.worklog/bin/l2-scan.mjs --help` |
| 同文件两次改写、`T-434` 双号 | 仓库 `AGENTS.md`「三层结构与 L1 直派」小节的依据行（2026-11-13 实测） |
| 回执对刷放大（15 分钟 35 单 / 18 回执 / 63KB） | `.worklog/WORKLOG.md` 2026-11-01 行 |

**本次自检**：`node scripts/check-docs-links.mjs` → 死链 0；`node scripts/check-paths.mjs` → OK；`node scripts/check-docs-drift.mjs` → 本文件（`waker=* hub=*`）不参与漂移判定。
