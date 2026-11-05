<!-- drift: waker=^0.8.0 hub=^0.7.21 owner=docs -->
# 接入 dsh-mesh（一页纸）

给**公网上的陌生人**：网络环境未知（很可能是双 NAT、没有公网 IP、公司防火墙），
照着下面三步做完就能收发消息。**不需要开端口、不需要手抄 token。**

> 若 hub 使用**自签证书**（公网 TCP 透传场景），**必须按下面第 0 节配置 CA**；若 hub 使用公共 CA 签发的证书、或位于可信内网，则无需配置 CA。

> 契约版本：hub 0.7.15 / waker 0.5.0 起（`/api/bootstrap` + `joinCode` 自举 + pull 默认）。

---

## 0. 自签 CA / 公网部署（A 模式）

公网接法为 **frp TCP 透传 + 自签证书**（本机现用形态是**边缘代理终止 TLS**）。客户端第一次连 hub 时 CA 尚未被信任，而
`/api/bootstrap` 自己就在 TLS 后面——**不能用它来获取它自己的 CA**，所以 CA 必须带外交付。

### 0.1 服务端一次性准备

证书必须包含**外网访问用的 IP 或域名**（客户端实际输入的那个），否则即使 CA 受信也会因
hostname 不匹配而失败：

```bash
# --ip 与 --dns 至少给一个，写客户端实际连接的公网地址
node scripts/make-cert.mjs --out certs --ip <公网IP>
# 或者：node scripts/make-cert.mjs --out certs --dns mesh.example.com

# 产物：certs/ca.crt（分发给客户端）+ 服务器证书/私钥
```

证书装在**哪里**取决于部署形态——两种都支持，**客户端做法完全相同**（拿 `ca.crt` 信任）：

| 形态 | 证书装在哪 | hub 的 env |
|---|---|---|
| **边缘终止**（本机现用） | frp / nginx 等边缘代理 | **不设** TLS 变量；hub 只监听明文，由代理加 TLS |
| hub 自己终止 | hub 进程 | 设 `MESH_TLS_CERT` / `MESH_TLS_KEY`（可选 `MESH_TLS_CA_FILE`，让 `/api/bootstrap` 发布 CA） |

- 配置 `MESH_PUBLIC_URL=https://<公网IP>:<端口>`（bootstrap 会把该地址告诉新设备）；
- 边缘终止时，代理必须**透传真实来源地址**（`X-Forwarded-For` 等），否则 `MESH_CONSOLE_ALLOW`
  白名单看到的是代理 IP——见 [`auth-and-console.md`](auth-and-console.md) 的来源限制一节。

### 0.2 把 CA 带外交付给每台设备

把 `certs/ca.crt` 通过 U 盘、文件传输或粘贴到本机文件的方式交给每台客户端，**必须带外**：
bootstrap 端点在 TLS 后面，客户端在信任 CA 之前拿不到任何东西——先有鸡还是先有蛋。

### 0.3 客户端配置

| 客户端 | 配置 |
|---|---|
| waker 插件 | `hubUrl: 'https://<公网IP>:<端口>'` + `caFile: '<本地 ca.crt 路径>'`（**推荐持久配置**）；或临时用 `NODE_EXTRA_CA_CERTS=<本地 ca.crt 路径>` |
| handoff.py | `MESH_HUB=https://<公网IP>:<端口>`、`MESH_TOKEN_FILE=~/.dsh/mesh-waker/token`、`--ca <本地 ca.crt 路径>`（也可用 `MESH_CA_FILE`；可选 `--ca-sha256` 校验指纹） |

**`NODE_EXTRA_CA_CERTS` 只对 Node（waker）有效，对 Python（handoff.py）无效**——这是最容易踩的坑。
Python 侧一律用 `--ca` / `MESH_CA_FILE` 显式指定同一个 pem 文件。

### 0.4 验证顺序（先窄后宽）

```bash
# 1) 证书链与 CA 匹配（在服务端 certs 目录）
openssl verify -CAfile ca.crt server.crt

# 1b) 公网入口实际出示的证书（看 issuer 与 SAN 是否含你访问用的 IP/域名）
openssl s_client -connect <公网IP>:<端口> -servername <公网IP> </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -ext subjectAltName

# 1c) 没有 openssl 时（Windows 常见）用 Node 读 peer 证书：
node -e "const t=require('tls').connect({host:'<公网IP>',port:<端口>,servername:'<公网IP>'},()=>{const c=t.getPeerCertificate();console.log(c.issuer,c.subjectaltname||'')});t.on('error',e=>{console.error(e.message);process.exit(1)})"

# 2) 从设备验证信任链（Node，waker 同款）
NODE_EXTRA_CA_CERTS=<本地 ca.crt 路径> node -e "fetch('https://<公网IP>:<端口>/api/bootstrap').then(r=>r.json()).then(j=>console.log(j.service))"
# 应输出 dsh-mesh

# 3) 从设备验证信任链（Python，handoff.py 同款）
python -c "import ssl,urllib.request; print(urllib.request.urlopen('https://<公网IP>:<端口>/api/bootstrap', context=ssl.create_default_context(cafile='<本地 ca.crt 路径>')).status)"
# 应输出 200
```

### 0.5 常见失败对照

| 错误 | 含义 |
|---|---|
| `SELF_SIGNED_CERT_IN_CHAIN` / `CERTIFICATE_VERIFY_FAILED` | CA 没配或配错文件；确认用的是 hub 的 `ca.crt` |
| `ERR_TLS_CERT_ALTNAME_INVALID`（Node）/ `hostname mismatch`（Python） | 证书里没有这个 IP/域名 → 用 `--ip`/`--dns` 重签 |
| 通了但 `service` 不是 `dsh-mesh` | 连到了别的服务（反代/端口错） |
| `/api/bootstrap` 的 `tls` 为 `null` | hub 未配 `MESH_TLS_CA_FILE`（**边缘终止时这是正常的**，不是错误——TLS 由代理负责，hub 不发布 CA） |

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
