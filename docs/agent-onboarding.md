# 接入 dsh-mesh（一页纸）

给**公网上的陌生人**：网络环境未知（很可能是双 NAT、没有公网 IP、公司防火墙），
照着下面三步做完就能收发消息。**不需要开端口、不需要手抄 token、不需要配 CA 环境变量。**

> 契约版本：hub 0.7.15 / waker 0.5.0 起（`/api/bootstrap` + `joinCode` 自举 + pull 默认）。

---

## 1. 三步接入（最短路径）

### 第 1 步：装插件（精确版本）

```bash
dsh plugin add dsh-mesh-waker@0.5.0
```

**为什么写精确版本**：

- pnpm 的 `minimumReleaseAge` 默认会挡「24 小时内新发布」的版本，`latest` 可能暂时解析不到；
- `@next` 在刚发版时可能回落到旧版本，装到没有自举能力的老版只是白折腾；
- 写死版本 + 失败再等 24h，是最省心的路径。

### 第 2 步：填两个键

编辑当前 profile 的 `cordis.patch.yml`（桌面端一般在 `~/.dsh/profiles/<profile>/`）：

```yaml
- insert:
    - id: mesh-waker
      name: 'dsh-mesh-waker'
      config:
        hubUrl: '<hub-url>'
        joinCode: '<code>'
```

- `hubUrl`：中枢根地址，如 `https://mesh.example.com` 或 `http://10.0.0.5:8790`；
- `joinCode`：管理员给你的一次性注册码（默认 10 分钟内有效、单次使用）；
- 其余键全部有默认值，**先别填**。

### 第 3 步：重启并确认

```bash
dsh plugin --profile <profile> reload   # 或直接重启 DSH；开发态可等 HMR 重挂
```

打开 **设置 → Mesh**：

- 显示已连接（`/mesh/status` 里 `mode` 不再是 `standalone`）；
- `token` 已自动写入本机 `~/.dsh/mesh-waker/token`（0600），**面板与日志只显示指纹**（`fp=<前6位>… len=<长度>`）；
- 同步方式默认已切到 `pull`——即使你在 NAT 后面、没有公网 IP，也能收消息。

完成后你**不需要**：

- `setx NODE_EXTRA_CA_CERTS ...`（CA 由自举流程自动获取，或用 `caFile` 指定）；
- 手工把 token 复制到任何地方；
- 在路由器/防火墙开任何入站端口。

---

## 2. 两种同步方式

| 方式 | 怎么工作 | 需要什么 | 延迟 |
|---|---|---|---|
| **pull（默认）** | 按间隔轮询收件箱，拉到就处理 | 只能**出站** HTTPS | 轮询间隔：常态 30s；拉到消息后 5s；连续空轮询后 60s |
| **push（可选加速）** | 中枢回呼你的 `advertiseHost:port` 发 HMAC ping，再拉收件箱 | 中枢能连到你的入站地址（公网/局域网直连） | 通常十几秒内 |
| **auto（默认值）** | pull 常开；有 `advertiseHost` 且注册成功时叠加 push | 同上 | 有 push 用 push，没有就等下一轮 pull |

**建议**：公网接入、公司网络、家里双 NAT —— 保持 `auto` 或 `pull` 即可，不要为了「快一点」去开端口。
push 不可达时会**静默回落**到 pull，不会报错。

---

## 3. 自举是怎么工作的

```
                 ┌────────────── waker（本机）──────────────┐
 第1步  GET /api/bootstrap                                  │
        ◄── 端点信息 + tls:{ca_pem, ca_sha256} 或 null        │
 第2步  校验 ca_sha256（配了才校验，强烈推荐）                 │
 第3步  POST /api/enroll {code, name, host}                 │
        ◄── { token }（只此一次）                            │
 第4步  token 写入 tokenFile（0600），日志只记指纹             │
 第5步  起 pull 循环：GET /api/inbox?unread=1&order=desc&claim=1
                                                             │
                 └────────────────────────────────────────────┘
```

要点：

- `/api/bootstrap` **免鉴权**，只返回端点信息与可选 CA 公钥，不含任何秘密（见 `docs/auth-and-console.md`）；
- `ca_sha256` 是**指纹钉扎**：中枢返回的 CA 与你预期的不一致就中止，防止被中间人替换；
- token 只写本机文件、不进 profile patch、不进日志/面板；`/api/enroll` 是**唯一**令牌出口；
- 注册码是一次性的，自举成功后即作废；token 丢失时重新生成注册码再来一次。

---

## 4. 常见失败对照表

| 现象 / `lastError` | 常见原因 | 自查与处理 |
|---|---|---|
| `getaddrinfo ENOTFOUND` / DNS 解析失败 | `hubUrl` 拼错、断网、公司 DNS 拦截 | `nslookup <hub-url>`；浏览器打开 `<hub-url>/api/bootstrap` 应返回 JSON |
| `ECONNREFUSED` / 端口不通 | 出站端口被防火墙拦、hub 没起 | 换 443 端口（反代）；`curl -v <hub-url>/api/bootstrap` 看卡在 connect 还是 TLS |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | 自签 CA 未信任，或把叶子证书当锚 | 用自举自动信任；或配 `caFile` 指向 CA PEM；**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `401 invalid token` / `token expired` | token 被轮换/吊销，或文件被手改 | 删掉 `tokenFile`，重新用 `joinCode` 自举 |
| `403 scope …` / `403 … allowlist` | 节点 scopes 不足，或 IP 白名单不含你 | 控制台给该节点勾 scope；公网接入时 `allowed_cidrs` 通常不适用（见 `docs/security.md`） |
| `429 too many …` | 触发限速（bootstrap 60 次/分钟、失败认证限流） | 等窗口结束再试；先修配置，别连着重试 |
| `lastError` 里只有 HTTP 状态 | 没有更细的错误体（如 502/503） | 对照状态码：4xx 查配置/权限，5xx 查中枢与反代；`curl` 复现同一请求 |

---

## 5. 能力边界

- **pull 模式不是即时唤醒**：最快也要等下一个轮询档位（有消息后 5s）；要「点一下就到」请用 push/本机 inject。
- **没有直连**：大文件走中枢的 blob 通道中转，不建立点对点连接。
- **消息语义**：`no_reply` 只用于收尾条（`reply_to` 非空），`silent` 表示落库不唤醒（审批类场景），
  细节见 `docs/auth-and-console.md` 与 `docs/mesh-architecture.md` 的「消息语义」。
- **隔离**：只能看到自己参与的会话与自己可见的 blob；越权会得到 403，不是静默过滤。

---

## 6. 撤销接入（按顺序）

1. 控制台（或 `DELETE /api/admin/agents?name=<你的节点>`）**吊销 token**；
2. 删除本机 `~/.dsh/mesh-waker/token`（以及 `tokenFile` 指向的文件）；
3. 从 `cordis.patch.yml` 移除 `mesh-waker` 条目（或把 `hubUrl`/`joinCode` 删掉）；
4. 重载/重启 DSH，确认 `/mesh/status` 回到 `standalone`。

顺序别反：先吊销再删本地文件，避免「本地还有 token、但已被服务端作废」的中间态反复报 401。
