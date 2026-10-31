# 工作区协作机制（可移植）

这是**工作区级的协作约定 + 台账工具**，不是消息中枢的功能：任何 git 仓库都能用它把「谁在做什么、什么算做完、卡住怎么喊人」落成文件。

## 这是什么

三层：

| 层 | 文件 | 作用 |
|---|---|---|
| 约定 | `AGENTS.md` | 目录归属、会话纪律、跨边界契约、决策路由、派活账本 |
| 台账 | `.worklog/todo/<角色>.md` + `WORKLOG.md` + `gates.json` | 可解析的待办、叙事与决策、阶段性关口 |
| 视图 | `ROADMAP.md` 自动段 + `.worklog/roadmap.html` | 由脚本生成，人读总览 |

工具来自技能 `worklog`（`roadmap.mjs` / `defects.mjs`）；本仓另提供脚手架与本地派活脚本。

## 怎么起一个新项目

```bash
# 0) 先装 worklog 技能（生成的包装器要找到它的实现）
cp -r <本仓>/skills/worklog ~/.dsh/skills/worklog
#    装在别处也可以：在项目里设 WORKLOG_SCRIPTS=<技能>/scripts（或每次跑包装器时带上）

# 1) 目标项目先是一个 git 仓库
cd <项目根> && git init

# 2) 一条命令铺好骨架（幂等，已有文件跳过）
node <本仓>/scripts/init-project.mjs --dir <项目根> --name "<项目名>" --roles hub,docs,ops

# 3) 填占位符：AGENTS.md 里的 <角色列表>、<各角色负责的目录>
#    4) 每轮：改 todo → node .worklog/bin/roadmap.mjs --write → --check
```

脚手架产出：

```
<项目根>/
  AGENTS.md                     ← 从 docs/agents-template.md 渲染
  .worklog/
    WORKLOG.md                  ← 叙事与决策
    todo/<角色>.md              ← 一行一条，可被脚本解析
    dispatch/queue.md           ← 派活账本
    gates.json                  ← 空数组 + 写法示例（改成 match 胶囊）
    ops/                        ← 运维记录
    bin/{roadmap,defects,dispatch}.mjs ← 转发到已安装技能/脚本
  且 .gitignore 含 .worklog/
```

`--dry-run` 只看计划；`--force` 覆盖已有文件。

## 多项目怎么共存

- **共用同一个消息中枢**：每个项目不需要单独部署，节点按需注册；
- **会话标题用 `<项目> · <角色>`**（例：`util4freesub · docs`），否则 `/mesh/inject` 按标题寻址会歧义（同名会 **400 并列出候选**，不会错投）；
- 台账各自在项目内（`.worklog/` 不入库），跨项目只通过消息/黑板交换结论；
- 本机派活用 `scripts/mesh-dispatch.mjs`（可选；没有 waker 时走 mesh 消息或直接开会话）。

## 最小日常

```bash
node .worklog/bin/roadmap.mjs --write    # 生成 ROADMAP 自动段 + HTML
node .worklog/bin/roadmap.mjs --check    # 0 一致 / 1 漂移
node .worklog/bin/defects.mjs --scan     # 缺陷台账
node .worklog/bin/dispatch.mjs --title "<项目> · <角色>" --file dispatch/task.txt
```
