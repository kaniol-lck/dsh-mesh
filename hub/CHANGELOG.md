# Changelog
本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。
## [未发布]
### Added
- 任务回执可标记 `observed`（自动结算）或 `declared`（客户端声明）；新增单条任务查询、`redispatch`（重置 parked/expired）与 `cancel`；blob 列表可按 `sha256` 精确反查任务正文。
## [0.8.0] - 2026-11-08
### Added
- 跨机任务账本：`/api/tasks` 提供 tasks/receipts 表、claim/lease 租约与心跳、结算回执；失败转 `parked` 不丢，deadline 过期转 `expired`。
## [0.7.21] - 2026-10-31
### Fixed
- 会话视图的 4 KiB 截断改为按 UTF-8 字节计算，不再超出上限或把中文/emoji 截成乱码。
## [0.7.20] - 2026-10-31
### Changed
- 环境变量与 `.env.example`、`docker-compose.yml` 全面对齐，部署配置不再漏项。
## [0.7.19] - 2026-10-31
### Added
- 收件箱未读消息不再因超过 TTL 被删除，而是标记 `stale` 并返回 `stale_count`。
- 黑板写入支持 `if_version` 乐观锁与 `visible_to` 可见性，不可见 key 返回 404。
## [0.7.18] - 2026-10-31
### Fixed
- `/api/blobs` 只列出调用者可见的文件，越权读取与元数据统一返回 404。
- blob 提交大小不符时同时删除文件与记录，不再残留 `uploading` 行。
### Changed
- 新增 `MESH_MAX_BLOB_CHUNK_BYTES`（默认 8 MiB），单 chunk 超限返回 413；`/health` 暴露文件/分片/总量上限。
## [0.7.17] - 2026-10-31
### Added
- 签发与轮换令牌时可指定 `expires_at`，到期请求返回 401 `token expired`；控制台可设置或清除。
## [0.7.16] - 2026-10-31
### Security
- 控制台保存空 scope 集返回 400（此前等于全权）；全权必须显式传 `["*"]`。
- `MESH_CONSOLE_ALLOW` 默认收紧为仅 loopback，`/api/admin/*` 同受来源限制。
## [0.7.15] - 2026-10-29
### Added
- 新增无需鉴权的 `GET /api/bootstrap`，返回版本、端点、TLS CA 与唤醒参数，便于客户端零配置接入。
- 收件箱支持两阶段 `claim=1` / `claim_ttl_ms`，租约到期后可重新领取。
## [0.7.14] - 2026-10-29
### Fixed
- `no_reply` 仅在带 `reply_to` 的对话收尾消息上生效，无 `reply_to` 时照常唤醒。
### Added
- `silent:true` 可只落库不唤醒；收件箱新增 `order=desc` 与 `before` 游标分页。
## [0.7.13] - 2026-10-29
### Added
- 控制台可生成一次性注册码；新节点也可用设备码请求，管理员批准后取回 token。
- 节点列表显示 `last_seen_at`，并可彻底清理已吊销节点。
## [0.7.12] - 2026-10-29
### Security
- REST 面按 `read/send/board/blob` scopes 判权，越权返回 403 与 `required_scope`。
## [0.7.11] - 2026-10-28
### Added
- 控制台支持退出与切换令牌。
## [0.7.10] - 2026-10-28
### Fixed
- 控制台内联脚本转义错误导致页面按钮失效。
## [0.7.9] - 2026-10-28
### Added
- 管理员控制台：只读/管理员双角色、CSRF 保护、按 agent 设置 scopes 与 IP 白名单、令牌过期时间。
## [0.7.8] - 2026-10-28
### Added
- 注册码签发与兑换：一次性 code（10 分钟）换 agent token，按 IP 防爆破。
## [0.7.7] - 2026-10-27
### Added
- 消息可带 `delivery` 建议（queue/steer/branch），由接收方决定投递方式。
## [0.7.6] - 2026-10-27
### Added
- 发送时可带 `session`，随消息与唤醒传递，便于接收端把对话绑回发起会话。
## [0.7.5] - 2026-10-26
### Added
- 只读控制台 `GET /console`：cookie 登录、来源限制与错误令牌锁定。
## [0.7.4] - 2026-10-26
### Added
- 节点可上报插件版本，`/api/peers` 与 `/api/status` 标记过期插件。
## [0.7.3] - 2026-10-26
### Added
- 消息可带 `interrupt` 提示；relay 唤醒用 `X-Hermes-Session-Key` 区分会话。
## [0.7.2] - 2026-10-25
### Fixed
- 空闲会话回收不再删除持久化记录，重启后可恢复 MCP 会话。
## [0.7.1] - 2026-10-25
### Added
- 发送时可用 `important` 标记重要消息，不随 7 天 TTL 删除。
## [0.7.0] - 2026-10-25
### Added
- 会话视图：对话列表、消息流（默认截断 4 KiB，`full=1` 取全文）、单条消息与重要消息列表。
## [0.6.2] - 2026-10-25
### Added
- MCP 会话持久化：进程重启后按 session id 重建；可选 `MESH_MCP_LENIENT_SESSION`。
## [0.6.1] - 2026-10-25
### Added
- blob 断点续传（init → chunk → commit），校验大小与 sha256；`visible_to` 控制读取范围。
## [0.6.0] - 2026-10-25
### Added
- blob 文件通道（上传/下载/元数据/列表/删除），单文件默认 64 MiB、24 小时过期。
## [0.5.7] - 2026-10-24
### Added
- 对话分组与 `no_reply`、黑板 owner/status、广播 `to:"*"`、按 agent 的唤醒密钥。
- relay 唤醒，并用 `X-Hermes-Session-Key` 传递会话键。
## [0.4.0] - 2026-10-23
### Added
- 消息支持 `conversation` 对话分组，唤醒携带对话 id。
## [0.2.2] - 2026-10-22
### Fixed
- 未知 MCP session id 返回 404，客户端可正确重新初始化。
## [0.2.1] - 2026-10-22
### Fixed
- `mesh_whoami` 返回名册中的 host 与实际可达 URL，不再显示 `0.0.0.0`。
## [0.1.0] - 2026-10-21
### Added
- 初始版本：MCP 工具、REST、令牌鉴权、收件箱、黑板与唤醒。
