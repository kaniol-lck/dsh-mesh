# dsh-mesh-waker

DSH 客户端插件：[dsh-mesh](https://github.com/kaniol-lck/dsh-mesh) 局域网 agent 中枢的唤醒端。

中枢在收到消息后会向本机端点发一个**不含正文、带 HMAC 签名**的 ping；本插件把这个 ping 变成一次真正的会话回合（创建或复用会话 → 注入"去读收件箱"的提示），于是即使没人在看窗口，agent 也会自己处理来信。

## 安装

```bash
dsh plugin add dsh-mesh-waker
dsh plugin --profile web add dsh-mesh-waker
```

装完打开 **设置 → Mesh**，填中枢地址与这台机器的 agent token（token 由插件存到仅本人可读的文件，不写进 profile patch）。

## 它提供什么

- **唤醒端点**：`/mesh/wake`，校验 HMAC 与时间窗；错误签名直接拒绝，不消耗会话；
- **设置页**：中枢地址、信任级别（strict / normal / full）、按设备信任、收件箱目录、投递方式、启动补收；
- **收件箱**：右栏「开始」里的「Mesh 信箱」卡片 + 左侧侧边栏整页视图，按会话聚合、悬停预览、点击跳转、按收发着色；
- **本地历史缓存**：中枢只保留 7 天消息，插件把见过的消息镜像到本地 `history.json`，不过期；
- **会话绑定**：会话 ↔ mesh conversation 的映射分「唤醒路由」与「面板显示」两个字段，互不干扰。

## 本机会话协作（不经过中枢）

同机、同一个 DSH 里的多个会话可以直接互相派活：waker 在 `127.0.0.1:8795` 暴露会话发现与注入接口，全程本地、毫秒级、离线可用。所有端点**只接受 loopback 请求**。

| 端点 | 作用 |
|---|---|
| `GET /mesh/sessions` | 列出本机会话（最多 80 条，按最后活动排序）：`id` / `title` / `cwd` / `workspace` / `last_active` / `live` / `archived` |
| `POST /mesh/inject` | 向已有会话投一轮任务：按 `session`（完整 id）→ 精确标题 → 标题唯一子串寻址；歧义或找不到返回 400。`mode` 为 `queue`（默认，等当前回合）或 `steer`（打断当前回合） |
| `POST /mesh/sessions/create` | 新建会话并绑定工作区，可选首轮 `prompt`；返回 `sessionId` / `workspaceId` / `workspacePath` / `prompted` |
| `POST /mesh/sessions/archive` | 归档会话：日志保留、侧栏隐藏；存活的会话会被宿主拒绝（`workspace/session-active`） |
| `POST /mesh/sessions/delete` | 删除会话：先停掉在跑的 agent（`sessionController.cancel` + 宿主 dispose 钩子），摘掉 `conversations.json` 里指向它的绑定，再删会话目录；停不下来的返回 **409**，不会假报成功 |

可直接复制：

```powershell
# 1. 看看有哪些会话
curl.exe -s http://127.0.0.1:8795/mesh/sessions

# 2. 给某个会话派活（按标题寻址；同名会 400 而不是随便挑一个）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/inject -H 'content-type: application/json' -d '{"title":"hub 文档维护","text":"列出 README 与实现不一致处，只列不改"}'

# 3. 新建执行会话并立刻投首轮任务（cwd 指向具体仓库根）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/create -H 'content-type: application/json' -d '{"title":"mesh · 临时工","cwd":"D:\\Libraries\\Documents\\projects\\dsh-mesh\\public","prompt":"先读 hub/README.md，列出与 docs 不一致处"}'

# 4. 归档 / 删除（都按完整 id）
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/archive -H 'content-type: application/json' -d '{"session":"session-…"}'
curl.exe -s -X POST http://127.0.0.1:8795/mesh/sessions/delete -H 'content-type: application/json' -d '{"session":"session-…"}'
```

`delete` 只删 waker 能发现的会话（id 必须出现在 `GET /mesh/sessions` 里），不接受路径；`archive` 与 `inject` 支持标题寻址，`delete` 目前只认完整 id。

细节与约定见 [docs/local-sessions.md](https://github.com/kaniol-lck/dsh-mesh/blob/main/docs/local-sessions.md)；端点验收：`node test/waker-endpoints.test.js`。

## 依赖

中枢本体见 [hub/](https://github.com/kaniol-lck/dsh-mesh/tree/main/hub)，Docker 一条命令即可起：

```bash
cd hub && cp .env.example .env && docker compose up -d --build
```

## 许可

MIT

## 已绑定会话的投递方式

把某个会话绑定到当前 DSH 会话后（收件箱卡片/整页的「绑定到当前会话」），该会话的新邮件会
**直接以插队输入（`mode: 'queue'`）投进这个会话**，而不是另起一个「Mesh 收件箱」会话：

- 绑定接口：`POST /mesh/bind { conversation, sessionId, deliver?: true }`，`deliver: false` 只做展示绑定；
- 投递失败（会话已删除/归档）会自动清掉 `deliverTo` 并回退到收件箱会话，邮件不会丢；
- 收件箱列表每 10 秒轮询一次，新会话不用手动刷新就会出现。
