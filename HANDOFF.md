# openclaw-shell 项目交接文档（HANDOFF）

> 更新：2026-08-21 · 目的：让接手 AI 读取本文后能快速上手、持续开发
> 配套文档：`D:\ai_workspace\未来规划书.md`（未来规划）、项目内 `DESIGN.md`（设计稿）、`README.md`（使用说明）

---

## 0. 一句话定位

**装在自己电脑上的 AI 角色机器人工作室**：从聊天记录蒸馏出人设 → 做成标准角色卡（CCv2 PNG/JSON）→ 配模型 → 接 QQ/微信 → 网页全流程操作。商业模式 = 开源引流 + 自建 API 中转赚钱（**Agnes 只是测试上游，生产中转未建**）。

## 1. 快速上手（接手后第一件事）

```bash
cd /d/ai_workspace/openclaw-shell
npm run build            # 编译 dist/（改了 src 后必做）
npx tsc --noEmit         # 类型检查
powershell -ExecutionPolicy Bypass -File scripts/start-stack.ps1
# 浏览器开 http://127.0.0.1:17880（登录凭据见项目 .env，当前：跟在太阳后面 / 13233334@@Qq）
# 桌面也有开关：桌面/openclaw-shell 开关.bat（在跑就停，没跑就启）
```

启动的三件套由 `scripts/start-stack.ps1` 统一管理：**管理台(17880) + OpenClaw 网关(18789) + Cloudflare 隧道**。日志在 `data/*.log`。

## 2. 技术栈与环境

- Node 24 + TypeScript + Express + zod；前端为原生 JS 抽屉路由 SPA（无框架、无构建步骤）
- **OpenClaw 2026.6.34**：npm 全局装在 `%APPDATA%\npm\node_modules\openclaw`（入口 `openclaw.mjs`），本机用户 PATH 已含 `%APPDATA%\npm`
- npm 全局前缀已从 Program Files 改到用户目录（免管理员）；装大包用 npmmirror：`npm_config_registry=https://registry.npmmirror.com npm install ...`
- 依赖：express、zod、@modelcontextprotocol/sdk（dev: typescript、tsx、@types/*）
- Windows 环境（Git Bash 终端）；PowerShell 5.1 有坑（见 §8）

## 3. 文件结构（改哪里找哪里）

```
openclaw-shell/
├── src/
│   ├── cli.ts            # CLI：create/list/view/validate/compile/distill
│   ├── server.ts         # Express 后端：全部 /api/*（卡片/蒸馏/通道/API/聊天/工具/表情/生图/MCP/备份）
│   ├── core/
│   │   ├── schema.ts     # persona-card v1 schema（zod）：身份/声音/人格/记忆/知识/变体/工具/表情/CCv2 段
│   │   ├── validator.ts  # 校验（蒸馏卡必须脱敏、语录 PII 抽查等）
│   │   ├── cardStore.ts  # 卡库（data/cards/<slug>/persona.json）+ dataDir() 数据根
│   │   ├── compiler.ts   # persona.json → OpenClaw workspace（SOUL.md + skills/personas/<slug>/ 含世界书/开场白/工具）
│   │   ├── cardConvert.ts# persona ↔ CCv2 双向转换（扩展数据存 extensions.openclaw_shell）
│   │   ├── png.ts        # PNG 读写（tEXt "chara" 块存 base64 JSON，CCv2 标准）
│   │   ├── chatPrompt.ts # 人设卡 → 聊天 system prompt
│   │   ├── skills.ts     # 内置技能库（代码专家/翻译/写作/陪伴）
│   │   ├── modelConfig.ts# 读改写 ~/.openclaw/openclaw.json 的 models.providers + 默认模型
│   │   ├── imageConfig.ts# data/imageConfig.json 生图配置（NovelAI/OpenAI/本地占位）
│   │   └── openclawCli.ts# openclaw CLI 封装（扫码登录进程管理/状态/端口检测）
│   ├── distiller/        # 蒸馏：parser(WeFlow/纯文本) / redact(PII) / extract(四维LLM) / pipeline
│   └── tools/
│       ├── registry.ts   # 工具注册表：code_exec(沙箱) / sandbox_list|read|write|grep / web_search / weather / datetime / memory_save / image_gen
│       └── mcp.ts        # MCP 客户端（@modelcontextprotocol/sdk，stdio）
├── web/                  # 前端 v2：抽屉导航 + hash 路由（home/cards/distill/channels/api/capabilities/data/settings）
│   ├── index.html        # 骨架（顶栏/抽屉/视图容器）
│   ├── app.js            # 全部前端逻辑（路由 render/init、聊天、做卡、表情、生图、通道扫码…）
│   └── style.css         # 样式（用户已美化，改动前先读）
├── scripts/              # start-stack.ps1 / stop-stack.ps1 / toggle-stack.bat / autostart.bat
├── data/                 # 运行数据（gitignored）：cards/ memory/ sandbox/ emojis/ images/ workspace/ mcp.json imageConfig.json samples/
├── DESIGN.md / README.md / package.json / tsconfig.json / .env(gitignored 登录凭据)
```

## 4. 已实现功能全景

| 面 | 功能 |
|---|---|
| 人设卡 | 建/编/校验/编译、聊天测试（人设+工具+技能+记忆+语音+思考深度）、做卡向导（简介/开场白/世界书/正则/头像）、导出 PNG/JSON、导入 PNG/JSON（CCv2）、生效人设指示、**表情包（每卡≤120，带解释，AI 用 [表情:名字] 标记）** |
| 蒸馏 | WeFlow JSON 上传 / 粘贴「昵称: 内容」文本 / 直连本机 WeFlow(5031) → PII 脱敏 → 四维蒸馏（互动/人格/记忆，证据分级）→ 保存或直接导出 PNG |
| 通道 | 微信官方插件扫码绑定（单聊，ClawBot 灰度）、QQ 官方开放平台扫码绑定（q.qq.com 机器人，单聊/群@/频道）、配对授权 |
| API | 模型提供商配置+测试、默认模型、**生图配置（NovelAI/OpenAI 兼容/本地占位）**、MCP 服务器、数据备份 |
| 聊天能力 | 工具：沙箱写代码+文件（危险先问后做审批）/搜索/天气/时间/记忆/生图；技能库；思考深度 关闭/自动/低/中/高/极高（对齐 rikkahub，极高=xhigh 不支持自动降级）；语音 TTS/STT；普通聊天/工作模式分离 |
| 基建 | 开机自启 + 桌面开关、Cloudflare 独立隧道公网、Basic 认证、数据全本地 |

## 5. 服务与依赖（关键路径/配置）

- **OpenClaw 配置** `~/.openclaw/openclaw.json`：`gateway.mode=local` + `gateway.auth.token`；`agents.defaults.workspace = D:\ai_workspace\openclaw-shell\data\workspace`；`models.providers.agnes`（测试上游：`https://apihub.agnes-ai.cn/v1`，模型 ID **必须写 `agnes-2.0-flash`**，写 2.0Flash 会 503）
- **插件**（~/.openclaw/npm/projects/）：`openclaw-weixin` v2.4.6（腾讯官方微信）、`openclaw-qqbot` v2.0.1（腾讯官方 QQ）
- **Cloudflare**：
  - 新隧道 `openclaw`（ID 74975232-d922-4337-9644-76fac4d04c26），配置 `C:\Users\followsun\.cloudflared\config-openclaw.yml`，用户账户运行（由 start-stack 托管）→ 子域名 `openclaw.319274.xyz` → 17880
  - 旧隧道 `fwq`（ID abbf0656-...）是系统服务（SYSTEM 身份，配置在 systemprofile 目录），**别动**，服务它自己的 8080
  - 死记录：`shell.319274.xyz` 指向旧隧道（404，无害，可在面板删）
- **数据根** `data/`：cards、memory（`<slug>.mem`）、sandbox（每人设卡一个沙箱目录）、emojis、images、workspace（编译产物）
- 登录凭据：项目 `.env`（gitignored）——⚠️ 若仓库转 public 必须改

## 6. GitHub 状态

- 仓库：`git@github.com:sunfollower-hello/openclaw-shell.git`（**private**，main 分支）
- 推送：SSH（HTTPS 被墙；git 已全局改写 https→SSH，写 https URL 也走 SSH）；提交身份 sunfollower-hello
- 变更流程：`git add -A && git -c user.name="sunfollower-hello" -c user.email="sunfollower-hello@users.noreply.github.com" commit -m "..." && git push`
- LICENSE 缺失（README 写 MIT）——开源前补

## 7. 未来展望（详见 D:\ai_workspace\未来规划书.md）

- **等条件**：QQ/微信绑定验证（等用户扫码，验收清单已在规划书）、M5 中转商业化（等中转站，用 one-api/new-api）、App 更新推送机制（参考 rikkahub 的 GitHub Releases 方案）
- **功能增强**：MetaPact 多模态能力包（vision/hearing/voice skills）、cc-connect 自己的号渠道（封号风险待拍板）、本地生图（ComfyUI/Forge 分析已写）、GPT-SoVITS 声音克隆、OpenClaw 端工具/表情/生图接入（让 QQ/微信里的机器人也用上，目前只在网页聊天测试生效）、记忆增强、群运营、MCP 真实联调、心跳主动消息、模型能力路由、README 宣传
- **打包分发**：Windows 便携版/安装包（内嵌 Node+OpenClaw+首次引导）优先；与 M5 中转配套

## 8. 踩坑记录（接手必读，避免重复踩）

1. **PowerShell 5.1 `ConvertFrom-Json` 数组 bug**：`@(ConvertFrom-Json)[0].prop` 会返回整个集合 → start-stack 的存活检测用**端口/进程探测**（Test-Port / Get-CimInstance），不用 JSON
2. **`$args` 是 PowerShell 保留变量**，不能当函数参数名（会报 Null）
3. **脚本编码**：.ps1/.bat 内容必须**纯 ASCII**（中文系统按 GBK 读 UTF-8 会乱码/引号错乱）；文件名可中文
4. **中文用户名/内容**：Git Bash 里 curl 传中文会 GBK 乱码 → 用 `node -e` + `Buffer.from(...).toString('base64')` 测 UTF-8
5. **杀后台任务**：`TaskStop`/杀 npm 外层不杀 node 子进程 → 端口残留 EADDRINUSE → `netstat -ano | grep :PORT` 找 PID `taskkill //PID x //F`
6. **openclaw config set 不支持数组/嵌套 models**（"custom model providers must declare models"）→ 用 node 直接改 `~/.openclaw/openclaw.json`
7. **网关启动慢**（MCP SDK 加载）→ 重启后等 ~15s 再测；start-stack 输出会被管道缓冲，直接看端口/curl 确认
8. **Agnes 拒绝 `reasoning_effort: xhigh`**（400）→ server 已做自动降级 high；Agnes 模型 ID 是 `agnes-2.0-flash`
9. **NovelAI 直连当前网络可能被墙**（fetch 网络错误，非代码问题）
10. **NapCat 插件不可用**：npm 包无编译产物、源码版与 2026.6 SDK 不兼容 → QQ 走官方开放平台插件，别回头搞 NapCat
11. 微信扫码登录必须在**跑 gateway 的同一台机器**上；微信 ClawBot 入口是灰度，账号没有就扫不了

## 9. 参考内容索引

- **rikkahub**（github.com/rikkahub/rikkahub）：思考档位对齐（OFF/AUTO/LOW/MEDIUM/HIGH/XHIGH → effort 字符串）、APK 更新机制（GitHub Releases 当更新源，免服务器）
- **MetaPact**（github.com/Lovappen/MetaPact）：AI 伴侣 Agent Pack，OpenClaw 可装；借鉴其多模态 skills（vision/hearing/voice/selfie）、HEARTBEAT 主动消息、agent/*.md 人设文件结构、cc-connect 多渠道（自己的号，有风险）——只借鉴功能不照抄
- **RP-Hub**（D:\rphub修改实验\最新版rp\RP-Hub-1.7.1）：NovelAI 生图参考（模型 nai-diffusion-4-5-full、sampler k_dpmpp_2m_sde、steps/scale/负面词）、本地 Forge 生图适配器（fwq.319274.xyz/v1）、读卡做卡流程（CCv2）
- **SillyTavern CCv2**：角色卡标准（PNG tEXt "chara" 块 base64 JSON；data.character_book 世界书、extensions.regex_scripts 正则、first_mes 开场白）
- **WeFlow**（hicccc77/WeFlow）：微信聊天记录导出；本机 HTTP API `127.0.0.1:5031`（/api/v1/messages?access_token=&talker=；talkers 列表接口未确认）
- **OpenClaw 官方**：docs.openclaw.ai（微信插件 openclaw-weixin、QQ 插件 openclaw-qqbot、channels login/pairing）

## 10. 接手后建议的第一步

1. 读本文 + 规划书 → 跑 `npm run build && start-stack.ps1` 确认服务活着
2. 若要推进功能：优先「OpenClaw 端工具/表情/生图接入」（把网页聊天测试的能力接到 QQ/微信通道，商业价值最高）或「绑定验证」（等用户扫码，验收清单在规划书）
3. 任何改动前先读 `web/app.js`（用户重写过，勿覆盖）与 `server.ts` 相关段
