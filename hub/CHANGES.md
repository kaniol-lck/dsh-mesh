# 变更记录

v0.1.0 是一次外部评审的输入包。评审在 2026-10-21 做了静态审计 + 本机实跑，
发现"能跑、但不够常驻"的一组问题。v0.2.0 只改这些，**不扩大功能面**（工具数仍是 10 个）；
v0.2.1 是接入三台机器后暴露的两个展示层缺陷；v0.4.0 加对话分组。

复验方式：`node smoke-client.mjs`（未设 `MESH_WAKE_SECRET` 时 113/113，wake push 用例打印 `SKIP`；设置后 121/121）、`node --test test/*.test.mjs`（6/6；Node 24 下 `test/` 目录写法会报 MODULE_NOT_FOUND）、`NODE_EXTRA_CA_CERTS=... node scripts/tls-check.mjs`（6/6）。

> **2026-10-29 补记**：0.7.9 的 per-agent scopes 当时只覆盖 MCP 工具，REST 面未判权；补丁进入 0.7.12（见下条）。

---

## v0.7.21（2026-10-31，截断按字节 + 文档对齐审计/工具/变量）

| 项 | 内容 |
|---|---|
| 会话截断 | `/api/conversation` 的 4 KiB 截断改为按 UTF-8 **字节**（≤4096），不切多字节字符，末尾补 `…`；smoke 中文/emoji 两例断言字节数与无 `U+FFFD` |
| 审计文档 | README 增加「审计现实语义」表：成功认证不记、失败记 `auth`、超限只 429、管理与配对/blob 记对应 action，与 `audit()` 调用点一致 |
| README | 中文删「没有广播组」（现有 `to:"*"`），环境变量表指向 `.env.example`（保留高频项），工具数 10→14；英文工具清单改为实际 14 个（删除 `mesh_read`/`mesh_presence`/`mesh_cache_clear`） |
| 验证 | smoke 119→121（新增 2 例截断）；`node --test test/*.test.mjs` 6/6；两 README 相对链接 dead=0 |

## v0.7.20（2026-10-31，smoke 覆盖收口 + 部署变量补齐；无行为变更）

| 项 | 内容 |
|---|---|
| smoke 覆盖 | 新增 12 例：控制台登录/CSRF/成功写入、`allowed_cidrs` 拒绝非匹配来源、`interrupt`/`delivery_mode` 落库、board log 列表与不可见 key 过滤、blob `/meta`、chunk `offset` 409、plugin 版本上报与 outdated 标记；107→119 |
| node:test | 新增 `hub/test/limits.test.mjs`（`MESH_MAX_SESSIONS` 上限 + 空闲会话回收）与只读控制台角色 403；4→6 |
| 配置补齐 | `hub/server.mjs` 的 38 个 `process.env.MESH_*` 全部进入 `.env.example` 与 `docker-compose.yml`（此前分别缺 27/22 个）；每个变量注明用途/默认值/是否必需；compose 用 `${VAR:-default}` 透传 |
| 无法自动化 | `/api/enroll` 注册码过期（10 分钟固定 TTL，无测试用 env）；单次消费已覆盖。手工步骤：生成 code → 等 10 分钟 → `POST /api/enroll` 应 401 |
| 验证 | smoke 无 `MESH_WAKE_SECRET` 111/111、设置后 119/119；`node --test test/*.test.mjs` 6/6 |

## v0.7.19（2026-10-31，未读不丢 + 黑板 CAS/可见性）

| 项 | 内容 |
|---|---|
| 未读消息不删 | 清扫只删除**已读**且超 TTL 的消息；未读超 TTL 只写 `stale_at`，`/api/inbox` 行带 `stale: true`、顶层带 `stale_count`（本页）；`MESH_MAX_UNREAD_MESSAGES`（默认 0=关）超限只 WARN，不删除 |
| 黑板 CAS | `POST /api/board` 可选 `if_version`：匹配→版本 +1；不匹配→**409** `{current_version, current_value}`；`if_version=0` 仅用于新 key；不带则覆盖并 +1。`GET /api/admin/board` 提供 admin 全量视图 |
| 黑板可见性 | key 支持 `visible_to`（`*` 或白名单）：GET 列表过滤、不可见直读 **404**、`board_log` 同步过滤；旧 key 迁移为 `*` + `version=1` |
| 迁移 | `messages.stale_at`、`board.version` / `board.visible_to` 幂等 ALTER；旧数据默认可见、版本 1 |
| 验证 | smoke：未设 `MESH_WAKE_SECRET` 99/99、设置后 107/107（CAS 匹配/409、`if_version=0`、私有 key 列表/直读、admin 视图）；`node --test test/*.test.mjs` 4/4（未读 stale、已读清理） |

## v0.7.18（2026-10-31，blob 可见性 / 回滚 / 分端限额）

| 项 | 内容 |
|---|---|
| blob 列表过滤 | `GET /api/blobs` 只返回调用者可读的条目（admin / uploader / `visible_to` 命中）；被过滤的条目直接不出现，不泄露数量。越权下载与 `/meta` 由 403 改为 **404**（不确认存在性） |
| size 回滚 | `commit` 大小不符时删除已写文件与 `blobs` 行（原先返回 400 但保留 `uploading` 行），与 sha 不符路径一致 |
| 分端限额 | 新增 `MESH_MAX_BLOB_CHUNK_BYTES`（默认 8 MiB，单 chunk 超限 → 413）；`MESH_MAX_BLOB_BYTES` 仍为单文件 64 MiB；`MESH_MAX_BODY_BYTES`（1 MiB）只作用于非 blob 端点；`/health.blobs` 暴露 `max_file/max_chunk/max_total` 供客户端预检 |
| 破坏性影响 | 非 admin 的 `/api/blobs` 结果变少（仅可见项）；越权直连从 403 变 404；单 chunk 超过 8 MiB 的客户端需要拆片 |
| 验证 | smoke：未设 `MESH_WAKE_SECRET` 91/91、设置后 99/99（列表过滤、私有 meta/download 404、size 回滚、file/chunk 413、health 限额）；`node --test test/*.test.mjs` 3/3 |

## v0.7.17（2026-10-31，token 过期可设置 + 文档校准）

| 项 | 内容 |
|---|---|
| token 过期 | `/api/admin/agents`、`/api/admin/rotate`、`/api/enroll` 与控制台注册码接受可选 `expires_at`（ISO 8601 或 epoch 毫秒，省略 = 永不过期）；控制台节点行可设置/清除；到期请求返回 `401 token expired...`，审计 `auth.expired`（鉴权判断原本已有，缺的是签发入口） |
| 文档校准 | `hub/README.en.md` 控制台段改为 0.7.x 管理能力（scopes/CIDR/轮换/吊销/注册码/过期），去掉「read-only」；health 示例用 `<version>` 占位；`hub/README.md` 补令牌过期说明 |
| 链接 | `hub/README.md` 相对链接扫描 dead=0（`skills/mesh/SKILL.md` 路径已正确） |
| 验证 | smoke：未设 `MESH_WAKE_SECRET` 83/83、设置后 91/91（过期 401 + 原因、未过期 200、非法 `expires_at` 400、rotate 过期 401）；`node --test test/*.test.mjs` 3/3；README.en 无 read-only/0.5.7 |

## v0.7.16（2026-10-31，管理面安全：空 scope 拒绝 + 明文管理面告警）

| 项 | 内容 |
|---|---|
| scopes 空集拒绝 | 控制台保存空数组/空串 → 400（原先存 `""` 又被读成全部，等于误给全权）；全权必须显式传 `["*"]`；历史空串行不改语义（仍按全权）但启动时 WARN 列出行数 |
| 管理面来源收紧 | `MESH_CONSOLE_ALLOW` 未设置时默认仅 loopback（原先 loopback+RFC1918）；`/api/admin/*` 同样受该来源限制（非允许来源 403）；无 TLS 且 console 启用时启动 WARN「console/admin over plain HTTP」 |
| 迁移 | 老部署若从内网访问 console 或 `/api/admin/*`，需显式设置 `MESH_CONSOLE_ALLOW=192.168.0.0/16`（或实际网段），否则远程管理面 403；数据库无需迁移 |
| 验证 | `node smoke-client.mjs`：未设 `MESH_WAKE_SECRET` 79/79（wake push SKIP），设置后 87/87（空数组/空串 400、`["*"]` 200 且全权、单 scope 仍受限）；`node --test test/*.test.mjs` 3/3（明文 WARN、默认 loopback 403、显式允许 200、历史空串 WARN；Node 24 下 `test/` 目录写法报 MODULE_NOT_FOUND） |

## v0.7.15（2026-10-29，pull 自举与收件箱 claim）

| 项 | 内容 |
|---|---|
| bootstrap | 新增无需鉴权的 `GET /api/bootstrap`（按 IP 60 次/分钟限速，超限 429）：返回 `service/version/protocol/tls/endpoints/enroll/wake`；`tls` 由可选 `MESH_TLS_CA_FILE`（PEM）填充 `{ca_pem, ca_sha256}`，未设或不可读为 `null`（不可读只 WARN）；不含 token/wake_secret/文件路径 |
| claim | `GET /api/inbox` 新增 `claim=1` 与 `claim_ttl_ms`（默认 300000）：只对本次返回行且在 `claimed_at` 为空或租约过期时写入；响应行带 `claimed_at`；claim 不等于已读，`mark_read=1` 行为不变 |
| 迁移 | `messages.claimed_at INTEGER`（幂等 ALTER） |
| 验证 | `node smoke-client.mjs`：84/84（bootstrap 字段与 60/min 限速、claim 租约保持/过期重取、claim 不影响未读、mark_read 生效）；手测 TLS：`ca_sha256` 与文件 SHA-256 一致，不可读路径 `tls:null` 且 WARN |

## v0.7.14（2026-10-29，静默消息与收件箱可达性修复）

| 项 | 内容 |
|---|---|
| no_reply 收紧 | `no_reply:true` 只在带 `reply_to`（对话收尾）时生效；没有 `reply_to` 时忽略该标志、照常唤醒，响应带 `no_reply_ignored:true` 与 reason；广播路径同样适用 |
| silent | `POST /api/send` 与 `mesh_send` 新增 `silent:true`：落库但不唤醒，供「必须人来回」的通道；与 `no_reply` 同时出现时 silent 优先并在响应注明 |
| inbox 分页 | `GET /api/inbox` 新增 `order=asc|desc`（默认 asc）与 `before=<epoch_ms>` 游标，响应带 `has_more` / `next_before`；`mark_read=1` 仍只标记本次页；MCP `mesh_inbox` 新增 `order`，`unread_only:false` 时默认 `desc` |
| 审批桥 | `plugins/mesh-approval` 发送改 `silent:true`（否则新语义下会唤醒 agent、可自审自批），轮询改 `order=desc`；新增 `test_transport_contract.py` 回归用例 |
| 构建 | `Dockerfile` 新增 `ARG NPM_REGISTRY`（默认 `https://registry.npmmirror.com`），`npm install` 按该源执行；构建时可用 `--build-arg NPM_REGISTRY=https://registry.npmjs.org` 覆盖。只影响构建，版本号不变 |
| 验证 | `node smoke-client.mjs`：77/77 passed（30 条积压下 desc 取最新、before 覆盖全量、no_reply 无 reply_to 唤醒、silent 不唤醒、reply_to 收尾不唤醒、MCP desc）；审批单测 2/2；live 审批 decision=once、wake_hits=0 |

## v0.7.13（2026-10-29，控制台配对：注册码入口 + 设备码）

| 项 | 内容 |
|---|---|
| 注册码入口 | 控制台「新节点配对」区块：管理员点按钮调 `POST /console/enroll-code` 生成 8 位码（10 分钟、单次），页内显示大字号码、剩余时间、复制按钮，并直接给出三条接入命令（换 token / 落盘 0600 / 验证） |
| 设备码 | 新增 `POST /api/enroll/request`（返回 `user_code` + `device_code`，10 分钟、单次、按 IP 限速）与 `POST /api/enroll/token`（`202 pending` / `201 {name,token}` / `403 denied` / `410 expired`）；控制台新增待批准列表与批准/拒绝，管理面另有 `/api/admin/enroll/approve|deny` |
| 安全 | `device_code` 不出现在控制台页面；批准需管理员控制台会话或 admin token；轮询 10 次/分钟/IP，失败进 audit；原 `/api/enroll` 八位码保持不变 |
| 时间字段 | `/api/admin/agents`、`/api/peers`（REST 与 MCP）新增 `last_seen_at`（UTC ISO 8601，保留 `last_seen_seconds_ago` 兼容）；控制台「最后活动」渲染为「刚刚 / N 分钟前 / N 小时前 / N 天前」，`title` 放本地绝对时间 |
| 彻底删除 | `DELETE /api/admin/agents?name=&purge=1` 连行删除（含 wake_url/wake_secret）并审计 `admin.purge`；不带 `purge` 仍是吊销；控制台对已吊销节点显示「清理」，经会话鉴权的 `/console/agents/purge` 执行并二次确认 |
| 验证 | `node smoke-client.mjs`：70/70 passed（注册码单次、设备码 pending→approve→token→410、deny→403、轮询限速 429、`last_seen_at` 可解析、`purge=1` 删行）；本地控制台手测 12/12（人类可读渲染 + 清理按钮）；页面脚本 `node --check` 通过 |

## v0.7.12（2026-10-29，REST 面 scopes 越权修复）

| 项 | 内容 |
|---|---|
| 修复 | `handleRest` 之前不检查 `id.scopes`，受限 token 仍能调 `/api/send`、`/api/inbox`、`/api/board` 等；现在按读写端点逐一判权：读端点要 `read`，发消息/改消息要 `send`，写黑板要 `board`，blob 传输要 `blob` |
| 响应 | 越权返回 `403` + `{ok:false, error, required_scope}`；admin 端点仍只认 admin token |
| 测试 | smoke 增加 7 例：send-only 读 inbox 403、read-only 写 board 403、read-only 上传 blob 403、read-only 列 blob 元数据 200、unrestricted 发送 201，另含 read-only 发消息 403、read-only 读 inbox 200 |
| 验证 | `node smoke-client.mjs`：57/57 passed（临时端口 + 临时数据目录，未碰生产数据） |

## v0.7.11（2026-10-28，控制台可退出 / 切换令牌）

| 项 | 内容 |
|---|---|
| 控制台 | 页头加「退出 / 切换令牌」表单：POST /console/logout 清掉 cookie 回登录页；只读角色提示用管理员令牌重新登录以切换角色 |
| 验证 | 控制台点「退出」后 cookie 失效并回到登录页；换另一个令牌登录后角色角标随之切换 |

## v0.7.10（2026-10-28，修复控制台页面脚本）

| 项 | 内容 |
|---|---|
| 修复 | 页面内联脚本里 `alert('…\n\n' + token)` 的 `\n` 被模板字符串展开成真实换行，浏览器报语法错误，刷新与所有按钮失效；改为转义后的 `\\n` |
| 验证 | 打开 /console 后概览、成员、审计正常渲染，浏览器 console 无语法错误；轮换令牌弹窗正常显示 |

## v0.7.9（2026-10-28，管理员控制台、per-agent scopes、IP 白名单、令牌过期）

| 项 | 内容 |
|---|---|
| 控制台 | 双角色：view token 只读；admin token 可轮换/吊销、改 scopes、改 allowed_cidrs、生成注册码。cookie 会话的写操作要求 x-mesh-csrf，只读角色写操作 403 |
| 权限 | agents.scopes（read / send / board / blob，空 = 全部）、allowed_cidrs、token_expires_at 列（自动迁移）；MCP 工具按 scope 拒绝并返回可读错误 |
| 认证 | 令牌过期返回 401 token expired；来源不在 allowed_cidrs 返回 403；控制台来源由 MESH_CONSOLE_ALLOW 限制（默认 loopback + RFC1918） |
| 验证 | 受限 scope 的 token 调 mesh_send 得到 scope 错误；CIDR 不符 403；过期 token 401；只读角色在控制台写操作 403 |

## v0.7.8（2026-10-28，注册码 enroll）

| 项 | 内容 |
|---|---|
| 注册码 | POST /api/admin/enroll-codes（admin）生成 8 位 code，10 分钟有效、单次使用；POST /api/enroll 用它换 agent token（201），同码重放 401 |
| 防爆破 | enroll 按来源 IP 计数，超过 10 次返回 429；成功与失败都进 audit 表 |
| 关联 | 同提交的「两轴版本自检」与「持久化限流账本」在 waker 0.4.55，详见插件 CHANGELOG |
| 验证 | 生成注册码 → /api/enroll 换到 token → token 调 /api/status 200；重放同一 code 401；库中只存 token 的 sha256 |

## v0.7.7（2026-10-27，按消息指定投递模式）

| 项 | 内容 |
|---|---|
| 消息 | messages.delivery_mode 列（自动迁移）；mesh_send 接受 delivery: queue / steer / branch，POST /api/send 接受 body.delivery，非法值按未设置处理 |
| 语义 | 只是发送方建议，接收方 waker 的本地策略与频率上限仍优先；inbox / conversation 返回该字段 |
| 验证 | 发送 delivery=steer 后 /api/inbox 返回 delivery_mode=steer；不传该字段时为 null |

## v0.7.6（2026-10-27，回信沿用发起会话）

| 项 | 内容 |
|---|---|
| 消息 | messages.origin_session 列（自动迁移）；mesh_send 接受 session，POST /api/send 接受 body.session，随消息落库（≤80 字符） |
| 唤醒 | wake ping 带上该 conversation 中发送方最近一条 origin_session，接收端 waker 可把对话绑回发起会话；仅是建议，接收端自行决定 |
| 验证 | 带 session 发送后，对端 wake body 含 origin_session；/api/conversation 返回该字段 |

## v0.7.5（2026-10-26，只读控制台）

| 项 | 内容 |
|---|---|
| 控制台 | GET /console（需 MESH_VIEW_TOKEN，未设时回落到 MESH_ADMIN_TOKEN；两者都没有则 404）；登录换 HttpOnly + SameSite=Strict cookie（12 小时） |
| 防护 | 来源由 MESH_CONSOLE_ALLOW 限制（默认 loopback + RFC1918）；连续 5 次错误令牌锁 60 秒；只读 API：overview / peers / audit |
| 验证 | 设置 MESH_VIEW_TOKEN 后 /console 先返回登录页、登录后 200；非白名单来源 403；README 与 README.en 同步控制台说明 |

## v0.7.4（2026-10-26，插件版本上报与漂移提示）

| 项 | 内容 |
|---|---|
| 上报 | POST /api/register 接受 plugin {name, version, platform}，写入 agents.plugin_* 列（自动迁移）；仅作展示，不参与鉴权 |
| 漂移 | 引入 HUB_VERSION 与 MESH_MIN_WAKER；/api/peers 返回 plugin 与 compat（ok / outdated），/api/status 返回 plugin_versions 与 outdated 列表 |
| 验证 | 以 plugin.version=0.3.9 注册后 /api/peers 显示 outdated、0.4.0 显示 ok；/api/status 的 outdated 含旧节点 |

## v0.7.3（2026-10-26，interrupt 提示与 relay 会话键）

| 项 | 内容 |
|---|---|
| 消息 | messages.interrupt 列（自动迁移）；mesh_send 接受 interrupt:true，POST /api/send 接受 body.interrupt；inbox / conversation 返回该字段。是否插队仍由接收方 waker 决定 |
| relay | 唤醒请求改用 X-Hermes-Session-Key: mesh:<conversation>，Hermes 的 api_server 按 header（而不是 OpenAI user 字段）区分会话 |
| 验证 | 发送 interrupt:true 后 /api/inbox 与 /api/conversation 的 interrupt=1；relay 目标收到 x-hermes-session-key header |

## v0.7.2（2026-10-25，修复会话持久化被 idle sweep 抹掉）

**问题**：`sweepSessions` 关闭 transport 时会触发 `onclose`，而 `onclose` 会 `forgetSession(sid)`
删掉 `mcp_sessions` 行——空闲 30 分钟后持久化记录被一起删了，客户端再连就是 404，等于 0.7.1 白做。

**修复**：sweep 关 transport 前先 `transport.onclose = undefined`，只释放内存会话，保留 DB 行；
只有显式 `DELETE /mcp` 才真正删除记录。

**验证**：部署 0.7.2（进程重启）后**不重挂 MCP 插件**直接调用工具成功，说明按 DB 行重建生效。

## v0.7.1（2026-10-25，发送时标记"重要"）

| 项 | 内容 |
|---|---|
| MCP | `mesh_send` 新增 `important?: boolean`；为 true 时落库即 `pinned = 1`，不随 7 天 TTL 删除 |
| REST | `POST /api/send` 接受 `important`（或 `pinned`） |
| 语义 | 重要由**发件人发送时**决定；收件人仍可事后 `POST /api/message/<id>/pin` 补标，两者共用同一列 |
| 其他 | `/api/inbox`（REST 与 MCP）都返回 `pinned`，客户端可据此持久化重要状态 |

验证：smoke **49/49**（新增 2 项：发送时 important 进入 pinned 列表、inbox 暴露 pinned 标记）。

## v0.7.0（2026-10-25，会话视图 + 重要标记）

| 端点 | 说明 |
|---|---|
| `GET /api/conversations` | 我的对话列表（按 conversation 聚合：条数、未读、重要数、参与者、最后时间） |
| `GET /api/conversation?conversation=&limit=&before=&full=` | 某个会话的消息流（只含我参与的）；body 默认截断 4 KiB，`full=1` 取全文 |
| `GET /api/message?id=` | 单条消息（参与者或 admin） |
| `POST /api/message/<id>/pin` | 标/取消"重要"（参与者或 admin） |
| `GET /api/pinned` | 我的重要消息列表 |

`messages.pinned` 列新增；`purgeExpired` 跳过 `pinned = 1` 的行——**重要消息不随 7 天 TTL 删除**，
其余消息保留策略不变（云端不扩展）。

验证：smoke **47/47**（新增 5 项：会话聚合、截断、全文、pin、非参与者 403）。

## v0.6.2（2026-10-25，MCP 会话持久化 + 可选宽松重建）

**背景**：dsh 的 MCP 客户端在收到 404（会话过期/中枢重启）后**不会自动重新 initialize**，
此后每次工具调用都报 `-32001 unknown or expired session`，只能手动重挂插件。实测本轮会话中
至少撞到 3 次。

| 项 | 内容 |
|---|---|
| A. 持久化 | `mcp_sessions(sid, agent, created_at, last_used)`；initialize 时写入，close/DELETE 时删除；重启后按 id 重建 transport（注入 `sessionId` + `_initialized`），**无需重新握手** |
| 过期 | 内存会话仍按 `MESH_SESSION_IDLE_MS`（30 min）回收；DB 行按 `MESH_MCP_SESSION_TTL_MS`（默认 7 天）清理 |
| B. 宽松开关 | `MESH_MCP_LENIENT_SESSION=1` 时，未知 session id 也重建；默认关闭以保持 404 语义 |
| 约束 | 会话 id 仍绑定 agent：别的 token 拿同 id 会 403 |

验证：smoke **42/42**；独立重启测试三项全过 —— 重启后同 sid 调 `tools/list` 返回 200（10 个工具）、
严格模式未知 sid 404、宽松模式未知 sid 200。

## v0.6.1（2026-10-25，断点续传 + blob ACL）

| 项 | 内容 |
|---|---|
| 断点续传 | `POST /api/blob/init`（声明 name/bytes/sha256）→ `PUT /api/blob/<id>/chunk?offset=N` 追加 → `POST /api/blob/<id>/commit` 校验大小与 sha256；offset 不符返回 409 并告知已收字节；校验失败删除整包 |
| 清理 | 1 小时未完成的上传与过期 blob 一并由 sweep 删除 |
| ACL | `visible_to` = `*` 或 agent 白名单；GET/meta 受约束，`PATCH /api/blob/<id>` 由上传者/admin 修改；仍不支持下载过期后的续期 |

验证：smoke **41/41**（新增：断点续传 commit 校验、下载一致性、ACL 拒绝、ACL 重开）。

## v0.6.0（2026-10-25，blob 通道：大于 64 KiB 的文件）

**背景**：黑板单值上限 64 KiB。技能包、工作区快照、构建产物只能拆成上百个黑板键，没有校验、没有过期、失败要整体重来。

**改动**：

| 端点 | 说明 |
|---|---|
| `POST /api/blob?name=&sha256=` | 原始字节上传；sha256 不符直接 400 且不落盘；返回 id/url/过期时间 |
| `GET /api/blob/<id>` | 下载原始字节，响应头带 `x-blob-sha256` / `x-blob-name` |
| `GET /api/blob/<id>/meta` | 元数据 |
| `GET /api/blobs?mine=1` | 列表（默认最近 100 条） |
| `DELETE /api/blob/<id>` | 仅上传者或 admin |

**上限与清理**：单文件 `MESH_MAX_BLOB_BYTES`（默认 64 MiB）、总量 `MESH_MAX_BLOB_TOTAL_BYTES`（2 GiB）、
`MESH_BLOB_TTL_MS`（24h）到期由逐小时 sweep 删除文件与记录；上传记录进 `audit` 表。

**验证**：smoke 37/37（新增 5 项：上传/sha 校验/下载一致/错误 sha 拒绝/删除）；跨机实测 laptop
下载 512 KB 文件，`sha256` 完全一致。

## v0.5.x（2026-10-23~24，对话协议 + 每 agent 密钥 + relay 唤醒）

| 版本 | 改动 |
|---|---|
| 0.5.0 | 消息加 `conversation`（对话分组）与 `no_reply`（收尾不唤醒）；黑板加 `owner`/`status`；广播 `to:"*"`；`POST /api/read` 按 id 确认；`GET /api/wake-secret` |
| 0.5.4 | wake secret 从全局改为**每 agent 一把**（`ensureWakeSecret`），旧全局密钥签名被拒；`/api/wake-secret` 返回 `scope:"agent"` |
| 0.5.5 | 新增 **relay 唤醒**：`wake_api` 注册项可让中枢直接调用宿主 loopback 上的 OpenAI 兼容 API；目标是**硬编码白名单**，中枢不能当通用代理；`/health` 暴露 `relay` |
| 0.5.6 | relay 提示词收紧（只许两次工具调用，禁止跑飞） |
| 0.5.7 | relay 带 `X-Gateway agent-Session-Key: mesh:<conversation>`（api_server 的会话身份来源是 header，不是 OpenAI `user` 字段）；修 12 处编码损坏的破折号；补 LICENSE / 英文 README / CI |

复验：`node smoke-client.mjs`（32/32，含「每 agent 密钥」与「relay 白名单」两项回归）。

## v0.4.0（2026-10-23，对话分组 + 唤醒带上对话 id）

**背景**：dsh 的 MCP 工具调用不携带会话上下文（`dsh-mcp-client` 只发 `{name, arguments}`），
中枢按 token 识别 agent，因此同一台机器的多个 dsh 会话在中枢看来是同一个身份，
接收侧无法把"同一轮对话"归到同一个会话里。

**改动**：

| 项 | 内容 |
|---|---|
| 消息表 | 新增 `conversation TEXT`（自动迁移）；`mesh_send` / `POST /api/send` 接受可选 `conversation`（≤120 字节） |
| 收件箱 | `mesh_inbox` / `GET /api/inbox` 返回 `conversation` 字段 |
| 唤醒 | wake ping 体带上 `conversation`，接收侧的 waker 据此把同一对话落到同一个 dsh 会话 |
| 回归 | 新增"conversation 落库并原样返回"，共 26 项 |

**约定**：`conversation` 由调用方声明（skill §10），不是 dsh 真实 session id——
后者需要改上游 `dsh-mcp-client` 才能自动带出，暂不做。

---


## v0.2.2（2026-10-22，升级中枢时暴露的会话恢复缺陷）

**现象**：替换容器（升级镜像）后，所有在线客户端的 `Mcp-Session-Id` 都失效，但服务端对"未知会话"不返回 404，
而是当作新会话建了一个**尚未初始化**的 transport，于是每个请求都回 `Bad Request: Server not initialized`。
客户端拿不到"该重新 initialize"的信号——Gateway agent 那类按规范处理 404 的客户端还能自愈，dsh 侧只能重启或重挂插件。

**修法**：请求带 `Mcp-Session-Id` 但表里没有该会话时，直接返回 **404** + JSON-RPC 错误（MCP 规范要求）。
回归新增一项（"未知 session id 返回 404"），总数 23。

**升级操作约定**（写进 `docs/` 与技能）：
1. 升级前知会各 agent；
2. 替换容器后，dsh 侧若报 `Server not initialized`，重挂插件（`plugin_manager set_plugin` 关闭再开启）或重启 dsh；
3. Gateway agent 侧保持常连，收到 404 会自行重新 initialize。

---

## v0.2.1（2026-10-22，使用中发现的展示层缺陷）

`mesh_whoami` 报的信息不可用，两处都在它自己身上：

| 现象 | 原因 | 修法 |
|---|---|---|
| `host` 恒为 `null` | 取自请求头 `X-Mesh-Host`，而 dsh / Gateway agent 客户端都不发这个头 | 改查名册行（token 决定身份，名册决定 host / description），并回传 `description`、`last_seen` |
| `hub` 回显 `http://0.0.0.0:8790/mcp` | 直接拼接了监听地址 | 用调用方实际请求的 `Host` 头拼出可达 URL；反代 / 隧道（TLS 在外部终结）场景可用新增的 `MESH_PUBLIC_URL` 覆盖 |

回归扩到 22 项：新增"whoami 报的是名册 host，不是请求头"与"whoami 的 hub 不是 0.0.0.0"。
顺带把 smoke 客户端里那个 `x-mesh-host` 头去掉——真实客户端本来就不发，留着会掩盖这类缺陷。

---

## P1（跨网上线前必须修）

### 1. MCP 会话永不回收

- **现象**：`sessions` 只在 `transport.onclose` 删除；dsh 被关机/kill 时不会发 `DELETE /mcp`，
  会话条目永久驻留。实测：跑完一次正常回归仍残留 4 个；5 次"异常重连"后 4 → 9 且不降。
- **修法**：条目增加 `lastUsed`，每 `min(60s, max(5s, idle/2))` 扫一次，超过
  `MESH_SESSION_IDLE_MS`（默认 30 分钟）的会话 `close()` 并删除；`MESH_MAX_SESSIONS`
  （默认 128）封顶，超出返回 503。
- **验证**：`MESH_SESSION_IDLE_MS=1000` 起服务，5 个被遗弃的连接 8 秒后 sessions → 0。

### 2. 按 IP 的认证限流会把整个 mesh 熔断

- **现象**：`resolveIdentity` 入口先判 `isThrottled(ip)`，同一 IP 失败 8 次/分钟后，
  该 IP 的**有效 token** 也返回 429。实测已复现。
- **为什么致命**：`docs/security.md` 的形态是 frp `type="tcp"` 透传，frpc 不注入
  `X-Forwarded-For`，所有外部 agent 的源地址都是 `127.0.0.1`。公网端口必然被扫
  （文档自己写了这句），扫描器一分钟的失败次数远超 8 次 → 全网持续 429，且
  `MESH_TRUST_PROXY` 帮不上忙。
- **修法**：先校验 token，有效就放行并清零计数；只有**失败请求**才计数、才可能拿到 429。
  同时只审计窗口内前 `FAIL_LIMIT` 次失败，防止扫描器把 `audit` 表刷爆。
- **验证**：连续 12 次错 token 后，同一 IP 的有效 token 仍返回 200；错 token 自身返回 429。

## P2（常驻会累积）

### 3. 没有任何体积上限

- **现象**：`readJson` 全量拼接后 `JSON.parse`；`board.value`、消息 `body` 无上限。
  实测 8 MB 的黑板值写入返回 200。
- **修法**：`readBody` 边读边计，超过 `MESH_MAX_BODY_BYTES`（默认 1 MiB）直接 413 且不缓冲；
  消息正文 / 黑板值 `MESH_MAX_MESSAGE_BYTES` / `MESH_MAX_BOARD_BYTES`（各 64 KiB），
  key / subject 200 B，超限 400 并说明字节数。
- **验证**：8 MB → 413；70 KB 黑板值 → 400；正常写入仍是 200。

### 4. `board_log` 与 `audit` 只写不读不清理

- **现象**：`board_log` 三处引用全是 INSERT，没有任何读取入口（README 却承诺"变更日志"），
  两张表都不清理。
- **修法**：新增 `GET /api/board/log?key=&prefix=&limit=`（倒序，agent token）；
  `purgeExpired` 增加时间窗口（`MESH_LOG_TTL_MS`，默认 30 天）+ 行数上限
  （`MESH_LOG_MAX_ROWS`，默认 2 万），每小时执行。
- **验证**：写黑板后能读到日志条目，`actor` 正确。

### 5. 开 TLS 后容器健康检查永远失败

- **现象**：`Dockerfile` 的 HEALTHCHECK 硬编码 `http://127.0.0.1:8790/health`，
  TLS 模式下该端口只答 HTTPS → 容器永久 `unhealthy`（`restart: unless-stopped` 又不重启，
  等于"看着在跑、监控一直红"）。
- **修法**：新增 `scripts/healthcheck.mjs`，按 `MESH_TLS_CERT`/`MESH_TLS_KEY` 选择 http/https，
  loopback 自签场景 `rejectUnauthorized:false`（只是确认监听还活着）。
- **验证**：HTTP 与 TLS 两种形态下均退出码 0。

## P3（顺手修）

| 问题 | 修法 |
|---|---|
| 会话命中后不校验归属，`Mcp-Session-Id` 泄漏即可冒充 | `sessionFor()` 比对 `agentName`，不符 403 |
| `smoke-client.mjs` / `tls-check.mjs` 硬编码 `<author-machine>/dsh/mesh/data/admin.token`（作者机器残留） | 改为相对脚本目录的 `data/admin.token`，失败时给出可读提示 |
| 首次启动把 admin token 打进 stdout，长期留在 `docker logs` | 默认不打印，改用 `cat data/admin.token`；要打印设 `MESH_PRINT_ADMIN_TOKEN=1` |
| compose 无条件挂载 `./certs`，目录不存在时被 Docker 建成 root 属主 | 默认注释该挂载，启用 TLS 前先建目录 |
| `?limit=abc` 触发 `datatype mismatch` | `parseLimit()` 校验，返回可读 400 |

## 没做的（有意留白，等你决定）

- **per-agent ACL**：现在任何 agent token 都能读全板、给任何人发消息。家庭规模可接受，
  但真要分权就得引入角色/命名空间——属于功能扩展，不在本次范围。
- **消息 TTL 语义**：默认 7 天仍会静默丢弃"对端关机超过一周"的消息。当前只能调
  `MESH_MESSAGE_TTL_MS`；如果希望"未读永不删"，需要改清理策略（按已读时间而非创建时间）。
- **黑板 CAS**：仍是 last-write-wins，SKILL.md 的"写前先 get"只是约定。
