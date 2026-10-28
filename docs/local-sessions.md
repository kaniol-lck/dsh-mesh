# 本机会话协作（不经过中枢）

同机、同一个 DSH 里的多个会话可以直接互相投递任务：waker 在 `127.0.0.1:8795` 提供会话发现与注入接口，全程本地、毫秒级、离线可用。

## 端点

### `GET /mesh/sessions`

列出本机会话（最多 80 条，按最后活动排序）：

```json
{
  "ok": true,
  "sessions": [
    {
      "id": "session-c61c2456-…",
      "title": "hermes · rehome",
      "workspacePath": "D:\\Libraries\\Documents\\projects\\dsh-mesh",
      "workspace": "--D-Libraries-Documents-projects-dsh-mesh--",
      "last_active": 1793167809000,
      "live": true
    }
  ]
}
```

- `title` 从会话日志里恢复（首次扫描较慢，之后走缓存 `~/.dsh/mesh-waker/sessions-index.json`）；
- `live` 表示该会话当前是否加载在内存里；不在也可注入（会自动 resume）。


### `POST /mesh/sessions/create`

在指定目录（或默认收件目录）新建一个会话，可选地直接投首轮任务：

```json
{
  "title": "mesh · hub 开发",
  "cwd": "D:\\Libraries\\Documents\\projects\\dsh-mesh",
  "prompt": "先读 hub/README.md，列出与 docs 不一致处（只列不改）。",
  "mode": "queue"
}
```

返回：

```json
{ "ok": true, "sessionId": "session-…", "title": "mesh · hub 开发", "cwd": "…", "prompted": true }
```

用途：让一个协调会话按分工创建执行会话，不必手工在 UI 里开。`cwd` 省略时用 waker 的 `sessionCwd`（收件箱目录）。

### `POST /mesh/inject`

```json
{
  "session": "session-c61c2456-330b-4471-a6ac-4245bfc8c41a",
  "text": "请处理 hub/README.md 的文档更新，完成后回报改了哪些行。",
  "mode": "queue"
}
```

- 寻址优先级：`session`（完整 id）→ 精确标题 → 标题唯一子串；歧义或找不到返回 400 并提示用 `GET /mesh/sessions`；
- `mode`：`queue`（默认，等当前回合结束）/ `steer`（打断当前回合）；
- 只接受 loopback 请求；写入 waker 日志 `injected … into local session …`。


### `POST /mesh/sessions/archive`

归档一个本机会话（会话文件保留，侧栏隐藏）：

```json
{ "session": "session-…" }
```

只能归档**已绑定工作区**的会话；没有 workspaceId 的会话会返回 400（这类会话本来也不出现在侧栏）。


> **cwd 怎么选**：项目有两个仓时（如 dsh-mesh/public 与 dsh-mesh/transfer），
> workspacePath 要指向**具体仓库根**，不要指向包含两个仓的上级目录——否则会话里的
> hub/、plugins/ 这类相对路径全部找不到。

## 典型用法：一个协调会话 + 多个执行会话

```powershell
# 1. 看看有哪些会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 2. 给某个执行会话派活
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' -d '{
  "title": "hub 文档维护",
  "text": "请按 docs/auth-and-console.md 核对 hub/README.md，列出不一致处，不要直接改。"
}'

# 3. 收结果：执行会话把结论写进项目文件或黑板，协调会话再读取
```

约定建议：

- 执行会话**按目录/文件分工**（例如一个管 `hub/`，一个管 `plugins/`），避免同文件并发；
- 跨会话任务用黑板登记（`mesh_board_set`），完成后释放；
- 长任务用 git 分支，不要让两个会话同时改同一分支。

## 与中枢路径的分工

| 场景 | 用哪条 |
|---|---|
| 同机会话派活、收结果 | **本接口**（毫秒级、离线可用） |
| 跨机器 / 对方可能不在线 | 中枢 `/api/send`（持久化、开机补收） |
| 需要审计、令牌与权限 | 中枢（带 scopes 的 agent token） |

## 已知限制

- 只在同一 DSH 进程内有效；DSH 关闭时注入请求直接失败（无持久队列）；
- 目标会话会被真正执行一轮，注意成本；
- 标题依赖会话日志可读；损坏或过旧日志可能没有标题，此时用 id 寻址。
