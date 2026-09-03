# openclaw-shell 本地独立部署方案书（给新电脑 / 新 AI 用）

> 目标：**在不迁移任何账号、不依赖任何服务器/Cloudflare 的前提下**，从 GitHub 拉取本仓库代码，在一台干净的 Windows 电脑上完整构建并本地运行，之后可直接修改代码继续开发。
> 本文件是"交接给另一台电脑的 AI"的完整指令：照着做即可，遇到下面没覆盖的问题，按"常见坑"排查。

---

## 0. 结论先说

**本地部署完全自包含，不需要 Cloudflare、不需要任何云服务。** 仓库里已有全部源码（后端 + 前端 + 自研生图插件）；本地运行只依赖三样公开可装的东西：Node.js、npm 全局的 OpenClaw CLI、腾讯官方渠道插件（npm 公开包）。代码里没有硬编码本机路径（唯一历史硬编码已改为自动探测），克隆到任意目录都能跑。

唯一需要"账号"的地方：**QQ/微信机器人扫码绑定**（在网页界面完成，一次性配置，与这台电脑的 GitHub 账号无关）。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 | 开发机即生产机 |
| Git | 任意版本 | 拉取仓库 |
| Node.js | **20+（开发用 24）** | 打开 CMD 用 `node -v` 验证 |
| PowerShell | 系统自带 5.1 即可 | 启动脚本兼容 5.1 |
| 网络 | 能访问 GitHub / npm | 国内可配 npm 镜像（见下） |

## 2. 最快路径（推荐）：一键安装脚本

克隆仓库后，在项目根目录打开 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-new-machine.ps1
```

脚本自动完成：环境检查 → `npm install` → `npm run build` → 全局安装 OpenClaw CLI（2026.6.34）→ 安装腾讯 QQ/微信官方插件 → `--link` 安装仓库自带的生图插件 → 提示 `.env` 可选（纯本地无需登录，见 §9）→ 输出剩余手工步骤。

国内网络自动使用 npmmirror 镜像。脚本全程纯 ASCII 输出。

## 3. 手动路径（分步，便于理解每一步）

如果不用脚本（或脚本某步失败），按下面手动执行：

```bash
# ① 克隆
git clone git@github.com:sunfollower-hello/openclaw-shell.git
cd openclaw-shell

# ② 项目依赖 + 编译
npm install --registry=https://registry.npmmirror.com
npm run build          # 产出 dist/（server.js / tts-server.js）

# ③ OpenClaw CLI（全局）
npm install -g openclaw@2026.6.34 --registry=https://registry.npmmirror.com
# 验证：openclaw -V  应输出 2026.6.34

# ④ 腾讯官方渠道插件（npm 公开包）
openclaw plugins install npm:@tencent-connect/openclaw-qqbot --force
openclaw plugins install npm:@tencent-weixin/openclaw-weixin --force

# ⑤ 生图插件（仓库自带源码，--link 本地挂载）
cd plugins/openclaw-shell-imagegen && npm install --registry=https://registry.npmmirror.com && npm run build
cd ../..
openclaw plugins install --link %CD%\plugins\openclaw-shell-imagegen
```

## 4. 关键配置（OpenClaw 配置文件）

配置文件位置：`%USERPROFILE%\.openclaw\openclaw.json`。**首次运行前手动创建**（或先跑 `openclaw setup` 引导）：

```json
{
  "gateway": { "mode": "local", "auth": { "token": "<任意随机串，如 openssl rand -hex 16>" } },
  "agents": {
    "defaults": {
      "workspace": "<项目绝对路径>\\data\\workspace",
      "model": { "primary": "<提供商名>/<模型ID>" }
    }
  },
  "models": {
    "providers": {
      "<提供商名>": {
        "baseUrl": "https://<OpenAI兼容服务>/v1",
        "api": "openai-completions",
        "apiKey": "<API KEY>",
        "models": [{ "id": "<模型ID>", "name": "<模型ID>" }]
      }
    }
  },
  "plugins": {
    "entries": {
      "openclaw-weixin": { "enabled": true },
      "openclaw-qqbot": { "enabled": true },
      "openclaw-shell-imagegen": { "enabled": true }
    }
  }
}
```

要点：
- **模型 API Key 是隐私数据，不在仓库**——向使用方索要任意 OpenAI 兼容服务的 key 填入，或在启动后网页「API 与模型」页配置（网页配置会写回这个文件）。
- `agents.defaults.workspace` 必须指向项目内 `data/workspace`（克隆路径变了要同步改）。

## 5. 启动与验证

```powershell
# 一键启动（网页 17880 + 网关 18789 + TTS 17900；Cloudflare 隧道自动跳过）
powershell -ExecutionPolicy Bypass -File scripts\start-stack.ps1
```

| 项 | 地址 | 验证 |
|---|---|---|
| 管理台（网页） | http://127.0.0.1:17880（局域网 http://<内网IP>:17880） | 浏览器直接打开即可（本地默认免登录；建了 .env 则需账号密码） |
| OpenClaw 网关 | 127.0.0.1:18789 | `openclaw health` 或看 `data\gateway.log` |
| TTS 服务 | 127.0.0.1:17900 | `curl http://127.0.0.1:17900/health` |

停止：`powershell -ExecutionPolicy Bypass -File scripts\stop-stack.ps1`。

日常使用顺序：**先起网关再起网页**（start-stack 已按此设计；若先开了网页会提示网关未连接，重启脚本即可）。

> **局域网模式（本仓库默认）**：`start-stack.ps1` 会把网页绑定 `0.0.0.0`，同网络机器用
> `http://<本机内网IP>:17880` 访问（脚本末尾自动打印内网 IP，如 `http://192.168.1.61:17880`）。
> 首次需**以管理员身份**运行一次 `scripts\add-firewall-rule.bat` 放行 17880 入站，否则局域网浏览器连不上
> （本机 127.0.0.1 不受影响）。管理台默认**免登录**；若日后想加登录，建 `.env` 并填
> `OPENCLAW_SHELL_UI_USER/PASS` 即可（见 §9）。

## 6. 首次使用流程（网页内完成，无需改代码）

1. 打开管理台 → 「API 与模型」页 → 添加提供商并设为默认（或直接改 openclaw.json）
2. 「人设卡库」→ 做卡 / 导入 CCv2 卡
3. 点开卡 → 右上角「⚙ 高级配置」→ 机器人接入 → 创建机器人 → 扫码绑定 QQ/微信（**唯一需要账号的步骤**，每张卡一个独立机器人，凭证存本机，之后换卡可复用免扫码）
4. 网关重启后生效（start-stack 重跑一次即可）

## 7. 日常开发工作流（改代码）

```bash
npx tsc --noEmit        # 类型检查（改 src/ 后必做）
npm run build           # 编译到 dist/（网页后端跑的是 dist/server.js）
# 重启生效：
powershell -ExecutionPolicy Bypass -File scripts\start-stack.ps1   # 已在跑则先 stop-stack 再 start
```

- 前端是纯静态文件（`web/` 下原生 JS），改完浏览器刷新即可（注意缓存，`index.html` 里 `app.js?v=N` 版本号要递增）
- 改了 `src/` 必须 build + 重启后端
- 改了 OpenClaw 侧配置（openclaw.json / 插件）必须重启网关
- 提交规范：`git add -A && git commit -m "说明" && git push`（SSH；首次需配 GitHub SSH key）

## 8. 常见坑（务必先看）

1. **PowerShell 5.1 中文乱码**：所有 `.ps1` 必须纯 ASCII（仓库已遵守），命令行里避免中文输出
2. **端口残留**：杀进程后端口仍被占 → `netstat -ano | findstr :17880` 找 PID → `taskkill /PID <PID> /F`
3. **OpenClaw CLI 慢**：`plugins list` / `agents list` 等命令冷启动要 5-15 秒，网页某些页面首次加载会有"加载中"，属正常
4. **插件改了不生效**：装/卸/改插件必须重启网关（start-stack 重跑）
5. **模型 ID 写错**：如上游是 Agnes 类服务，模型 ID 必须与上游一致（如 `agnes-2.0-flash`），写错会报 "No available channel" / 503
6. **Cloudflare 隧道**：默认自动跳过（找不到 cloudflared 或 config 文件时）。本地使用不需要它；要公网访问再按 `scripts\start-stack.ps1` 注释配置
7. **SAPI 中文乱码**：TTS 本地兜底用 SAPI，脚本已处理 BOM；Edge 在线合成在国内网络可能 403，属网络问题
8. **装大 npm 包慢/失败**：用 `--registry=https://registry.npmmirror.com`

## 9. 数据全本地（安全提示）

- 项目数据（卡库/记忆/机器人实例/生图配置）在项目的 `data/` 目录，已 gitignore，不会上传
- 账号凭证（QQ AppID/密钥、微信 token）在本机 `%USERPROFILE%\.openclaw\`，不入仓库
- 管理台默认**无需登录**（认证只有当 `.env` 设置了用户/密码才启用）。纯本地直接访问即可；**若配置公网隧道，必须先建带强密码的 `.env`**（参考 `scripts/setup-new-machine.ps1` 末尾说明）

---

*本文件随仓库维护；与 `HANDOFF.md`（内部开发交接）、`未来规划书.md` 配套。*