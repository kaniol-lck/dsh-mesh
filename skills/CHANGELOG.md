# Changelog

本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。

> 最新发布：`0.3.0`。

## [0.3.0] - 2026-11-28

### Fixed

- **本包此前从未真正发布过**：`0.2.0`/`0.2.1`/`0.2.2` 都只写了 CHANGELOG，`npm view dsh-mesh-skills` 一直是 **404**。
  所以「发版后同步技能到各机器」这条约定**在源头就是空转的**——没有发布物可同步。这次是 npm 上的第一个版本。
  （发现于 owner 2026-11-28 问「协作技能同步给 nas dsh 了吗」，顺带查出本机 `~/.dsh/skills/mesh` 也停在 11-18。）

- registry 上除 `0.3.0` 外还有一个 **`0.0.0-stage`**：那是 npm 在发布过程中自动创建的占位版本
  （`description: "Temporary package placeholder for staged publishing"`），不是本包的内容，`latest` 指向 `0.3.0`。
  别被 `npm view dsh-mesh-skills versions` 里的两个版本号误导。
  （我自己就误判过：发布后 25 秒查 registry 读到陈旧缓存，以为「被 staged 暂存」；**查 registry 必须带 cache-buster**。）

### Added

- `skills/mesh/SKILL.md` §16「steer 的三个入口」：同一个「插队进当前回合」概念在三个入口参数名不同——
  `mesh_dispatch` 是 `mode`、`mesh_send` 是 `delivery`、`POST /mesh/inject` 是 `mode`。**写错参数名等于没生效**，
  且只有 `mesh_send.delivery` 还接受 `branch`。参数以 `docs/tools-reference.md` 为准，不要凭记忆写。

### Changed

- `mesh` 技能：跨机发消息的边界措辞改为「不要发给自己」（原「`to` 只填机器级 agent 名」），
  与工具契约守卫的用词一致；修正三处 `branch` / `backfill` 的转义残缺。

## [0.2.2] - 2026-11-17

### Changed

- `spawn` 在创建前校验标题：拒绝 `<工作区> · <角色>` 形式与「协调 / coordinator」等已废弃角色词
  （owner 2026-11-17：标题只做显示，身份走 session id）。拒绝时退出码 2 并给出可执行的替代写法。

## [0.2.1] - 2026-11-17

### Fixed

- `spawn` 增加**存活判据**：派生前读 `/mesh/sessions` 的 `live` / `archived` / `last_active`，已有存活派生会话时
  默认拒绝并列出会话 id，`--force` 才放行。**不按标题查重**（标题只做显示，身份走 session id）。
  起因：有会话把「回执 `lost` + 目录 17 分钟无写入」当成会话已死的证据，又开了一个同主题会话，
  实际原会话正在深度分析，两个都被 owner 手动掐掉。

## [0.2.0] - 2026-11-17

### Added

- 新增 `spawn` 技能：派生一层专项会话（重构讨论 / 方案对比 / 独立排查），主线只留结论与报告路径。
  `scripts/spawn.mjs` 默认 dry-run，`--apply` 才建会话并派首单；角色卡与报告目录按目标仓自动探测
  （`.worklog/roles/{special,l1-special,l1}.md`、`.worklog/{specs,reports}`），可用 `--role-card` /
  `--report-dir` 覆盖；默认只允许一层、在飞上限 3（2 小时窗口）。

### Changed

- `install` 现在安装四个技能（`mesh`、`handoff`、`worklog`、`spawn`）。

## [0.1.0] - 2026-11-13

### Added

- 首次发布：把 `mesh`、`handoff`、`worklog` 三个技能打包为 `dsh-mesh-skills`，附带零依赖安装器
  `dsh-mesh-skills install [--dest <dir>] [--force] [--dry-run]`。
