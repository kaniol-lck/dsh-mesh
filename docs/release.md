# 发布流程（插件与 hub）

目标：**坏版本不进 `latest`**。我们踩过的两次事故都不是"推得早"，而是"没验证客户端
bundle 能否被 loader 认领"——`node --check` 通过、宿主接口也正常，但页面一刷新就 web boot
失败。所以发布分成三级。

## 人工确认门（2026-10-27 起）

**发版动作必须等 owner 手动确认，代码推送不受限。** 具体：

| 动作 | 是否需确认 |
|---|---|
| 改代码、同步、git commit、git push | 否，改完即做 |
| npm publish（含 `--tag next` 与 `--promote`，统一由 `scripts/release.py` 执行） | **是** |
| 部署 hub 到 NAS（docker 重建/重启） | **是** |

申请确认时一次性给出：版本号、改了什么、预检结果、关键路径实测结果（真实收发的日志/响应），
然后停下等 owner 回复；确认后再执行发布/部署。被拒绝就只保留代码提交与验证记录。

## 版本递增纪律

- **平时不改版本号**：bug 修复、文档、测试、重构都不动 `version`，版本号只在发版时跳；
- 发版时一次性同步（漏一处就会出现 drift）：
  - hub：`HUB_VERSION`（`hub/server.mjs`）+ `hub/package.json` + `hub/package-lock.json` + `CHANGES.md` 对应条目；
  - waker：`plugins/mesh-waker/package.json` + `CHANGELOG.md`（新版本条目；还没有就先新建）；
- 发版前必须全绿：`node .worklog/bin/roadmap.mjs --check`（含版本一致性硬校验）、`node scripts/check-paths.mjs`、
  `python scripts/release.py --preflight`；
- 文档里**不要抄当前版本号**：ROADMAP 自动段的「版本快照」是唯一展示位，其余文档只写「以中枢 `/health` / 自动段为准」。

## 三级

| 级别 | 动作 | 时机 |
|---|---|---|
| 1. 源码 | `git push` | 改完即推，当作备份与审计 |
| 2. 预发布 | `python scripts/release.py`（发到 `next`） | 预检通过后 |
| 3. 稳定 | `python scripts/release.py --promote` | 本机 link 装过一次、GUI 刷新无 boot 错、跑过一个回合 |

`next` 标签不改 `latest`，别人 `dsh plugin add dsh-mesh-waker` 拿不到；想让某台机器先试，用
`dsh plugin add dsh-mesh-waker@next`。

## 一条命令

```bash
# 预检（语法 + bundle id 用例 + 密钥扫描 + 仓库内不得有 .npmrc）
python scripts/release.py --preflight

# 预检 + 发到 next
python scripts/release.py

# 本机验证通过后，把当前版本提升为 latest
python scripts/release.py --promote
```

凭据只从环境变量 `NPM_TOKEN` 读（vault 注入），脚本把临时 `.npmrc` 写到系统临时目录并用
`--userconfig` 指过去，**不会在仓库里留下任何凭据文件**。

## hub 发版流程（镜像 + NAS 部署）

hub 不走 npm，走镜像 + NAS 部署，同样要过 owner 确认门（命令细节见 `docs/multi-session-playbook.md` §5）。

1. **bump 三处**（一次改齐，否则 `roadmap --check` 会报 version drift）：`HUB_VERSION`（`hub/server.mjs`）、
   `hub/package.json`、`hub/package-lock.json`；同时补 `hub/CHANGES.md` 对应条目。
2. **预检**：`python scripts/release.py --preflight`（语法、版本一致性、密钥扫描、无 stray `.npmrc`）。
3. **部署**：用 `sessions\<本机脚本>\ssh_deploy_*.py` 在 NAS 上重建/重启容器（脚本名以实际为准）。
   NAS 构建**必须**走 `registry.npmmirror.com`——直连 `registry.npmjs.org` 会 20 秒超时卡住安装（0.7.14 的真实事故）。
   镜像 tag 用版本号（如 `dsh-mesh:<版本>`），不要只留 `latest`，回滚才有抓手。
4. **部署后验证**：`/health` 返回的版本等于新版本；公网入口 `https://<hub>` 返回 200
   （自签 CA 与 `curl --ssl-no-revoke` 见 `docs/transport-security.md`）。
5. **打 tag 并推送**：`git tag v<版本> && git push origin v<版本>`；GitHub Release 页用 `gh release create`，
   摘要与 `hub/CHANGES.md` 口径一致。
6. **回滚**：把容器镜像换回上一个版本 tag 并重启；数据在 `hub/data`，镜像回滚不动数据。

## 预检做什么

1. `node --check plugins/mesh-waker/index.js client.js`；
2. `node test/dynamic-id.test.js` —— 客户端 bundle 必须按启动清单认领模块 id
   （link 安装 = `@local/dsh-mesh-waker`，npm 安装 = `dsh-mesh-waker`，写死任何一个都会让另一种安装
   的 web boot 失败）；
3. `scripts/check-secrets.py`；
4. 仓库内存在 `.npmrc` 直接判失败。

CI（`.github/workflows/plugin-check.yml`）在 push / PR 时跑前两项，失败即挡在发布之前。

## 提升前的人工验收

- 本机 link 安装：刷新 GUI，`web boot` 无报错，右侧 Mesh 信箱在；
- 让对话收到一封信，确认唤醒/投递按预期工作；
- npm 命名边界：确认只在 npm 发布 `dsh-mesh-waker`；`hub/package.json` 保持 `private: true`；不要把 hub 当成 `dsh-mesh` 发布（npm 上同名包属第三方）；
- matebook 等远端的升级等到 `latest` 提升之后再统一做。
