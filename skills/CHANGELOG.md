# Changelog

本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。

> 最新发布：`0.2.1`。

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
