# 贡献指南

## 仓库结构

```
hub/                    中枢服务（Node，单文件 server.mjs + Dockerfile + 控制台）
plugins/mesh-waker/     DSH 客户端插件（唤醒端点 -> 会话回合）
plugins/mesh-approval/  审批转发插件（Hermes 兼容，Python）
docs/                   公开文档（安装、API、架构、发布、传输安全）
skills/                 给 agent 的技能说明（mesh、handoff）
scripts/                门禁与辅助脚本（密钥扫描、路径检查、发布、REST 小工具）
test/                   测试（waker 端点、动态 id 等）
```

## 本地验证

提交前请跑：

```bash
node test/waker-endpoints.test.js     # waker 端点测试
node scripts/check-paths.mjs          # 路径/内网拓扑门禁（必须 0）
python scripts/check-secrets.py       # 凭据扫描（必须 0）
node scripts/check-loadable.mjs       # 客户端 bundle 可加载性
python scripts/release.py --preflight # 发版预检（改到发布相关时）
```

CI 会在 push / PR 时跑其中前两项，失败即挡在合并之前。

## 提交规范

- commit message 写**为什么**（不只写“更新”）：一句话说明动机 + 影响面；
- 不提交凭据、token、`.npmrc`、私钥；`scripts/check-secrets.py` 会扫描；
- 不提交本机绝对路径或真实内网地址；`scripts/check-paths.mjs` 会拦截；
- 一个提交只做一件事，便于 review 与回滚。

## 发版

发版是维护者操作，通用流程见 [docs/release.md](docs/release.md)：
插件走 `python scripts/release.py`（先 `next`，验证后 `--promote`）；hub 走镜像构建 + `/health` 版本核对 + tag。
任何发布动作都需要维护者确认。

## 文档

- 公开文档在 `docs/`，安装与接入优先看 `docs/agent-onboarding.md`；
- 新增公开文档请在 `docs/README.md` 登记一行定位；
- 示例中的地址/端口用占位符（`<hub-url>`、`<edge-port>` 等），不要写真实环境值。
