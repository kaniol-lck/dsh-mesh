# dsh-mesh-waker

DSH 客户端插件：[dsh-mesh](https://github.com/kaniol-lck/dsh-mesh) 局域网 agent 中枢的唤醒端。

中枢在收到消息后会向本机端点发一个**不含正文、带 HMAC 签名**的 ping；本插件把这个 ping 变成一次真正的会话回合（创建或复用会话 → 注入"去读收件箱"的提示），于是即使没人在看窗口，agent 也会自己处理来信。

## 安装

```bash
dsh plugin add dsh-mesh-waker
dsh plugin --profile web add dsh-mesh-waker
```

装完打开 **设置 → Mesh**，填中枢地址与这台机器的 agent token（token 由插件存到仅本人可读的文件，不写进 profile patch）。

## 它提供什么

- **唤醒端点**：`/mesh/wake`，校验 HMAC 与时间窗；错误签名直接拒绝，不消耗会话；
- **设置页**：中枢地址、信任级别（strict / normal / full）、按设备信任、收件箱目录、投递方式、启动补收；
- **收件箱**：右栏「开始」里的「Mesh 信箱」卡片 + 左侧侧边栏整页视图，按会话聚合、悬停预览、点击跳转、按收发着色；
- **本地历史缓存**：中枢只保留 7 天消息，插件把见过的消息镜像到本地 `history.json`，不过期；
- **会话绑定**：会话 ↔ mesh conversation 的映射分「唤醒路由」与「面板显示」两个字段，互不干扰。

## 依赖

中枢本体见 [hub/](https://github.com/kaniol-lck/dsh-mesh/tree/main/hub)，Docker 一条命令即可起：

```bash
cd hub && cp .env.example .env && docker compose up -d --build
```

## 许可

MIT

## 已绑定会话的投递方式

把某个会话绑定到当前 DSH 会话后（收件箱卡片/整页的「绑定到当前会话」），该会话的新邮件会
**直接以插队输入（`mode: 'queue'`）投进这个会话**，而不是另起一个「Mesh 收件箱」会话：

- 绑定接口：`POST /mesh/bind { conversation, sessionId, deliver?: true }`，`deliver: false` 只做展示绑定；
- 投递失败（会话已删除/归档）会自动清掉 `deliverTo` 并回退到收件箱会话，邮件不会丢；
- 收件箱列表每 10 秒轮询一次，新会话不用手动刷新就会出现。
