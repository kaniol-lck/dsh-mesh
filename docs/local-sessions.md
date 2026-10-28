# 本机会话协作（不经过中枢）

同机、同一个 DSH 里的多个会话可以直接互相投递任务：waker 在 `127.0.0.1:8795` 提供会话发现与注入接口，全程本地、毫秒级、离线可用。

五个端点与 `plugins/mesh-waker/index.js`（0.4.59）的路由一一对应，全部**只接受 loopback 请求**（非本机返回 `403 loopback only`）。

## 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/mesh/sessions` | 列出本机会话 |
| POST | `/mesh/sessions/create` | 新建会话，可选投首轮任务 |
| POST | `/mesh/inject` | 定向投递一句话 |
| POST | `/mesh/sessions/archive` | 归档（侧栏隐藏，文件保留） |
| POST | `/mesh/sessions/delete` | 从注册表删除（文件可能仍在磁盘） |

### `GET /mesh/sessions`

列出本机会话（最多 80 条，按最后活动排序）：

```json
{
  "ok": true,
  "sessions": [
    {
      "id": "session-c61c2456-…",
      "title": "hermes · rehome",
      "cwd": "<repo>",
      "workspace": "--<repo-path-slug>--",
      "last_active": 1793167809000,
      "live": true,
      "archived": false,
      "known": true
    }
  ]
}
```

- `title` 从会话日志里恢复（首次扫描较慢，之后走缓存 `~/.dsh/mesh-waker/sessions-index.json`）；
- `live` 表示该会话当前是否加载在内存里；不在也可注入（会自动 resume）；
- `archived: true` 表示已归档：侧栏隐藏、文件仍在，但列表**照样扫得出来**（列表扫磁盘，不以注册表为准）；
- `known` 表示注册表里有这条会话（`false` 通常是已被删除或从未登记的残留日志）。

### `POST /mesh/sessions/create`

在指定目录（或默认收件目录）新建一个会话，可选地直接投首轮任务：

```json
{
  "title": "mesh · hub 开发",
  "workspacePath": "<repo>",
  "prompt": "先读 hub/README.md，列出与 docs 不一致处（只列不改）。",
  "mode": "queue"
}
```

- `title` 必填（≤60 字符）；
- `workspacePath` 或 `cwd`：**两者都会**被尝试解析/创建工作区（`plugins/mesh-waker/index.js:1674-1695`）。只有解析/创建失败时才回退成「无工作区」会话，侧栏因此不显示；显式传 `workspacePath` 更好排错；
- 两者都省略时用 waker 的 `sessionCwd`（收件箱目录）；
- `prompt` 可选：给了就按 `mode`（`queue` 默认 / `steer`）投首轮；不给则只建会话；
- `workspaceTitle` 可选：需要新建工作区时用这个名字。

返回（HTTP 201）：

```json
{
  "ok": true,
  "sessionId": "session-…",
  "title": "mesh · hub 开发",
  "workspaceId": "workspace-…",
  "workspacePath": "<repo>",
  "prompted": true
}
```

`workspaceId` 为 `null` 表示没绑定工作区（侧栏不显示）。

### `POST /mesh/inject`

```json
{
  "session": "session-c61c2456-330b-4471-a6ac-4245bfc8c41a",
  "text": "请处理 hub/README.md 的文档更新，完成后回报改了哪些行。",
  "mode": "queue"
}
```

- 寻址优先级：`session`（完整 id，可省略 `session-` 前缀）→ 精确标题 → 标题唯一子串；歧义或找不到返回 400 并提示用 `GET /mesh/sessions`；
- `mode`：`queue`（默认，等当前回合结束）/ `steer`（打断当前回合）；
- 返回 `{"ok":true,"sessionId":"…","title":"…","mode":"queue"}`，并写入 waker 日志 `injected … into local session …`。

### `POST /mesh/sessions/archive`

```json
{ "session": "session-…" }
```

- 支持 `session` 完整 id 或 `title`（与 inject 同一套寻址）；
- 走 `workspaceRegistry.archiveSession()`：侧栏隐藏、会话文件保留；
- 成功返回 `{"ok":true,"sessionId":"…","title":"…"}`；找不到目标或注册表拒绝时返回 400，原因在 `error` 里。

### `POST /mesh/sessions/delete`

```json
{ "session": "session-…" }
```

- **只认完整 id**（不接受标题寻址，这是与 inject/archive 的差别之一）；
- 先试 `workspaceRegistry.deleteKnown(id)`，没有该方法或失败时退回 `delete(id)`；
- 返回 `{"ok":true,"sessionId":"…","method":"deleteKnown"}`；
- 注意：两种方法都不可用时仍返回 200 且 `method:"unknown"`（已知缺陷，调用方需自行确认结果）；**不会关闭正在运行的会话**，也不清理 `conversations.json` 里指向该 id 的绑定。

### archive 与 delete 的差别

| 端点 | 语义 | 侧栏 | 会话文件 | 绑定/运行中会话 |
|---|---|---|---|---|
| `archive` | 隐藏 | 消失 | 保留 | 不处理 |
| `delete` | 从注册表删除 | 消失 | 可能仍在磁盘 | 不清理（已知限制） |

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
- 标题依赖会话日志可读；损坏或过旧日志可能没有标题，此时用 id 寻址；
- `/mesh/sessions` 固定截断 80 条、无分页/过滤参数，会话变多时只能靠标题猜；
- `delete` 不处理 live 会话与绑定，且无可用删除方法时会假成功（返回 `method:"unknown"`）。
