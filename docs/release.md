# 发布流程

目标：**坏版本不进 `latest`**。发布分三级，任何一级都可以停下。

## 版本递增纪律

- 平时不改版本号：bug 修复、文档、测试、重构都不动 `version`，版本号只在发版时跳；
- 发版时一次改齐（漏一处就会出现 drift）：
  - hub：`HUB_VERSION`（`hub/server.mjs`）+ `hub/package.json` + `hub/package-lock.json` + `CHANGES.md` 条目；
  - waker：`plugins/mesh-waker/package.json` + `CHANGELOG.md` 新版本条目；
- 发版前必须全绿：`node scripts/check-paths.mjs`、`python scripts/check-secrets.py`、
  `python scripts/release.py --preflight`；
- 文档里**不要抄当前版本号**：以中枢 `/health` 与发布记录为准。

## 插件（npm）三级

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

凭据只从环境变量 `NPM_TOKEN` 读，脚本把临时 `.npmrc` 写到系统临时目录并用 `--userconfig` 指过去，
**不会在仓库里留下任何凭据文件**。

## 发布顺序（hub 与 waker）

两者独立发布、互不阻塞。若当次**两边都变**，先发 hub、再发 waker：客户端插件通常依赖中枢的新端点/新字段，
先上 hub 才能让 waker 的新行为有落点；反过来会出现一段「插件已升级、中枢还不支持」的窗口。

## 回滚

- **hub**：把容器镜像换回上一个版本 tag 并重启；数据卷不受影响。回滚后立刻核对 `/health` 版本。
- **waker（npm）**：用 `npm dist-tag add dsh-mesh-waker@<旧版本> latest` 把 `latest` 指回旧版本；
  **不要用 `npm unpublish`**——已发布版本可能已被别人安装，unpublish 会破坏可复现性，npm 对时间窗也有限制。
  回滚后让一台机器重装验证：`dsh plugin add dsh-mesh-waker`。

## 预检做什么

1. 语法与可加载性：`node --check plugins/mesh-waker/index.js client.js`（必要时 `node scripts/check-loadable.mjs`）；
2. `node test/dynamic-id.test.js` —— 客户端 bundle 必须按启动清单认领模块 id
   （link 安装 = `@local/dsh-mesh-waker`，npm 安装 = `dsh-mesh-waker`，写死任何一个都会让另一种安装
   的 web boot 失败）；
3. `scripts/check-secrets.py`；
4. 仓库内存在 `.npmrc` 直接判失败；
5. **双轴版本自检**（任一不一致即 FAIL，并打印差异）：

| 轴 | 校验内容 |
|---|---|
| **waker 轴** | `plugins/mesh-waker/package.json` 的 `version` 与 `CHANGELOG.md` 顶部 `## v<版本>` 条目一致 |
| **hub 轴** | `hub/server.mjs` 的 `HUB_VERSION` == `hub/package.json` 的 `version`，且 `hub/CHANGES.md` 顶部有 `## v<版本>` 条目 |

预检失败时**先改版本文件，不要改脚本**：把上面涉及的常量、`package.json` 与变更记录顶部条目对齐到同一个版本号，再重跑预检。
为什么要它：版本号散落在多个文件里，靠人记必出错；三处不一致时部署出去，`/health` 与仓库对不上，排查成本远高于这条检查。

CI（`.github/workflows/plugin-check.yml`）在 push / PR 时跑前两项，失败即挡在发布之前。

## hub（镜像/部署）通用流程

hub 不走 npm，按下面的通用步骤发布；部署目标（本机、容器平台、云主机）由部署者自行选择。

1. **bump 三处**：`HUB_VERSION`、`hub/package.json`、`hub/package-lock.json`，并补 `CHANGES.md`；
2. **预检**：`python scripts/release.py --preflight`（版本一致性、密钥扫描、无 stray `.npmrc`）；
3. **构建镜像**：用仓库 `hub/Dockerfile` 构建，镜像 tag 用版本号（不要只留 `latest`，回滚才有抓手）；
4. **部署并验证**：`/health` 返回的版本等于新版本；若经反代/隧道暴露，再验一次公网入口返回 200；
5. **打 tag**：`git tag v<版本> && git push origin v<版本>`；
6. **回滚**：见下方「回滚」一节（镜像 tag 换回上一版，数据卷不动）。

## 提升前的人工验收

- 本机 link 安装：刷新 GUI，`web boot` 无报错，右侧 Mesh 信箱在；
- 让对话收到一封信，确认唤醒/投递按预期工作；
- npm 命名边界：确认只在 npm 发布 `dsh-mesh-waker`；`hub/package.json` 保持 `private: true`；
  不要把 hub 当成 `dsh-mesh` 发布（npm 上同名包属第三方）；
- 远端的升级等到 `latest` 提升之后再统一做。
