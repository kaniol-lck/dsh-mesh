# dsh-mesh 仓库约定（给在这个工作区里干活的会话）

本仓是 **dsh-mesh 的唯一开发源**。私有镜像仓在 `..\transfer`，只做下游同步。

## 目录与归属

| 路径 | 内容 | 允许改它的会话 |
|---|---|---|
| `hub/` | 中枢服务、控制台、鉴权 | mesh · hub |
| `plugins/mesh-waker/` | DSH 唤醒插件 | mesh · waker |
| `plugins/mesh-approval/` | Hermes 侧审批桥（Python 插件，把危险命令审批转进 mesh 收件箱） | **mesh · hub** |
| `docs/`、根 `*.md` | 文档 | mesh · docs |
| `scripts/`、`test/` | 工具与测试 | 对应功能负责人 |
| `skills/mesh/` | 给 agent 的协作说明 | mesh · docs |

**不允许**跨目录顺手改：需要别的目录时，让协调会话派给对应执行会话。

## 会话纪律

1. **cwd 必须是本仓根**（`public/` 这一层，即 clone/检出目录）。不要用包含 `public/` 与 `transfer/` 的上级目录，否则相对路径找不到文件。
2. 相对路径一律以本仓根为准：`hub/README.md`、`plugins/mesh-waker/index.js`。
3. 提交只 `git add` 自己负责的路径；commit message 写**为什么**，不要只写“更新”。
4. 不 `git push --force`；不提交凭据、token、`.npmrc`（`scripts/check-secrets.py` 是门禁）。
5. 发版动作（`npm publish`、部署 hub 到 NAS）**必须先得到 owner 确认**。
6. 待办写 `.worklog/todo/<自己>.md`，任务/故障/发版日志写 `.worklog/WORKLOG.md`，整套 `.worklog/` 不入库（明细只留在本地）。跨域条目**必须**写 `归属：<会话>`（缺了 `node scripts/roadmap.mjs --check` 只 WARN，不阻塞）。**`状态：进行中` 必须带 `归属` 与 `进展：YYYY-MM-DD`（≤14 天），否则按待办处理并 WARN。**
7. 工作日志的格式、目录与收尾检查见 `docs/worklog.md`。
8. 改完自己的 todo **直接跑 `node scripts/roadmap.mjs --write`**（**任何会话都可以跑**：它只重算仓外的派生文件与 `.worklog/roadmap.html`，不属于越界写入）；收尾 `node scripts/roadmap.mjs --check` 必须退出 0，`node scripts/check-paths.mjs` 也必须退出 0。`--check` 同时校验版本一致性，报 `version drift` 时先对齐 `HUB_VERSION` 与 `package.json`，不要手改生成段。

## 缺陷回流（协调会话）
1. 只在有证据时触发：同类问题 ≥2 次 / 一次故障让既有约定失效 / 检查脚本反复卡同一处。
2. 动作：记 WORKLOG 一行 → 若是约定缺口，产出 AGENTS.md 或 docs/worklog.md 的补丁（含证据行与收尾验证办法）。
3. 约定变更必须先报 owner 批准，批准后由 docs 落盘、协调会话记 WORKLOG；禁止静默改约定。
4. 统计口径固定为 `node scripts/defects.mjs --scan --threshold 3`；同类 ≥3 条标 READY FOR PATCH，才起草补丁。**READY 只看确定源**（`DEFECT:` 行 + **未归口**的跨会话重复对；双方都标了 `归属` 的重复登记只计数）；工具失败归 fail-log-guide，`--with-fail-log` 只作参考，不计入 READY。

## 跨域发现（所有会话）
1. 同域问题写自己 todo；跨域但只需改文件时，只写一条 `归属：<会话>` 的 todo，派活由协调会话统一做。
2. 跨域只读核对可直接问对端，并在 todo 标「已直连确认」。
3. P0 / 安全 / 阻塞自己：立即 inject（本机 8795）或 mesh（跨机）报协调会话。
4. 例外：对方唯一能解且卡住你时可直连，但必须抄送协调会话一行（问了什么、对方怎么回）。
5. 不跨机直接派活。

## 自测与生产中枢

允许直接对生产中枢（`https://<CLOUD-IP>:<EDGE-PORT>` 或内网 `http://<NAS-IP>:8790`）跑自测，但必须统一管理（真实地址见本地 `.worklog/ops/transport-security.local.md`，不入库）。测试口径：单元/集成测试默认用临时实例（临时端口 + 临时数据目录，不碰生产数据）；端到端验收允许打生产中枢，但按下面四条管理。

1. **命名前缀**：自测创建的 agent 必须以 `selftest-` 或 `test-` 开头（例：`selftest-enroll-20261029`）；生产节点禁止使用这两个前缀。
2. **当场清理**：测试结束立刻 `DELETE /api/admin/agents?name=<名>&purge=1` 连行删除；确实需要留证据时，在 WORKLOG 记 `SELFTEST: <名> · <用途> · <保留到何时>`。
3. **登记一行**：每次对生产中枢自测，在 `.worklog/WORKLOG.md` 顶部记 `SELFTEST: <名> · <用途> · <结果>`，便于事后对账。
4. **巡检兜底**：`mesh · ops` 每日巡检会列出「`selftest-`/`test-` 前缀 + 已吊销或离线超过 24h」的节点；发现即 purge 并在报告里记一行，不需要等人批准（测试残留不是生产数据）。

消息、黑板、blob 等测试写入生产中枢时：用带时间戳的 key/主题（`test/<日期>/…`），并在 WORKLOG 登记；不要在 `board` 用生产 key。

## 决策路由（谁能拍板）

判据：**不越界**（只影响本会话产出，不改别人文件/对外契约/版本号）+ **不阻塞别人** + **可记录**，三条全满足才可自行决定。

1. **必须走协调会话**：阻塞型问题（不问就干不下去且影响交付）、约定/流程变更、版本号、凭据与轮换、发版与部署、跨会话排期、两个会话可能各自决定同一件事。
2. **会话自行决定**：非阻塞且不越界的选择（测试形态、内部命名、日志字段顺序、单文件内重构、文案措辞的默认取值），做完写 `DECISION:` 行即可，不必打断 owner。
3. **可直问 owner**：必须 owner 拍板但不影响别人 —— 可在该会话直接问，**同时抄送协调会话一行**（问了什么、owner 怎么定）。
4. **记录义务（最重要）**：无论走哪条路，决定必须落一行到 `.worklog/WORKLOG.md`：
   `DECISION: <一句话决定> · <谁定的：owner / <会话>> · <YYYY-MM-DD> · <影响面>`。
   没有这一行 = 没有决定；协调会话每轮收尾会 grep `DECISION:` 汇总。
5. **冲突处理**：若直问得到的决定与既有约定/记录冲突，以「时间较晚 + 已记录」为准，并由该会话抄送协调会话回写 AGENTS/todo。

## 派活账本（协调会话维护）

协调会话每派一单，在 `.worklog/dispatch/queue.md` 记一行：编号 / 会话 / 任务 / 派出时间 / 期望产物 / 状态。

状态机：`dispatched` → `started`（可选）→ `committed`（有 commit）→ `deployed`（需上生产才算完）→ `done`。

三条核对规则：
1. 超过 **30 分钟**仍停在 `dispatched`/`started`，且该会话 `last_active` 在动 → 协调会话直接问「卡在哪」，**不许靠猜**；
2. `committed` ≠ 可用：需要部署的单必须等到 `deployed`，否则按「代码进了仓库、生产还是旧镜像」处理（本机已发生过一次：hub 新端点全部提交但生产仍是旧版）；
3. `mesh · ops` 巡检第 10 项会列出超过 30 分钟未 `committed` 的条目，作为兜底告警。

执行会话**不需要**维护这个文件；你们的 `todo/<自己>.md` 与 commit 就是账本的证据来源。派活正文里若写明「期望产物」，账本会照抄该列，便于对账。

## 唤醒协调会话（本机）

- 本机唤醒**只用 inject**：`node scripts/mesh-dispatch.mjs --wake --title "mesh · 协调" --file .worklog/dispatch/<主题>.txt`；不要为本机唤醒去调 hub/mesh。
- 触发门槛（满足其一才叫）：P0 / 安全；需要 owner 决策；阻塞自己 ≥30 分钟；任务完成且结论会影响别人下一步。
- **不唤醒**：普通进度、「我做完了」、todo 更新、例行问答 —— 写进 `.worklog/todo/<自己>.md` 与 `WORKLOG`，协调会话下一轮会扫到。
- 正文首行必须是 `[WAKE] <一句话摘要>`，细节写后面；一次任务最多叫一次；等回执期间不要重复叫（`--wake` 对同一目标 + 同一正文 60 秒内自动去重）。
- 跨机来件才走 mesh（由 waker 的 conversation 绑定决定落到哪个会话），本机会话之间不绕中枢。
- **回复不等于送达**：`/mesh/inject` 是单向投递（响应只有 `{ok, sessionId, title, mode}`，不含回复正文），你的回复**不会**自动回到协调会话。需要协调会话行动 → 必须 `--wake`；只是记录 → 写 `.worklog/todo/<自己>.md` 与 `WORKLOG`。
- **例外**：只有派活正文里明确写了「本轮不用叫我，我会读 X 文件」时，才可以省略唤醒。
- **上报前复检**：准备 `--wake` 之前，先重跑一次判定命令（`node scripts/roadmap.mjs --check`、`node scripts/check-paths.mjs`、`curl …/health` 等）；如果已经绿了，就**只写文件、不唤醒**，并在报告里记一句「复检时已恢复（<时间>）」。判定类告警有竞争，复检能压掉空唤醒。复检**不豁免**「门禁红必须上报」——复检仍红才唤醒，仍是必须；复检只重跑**判定命令**，不重跑整轮巡检；如果连续两次复检都在红与绿之间跳（例如两个会话互相改 todo 造成抖动），照常唤醒，并在正文里写明「抖动」而不是自己压着。

## 本机运维会话（mesh · ops）

- **做什么**：本机 DSH 部署态巡检（只看**本项目部署面**，见下）、令牌轮换、owner 的日常配置修改项。**不是**缺陷、**不是**功能请求——那两类仍走协调会话派给 hub / waker / docs。
- **巡检范围（只看本项目部署面）**：hub `/health` 与版本一致性、waker `process/disk/stale`、8790/8795/3654 端口、三道门禁（roadmap / check-paths / defects）、未推送提交、hub 容器状态与项目日志、`hub/data` 与插件目录所在卷余量（**低于 1G 才报**）。**不巡检** NAS 全局容量与其他卷、SMB 映射、路由器等家庭网络面（那些归 `lan-ops` / 其他会话）。
- **上报门槛**：以下情形**必须立即** `--wake` 协调会话——`roadmap --check` drift、`check-paths` / secrets 失败、版本不一致（`HUB_VERSION` ≠ `package.json`、`/health` ≠ 仓库、waker `stale=true`）、端口不通或 hub 不可达、任何 P0 / 安全发现；**只有全绿或纯观察项才只写文件不唤醒**。一句话：**会让别人的门禁变红或服务不可用，就叫人；只是记录就写文件。**
- **边界**：只读仓库文件；可写 `.worklog/ops/**`、`.worklog/todo/ops.md`、本机 `~/.dsh/**`（改前备份、写回滚说明）；不改代码、不 push、不 publish、不部署、不重启（除 owner 批准）。
- **怎么找它**：按标题 `mesh · ops` inject：`node scripts/mesh-dispatch.mjs --wake --title "mesh · ops" --file .worklog/dispatch/ops.txt`；精确 session id 见 `.worklog/ops/session.md`（机器本地，不入库）。

### 发现 token 泄露怎么办

- **第一动作**：立刻 inject `mesh · ops`（`[WAKE]` 首行），只写「哪个键疑似泄露、怎么发现的、影响范围」；**不要在消息里重复 token 值**，也不要贴日志原文里的凭据片段。
- ops 负责：确认范围 → 用 vault 里的 admin token 走中枢轮换 → 更新本机 vault 对应键 → 验证旧 token 401 / 新 token 可用 → 回报「键名 + 已更新 + 验证结果」。
- 任何人不得自行把新 token 贴进对话；轮换后由 ops 在 `WORKLOG` 记一行（不含值）。
- 若泄露源是提交进仓库的：同时 inject 协调会话，由协调会话决定是否 `git filter-repo`（历史改写需 owner 批准）。

## 多会话派活

协调会话通过 waker 的本地接口派活（不需要中枢）：

```powershell
# 看本机会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 派给某个会话（Node fetch，正文从文件读）
node scripts/mesh-dispatch.mjs --title "mesh · hub" --file .worklog/dispatch/hub.txt
```

**不要用 `Invoke-RestMethod` / `ConvertTo-Json` 发任务正文**（会把多行字符串收成 `[object Object]`）。

**派活必须带回执**：`mesh_dispatch`（或 CLI）要带 `taskId`；多单用同一 `batchId`，全部结束才唤醒一次。
不带 taskId = 放弃回执，只能靠翻 git log 猜完没完。

**回执是线索，产物才是证据**：收到 `status=completed` 必须核对产物 —— commit 确实存在、目标文件/接口确实改了、
测试数对得上、部署后 `/health` 或 `process` 版本确实变了。**不得仅凭回执宣布完成**。
（已发生过：任务注入时目标会话正在跑上一轮，上一轮的 `turn/end` 被误记为本任务完成。）

**派活前先看目标会话忙不忙**：`GET /mesh/batches` 或 `/mesh/status` 的 `pendingTasks`；若目标在 `working`，
要明确知道「这条会排队到下一轮」并据此调整预期，不要往同一条队列里叠太多单。

细节见 `docs/multi-session-playbook.md`。

## 与镜像仓的关系

- 改动**只在本仓发起**；
- 需要同步时运行 `python scripts/sync-to-transfer.py`（默认 dry-run，加 `--apply` 才写）；
- `transfer/` 里的 `refs/`、`skills/lan-ops/`、`docs/plugin-release.md` 是私有内容，同步不覆盖。
