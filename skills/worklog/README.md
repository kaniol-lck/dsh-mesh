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
node scripts/roadmap.mjs --json            # 机器可读模型
node scripts/defects.mjs --scan            # 缺陷台账（写 <worklog-dir>/defects.md）
node scripts/defects.mjs --taxonomy        # 查看签名词表
```

自定义路径：

```bash
node scripts/roadmap.mjs --write --worklog-dir ./.worklog --out ../ROADMAP.md
node scripts/defects.mjs --scan --worklog-dir ./.worklog
```

## 硬规则

- `进行中` 必须有 `归属` + 14 天内的 `进展`，否则按待办处理（WARN）；
- 做完同一轮改状态并写验收证据；
- 验收看产物，不看回执/自我声明。

## 示例

```bash
node scripts/roadmap.mjs --worklog-dir examples --out examples/ROADMAP.md \
  --gates examples/gates.example.json --write
```

输出样例：[examples/ROADMAP.md](examples/ROADMAP.md)。
