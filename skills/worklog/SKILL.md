---
name: worklog
description: 给多会话/多 agent 项目用的轻量台账工具链：todo/<角色>.md 记最小任务，WORKLOG.md 记叙事与决策，roadmap.mjs 渲染总览与阶段性关口，defects.mjs 做缺陷回流统计。当需要跨会话分工、跟踪「谁在做什么/什么卡住了/什么算做完」、或想机械判定「哪些做完=能力闭环」时使用。
whenToUse: 多个 agent 会话并行做一个项目；需要可审计的任务台账；需要把路线图/里程碑自动生成；需要统计反复出现的同类问题以决定何时立规
---

# worklog：agent 项目的台账与总览

## 1. 为什么 agent 项目需要台账

多个会话并行时，「谁在做什么、什么做完了、什么卡住了」不能靠记忆：
会话会重启、上下文会丢、协作方只能看到文件。台账把状态落成**文件**，
让任何会话（或人）随时能读、能派活、能验收。

## 2. 三层结构

```
<worklog-dir>/
  todo/<role>.md     ← 最小可派活单位：一条一行，可被脚本解析
  WORKLOG.md         ← 叙事与决策：为什么这么做、事故、发布记录
  gates.json         ← 可选：阶段性验收定义
  roadmap.html       ← 生成物：本地看板
<out>                ← 生成物：ROADMAP.md 的自动段（放在仓库根或上级目录）
```

- `todo/<role>.md`：每个角色/会话一个文件，避免同文件并发写；
- `WORKLOG.md`：只写「发生了什么、为什么」；任务状态不放这里；
- `ROADMAP.md`：由脚本生成，**不要手改**自动段。

## 3. 条目格式

```markdown
<!-- session: backend · updated: 2026-10-30 -->
- [P1] 用户表迁移 —— 增加 profile 字段并回填；验收：空库与已有库都能跑通；状态：进行中；归属：backend；进展：2026-10-30；功能：后端
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `[P0|P1|P2]` | 是 | 优先级 |
| 标题 —— 说明 | 是 | `——` 分隔；说明写「为什么/影响面」 |
| `验收：` | 是 | 必须可被命令或肉眼逐条核对 |
| `状态：` | 是 | `未开始` / `进行中` / `已完成` |
| `归属：` | 建议 | 负责的角色/会话；缺省用文件名 |
| `进展：` | 进行中必填 | `YYYY-MM-DD`，14 天内有效 |
| `功能：` | 可选 | 聚合用的标签（自由取值，缺省 `未分类`） |

## 4. 三条硬规则（都来自真实事故）

1. **`进行中` 必须带 `归属` + 14 天内的 `进展`**：否则按待办处理并在 `--check` 里 WARN。
   没有新鲜进展的「进行中」= 僵尸项，看板会长期显示却无人推进。
2. **做完即改账**：完成某条工作**同一轮**把状态改成 `已完成`，并在正文补一行验收证据
   （commit / 测试通过数 / 验证命令）。不要留给协调者事后补——产物完成而台账还写「未开始」，
   是协作里最常见的假象。
3. **回执/状态是线索，产物才是证据**：验收看 commit、测试数、接口行为，不看自我声明；
   自动化回执只说明「那一轮结束了」。

## 5. 关口：哪些做完 = 能力闭环

`gates.json` 用声明式规则回答「完成哪几项就可以发布/算某个能力闭环」：

```json
{
  "gates": [
    { "id": "G1", "name": "接入闭环", "question": "外部客户端能完成一次鉴权读写？",
      "requires": [ { "match": "接入 API" }, { "feature": "接入" } ] }
  ]
}
```

- `{ "match": "标题子串" }`：标题包含该子串的条目**全部完成**才算满足；
- `{ "feature": "标签" }`：该功能下全部条目完成才算满足；
- 脚本机械判定，输出 `✅ 达成` 或 `⏳ m/n` 与「还差什么」；
- 匹配不到任何条目时 `--check` 会 WARN（标题改过？），记得同步改 gates.json。

## 6. 缺陷回流

`defects.mjs` 统计反复出现的问题，**脚本不会自动改约定**：

- 确定源：`WORKLOG.md` 里的 `DEFECT: <签名> · <域> · <证据> · <blocking:yes|no>` 行；
- 推断源：命中「修复/漂移/坑/失败/超时/不一致」的行（只计数，不决定 READY）；
- 同类达到 `--threshold`（默认 3）才标 `READY FOR PATCH`，这时才起草约定补丁。

## 7. 用法

```bash
# 生成/检查（默认 ./.worklog、../ROADMAP.md、<worklog-dir>/gates.json）
node scripts/roadmap.mjs --write
node scripts/roadmap.mjs --check          # 0 一致 / 1 漂移 / 2 配置问题

# 自定义路径
node scripts/roadmap.mjs --write \
  --worklog-dir ./.worklog --out ../ROADMAP.md --gates ./.worklog/gates.json

# 可选：版本一致性（源码常量 vs package.json）
node scripts/roadmap.mjs --check \
  --version-file src/version.ts --version-key APP_VERSION --version-package package.json

# 缺陷台账
node scripts/defects.mjs --scan --worklog-dir ./.worklog
```

`--write` 对并发安全（临时文件 + rename，`<worklog-dir>/.roadmap.lock` 互斥；拿不到锁只 WARN 并退出 0）。

## 8. 示例

`examples/` 是一个最小可跑项目：

```bash
node scripts/roadmap.mjs --worklog-dir examples --out examples/ROADMAP.md \
  --gates examples/gates.example.json --write
```

生成结果见 `examples/ROADMAP.md`。
