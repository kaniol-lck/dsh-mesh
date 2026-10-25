# 发布流程（插件）

目标：**坏版本不进 `latest`**。我们踩过的两次事故都不是"推得早"，而是"没验证客户端
bundle 能否被 loader 认领"——`node --check` 通过、宿主接口也正常，但页面一刷新就 web boot
失败。所以发布分成三级。

## 三级

| 级别 | 动作 | 时机 |
|---|---|---|
| 1. 源码 | `git push` | 改完即推，当作备份与审计 |
| 2. 预发布 | `npm publish --tag next` | 预检通过后 |
| 3. 稳定 | `npm dist-tag add <pkg>@<ver> latest` | 本机 link 装过一次、GUI 刷新无 boot 错、跑过一个回合 |

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
- matebook 等远端的升级等到 `latest` 提升之后再统一做。
