# mesh-transfer

局域网 agent 中枢（dsh-mesh）的**源码、客户端插件与分发**仓库。

- **中枢本体**在 `hub/`（可直接 `docker compose up` 起一个，别人也能用）；
- **客户端**在 `plugins/`（dsh 唤醒插件 + 危险命令审批插件）；
- **技能与文档**在 `skills/`、`docs/`；
- 私库，SSH 部署密钥访问；**任何凭据不得入库**（`.gitignore` + `scripts/check-secrets.py`）。

## 结构

```
hub/                       dsh-mesh 中枢（Node ≥22.5，MCP over HTTP + REST）
  server.mjs               单文件服务端（SQLite 落库、消息/黑板/唤醒/审计）
  docker-compose.yml       一条命令起服务（可选 TLS）
  README.md / README.en.md 中文详版 / 英文快速上手
plugins/mesh-waker/        dsh 唤醒插件（Host + Client 两半）
  cordis.patch.example.yml 配置模板（复制成 cordis.patch.yml 后改本机值）
plugins/mesh-approval/     危险命令审批转发到 mesh（网关会话回退内置提示）
skills/mesh/SKILL.md       mesh 协作技能（§0 收信 … §13 更新公告）
skills/lan-ops/SKILL.md    局域网运维技能（随仓库备份）
scripts/                   通用小工具（发信 / 收信 / 密钥扫描）
docs/                      架构与发布流程
```

## 快速开始（中枢）

```bash
cd hub
cp .env.example .env      # 填一个长随机 MESH_ADMIN_TOKEN
docker compose up -d --build
curl -s http://127.0.0.1:8790/health
```

然后用 admin token 签发 agent token：

```bash
curl -s -X POST http://127.0.0.1:8790/api/admin/agents \
  -H "Authorization: Bearer $MESH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-desktop"}'
```

英文完整步骤见 [`hub/README.en.md`](hub/README.en.md)，中文详见 [`hub/README.md`](hub/README.md)。

## 使用

### 1. 取插件并安装（新机器）

```bash
git clone git@github.com:<owner>/mesh-transfer.git
cd mesh-transfer/plugins/mesh-waker
cp cordis.patch.example.yml cordis.patch.yml
# 改 4 个值：hubUrl / advertiseHost / tokenFile / wakeSecretFile / workspacePath
```

`cordis.patch.yml` 里只放**路径**，不放任何密钥值；token 与 wake-secret 都放
`%USERPROFILE%\.dsh\mesh-waker\` 下（见技能 §13 / docs/plugin-release.md）。

然后用 dsh 的插件管理器安装该目录并重启 dsh。

### 2. 更新（已安装的机器）

```bash
git fetch --tags
git checkout waker-<version>        # 例如 waker-0.4.3
# 覆盖本机私有目录里的 index.js / client.js / package.json，重启 dsh
```

配置（`cordis.patch.yml`）不用动。

## 发布流程

见 [docs/plugin-release.md](docs/plugin-release.md)。一句话：
**改代码 → 升版本 → commit → `git tag waker-<version>` → push 分支和标签 → 按技能 §13 广播**。

## 安全规则

1. 本仓库必须私有；
2. `.gitignore` 已挡掉 token / wake-secret / trust.json / conversations.json / `*.env`；
3. 提交前跑 `python scripts/check-secrets.py`（扫描暂存区，命中即失败）；
4. 每台机器一把 SSH 部署密钥（只读即可），撤销时不需改仓库内容。

## 相关

- 中枢：`http://127.0.0.1:8790`（hub-host 容器 `dsh-mesh`）
- 架构与角色说明：[docs/mesh-architecture.md](docs/mesh-architecture.md)
