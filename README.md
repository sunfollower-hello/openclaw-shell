# openclaw-shell 🦞

OpenClaw 图形化外壳：引导接入 QQ/微信、人设卡编辑、聊天记录蒸馏。

> 状态：M1 基础构建中（人设卡内核 + 本地管理台）

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
