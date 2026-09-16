# Linux 服务器部署手册（Ubuntu 24.04，SoulBox 分发站）

> 本文记录 2026-09-16 首次部署的完整步骤与坑位，重装/换机照抄即可。
> 服务器：103.117.138.91（4核 Xeon 8272CL / 3.8G / 系统盘 30G + 数据盘 50G / 30M / CN2）

## 0. 一次性准备（商家镜像的默认坑）

```bash
# 1) 商家镜像默认关 pubkey：开！否则只能用密码
echo "PubkeyAuthentication yes" > /etc/ssh/sshd_config.d/99-pubkey.conf
mkdir -p /root/.ssh && chmod 700 /root/.ssh
printf "%s\n" "ssh-ed25519 AAAA...你的公钥" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys && systemctl reload ssh

# 2) 数据盘（vdb 默认不挂载，必须自己挂）
mkfs.ext4 -F /dev/vdb1                                  # 首次
mkdir -p /data && mount /dev/vdb1 /data
echo "UUID=<blkid 里的 UUID> /data ext4 defaults 0 2" >> /etc/fstab

# 3) swap（2G，兜并发生成的内存峰值）
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab

# 4) 防火墙
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

## 1. 运行环境

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs   # Node 24
npm install -g openclaw@2026.6.34 --allow-scripts=openclaw,@google/genai,protobufjs,tree-sitter-bash
npm install -g @tencent-connect/openclaw-qqbot openclaw-weixin \
  --allow-scripts=openclaw,@google/genai,koffi,tree-sitter-bash,protobufjs
# npm 11 默认拦安装脚本，必须带 --allow-scripts，否则原生模块（tree-sitter/koffi）不编译
```

## 2. 代码与构建

```bash
# 从开发机推（排除 node_modules/data/dist）：
#   tar --exclude=node_modules --exclude=data --exclude=dist -czf /tmp/ocs.tar.gz openclaw-shell
#   scp /tmp/ocs.tar.gz sb:/tmp/ && ssh sb "tar -xzf /tmp/ocs.tar.gz -C /data"
cd /data/openclaw-shell && npm install --no-audit --no-fund && npm run build
printf "OPENCLAW_SHELL_UI_USER=soulbox\nOPENCLAW_SHELL_UI_PASS=<强密码>\n" > .env && chmod 600 .env
```

## 3. OpenClaw 家目录（必须是软链到数据盘）

```bash
mkdir -p /data/openclaw
# ⚠️ 坑：openclaw 首次运行会自建 ~/.openclaw 真目录，直接 ln -s 会把链接塞进它里面 → 网关报 "Missing config"
# 正确顺序：先建好 /data/openclaw，再把 /root/.openclaw 整个替换成软链
rm -rf /root/.openclaw && ln -s /data/openclaw /root/.openclaw
cat > /data/openclaw/openclaw.json << 'EOF'
{
  "gateway": { "mode": "local", "auth": { "token": "<随机32位>" } },
  "agents": { "defaults": { "workspace": "/data/openclaw-shell/data/workspace" } }
}
EOF
```

## 4. systemd 三件套（+ Caddy）

`/etc/systemd/system/openclaw-shell.service`：

```ini
[Unit]
Description=OpenClaw Shell web console (SoulBox)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/data/openclaw-shell
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
Environment=HOST=127.0.0.1
Environment=PORT=17880
Environment=OPENCLAW_SHELL_DATA=/data/openclaw-shell/data
ExecStart=/usr/bin/node /data/openclaw-shell/dist/server.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

`openclaw-gateway.service`：`ExecStart=/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs gateway`（`Environment=HOME=/root`，否则找不到 ~/.openclaw）

`openclaw-tts.service`：`ExecStart=/usr/bin/node /data/openclaw-shell/dist/tts-server.js`

```bash
systemctl daemon-reload && systemctl enable --now openclaw-shell openclaw-gateway openclaw-tts
```

## 5. 公网入口（Caddy + Let's Encrypt）

```bash
apt-get install -y caddy
# /etc/caddy/Caddyfile：soulbox.319274.xyz { reverse_proxy 127.0.0.1:17880; 静态长缓存; 安全头 } + :80 IP 直连兜底（明文，建议上线后删）
systemctl restart caddy
```

**DNS 必须**：`soulbox.319274.xyz A 103.117.138.91`，**灰云（不代理）**——套了 CF 橙云 ACME 拿不到证书。
（原家里隧道映射已从 `~/.cloudflared/config-openclaw.yml` 摘除，家里隧道只剩 `openclaw.319274.xyz`。）

## 5.5 身份与登录（分发形态）

两条身份路线，互不干扰：

| 身份 | 怎么进 | 数据范围 |
|---|---|---|
| **分发用户** | 什么都不用做——首次打开自动生成 32 位设备 ID（localStorage + cookie） | 只有自己的 `data/users/<id>/` |
| **管理员** | `https://<域名>/#/login` 输账号密码（也可用 Basic 凭据调 API/CLI） | 全局 `data/`，能看到所有用户数据 |

- 登录成功下发 `oc_admin` cookie（HMAC 签名、HttpOnly、HTTPS 下 Secure，30 天），**改密码即全体失效**
- 免认证清单：外壳静态文件（`/`、`/index.html`、`/app.js`、`/style.css`、`/assets/*`）+ `/api/admin/*`——新用户必须能打开页面才会生成设备 ID
- 抽屉底部有「管理登录 / 退出管理」入口
- 管理员账号（`soulbox`）与密码存在服务器 `/data/openclaw-shell/.env`

安全加固已做：`ssh` 密码登录已关（只认密钥，`sshd -T` 可验）、IP:80 只跳转到域名（不再明文代理应用）。

## 6. 端口与安全口径

| 端口 | 服务 | 暴露 |
|---|---|---|
| 22 | SSH | 公网（**仅密钥**，密码登录已关闭） |
| 80/443 | Caddy | 公网（443 反代 17880；80 只做跳转） |
| 17880 | 管理台 | **仅 127.0.0.1** |
| 18789 | OpenClaw 网关 | **仅 127.0.0.1** |
| 17900 | TTS 售卖服务 | 0.0.0.0 监听但被 ufw 拦（要用再单独放行） |

## 7. 验证清单

```bash
systemctl is-active openclaw-shell openclaw-gateway openclaw-tts caddy   # 全 active
ss -lntp | grep -E "17880|18789|17900|:443"
curl -s -u soulbox:<密码> -o /dev/null -w "%{http_code}\n" http://127.0.0.1:17880/api/health   # 200
curl -s -H "X-Device-Id: <32位hex>" -o /dev/null -w "%{http_code}\n" http://127.0.0.1:17880/api/cards  # 200（设备身份）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:17880/api/cards                     # 401（无凭据）
openclaw doctor    # Errors: 0
```

## 8. 更新代码

```bash
# 开发机改完 → 重新打包推送 → 服务器
cd /data/openclaw-shell && npm run build && systemctl restart openclaw-shell
# 只改前端（web/）不用重启；改 src/ 必须 build + restart
```
