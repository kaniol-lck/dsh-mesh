# mesh handoff —— 工作区 + 上下文打包交接

`handoff.py` 把「一个工作区 + 一段上下文摘要 + 一份依赖清单」打成一个带 sha256 的 bundle，
走中枢的 blob 通道交给另一台机器；接收方解包后**自动校验依赖**，缺什么就按协议回问发送方，
发送方补一个 delta 包或给安装说明，最多两轮。

## 用法

```bash
# 发送方：打包（默认排除 .git/node_modules/*.env/token*，打包前做密钥扫描）
python handoff.py pack --workspace ./proj --out ./handoff.tar.gz \
  --id 20261026-001 --conversation conv/handoff-001 \
  --next "解包|读 context/summary.md|继续构建"

# 发送方：上传 + 通知（visible_to 限制谁能下载）
python handoff.py send --file ./handoff.tar.gz --to agent-b \
  --conversation conv/handoff-001 --id 20261026-001 \
  --visible-to agent-a,agent-b --next "解包|读 context/summary.md|继续构建"

# 接收方：下载 + 校验 + 解包 + 依赖校验（exit 2 表示缺依赖）
python handoff.py receive --id <blob-id> --dir ./incoming --sha256 <sha>

# 接收方：缺东西就回问
python handoff.py msg --type needs --to agent-a --conversation conv/handoff-001 \
  --id 20261026-001 --round 0 --missing '[{"kind":"command","name":"node","need":">=22.5"}]'

# 发送方：补一个 delta（或给安装说明/放行）
python handoff.py send --file ./delta.tar.gz --to agent-b --conversation conv/handoff-001 \
  --id 20261026-001 --type delta --round 1 --visible-to agent-a,agent-b

# 接收方：补齐后再校验，通过就回 accepted
python handoff.py verify --dir ./incoming
python handoff.py msg --type accepted --to agent-a --conversation conv/handoff-001 --id 20261026-001 --round 1
```

## 配置

| 变量 | 说明 |
|---|---|
| `MESH_HUB_URL` | 中枢地址，默认 `http://127.0.0.1:8790` |
| `MESH_TOKEN` / `MESH_TOKEN_FILE` | 本机 agent token（默认 `~/.dsh/mesh-waker/token`） |
| `MESH_AGENT` | 本机 agent 名，写进 manifest 与 `visible_to` |

## manifest（bundle 内 `handoff/manifest.json`）

```json
{
  "handoffId": "20261026-001",
  "from": "agent-a",
  "conversation": "conv/handoff-001",
  "round": 0,
  "workspace": { "root": "workspace/", "git": { "commit": "abc123" } },
  "requirements": {
    "commands": [{ "name": "node", "minVersion": "22.5", "blocking": true }],
    "python": [{ "module": "requests", "blocking": false }],
    "dshPlugins": [{ "name": "dsh-mesh-waker", "blocking": true }],
    "skills": [{ "name": "mesh", "blocking": false }],
    "env": [{ "name": "MESH_TOKEN", "blocking": true }]
  },
  "nextSteps": ["解包", "读 context/summary.md", "继续构建"]
}
```

`blocking: false` 的缺失只记警告，不阻塞交接（例如对方根本没有的硬件/内网资源）。

## 协议消息

| type | 方向 | 含义 |
|---|---|---|
| `package` | 发送方 → 接收方 | 主包（blob + sha256 + nextSteps） |
| `needs` | 接收方 → 发送方 | 缺依赖清单（结构化 missing） |
| `delta` | 发送方 → 接收方 | 补丁包（缺失工具/脚本/数据） |
| `instructions` | 发送方 → 接收方 | 只给安装命令/链接，不打包 |
| `release` | 发送方 → 接收方 | 这些缺失不影响本段，放行 |
| `accepted` | 接收方 → 发送方 | 校验通过，开始干活 |

约定：同一 `conversation`、`important: true`（不随 7 天过期）、`round` 最多到 2，超过就升级为人工消息。

## 边界

- 单文件 ≤64 MiB、总量 2 GiB、blob 默认 24h 过期；更大的工作区要分卷或调大中枢限制；
- **跨机不能续同一个 DSH 会话**，只带结构化摘要 + 文件 + 下一步；同机才谈得上"续会话"；
- 打包前会做一次密钥扫描，命中即拒绝（`--force` 可覆盖，但不建议）。

## Windows 下传 JSON 参数

PowerShell 5.1 调原生程序时会剥掉 JSON 里的引号，--missing '[{"kind":"command"}]' 会失败。
用文件或 stdin：

`powershell
'[{"kind":"command","name":"node","need":">=22.5"}]' | Set-Content needs.json -Encoding utf8
python handoff.py msg --type needs --to agent-a --conversation conv/x --id x --missing-file needs.json
# 或
Get-Content needs.json -Raw | python handoff.py msg ... --missing -
`
