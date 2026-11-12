<!-- drift: waker=* hub=* owner=docs -->
# 团队仓库与工作日志规范（v1.2 裁剪采纳版）

本文是外部文档《团队仓库与工作日志规范 v1.2》的**裁剪采纳版**：不是全文照搬，而是按迁移成本分三档，
把「现在就能用」的部分落成约定，把「以后再说」和「本仓不适用」写清楚，避免下次评估时重新争论。

- 分支模型与本仓落地位置：`AGENTS.md`「分支模型」一节（owner 2026-11-12 定）。
- 多主线并行（工作树）：`docs/multi-track-worktrees.md`。
- 工作日志工具链：技能 `worklog`（`roadmap.mjs` / `defects.mjs`）与 `docs/workspace-collaboration.md`。

## 1. 采纳（已生效）

### 1.1 单仓模型（v1.2 §2.1）

一个产品一个仓库：代码、插件、文档、测试、发布脚本同仓；不拆「业务仓 + 配置仓」。
本仓现状即单仓（`hub/`、`plugins/`、`docs/`、`skills/`、`scripts/`、`test/` 同库）。

### 1.2 分支模型（v1.2 §3）

| 分支 | 用途 | 来源 → 去向 |
|---|---|---|
| `main` | 发布线，只收发布/热修合入 | `release/*` / `hotfix/*` → `main` |
| `dev` | 日常开发主线（默认基线） | `feature/*` / `bugfix/*` 合回这里 |
| `feature/<kebab>` | 功能开发 | 从 `dev` 切，squash 合回 `dev` |
| `bugfix/<kebab>` | 缺陷修复 | 从 `dev` 切，squash 合回 `dev` |
| `release/vX.Y.Z` | 发布准备 | 从 `dev` 切，`--no-ff` 合入 `main` 并打 tag |
| `hotfix/<kebab>` | 线上热修 | 从 `main` 切，合 `main` 后回合并 `dev` |

- **worker 不切分支**：分支切换只由协调/收尾在合并窗口执行（见 `AGENTS.md`「共享工作树纪律」C）。
- 派活默认 `base=dev`；回执核对 `git.branch`，发现不在 `dev` 先停手。
- 小版本可跳过 `release/*`（见 §1.4），但 `main` 仍然只接受合入、不接受日常直推。

### 1.3 合并策略（v1.2 §4）

- `feature/*` / `bugfix/*` → `dev`：**squash merge**，一条提交对应一个可验收产物。
- `release/*` → `main`：**`--no-ff` merge**，保留发布边界。
- **不做线性历史**（不 rebase 改写已推送提交、不要求 fast-forward-only）：多人/多 agent 场景下，
  线性历史会让「谁在什么时候合了什么」不可追，且与 squash 策略冲突。

### 1.4 发版（v1.2 §9，简化版）

1. `dev` 上功能齐、门禁绿；
2. 从 `dev` 切 `release/vX.Y.Z`（**小版本可跳过此步**，直接从 `dev` 合入 `main`）；
3. `--no-ff` 合入 `main`，打 `vX.Y.Z` tag；
4. 更新 `CHANGELOG.md`（Keep a Changelog 格式，见 `AGENTS.md`「变更记录」）；
5. 推送由协调统一执行，执行会话只提交。

## 2. 分阶段（本期先不做，标 TODO）

| v1.2 条目 | 现状 | 计划 |
|---|---|---|
| §5 Issues / Projects | 本期仍用 `.worklog/todo/<角色>.md` + `ROADMAP.md` 自动段 | TODO：等多人协作、需要跨仓库可见性时再迁移；迁移前先保持 todo 格式稳定 |
| §7 Rulesets / CODEOWNERS | 本期只在 GitHub 上对 `main` 做「禁强推 + 禁删除」最小保护 | TODO：仓库角色稳定后再加 CODEOWNERS 与必需检查 |

> 注：`.worklog/**` 不入库，GitHub 上看不到账本；因此「必需检查」只能覆盖代码/文档/测试，账本校验靠本地
> （`roadmap --check`、可选 pre-commit，见 `skills/worklog/README.md`）。

## 3. 不采纳（并写明原因）

### 3.1 双仓模型（v1.2 §2.2）

不采纳「业务仓 + 配置仓」双仓。本仓是 **public 主仓 + `../transfer` 私有镜像**的下游同步关系，
不是「可见性隔离」意义上的双仓：镜像只做单向同步（`python .worklog/bin/sync-to-transfer.py`），
不承载独立历史，也不需要单独的分支/发布流程。

### 3.2 组织角色（v1.2 §8）

不采纳完整组织角色（PM / TL / 开发 / 测试 / 运维的汇报链）。本仓是「单人 owner + 多 agent 会话」场景：
角色按**文件归属边界**划分（`协调/waker/hub/docs/ops`，见 `AGENTS.md`「角色与分工」），
不设汇报层级，也不引入跨角色的审批链。

## 4. 账本分层：本仓用 L0（与 v1.2 §11.4 的偏离）

v1.2 §11.4 建议「模式 B → L2」（账本入库、随仓库分发）。本仓**明确用 L0**：

- `.worklog/**` **不入库**（`.gitignore`），账本只存在本机；
- 理由：本仓是公开仓，账本含会话 id、内部排期、巡检结论、本机路径与安全边界信息；
  入库会把内部施工日志暴露给公开历史，且 `.worklog` 里的生成物（`roadmap.html`/`board.html`）会频繁制造噪音提交；
- 代价与补偿：CI 看不到账本 → 账本校验放本地（`roadmap --check` + 可选 pre-commit hook），
  公开仓只保证代码/文档/测试门禁；跨机协作靠 `ROADMAP.md` 自动段与 WORKLOG 的 `DECISION:` 记录传递结论。

**偏离记录**：见 `.worklog/WORKLOG.md` 2026-11-12 22:25 的采纳评估记录（owner 同意按迁移成本分档采纳；
L0 与「模式 B→L2」的偏离在此说明）；正式 `DECISION:` 行由协调回填。

## 5. 与其它文档的关系

- 分支模型落地：`AGENTS.md`「分支模型」。
- 多主线/工作树：`docs/multi-track-worktrees.md`。
- 协作与台账工具：`docs/workspace-collaboration.md`、`skills/worklog/README.md`。
