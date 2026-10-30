# 公开文档索引

| 文档 | 定位 |
|---|---|
| [README](../README.md) | 项目定位、30 秒接入、能力概览 |
| [agent-onboarding.md](agent-onboarding.md) | 对端接入一页纸：装插件、填 `hubUrl` + `joinCode`、失败排查 |
| [mesh-architecture.md](mesh-architecture.md) | 拓扑、四条通道、消息语义、同步模型（pull 基线 / push 加速） |
| [scenarios.md](scenarios.md) | 五种典型环境：能做什么、降级成什么、需要准备什么 |
| [comparison.md](comparison.md) | 与 MCP、A2A、编排框架、工作流引擎、聊天机器人、组网工具的对比与边界 |
| [auth-and-console.md](auth-and-console.md) | token 生命周期、scopes、IP 白名单、注册码、控制台角色 |
| [local-sessions.md](local-sessions.md) | 本机会话发现与定向注入的端点与参数（不经过中枢） |
| [security.md](security.md) | 通用安全指南：威胁模型、接入方式取舍、自签 CA 规则、凭据与审计 |
| [release.md](release.md) | 发布流程：npm 双 tag、预检、promote、hub 镜像发布与回滚 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 仓库结构、本地验证、提交规范 |

技能（给 agent 看）：

- [skills/mesh](../skills/mesh/SKILL.md) —— 中枢协作约定（收件箱、黑板、派活、批次）
- [skills/handoff](../skills/handoff/SKILL.md) —— 工作区交接（bundle + 依赖协商）
