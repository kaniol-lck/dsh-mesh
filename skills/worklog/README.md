# worklog 速查

轻量台账：`todo/<角色>.md` + `WORKLOG.md` + 脚本生成的总览。完整说明见 [SKILL.md](SKILL.md)。

## 结构

```
<worklog-dir>/todo/<role>.md   # 一行一条任务
<worklog-dir>/WORKLOG.md       # 叙事、决策、DEFECT 行
<worklog-dir>/gates.json       # 可选：阶段性验收
<out>                          # ROADMAP.md 的自动段（默认 ../ROADMAP.md）
```

## 任务行

```markdown
<!-- session: backend · updated: 2026-10-30 -->
- [P1] 用户表迁移 —— 说明；验收：…；状态：进行中；归属：backend；进展：2026-10-30；功能：后端
```

## 命令

```bash
node scripts/roadmap.mjs --write           # 生成 ROADMAP 自动段 + roadmap.html
node scripts/roadmap.mjs --check           # 0 一致 / 1 漂移 / 2 配置问题
node scripts/roadmap.mjs --check --strict  # 额外要求每条都有「功能：」且能归类
node scripts/roadmap.mjs --json            # 机器可读模型
node scripts/defects.mjs --scan            # 缺陷台账（写 <worklog-dir>/defects.md）
node scripts/defects.mjs --taxonomy        # 查看签名词表
# --json 字段：counts / features（[{name,total,open,done}]）/ gates（含 capsules）/ nextUp / gatesPath / entries
```

`--write` / `--check` 不带 `--strict` 时行为不变：缺 `功能：` 只算 warning（归「未分类」），
`--strict` 才把「缺 `功能：`」与「未分类」都判 error。仓库收尾用默认口径（存量条目很多没写
`功能：`），要逐步硬化时再对新目录/新条目开 `--strict`。

任何解析/校验错误都会先列 `file:line: …`，最后一行明确产物状态：
`--check` 是「✗ 校验失败（未写任何文件）」，`--write` 是
「✗ ROADMAP/HTML 均未写入（产物保持旧版本）」——提交前看到这句就别以为产物已更新。
`--write` 成功会打印 ROADMAP 与 roadmap.html 的**本机绝对路径**（worktree 里留意是哪一份）。

本地强制（可选，默认不装）：`node scripts/install-hooks.mjs --apply` 安装
`.git/hooks/pre-commit`，提交前跑 `roadmap --check`（有 `check-todo-owners.mjs` 也跑）；
默认 dry-run，`--force` 才覆盖非本工具生成的 hook（先备份 `.bak-<时间戳>`），
`--uninstall` 卸载。`.worklog/**` 被 gitignore，CI 看不到这些文件，所以只能本地把关；
**每个 worktree 各装一次**，hook 不联网。

自定义路径：

```bash
node scripts/roadmap.mjs --write --worklog-dir ./.worklog --out ../ROADMAP.md
node scripts/defects.mjs --scan --worklog-dir ./.worklog
```

## 硬规则

- `进行中` 必须有 `归属` + 14 天内的 `进展`，否则按待办处理（WARN）；
- 做完同一轮改状态并写验收证据；
- 分类优先级：显式 `功能：` > 标题关键词 > `未分类`（显式字段永远优先）；
- 关口优先用 `match` 清单：`feature` 判据会被新增同功能条目拖回退（`--check` 会 WARN）。
- 关口未达成时，ROADMAP 会多出「待办聚合」（按关口列胶囊，未完成在前）与「下一步 Top」（未完成 P1 按归属聚合）。
- 验收看产物，不看回执/自我声明。

## 示例

```bash
node scripts/roadmap.mjs --worklog-dir examples --out examples/ROADMAP.md \
  --gates examples/gates.example.json --write
```

输出样例：[examples/ROADMAP.md](examples/ROADMAP.md)。
