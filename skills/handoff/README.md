# handoff 速查

把一个工作区打成带 sha256 的 bundle，经 mesh hub 交给另一台机器；对端自动校验依赖。
完整说明见 [SKILL.md](SKILL.md)。

## 环境

```bash
export MESH_HUB=<hub-url>
export MESH_TOKEN=<token>        # 或 MESH_TOKEN_FILE=/path/to/token
export MESH_AGENT=<agent-a>
```

没有 hub 也能用：`pack` 出本地 bundle，手工拷贝，`receive --bundle` 解包。

## 三步

```bash
# 1) 打包（自动排除 .git/node_modules/*.env/token*/*.key/*.pem，密钥扫描命中即拒绝）
python skills/handoff/scripts/handoff.py pack \
  --workspace <workspace> --out handoff-<id>.tar.gz --id <id> \
  --conversation conv/handoff-<id> --next "解包|读摘要|继续" --max-bytes 67108864

# 2) 上传并通知
python skills/handoff/scripts/handoff.py send \
  --file handoff-<id>.tar.gz --to <agent-b> --conversation conv/handoff-<id> \
  --id <id> --visible-to <agent-a>,<agent-b>

# 3) 接收：下载 + 校验 + 解包 + 依赖检查
python skills/handoff/scripts/handoff.py receive \
  --id <blob-id> --dir ./incoming --sha256 <sha256>
# 本地 bundle：把 --id <blob-id> 换成 --bundle handoff-<id>.tar.gz
```

退出码：`0` 通过；`2` 有阻塞依赖缺失（进入协商）；`1` 其它错误。

## 依赖协商（最多两轮）

```bash
# 接收方：把 missing 原样回问
python skills/handoff/scripts/handoff.py msg --type needs --to <agent-a> \
  --conversation conv/handoff-<id> --id <id> --missing-file missing.json

# 发送方：补 delta 包或说明
python skills/handoff/scripts/handoff.py msg --type delta --to <agent-b> \
  --conversation conv/handoff-<id> --id <id> --round 1 --body-file delta.md
```

两轮仍未解决 → 人工介入。

## 自检

```bash
python skills/handoff/scripts/handoff.py --help
python skills/handoff/scripts/handoff.py pack --help
```

## 配置合并

```bash
python skills/handoff/scripts/merge_patch.py --backup old.yml --current current.yml --out merged.yml
```
