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
| POST | `/mesh/sessions/create` | 新建会话：`{title, workspacePath, prompt?}` |
| POST | `/mesh/inject` | 定向投递：`{session 或 title, text, mode?}` |
| POST | `/mesh/sessions/archive` | 归档（侧栏隐藏，文件保留） |
| POST | `/mesh/sessions/delete` | 尝试从注册表删除（文件可能仍在磁盘） |

要点：

- **cwd 必须是具体仓根**（`...\dsh-mesh\public`）。指到包含两个仓的上级目录会让 `hub/`、`plugins/` 全部找不到；
- 新建会话若不绑定工作区（只传 `cwd`），侧栏不会显示——统一传 `workspacePath`；
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
| 新建会话侧栏不显示 | 只传了 cwd，没绑工作区 | 传 `workspacePath`；旧会话可 archive |
| 会话里 `hub/README.md` 找不到 | cwd 指向了上级总目录 | 用具体仓根重建会话 |
| 重复会话 | 创建请求在成功后报错（历史 bug），或重复提交 | 按标题去重：保留最新，其余 `/mesh/sessions/archive` |
| archive 后仍出现在 `/mesh/sessions` | 该列表扫磁盘，不看注册表 | 侧栏以注册表为准；要彻底清理需删目录并重启 DSH |
| 注入没反应 | 目标会话忙/标题匹配歧义 | 用完整 session id；查 `live` 字段 |
| `create` 返回 400 | 缺 `title`，或标题匹配不到目标 | 看响应里的 `error` |
| 注入只收到 15 字符 `"[object Object]"` | PowerShell 5.1 `ConvertTo-Json` 把多行字符串包成 `{"value":…}` | 改用 `scripts/mesh-dispatch.mjs`（Node fetch）派活，不要用 `Invoke-RestMethod` |

## 5. 发版（仍需 owner 确认）

```bash
python scripts/release.py --preflight     # 预检
python scripts/release.py                 # 发 next
python scripts/release.py --promote       # 提 latest
```

部署 hub 到 NAS 用 `sessions\<本机脚本>\ssh_deploy.py`，部署后必须验证 `/health` 版本。

## 6. 收尾三连

改完 `.worklog/todo/<自己>.md` 后固定跑三件：

```powershell
node scripts/roadmap.mjs --write   # 汇总进 ROADMAP 自动段 + 重渲染 .worklog/roadmap.html
git status                         # 应干净：产物都在忽略目录 / 仓外
node scripts/roadmap.mjs --check   # 必须退出 0
```

`--check` 退出 1 表示 todo 与 ROADMAP 自动段漂移，跑 `--write` 后复查；退出 2 表示 ROADMAP 缺 AUTO 标记，找协调会话。
