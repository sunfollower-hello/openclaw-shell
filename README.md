# SoulBox（openclaw-shell）

装在自己电脑上的 AI 角色机器人工作室——从聊天记录蒸馏出人设卡，接到 QQ/微信，让想念的人重新开口说话。

原名 openclaw-shell：OpenClaw 图形化外壳，引导接入 QQ/微信、人设卡编辑、聊天记录蒸馏、API 中转配置。

> 状态：M5 前的基础已就绪（人设卡 + 编译器 + 蒸馏 + 通道向导 + API 配置页）

## Web 管理台（三个页面）

| Tab | 功能 |
|---|---|
| 人设卡 | 创建/编辑/校验/编译人设卡，卡库管理，**聊天测试**（人设+工具+技能+记忆+语音），**做卡向导**（简介/开场白/世界书/正则/头像），**导出 PNG/JSON、导入 PNG/JSON**（CCv2），当前生效人设指示 |
| 蒸馏 | 聊天记录数字分身工厂：上传 WeFlow JSON 或**粘贴「昵称: 内容」文本**或**直连本机 WeFlow(5031)** → 脱敏 → 四维蒸馏 → 保存/直接导出 PNG |
| 通道 | 微信扫码绑定向导（网页出二维码、轮询登录、配对授权）；QQ 官方开放平台机器人绑定向导（腾讯官方插件，网页扫码） |
| API | 模型提供商管理（baseUrl/key/模型），默认模型设置，连接测试，**MCP 服务器配置**，**数据备份**（卡片+记忆+MCP 配置一键下载） |

## 机器人能力（聊天测试内可勾选）

- **工具**（全免 API key）：写代码并运行（**沙箱内**，Node 权限模型限文件访问）、沙箱文件读写/列表/搜索、联网搜索(DuckDuckGo)、天气(wttr.in)、时间、**长期记忆**（memory_save 记住用户事实，跨会话回忆）
- **ask 审批**：危险工具（写代码/MCP）先问用户「执行/拒绝」，批准后才运行（人设卡 `tools.policy` 可强制全部审批）
- **技能**：代码专家/翻译/写作/情感陪伴（内置，可多选叠加）
- **思考深度**：关闭/自动(默认)/低/中/高/极高（对齐 rikkahub；极高→`reasoning_effort: xhigh`，中转不支持时自动降为 high）
- **语音**：浏览器读回复（TTS）+ 语音输入（Web Speech，Chrome/Edge）
- **MCP**：配置任意 MCP server（stdio），其工具并入工具循环（默认需审批）；参考 rikkahub 的 MCP 支持思路实现

## 技术栈

Node.js 24 + TypeScript + Express + zod。纯本地运行，数据不离开你的电脑。

## 快速开始

```bash
npm install

# 命令行操作卡库
npm run cli -- create --name 奶奶 --role family
npm run cli -- list
npm run cli -- validate 奶奶      # 或 npm run cli -- validate path/to/card.json

# 启动本地管理台（浏览器打开 http://127.0.0.1:17880）
npm run server
```

## 数据目录

卡片存储在 `<项目>/data/cards/<slug>/persona.json`，版本快照在 `versions/`。
可用环境变量 `OPENCLAW_SHELL_DATA` 覆盖存储位置。

## 目录结构

```
src/
├── cli.ts              # CLI 入口
├── server.ts           # 本地管理台（Express + 卡片 API）
├── core/
│   ├── schema.ts       # persona-card v1.0 格式（zod）
│   ├── validator.ts    # 结构 + 业务规则校验
│   └── cardStore.ts    # 卡库存储（文件 + 版本快照）
web/                    # 管理台前端（原生 JS）
data/cards/             # 卡库（gitignored）
```

## 路线图

- [x] M1 人设卡内核：schema + 校验器 + 卡库 + CLI + Web 编辑器
- [x] M2 编译器：persona.json → OpenClaw SOUL.md / skill / memory（CLI `compile` + 管理台"编译到 OpenClaw"按钮）
- [x] M3 蒸馏流水线骨架：WeFlow 导入 → 脱敏 → 四维蒸馏 → 组装卡（CLI `distill`，`--dry-run` 离线试跑；接真实 API 需配 `OPENCLAW_SHELL_API_BASE/KEY/MODEL`）
- [x] M4 通道接入（本机已打通）：OpenClaw 安装 + workspace 指向编译产物 + 腾讯微信官方插件（openclaw-weixin）扫码登录
- [ ] M4b QQ 通道：napcat（OneBot 11）
- [ ] M5 商业化：API 中转预填 + 计费

## 运行链路（本机）

```bash
# 1. 编译人设卡到 workspace（产物被 OpenClaw 识别为 skill）
npm run cli -- compile <slug>

# 2. 启动 OpenClaw 网关（加载 workspace 与微信插件）
openclaw gateway

# 3. 微信扫码登录（手机微信扫终端二维码）
openclaw channels login --channel openclaw-weixin

# 4. 配置模型（聊天/蒸馏都需要，任一 OpenAI 兼容 key 即可）
#    OPENAI_API_KEY=... 或你的中转 OPENAI_BASE_URL=... openclaw gateway
```

说明：
- OpenClaw 全局安装在 `%APPDATA%\npm`（已加入用户 PATH；npm 全局前缀已从 Program Files 改到用户目录，装全局包不再需要管理员权限）
- 网关配置：`gateway.mode=local`、`gateway.auth.token`、`agents.defaults.workspace` 指向 `<项目>/data/workspace`
- 微信通道是腾讯官方插件（@tencent-weixin/openclaw-weixin），当前仅支持单聊；部分账号灰度未开放 ClawBot 入口
- 模型：Agnes 中转（`models.providers.agnes`，模型 `agnes-2.0-flash`），密钥在 `~/.openclaw/openclaw.json`，不入库
- 通道：微信走腾讯官方插件 `openclaw-weixin`（单聊，部分账号灰度）；QQ 走腾讯官方插件 `@tencent-connect/openclaw-qqbot`（单聊/群聊@/频道，q.qq.com 创建机器人后网页扫码绑定）
- 已知限制：NapCat（用自己的 QQ 号当机器人）方案未就绪——官方 napcat 插件 npm 包无编译产物且源码版与新 SDK 不兼容

## 开机自启 + 桌面开关

三个组件（管理台 / OpenClaw 网关 / Cloudflare 隧道）由 `scripts/start-stack.ps1` 统一托管，PID 记录在 `data/stack-pids.json`：

- **桌面开关**：`桌面/openclaw-shell 开关.bat`（双击：在跑就停，没跑就启）
- **开机自启**：`scripts/autostart.bat` 已放入启动文件夹（登录时自动启动）
- 手动命令：
  ```powershell
  powershell -File D:\ai_workspace\openclaw-shell\scripts\start-stack.ps1
  powershell -File D:\ai_workspace\openclaw-shell\scripts\stop-stack.ps1
  ```
- 停止只回收记录在案的 PID，绝不触碰其他进程（如 fwq 隧道系统服务）

## 公网访问（Cloudflare Tunnel）

管理台经独立 Cloudflare 隧道（`openclaw`）挂在子域名：

```
https://openclaw.319274.xyz   →  http://127.0.0.1:17880
```

- 页面启用 Basic 认证：账号密码在项目根 `.env`（`OPENCLAW_SHELL_UI_USER/PASS`，已 gitignore）
- 隧道配置：`C:\Users\followsun\.cloudflared\config-openclaw.yml`（隧道 74975232...，用户账户运行，无需管理员）
- 注意：openclaw 隧道目前由 nohup 进程托管，重启电脑后需重新启动（后续可做成开机自启）
- 历史遗留：`shell.319274.xyz` 有一条指向旧隧道的 DNS 记录（访问 404，无害），可在 Cloudflare 面板顺手删除

## 许可

MIT
