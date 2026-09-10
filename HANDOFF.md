# openclaw-shell 项目交接文档（HANDOFF）

> 更新：2026-09-04（**合入异地备份版**：预设 v3 / 表情分组 / 开场白 / AI 主动消息 / 跨端会话镜像 / 记忆整卡通用化，详见 git 提交 a5907e1 + 库内 REPLICATE.md）
> 配套文档：`D:\ai_workspace\未来规划书.md`（未来规划）、项目内 `DESIGN.md`（设计稿）、`README.md`（使用说明）、`REPLICATE.md`（异地复刻/本次大改说明）、`docs/tts-guide.md`（TTS 专项完整指引）

---

## 0. 一句话定位

**装在自己电脑上的 AI 角色机器人工作室**：从聊天记录蒸馏出人设 → 做成标准角色卡（CCv2 PNG/JSON）→ 配模型 → 接 QQ/微信 → 网页全流程操作。商业模式 = 开源引流 + 自建 API 中转赚钱（**Agnes 只是测试上游，生产中转未建**）。

## 1. 快速上手（接手后第一件事）

```bash
cd /d/ai_workspace/openclaw-shell
npm run build            # 编译 dist/（改了 src 后必做）
npx tsc --noEmit         # 类型检查
powershell -ExecutionPolicy Bypass -File scripts/start-stack.ps1
# 浏览器开 http://127.0.0.1:17880（登录凭据见项目 .env，当前：跟在太阳后面 / 112233123）
# 桌面也有开关：桌面/openclaw-shell 开关.bat（在跑就停，没跑就启）
```

启动的四件套由 `scripts/start-stack.ps1` 统一管理：**管理台(17880，127.0.0.1) + OpenClaw 网关(18789) + TTS 售卖服务(17900) + Cloudflare 隧道（可选，自动探测 cloudflared）**。日志在 `data/*.log`。

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
│   │   ├── schema.ts     # persona-card v1 schema（zod）：身份/声音/人格/记忆/知识/变体/工具/表情/CCv2 段 + presets(tier/style)/emojiGroups/life/abilities
│   │   ├── presets.ts    # 角色扮演预设 v3：档位(不破甲/破甲最高)×风格(纯对话/重描写)+全局输出护栏+示例对话跟随风格（data/presets.json，缺则自动重建内置）
│   │   ├── sanitize.ts   # 出站文本清理：stripCoT 剥离纯文本思维链前缀（「分析：」「思路：」等，不误伤角色动作描写）
│   │   ├── greetedStore.ts# 开场白状态 data/memory/<slug>.greeted.json（按 userKey 原子领取，避免重复开场）
│   │   ├── conversationStore.ts # 统一会话日志 data/conversations/<slug>.jsonl（网页+通道互传）
│   │   ├── sessionMirror.ts # 通道会话观察器：读 OpenClaw sessions jsonl 增量同步到网页（游标防重）
│   │   ├── lifeScheduler.ts # AI 主动发消息调度 data/life/<slug>.json（间隔/静默时段/时间情绪/防骚扰）
│   │   ├── emojiStore.ts # 共享表情库 v3：分组体系（data/emojis/_shared + library.json + groups.json），卡片多选分组，旧按卡表情自动迁移
│   │   ├── validator.ts  # 校验（蒸馏卡必须脱敏、语录 PII 抽查等）
│   │   ├── cardStore.ts  # 卡库（data/cards/<slug>/persona.json）+ dataDir() 数据根
│   │   ├── compiler.ts   # persona.json → OpenClaw workspace（SOUL.md + skills/personas/<slug>/ 含世界书/开场白/工具）
│   │   ├── cardConvert.ts# persona ↔ CCv2 双向转换（扩展数据存 extensions.openclaw_shell）
│   │   ├── png.ts        # PNG 读写（tEXt "chara" 块存 base64 JSON，CCv2 标准）
│   │   ├── chatPrompt.ts # 人设卡 → 聊天 system prompt
│   │   ├── skills.ts     # 内置技能库（代码专家/翻译/写作/陪伴）
│   │   ├── modelConfig.ts# 读改写 ~/.openclaw/openclaw.json 的 models.providers + 默认模型
│   │   ├── botStore.ts    # 多机器人实例表 data/bots.json：卡×渠道账号×agent；上限 QQ 5 个/微信 1 个/每卡 1 个；每 agent 独立 workspace=data/agent-workspaces/<slug>/
│   │   ├── pluginMarket.ts# 插件商店：目录 data/plugin-market/catalog.json（精选/用户分享/付费，feeRate 默认 0.2）+ sales.jsonl 购买记账 + uploads/ 上传 zip 管理
│   │   ├── imageConfig.ts# data/imageConfig.json 生图配置（NovelAI/OpenAI 兼容，画师串列表+当前生效）
│   │   ├── imageGen.ts   # 生图核心：NovelAI/OpenAI 统一生成（三档比例方 1024/竖 832x1216/横 1216x832（NAI 标准普通档），画师串拼接，网页工具与 OpenClaw 插件共用）
│   │   ├── ttsConfig.ts  # data/ttsConfig.json 语音合成：多上游聚合（kind: openai/minimax/volc，前端添加向导录入，默认不预置）+ 本地兜底（Edge 在线/SAPI 离线）
│   │   ├── ttsUsage.ts   # TTS 用量记账（data/tts-usage.jsonl 追加 + 汇总统计）
│   │   └── openclawCli.ts# openclaw CLI 封装（扫码登录进程管理——支持 --account 按账号多机器人登录/状态/端口检测）
│   ├── tts-server.ts     # 独立 TTS 售卖服务：POST /v1/audio/speech（OpenAI 兼容、Bearer key、17900、可单独部署到服务器赚差价）
│   ├── distiller/        # 蒸馏：parser(WeFlow/纯文本) / redact(PII) / extract(四维LLM) / pipeline
│   └── tools/
│       ├── registry.ts   # 工具注册表：code_exec(沙箱) / sandbox_list|read|write|grep / web_search / weather / datetime / memory_save / image_gen
│       └── mcp.ts        # MCP 客户端（@modelcontextprotocol/sdk，stdio）
├── web/                  # 前端 v2：抽屉导航 + hash 路由（home/cards/distill/channels/api/capabilities/data/settings）
│   ├── index.html        # 骨架（顶栏/抽屉/视图容器）
│   ├── app.js            # 全部前端逻辑（路由 render/init、聊天、做卡、表情、生图、通道扫码、卡片🤖机器人弹窗…）
│   └── style.css         # 样式（用户已美化，改动前先读）
├── scripts/              # start-stack.ps1 / stop-stack.ps1 / toggle-stack.bat / autostart.bat / test-bots.mjs（多机器人 API 回归测试）
├── data/                 # 运行数据（gitignored）：cards/ memory/ sandbox/ emojis/ images/ workspace/ mcp.json imageConfig.json samples/ bots.json（机器人实例表） agent-workspaces/（每 agent 独立编译产物）
├── DESIGN.md / README.md / package.json / tsconfig.json / .env(gitignored 登录凭据)
```

## 4. 已实现功能全景

| 面 | 功能 |
|---|---|
| 人设卡 | 建/编/校验/编译、聊天测试（人设+工具+技能+记忆+语音+思考深度）、做卡向导（简介/开场白/世界书/正则/头像）、导出 PNG/JSON、导入 PNG/JSON（CCv2）、生效人设指示、**表情包（共享库分组体系 v3：全局 300 个上限、分组 CRUD、卡片高级配置多选分组 emojiGroups、聊天 [表情:名字] 渲染为图片）**、**高级配置（编辑卡右上角 ⚙：每卡模型下拉 + 能力开关[联网搜索/生图/写代码/记忆/天气/时间/技能库/TTS 自动朗读] + 机器人接入 + 预设档位/风格 + 主动发消息）**、**开场白自动发送（greetedStore 按用户原子领取，本地首次显示、通道 SKILL.md 规则防重复）** |
| 预设 | **预设系统 v3（2026-08-30 异地开发，09-04 合入）**：档位（不破甲 / 破甲最高）× 风格（纯对话 / 重描写）+ 全局输出护栏（禁思维链泄漏/末句无句号）+ 示例对话跟随风格注入（few-shot 锚定）+ 网页试聊与 OpenClaw 编译共用同一套解析（compiler 编译 SKILL.md 时同步注入） |
| 蒸馏 | WeFlow JSON 上传 / 粘贴「昵称: 内容」文本 / 直连本机 WeFlow(5031)，可单独选模型商/模型（09-06）→ PII 脱敏 → 四维蒸馏（互动/人格/记忆，证据分级）→ 保存或直接导出 PNG |
| 通道 | 微信官方插件扫码绑定（单聊，ClawBot 灰度）、QQ 官方开放平台扫码绑定（q.qq.com 机器人，单聊/群@/频道）、配对授权；**多机器人（2026-08-24）：卡库每卡右上角 🤖 → 建独立 bot（OpenClaw agents 多 agent + 渠道账号路由），上限 QQ 5 个/微信 1 个/每卡 1 个（2026-08-26 起放开 2 实例限制），每 agent 独立 workspace/模型/会话；创建=编译卡→agents add→扫码绑定该账号，卡片更新可一键重编译，入口保留旧通道页**；**快速接卡（2026-08-24）：通道页下方「🤖 机器人连接」区——已认证账号仓库（扫描 openclaw.json `channels.qqbot.accounts`+默认账号+微信 accounts.json）+ 可复用账号免扫码绑定（凭证落盘）+ 一键转移（账号被占用从旧卡顶到新卡，`POST /api/bots/transfer`）+ 创建冲突返 409 conflict+占用者，卡上弹窗引导转移** |
| API | 模型提供商配置+测试、默认模型、**生图配置（NovelAI/OpenAI 兼容；三档比例方 1024x1024/竖 832x1216/横 1216x832（NAI 标准普通档）+ **auto 自动档**（按提示词画面内容推断：人物竖构图→竖图、风景横场景→横图、其余→方图）；画师串可增删改/设当前；参数固定默认不开放；试生一张；图片库与清理入口不在前端展示，后端保留自动清理 retentionDays 默认 30）**、MCP 服务器、数据备份；**TTS 语音合成为独立页 #/tts（上游聚合 OpenAI 兼容/MiniMax/火山豆包，添加向导+自动拉取模型；用量记账；对外售卖接口）** |
| 聊天能力 | 工具：沙箱写代码+文件（危险先问后做审批）/搜索/天气/时间/记忆/生图；**聊天气泡内直接渲染生成的图片（点击放大）**；技能库；思考深度 关闭/自动/低/中/高/极高（对齐 rikkahub，极高=xhigh 不支持自动降级）；**TTS 朗读（bot 气泡 hover 出 🔊，点击合成播放，走默认通道）**；普通聊天/工作模式分离 |
| 记忆 | 每卡独立长期记忆（JSONL 结构化，**整卡通用：网页/QQ/微信共用同一份记忆，ns 恒为 shared，2026-09-04 起不再按用户隔离**）；**相关召回注入**（关键词+新鲜度+关键词命中强相关+关键记忆 important 恒置顶）、memory_save 工具（去重+关键词+关键标记）、**自动总结（N 轮一批，2026-09-06 改）**（每攒够 N 轮总结一批、最新轮也总结、默认 N=5；最近 20 轮原文始终由历史窗口完整注入不被记忆替代；**记忆巡回**：总结失败段落标记回 chatlog（r=1）下次自动搭车补记；对话日志统一 `data/memory/<slug>.chatlog.jsonl`，每段只总结一次）、**前端单条管理**（编辑/删除/搜索/关键记忆红色分区+switch 开关+触发词/相对时间；已去掉手动添加，记忆由自动总结与 memory_save 产生）、旧纯文本自动迁移、**无条数上限（2026-09-06 移除 300 条淘汰）**、备份兼容；**OpenClaw 端已打通（2026-09-07 升级）**：① 记忆变更自动导出 `data/memory-export/<slug>.md` → `agents.defaults.memorySearch.extraPaths` 索引 → QQ/微信可搜到；② **免向量直读：`syncAgentUserMemory` 把「记忆摘要全文 + 本地网页聊天近 3 轮」写进 agent 工作区 USER.md（OpenClaw 每轮必注入的用户档案，已实测）→ QQ/微信每次对话自动带上记忆与近期聊天，不依赖模型调工具**；③ **本地聊天原文可检索：`src/core/historyExport.ts` 把网页聊天（surface=web）最近 100 轮导出 `data/history-export/<slug>.md`，extraPaths 已含此目录（builtin FTS 关键词索引，改后跑 `openclaw memory index --force` 重建）**；网页聊天落盘后 `scheduleChannelMemoryRefresh` 防抖 6s 刷 md+USER.md；编译 SKILL.md 也注入「共同记忆与近期聊天」段（近 3 轮+记忆全文，编译快照）；**跨端会话（2026-09-01）**：绑定卡片后网页与 QQ/微信互传同一份记录（conversationStore + sessionMirror 观察器每 5 秒同步），未绑定各自独立；一键重置清空记忆+对话+开场状态；私密性：网页聊天永不推送通道（只进本地 conversations/history-export/USER.md） |
| 插件商店 | **侧边栏「🧩 插件商店」（2026-08-24）**：ClawHub 官方市场实时搜索（跟着上游更新）+ 精选区（5 个中文简介内置精选）+ 用户免费分享（填 ClawHub 包名或上传 zip）+ 付费区（用户上传自研 zip 自主定价，feeRate 20% 手续费，购买记账 sales.jsonl，当前记账模式支付通道待开通）+ 已装管理（卸载/启停/更新，装完提示重启网关生效）；安装 zip 包校验 manifest（configSchema 必填）→ 解压到项目 plugins/<id>/ → `plugins install --link`；卸载自动清理目录+openclaw.json 条目；安装失败自动回滚 |
| 基建 | 开机自启 + 桌面开关、Cloudflare 独立隧道公网、Basic 认证、数据全本地 |；**手机端/触屏适配（2026-09-06 三批）**：@media(hover:none) 悬停按钮常显（卡库操作/机器人/朗读）、toast z-index 300 压过弹窗、补 wb-modal 弹窗样式、世界书/正则摘要行窄屏换行、mem-row/mem-edit/preset-item-head 窄屏换行、输入控件 16px 防 iOS 缩放、全面屏 safe-area（lc-dock/create-actions/drawer-foot）、弹窗窄屏顶部对齐防软键盘顶飞、二维码自适应、聊天顶栏窄屏换行、灯箱改 data-lb 事件委托（弃内联 onclick 拼 URL）、机器人区块双容器 id 分离（bot-dialog-body/adv-bot-body）；**UI 减负专项（2026-09-06 二轮）**：蒸馏/做卡默认直填默认模型商+首模型（去「跟随默认」占位）、本地聊天下双方头像（卡面中心圆裁，dataURL 转 Blob URL 会话级复用防内存膨胀）、高级配置记忆改滑杆 0-20（0=关闭，滑杆同时控制 memory_save 工具开关）、主动发消息滑杆跟随标签、各页过度提示全删、首页公告隐藏、表情库紧凑格子+点击放大详情+编辑弹窗（名称+适用场合同窗改）、预设破甲默认装给所有卡（presets.ts 两处 fallback break）；**本地聊天专项（2026-09-06 三轮）**：镜像重复导入修复（会话消息 id 去重 srcId+游标重置不再重灌）、重进恢复完整历史（网页消息回填 wbChatHistory）、顶栏 RP-Hub 式接管（隐藏 SoulBox 顶栏/卡头像+名字当页头/联通状态圆点绿红白/头像点击直达卡片配置/删快速切卡与模型选择——固定用卡片模型）、输入岛单行（搜索+思考深度+输入+发送）、清空/重置合并为一键删除（聊天+记忆）、长按消息多选删除（触屏 500ms/桌面右键，后端 /conversation/delete 联动：日志同内容轮次移除+删超 N/2 解散最新记忆）、自动朗读移除（只留喇叭手动）、输出铁律并入破甲组当第 5 条内置条目（break-guard，随破甲档位注入恒生效，可在预设页破甲组内编辑；曾短暂做过的独立 guard 区已按用户要求撤掉）、首页速览横排紧凑卡、公告修正（首页显示，设置入口隐藏）；**表情库回归修复（2026-09-06）**：重构时误删 addEmojiToLib 导致表情页整体空白（initEmojis 首行 ReferenceError 静默中断加载），已补回并实测 4 个表情+点击放大详情正常；教训：大段替换函数块后必须核对段内所有函数仍在；**本地聊天/表情四修（2026-09-06 四轮）**：①本地聊天页头加回三条横线菜单键（上轮隐藏 topbar 把用户困死，教训：接管整页必须保留全局导航入口）②顶栏/输入岛手机单行不换行（删 flex-wrap 规则，名字中段省略 middleEllipsis）③模型选择回归：单下拉列出全部启用模型、默认选中卡片配置的模型（lcModelOverride 读 #lc-model-sel）④表情「从其他分组导入」：/api/emojis/import 路径复用（新条目指向原文件不复制图片，重名自动加序号，removeEmoji 有同文件引用时不删文件）；**输入岛 RP-Hub 化五轮（2026-09-06）**：按键排（模型商/模型/思考深度弹层）移到输入框上方、联网搜索开关删除（能力跟随卡配置）、模型按键只写「模型」点开可见、思考深度竖排弹层、表情笑脸按钮（插入 [表情:名]，用卡配置分组）、输入框/发送键缩小约 1/3；**大教训**：wbChatOpts 块替换时连带吞掉 wbInputEnter/wbAutoGrow/lcEnterPending（initWorkbench 静默崩溃、全部按键失灵），用临时 unhandledrejection→document.title 钩子定位后从 git HEAD 恢复——大段替换必须 git diff 核对

## 5. 服务与依赖（关键路径/配置）

- **OpenClaw 配置** `~/.openclaw/openclaw.json`：`gateway.mode=local` + `gateway.auth.token`；`agents.defaults.workspace = D:\ai_workspace\openclaw-shell\data\workspace`；`models.providers.agnes`（测试上游：`https://apihub.agnes-ai.cn/v1`，模型 ID **必须写 `agnes-2.0-flash`**，写 2.0Flash 会 503）；`agents.defaults.memorySearch` = `{ extraPaths: [], provider: "none", store: { fts: { tokenizer: "trigram" }, vector: { enabled: false } }, query: { hybrid: { vectorWeight: 0, textWeight: 1 } } }` + **每个绑定卡的 agent 级 `memorySearch.extraPaths` 只指向本卡两个 md**（`data/memory-export/<slug>.md`、`data/history-export/<slug>.md`；**2026-09-08 检索隔离**：defaults.extraPaths 必须保持空数组，因为 OpenClaw 的 agent 级与 defaults 级是合并关系，不清空就会跨卡互搜；维护走 `applyAgentMemoryScope`/`applyAllAgentMemoryScopes`（botStore），启动时 ensureMemorySearchExtraPaths 自动跑）；**消息分段（2026-09-07 v7 定稿，详见 §24）**：`agents.defaults.blockStreamingDefault="on"` + `blockStreamingChunk{minChars:1,maxChars:500,breakPreference:"newline"}` + `blockStreamingCoalesce{minChars:1,maxChars:500,idleMs:250}` + `channels.qqbot.deliverDebounce.enabled=false`；**真正的语义拆条（换行必分/句号切分/100字兜底）在 QQ/微信插件补丁里做**（OpenClaw 原生 chunker 的 sentence 断点是 ASCII 正则、中文不识别，配置只负责不硬切），风格按 agentId 查侧车表 `~/.openclaw/split-styles.json`（项目保存卡时维护，插件补丁 `scripts/patch-channels.mjs` 升级后可重打）
- **插件**（~/.openclaw/npm/projects/）：`openclaw-weixin` v2.4.6（腾讯官方微信）、`openclaw-qqbot` v2.0.1（腾讯官方 QQ）；**自研插件 `openclaw-shell-imagegen`**（源码在项目 `plugins/openclaw-shell-imagegen/`，`openclaw plugins install --link` 已装，gateway 启动时自动加载）→ 给 OpenClaw agent（QQ/微信）注册 `image_gen` 生图工具，复用项目 `dist/core/imageGen.js`（同一份 data/imageConfig.json），图片存 `~/.openclaw/media`（QQ 插件白名单目录），返回文本带 `MEDIA:<路径>` 行 + 结构化 attachments（双保险投递）
- **Cloudflare**：
  - 新隧道 `openclaw`（ID 74975232-d922-4337-9644-76fac4d04c26），配置 `C:\Users\followsun\.cloudflared\config-openclaw.yml`，用户账户运行（由 start-stack 托管）→ 子域名 `openclaw.319274.xyz` → 17880
  - 旧隧道 `fwq`（ID abbf0656-...）是系统服务（SYSTEM 身份，配置在 systemprofile 目录），**别动**，服务它自己的 8080
  - 死记录：`shell.319274.xyz` 指向旧隧道（404，无害，可在面板删）
- **数据根** `data/`：cards、memory（`<slug>.mem` 为 **JSONL 结构化记忆**：每行 `{id,fact,cat,ts,src}`，含分类[信息/偏好/关系/事件/待定]、时间戳、来源[手动/自动/工具/旧数据]；旧纯文本格式首次读取自动迁移）、**memory-export/（记忆导出的 md，供 OpenClaw memorySearch 索引）**、sandbox（每人设卡一个沙箱目录）、emojis、images、tts（朗读音频产物）、ttsConfig.json（TTS 配置）、tts-usage.jsonl（TTS 用量）、workspace（编译产物）
- **TTS 售卖服务**（独立进程，按需启动）：`npm run tts-server`（或 build 后 `node dist/tts-server.js`）→ 0.0.0.0:17900，`POST /v1/audio/speech` 完全 OpenAI 兼容（客户用 OpenAI SDK 改 baseUrl 即可）；本机 127.0.0.1 免 key 自测，外部必须 Bearer key（`data/ttsKeys.json` 数组 `[{"key":"...","name":"客户A"}]` 或环境变量 `TTS_API_KEYS="k1,k2"`）；按 model 名路由上游（不填走默认上游）；每次调用记入 tts-usage.jsonl。部署到服务器时带 dist + data/ttsConfig.json + ttsKeys.json 即可
- 登录凭据：项目 `.env`（gitignored）——⚠️ 若仓库转 public 必须改

## 6. GitHub 状态

- 仓库：`git@github.com:sunfollower-hello/openclaw-shell.git`（**private**，main 分支）
- 推送：SSH（HTTPS 被墙；git 已全局改写 https→SSH，写 https URL 也走 SSH）；提交身份 sunfollower-hello
- 变更流程：`git add -A && git -c user.name="sunfollower-hello" -c user.email="sunfollower-hello@users.noreply.github.com" commit -m "..." && git push`
- LICENSE 缺失（README 写 MIT）——开源前补

## 7. 未来展望（详见 D:\ai_workspace\未来规划书.md）

- **等条件**：QQ/微信绑定验证（等用户扫码，验收清单已在规划书）、M5 中转商业化（等中转站，用 one-api/new-api）、**TTS 开卖（等用户注册任一上游拿 key 填入 API 页并启用；售卖接口/记账/多协议适配器已就绪）**、App 更新推送机制（参考 rikkahub 的 GitHub Releases 方案）
- **功能增强**：MetaPact 多模态能力包（vision/hearing/voice skills）、cc-connect 自己的号渠道（封号风险待拍板）、本地生图（ComfyUI/Forge 分析已写）、GPT-SoVITS 声音克隆（付费增值：TTS 已留 provider 结构，加 kind 即可扩）、语音 STT 输入、OpenClaw 端工具策略接入（**生图 ✅ 已接入**：openclaw-shell-imagegen 插件，QQ/微信机器人已可调用 image_gen 发图；沙箱/记忆/技能/表情/审批 待接入，目前只在网页聊天测试生效）、群运营、MCP 真实联调、模型能力路由、README 宣传（**主动消息 ✅ 2026-09-01 已实现：lifeScheduler；跨端会话 ✅ 已实现：sessionMirror**）
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
12. **edge-tts（Edge 在线免费语音）WS 合成握手 403**：语音列表 HTTP 200（网络通），但 WebSocket 合成被拒（token/风控），本网络环境不可用 → 本地兜底用 **Windows SAPI**（离线必可用，音质一般）；edge 选项保留在前端，换网络环境可能恢复
13. **edge-tts npm 包 main 指向 index.ts**：必须 `import ... from "edge-tts/out/index.js"`（编译产物），否则 dist 下 node 跑不起来
14. **`tools.allow` 是白名单不是"额外放行"**：在 openclaw.json 加 `tools.allow: ["image_gen"]` 会把其他 73 个工具（含 exec/edit/qq_*）全部移除。自研插件注册**非 optional 工具默认就对 agent 可见**（`defineToolPlugin`/`registerTool` 不传 optional 即可），不要加 allow。删掉 tools 段即恢复默认全集
15. **CLI `openclaw agent` 走 gateway 会因 scope 配对失败而自动降级 embedded**（"scope upgrade pending approval"）——embedded 回退同样加载插件与 tools 配置，但工具集可能不含部分 runtime 工具，且不影响 QQ/微信通道（通道消息走 gateway 内部）
16. **openclaw CLI 并发跑会互相拖慢**：`agents add` 刚结束立刻 `agents list` 可能超时/输出不全 → GET /api/bots 的 agentExists 检测在 CLI 失败时返回 null（前端显示"状态未知"），别断言"缺失"；runOpenclaw 超时给足 60s
17. **前端慢接口别挡主渲染**：/api/bots 内部要 spawn openclaw CLI（5-15s），卡片网格先渲染、机器人角标异步补——任何页面把慢接口和首屏绑 Promise.all 都会让页面"空白"被当成 bug
18. **多机器人实测事实（2026-08-24）**：`agents add <slug> --workspace <dir> --model <p/m> --bind qqbot:<acc> --non-interactive --json` 全参数可用；`agents delete --force` 会把 workspace 目录移入回收站（重建时 compileCard 自动重生成，无碍）；qqbot 扫码输出含终端二维码 + `https://q.qq.com/qqbot/openclaw/connect.html?task_id=...` 链接，一次扫码只绑一个机器人；QQ 个体开发者一号最多 5 个机器人
19. **插件商店踩坑（2026-08-24）**：① ClawHub 部分社区插件有包装问题（如 png-to-pdf 缺编译产物：`package install requires compiled runtime output`）——是上游问题不是我们 bug，安装失败提示即可；② `openclaw plugins uninstall` 不认 `--link` 本地装的插件（registry 无条目）也不删目录——卸载端点按 manifest id 扫描项目 plugins/ 目录删 + 清 openclaw.json 的 plugins.load.paths/entries；③ --link 安装 bundle 的目录名是 shareId（sp_xxx）不是插件 id，清理必须读 manifest 匹配；④ 本地插件包必须有 package.json 的 `openclaw.extensions` + manifest 的 `configSchema`（缺失报错 `plugin manifest requires configSchema`），上传校验已内置这两条；⑤ plugins list/agents list 都慢（5-15s），market/bots 端点都要缓存+并发合并，前端给"加载中"提示；⑥ 安装失败自动回滚（删目录+清 config）

20. **通道绑定联通踩坑（2026-08-26，三个真 bug）**：① `channels status --probe --json` 的 `channelAccounts[channel][]` 账号字段是 **`accountId` 不是 `id`**（读错会得到 `[object Object]`）；且**通道级 `connected` 对微信恒为 false**（无长连接），必须看账号级 connected/running/configured——这是"微信明明绑好了却显示未连接"的原因；② **bots.json 有实例 ≠ OpenClaw 有路由绑定**：绑定可能因 agents add 时 bind 失败/被 agents delete 顺带清掉而丢失，此时消息落到默认 agent，表现为"连上了但回的是别的卡（共享 workspace 最后编译的那张）"——已加 `repairBotBindings()` 在进连接页时查 `agents bindings` 缺就补（幂等）；③ 微信真实 accountId 由服务器下发（`xxxx-im-bot`），创建 bot 时只能填占位名 `wx-main`，原来只在前端轮询到"登录成功那一刻"才校正，**关弹窗/刷新页面就永久错位** → 改为进连接页时对账不上就自动 `reconcileBotAccount`。经验：这类"配置在两处（我们的 bots.json + OpenClaw 的 bindings）"的设计必须有自愈对账，不能只在事件那一刻同步

21. **回复拆条改造（2026-09-07，参照 OpenOS 逆向结论落地；⚠️ 口径已被 §23 v7 更新）**：新增 `src/core/splitter.ts`（四级拆条：空行分段 → 句号断句 → 逗号超2再断 → 条数/字数收敛），本地聊天 `/api/chat` 返回 `parts[]` 前端逐条渲染（`addBotReplyHumanLike(rawText, serverParts)`）；QQ 通道靠 `applyAgentBlockStreaming()` 写 openclaw.json 的 `channels.<ch>.accounts.<id>.streaming.preview.chunk`（源码 `resolveChannelDraftStreamingChunking` 读这里，account 级优先）+ prompt 约定，条数上限是软约束。**关键口径**：轻对话目标 24 字/硬切 30 字（bubbleMax/hardCap 分离，26-30 的完整句子不切词）；重描写 70/88；总字数 = max条数×15（轻）/×50（重）。卡片高级配置弹窗新增"回复条数区间"（1-7，存 `chat.split`），预设里用 `{split_min}/{split_max}` 模板变量（`resolveCardPresetBlocks` 替换）。**踩坑**：① 总字数收敛不能靠"合并相邻对"（合并不减字数），必须截尾；② 省略号"……"要连续吞并否则拆出孤立"…"条；③ 逗号>2 的句子必须每攒 2 个逗号就断，否则 4 逗号句整句保留；④ hardCap 分离是防"好吃"被切"好"+"吃。"的关键

25. **网页卡顿专项（2026-09-08，实测定位 + 四层优化）**：用户反馈「点卡库每次重新生成一遍、偶发 fail to…、进高级配置/本地聊天卡顿一下、高级配置的模型/预设经常加载不出来（关掉重开才行）、预设页有时只剩两个按钮、API/记忆/生图每次进都全量重载、刷新偶尔只剩 SoulBox 顶栏+黄底」。**实测数据定位（关键）**：本机直连 API 全部个位数毫秒（/api/cards 9ms、presets 7ms），但**走 Cloudflare 隧道每个请求 500-1700ms**（app.js 266KB 首次 1305-2073ms，cf-cache-status=BYPASS）→ 服务端无性能问题，根因是**前端每切一次页面就重新请求全部数据**，公网延迟被逐次放大。四层修复：**①接口缓存层**（app.js 顶部 apiCache + cachedGet/cachePeek/cacheInvalidate/apiGetRetry）：新鲜期（CACHE_TTL 60s）内直接用缓存、连后台请求都不发；过期才 stale-while-revalidate（先用旧数据渲染 + 后台刷新 + 数据真变了才重绘，避免闪动）；卡片/预设/提供商的写操作后 cacheInvalidate 保证不看旧数据。**实测：连续 6 次切页从「每次都请求」降到只有首访 2 个请求，之后 0 请求**。②**修静默失败**（用户说的「加载不出来」是真 bug 不是网络偶发）：openAdvConfig 原来四个请求各自 .catch() 成空数组 → 弹窗照画但下拉框全空；改为 fetchAdvData() 失败即抛 + apiGetRetry 自动重试一次 + showAdvError() 弹明确错误与重试按钮；有缓存时**先秒开弹窗**再后台校验（实测打开 20-165ms）；loadPresetStore 同理不再 catch 成空（那是预设页只剩「新增档位/恢复内置」的原因），initPresets 失败显示错误+重试。③**静态资源与首屏**：web 静态资源带 ?v= 的 js/css 改 "public, max-age=31536000, immutable"（其余仍 no-cache），**实测 Cloudflare 从 BYPASS 变 HIT：2073ms → 267-332ms**，浏览器条件请求 304 不再传 266KB；**index.html 的 ?v= 号改为按 app.js/style.css 的 mtime+size 自动生成**（serveIndexHtml，GET / 与 /index.html 动态重写）——不加这个，immutable 会让改完前端看不到新代码（本次实测踩到：页面一直跑 v18 旧逻辑）；启动流程从 "loadProfile().finally(() => router())" 改为**先 router() 再后台 loadProfile/loadEmojiLib**（原来必须等 /api/profile 回来才画第一屏，公网 1-2s 白屏 = 用户看到的「只有 SoulBox 加黄页」）。④**交互调整（用户点名）**：机器人区删掉「重新应用（卡更新后）」与「删除机器人」两按钮（前者与保存配置重复——卡片 PUT 时 syncCardToChannel 已自动重编译+同步模型；后者换卡用「换绑账号」即可；后端 /recompile 与 DELETE 端点保留供排障），本地聊天「退出」改为回到**刚才聊的那张卡的编辑页**（pendingOpenCardSlug + initCards 消费，不再甩回首页）。**注意**：Cloudflare 那 ~300-500ms 基础往返无法消除（隧道绕行的物理延迟），做完后绝大多数点击不再触发网络请求所以体感接近本机；**踩坑**：内嵌凭据 URL（user:pass@host）下浏览器直接拒绝 fetch（报 "Failed to execute fetch … URL that includes credentials"），验证要用干净 URL，这也是用户偶见 fail to… 的一个来源。

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

22. **通道分段改造（2026-09-07，深度踩坑；⚠️ 最终口径见 §23 v7）**：① **qqbot 插件 v2.0.1/2.0.3 无纯文本自动分段**——`capabilities.blockStreaming:false` + dispatch 把 `kind='block'` 文本块丢弃给编辑式流式（QQ stream API 编辑同一条），必须改插件 dist：block 文本块直接 `deliverReply` 逐条发送 + **分支末尾加 return**（否则落到默认路径每块发两次=重复！16api/8block 就是这 bug）；② **微信插件硬编码 `disableBlockStreaming:true`**（dist/src/messaging/process-message.ts），必须改 false 才走 block 管线，且微信账号 `streaming.mode` 也要 off（partial 激活编辑式流式合并）；③ **block 配置真路径是 `agents.defaults.blockStreamingChunk`**（不是 channels.*.streaming.preview.chunk，那是 telegram/draft 专用，微信无 draft 消费方=死配置，已清）；④ coalesce 必须调小（微信自带 200/3000 默认会合并小段）；⑤ 插件补丁在**升级/重装会丢**，重打用 `scripts/patch-channels.mjs`；⑥ AI 会自作主张调 message 工具发多条→prompt 已加【重要】规则禁止（调工具反而重复）；⑦ presets.json 是运行时快照，改内置预设要同步它（或删掉重建），编译用 `npm run cli -- compile <slug> --workspace data/agent-workspaces/<slug>`（CLI 默认写 data/workspace 是错的）
23. **切分规则定稿 v7（2026-09-07 三轮，替代二轮口径，本地引擎/通道插件/prompt 三处同一套）**：① **公共规则**：换行必分（任何单个 `\n` 即分段，AI 写的一行 = 一条消息）；绝不在逗号/分号/顿号处切；无合法切分点的超长行整条保留（宁长不切）；切分点句号删除、紧跟在句号后的 ！？… 并入本条（「真好。！」→「真好！」）、!?… 自身不触发切分；**总字数限制全部取消**（prompt 的 ×15/×50 与运行时都不再限制）。② **轻对话 chat**：行内按句号（。．.）必切，一条消息最多一个完整句子；问号/叹号/省略号不切（「在吗？」整条保留），靠 AI 语义分段；无运行时字数兜底（无句号长行整条保留）。③ **重描写 rich**：行内不按句号切（一条可有多个句子多个句号），主要靠 AI 换行分段；运行时兜底：单行 >100 字时从行首找下一个**括号外**（（）和 {} 深度 0）的句号切，切点句号删除，剩余部分重复直到 ≤100 或无括号外句号。④ **通道侧**：OpenClaw 原生 chunker 的 sentence 断点是 ASCII 正则（`.!?`+空白），**中文 。！？ 不识别**，配置层面任何 breakPreference 都救不了中文，只能把网关参数调成安全值（minChars:1 / maxChars:500 / breakPreference:"newline" / coalesce 1/500/250）防原生硬切词，**真正的拆条在插件补丁**（QQ dist `kind==="block"` 分支、微信 process-message.js `deliver`），每条之间 250-750ms 随机停顿（活人感）；风格按 agentId 查侧车表 `~/.openclaw/split-styles.json`（每卡独立，QQ `deliverCtx.agentId` / 微信 `route.agentId` 已核证可取）；`scripts/patch-channels.mjs` 可重放补丁（插件升级会丢）。⑤ prompt 软约束：chat 每条 ≤24 字、rich 每条 ≤80 字（运行时 100 兜底），都不再写总字数。⑥ **条数收敛（本地）**：片段数超卡配置 max（1-7）时合并最短相邻对，但**合并连接不用换行**（换行=分段是硬规则，气泡内绝不出现 \n）：前段以句末标点/语气词结尾直接拼接，否则补一个空格；通道侧条数不强制收敛（靠 prompt 软约束，插件只按换行/句号拆）。⑦ 插件与引擎一致性用 `node scripts/patch-channels.mjs --selftest` 验证（从 QQ dist 提取补丁函数与 dist/core/splitter.js 对拍）；`scripts/apply-split-config.mjs` 可一次性按现有 bots 重建侧车表与 openclaw.json 安全值（新增 bot 后想立刻生效可用，正常保存卡流程也会自动做）。
24. **表情包通道侧根因（2026-09-07）**：`plugins/openclaw-shell-imagegen/openclaw.plugin.json` 的 `contracts.tools` 是**注册期硬性白名单**（OpenClaw 源码 registry 校验，未声明的工具直接丢弃不注册），只写了 `["image_gen"]` 导致 `emoji_send` 从未注册成功 → 模型在 SKILL.md 里看到「调 emoji_send」但工具不存在，只能嘴上说「表情包发过去啦」不发图（gateway.log 无任何工具调用为证）。已加 `"emoji_send"` 并重建插件 dist（8/26 旧 dist 与 9/4 源码脱节，模糊匹配修复一直没编进去，`npm run plugin:build` 的 build 步骤 tsc 即可，openclaw CLI 的 plugins build 因 Node 版本门（要求 ≥24.15）跑不了，本机 24.13.1——插件加载本身不需要 bundle）；表情图片投递前统一复制到 `~/.openclaw/media/emojis/`（与 image_gen 同目录策略，虽然实测 QQ resolveMediaPath 无白名单目录校验，本地路径直接解析，但统一目录更稳）。插件为 live link（openclaw.json `plugins.load.paths` 指向项目目录），改完 manifest/dist 重启网关即生效。**v8 拦截（同日晚）**：工具已能调用、文件已复制，但**发不出来**——实测根因：OpenClaw block 管线 `extractMediaDirectives:false` 不解析 MEDIA: 指令行，工具结果的结构化 attachments 也不自动投递（只记录进会话 jsonl 的 toolResult.details，不转媒体 payload），模型把工具返回的 `MEDIA:路径` 复读进回复当纯文本发（QQ 日志 `kind=block len=57 media=false` 为证）。修复：插件补丁 v8 在 QQ/微信出口拦截 `MEDIA:` 指令行转媒体投递（QQ `forwardMediaUrls`，微信 `sendWeixinMediaFile`），剩余文本照常拆条（`node scripts/patch-channels.mjs` 会把 v7 自动升级 v8；`--selftest` 对拍含 MEDIA 提取用例）。**v8.1（同日深夜）**：① 模型复读 MEDIA 行时常在同一行后粘文字（`MEDIA:...大笑.gif发了个"大笑"` 整行被当路径 → 文件找不到）→ MEDIA 提取改为**按扩展名截断**（支持反引号包裹含空格路径 + 裸路径），剩余文字保留发送；② 媒体发送加 20s 超时保护（QQ forwardMediaUrls / 微信 sendWeixinMediaFile 挂起不阻塞文本，防"正在输入中"卡死）；③ 工具执行（emoji_send 拷贝/建目录）加 15s 超时。**模型差异教训（关键）**：jiyuan 的 `deepseek-v4-flash`（基础版）会调 emoji_send 但**从不复读 MEDIA 行**（微信两次实测，会话 jsonl 可见 toolResult 成功但最终回复无 MEDIA）；`deepseek-v4-flash-0731` 会复读（QQ 实测成功）→ 2026-09-07 已把三张卡模型统一为 `jiyuan/deepseek-v4-flash-0731`。QQ 侧 IMAGE_EXTS 含 .gif、本地路径无白名单限制；微信按 MIME 路由 image/* 上传，gif 支持待真机确认（不行则需转静态图）。**v9（09-08，爱语式指令模式，表情只调一次聊天模型）**：工具模式（回合1调工具 + 回合2复读MEDIA收尾）每次发表情=两次聊天模型调用。参照爱语（无 function calling，模型一次输出内写 `[表情名]`/`<generate_image:描述>`，App 端正则解析执行后收尾）改为指令模式：模型一次生成内直接输出 `[表情:名字]` → 插件补丁 v9 出口解析标签，查 `~/.openclaw/media/emojis/<名>.<ext>`（emoji_send 落盘目录）→ 直接发图，命中才剔标签（未命中保留原文不吞字）；compiler 的 SKILL.md 表情段从 tool 模式改回 inline 模式（教模型写 `[表情:名]`，与网页端同文案，「会被渲染成图片」在通道侧现在是真的）；MEDIA 保险丝（v8/v8.1）保留给生图工具模式。升级方式：`node scripts/patch-channels.mjs` 对已打 v8/v8.1 的 dist **增量插入**（保留线上增强，不整段覆盖）：helper 段尾插表情函数块 + 拆条锚点行替换；全新安装打完整增强基线。生图（image_gen）暂未指令化（用户另行考虑）。**v10（09-08，彻底移除表情工具）**：AI 已无法再调用 emoji_send——插件 `src/index.ts` 删掉 emoji_send 注册块 + `openclaw.plugin.json` contracts 只留 `["image_gen"]`（registry 白名单机制：未声明即不注册），重建 dist 后生效；表情库 CRUD（addEmoji/updateEmoji 改名/moveEmojiToGroup copy/importEmojisToGroup）后自动 `syncEmojisToChannelMedia()` 把表情同步到 `~/.openclaw/media/emojis/<安全名>.<ext>`（补丁 v9 发图的查图目录，以前靠工具执行拷贝，现由库管理兜底；server 启动也全量同步一次，缺什么拷什么不删孤儿）。表情发送只剩一条路：模型输出 `[表情:名字]` → 补丁出口解析发图（一次模型调用）。**v10.1-v10.3（09-08，三次排障）**：① **QQ 全挂根因（v10.1）**：v9.1 补丁写 `text = __ocsStripMediaWarnings(text)` 对 **const text 赋值 → 每次投递 TypeError**（QQ 的 text 是 const，微信是 let 所以幸免），QQ 所有回复发不出；改新变量 `ocsT` 修复。② **微信表情失败根因（v10.2）**：模型没走 `[表情:名]` 而是输出**远程 tenor.com GIF 链接**（`media.tenor.com` 被墙 ConnectTimeout）→ 微信下载远程媒体失败；补丁 MEDIA 提取只收本地路径（远程行剔除）+ SKILL 新增「禁止输出任何图片网址/![]() 语法」。③ **模型持续编造「开心.gif」根因（v10.3，历史污染）**：MEDIA 行已渗入 conversations/chatlog/OpenClaw 会话历史（`MEDIA:C:...emojis开心.gif`、`MEDIA:null`），模型每轮看到坏样例就模仿——`scripts/clean-media-lines.mjs` 全量清洗（161+21 行，递归处理嵌套 message.content，扩展名截断+无扩展名整行剔除）；`historyExport.cleanMediaLines` 在 USER.md/history-export/SKILL 注入前永久过滤（`[表情:名]` 是好样例保留）；SKILL 表情段强化语义对应（「发个开心的表情」→ 从清单选语义最近如 大笑，清单外名字（如「开心」）绝不编造）。trajectory.jsonl 残留 MEDIA 不影响（模型不读调试轨迹）。**v12（09-08，生图指令化，发图只调一次聊天模型）**：触发格式 `<生图:描述>`（尖括号+中文前缀，兼容全角＜＞；爱语同源但自定格式，与 RP-Hub 的 `image###`、表情 `[表情:名]` 均不同）；通道补丁出口解析（__ocsExtractGenerateImage 半角/全角/多指令/未命中容错，一次回复最多 1 张）→ __ocsGenerateImage 动态 import dist/core/imageGen.js（__ocsShellRoot 探测：env OPENCLAW_SHELL_ROOT → ~/ai_workspace/openclaw-shell → D:/ai_workspace/openclaw-shell）调 generateImage（独立生图接口，不是聊天模型）→ 成功发图（QQ forwardMediaUrls / 微信 sendWeixinMediaFile）、失败只发「生图失败」短文本（指令从正文剔除，不丢提示词——用户明确不要 RP-Hub 式把提示词留在气泡里）；发送顺序：文本先发（拆条）→ 表情图 → 生图异步出图；ABILITY_IMAGE_RULE_CHANNEL（presets.ts 新增常量）教模型输出指令且「不要调用任何工具」，compiler 编译 SKILL.md/AGENTS.md 时把生图规则替换为通道版 + 「可用工具」列表过滤 image_gen（防双路径）；网页侧生图保持工具模式（runToolLoop 不受影响）。**v13（09-08，插件空壳化）**：与表情 v10 同逻辑，彻底移除通道侧 image_gen 工具——插件 src/index.ts 重写为空壳（register 无工具），openclaw.plugin.json contracts.tools 清空（registry 白名单机制：未声明即不注册），重建 dist 生效（插件本体保留，openclaw.json 引用不失效）。至此通道侧生图/表情均只剩一条路：模型一次生成输出指令标签 → 补丁出口解析执行（各一次聊天模型调用），工具面全清。node scripts/patch-channels.mjs 自检覆盖生图指令提取（半角/全角/多指令/未命中保留原文）；生图真实链路已实测（file:// 动态 import + generateImage 出图成功）。升级 gateway 时若 18789 起不来：检查 start-stack 是否残留旧 gateway 进程（taskkill //F //PID + 清锁后重启）。

26. **群聊专项（2026-09-09，落地完成）**：用户方案（已实施）——群聊与网页/私聊**彻底隔离**、**不做记忆总结**、按人名一一对应存原文。① **存储** `src/core/groupChatStore.ts`：`data/groupchat/<slug>/<gid>.jsonl` 每行一轮 `{id,t,memberId,memberName,user,assistant}`（提问与回复一一对应），`_meta.json` 存群名+成员起名映射；每人滚存 200 轮（超限只删旧原文，不做语义压缩）。② **两级检索注入**（`recallGroupContext`，6 轮）：先按 memberId 过滤该人历史取最近 6 轮 → 再在该人历史里做关键词打分，命中轮次前后各抓 1 轮合并去重按时序排列 → 注入格式「【群里 <名字> 之前与你的对话】<名字>：… 你：…」+「对不同的人保持你们之间应有的相处方式」。显示名一律取**当前起的名字**（历史行 memberName 是快照，起名后必须跟着变）。③ **QQ 补丁 v13**（`scripts/patch-channels.mjs`）：入站在 `assembleBody` 后按 `envelope.chatScope==="group"` 调管理台 `/api/internal/groupchat/recall` 拿注入文本覆盖 `assembled.agentBody`；出站在拆条后把 `pieces.join("
")` 作为回复存档；`bot.on("rawEvent")` 接住 `GROUP_ADD_ROBOT`（上游只 emit 无人订阅=进群事件被丢弃）→ 只登记群、**按用户要求不发开场白**。**补丁踩坑**：v13 helper 必须插在 **v8 段尾标记**（`// ==== [/openclaw-shell patch v8] ====`）——插在 v12/v9 段尾会与 gen helper 互相整段覆盖（实测两者反复吞掉对方，表现为生图 helper 只剩调用点 → 运行时 ReferenceError 回复全挂）；跳过判定必须校验 `function __ocsXxx` **函数声明**而非标识符，否则残缺形态被误判为已打完。④ **隔离**：`sessionMirror` 的 `findSession`/`listAgentSessionUsers` 跳过群会话（`isGroupSessionKey` 匹配 `:group:`/`:channel:`），群消息不进 conversations/history-export/USER.md/记忆库（实测已验证）。⑤ **网页 UI**：记忆页底部「群聊对话memory」区，群名矩形方块（显示 N 轮 · M 人）+ 右侧删除键（单群一键删除，不影响网页/私聊记忆），点方块弹窗给成员起名（QQ 开放平台**无群成员昵称接口**，默认显示 `成员_xxxx` 短码，起名后检索与称呼都用新名）。⑥ **API**：网页侧 `/api/groupchat/:slug`（列表）、`/:gid`（成员详情）、`/:gid/delete`、`/:gid/member`（起名）；插件侧 `/api/internal/groupchat/{recall,turn,join}`（本机 127.0.0.1 免 Basic 认证，按 accountId/agentId 反查卡 slug）。⑦ **平台事实**：群里所有人共用一个 OpenClaw 会话（sessionKey 只含 group_openid），但每条消息带 member_openid → 我们自己按人建档才有「对不同的人不同态度」；QQ 群默认仅 @ 才回（插件 mention-gate），官方主动发言有硬频控（每群每天 1000 条、被动回复 5 分钟 5 次）；**微信插件不支持群聊**（capabilities.chatTypes 只有 direct）。⑧ **P2 待做**：环境消息模式（`messages.groupChat.unmentionedInbound:"room_event"` + AI 自主判断发言，官方 ambient room events）——输入量有三道闸不会爆（未@消息压缩成通知、群历史滚动窗口默认 50 条、我们的检索限量注入）。
