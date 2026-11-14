<!-- drift: waker=* hub=* owner=docs -->
# 本机参考实现（`refs/`）—— 看过什么、借鉴/拒绝什么

> 2026-11-14 · 本文件是**唯一**的参考登记处（owner 定：收敛到 `docs/reference/`，仓根 `REFS.md` 废止）。
> `refs/` 目录本身仍在本机、被 `.gitignore` 忽略，**不随仓库分发**；本文件只记结论，不复制其中代码。
> 要复制代码时，按 `docs/third-party` 约定补 URL + commit + license。

## 记录规则

| 问题 | 这里怎么答 |
|---|---|
| 为什么拉它 | 一节「为什么拉它」，写当时的缺口 |
| 看了什么 | 概念对照表 / 取了哪几个文件 |
| 借鉴还是拒绝 | 「可借鉴清单」与「不借鉴」，拒绝的必须写原因 |
| 代价多大 | 一句形态描述（文件数 / 体量 / 许可），够判断值不值得再拉一次 |

---

## refs/dsh-superagent-prototype

| 项 | 值 |
|---|---|
| 来源 | https://github.com/deepseek-ai/dsh-superagent-prototype |
| commit | `6337fc8 feat: add the dsh-superagent research prototype` |
| 许可 | 仓库自带 LICENSE（MIT 风格，以仓库为准） |
| 拉取时间 | 2026-10-31 23:0x |
| 用途 | DSH 团队《Super-agent 设计探索》的参考实现；对照我们的 waker / 任务库 / 关口设计 |
| 形态 | TypeScript 单体插件，216 文件（`src/` 下 core/app/sources/executor/client），65 个测试文件 |

### 它是什么

面向**单个 GitHub 仓库**的主动式编码 agent，打包为 DSH bundle：
Source（Feishu / GitHub 事件源）→ Trigger → Thread → **Eval（gate + assessment 两层判定）** → **Mandate（授权记录）** → **Ticket（授权工作单元）** → **Assignment（绑定到 Executor 实例）** → Executor（DSH Session + 每 Ticket 一个目录）。

### 与我们概念对照

| 它的概念 | 我们的对应物 | 差距 |
|---|---|---|
| Trigger | 派活消息 / hub 消息 | 同构 |
| Thread | `conversation` / topic label | 当时没有 Thread 身份；后续消息仍经协调会话 |
| Subscription（Ticket ↔ Thread 多对多） | 计划中的"topics 升级" | 当时未实现 |
| Policy（版本化判定规则 + 各 Source 准入表） | 门禁脚本 + 信任档 | 我们只有 Fast Path，无版本化策略记录 |
| Eval（gate + assessment 两层） | 「该不该派/派给谁」靠人判断 | 缺 Slow Path |
| **Mandate**（这次工作被授权的依据：策略版本/范围/强度/命中规则/发送者身份） | **无**——信任是环境变量式存在 | **值得借鉴**：授权应当是可追溯的记录，不是隐式状态 |
| **Ticket** | 任务库 `tasks.jsonl` | 我们有了任务库；但 Ticket 状态**跟随会话回合**，它明确**拒绝**这一点 |
| Assignment（Ticket ↔ Executor 多次绑定） | `targetSessionId` 单一绑定 | 缺"同一任务换会话接手"的模型 |
| Channel（Thread 的写侧） | 回信 / 回执 | 只有回执，无"往原 Thread 回写" |

### 它明确**拒绝**的概念（对我们是警示）

- **「Ticket 状态跟随 DSH Session」**——Ticket 可被交接、恢复、由多个 Executor 执行；我们的任务状态正跟随回合，后来确实由此产生了假回执问题。
- **「用报告的自由文本推断"在等人"」**——分类需要结构化事实；我们的 `stalled` 判据也应基于结构化字段。
- **「Policy 变更时取消正在跑的 Ticket」**——会留下半成品；变更应被记录而非追溯取消。
- **「把 Executor Session 的全部工具锁死」**——会拒绝人直接在会话里工作。

### 可借鉴清单（按当时优先级）

1. **Mandate**：任务落库时记录"凭什么授权"（信任档 + 来源 + 命中规则），使越权可追溯；
2. **Subscription 多对多**：Thread 订阅而非"派一次"；
3. **Eval 两层**：程序 gate（已有）+ 语义 assessment（可配置提示词策略）；
4. **Assignment 可多次**：任务可换会话接手（对应"交接"需求）；
5. **Channel 写侧**：回执之外，支持"往原 Thread 回写"。

### 不借鉴

- 绑死单仓库、Feishu/GitHub 事件源的形态（我们是多工作区 + 本地会话）；
- 它的部署/迁移体系（`app/migration.ts` 45KB）——我们规模不需要。

---

## refs/dsh-official-ui

| 项 | 值 |
|---|---|
| 来源 | DSH 安装目录 `resources/app.asar` 内的官方客户端包（非开源仓、非 npm） |
| 版本 | 随本机 DSH 安装（当时 `app.asar` 182MB / 18234 个条目） |
| 许可 | 随 DSH 二进制分发；**仅作本机只读参考，不得再分发** |
| 抽取时间 | 2026-11-04 01:0x |
| 工具 | 自建 asar 解析器 `.worklog/bin/asar-extract.mjs`（不依赖 electron/asar） |
| 用途 | **UI 风格对齐的权威来源**：令牌真值、官方设置页与侧边栏的真实实现 |

### 为什么拉它

owner 反馈「让协调会话改 UI 经常做不到风格统一」。查证后根因不是审美，而是**插件层没有可参照的官方实现**：

- npm 上**不存在** `dsh-client-ui-primitives`（实测 404）；
- 安装目录 `app.asar.unpacked` 只有原生 `node_modules`，没有前端资源；
- `dsh --help` 没有导出/解包子命令。

于是自建 asar 解析器，直接从安装包里取。asar 里共有 **55 个** `dsh-client-ui-*` 官方包。

### 取了哪几个（只取与本项目 UI 相关的）

| 包 | 用途 |
|---|---|
| `dsh-client-ui-theme` | **602 个 `--dsw-*` 令牌的真实取值**（`lib/client.js` 内 `design_platform_css_default` 字符串）← 最重要 |
| `dsh-client-ui-settings-models` | 「模型提供商卡片」的官方实现（卡片/内嵌区结构） |
| `dsh-client-ui-settings-shell` | 设置页外壳 |
| `dsh-client-ui-settings-plugins` | 插件设置页（本插件的卡片渲染在这里） |
| `dsh-client-ui-sidebar` / `-sidebar-right` | 左右侧边栏与 tab 注册的官方实现 |
| `dsh-web-frontend/dist/assets/index-*.css` | 外壳样式表（77KB，含 `--dsw-radius-lg` 等 13 处用法） |

### 拿它做什么 / 不做什么

- **做**：把我们 `client.js` 里 `TOKENS` 的**兜底值**对齐官方静态值；卡片/内嵌区结构照官方组件对齐；hub 控制台用同一套语义值。
- **不做**：不直接 import 官方包（插件运行时拿不到，只能 `require('react')`）；不再分发这些文件；不把它们的代码抄进仓库（`refs/` 已 gitignore）。
- **只读核对**（2026-11-14，T-474）：同一套方法也用来枚举宿主端点——**普通 `node`/`rg` 读 asar 内文件报 `os error 3`**，必须用 `ELECTRON_RUN_AS_NODE=1 "<DSH 可执行文件>" <script.mjs>`；产物见 `dsh-endpoints.md`（55 个 waker 端点 + 26 个 Session Remote 方法）。该轮**没有抽取任何文件**，`refs/` 无变化。

---

## 不用拉进 `refs/` 的来源

外部网页/文档（Anthropic、Magentic-One、Prometheus、Google SRE 等）不需要本地副本：结论与 URL 记在 [README.md](README.md) 的条目里，可外部核对，避免仓库里存一份会过期的副本。
