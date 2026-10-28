# 多会话协作手册

本文件说明如何用一个协调会话 + 若干执行会话维护 dsh-mesh。接口全部在本机 `127.0.0.1:8795`，
不经过中枢、离线可用。

## 1. 会话分工

| 会话 | 职责 | 可改路径 |
|---|---|---|
| **mesh · 协调** | 拆任务、派活、验收、汇总；发版前找 owner 确认 | 不直接改代码 |
| **mesh · hub** | 中枢、控制台、鉴权 | `hub/` |
| **mesh · waker** | 唤醒插件、投递模式、本机会话接口 | `plugins/mesh-waker/` |
| **mesh · docs** | README、docs、CHANGES | `docs/`、根 `*.md` |

## 2. 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/mesh/sessions` | 列出本机会话（id、标题、cwd、是否 live/archived） |
| POST | `/mesh/sessions/create` | 新建会话：`{title, workspacePath 或 cwd, prompt?}` |
| POST | `/mesh/inject` | 定向投递：`{session 或 title, text, mode?}` |
| POST | `/mesh/sessions/archive` | 归档（侧栏隐藏，文件保留） |
| POST | `/mesh/sessions/delete` | 尝试从注册表删除（文件可能仍在磁盘） |

要点：

- **cwd 必须是具体仓根**（`...\dsh-mesh\public`）。指到包含两个仓的上级目录会让 `hub/`、`plugins/` 全部找不到；
- 新建会话的 `workspacePath` 与 `cwd` **都会**被尝试解析/绑定工作区（`plugins/mesh-waker/index.js:1674-1695`）；只有解析/创建失败时才回退为「无工作区」会话、侧栏不显示。推荐显式传 `workspacePath`，便于排错；
- 注入默认 `mode=queue`（等当前回合结束），`steer` 会打断，慎用；
- 目标会话不在内存时会自动 resume，首次稍慢。

## 3. 派活模板

```powershell
# 协调 → hub：只读核对
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' -d '{
  "title": "mesh · hub",
  "text": "任务：核对 hub/server.mjs 与控制台文档是否一致。只列清单，不改文件；完成后把结论写进 docs/console-audit.md 并 inject 回协调会话。"
}'

# 协调 → waker：带验收标准
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' -d '{
  "title": "mesh · waker",
  "text": "任务：给 /mesh/sessions 增加分页参数。验收：单元/手测通过、README 更新、只提交 plugins/mesh-waker/。完成后回报 commit hash。"
}'
```

原则：**一个任务一个会话**；写清楚“只改哪里、什么算完成、怎么回报”。

### 用 Node 发，不要用 PS 5.1 的 ConvertTo-Json

PowerShell 5.1 的 `ConvertTo-Json` 会把多行字符串序列化成 `{"value":"…"}`，经 `/mesh/inject` 投递后对方只收到 15 字符的 `[object Object]`（`Invoke-RestMethod -Body` 同理）。把任务正文写成纯文本文件，用脚本发：

```powershell
node scripts/mesh-dispatch.mjs --title "mesh · hub" --file .worklog/dispatch/hub.txt
node scripts/mesh-dispatch.mjs --title "mesh · docs" --file .worklog/dispatch/docs.txt --dry-run
node scripts/mesh-dispatch.mjs --session session-… --file task.txt --mode steer
```

脚本按标题找目标时只考虑 `archived:false` 且 cwd 为仓根的会话，多条取 `last_active` 最新；打印选中的 session id 与 `chars=`，非 200 或 `ok:false` 时退出码 1。

## 4. 常踩的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 新建会话侧栏不显示 | 工作区解析/创建失败（路径不存在或无权限），或旧版 waker；0.4.59 下 `cwd` 也会尝试绑定 | 确认路径存在可读，显式传 `workspacePath`；旧会话可 archive |
| 会话里 `hub/README.md` 找不到 | cwd 指向了上级总目录 | 用具体仓根重建会话 |
| 重复会话 | 创建请求在成功后报错（历史 bug），或重复提交 | 按标题去重：保留最新，其余 `/mesh/sessions/archive` |
| archive 后仍出现在 `/mesh/sessions` | 该列表扫磁盘，不看注册表 | 侧栏以注册表为准；要彻底清理需删目录并重启 DSH |
| 注入没反应 | 目标会话忙/标题匹配歧义 | 用完整 session id；查 `live` 字段 |
| `create` 返回 400 | 缺 `title`，或标题匹配不到目标 | 看响应里的 `error` |
| 注入只收到 15 字符 `"[object Object]"` | PowerShell 5.1 `ConvertTo-Json` 把多行字符串包成 `{"value":…}` | 改用 `scripts/mesh-dispatch.mjs`（Node fetch）派活，不要用 `Invoke-RestMethod` |
| 用 PS `Set-Content -Encoding utf8` 改 `package.json` 后 JSON 解析失败 | Windows PowerShell 5.1 的 `-Encoding utf8` 会写 UTF-8 **BOM**，`JSON.parse` 报 `Unexpected token '﻿'` | 改 JSON/JS 时用 `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`，或直接用编辑工具；写完 `node -e "JSON.parse(...)"` 验一遍 |
| 测试 version drift 后 `hub/package.json` 未还原 | 手工改完没 `git checkout`，测试值被提交进去 | 测完立即 `git checkout -- hub/package.json`（或改前先备份），提交前 `git diff hub/` 确认为空 |

## 5. 发版（仍需 owner 确认）

```bash
python scripts/release.py --preflight     # 预检
python scripts/release.py                 # 发 next
python scripts/release.py --promote       # 提 latest
```

部署 hub 到 NAS 用 `sessions\<本机脚本>\ssh_deploy.py`，部署后必须验证 `/health` 版本。

## 6. 收尾五连

改完 `.worklog/todo/<自己>.md` 后固定跑五步：

```powershell
node scripts/roadmap.mjs --write   # 汇总进 ROADMAP 自动段 + 重渲染 .worklog/roadmap.html
node scripts/defects.mjs --scan    # 复核缺陷台账（.worklog/defects.md）
git status                         # 应干净：产物都在忽略目录 / 仓外
node scripts/check-paths.mjs       # 路径/内网拓扑门禁：本机绝对路径、真实 LAN IP 一律不得入库
node scripts/roadmap.mjs --check   # 必须退出 0
```

`--check` 退出 1 表示 todo 与 ROADMAP 自动段漂移，跑 `--write` 后复查；退出 2 表示 ROADMAP 缺 AUTO 标记，找协调会话。看到 `WARN: .worklog/roadmap.html 过期` 就补跑一次 `--write`（不阻塞收尾，但别把过期页面当现状）。

决策怎么路由看 AGENTS「决策路由」：跨域、约定/流程变更、版本号、凭据与轮换、发版与部署的事别在会话里自己拍板；自决的决定在 `WORKLOG` 写一行 `DECISION:`。

## 7. 唤醒协调会话（本机）

本机内**只用 inject**，不要为了叫醒本机会话去调 hub/mesh：

```powershell
# P0 / 安全：立刻叫醒协调会话
node scripts/mesh-dispatch.mjs --wake --title "mesh · 协调" --text "[WAKE] hub/README 的 TLS 示例仍指向明文 HTTP，涉及安全，需你决定是否先改文档"

# 需要 owner 决策：一句话说清现状和选项，细节放第二段
node scripts/mesh-dispatch.mjs --wake --title "mesh · 协调" --text "[WAKE] latest 发布前需要 owner 确认，两个候选版本已备好"
```

- 触发门槛（满足其一才叫）：P0 / 安全；需要 owner 决策；阻塞自己 ≥30 分钟；任务完成且结论会影响别人下一步；
- **不唤醒**：普通进度、「我做完了」、todo 更新、例行问答 —— 写进 `.worklog/todo/<自己>.md` 和 `WORKLOG`，协调会话下一轮会扫到；
- **回复不等于送达**：`/mesh/inject` 是单向投递（响应只有 `{ok, sessionId, title, mode}`，不含回复正文），你的回复不会自动回到协调会话；需要它行动就必须 `--wake`，除非派活正文明确写了「本轮不用叫我，我会读 X 文件」；
- **上报前复检**：`--wake` 前先重跑判定命令（`roadmap --check` / `check-paths` / `/health` 等），已绿就只写文件并记「复检时已恢复（时间）」；仍红才唤醒；连续两次在红/绿间抖动（如两个会话互改 todo）照常叫，并在正文注明「抖动」；
- 正文首行必须是 `[WAKE] <一句话摘要>`，细节写后面；一次任务最多叫一次，等回执期间不要重复叫；
- `--wake` 对「同一目标会话 + 同一正文」做 60 秒防抖，重复投递会打印 `deduped: same payload within 60s` 并退出 0。

## 8. 跨机消息唤醒（绑定）

绑定只服务跨机来件；本机唤醒见 §7。

跨机来件由 hub 落库后经 waker 唤醒；落到哪个本机会话由 binding 决定：

```powershell
curl.exe -s -X POST http://127.0.0.1:8795/mesh/bind -H 'content-type: application/json' `
  -d '{"conversation":"conv/xxx","sessionId":"session-…","deliver":true}'
```

- 只有绑定过的 `conversation`，新消息才会注入指定会话；未绑定的落到「mesh 收件箱」会话；
- `deliver:false` 只做展示绑定、不投递；
- **已实测（2026-10-29）**：临时会话绑定一段 conversation 后，经 hub 发 1 条消息 → 该会话自动起一轮（实测 604ms），消息注入绑定会话；测试后解绑，`/mesh/admin/bindings` 无残留。本机会话之间不要走这条路（用 `scripts/mesh-dispatch.mjs --wake` 直接 inject）。
