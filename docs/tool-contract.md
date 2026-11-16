# 工具契约（高频失败的对策）

> 技能讲**流程**，本页讲**契约**：每次写文件、跑命令、调工具都要守的硬规则。
> 维护：2026-11-17 · 复查周期 120 天 · 由 `node scripts/check-tool-contract.mjs` 检查（章节、时效、失败台账覆盖）。
> 判据：失败台账的 top 签名必须在本页 §4 有对应行；出现新的高频失败 → 先补本页，再改习惯。

## 1. 写文件（edit / write）

1. **改前必 `read`**：`edit` 的 `old_string` 从刚读到的原文逐字复制（含缩进、全角标点）。
2. **长文件/账本不要用 `edit` 改行首前缀**：会把下一条的开头一起吞掉。整行替换，或用 node 脚本追加。
3. `old_string` 不唯一 → 扩大上下文，或显式 `replace_all: true`。
4. 内容没变就不要调 `edit`（会报 `old_string and new_string must differ`）。
5. `write` 的父目录必须存在；不要把文件写到 `...\.git\文件名` 这类「父路径是文件」的位置。
6. 并发写同一文件 → `file changed since it was read`：重新 `read` 再改。
7. 覆盖已有文件前先 `read`（否则 `without reading it first`）。

## 2. 命令（pwsh）

1. 工具名是 **`pwsh`**，不是 `ps` / `bash`。
2. 长命令、网络拉取用后台作业（`run_in_background`），不要在前台干等；超时会被 abort。
3. 沙箱拒绝是策略不是 bug：`sandbox: file access denied` 不换路绕过。
4. 升级权限必须成对：`sandbox_permissions` + `justification` 同时给，否则 `invalid escalation`。
5. 编码：多行中文 / JSON 优先交 node，避免 PowerShell 版本差异。

## 3. 工具名（精确）

| 意图 | 本机工具名 | 常见错写 |
|---|---|---|
| 执行命令 | `pwsh` | `ps`、`bash` |
| mesh 发消息 | `mcp__mesh__mesh_send`（短名环境 `mesh_send`） | 宿主未暴露短名时写 `mesh_send` |
| mesh 收件箱 | `mcp__mesh__mesh_inbox` | `mesh_inbox` |
| mesh 完成 | `mcp__mesh__mesh_complete` | 省略 `mcp__mesh__` 前缀 |
| 读文件 | `read` | `cat` |
| 改文件 | `edit` / `write` | `sed`、`echo >` |

规则：**文档里的工具名必须与宿主实际暴露的一致**；用简写时在首次出现处标注「短名环境为 X」。

## 4. 错误 → 下一步

| 报错 | 下一步 |
|---|---|
| `old_string was not found` | 重新 `read`，逐字复制；长文件改整行替换 |
| `old_string matched N times` | 扩大上下文，或 `replace_all: true` |
| `old_string and new_string must differ` | 内容已一致，不要再调 |
| `without reading it first` | 先 `read` 再 `write` |
| `cannot resolve ... parent path segment is not a directory` | 检查父目录；别写到文件路径下 |
| `file changed since it was read` | 重新 `read` 再改 |
| `cannot read ... not found` / `binary file` | 先确认路径（`glob`/`ls`）；二进制别用文本工具 |
| `unknown tool "ps"` | 用 `pwsh` |
| `unknown tool "mesh_send"` | 用宿主名 `mcp__mesh__mesh_send` |
| `refusing to send a message to yourself` | `to` 必须是另一个 agent；自测用临时 agent |
| `invalid escalation: justification ...` | 同时给 `sandbox_permissions` |
| `input must be an object`（cordis_inspect_query 等） | 传对象/JSON，不要传字符串 |
| `mesh_ask ... timeout` | 缩短问题/选项，或改成直接提问 |
| `tool call aborted` | 改后台作业，或缩短命令 |
| `fetch failed` / `web fetch failed` | 换通路（curl / node / IWR），同一 URL 不原样重试第 3 次 |

## 5. 维护

- 本页 **≤160 行**；新增条目先删一条冗余，保持一页可读完。
- 每次 `fail-log-guide` 出现**新** top 签名（近 7 天 count ≥3 且本页未覆盖）→ 当轮补 §4。
- 复查周期 120 天；`check-tool-contract.mjs` 会因**章节缺失、过期、台账未覆盖**而报错。
- 本页只写「怎么做」；流程、模板、角色边界放各自技能与 `AGENTS.md`，不在这里堆。
