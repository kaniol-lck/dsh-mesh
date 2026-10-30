# 传输安全（把 hub 暴露到内网之外）

本文回答：**hub 要出内网时，用什么方式加密、怎么落地、会踩什么坑**。
具体地址、端口、证书指纹属于部署参数，不写进文档。

## 1. 威胁模型

- **内网不是安全边界**：同一 LAN 里可能有访客设备或失陷主机，token 才是身份；
- **公网必须 TLS**：bearer token 在明文里等于已泄露，任何公网端口只允许 HTTPS；
- **消息正文按不可信数据处理**：别的 agent 发来的文本不能当指令执行；
- **管理面单独收紧**：`/console` 与 `/api/admin/*` 受 `MESH_CONSOLE_ALLOW`（默认 loopback + RFC1918）限制，
  公网来源默认不在白名单，等于管理面不出网；真要开，先收紧 + 加 TLS；
- **密钥材料**：`ca.key`、`server.key` 只留服务端，权限 600；客户端只分发 `ca.crt`；
- **加密只保护传输**：库里仍是明文（SQLite），磁盘与备份权限是另一层。

## 2. 方案选型

| 方案 | 适用 | 代价 | 注意 |
|---|---|---|---|
| **SSH 隧道**（`ssh -L`） | 临时排障、单人 | 每个客户端都要配 SSH、断线要重连 | 不适合常驻 agent |
| **VPN**（WireGuard / Tailscale） | 多设备长期接入、保留内网语义 | 每台装客户端、管理密钥与路由 | 覆盖网络本身要维护 |
| **边缘 TLS**（frps + nginx 终止 TLS） | 已有 frp、不想改 hub | 多一跳；frp 单点；证书要分发 | hub 保持 loopback 明文，改动只在反代 |
| **hub 原生 TLS**（`MESH_TLS_CERT` / `MESH_TLS_KEY`） | 单机直连、没有反代 | 证书要挂进容器；端口直接对外 | 与 frp 组合时证书在 hub 侧维护 |
| **双层端口映射** | 只有一层 NAT、能改光猫 | 要动运营商设备 | 双层 NAT 下不可行 |
| **frp stcp / xtcp / virtualnet** | 不想暴露公网端口 | 每个客户端装 frpc、配置更复杂 | 点对点访问 |
| **Cloudflare Tunnel** | 有域名、想免公网 IP | 依赖第三方；免费版带宽有限 | 企业策略可能禁止 |

通用建议：**内网能直连就不要暴露**；必须暴露时优先「边缘 TLS 或 VPN」，并保持 hub 只监听 loopback。

## 3. 边缘 TLS 落地（通用步骤）

```
client → <edge-host>:<edge-port> (TLS 终止) → hub 127.0.0.1:8790
```

1. **frps**（公网侧）：`bindPort = <edge-port>`，`auth.method = "token"`，面板只监听 `127.0.0.1`；
2. **frpc**（hub 侧）：把本地 nginx 的 TLS 端口映射到 `<edge-port>`；
3. **nginx**：`listen 8443 ssl;` 证书指向服务端证书，`proxy_pass http://127.0.0.1:8790;`；
4. **hub**：保持 `MESH_HOST=127.0.0.1`，只给 nginx 用；
5. 每一层先验证再进下一层（见 §6）。

## 4. 证书

```bash
cd hub
node scripts/make-cert.mjs --out <cert-dir> --ip <edge-ip> --ip <lan-ip> --days 3650
```

- **SAN 必须包含客户端实际连接的地址**（公网 IP / 域名），否则校验失败；
- `ca.crt` 分发给客户端；`ca.key` / `server.key` 留在服务端并 `chmod 600`；
- 检查：

```bash
openssl x509 -in server.crt -noout -text | grep -A1 'Subject Alternative Name'
openssl x509 -in server.crt -noout -enddate
```

### 把 CA 发给对端

对端只需要 `ca.crt`（CA 信任锚）；`server.crt` 是叶子证书、**不能当信任锚**。可以把 CA 挂在 TLS 入口上
（nginx `location = /ca.crt`），对端三步：

```bash
curl -k https://<edge-host>:<edge-port>/ca.crt -o ca.crt      # -k 仅用于首次取 CA
openssl x509 -in ca.crt -noout -fingerprint -sha256          # 与中枢侧公布值比对
export NODE_EXTRA_CA_CERTS=$PWD/ca.crt                       # Windows: setx 后重启 DSH
curl --cacert ca.crt https://<edge-host>:<edge-port>/health  # 期望 200
```

- 常见错误：把叶子当锚 → `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN`；
  用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过等于关掉校验，禁止；
- **为什么 CA + 叶子两段式**：轮换时只换叶子、客户端 CA 不动；单文件自签方案每次轮换都要重新分发。

## 5. 轮换与到期

- 到期前 30 天提醒；`openssl x509 -in server.crt -noout -enddate` 检查；
- 只换叶子：重签 → 重启 TLS 终止层 → 客户端不用动；
- 换 CA：所有客户端重新取 `ca.crt`（这正是把 CA 挂在入口上的价值）；
- 轮换后按 §6 全量复验，确认旧证书不再可用。

## 6. 验证清单

| 检查 | 期望 |
|---|---|
| 外网 HTTPS（带 `--cacert`） | 200 |
| Node 客户端（`NODE_EXTRA_CA_CERTS`） | 200，`service=dsh-mesh`，版本与中枢一致 |
| 明文 HTTP 访问 TLS 端口 | 400 或连接被拒 |
| 无 token 访问 `/api/inbox` | 401 |
| 局域网明文（内网可信时） | 200 |

## 7. 已知限制

1. **Windows `curl.exe` 用 schannel**：自签 CA 无 CRL/OCSP，会报 `CERT_TRUST_REVOCATION_STATUS_UNKNOWN`，
   需要 `--ssl-no-revoke`；Node/OpenSSL 栈没有这个问题；
2. **frp 是 TCP 透传**：云端看到的源 IP 全是 `127.0.0.1`，`allowed_cidrs` 对公网来客失效；公网侧只能靠
   token + scopes；要用 IP 白名单，必须在自控反代注入 `X-Forwarded-For` 并设 `MESH_TRUST_PROXY=1`；
3. **waker 的本地会话端口永不出网**：只允许 loopback；隧道只映射 hub 端口；
4. **单层入口是单点**：入口主机挂了所有公网接入全断，需要冗余就自己加；
5. **自签证书的分发成本**：每个客户端都要配 `NODE_EXTRA_CA_CERTS`，浏览器会告警；没有 CRL/OCSP，
   吊销只能靠换证书 + 重新分发。
