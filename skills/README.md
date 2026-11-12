# dsh-mesh-skills

DSH 技能包：把 **mesh 协作约定**、**handoff 工作区交接**、**worklog 多会话台账** 一次装进
`~/.dsh/skills`。与插件 **`dsh-mesh-waker` 是两个包**：

- `dsh-mesh-waker`：DSH 客户端插件（npm 包，`dsh plugin add dsh-mesh-waker`），负责唤醒与会话注入；
- `dsh-mesh-skills`：本包，只装技能文件（`mesh/`、`handoff/`、`worklog/`），不含任何运行时依赖，
  不启动服务、不改 DSH profile。

两者同仓发布、分开安装：插件更新不影响技能，技能更新也不要求重装插件。

## 安装

```bash
npm i -g dsh-mesh-skills
dsh-mesh-skills install                 # -> ~/.dsh/skills/{mesh,handoff,worklog}
dsh-mesh-skills install --dest ./skills # 自定义目录
```

选项：

| 选项 | 含义 |
|---|---|
| `--dest <dir>` | 目标技能目录，默认 `~/.dsh/skills` |
| `--force` | 目标已有同名技能时覆盖（默认跳过并打印「已存在，跳过（--force 覆盖）」） |
| `--dry-run` | 只打印计划（`copied/skipped/overwritten`），零写入 |
| `-h, --help` | 打印用法，零副作用 |

每个技能输出一行 `copied|skipped|overwritten <skill> -> <目标路径>`，最后一行是汇总。
安装器只复制技能目录，不碰 `~/.dsh/config` 或 profile。

## 技能清单

| 技能 | 用途 |
|---|---|
| `mesh` | 局域网 agent 中枢 dsh-mesh 的协作约定：收件箱、消息/黑板、会话绑定与派活 |
| `handoff` | 把工作区 + 上下文 + 依赖打成带 sha256 的 bundle，交给另一台机器/另一个 agent |
| `worklog` | 多会话/多 agent 台账：`todo/<角色>.md`、`WORKLOG.md`、`roadmap.mjs` 总览与门禁 |

## 发布说明

- 版本见 `CHANGELOG.md`；当前 `0.1.0`（MVP，**尚未 `npm publish`**，发布需 owner 明确批准）。
- 发布包**不包含** `__pycache__`/`.pyc`/`.pyo`（`.npmignore` 排除；`files` 白名单里也加了对应 `!` 规则——npm 在有 `files` 时只看白名单，单靠 `.npmignore` 不会生效）。
- 本包暂未纳入仓库根的门禁（`check-changelog` / `check-version-sync` 目前只覆盖三个插件/hub）；
  TODO：发布前把 `skills/package.json` 的版本与 `CHANGELOG.md` 接入门禁。
