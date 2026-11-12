<!-- drift: waker=* hub=* owner=docs -->
# 多主线并行：工作树约定（C 案采纳版）

本文采纳外部文档《dsh-mesh 多主线并行工作树约定（C 案）》的骨架，并修掉原稿与本仓现状不一致的三处
（基线分支、登记位置、账本共享）。目标：多条主线同时推进时，**一个主线一个工作树一个分支**，
互不把对方的提交带偏；合并只在窗口内发生。

- 分支模型：`docs/team-repo-governance.md`、`AGENTS.md`「分支模型」。
- 共享工作树纪律（B+C）：`AGENTS.md`「共享工作树纪律」。

## 1. 基本规则

1. **一主线一工作树一分支**：每个并行主线（一条 `feature/*`、`bugfix/*` 或 `release/*`）一个 git worktree，
   树内只待在自己的分支上。
2. **基线用 `dev`**：本仓 `dev` 已存在（`b0cd506` 起），所有功能/修复分支从 `dev` 切出，合回 `dev`；
   `main` 只做发布合入。原稿里的「dev 占位写法」不适用。
3. **工作树目录**：`<项目根>/wt-<主线>`（例：`dsh-mesh/wt-queue-obs`），与主工作树平级、不嵌套。
4. **worker 不切分支**：树内会话只在自己分支上工作；切分支/合并由协调在合并窗口执行。

## 2. 登记（不要写 queue.md）

工作树登记放 **`.worklog/dispatch/worktrees.md`**（人读表格），**不要写 `queue.md`**：
`queue.md` 是 `scripts/queue-sync.mjs` 从 `dispatch/queue/<sessionId>.md` 生成的聚合视图，手改会 drift，
`queue-sync --check` 会红。

建议列：`主线 | 分支 | 工作树路径 | 会话 id | 创建日期 | 状态 | 备注`。
状态机：`active → merging → done`（`done` 时同时 `git worktree remove`）。

## 3. 账本共享（禁止 worktree 独立账本）

`.worklog/**` 是 gitignored 的本地账本，**不进 git**，因此 worktree 里不会自动出现；也**禁止**让 worktree
生成独立账本（会分叉成两份 todo/ROADMAP）。

两种做法二选一：

- **junction（推荐，Windows）**：在 worktree 根建目录联接指向主树账本：
  `cmd /c mklink /J <worktree>\.worklog <主树>\.worklog`（目录联接，不是符号链接；`mklink` 需要非管理员也可用 `/J`）。
  之后 worktree 里的 `roadmap.mjs` 读写的都是主树同一份账本。
- **显式主树路径**：不建 junction，跑 `node <主树>/skills/worklog/scripts/roadmap.mjs --write --worklog-dir <主树>/.worklog --out <主树>/../ROADMAP.md`，
  始终显式指向主树；不要让默认相对路径把产物写进 worktree。

生成物（`.worklog/roadmap.html`、`.worklog/board.html`）同样只保留主树一份；worktree 里若生成过，
拷回主树或在主树重跑一次 `roadmap --write`（见 `AGENTS.md`「共享工作树纪律」C④）。

## 4. 跨 worktree 派活 = 跨区

工作树会话与主树会话不在同一工作区，派活按**跨区**处理：`taskId` 必须 `<PREFIX>-<日期>-<序号>`
（例：`DMSH-20261112-01`），不能再用裸 `T-NNN`——`local/tasks.jsonl` 是跨区共用文件，裸号会静默覆盖。
派活正文写清工作树路径、分支、基线 `dev`。

## 5. 合并窗口（锁）

合并是唯一会改动主树分支的动作，必须在**主工作树**上加锁：

```text
mesh_lock acquire workspace=dsh-mesh ttl=<计划合并时长 × 2> reason="merge wt-queue-obs -> dev"
  # 合并（squash 到 dev，或 --no-ff 到 main；按 team-repo-governance.md）
mesh_lock release workspace=dsh-mesh
```

- 锁是 advisory：读不受影响，新的「会改 git」派活排队等待；
- TTL 取计划时长的 2 倍，避免合并中途锁过期；
- 合并完成后立即释放，不把锁留在常态。

## 6. 生命周期

```text
创建：git worktree add ../wt-<主线> -b <分支> dev  → 登记 worktrees.md（active）
开发：树内会话只读/写自己的分支；不切分支、不改主树
合并：主树 mesh_lock → 合并 → 释放 → 登记 merging/done
清理：git worktree remove ../wt-<主线> → 登记 done
```

**巡检（ops）**：定期核对
① 存在但未登记的 worktree（`git worktree list` vs `worktrees.md`）；
② 已合入但未清理的 worktree（分支已 merge、目录还在）；
③ 已清理但登记仍 `active` 的行。

## 7. 常见坑

- 在 worktree 里跑 `roadmap --write` 用默认路径 → 账本/产物落到树内，主树停更；按 §3 显式指定主树。
- 把 worktree 登记写进 `queue.md` → `queue-sync --check` 报 drift；写到 `dispatch/worktrees.md`。
- 树内会话 `git switch` → 把同树别人的改动带走；worker 不切分支。
- 合并时不加锁 → 与其它「会改 git」的任务交叉；按 §5 加锁。
