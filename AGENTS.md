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

## 多会话派活

协调会话通过 waker 的本地接口派活（不需要中枢）：

```powershell
# 看本机会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 派给某个会话（按标题或 id）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' `
  -d '{"title":"mesh · hub","text":"核对 hub/README.md 与 docs/auth-and-console.md，列出不一致处，只列不改。"}'
```

细节见 `docs/multi-session-playbook.md`。

## 与镜像仓的关系

- 改动**只在本仓发起**；
- 需要同步时运行 `python scripts/sync-to-transfer.py`（默认 dry-run，加 `--apply` 才写）；
- `transfer/` 里的 `refs/`、`skills/lan-ops/`、`docs/plugin-release.md` 是私有内容，同步不覆盖。
