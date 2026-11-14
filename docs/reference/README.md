<!-- drift: waker=* hub=* owner=docs -->
# 参考资料索引（reference）

> 维护者：L1 参考资料与评估（`mesh · L1 参考资料与评估`）。
> 入库标准：**每条都能脱离本机核对**——URL + 抓取日期 + 与本仓的关系 + 可直接复用的结论。
> 「我读过」不算条目；没有可复用结论的链接也不进索引。

## 怎么用

- **要做一件事之前**：先在「索引」里找同类，读「可复用结论」，别重新发明（与全局约定「先找现成，再想沉淀」同一条纪律）。
- **引用格式**：正文引用结论时带条目 id（`REF-001`）与原 URL，不只写来源名，方便别人回查。
- 「关系」列只有三种取值：`同构`（我们已在做的事，别人有更成熟的做法）、`反例`（别人踩过的坑，我们正在踩）、`未采用`（看过，明确不照搬，写清原因）。

## 索引

| id | 主题 | 来源 | 抓取日期 | 关系 | 可直接复用的结论 |
|---|---|---|---|---|---|
| REF-001 | 多 agent 委派契约 | [How we built our multi-agent research system · Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) | 2026-11-14 | 同构 | 委派必须带目标 / 输出格式 / 可用工具与来源 / 任务边界四件；缺了就会出现重复劳动与漏项。多 agent 比普通对话多耗约 **15×** token（单 agent 约 4×），所以「多拆一个角色」的成本是数量级的 |
| REF-002 | 监督者 + 双账本 + 空转检测 | [Magentic-One: A Generalist Multi-Agent System（arXiv:2411.04468）](https://arxiv.org/abs/2411.04468) | 2026-11-14 | 同构 | 外层 **task ledger** 存全局计划与事实，内层 **progress ledger** 每步自问五问：完成了吗 / 在打转吗 / 有进展吗 / 谁下一步 / 问什么；超出阈值就重规划。这是「孤儿任务」与「重复开工」的机械解，不靠人盯 |
| REF-003 | 告警分级 / 去重 / 抑制 | [Alertmanager · Prometheus](https://prometheus.io/docs/alerting/latest/alertmanager/) | 2026-11-14 | 同构 | 相似告警**合并成一条**通知；根因告警在响时**抑制**症状告警（inhibition）；按标签**路由**到不同接收方；静默要带匹配器与时限，重复提醒用 `repeat_interval` 节流 |
| REF-004 | 值班指挥与执行分离 | [Managing Incidents · Google SRE Book 第 14 章](https://sre.google/sre-book/managing-incidents/) | 2026-11-14 | 同构 | 指挥者**不修问题**（分工可递归、可再委托）；必须有可读的实时状态文档，交接要显式确认「你现在是指挥」。单一指挥者不收窄输入量就会变成瓶颈 |

## 本索引支撑的评估

| 评估 | 用到的条目 | 结论 |
|---|---|---|
| [three-layer-comparison.md](three-layer-comparison.md)（三层结构参照评估，2026-11-14） | REF-001 / REF-002 / REF-003 / REF-004 | 有条件做：改工具（brief 产物字段、在飞视图、红线分级），不改分层 |

## 逐条说明

### REF-001 委派契约（Anthropic）

- **它是什么**：orchestrator-worker 形态的研究系统，lead agent 拆解任务并派给并行 subagent。
- **与本仓的关系**：`dispatch-brief.mjs` 就是我们的「委派契约」，`subject`/`expect`/`text` 三件对应目标与判据；但**没有**输出格式（产物路径）与边界（不许改哪些路径）的结构字段。
- **可复用结论**：①委派描述含糊 → subagent 做同样的搜索（文中实例：一个查 2021 汽车芯片、两个重复查 2025 供应链）；②同步等待是瓶颈——lead 不能 steer、subagent 之间不能协调；③subagent 产出落文件、只回传轻引用，避免「传话游戏」。
- **代价线索**：同一文给出的 token 倍数是判断「值不值得多拆一层」的唯一量化依据。

### REF-002 双账本与空转检测（Magentic-One）

- **它是什么**：一个 Orchestrator + 专用 agent（WebSurfer / FileSurfer / Coder）的通用系统，Orchestrator 维护 task ledger 与 progress ledger 两个账本。
- **与本仓的关系**：我们的 `queue.md`（派活账本）+ `verify-task` / `progress-watch` 是**同一对账本的低配版**：账本有了，但缺「按工作区聚合的在飞视图」和「空转计数」。
- **可复用结论**：把「团队是不是在打转」变成每步必答的结构化问题，并给阈值；plan 更新时清空各 agent 上下文，避免旧计划污染。

### REF-003 分级、去重、抑制（Alertmanager）

- **它是什么**：Prometheus 生态的告警路由组件，职责是 dedup / grouping / routing / inhibition / silence。
- **与本仓的关系**：`digestDelivery`（合并成一条 `[TASK-DIGEST]`）≈ grouping；`mesh_ack` ≈ silence（但**没有时限、没有匹配器**）；`l2-scan` 的红线唤醒 ≈ routing（但**只有一条路由**：全部给 L2）。
- **可复用结论**：告警的价值不在「送达」，而在「只把可行动的那一条送到人手上」；抑制规则比合并更能降噪，因为它处理的是根因-症状关系。

### REF-004 指挥与执行分离（Google SRE）

- **它是什么**：事故响应把角色拆成 Incident Command / Operational Work / Communication / Planning 四类，允许递归委托。
- **与本仓的关系**：L2 异常协调 ≈ 指挥 + Planning（只裁决与安排，不代做）；L3 worker ≈ Ops（唯一动系统的人）；`workspace lock` 是「Ops 是唯一改生产的人」的结构化版本。
- **可复用结论**：①指挥者一旦下场修 bug 就丢失全局视野，这是**明确写在书里的反模式**；②「指挥者持有所有未委托的职位」——所以 L2 只有在有人接走日常事务时才薄得下来；③交接要显式确认，不能靠「以为对方知道了」。

## 待补的空白（本仓当前最缺）

| 空白 | 为什么重要 | 下一步 |
|---|---|---|
| DSH 插件机制（Cordis、`ctx`、`sessionController`、`agents`）的官方文档与样例 | 任何 waker / approval 侧改动都要靠它；现在只能读本机安装包与既有插件代码 | 找公开文档或可引用的官方样例；没有公开来源就退回「本机安装包 + 自有插件」并标注不可外部核对 |
| 任务队列的失败语义（重投、死信、幂等） | 对应我们 `error`/`lost` 回执与「同号多行互相污染」 | 优先找 SQS DLQ / Temporal 一类的一手文档，落 `REF-005+` |
| 多 agent 的成本与规模数据 | 判断「再加一个 L1 值不值」需要量级，不是感觉 | 从 REF-001 已拿到 15× 这个锚点，后续补横向对比 |

## 维护规则

- 新增条目：先加表格一行（id 顺延），再补「逐条说明」一段；两处缺一不可。
- 外部来源抓取失败时**如实标注**取证方式（例：本机直连被拒、内容来自检索摘要），不要写成「已读原文」。
- 条目被推翻（来源过时、结论被本仓实测否定）时**不删**，标 `状态：已过时` 并写推翻证据——索引的价值在于可追溯。
