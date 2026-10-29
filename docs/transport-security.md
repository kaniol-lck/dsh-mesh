# 传输安全（外网接入）

本文回答一个问题：**hub 要出内网时，用什么方式加密、怎么落地、怎么验证、会踩什么坑**。
结论按 2026-10-29 的本机实测环境书写；换网络环境时先看 §2 的决策表，再看 §3 是否仍适用。

> 本文不写任何口令 / token / 私钥；LAN 侧地址用占位符（`<NAS-IP>`、`<home-public-ip>`），
> 公网入口地址与端口是部署事实，直接写出。

---

## 1. 威胁模型

- **内网不是安全边界**：同一 LAN 里可能有访客设备或失陷的主机，token 才是身份；但内网明文可接受的前提是「整段链路你都控制」。
- **公网必须 TLS**：bearer token 在明文里等于已泄露。任何公网端口只允许 HTTPS；TLS 没配好时不要映射端口。
- **消息正文按不可信数据处理**：无论是否 TLS，别的 agent 发来的文本都不能当指令执行（见 `skills/mesh/SKILL.md` §5）。
- **管理面单独收紧**：`/console` 与 `/api/admin/*` 受 `MESH_CONSOLE_ALLOW`（默认 loopback + RFC1918）限制；公网来源默认**不在**白名单，等于管理面不出网。真要开，先收紧 + 加 TLS。
- **密钥材料**：`ca.key`、`server.key` 只留在服务端，权限 600；客户端只分发 `ca.crt`。
- **加密只保护传输**：库里仍是明文（SQLite 消息正文），磁盘与备份的权限是另一层。

---

## 2. 方案决策表

| 方案 | 适用 | 代价 | 本环境为什么选 / 不选 |
|---|---|---|---|
| **SSH 隧道**（`ssh -L`） | 临时排障、单人、目标机已有 SSH | 每个客户端都要配 SSH、断线要重连；常驻 agent 很难维护 | 不选：需要多客户端常驻 |
| **VPN**（WireGuard / Tailscale） | 多设备长期接入、希望保留内网语义 | 每台装客户端、管理密钥与路由；移动端成本更高 | 可选的备选；本环境未采用（要额外维护一套覆盖网络） |
| **边缘 TLS**（frps + nginx 终止 TLS） | 已有 frp、**不想改 hub**、能接受自签 CA 分发 | 多一跳；frps 是单点；证书要分发 | **本环境采用**：hub 保持 loopback 明文，改动只在反代与隧道 |
| **hub 原生 TLS**（`MESH_TLS_CERT` / `MESH_TLS_KEY`） | 单机直连、没有反代 | 证书要挂进容器；8790 直接对外或再套端口映射；与 frp 组合时证书要在 hub 侧维护 | 未选：hub 容器不想挂证书，且 frp 目标是本机回环 |
| **双层端口映射**（光猫 + 路由各映射一次） | 只有一层 NAT、且能改光猫 | 要动运营商设备；两层都要稳定 | 不可行：本环境是双层 NAT，且无法在光猫层加映射 |
| **frp stcp / xtcp / virtualnet** | 不想暴露公网端口、点对点访问 | 每个客户端都要装 frpc、配置更复杂 | 未选：需要单一公网入口 + 简单客户端 |
| **Cloudflare Tunnel** | 有域名、想免公网 IP | 依赖第三方；免费版带宽/延迟有限；企业策略可能禁止 | 未选：本环境没有域名规划 |

**结论**：本环境 = 「云主机 frps（公网入口）+ NAS frpc 隧道 + nginx 做 TLS 终止」，
hub 本体不动，仍然只监听本机回环。优点是改动最小、单入口可控；代价是 frps 单点与自签证书分发。

---

## 3. 本环境落地步骤

### 3.1 拓扑（双层 NAT，无 IPv6）

```
公网 → <EDGE-ROUTER>（<ISP>定制光猫/路由，<home-public-ip>）        ← NAT #1
     → Kwrt/OpenWrt（LAN <LAN-CIDR>）                          ← NAT #2
     → NAS <NAS-IP>（<NAS-OS>）：frpc → nginx(:8443, TLS 终止) → hub 127.0.0.1:8790
公网 → 云 <CLOUD-IP>:18790（frps 0.71.1）→ 上面这条隧道
```

- 路由器 `ipv6-address` / `ipv6-prefix` 为空 → **IPv6 不可用**，入口只能靠云主机。
- 隧道只映射 **8790 这一条**（经 nginx 包装成 8443），waker 的 8795 永不出网。

### 3.2 云主机 frps

`frps.toml` 关键项（token 从 vault/环境变量注入，不要写进仓库）：

```toml
bindPort = 18790
auth.method = "token"
auth.token = "<vault 注入>"

# 面板只监听本机，用 SSH 转发访问，不要对公网开放
webServer.addr = "127.0.0.1"
webServer.port = 7500
```

启动：`./frps -c frps.toml`（或等价 systemd/docker 方式）。面板：`ssh -L 7500:127.0.0.1:7500 <cloud-host>` 后本机开 `http://127.0.0.1:7500`。

### 3.3 NAS frpc

目录：`/vol4/1000/docker/dsh-mesh-frpc`。`frpc.toml`：

```toml
serverAddr = "<CLOUD-IP>"
serverPort = 18790
auth.method = "token"
auth.token = "<vault 注入>"

[[proxies]]
name = "dsh-mesh-tls"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 18790
```

### 3.4 nginx 做 TLS 终止

容器：`nginx:1.27-alpine`，名字 `dsh-mesh-tls`，`--network host`（因此能直接连 `127.0.0.1:8790`）。

```nginx
server {
  listen 8443 ssl;
  server_name _;

  ssl_certificate     /etc/nginx/tls/server.crt;
  ssl_certificate_key /etc/nginx/tls/server.key;

  location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

hub 侧保持 `MESH_HOST=127.0.0.1`（只给 nginx 用），不要直接暴露 8790。

### 3.5 证书

```bash
cd hub
node scripts/make-cert.mjs --out <cert-dir> \
  --ip <CLOUD-IP> --ip <NAS-IP> --days 3650
```

- SAN 必须包含客户端实际连接的地址（这里是 `<CLOUD-IP>`），否则校验失败；
- 本环境证书 SAN：`IP:<CLOUD-IP>`、`IP:<NAS-IP>`，**到期 2036-10-26**；
- `ca.crt` 分发给客户端，`ca.key` / `server.key` 留在服务端并 `chmod 600`；
- 检查 SAN 与有效期：

```bash
openssl x509 -in server.crt -noout -text | grep -A1 'Subject Alternative Name'
openssl x509 -in server.crt -noout -enddate
```

### 3.6 启动顺序

1. hub（`127.0.0.1:8790`，本环境 0.7.12）→ 2. `dsh-mesh-tls`（nginx 8443）→ 3. frpc → 4. 云端 frps。
每层都先按 §6 验证再进下一层。

---

## 4. 客户端接入

### 怎么把 CA 发给对端

对端只需要 **`ca.crt`**（CA 信任锚）；`ca.key` 与 `server.key` 永不外发，
`server.crt` 是叶子证书、**不能当信任锚**。

中枢侧已把 CA 挂在同一个 TLS 入口上（nginx `location = /ca.crt`，`application/x-x509-ca-cert`，
经 frp 暴露在 `https://<CLOUD-IP>:18790/ca.crt`）。对端三步：

```bash
# 1) 首次取 CA（-k 只用于这一次：此时还没有可信任的锚）
curl -k https://<CLOUD-IP>:18790/ca.crt -o ca.crt
# 2) 核对指纹（与中枢侧公布值比对，不一致就不要继续）
openssl x509 -in ca.crt -noout -fingerprint -sha256
# 3) 让 Node 信任它，再验证一次
export NODE_EXTRA_CA_CERTS=$PWD/ca.crt      # Windows: setx NODE_EXTRA_CA_CERTS ... 后重启 DSH
curl --cacert ca.crt https://<CLOUD-IP>:18790/health    # 期望 200
```

Windows 的 `curl.exe`（schannel）另需 `--ssl-no-revoke`（见下）。

- 本环境实测（2026-10-29）：`/ca.crt` 返回 200 / 1053 bytes；sha256 与中枢侧一致
  `dc0efcd20925f286d052a0edfc330ec968aba81d43cbbb9f2ae77d3a7e5e3105`；
  用取回的 CA 再请求 `/health` → 200。CA 主体 `CN=dsh-mesh local CA`，到期 **2036-10-26**。
- **常见错误**：把 `server.crt`（叶子）当信任锚 → `UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
  `SELF_SIGNED_CERT_IN_CHAIN`；用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过 → **等于关掉校验，禁止**。
- **为什么保留 CA + 叶子两段式**：轮换时只换叶子、客户端 CA 不动；
  单文件自签叶子方案每次轮换都要重新分发到每台机器。
- `/ca.crt` 是公开文件，不含私钥；`ca.key` 只留在中枢侧（本机 `.worklog/dispatch/certs/`
  与 NAS 证书目录），永不进仓库。

### Node / DSH 主机

```bash
NODE_EXTRA_CA_CERTS=<path>/ca.crt node -e "
  fetch('https://<CLOUD-IP>:18790/health').then(r => r.json()).then(console.log)"
# 期望：{ ok: true, service: 'dsh-mesh', version: '0.7.12', ... }
```

DSH 的 `mcp-mesh` 配置里把 `url` 换成 `https://<CLOUD-IP>:18790/mcp`，
并保证**启动 DSH 的进程**能拿到 `NODE_EXTRA_CA_CERTS`（Windows 下是用户/系统环境变量，不是 profile 里的字段）。

### Windows `curl.exe`

```powershell
curl.exe --cacert ca.crt --ssl-no-revoke https://<CLOUD-IP>:18790/health
```

`--ssl-no-revoke` 的原因：Windows `curl.exe` 用 schannel，自签 CA 没有 CRL/OCSP，
默认会报 `CERT_TRUST_REVOCATION_STATUS_UNKNOWN`；Node（OpenSSL）没有这个问题。

### 浏览器

自签证书会弹警告——**预期行为**。不要在未核对指纹的情况下点「继续」访问管理面；
需要的话用 `openssl x509 -fingerprint -sha256 -noout -in server.crt` 核对一次。

---

## 5. 证书轮换与到期

- 当前证书：**2036-10-26 到期**（3650 天），提前 **30 天** 提醒；
- CA 与服务器证书分开：CA 复用，轮换服务器证书**不要求**所有客户端重新信任根证书；
- 轮换步骤：
  1. `node scripts/make-cert.mjs --out <cert-dir> --ip <CLOUD-IP> --ip <NAS-IP> --days 3650 --force`
     （复用已有 `ca.crt`/`ca.key`，只重签 `server.crt`/`server.key`）；
  2. 重启 `dsh-mesh-tls` 容器加载新证书；
  3. 若 CA 未变：只更新服务端，客户端不动；若已重建 CA：重新分发 `ca.crt` 并重配 `NODE_EXTRA_CA_CERTS`；
  4. 按 §6 全量复验，确认旧证书不再可用。

一句话：**只换叶子 → 重启容器、客户端不动；换 CA → 所有客户端重新走 §4 的 `/ca.crt` 三步**
（这也是把 CA 挂在 TLS 入口上的最大价值）。

检查：

```bash
openssl x509 -in server.crt -noout -enddate
```

---

## 6. 验证清单

| 检查 | 命令要点 | 期望结果 |
|---|---|---|
| 外网 HTTPS | `curl --cacert ca.crt --ssl-no-revoke https://<CLOUD-IP>:18790/health` | 200 |
| Node 客户端 | `NODE_EXTRA_CA_CERTS=ca.crt node -e "fetch(...)"` | 200，`service=dsh-mesh version=0.7.12` |
| 明文 HTTP | `curl http://<CLOUD-IP>:18790/health` | **400**（nginx 拒绝 "plain HTTP request sent to HTTPS port"） |
| 无 token | `curl --cacert ca.crt --ssl-no-revoke https://<CLOUD-IP>:18790/api/inbox` | **401** |
| 局域网明文 | `curl http://<NAS-IP>:8790/health` | 200（内网保持原样） |

TLS 自动化检查（在 hub 目录）：

```bash
NODE_EXTRA_CA_CERTS=<path>/ca.crt \
MESH_BASE=https://<CLOUD-IP>:18790 \
MESH_ADMIN_TOKEN=<vault 注入> \
node scripts/tls-check.mjs
```

`tls-check.mjs` 覆盖 6 项：明文拒绝、TLS health、未认证 401、admin token、临时 agent token、错误 token。
本环境在原生 TLS 端口上实测 **6/6**。
注意：边缘 nginx 形态下第 1 项的「明文拒绝」会表现为 400 响应而非连接被拒，
脚本会按失败计；此时以本表前 5 行的手工结果为准。

---

## 7. 已知限制

1. **Windows `curl.exe` 的 schannel 吊销检查**：自签 CA 无 CRL/OCSP，必须 `--ssl-no-revoke`；
   Node/OpenSSL 栈不受影响。
2. **`allowed_cidrs` 对公网来客失效**：frp 是 TCP 透传，云端看到的源 IP 全是 `127.0.0.1`，
   IP 白名单在公网侧没有意义。公网侧只能靠 token + scopes；要用 IP 白名单，
   必须在云端反代注入 `X-Forwarded-For` 并设 `MESH_TRUST_PROXY=1`，且确认**只有**自己的反代能连上来。
3. **8795 永不出网**：waker 的本地会话注入端点只允许 loopback；隧道只映射 8790（经 8443 TLS），
   不要把 8795 一起暴露。
4. **无 IPv6**：上游未下发前缀，公网入口完全依赖云主机 frps。
5. **单层 frps 是单点**：带宽与可用性都由这台云主机决定，frps 挂了所有公网接入全断，目前没有冗余。
6. **自签证书的分发成本**：每个客户端都要配 `NODE_EXTRA_CA_CERTS`，浏览器会告警；
   没有 CRL/OCSP，吊销只能靠换证书 + 重新分发。
