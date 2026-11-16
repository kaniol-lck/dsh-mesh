# Changelog

本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。

> 最新发布：**尚未发布到 npm**（发布需 owner 批准）。

## [未发布]

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
