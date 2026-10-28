# dsh-mesh 仓库约定（给在这个工作区里干活的会话）

本仓是 **dsh-mesh 的唯一开发源**。私有镜像仓在 `..\transfer`，只做下游同步。

## 目录与归属

| 路径 | 内容 | 允许改它的会话 |
|---|---|---|
| `hub/` | 中枢服务、控制台、鉴权 | mesh · hub |
| `plugins/mesh-waker/` | DSH 唤醒插件 | mesh · waker |
| `docs/`、根 `*.md` | 文档 | mesh · docs |
| `scripts/`、`test/` | 工具与测试 | 对应功能负责人 |
| `skills/mesh/` | 给 agent 的协作说明 | mesh · docs |

**不允许**跨目录顺手改：需要别的目录时，让协调会话派给对应执行会话。

## 会话纪律

1. **cwd 必须是本仓根**（`D:\Libraries\Documents\projects\dsh-mesh\public`）。不要用包含 `public/` 与 `transfer/` 的上级目录，否则相对路径找不到文件。
2. 相对路径一律以本仓根为准：`hub/README.md`、`plugins/mesh-waker/index.js`。
3. 提交只 `git add` 自己负责的路径；commit message 写**为什么**，不要只写“更新”。
4. 不 `git push --force`；不提交凭据、token、`.npmrc`（`scripts/check-secrets.py` 是门禁）。
5. 发版动作（`npm publish`、部署 hub 到 NAS）**必须先得到 owner 确认**。
6. 待办写 `.worklog/todo/<自己>.md`，任务/故障/发版日志写 `.worklog/WORKLOG.md`，整套 `.worklog/` 不入库（明细只留在本地）。
7. 工作日志的格式、目录与收尾检查见 `docs/worklog.md`。
8. 改完自己的 todo 跑 `node scripts/roadmap.mjs --write`；收尾 `node scripts/roadmap.mjs --check` 必须退出 0。

## 多会话派活

协调会话通过 waker 的本地接口派活（不需要中枢）：

```powershell
# 看本机会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 派给某个会话（Node fetch，正文从文件读）
node scripts/mesh-dispatch.mjs --title "mesh · hub" --file .worklog/dispatch/hub.txt
```

**不要用 `Invoke-RestMethod` / `ConvertTo-Json` 发任务正文**（会把多行字符串收成 `[object Object]`）。

细节见 `docs/multi-session-playbook.md`。

## 与镜像仓的关系

- 改动**只在本仓发起**；
- 需要同步时运行 `python scripts/sync-to-transfer.py`（默认 dry-run，加 `--apply` 才写）；
- `transfer/` 里的 `refs/`、`skills/lan-ops/`、`docs/plugin-release.md` 是私有内容，同步不覆盖。
