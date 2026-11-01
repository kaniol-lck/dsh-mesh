# Changelog
本项目从 0.1.0 开始记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer。
## [未发布]
暂无变更。
## [0.1.0] - 2026-11-01
### Added
- 把危险命令审批转进 dsh-mesh 收件箱：发送 silent 消息（不唤醒 agent，防自批），按 `request_id` 匹配回复。
- 支持 approve / always / session / deny 词表（含中文同义词），并校验宿主提供的 `allowed_choices`。
- 超时未回复按 deny 处理；只接受带 `request_id` 的回复，命中后标记已读。
