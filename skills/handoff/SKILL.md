---
name: handoff
description: 把工作区 + 上下文摘要 + 依赖清单打成带 sha256 的 bundle，经 mesh blob 通道交给另一台机器/另一个 agent；接收方自动校验依赖，缺什么按两轮协议回问。当需要换机器继续干活、把会话上下文交给别的 agent、或大改动分两阶段由不同 agent 完成时使用。
whenToUse: 换机器继续同一件事；把一块工作交接给另一个 agent；两台机器之间搬工作区但不想手打包；收到 handoff bundle 需要解包并校验依赖
---

# 工作区交接（handoff）

把「工作区 + 上下文摘要 + 依赖清单」打成一个可校验的 bundle，经 mesh 的 blob 通道交给对端；
接收方解包后**自动检查依赖**，缺什么就按两轮协议回问，而不是靠人猜。

## 1. 何时用

- **换机器继续干活**：桌面 → 笔记本，或本机 → 另一台有算力/网络的机器；
- **把上下文交给另一个 agent**：不搬会话（会话不能跨机迁移），只带结构化摘要 + 文件 + 下一步；
- **大改动分两阶段**：A agent 做前半、B agent 接后半，中间用 bundle 交接。

不需要它的场景：同一台机器上继续做（直接 `git pull` / 移动目录即可）；只需要共享几个文件（用 blob 直接传）。

## 2. 三步流程

前提：两台机器都能连到同一个 mesh hub，各自有 agent token；环境变量 `MESH_HUB` / `MESH_TOKEN` / `MESH_AGENT`。

### 第 1 步：pack（打包 + 密钥扫描）

```bash
python skills/handoff/scripts/handoff.py pack \
  --workspace <workspace> --out handoff-<id>.tar.gz \
  --id <id> --conversation conv/handoff-<id> \
  --next "解包|读摘要|继续构建" --max-bytes 67108864
```

- 默认排除 `.git/`、`node_modules/`、构建产物、`*.env`、`token*`、`*.key`、`*.pem`；
- **打包前做密钥扫描，命中即拒绝**（不会生成 bundle）；
- 输出 JSON：bundle 路径、字节数、`sha256`、`handoffId`、自动探测的 `requirements`；
- 依赖探测：有 `package.json` → node ≥20（npm 非阻塞）；有 `requirements.txt`/`*.py` → python ≥3.10；
  也可以在 `handoff.requires.json` 里写自定义项（格式见 `examples/deps.example.json`）。

### 第 2 步：send（上传 + 通知）

```bash
python skills/handoff/scripts/handoff.py send \
  --file handoff-<id>.tar.gz --to <agent-b> --conversation conv/handoff-<id> \
  --id <id> --visible-to <agent-a>,<agent-b>
```

- 走 hub 的 blob 通道分片上传（断点可重试），再发一条 `important` 消息通知对端；
- `--visible-to` 限制谁能下载这个 blob（默认是发送方 + 接收方）。

### 第 3 步：receive（下载 + 校验 + 解包 + 依赖检查）

```bash
# 从 hub 拉（--id 是 blob id）
python skills/handoff/scripts/handoff.py receive \
  --id <blob-id> --dir ./incoming --sha256 <sha256>

# 或本地文件模式（没有 hub / 手工拷过来的 bundle）
python skills/handoff/scripts/handoff.py receive \
  --bundle handoff-<id>.tar.gz --dir ./incoming --sha256 <sha256>
```

- `--sha256` 不匹配 → 立即失败，不会解包；
- 解包后跑依赖检查，输出 `satisfied` / `missing` / `blockingMissing`；
- **有 blocking 依赖缺失 → 退出码 2**（不是崩溃，是「需要协商」）。

## 3. 依赖协商协议（最多两轮）

```
接收方: needs        （缺什么：missing 列表原样带上）
发送方: delta / instructions / release
接收方: verify → accepted（exit 0）或再次 needs（round=1）
```

- `needs` 用 `--missing`（JSON）或 `--missing-file` 传，避免 shell 引号问题；
- 发送方可以补一个 **delta 包**（只含缺失文件/依赖），或给 `instructions`（怎么装）；
- 同一 `conversation` 贯穿全程；**round 最多 2 轮**，超过转人工，不要无限来回；
- delta 包用同一条 `receive --dir <同一个 incoming>` 解开（会覆盖并重新 verify）。

```bash
python skills/handoff/scripts/handoff.py msg --type needs --to <agent-a> \
  --conversation conv/handoff-<id> --id <id> --round 0 \
  --missing-file missing.json
```

## 4. 与 mesh 的关系

- handoff 依赖 hub 的两条通道：**blob**（传 bundle）与**消息**（通知与协商）；
- hub 地址与 token 全部来自参数/环境变量，本技能**不内置任何地址**：
  `--hub <hub-url>` 或 `MESH_HUB`；`MESH_TOKEN` 或 `MESH_TOKEN_FILE`；
- 没有 mesh 也能用：`pack` 生成本地 bundle，手工拷到对端，用 `receive --bundle` 解包；
- 单机场景不需要 handoff：直接移动目录或 `git pull` 更简单。

## 5. 边界

- **不传凭据**：扫描命中即拒绝；`--force` 故意不提供；
- **不传 `.git` 历史**：只带工作区文件 + manifest 里的当前 commit id；需要历史就用 `git bundle`；
- **大小上限由部署决定**：hub 的 blob 单文件上限是可配置的，打包前用 `--max-bytes` 自检（例如 64 MiB）；
- **不搬会话**：跨机只带摘要 + 文件 + 下一步，不能续同一个会话；
- **不校验内容正确性**：依赖检查只回答「环境够不够」，代码是否可用仍要靠测试。

## 6. 文件

```
skills/handoff/
  SKILL.md                      本文件
  README.md                     用法速查（不装技能也能读）
  scripts/handoff.py            pack / send / receive / verify / msg
  scripts/merge_patch.py        从备份合并 YAML 列表条目（重装后恢复配置）
  examples/context-summary.md   交接摘要模板
  examples/deps.example.json    依赖清单示例
```
