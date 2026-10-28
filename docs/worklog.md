# 工作日志约定

**本文件入库；日志数据在 `.worklog/`（已 gitignore），永不提交。**

执行会话把待办、派活载荷和滚动日志写在本地 `.worklog/`；约定正文只维护这一份，避免与本地副本漂移。

## 目录结构

| 路径 | 用途 |
|---|---|
| `.worklog/WORKLOG.md` | 滚动日志，倒序，新条目加在**顶部** |
| `.worklog/todo/<会话>.md` | 各会话的待办清单（`hub` / `waker` / `docs`） |
| `.worklog/archive/YYYY-MM.md` | 月度归档，整月日志搬入 |
| `.worklog/dispatch/` | 派活载荷（纯文本任务正文），可随时删 |

本文件在 `docs/` 下，是唯一入库的约定；`.worklog/` 整个目录不入库。

## 待办：`.worklog/todo/<会话>.md`

每个文件首行固定，更新条目时同步改日期：

```
<!-- session: <名> · updated: YYYY-MM-DD -->
```

条目一行一条，字段顺序固定；`归属：<会话>` 放在行尾，**跨域条目必填**（说明这条该谁做），同域可省略（缺省=条目所在文件的会话）：

```
- [P0|P1|P2] <标题> —— <一句话说明>；验收：<可验证标准>；状态：未开始|进行中|已完成；归属：<会话>
```

解析按 `；` 拆段：只有段首是 `验收：` / `状态：` / `归属：` 的才算字段，其余拼回说明（说明里本身可能含 `；`）。

规则：

- 每个执行会话**只写自己的** `.worklog/todo/<自己>.md`，协调会话不改别人的文件（只读、汇总）；
- 待办完成就改状态与验收结论，不要另起文件；过期的直接删或用 `.worklog/archive/` 归档；
- 标题用一句话说清动作，说明写“为什么/影响面”，验收必须可被命令或肉眼逐条核对。

## 自动汇总与渲染

`scripts/roadmap.mjs` 把 todo 汇总进仓外 ROADMAP（只替换标记之间的自动段），并渲染本地 HTML：

```powershell
node scripts/roadmap.mjs --write   # 重写 ROADMAP 自动段 + .worklog/roadmap.html
node scripts/roadmap.mjs --check   # 只比对：一致 0 / 漂移 1 / 缺标记 2
```

- `<!-- AUTO:TODO START -->` 与 `<!-- AUTO:TODO END -->` 之间整段由脚本生成，**手改会被覆盖**；标记外内容原样保留；
- 产物位置：ROADMAP 在仓外（默认 `<仓根>/../ROADMAP.md`，可用 `--roadmap` 指定），HTML 在 `.worklog/roadmap.html`（已忽略，本地打开）；
- `--check` 比较时忽略 `<!-- generated:` 时间行，因此刚 `--write` 完必须退出 0；它也是收尾检查的一部分；
- **已完成条目只在「已完成」节单列**：P0/P1/P2 分组只列未完成，头部计数 `P0/P1/P2（未完成） + 已完成 = 总数`；
- `--check` 还会核对 `.worklog/roadmap.html` 的 `src=` 源哈希：ROADMAP 一致但 HTML 缺失/过期时只打印 `WARN`，退出码仍为 0（HTML 是附属产物）。

## 汇总：协调会话 → `..\ROADMAP.md`

- **不再手工抄写**：跑 `node scripts/roadmap.mjs --write`，脚本把 `.worklog/todo/*.md` 的明细写进 ROADMAP 的自动段；
- ROADMAP 只放**阶段目标与取舍**（「本阶段焦点」「发布状态」等手写段由协调会话判断），明细（验收、状态、归属）留在本地 todo 文件；
- 执行会话不直接改 ROADMAP。

## 滚动日志：`.worklog/WORKLOG.md`

任务完成 / 故障 / 发版时，在 `WORKLOG.md` **顶部**追加一行（倒序）：

```
YYYY-MM-DD HH:mm · <会话> · <动作> · <产物或 commit>
```

- 发版、部署那行必须注明「owner 确认」与确认时间；
- 没有确认记录的发版视为违规，事后补记也要写明是补记。

## 缺陷台账

反复出现的问题先记账，够数才动约定；脚本**不会自动改约定**。

- 确定源（决定 READY）：`.worklog/WORKLOG.md` 里的 `DEFECT: <签名> · <域> · <证据> · <blocking:yes|no>` 行（字段可缺，缺了记 `?`），以及 roadmap 标出的跨会话疑似重复**对**（一对算 1 条；**双方都标了 `归属` 的重复登记不算缺陷**，只有未归口或状态冲突的对计入 READY）；
- 推断源（只计数，不决定 READY）：WORKLOG 里命中 `修复|漂移|坑|失败|超时|不一致` 的行，台账里标 `?`；
- 统计：`node scripts/defects.mjs --scan --threshold 3` 生成 `.worklog/defects.md`（本地文件，不入库）；`--json` 只打印不写文件，`--taxonomy` 打印词表；
- 某签名**确定性**次数 ≥ threshold 时才标 `READY FOR PATCH`（推断源永不触发）：到了才起草约定补丁 → owner 批准 → docs 落盘 → 协调会话记 WORKLOG 一行；
- 工具失败归 fail-log-guide，默认**不纳入**台账；`--with-fail-log` 只把去重后的错误签名列进「工具失败（参考）」节，不计入 READY；
- `DEFECT:` 进料目前是**建议不是强制**：先观察两轮真实进料量，再决定要不要升级为硬性要求。

## 收尾检查

- `git status` 必须干净：`.worklog/` 全部被忽略，不会出现在 status 里；`git ls-files .worklog` 应为空；
- `node scripts/roadmap.mjs --check` 必须退出 0（1=漂移、2=缺标记），否则先 `--write` 再复查；
- 不要把 `.worklog/` 下任何文件加入暂存区（不要用 `git add -A`，也不要 `git add -f`）；
- 需要把日志带进交接包/镜像仓时，导出摘要到 `docs/`，不要整体拷贝本目录。
