# openclaw-shell 项目交接文档（HANDOFF）

> 更新：**2026-09-17**（新对话**先读 §42 交接速查**；09-16/17 的改动细节看 §43–§50）
> 历史：2026-09-04 合入异地备份版（预设 v3 / 表情分组 / 开场白 / AI 主动消息 / 跨端会话镜像 / 记忆整卡通用化，详见 git 提交 a5907e1 + 库内 REPLICATE.md）
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

27. **模型上下文缓存专项（2026-09-11，实测命中率 33% → 93-96%）**：用户提出的成本问题——DeepSeek 缓存命中价 0.02 元/M、未命中 1 元/M（差 50 倍），但要求**前缀逐字节稳定**才命中。① **上游能力已实测可行**：jiyuan（DeepSeek 中转）第 1 次 hit=0（冷启动，官方说需 1-2 轮预热）、第 2/3 次 hit=1024/1235（83%），字段是 DeepSeek 原生 `prompt_cache_hit_tokens` + OpenAI 兼容 `prompt_tokens_details.cached_tokens` **双份都透传**；agnes 只有 `cached_tokens` 形状（免费额度易限流）。② **我们改前的实测基线 = 稳定态 33.3% 命中、每轮未命中 870 token**（首轮 0%）。③ **找到并修掉四个破坏点**：**(a) 记忆检索每轮重算塞进 system**（原来 `recall(slug, message, 30)` 按当前消息做相关性检索 → system 头部每轮都变 → 整段前缀报废）→ 改为 **`readEntries(slug)` 全量注入**（不检索），记忆没新增时 system 完全不变；**(b) 世界书 `probability` 用 `Math.random()` 抽样**（同一条目每轮随机在/不在 → 前缀抖）→ 改为**按条目内容做 FNV-1a 确定性哈希**，保留概率语义但集合稳定；**(c) 配置变更提醒 `cfgReminder` 永久不过期**（`lastChange` 一直保留，实测某卡 9-08 的变更到 9-11 还在每轮注入 137 字符）→ `buildConfigChangeReminder` 加 **24 小时过期**；**(d) 动态块摆放**——记忆/世界书触发条目曾试图后置到历史之后，实测**反而更差**（451ms vs 基线，未命中涨到 800-1000），因为 DeepSeek 按「请求边界」落盘缓存单元，动态块插在末尾会破坏「上一轮 assistant 回复」那个落盘边界 → 最终方案：**只有「必须贴近生成点」的配置提醒与关键词世界书留末尾，记忆全量进 system 末尾**。④ **最终结构**：`[system 静态人设+预设+常驻世界书+工具+记忆] → [示范对话] → [开场白] → [历史(只追加)] → [动态块，稳定态为空] → [本轮 user]`。⑤ **实测结果**：稳定态 **93-96% 命中**，每轮未命中降到 **137-250 token**（就是本轮新增的 user 消息，不可避免）；合计 83%。⑥ **配套工具**：新增 `src/core/llmUsage.ts`（解析两种缓存字段形状、jsonl 记账、汇总统计）+ `chatCompletions` 内 `logAndRecordUsage`（日志打「输入 X · 输出 Y · 缓存命中 Z/W（P%）· 未命中 N」）+ `GET /api/llm/usage` + **设置→运行日志页顶部「模型缓存统计」面板**（合计 + 按模型列表，可刷新）。记忆总结调用也一并记账（`kind: memory`）。⑦ **验证记忆未被改坏**：全量注入后提问「还记得我喜欢什么回答方式/表情包要求吗」，AI 准确复述了直白回答、单行不加换行、别重复刷屏、只用纯文字、表情包要 GIF 等要点。⑧ **注意事项**：缓存有效期官方不承诺（best-effort，几小时到几天）；**只匹配输入前缀，输出永不受影响**；若走第三方中转，务必实测流式下 hit/miss 是否透传（本次两家都透传，但社区有 NewAPI 流式 `cached_tokens` 恒为 0 的案例）；**别频繁改预设**——每次改 system 会让该卡所有活跃会话缓存一起报废。jiyuan 提供商是为本次测试启用的（原为停用状态）。

28. **气泡返回值回归 bug（2026-09-11 修复，用户报「Cannot read properties of undefined (reading 'dataset')」+「（正在输出…）一直卡在聊天记录里」）**：两个现象**同一个根因**，且**是本项目前端 bug，与所用 API/模型（老黄）无关**。① **根因**：09-10 的提交 `bc9834f`（做卡生成与通道体验大更新）把 `addChatBubble` 的函数体抽成新的 `renderBubbleRow` 时**丢了返回值**——新 `addChatBubble` 表情分支显式 `return;`、普通分支只调用 `renderBubbleRow(...)` 不 return，**恒返回 undefined**；同一提交又把调用点改成 `wbPendingUserRows.push(addChatBubble(...))`（开始依赖返回值）。于是：**(a)** `wbThinkingBubble = addChatBubble("bot","（正在输出…）")` 得到 undefined → `if (wbThinkingBubble)` 永远为假 → **占位气泡每次都删不掉**（不只截断时，正常回复也残留）；**(b)** 该 undefined 被 push 进数组后 `rows[rows.length-1].dataset.convId = ids[0]` → **undefined.dataset 抛错** → 被 wbDoSend 的 catch 捕获，聊天里冒出「⚠ Cannot read properties of undefined (reading 'dataset')」，同时 `wbChatHistory.pop()` 把本轮用户消息从历史里挤掉。② **另一处坑（当时已存在）**：`renderBubbleRow` 结尾机械照搬了旧代码的 `return div`，但重构后 `div` 是**内层 .bubble**、外层才是新加的 `.bubble-row`——而所有调用方要的都是外层（挂 data-conv-id 供 `#chat-log .bubble-row[data-conv-id]` 选择器匹配、`.closest(".bubble-row")` 移除、`.parentNode` 追加审批按钮）。③ **修法**：`renderBubbleRow` 改 `return row`（外层）+ 注释说明；`addChatBubble` 普通分支 `return renderBubbleRow(...)`、表情拆分分支返回最后一条；调用点加防御 `const lastUserRow = rows[rows.length-1]; if (ids[0] && lastUserRow) ...`。④ **浏览器实测（含截断路径）**：正常发送 → 占位气泡请求后消失、convId 正确挂到用户气泡、无报错；**截断路径**（请求在飞时再发，入口=双击回车；发送按钮此时是 disabled 所以点按钮无效）→ 占位气泡正确移除 + 「已截断上一条输出」提示正常；表情气泡（innerText 为空是正常的，内容是 img）不受影响。⑤ **排查教训**：① **多标签页陷阱**——browser-use 里 `tabs.list().find(t=>t.url.includes(host))` 会命中**旧标签**（旧版本 JS），导致"改了没生效"的假象；必须逐个核对标签的 `document.scripts` 版本号，或先关旧标签。② 前端静态资源是 **immutable 缓存**，index.html 的 `?v=` 由 mtime+size 自动生成（见 §25），**改完前端刷新即生效**，但**已经打开的旧页面不会自动更新**，用户需刷新。③ 判断"前端 bug vs API 问题"的快速方法：看报错是不是 JS TypeError（`Cannot read properties of undefined` 这类）——API 故障只会表现为 HTTP 错误/超时/空回复，不会抛前端 TypeError。

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

29. **图片/语音本地化专项（2026-09-15，已实施并实测）**：目标=分发形态下**服务器不再保存任何用户图片**，图片与语音归用户浏览器（IndexedDB）与用户自选文件夹。改动分四块：① **生图双轨化**（`src/core/imageGen.ts` 新增 `GenOpts.web`）：NAI 走「**URL 直显**」——网关只回图链，服务器**不下载不落盘**，浏览器 `<img>` 直连上游（上游 4.5/5 由 sta1n 提供，只保存约 15 天，生图配置页已加提示文案）；OpenAI 走「**内存图库**」——字节下载后存 `src/core/memImages.ts`（2 小时 TTL），工具返回 `/api/image/<id>`，前端拉一次进 IndexedDB，服务器不留。**通道（QQ/微信）不受影响**：插件仍下载字节传腾讯（唯一路径），压缩开关开启时发送前转 JPEG q88。② **图片记录与显示链**：`/api/chat` 响应新增 `images: [{url, prompt}]` 元数据（由 `executeToolCalls` 从工具结果解析）；服务端把模型复述的图链**一律剔除**再统一以「已生成图片：<url>」追加（URL 绝不作为文本出现在气泡里，无扩展名图链也能渲染）；前端 `ocSaveImageMeta` 入库、`ocHydrateChatImage` 渲染链 = **上游 URL → 本地文件夹文件 → 提示词卡片（带复制提示词键）**。③ **文件夹保存（File System Access API）**：设置→本地存储 里选保存位置（`showDirectoryPicker`，句柄存 IndexedDB，重启后需再授权一次），写入按角色卡建子文件夹、文件名 `日期_时间_随机.webp`（天然按时间排）；**手机浏览器不支持选文件夹** → 自动降级为下载到「下载」文件夹。自动保存两个独立开关（OpenAI / NAI，默认都关，NAI 自动保存会经服务器代理拉一次字节）；压缩开关（`imageConfig.compression.enabled`，服务端配置）开启后**保存一律转 WebP**（实测 1380KB PNG → 111KB WebP，省 92%），通道发送转 JPEG。④ **存储管理页 + 批量保存页**：`#/storage`（占用统计 `storage.estimate()` + 按卡分组图片网格 + 语音列表 + 删除，全部流式游标遍历防 OOM）；`#/imgsave?slug=`（聊天设置页入口，拉起该卡**未保存**图片，微信式圆圈多选 + 全选 + 保存）；TTS 朗读音频存 IndexedDB（同文本重听零合成）。**同时删掉**：30 天图片自动清理（`cleanupImages` + 每日定时器 + `imageConfig.retentionDays` 全删，服务器已无清理对象；音频本来就不落盘、无清理功能）。**踩坑**：① `/api/image/:id` 必须注册在 `/api/image/list|delete` **之后**，否则 list 被当 id 截胡；② 前端列表加载要加**代际守卫**（两次加载共用一个数组会互相清空→实测丢记录）；③ 气泡里的开关 input 是隐藏的（视觉在 label 滑块上），测试要点 label 不是 input。**未做**：真实生图出图后的一次端到端回归（用户自行验证，避免烧生图额度）、分发前删除本地语音兜底（Edge/SAPI）。

30. **本地存储页重做 v2（2026-09-15，按用户反馈重排布局）**：用户否掉了首版（"抄都不会抄吗"，要求对齐 RP-Hub 存储页）。**新布局**（`#/storage`，全部在 `web/app.js` 媒体库段落里）：三级视图 `ocSt.view` = overview / img / img_card / au / au_card，用 `ocStGo(view, slug, name)` 原地重渲染 `#view`（不换路由）。① **总览** = 三张卡：**网页存储空间**（大号已用数值 + `/ 配额` + 进度条 + 右上「重新统计」）、**分类占用**（彩条行：图片蓝 #1677ff / 语音绿 #22c55e，右侧「N 张 · 大小」+ 箭头，整行可点进明细）、**保存设置**（分隔线行：保存位置 + 选择文件夹、自动保存 NAI 图、保存时压缩）。② **明细**（img/au）= 按角色卡的彩条行列表 → 点进 **卡片视图** = 图片网格（状态角标「已存文件/仅链接/应用内」+ ✕ 删除 + 右上「全部删除」）或语音行（▶ / 文本摘要 / 大小 / ✕）。**设计口径（用户明确要求）**：**界面里不要写解释性文案**（"此浏览器不支持选文件夹""不计入统计"这类全删）——不支持的浏览器**直接把「选择文件夹」按钮置灰**；开关只留短标签（"保存时压缩"，不写 WebP 说明）；空态只写「暂无图片/暂无语音」。**去掉的功能**：OpenAI 自动保存开关（OpenAI 图本来就自动进 IndexedDB，无需开关；只有 NAI 自动保存保留，默认关）。**踩坑（重要，重演 09-08 v13 那类事故）**：新增的 `const ocSt/ocStCache/ocStColors` 声明写在**文件末尾的媒体库段落**，而原启动调用 `router()` 位于文件中部 → 首次进 `#/storage` 撞 **TDZ 报错**（`Cannot access 'ocSt' before initialization`，表现是 `#view` 渲染空白）。修法=**把 `router(); void loadProfile(); ensureEmojiLib()` 三行启动调用移到文件最末尾**（在所有 const 声明之后）。教训：往 app.js 追加带 const 的模块，必须把启动调用也挪到最后，或把状态声明改成函数内/惰性初始化。**其他**：`ocStGo` 每次进视图清空扫描缓存（否则新生成的图不显示——实测踩到）；`ocFmtSize(0)` 返回 `0 B`（原来 `Math.max(1,…)` 会显示成 "1 KB" 很怪）；无字节的分类行只显示「N 张」不显示大小。

31. **本地存储页 v3（2026-09-15，补齐 RP-Hub 分类口径 + 删除墓碑）**：用户指出 v2 抄漏了分类——**必须有「聊天记录 / 角色卡 / 记忆」三类占用**（我们没有群聊与向量，故不列）。① **服务端新增 `GET /api/storage/breakdown`**：按卡返回 `{chat, mem, card, img}`（chat=conversations jsonl+chatlog；mem=.mem/.greeted/.mirror/两个导出 md；card=cards/<slug>/+covers；img=data/images/<slug>/ 的历史图），用递归 `pathBytes()` 统计、软链跳过。**这是"打开存储页显示 0"的根因**——旧图全在服务端，浏览器 IndexedDB 里没有，v2 只统计浏览器侧所以是 0。② **视图层级**：总览分类占用（聊天记录→chats / 角色卡→cards / 记忆→mems）+ 保存设置；**聊天记录列表**按卡显示总占用（服务端+浏览器+文件夹+历史图之和），**每行最右「更多」→ 展开「图片 / 语音」两个按键**（用户点名要求，RP-Hub 原位是图片键）；**图片页**分三段=本机图片（IndexedDB 记录）/ 服务器图片（历史 data/images，可直接 ✕ 删，走 `/api/image/delete`）/ 已保存到文件夹（句柄枚举，✕ 直接删文件）。③ **删除=墓碑**（用户要求）：`ocDeleteImageRecord` 不再真删记录，而是落 `{deleted:true}` 墓碑并清掉 blob 与文件夹文件 → 聊天里那张图**永远显示提示词占位（"图片已删除"+ 提示词 + 复制键），且绝不触发二次生图**；语音同理（`ocAudioDelete` 墓碑保留 text，`speakText` 见到墓碑直接提示「这条语音已删除」，不再重新合成烧钱）。④ **修复两个真 bug（都是真实出图实测出来的）**：**(a) sta1n 的图链没有扩展名**（`/api/images/img_xxx/content`）——服务端只按扩展名正则收图导致图片行根本没写进回复；改为**按「已生成图片：」前缀取 URL**（`executeToolCalls` 里 gen[1] 同时进 imgs 与 imageMeta），前端 `CHAT_IMG_RE` 也加了前缀分支并在渲染时剥前缀。**(b) 会话记录不存生图元数据** → 刷新/换浏览器后历史渲染出来的图没有提示词、URL 失效时卡片空白；`ConvEntry` 加 `images:[{url,prompt}]` 字段（appendConv/readConv 双向透传），前端加载历史时建 `ocUrlPrompt` 映射，hydrate 建记录与回填旧记录都取它。⑤ **实测（真实 NAI 4.5 出图 3 张）**：回复带图链 ✓、图片 832x1216 正常渲染且 URL 不出现在文本里 ✓、历史渲染入库（含提示词回填）✓、删除后聊天显示"图片已删除"+完整提示词 ✓、语音墓碑 playback 置 null ✓。**注意**：小小卡的模型 `agnes/agnes-2.5-flash` 会出现「只嘴上说画好了、从不真正调用 image_gen」——测试时改用支持 function calling 的模型（jiyuan/deepseek-v4-flash-0731）才真出图，这是模型能力问题不是链路问题。

32. **本地存储页 v3.1（2026-09-15，用户三点反馈）**：① **图片页不再分段**——本机记录 / 服务器历史图 / 文件夹文件**混排成一条时间线**（按 createdAt / mtime / File.lastModified 倒序，最新在最前），删掉 v3 的「图片 0 + 服务器图片」两段式（用户："不要区分"）；`ocImgCell(it)` 统一渲染三种来源（角标=状态或大小），`ocDeleteImageRecord` / `/api/image/delete` / 句柄 removeEntry 三种删除各自对接。② **统计改为按需 + 缓存**（用户："不要每次返回和进入都重新统计"）：`ocStData(force)` 命中 `ocStCache` 直接返回；**总览进入时若没缓存只显示「—」不扫描**，点「重新统计」才 `ocFillOverview(true)` 真扫；详情视图用缓存、无缓存才扫一次；**只有删除会作废缓存并原地重算**（`ocStAfterDelete()`）；`#/storage` 的 init 不再清缓存（进出保持结果）。实测：进入 0 请求 → 点按钮 1 请求 → 进出三个视图仍 1 请求。③ 保存设置的两个开关行加 `.oc-row .switch { margin-left: auto; }` 贴右对齐。**顺带修掉一个坑**：缩略图原来用 IntersectionObserver 懒加载，**在 `#view` 这个自滚动容器里实测根本不触发**（表现为空格子、手动赋 src 就正常）→ 改为直接取源，延迟交给 `<img loading="lazy">`（原生懒加载）。

33. **网关规模压测（2026-09-15，实测）**：目的=回答"每用户独立机器人"形态下，一台服务器能挂多少个 agent。方法：`scripts/loadtest-agents.mjs`（保留在仓库里，add/remove 两个命令）向 `~/.openclaw/openclaw.json` 的 `agents.list` 批量写入假 agent（id=loadtest-XXX，空工作区+最小 AGENTS.md，不绑任何凭证），重启网关后测 node 进程 RSS，最后 remove+清目录+还原。**结果**：6 agents=282MB → 31=265MB → 56=265MB → **206=290MB** → 还原 6=279MB。**结论：空闲 agent 的边际内存成本 ≈ 36KB/个（噪音级），网关内存由插件/SDK 基线（~260-290MB）主导，与注册 agent 数无关**——agent 是懒加载的，工作区/会话只在有消息时才载入。这直接验证了"用户注册后不等于常驻消耗"：容量按**活跃会话**算，不按注册数。**两个连带发现**：① `openclaw agents list` 在 206 agents 时耗时 ~150s（6 个时秒回）——CLI 巡检随规模急剧变慢，多租户后管理端的热路径必须改成直读 openclaw.json/缓存，不能 spawn CLI；② 网关启动在 206 agents 下仍正常（QQ bot 照常 ready）。**对服务器结论的影响**：内存维度从"按注册用户"改成"按并发生成"——2核4G 撑 ≤300 注册用户（活跃几十个、并发生成 ≤30）没有问题；磁盘实测每活跃用户每月 1-4MB（5 个 agent 26 天共 14.4MB 会话 + 管理台侧 1.5MB，媒体即发即删不计），50G 是年级别的余量。压测备份：`~/.openclaw/openclaw.json.bak-loadtest`（确认无误后可删）。

34. **多租户地基：设备随机 ID 即身份（2026-09-15，已实施并实测 7/7）**：分发形态的隔离方案（用户拍板：**无注册无登录**，打开就能玩；删除 App 重装 = 全新身份 = 服务端数据清空；用户自己保存到文件夹的文件不删——浏览器机制天然保证，应用内 IndexedDB 卸载自动清）。**机制**：① 前端首启生成 32 位随机 hex（`localStorage.oc_device` + `oc_device` cookie，cookie 让 `<img>` 等子资源也能带身份），`fetchApi` 全部携带 `X-Device-Id`；② 服务端 `src/core/dataRoot.ts` 用 **AsyncLocalStorage** 存请求作用域，`dataDir()` 在设备请求内自动指向 `data/users/<id>/`——**全项目 25+ 个 store 全部经 dataDir() 取路径，一处改全局生效**；③ 管理员（Basic 有效）**永远压过设备身份**（浏览器同时带设备 cookie + Basic，Basic 校验在前并把 `res.locals.ocDevice` 置 null）→ 走全局 `data/`，原有数据零迁移；设备请求免 Basic。④ 设备注册表 `data/users/registry.json`（全局，不在任何命名空间内），管理员端点 `GET /api/users` / `POST /api/users/disable`（列出/停用；被停用设备按未认证处理 → 401）。⑤ **管理员专属端点清单**（设备 403）：`/api/bots /api/channels /api/distill /api/plugins /api/mcp /api/users /api/backup /api/workspace/`。⑥ 按作用域静态：`/img /emojis /covers` 用 `ocScopedStatic()`（每根缓存 express.static 实例）。**实测 7/7**：管理员全局 5 卡不受影响（含"Basic+设备头并存=管理员优先"）；纯设备 A 建卡只自己可见；设备 B 跨读 404；停用 401、恢复 200；磁盘落位 `data/users/<id>/cards/...`，全局 `data/cards` 未动。**注意**：ALS 上下文随 async 链路传播——请求内 `void autoMemorize(...)` 这类延时任务也在设备作用域里写（正确）；而**启动期定时器**（lifeScheduler/mirror）无作用域写全局（也正确，那是运营者数据）。**Phase B（分发前必做）**：机器人/通道按设备归属（botId 前缀防 slug 撞车，`botStore.ts:105` agentId=卡 slug 会跨用户撞）、模型 key 到设备/用户级（各走各的 Soul API token）、远程绑定流程、管理页设备管理 UI、**打开 App 增量同步通道记录**（09-17 设计对齐，见 §42 待办 1）。压测脚本 `scripts/loadtest-agents.mjs`（add/remove）保留。

35. **分发服务器已上线（2026-09-16）**：`103.117.138.91`（4核 Xeon 8272CL / 3.8G / 系统盘 30G + 数据盘 50G 挂 `/data` / 30M 不限流量 / CN2 / Ubuntu 24.04.1，40 元/月）。**完整部署手册见仓库 `docs/linux-deploy.md`**（含全部命令与坑位，重装照抄）。要点：① **SSH**：本机别名 `ssh sb`（专用密钥 `id_ed25519_sb`）；商家镜像 `PubkeyAuthentication no` 必须用 `/etc/ssh/sshd_config.d/99-pubkey.conf` 覆盖（与中转站同一个坑）；密码登录尚未关闭。② **systemd 四服务**：`openclaw-shell`（管理台 127.0.0.1:17880）、`openclaw-gateway`（127.0.0.1:18789）、`openclaw-tts`（0.0.0.0:17900，被 ufw 拦）、`caddy`（80/443 反代 17880），全部 enable 开机自启。③ **路径**：程序 `/data/openclaw-shell`（数据同盘）；`/root/.openclaw` → 软链 `/data/openclaw`——**坑：openclaw 首次运行会自建真目录，直接 `ln -s` 会把链接塞进它里面，网关报 "Missing config" 起不来；正确顺序是先建 `/data/openclaw` 再 `rm -rf /root/.openclaw && ln -s`**。④ **npm 11 默认拦安装脚本**：装 openclaw/通道插件必须带 `--allow-scripts=openclaw,@google/genai,koffi,protobufjs,tree-sitter-bash`，否则 tree-sitter/koffi 原生模块不编译。⑤ **公网入口**：Caddy 配 `app.319274.xyz`（**需灰云 A 记录**，套 CF 橙云实测 ACME 签发 401 失败）+ `:80` IP 直连兜底（HTTPS 通后可删这段）；`soulbox.319274.xyz` 指向家里隧道**不要动**。⑥ **验证口径**：公网 IP 访问返回 401（要 Basic）、带凭据 `/api/health` 200、设备身份请求（X-Device-Id）200、无凭据 401、`openclaw doctor` 无误。⑦ **服务器当前是干净起点**：**未迁移任何通道凭证**（QQ/微信还在开发机，避免两个网关抢同一账号），`openclaw.json` 为最小配置（无 providers/channels）；TTS_ALLOW_LOCAL/TTS_FORCE_SILK 这两个本机 hack 未在服务端设置。

36. **身份双轨 + 管理员登录（2026-09-16，已上线 `https://soulbox.319274.xyz`）**：分发形态下**用户零登录**（设备随机 ID），管理员靠密码，两者互不干扰。**关键修正**：原来只有 Basic 认证，而浏览器一旦带上设备 cookie 就再也不弹 Basic 框（设备请求免认证）→ 管理员进不去管理端。现在：① 登录页 `https://<域名>/#/login`（抽屉底部还有「管理登录/退出管理」入口）；② 登录成功下发 `oc_admin` cookie（**HMAC(user:pass) 无状态签名**、HttpOnly、HTTPS 下 Secure、30 天，改密码即全体失效）；③ 认证优先级：Basic 凭据 > `oc_admin` cookie > 设备 ID（前两者都强制走全局 data/）；④ **外壳静态免认证**（`/`、`/index.html`、`/app.js`、`/style.css`、`/assets/*` 与 `/api/admin/*` 在 PUBLIC 清单里）——这是分发的前提，新用户必须先能打开页面才会生成设备 ID（否则会撞 Basic 弹窗，用户根本没密码）。**已知坑**：`/api/admin/me` 也在免认证清单里 → 它读不到 `res.locals.ocAdmin`，必须自己判 cookie/Basic（踩过一次，返回 admin:false 导致"退出管理"按钮不出现）。**安全加固已做**：SSH 密码登录关闭（仅密钥，`sshd -T` 验证 `passwordauthentication no`）、IP:80 由"明文代理应用"改为"跳转域名"。**凭据位置**：管理台账号在服务器 `/data/openclaw-shell/.env`；SSH 别名 `ssh sb`（密钥 `~/.ssh/id_ed25519_sb`）；OpenClaw 网关 token 在 `/data/openclaw/openclaw.json`。**另注意**：跨境 SSH 短时间连太多次会被对端重置（实测连续 5-6 次后开始 Connection reset，等 60 秒恢复）——批量操作要合并成一次连接。

37. **管理员设备机制 + 数据迁移（2026-09-16）**：用户反馈"登录后卡还是空的"——两层根因：① **服务器是新装的，他的 5 张卡在开发机没迁**（迁移=打包 data/{cards,conversations,memory,memory-export,history-export,covers,emojis,presets.json,imageConfig.json,ttsConfig.json,providers.json,user-profile.json,chat-list.json} → 解到服务器全局 data/，工作区/agent-workspaces 不迁（网关按需重建））；② **管理员设备机制**：`users.ts` 设备记录加 `admin` 标记 → 设备中间件识别后走全局作用域免密码（`/api/admin/me` 返回 `{admin:true,via:"device"}`）→ **踩坑：auth 中间件必须显式放行 `res.locals.ocAdmin`，只设标记不放行会 401**。管理端点 `POST /api/users/admin {id,admin}`（把某设备设为管理员——换电脑/新设备迁管理端用）；抽屉对管理员设备显示「管理员（本设备）」无退出概念。**#/login 密码登录保留**作为新设备进管理端的备用通道（用户说"取消登录"指的是不要密码门槛，他的设备已白名单免密）。**数据迁移口径**：开发机=开发环境，服务器=生产；两边数据从此各自演化不同步，改卡要在服务器上改（或再跑一次迁移覆盖）。本地用户数据实测迁移包 13MB。

38. **凭证迁移 + 设备管理页 + 备份体系（2026-09-16）**：① **QQ/微信凭证已迁至服务器**（本地 openclaw.json 全量迁移 + 路径改写：`D:\ai_workspace\openclaw-shell→/data/openclaw-shell`、`C:\Users\followsun\.openclaw→/data/openclaw`，转换脚本 /tmp/fix-paths.cjs 思路=双/单/正斜杠三形态 + /data/ 开头路径残留反斜杠兜底）；**两个 QQ 号（qq-<运营者号1>/qq-<运营者号2>）已在服务器 Gateway ready**；本地网关已停、本地 openclaw.json 通道已 enabled=false（防双网关抢号）。**踩坑三连**：a) tar 上传的文件带开发机 uid → OpenClaw 插件安全检查拦截"suspicious ownership"，`chown -R root:root /data/openclaw-shell /data/openclaw` 解决；b) openclaw 首次运行自建 ~/.openclaw 真目录导致软链失效（见 §35）；c) 迁移的 npm/projects 只是文件，OpenClaw 的安装注册表没跟上 → 必须用官方命令重注册：`openclaw plugins install --link <自研插件路径>` × 2 + `openclaw plugins install npm:@tencent-connect/openclaw-qqbot --force` + `npm:openclaw-weixin --force`。② **设备管理页** `#/users`（管理员可见，/api/users 本身就是设备 403）：每设备一行=创建日期/最近在线/管理员标记 + 「设为/取消管理员」「停用/恢复」；`POST /api/users/admin {id,admin}` 新端点。③ **备份体系**：`scripts/server-backup.sh`（服务器 /data/scripts/）——每日 04:00 cron 打包 data+openclaw+.env → /data/backups/ 留 7 份 + **scp 异地推送到中转站机器**（103.233.254.159:/data/backups-from-soulbox/ 留 7 份；站间密钥 id_ed25519_hkrelay，对端 authorized_keys 已加）。首次备份实测 38MB 全链路通过。异地用加密推 GitHub 的方案可后续再加。

39. **架构分工定型（2026-09-16，用户拍板）**：**GitHub = 纯用户版，运营层永不上传**。
- **分支**：`main`（GitHub，公开面）= 用户自部署版（当前 = `a857767 图片/语音本地化`）；`prod`（**仅本地，不 push**）= 用户版 + 多租户 + 管理端 + 服务器运维脚本。**所有运营/管理/服务器相关内容只在 prod 分支与服务器上存在**。GitHub main 已强制回退到 a857767（历史里的运营提交在 GitHub 上消失；全量历史兜底 bundle 存于 `D:\ai_workspace\backups\openclaw-shell-full-history-*.bundle`）。
- **两种运行模式**（`src/server.ts` 顶部判定）：**有 `OPENCLAW_SHELL_UI_USER/PASS` = 托管模式**（设备命名空间隔离 + 管理员 Basic/cookie/白名单）；**无认证 = 单用户模式**（不做设备隔离，全部走全局 `data/`——就像用户自己拉代码在本机跑）。判定常量 `HOSTED_MODE`。
- **本机（开发机）已改为"普通用户模式"**：`.env` 里的登录凭据已删（备份 .env.bak-*）、**家里隧道已停且禁用**（`config-openclaw.yml` → `.disabled`，start-stack 不再拉起）、通道已 enabled=false、本地网关可不跑。本机 17880 免登录即见自己的卡（单用户全局空间）。
- **备份口径（用户明确）**：**只备份框架 + 管理员配置，不备份任何用户数据**（用户数据按设计在用户侧/短保留，丢了不影响用户）。服务器 `scripts/server-backup.sh` 现只打包 `.env + openclaw/openclaw.json + split-styles.json + users/registry.json`（**实测 2.8KB**），每日 04:00 cron、留 7 份；**不再推送到中转站**（站间密钥已删、中转站上的备份目录已删）。要拿回本机：`scp sb:/data/backups/soulbox-config-*.tar.gz 本地路径`。
- **中转站纪律（用户强调）**：103.233.254.159 **只跑中转站**，不要再往上放任何别的东西（本次已清理：删掉我加的备份目录与那行公钥）。

40. **用户数据只留 15 天 + 图片只存提示词 + 管理端查看用户（2026-09-16，全部只在 prod 分支，不进 GitHub）**：
- **保留策略**（`src/core/retention.ts`）：`RETENTION_DAYS` 默认 **15**（env `OC_RETENTION_DAYS` 可调），**只作用于设备命名空间 `data/users/<id>/`**（运营者自己的全局 data/ 完全不碰——不然他自己的卡与聊天会被清）。到期从最早的消息开始删：`conversations/*.jsonl`（按 `t`）、`memory/*.chatlog.jsonl`、`memory/*.mem`（按 `ts`）。启动跑一次 + 每 6 小时一次；管理员可 `POST /api/users/retention {days,dryRun,id?}` 手动跑/预演（实测预演返回每设备统计）。
- **图片只存提示词**：服务器写会话时把 `已生成图片：<上游URL>` 换成 `（图片：<提示词>）`（`/api/chat` 的 appendConv，prompt 取自 imageMeta）；保留策略也会把**存量**记录里的图链行一并改成提示词形态（含 parts）。**渲染路线不变**（图上还是走原地址，用户看不到 URL 文本）——用户明确说"不要搞得太严肃"，**已撤销**中途做的 AES token 加密代理方案（`mediaToken.ts` / `/api/img/:token` / 元数据改写全部删除）。
- **管理端查看用户**：`GET /api/users/:id/cards`（在该设备命名空间里读卡）、`GET /api/users/:id/chats/:slug`（readConv，含 `surface` 区分 web/qq/wx —— **QQ/微信 的聊天也在里面**，因为通道消息本来就镜像进同一份会话日志）。前端：设备管理页每行加「查看」→ `#/usercards`（该设备的卡列表）→ 点卡 → `#/userchats`（**纯文本，一行一句，不做任何气泡/框架渲染**）。
- **设置 →「我的设备 ID」**（`#/device`）：显示当前 ID + 复制 + **用旧 ID 恢复**输入框（写回 localStorage + cookie 后重载即接回原数据）；提示文案按用户原话：*"请牢记这个 ID。我们最多保存 15 天且仅有聊天记录，我们不会私自调用您的数据。15 天内遇到不慎删除，凭此 ID 可以恢复聊天记录；记忆和图片我们无能为力（服务器磁盘有限）。"* **此页不推 GitHub**（GitHub 是单用户自部署版，设备 ID 是托管形态才需要）。
- 设备注册表清理：删掉测试设备、把用户自己的 4 台设备都标为 admin（一键查看/管理）。

41. **底部管理入口按身份显示（2026-09-16）**：抽屉底部原来对所有设备都显示「管理登录」（用户看到不该看到的东西）。现改为 **`refreshAdminLink()` 只对管理员显示「管理」入口，普通用户彻底隐藏（连分隔符一起 `hidden`）**——判定走 `/api/admin/me`（管理员设备 via=device / 密码登录 via=cookie/basic 都算）。`web/index.html` 的页脚把分隔符拆成独立 `<span id="drawer-admin-sep">` 便于一起隐藏。**副作用**：换浏览器/清 cookie 后就看不到入口了 → 需要时手动访问 `https://<域名>/#/login` 输管理员密码（这条与设备无关，永远有效；建议加书签）。**只需在 prod 改，GitHub 用户版没有管理概念**。⚠️ **口径已被 §43⑥ 更新**：页脚那个 div 后来被误删又恢复，显示条件补齐为 `admin && hosted`（本地/自部署一律不出现）。

---

## §42 交接速查（**2026-09-17 第四次更新，新对话先读这段**）

### 一句话
「魂匣 SoulBox」= 装在自己服务器上、给用户开箱即用的 AI 角色机器人（角色卡 + 蒸馏 + QQ/微信机器人 + 生图 + 语音 + 表情包），商业模式是**自建 API 中转站**（香港 `api.319274.xyz`）赚钱。用户零注册零登录，**设备随机 ID 即身份**。

### 三份代码 = 同一个仓库的两条分支 + 服务器上的部署
| 位置 | 是什么 | 说明 |
|---|---|---|
| GitHub **`main`**（默认分支） | **纯用户版** | 直接 clone / Download ZIP 拿到的就是它；**没有**服务器 IP、路径、凭据等运营内容（已逐项验过） |
| GitHub **`prod`** + 本机 `prod` | **运营版**（服务器实际运行的那份） | GitHub 上只有一个**快照提交**（有意不带运营期的旧历史）；本机 `prod` 是日常开发分支 |
| 服务器 `/data/openclaw-shell` | 跑的就是运营版 | 用 tar 从本机传上去 |

**GitHub 纪律（重要）**
- 仓库目前是**公开**的（`api.github.com` 查 `private:false`；HANDOFF 旧文里写的 private 是错的）。想转私有：Settings → 最下面 Danger zone → Change visibility → Private。
- **绝不把凭据写进仓库文件**：管理员设备的 32 位 ID 在服务端**等同管理端密码**（请求头 `X-Device-Id: <该ID>` 直接得 admin 身份，实测 `/api/admin/me` 回 `admin:true`、`/api/users` 200，普通设备 403）。历史上它曾明文写在 HANDOFF 里，已脱敏成占位符。
- 推运营版：`git push origin prod`（本机 prod = 该分支）。造新快照的做法：从 `main` 拉分支 → `git checkout prod -- .` → 单提交（保证历史里没有运营旧提交）。
- 全量历史备份：`D:\ai_workspace\backups\openclaw-shell-full-history-20260917.bundle`（含改写前的旧 prod 尖端；找回：`git fetch <bundle> refs/heads/prod:prod-old`）。
- 往 `main` 推用户版时只能推**共用部分**（prod 的 `web/app.js` 混着运营代码，不能整份覆盖，按 hunk 挑，见 §44⑥）。

### 地址与入口
- 服务器：`ssh sb`（= 103.117.138.91）· 站点 <https://soulbox.319274.xyz>（用户入口，**免登录**）
- 管理员入口：`https://soulbox.319274.xyz/#/login`（账号 `soulbox`，密码在服务器 `/data/openclaw-shell/.env`）
- 本机开发：`D:\ai_workspace\openclaw-shell`，`powershell -File scripts/start-stack.ps1` → <http://127.0.0.1:17880>（单用户模式，免登录）
- **开发机数据与服务器各自演化、不同步**；改卡/改配置在服务器上改

### 服务器布局（4核/3.8G/30+50G/30M/CN2，Ubuntu 24.04）
- 程序 `/data/openclaw-shell`（数据同目录）· 网关家目录 `/root/.openclaw → /data/openclaw`
- 四服务（都开机自启）：`openclaw-shell`(127.0.0.1:17880 管理台) `openclaw-gateway`(18789) `openclaw-tts`(17900) `caddy`(80/443)
- 备份 `/data/scripts/server-backup.sh` 每日 04:00 → `/data/backups/soulbox-config-*.tar.gz`（**只存 .env + openclaw.json + split-styles.json + 设备注册表 ≈3KB**；**不含** presets.json / imageConfig.json / registry.json，这三样要改先自己 cp）
- 手册 `docs/linux-deploy.md`

### 改代码 → 上线（照顺序，别跳步）
1. 本机改（`prod` 分支）→ `npx tsc --noEmit` + `npm run build`
2. `cd /d/ai_workspace && tar -czf /tmp/w.tar.gz openclaw-shell/src openclaw-shell/web && cat /tmp/w.tar.gz | ssh sb "cd /data/openclaw-shell && tar -xzf - --strip-components=1"`
3. **先 md5 校验两端一致再继续**（大包中途断开会只写一半，而 `web/` 是线上直接提供的）
4. 改过 `src` 才需要 `ssh sb 'cd /data/openclaw-shell && npm run build && systemctl restart openclaw-shell'`
5. **必须** `ssh sb 'chown -R root:root /data/openclaw-shell'`（否则插件安全检查拦 suspicious ownership）
6. 纯前端不用重启；`?v=` 由 mtime+size 自动生成，刷新即生效
7. **⚠️ 2026-09-17 起跨境 SSH 大包频繁 reset**（整包 tar 与 200KB+ 单文件都会断）→ 改用**逐文件传 + md5 校验**，单个文件仍失败就**分片**：
   `split -b 40000 -d -a 2 <文件> /tmp/sp3/p-` → 每片单独 `cat | ssh sb "cat > /tmp/pt3/<片名>"` 并 md5 → 服务器侧 `cd /tmp/pt3 && cat $(ls|sort) > /tmp/<file>.new` → 再整体 md5 一致才 `mv` 就位。**每次上线前先 `cp` 备份旧文件**（都在 `/data/backups/pre-sync-20260917/`）。
8. 改 APK 壳（`apk-build/soulbox/`）→ `bash build-soulbox.sh <版本>`，产物 `SoulBox-v<版本>.apk`（**同一签名，覆盖安装保数据**）

### 身份与权限（09-16 定稿）
- **用户**：设备 32 位随机 ID（localStorage+cookie）→ `data/users/<id>/` 命名空间（AsyncLocalStorage，全项目 store 走 `dataDir()`）。删 App 重装=新身份，可凭旧 ID 在「设置 → 我的设备 ID」找回。
- **管理员**：`#/login` 密码 → `oc_admin` cookie（HMAC 无状态，改密码即全体失效）；或管理页把某设备标 admin（走全局 data、免密）。
> ⚠️ **安全铁律**：那个管理员设备 ID 等同管理端钥匙，**绝不写进任何会进仓库/公开的文件**（用 `#/login` 密码进管理端）。

- **用户能用**：做卡 / 卡库 / 预设（内置「默认」档位组不可打开编辑，其余随便用）/ 蒸馏 / **通道扫码绑自己的机器人** / API 与模型 / 生图 / 语音 / 表情包（含 zip 批量导入）/ 本地存储 / 设备 ID
- **只给管理员**：插件、运行日志、模型缓存统计（进程级共用）、`/api/users`、`/api/backup`、微信配对授权
- **隔离机制**（不是整块 403）：设备命名空间(ALS) + **渠道账号归属表 `data/channel-owners.json`**（无记录的老账号一律算运营者的，设备看不见也动不了；扫码用"起点快照"认领新账号）+ 预设内置组锁 + `ADMIN_ONLY_PREFIXES`
- 用户数据：**只留 15 天且仅聊天记录**（`src/core/retention.ts`，只作用于 `data/users/<id>/`）；图片在记录里只留「（图片：提示词）」

### 关键文件（改哪里找哪里）
| 文件 | 作用 |
|---|---|
| `web/app.js` | 前端全部逻辑（路由/聊天/做卡/生图/存储/表情/通道/管理页/原生壳桥） |
| `src/server.ts` | 后端全部 `/api/*`（设备与管理员中间件、通道、导入端点） |
| `src/core/dataRoot.ts` `users.ts` `channelOwners.ts` | 设备作用域(ALS) / 设备注册表 / **渠道账号归属** |
| `src/core/compiler.ts` `presets.ts` `splitter.ts` | 人设编译 / 预设 / 拆条（预设文案改动要"代码 + 两处 presets.json"同步） |
| `src/core/emojiStore.ts` `emojiPack.ts` | 表情库 / 表情包 zip 解析 |
| `src/core/imageConfig.ts` `imageGen.ts` | 生图（**模型无默认值，必须先拉取**） |
| `src/core/conversationStore.ts` `memoryStore.ts` `retention.ts` | 会话 / 记忆 / 15 天保留 |
| `src/core/sessionMirror.ts` | 通道会话观察器（水位游标 + 扫 reset 归档 + 空闲性能门）；§51 改过 |
| `src/core/openclawCli.ts` | 调 openclaw CLI：**跨平台入口解析** + 扫码登录**必须套 PTY**；§53 改过 |
| `src/core/greetedStore.ts` | 开场白状态（`<slug>.greeted.json`）；§58 加了 `#first_mes_logged` 一次性标记 |
| `src/core/users.ts` | 设备注册表（disabled / admin / **label 标记**）；§56 加了 `setDeviceLabel` |
| `scripts/test-channel-replay.mjs` | 通道复刻自测（App 不开也复刻 / 会话重置补齐 / 增量拉取 / 跨设备不串，15 项） |
| `scripts/make-emoji-pack.bat`+`.ps1` | 表情包打包器（拖文件夹即出包） |
| `scripts/test-device-isolation.mjs` | 设备级隔离自测（临时 HOME，不碰真实配置） |
| `apk-build/soulbox/`（**在仓库外**) | 安卓套壳工程：`bash build-soulbox.sh <版本>`；**签名密钥务必留着** |

### 09-16/17 已完成（细节见 §43–§59）
设备级隔离地基（agent 名/模型 key 加设备前缀，修掉"设备保存会删空管理员提供商 + 泄露 Key"两个线上 bug）· 管理向功能身份门槛 · 预设页改版 + 两个 store bug 修复 · **重描写括号对换**（`{}`=心理、`（）`=动作）· 设备管理页 v2 · **通道对用户开放**（账号归属隔离）· **蒸馏对用户开放 + 删掉「直连本机 WeFlow」** · 生图/TTS 五项清理 · **安卓套壳 APK** · **表情包 zip 批量导入** · **App 增量同步通道复刻（§51）**（服务端按设备扫描补观察 = App 关着也复刻 + 抗会话重置 + App 打开拉进本地永久副本）· **表情包页改版 + 全站原生弹窗清零（§52）** · **通道扫码登录修复（§53）**（CLI 入口跨平台 + Linux 交互式登录必须 PTY）· **扫码体验三改（§54）**（状态标签带账号数 + 扫码中态、生成过程不外露、**打开通道页预生成二维码**把 15s 静默等待藏起来）· **清空历史账号 + 内置画师串只留三条（§55）**（4 个老账号含隐藏 `default` 全删 + 插件残留/别人 openid/凭证备份全清）· **提权漏洞修复 + 设备标记 + 查看返回保位（§56）** · **模型选择器合成一个「模型」三栏面板 + 输入区加高 1/3（§57）** · **聊天页五连改（§58）**（面板再瘦身 / 键盘不顶走顶栏 / 撤销入输入区 / 「对方正在输入中」上顶栏 / **开场白丢失修复含老卡一次性补写**）· **设置新增「字体设置」页（对话字体大小）+ 新卡默认风格「纯对话」+ API 报错/纯英文不再拆条（§59）**。

### 还没做的
1. **`main`（用户版）落后一大截**：§52–§58 这些用户也受益的改动（表情包页改版 / 原生弹窗清零 / 扫码登录修复 / 面板与输入区 / 开场白修复 / 设备标记除外）**都还没按 hunk 推到 `main`**；更早那批（生图三个画师串、TTS 用量删除、两处提示删除、表情包 zip 与打包脚本）也还在队列里。做法见 §44⑥（prod 的 `web/app.js` 混着运营代码，**不能整份覆盖**）。
2. **APK v3 待用户安装 + 真机验收**：`apk-build/soulbox/SoulBox-v3.apk`（修了软键盘顶走顶栏）。网页侧已有兜底，不装也能用；装了才是治本。
3. **一处没验到的**：自造夹具卡走不出「成功回复」路径（schema 不全）→ 「生成中顶栏提示在**成功**时复位」只做了代码核对，真机发一条消息即可确认。
4. 远程绑定流程收尾、Phase B 其余；壳自更新（用户说先不做）、可选的「导出表情库为 zip」。
5. 仓库转私有（用户自己点设置）；`feature/import-backup-0904` 旧分支待清理。
6. 可选的卫生工作：设备注册表里有 ~16 台测试/空壳设备（现在能用「标记」挨个命名，或清理掉）。

### 坑位清单（都是真踩过的）
1. **CRLF**：内联 `node -e` 用 `\n` 精确匹配会静默失败 → 用 `\r?\n` 正则或 Edit 工具，改完立刻核对。
2. **前端缓存**：静态资源 immutable（`?v=` 由 mtime+size 生成）；手工测试页抄旧 `?v=` 会跑旧代码；**hash 导航不重载文档**，改完 `reload()`；临时实例用 `?nc=<时间戳>`。
3. **测试实例**：临时 HOME + 临时 `OPENCLAW_SHELL_DATA`；停止用 **TaskStop / 按端口 taskkill**，**绝不用 `kill $!`**（曾把开发机三件套一起带走）。
4. **数据文件不是代码**：`data/presets.json`、`data/imageConfig.json`、`data/users/registry.json` 会**压过代码默认值** → 改文案要"代码 + 本机文件 + 服务器文件"三处同步，改前 cp 备份。
5. **`.ps1` 必须带 UTF-8 BOM**（PS5.1 无 BOM 按 GBK 读中文必乱）。
6. **中文 zip 可能是 GBK**：条目名与 TXT 都要"UTF-8 严格解失败即回退 GBK"。
7. **SSH**：`Host sb` 已固定 `KexAlgorithms curve25519-sha256`；**大包/多次连接仍会 reset → 分片传（见上线流程第 7 条）**。
8. **别把测试文件留在 `web/`**（会公网可访问）。
9. **切分支前 `git stash -u`**，切回来 `stash pop` 后**重新 `npm run build`**。
10. **清设备/账号**：删注册表记录 ≠ 删数据目录；删目录是真丢数据，先确认目标。**删通道账号**要连插件私有目录一起清（见 §55，接口已补）。
11. **公开仓库纪律**：任何凭据（设备 ID / 密码 / key / token）都不进仓库文件；`data/`、`.env`、`apk-build/`（含 keystore）都在仓库之外。
12. **🔴 路由注册顺序 = 权限**：`ADMIN_ONLY_PREFIXES` 那道网关注册在哪些路由**之前**才生效；Express 按注册顺序匹配，写在网关后面的 `/api/users/*` 会**整个绕过拦截**（09-17 实测：普通设备可把自己提成管理员、读别人聊天记录）。**新增任何 `/api/users`、`/api/plugins`、`/api/logs` 路由前先看网关位置。**
13. **`requestAnimationFrame` 在后台标签页不触发**：凡是"渲染后校正"的逻辑（滚动位置等）别只依赖 rAF，用 `setTimeout` 追帧（§56 实测回调一次都没跑）。
14. **原生弹窗会漏站点地址**：`prompt/confirm/alert` 一律不用（换 `wbConfirm` / `ocInputDialog` / `emojiInfoDialog`）。**注意 `confirm` 是同步的**：换 `await` 时漏一个 `await` 会静默变成"永远确认"（删除类操作不再确认）→ 靠 `node --check`（await 在非 async 函数里是语法错误）+ 自写检查脚本兜底。
15. **`pkill -f "xxx"` 会自匹配**：你的 SSH 命令行里就含这几个字，会把**自己**杀掉（表现：命令毫无输出）→ 写成 `pkill -f "[x]xx"`。
16. **自造夹具卡走不通聊天**：卡片 schema 不完整（缺 `voice.tone_rules` / `chat.tone_rules` 等）时 `/api/chat` 直接 500；要验"模型回复类"功能就用真卡或把字段补齐。
---

## §43 Phase B 地基 + 管理向功能的身份门槛（2026-09-16，已上线服务器）

**背景**：§42 待办里除「打开 App 增量同步」（用户要求先不做）以外的都做了；另按用户要求把运行日志与本地语音兜底收成"只给管理员"。

**① 机器人按设备归属（agentId 设备前缀）**
- `botStore.deviceAgentId(slug)`：设备作用域下 agent 名 = `u<设备ID前8位>-<卡slug>`，管理员/单用户作用域保持裸 slug（存量 `bots.json` 里存的就是 agentId，不动 → 完全兼容）。
- 为什么必须加：`openclaw.json` 的 `agents.list` / `bindings` 与 `split-styles.json` 都是**全局**的，而 agent 的 workspace、`memorySearch.extraPaths` 是按设备目录给的——两台设备各有一张同名卡（slug 都是 grandma）时会是同一个 agentId，后建的顶掉前者（表现为"我的机器人回的是别人的卡"）。
- 换卡接口 `/api/bots/transfer` 原来硬写 `agentId: card.slug`（绕过 addBot），一并改成 `deviceAgentId`。

**② 模型 Key 到设备级（修掉两个真实线上 bug）**
- 原来：`~/.openclaw/openclaw.json` 的 `models.providers` 是全局的，而每台设备的 `providers.json` 是各自的。于是 **(a)** 设备侧 `migrateFromOpenclaw` 会把管理员在 openclaw.json 里的提供商（含明文 Key）**复制给任意用户**；**(b)** 设备保存一次提供商，清理逻辑会把"本设备列表里没有"的条目全删 —— 一保存就把管理员的提供商从配置里清空，并顺手改掉全局默认模型。
- 现在：设备作用域的提供商写成 `u<设备ID前8位>-<原名>`（各自命名空间），清理只删自己前缀下的条目，`agents.defaults.model` 只有管理员作用域能改；迁移逻辑加 `if (currentDeviceId()) return`。设备自己的 `providers.json` 与卡片里存的仍是**原名**，只有写进 openclaw.json 与 agent 的 model 字段才带前缀（`resolveChatLLM` 返回的就是带前缀的网关真名）。

**③ 运行日志 / 模型缓存统计 → 设备不可见**
- `/api/logs`、`/api/logs/clear`、`/api/llm-usage`、`/api/llm/usage` 进 `ADMIN_ONLY_PREFIXES`（设备 403）。原因：logger 的内存缓冲是**进程级共用**的，给用户看等于摊开别人的活动与上游报错。管理员（管理员设备/密码登录/单用户）照旧能看，排障用。

**④ 本地语音兜底（Edge/SAPI）→ 只给管理员**
- 新增 `localTtsAllowed(res)`（= 非托管 或 管理员）。设备侧：`/api/tts/config` 回 `local:null, allowLocal:false`（默认通道若指向 local 则顺延到第一个上游）、`/api/tts/voices` 回空、`/api/tts/test` 与 `/api/tts/synthesize` 拒绝 local（`synthesize/testTts` 新增 `allowLocal` 参数承载这条规则）、删上游时的回落目标从 local 改成第一个上游。
- 理由：托管形态下本地兜底跑在服务器上（SAPI 是 Windows-only，Linux 上根本不可用；Edge 走的是运营者出口与免费额度）。单用户自部署版等于管理员，照旧全开。

**⑤ 前端身份门槛**
- `/api/admin/me` 增加 `hosted` 字段；前端 `ocMode = {hosted, admin}` 缓存进 `localStorage.ocs_mode`（首屏要同步知道显示什么，不能为它多等一次往返），启动时 `loadMode()` 后台校正。
- `ocIsDevice()`（hosted && !admin）时隐藏：抽屉的 通道连接/蒸馏工厂、设置里的 运行日志/插件、首页快捷入口的 蒸馏/通道；路由层直接粘 `#/channels` 会被 `location.replace("#/home")` 弹回。
- **坑**：首屏是在身份未知时渲染的（缓存为空 → 按"全开"画），身份回来后只改抽屉会漏掉首页那些按身份裁剪的按键 → `loadMode` 发现身份变化时补一次 `router()` 重画。实测生产站点首访：抽屉与首页快捷键都正确。

**⑥ 管理端入口（修好一次误删 + 明确"只有服务器才叫管理员"）**
- **误删**：抽屉页脚的「管理」入口是 09-16 13:46（`4b7d5d6` 管理员登录体系）加的；09-16 17:19（`d4d2d37` 提交信息只写"删除抽屉底部文案"）**把整个 `.drawer-foot` div 一起替换掉了，入口跟着没了** —— 连带删除，不是有意删的。结果是管理员一度没有任何可见入口（只能手输 `#/users` 或走 `#/login`）。已恢复：页脚只留入口本身（底部那句"数据保存在本机，不上传"仍按用户要求保持删除），`#drawer-admin-foot` 整块显隐，不给普通用户留一条空横线。
- **门槛（用户拍板 09-16）**：`applyAdminLink` 的显示条件是 **`admin && hosted`** —— 托管形态（服务器）+ 管理员才出现。**本地/自部署（无认证 = 单用户模式）一律当普通用户**：那边没有"多租户设备"这个概念，设备管理页永远是空的。三种情形实测：本机单用户 → 无；托管+分发用户 → 无；托管+管理员 → 有。
- `#/login` 登录成功后直接落 `#/users`（密码登录后不用再找入口）。
- **曾经加过又撤掉的**（用户判定没用）：设置页的「设备管理」行、"把本机设为管理员"一键引导 —— 权力上本就没新增（设管理员始终只有管理员能调 `POST /api/users/admin`，设备侧 403），而用户自己那台设备早已是管理员，用不到。**别再加回来。**
- 辨析：服务器与本机跑的是**同一份代码**（prod 分支，tar 传上去，线上 md5 与本机一致），区别只在 `.env` 有没有认证 → 运行时模式不同。所以"看服务器版本"看的就是这份文件，不存在"另一份管理员版"。

**自测与验证**
- `node scripts/test-device-isolation.mjs`（21 项，临时 HOME + 临时 data 目录，**不碰真实 `~/.openclaw`**）：agent 前缀三例、设备看不到管理员 Key、两设备同名提供商各存各的、删自己的不影响别人、解析出的模型名带前缀、数据落位在自己的命名空间。
- HTTP 级：临时托管实例（`PORT=17890` + 临时 HOME/data）跑 `curl` 断言设备 403 / 管理员 200 / 设备 tts 全拒；浏览器实测设备视角与管理员视角两套 UI；开发机单用户实例回归（全开、不变）。

**上线**：web 直接传（免重启）· src 改动 → 服务器 `npm run build && systemctl restart openclaw-shell` + `chown -R root:root`。生产验证：设备 `/api/logs` 403、管理员 200、`/api/admin/me` 回 `hosted:true`。

**踩坑（本次真实发生）**：临时实例脚本里用 MSYS `kill $!` 停自己的 node，把开发机的三件套（17880/18789/17900）一起带走了 —— **以后临时实例一律用 `TaskStop` 或按端口 `taskkill //PID` 停，别用跨 shell 的 `kill $!`**；已用 `scripts/start-stack.ps1` 恢复。另：清理测试设备时按前缀删了 3 条注册表记录（含浏览器测试生成的），确认过这些命名空间里都是 0 文件（只是访问过站点、没产生数据），无用户数据受损。

---

## §44 预设页文案改版 + 世界书提示清理（2026-09-16，已上线；用户版已推 GitHub）
> ⚠️ 本节 ③「预设对用户关门」的**口径已被用户纠正**：只有内置档位组不给用户打开，预设页整体照旧对用户开放（见 ④）；③ 里把通道也一起藏了，已按 §48 对用户开通。

**用户要求**：预设页「破甲改名默认」；普通用户不可打开/编辑（管理员可看）；「档位」改名「通用基础预设」；「新增档位」改名「添加」；删掉档位区的「恢复内置」按键；风格区不动；删掉世界书里那句 AI 生成的三块写作提示；用户版这些一并推 GitHub。

**① 组名改名（三处必须同步，漏一处就白改）**
- `presets.ts` 内置 `BUILTIN_TIERS[0].name`：`破甲（最高）` → `默认`（id 仍是 `break`，卡片里存的档位 id 不受影响）。
- **`data/presets.json` 里存过的 name 会压过内置**（`normalizeGroup` 取存储的 name）→ 本机 `data/presets.json` 与**服务器 `/data/openclaw-shell/data/presets.json`** 都已同步改名（服务器上改前先 `cp presets.json presets.json.bak-20260916` 留底；该文件**不在每日备份范围内**，改它要自己留一份）。
- 注意"默认"只是显示名：那个组的实际内容仍是原来那套（破甲/防神化/防抢话/防跑偏/输出铁律）。

**② 预设页文案与按键**
- 档位区标题：`档位` → `通用基础预设`；该区按键只剩 `＋ 添加`（组内仍是「新增条目」）。
- `恢复内置`（走 `/api/presets/reset`）**只在风格区保留**；档位区不再出现。
- 新增组的 prompt 从「新档位名称：」改成「新预设名称：」（"档位"这个叫法退场）；风格区仍是「新风格名称：」。

**③ 世界书提示删除**：做卡表单里 `<p class="hint" id="cf-book-hint">世界书分三块写：…</p>` 整段删掉（AI 生成、不该给用户看）。全项目只有这一处引用 `cf-book-hint`，无 JS 依赖。

> ⚠️ **注**：本节 ③ 里把「通道连接」也对普通用户藏了 —— 那是错的，用户 09-16 指出通道是核心体验，已按 §48 对用户开通（账号按归属隔离）。

**④ 预设页的权限口径（⚠️ 我第一版做错了，按用户纠正后重做）**
- **正确口径**：普通用户**照旧用预设页** —— 能新增预设组、新增风格组、改风格、给自建组加条目；只有**内置档位组（对外叫「默认」，id `break`，就是破甲那套）**不给他打开与修改。管理员对那个组照旧能打开查看、能编辑。
- 我第一版误解成"整页对用户关门"（抽屉隐藏 + 所有写操作 403），被用户当场纠正："只是不能改动之前的破甲预设，他还是能够新增预设，新增风格还有修改风格的"。
- 前端：`presets` **不在** `OC_DEVICE_HIDDEN_ROUTES` 里（页面照常打开）；`presetGroupLocked(kind, groupId)` = `ocIsDevice() && kind==="tier" && groupId==="break"` → 该组卡加 `.locked` 样式（灰、`cursor:not-allowed`、名字后面带盾牌图标）、点了只弹「这个预设不可编辑」、组内视图也不渲染（兜底）。
- 后端：只拦"针对内置档位组"的写 —— `isBuiltinTierGroup(kind, groupId)`（`presets.ts` 导出）命中 `POST/PUT/DELETE /api/presets/tier/break...` 一律 403；**其余预设写操作全放行**（新增组、改风格、自建组条目）。GET 从来不拦（卡片高级配置的档位/风格下拉要读它）。
- `POST /api/presets/reset`（风格区那个「恢复内置」按钮）对设备**只重置风格**（`resetBuiltinPresets("style")`）——不能让用户点一下就把默认档位一起冲回代码默认。判 id 不判名字，免得以后再改名又要跟着改。
- 实测（临时托管实例 + 生产站点两次）：设备 PUT/POST/DELETE `tier/break*` 全 403；设备新增预设组 201、新增风格组 201、改风格 200、风格加条目 201、改风格条目 200；管理员对 `tier/break` PUT 200；设备 reset 后风格改动回滚、档位不动。

**⑤ 顺手修掉两个预设库真 bug（同一天，两版都已修）**
1. **新增的组每次读取都被丢掉**：`normalize()` 原来只有 `def.tiers.map(...)` —— 以**内置定义**为唯一来源遍历，文件里 id 不在内置里的组（＝用户自建组）每次 `loadPresets()` 都被过滤掉。表现：点「新增」时内存里 push 进去、界面看着创建成功，**刷新就没了**（生产站点上实测复现，留下的自建组还在文件里但读不出来）。→ 改为「内置组归一化 + 自定义组接在后面」。**副作用（好的）**：以前建过、被悄悄吞掉的自建组会重新出现（数据一直都在文件里）。
2. **「恢复内置」从来不生效**：`resetBuiltinPresets` 原来是 `normalizeGroup({ ...g, builtin: true }, b)`，而 normalizeGroup 的规则是"文件里已有的同 id 条目原样收下、只用内置补缺失 id" —— 等于把存的东西原样传回去，**从不重置任何文本**（组名也不重置），只补缺失条目。与按钮文案「内置条目的文本会重置为代码默认」不符（就是 §09-11 记的那个坑换了入口）。→ 改为以内置定义为底重建，自定义条目接回去。
3. 两处都用 `scripts/` 外的临时脚本验过（store 层：自建组建→读→改名→加条目→删全通过；HTTP 层：公网建-删自检）。

**⑥ GitHub 推送（用户版）**
- 用户版含 ①②③ + ⑤（两个 bug 修复同样影响用户版），**不含 ④**（"设备身份"这个概念只存在于托管形态）。
- 做法：`git stash push -u`（prod 有一堆未提交改动）→ `git checkout main` → 同法施加 → `npm run build` 验证 → 提交并 `push origin main` → `git checkout prod` → `git stash pop` → **再 `npm run build` 把 dist 还原成 prod 的**（在 main 上构建会把 dist 写成用户版，本机开发实例会跟着变）。
- **`main` 现在 = `df64eee`**（`f3dc374` = 文案改版那批，`df64eee` = 两个 bug 修复）。
- 踩坑：检出 main 后文件是 **CRLF**，用 `\n` 精确匹配的字符串替换会失败（本次世界书那段就没删掉）→ 用 `\r?\n` 宽容的正则，或改完立刻核对（`git diff` 逐条看）。

**⑦ 现状**：prod 侧改动仍未提交（等用户点头）；服务器已 build+restart 并验证；**开发机 17880 跑的还是启动时的旧 dist**（要看新后端行为需 `powershell -File scripts/start-stack.ps1` 重启一次）。

---

## §45 设备管理页 v2 + 「看管理员设备」读全局空间（2026-09-16，已上线；用户版不含）

**用户提的问题与要求（原话要点）**：设备只显示 8 位不好找（"别人出了问题找我要聊天记录我怎么找"）；加个搜索框；删掉我测试的设备（"15 台应该只有三四台是正常跑的"）；不要起名字（"我只看 Id"）；排序=管理员在最上面、其他按时间、新的往下面加、注册时间精确到分钟；自己这台不能「取消管理员」（"我自己取消自己不就废了吗"）；"我电脑里明明有角色卡，为啥设备管理里打开我的看不见聊天记录"；最后把除第一个管理员外的号都删掉，他要试"删掉后同一浏览器再进来会不会刷新 Id"。

**① 显示与查找**
- 每行**完整 32 位 ID**（等宽字体、可选中；**点一下即复制**，方便拿着 ID 去对"哪台是谁"）。
- 顶部搜索框（输前几位即可）+ 计数「共 N 台 · 显示 M」（本地过滤，不再打接口）。搜索行在 `#u-list` 之外，重画列表不会丢输入焦点。
- **去掉了 `dev.label` 的展示**：注册表里有 `label` 字段但**没有任何接口能写**（用户也明确说不要起名），原来 `label || "设备 "+id.slice(0,8)` 的兜底正是"只显示 8 位"的由来。

**② 排序与时间**：管理员设备置顶（多于一台时按注册时间），其余按 `createdAt` **从早到晚**（新设备自然加在列表下面）；注册/最近时间都显示到**分钟**（`2026-09-16 19:16`）。

**③ 自己这台不给「取消管理员」**：`isMe && dev.admin` 时该按钮不渲染（点掉就进不了管理端了）。别人的行照旧能取消。注意：本机是"管理员身份"但没被标 admin 设备（走密码登录）时，仍显示「设为管理员」。

**④ 「查看管理员设备」要读全局空间（修掉用户实测的真问题）**
- 现象：管理员在设备管理里点自己那台的「查看」，卡列表/聊天记录永远是空的。
- 根因：**管理员设备从不往自己的命名空间写**（管理员请求一律走全局 `data/`），实测 `data/users/3a012510.../` 里只有一个空 `cards/`，而全局有 5 张卡、9 个会话文件、26 个记忆文件。旧的 `GET /api/users/:id/cards` 一律按 `runAsUser(该设备)` 读，对管理员设备必然读到空目录。
- 修法：端点按 `isDeviceAdmin(id)` 分支 —— **管理员设备读全局**（＝它平时看到的那份），普通设备照旧读自己的命名空间；响应带 `admin` 标记，前端在卡列表页顶加一句"管理员设备：显示的是全局空间的卡"。实测：管理员设备看到 `global-card`、普通设备只看得到自己的卡、两者不串。

**⑤ 设备清理**：按用户要求，注册表只留第一个管理员 `<管理员设备ID：见服务器 registry.json / 本机记忆，不写进仓库>`，其余 14 台（含我测试用的 `aaaa…`/`0000…`/`f1d655a9…` 等）从注册表移除；改前备份 `registry.json.bak-20260916b`。**命名空间目录（`data/users/<id>/`）没动**——删注册表只是让它从列表消失，浏览器再访问会以**同一个 ID** 重新注册，数据也在；要连数据一起清必须另删目录（用户没要求，留着他发话）。

**⑥ 关键事实回答：删掉设备后，同一浏览器再进来 ID 不会变**
- ID 是**浏览器侧**生成的（`web/app.js` 的 `OC_DEVICE`：读 localStorage，没有/非法才新生成 32 位 hex，同时写 cookie），服务端只是拿它当命名空间名。删注册表记录不碰浏览器 → 同一个浏览器下次访问会被 `ensureDevice` **以同一 ID 重新登记**（`createdAt` 变成这次的时间）。
- 今天实测两次：`f1d655a9…`（我做测试的浏览器）被我删过，之后访问又原样出现；本次清理前它在列表里就是这个原因。
- 想让某台"变成新设备"：清该站点的 localStorage + cookie（或换浏览器/无痕窗口）→ 才会生成新 ID。**换 origin 也会**（`127.0.0.1` 与域名、域名与 IP 各自一套存储）——本机开发时容易踩：同一浏览器开 17880 和开生产站是两台"设备"。

**⑦ 新增样式**：`web/style.css` 里 `.u-search-row / .u-count / .u-dev-main / .u-dev-id / .u-dev-meta`（两行式设备块：ID 一行、时间一行）。

**⑧ 验证**：临时托管实例上跑全流程（注册 2 台设备并标一台为管理员 → 全局建卡 + 设备建卡 → 两个「查看」结果互不串）；浏览器里登录管理端实测完整 ID/搜索过滤/计数/排序/时间到分钟/本机无「取消管理员」/别的管理员行仍可取消；生产站点复核设备数=1 且管理员设备的卡列表返回 5 张卡。


---

## §46 重描写括号约定对换（2026-09-16，已上线；**用户版已推 GitHub**，`main` = 7ae26c8）

**用户要求**：原来的约定是「小括号（）包裹心理、大括号 {} 包裹动作」，现在**对换**。

**新约定**：**{} 花括号 = 心里想的**（别人看不见的念头/情绪/判断）；**（）全角圆括号 = 身体做的**（能被摄像头拍到的动作）。判断方法那句跟着换成「能拍下来的进（），只在脑子里的进{}」。

**改到的四处（缺一处就新旧混用）**
1. `src/core/presets.ts` rich 组：`rich-rule`（文风规则全文 + 示例 + ❌✅ 反例）与 `rich-example-ai`（示范对话）——示例里的括号一并换。
2. `src/core/compiler.ts` 两处说明：`心理用 {} 包裹、动作神态用（）包裹`（第 296 行与第 465 行，编译进 agent 产物/SKILL.md）。
3. 本机 `data/presets.json`。
4. **服务器 `data/presets.json`**（存储内容压过代码内置，见 09-11 那个坑；改前备份 `presets.json.bak-bracket-swap`）。

**换的时候踩到的两个坑（下次注意）**
- **`{split_min}` / `{split_max}` 是模板变量**：机械对换花括号会一起把它们变成圆括号 → 必须先保护哨兵再换（本次脚本第一版就漏了还原，靠通读一遍内容才发现）。
- **说明性括号不能跟着换**：标题里的「（动作 + 心理）」、「（默认 1~7）」、「（每条 = 一个气泡）」、「（.）」、「（起到停顿、留白的效果）」、「（属于对白）」都改成了直角引号「」；而 **「（）全角圆括号 = …」「{} 花括号 = …」这两行是符号定义本身**，机械对换会把圆括号/花括号的名字标错，必须手写正确。

**同步工具（新增）**：`scripts/sync-preset-text.mjs` —— 从 `src/core/presets.ts` 抽内置文本写进指定的 presets.json（默认只同步 rich-rule + rich-example-ai，其余条目一律不碰），本机与服务器都跑一次：
```
node scripts/sync-preset-text.mjs --file data/presets.json
```

**让改动真正生效**
- **网页聊天**：实时读 store（预设改动即刻生效，无需重编译）。
- **QQ/微信**：读的是**编译产物**（agent workspace 里的 SKILL.md/AGENT.md）→ 必须重编译。⚠️ 服务器 `bots.json` 是**空的**（09-16 迁移没带这个文件），所以"存卡自动重编译"那条链（`syncCardToChannel` 里有 `if (!bot) return`）不会触发 → 用 `POST /api/cards/<slug>/compile` 逐张编译（本次 5 张卡全 200；产物校验：含新约定 8 个文件、含旧约定 0 个）。
- 5 张卡里 3 张是重描写（anxia/persona-mt9xijkd/persona-mtusl05c）、2 张纯对话（chiyingqiu/shenqingwu，纯对话禁括号、本次不受影响）。

**顺带确认的事实**：卡里没有写死这个约定（只有 shenqingwu 的 world book 里有一句"动作神态：她生气时会抱住手臂…"的人物描写，与符号约定无关）；`scripts/sample-check.ts` 里的样本只是拆条测试数据（括号在 splitter 里只当"深度"用，两种括号等价），故未改。

---

## §47 SoulBox 安卓套壳 APK（2026-09-16，v2 已构建待真机验收）

**形态**：**纯套壳**——壳里不放业务，只 `loadUrl(https://soulbox.319274.xyz/)`。网页改完部署即生效，**壳不用跟着重打**（本次就是例子：壳 v2 打完后网页又改了导出编码，只传网页就够了）。服务器连不上时回退到内置的一句话提示页（assets/index.html）。

**工程位置**：`D:\ai_workspace\apk-build\soulbox\`

| 文件 | 说明 |
|---|---|
| `AndroidManifest.xml` | 包名 `com.soulbox.app`、应用名 SoulBox、minSdk 24 / targetSdk 35、只申请 INTERNET 权限 |
| `src/com/soulbox/app/MainActivity.java` | 壳本体（参考 RP-Hub 的 `apk-build/src/com/operit/rphubweb/MainActivity.java` 改） |
| `res/` | 图标（用户给的 SoulBox 书法图 1920×1920 → 5 档 mipmap）+ AppTheme |
| `assets/index.html` | 连不上服务器时的兜底提示页 |
| `build-soulbox.sh` | 六步构建：keystore → aapt2 compile+link → javac → d8 → 组装 → zipalign+签名 |
| `soulbox.keystore` + `keystore-info.txt` | **签名密钥必须长期保留**（丢了没法覆盖升级，只能卸载重装、设备身份会换） |
| `native-stub-test.html` | 网页侧原生分支的浏览器测试页（把 `window.SoulBoxNative` 换成打桩实现） |

**构建**：`cd /d/ai_workspace/apk-build/soulbox && bash build-soulbox.sh <版本号>` → `SoulBox-v<版本>.apk`。工具全在本机（不需要 Android Studio）：`/d/Android/Sdk/build-tools/36.1.0` + `android-36` + `/d/Java`。

**壳给网页的原生能力**（`window.SoulBoxNative`；网页里没有它就自动走浏览器老路）：

| 方法 | 作用 |
|---|---|
| `saveFile(name, mime, base64)` | 每个文件弹一次系统「保存到」对话框（照搬 RP-Hub 那套，已验证可用） |
| `pickFolder()` / `getFolderName()` / `clearFolder()` | 选一次文件夹 + **持久化授权**（SAF `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission`，存在壳的 SharedPreferences） |
| `saveToFolder(subdir, name, mime, base64)` | 往已选文件夹**静默写入**，按卡名建子目录，重名自动 `(2)(3)` 不覆盖 → 批量保存不再一个个弹框 |
| `copyText(text)` / `toast(msg)` / `getInfo()` | 剪贴板 / 原生提示 / 排障信息（WebView 版本等） |
| （壳侧另做） | 状态栏避让、返回键接管、文件选择器（导入/上传）、下载转发、DOM storage + IndexedDB、免手势音频播放、`<a download>` 兜底拦截（onPageFinished 注入脚本） |

**网页侧对应的分支**（`web/app.js`，全部写成"有桥就用、没桥走老路"，浏览器与 GitHub 用户版行为不变）：
- 顶部探测 `const ocNative = window.SoulBoxNative || null` + `ocHasNative(m)`；`window.soulboxOnFolderPicked` 回调（壳里选完目录会 evaluateJavascript 调它刷新界面）。
- `downloadDataUrl`：**两种 dataUrl 都要处理** —— base64 的（图片/音频）与 **URI 编码的**（备份 JSON 是 `data:application/json;charset=utf-8,%7B…`）。第一版只认 base64，实测"下载备份"在套壳里会静默失败 → 补了 `ocDataUrlToBase64`（URI 编码那条按 UTF-8 转字节，否则中文卡片名乱码）。
- `ocDownloadBlob`（没有文件夹时的兜底）→ 走 `saveFile`；它改成了 async，调用处已 await。
- `ocDirSupported` 加上 `|| ocHasNative("pickFolder")`；`ocPickSaveDir` 走原生；`ocWriteToFolder` 走 `saveToFolder`（子目录=卡名）；`ocFillDirName` 从壳取名字。
- **壳里不回读、不删用户文件**：`ocReadSavedFile` 直接返回 null（SAF 按名字回读不划算）→ 显示链退到"提示词卡片"；`ocRemoveSavedFile` 空操作（要删去文件管理器）。

**踩过的坑**
1. javac 报 `MIME_DIR` 未定义 —— 加了用法忘了常量声明。
2. 浏览器测网页分支时，手工测试页抄了 index.html 里的 `app.js?v=19`，被 **immutable 缓存**命中旧文件，测了半天是旧代码（§28 同款陷阱）→ 测试页必须用 `?nc=<时间戳>`；而且 hash 导航不会重新加载文档，**改完要 reload**。
3. 测试页别留在 `web/` 里一起传到服务器（已移出，另存到 shell 目录）。

**安装与升级**
- 直接装 `SoulBox-v2.apk`（需允许未知来源）。**务必覆盖安装**（同一签名）→ WebView 数据保留、设备 ID 不变。
- 卸载重装 = 新的设备 ID（服务器上算另一台设备）→ 用「设置 → 我的设备 ID → 用旧 ID 恢复」找回。
- 壳自身更新没做（用户要求先不做）：以后只有改桥才需要重打 + 覆盖安装。

**待真机验收**（我这边替代不了）：打开能进首页 → 杀进程重开设备 ID 不变、管理端能看到它 → 聊天/生图/表情/语音 → 导出角色卡与下载备份能弹「保存到」并选任意文件夹 → 存储页选一次文件夹后批量保存不再弹框（文件出现在 手机/<所选文件夹>/<卡名>/）→ 导入卡/上传头像能选文件 → 覆盖安装后数据还在。

---

## §48 通道对用户开通（账号归属隔离）+ 生图/TTS 五项清理（2026-09-16，已上线）

### 起因
用户看到手机（APK = 普通用户）侧键里**没有「通道连接」**，指出"用户最核心的体验就没了"。这是我在 §43 做身份门槛时把 `channels/distill/plugins/logs` 对普通用户一起藏了（当时后端对这些端点一律 403）。用户这句话把悬着的产品决定定了：**通道必须给用户**。于是把当时欠的"绑定隔离"补上。

### 做法（关键是**账号归属**，不是整块 403）
- **`ADMIN_ONLY_PREFIXES` 去掉 `/api/bots` 与 `/api/channels`** —— 设备能进通道页、能扫码、能绑自己的机器人。`/api/distill /api/plugins /api/logs /api/llm/*` 等仍对设备 403。
- **新增 `src/core/channelOwners.ts`**：全局归属表 `data/channel-owners.json`（**不在**任何设备命名空间里）
  - `owners`：`"channel:accountId" → deviceId`；**没有记录 = 运营者的老账号**（保守优先：设备看不见也动不了）
  - `claims`：扫码待领取快照 —— 设备点扫码时先记下"当前该通道已有哪些账号"，之后**不在快照里的新账号**才算它扫的，所以绝不会把运营者的老账号误判成用户新扫的（微信的真实 id 是登录成功后才下发的，只能这么兜）
- **`scanKnownAccounts()` 拆两层**：`scanAllAccounts()`（全局原样）+ 带过滤的 `scanKnownAccounts()`（设备只看自己的，并顺手消费待领取）。**全项目读账号都走后者**，一处改全局生效。
- 三个助手：`filterChannelStatus()`（通道状态接口里的账号列表按归属过滤，缓存是全服共用的所以只在返回前过滤）、`requireOwnedAccount()`（设备不拥有就 403）、`beginClaimForDevice()`（扫码起点快照）。
- 守卫落点：`accounts/label`、`accounts/delete`（删完 `clearAccountOwner`）、`bots/:id/bind`、`bots` 创建（**自己的 or 全新占位名**才允许，否则 403）、`bots/:id/login`（认领自己的账号 + 记快照）、`channels/*/login`（记快照）、`login/cancel`（收快照）、微信 `pairing*`（运营者 ClawBot 的事，对设备隐藏/拒绝）。
- `reconcileBotAccount` 里补 `moveAccountOwner`：占位名（`wx-main`）换成网关下发的真实 id 时归属要跟着搬，否则那个账号会变成"无主的运营者账号"、用户自己反而看不见。
- 前端：`OC_DEVICE_HIDDEN_ROUTES` 去掉 `channels`（保留 distill/plugins/logs）；首页快捷键恢复「通道」（蒸馏仍不对用户显示）。

### 实测（临时托管实例，两设备 + 管理员 + 网关里预置 2 个管理员 QQ + 1 个管理员微信账号）
设备A/B 看不到运营者的任何账号 ✓ · 设备A 用全新占位名建 bot 通过归属检查 ✓ · 设备A 拿管理员账号建 bot → 403 ✓ · 设备A 删/改管理员账号 → 403 ✓ · 设备A 改自己账号 → 200 ✓ · 设备A 列表里只看到自己那个（槽位也按自己的算 1/5）✓ · 设备B 看不到 A 的 ✓ · 管理员照旧看到全部（含设备的）✓ · 删自己的账号后归属被清 ✓。生产复核：管理员看到 4 个账号（qq-<运营者号1>/qq-<运营者号2>/两个 im-bot），设备看到 0 个，设备 `/api/bots` 与 `/api/channels/connections` 均 200、`/api/logs` 仍 403；生产站点以普通用户身份打开通道页正常、无 403 文案、显示"还没有绑定账号"。

**没验到的**：真实扫码（本机没有网关可用）—— 待真机扫一次；设备端"配对授权"区块对设备是空数据（设计如此）。

### 用户点名的五项清理（同一批上线）
1. **TTS 用量统计删掉**：`#/tts` 页那块「用量统计」整块移除（含 `loadTtsUsage`）。后端记账**保留**（`tts-usage.jsonl` 是售卖服务的计费依据，删了就丢账）。
2. **三个画师串做成内置默认**：`经典可爱基底`（ciloranko 主导）/`偶像梦幻感`（yoneyama_mai）/`清透水彩感`（tianliang_duohe_fangdongye），原文取自 09-15 交付那三条（`builtin: true` → 前端不可编辑不可删）。**顺带修一个真 bug**：全新安装/新设备没有 `imageConfig.json` 时，`getImageConfig()` 走 catch 直接返回 DEFAULTS → 画师串列表**是空的**（"默认画师串没放上去"的观感来源之一，现已改为兜底也带内置串）。
3. **生图模型不再有默认值**：`novelai.model` / `openai.model` 默认清空（`NAI_GATEWAY_DEFAULT_MODEL`、`OAI_DEFAULT_MODEL` 两个常量删除），生成时若没选模型直接报"还没选生图模型：到「生图配置」点一次「拉取模型」，选好再试"。**服务器上已存的旧默认值也清了**（`imageConfig.json` 备份为 `imageConfig.json.bak-modelclear`）→ 以后必须先点「拉取模型」再选。
4. **OpenAI 那句提示删除**：`生图模型（中转站一般不单独放生图模型，从 /models 拉取后选择）` → 只留 `生图模型`。
5. **API 页 Soul API 去掉「官方」小标签**：`paintProvList()` 里那个 `chip ok 官方` 删掉；**置顶行为不变**（`ensureOfficialFirst` 仍把它固定在第一位）。

### 部署
`src + web` 一起传 → 服务器 `npm run build && systemctl restart openclaw-shell` → `chown -R root:root`。线上校验：生图配置返回 6 个画师串（3 旧 + 3 新）、两个模型字段都是空串；设备侧 200/0 账号；管理员侧 4 账号；站点 200。

---

## §49 蒸馏对用户开放 + 删掉「直连本机 WeFlow」（2026-09-16，已上线）

**用户要求**：① 蒸馏也给用户；② 蒸馏页下面那个「直连 WeFlow（本机 5031）」**服务器版和本机版都不要**（"用了还占我自己的服务器"）；③ 本机当服务器的那份要**跟用户用到的版本一模一样**，方便后面测试；④ GitHub 上不用为此单独删（共用代码，随下次推送自然带上）。

**为什么必须去掉「直连本机」**：那条链路是服务器去 `fetch http://127.0.0.1:5031` —— 在部署形态下 127.0.0.1 指的是**跑服务那台机器**（运营者的服务器），等于让用户点一下去连运营者自己的 WeFlow；本机单用户版同理，连的是运营者自己的桌面服务。两版都删干净。

**改动**
- 后端删掉 `/api/weflow/probe` 与 `/api/distill/weflow` 两个端点（含 `WEFLOW_BASE` 常量），确认全项目再无 weflow 引用。
- 前端删掉蒸馏页的「直连 WeFlow」整块 UI（token/talker/limit 输入 + 探测/导入按钮 + 输出框）与 `probeWeFlow` / `distillFromWeFlow` 两个处理函数及其绑定。
- `/api/distill` 从 `ADMIN_ONLY_PREFIXES` 移除 → 用户也能蒸馏。**隔离天然成立**：蒸馏读的是上传的文件/粘贴的文本（不再有本机直连这条路），写出的卡走 `cardStore`（设备命名空间），用的模型走该设备自己的 API 配置（`resolveChatLLM`）——没有任何全局侧写。
- 前端 `OC_DEVICE_HIDDEN_ROUTES` 去掉 `distill`（`plugins`/`logs` 仍对用户隐藏）；首页快捷键恢复「蒸馏」。

**验证（生产）**：设备 `POST /api/distill` → 400（不再是 403）、`POST /api/weflow/probe` → 404、`POST /api/distill/weflow` → 404；管理员 `POST /api/distill` → 400；设备 `/api/logs`、`/api/plugins/installed` 仍 403。生产站点以普通用户身份：抽屉含 `distill`、首页六个快捷键齐全（做卡/卡库/蒸馏/通道/语音/生图）、蒸馏页只有「上传 WeFlow JSON / 粘贴文本 → 开始蒸馏」，**页面上再无任何 WeFlow 直连字样**。

**现状**：用户侧现在能用 = 做卡 / 卡库 / 预设（内置「默认」组除外）/ 蒸馏 / 通道扫码绑自己的机器人 / API 与模型 / 生图 / 语音 / 表情 / 存储 / 设备 ID；不可见 = 插件、运行日志、模型缓存统计（进程级共用，只给运营者）。

---

## §50 表情包 zip 批量导入 + 打包脚本（2026-09-16，**已上线**）

**用户定的方案**（用户先提"图片 + TXT 两文件"，我建议用文件名配对、用户改成**序号配对**，最终取用户方案）：
- 图片文件名 = `1.名字.gif`、`2.名字.gif`（**序号 + 名字**，名字取序号后面那段）
- `说明.txt` 只写使用场景，**按序号对应**：`1.气氛轻松时用` / `2.`（留空＝没场景）
- 序号配对天然顺序无关（不依赖 zip 时间戳，重压缩/传输不会错配），也不会因为图名重复而串行

**最省事的用法**：图片丢进文件夹 → `scripts/make-emoji-pack.bat`（拖文件夹到它上面或双击）→ 自动按**修改时间从早到晚**编号、打成一个 zip，并塞进一份待填写的「说明.txt」（UTF-8 带 BOM，记事本直接改）。

### 新增文件
| 文件 | 作用 |
|---|---|
| `scripts/make-emoji-pack.ps1` + `.bat` | 打包器（PowerShell + .NET 压缩，零依赖；**.ps1 必须带 UTF-8 BOM**，否则 PS5.1 按 GBK 读中文乱码 —— 老坑） |
| `src/core/emojiPack.ts` | zip 解析（纯函数、可单测）：条目名解码、说明解析、序号/名字/顺序三路配对、问题报告 |
| `POST /api/emojis/import-zip` | 导入端点（`?dryRun=1` 出预览不落库；raw body ≤60MB） |

### 解析容错（用户手攒的包什么样都有）
- 序号前缀认 `1.` `1、` `1)` `1_` `1-` `01 ` 等多种写法；**没有序号的就按名字配**（`大笑.gif` ↔ `大笑 场景`）
- 说明文件**两种模式自动判**：多数行以数字开头 → 序号模式（只当场景）；否则名字模式（`名字 场景`）
- 三路配对优先级：序号 → 名字 → **按 zip 内顺序兜底**（剩下的图和剩下的行配对）
- **编码**：条目名与 TXT 内容都先按 UTF-8 严格解，失败回退 GBK（Windows 压缩包常见）
- 子文件夹 = 分组（不存在自动建）；`#` 开头是注释；macOS 垃圾条目（`__MACOSX/`、`.DS_Store`）自动跳过
- 单张 >5MB、非 png/jpg/jpeg/gif/webp、空文件 → 跳过并报告

### 重复与上限（用户明确要求"项目那边得自动学会避免重复"）
- **重名自动加序号**（大笑 → 大笑2 → 大笑3），库里的和本次已排入的都避让，**绝不静默丢图**，报告里写明「原「大笑」改叫「大笑2」」
- 库满 300 就停下并报告还剩多少没进
- 批量导入跳过"每加一个就全量同步通道目录"，**最后统一同步一次**（`addEmoji({skipChannelSync:true})` + 收尾 `syncEmojisToChannelMedia()`）

### 前端
> ⚠️ 本节的 UI 描述**已被 §52 改版取代**（两个入口合成一个「添加表情」按钮、去掉整段说明文字、原生 `confirm/alert` 换成页内弹窗）。后端解析逻辑（序号/名字/编码/分组/重名）没变。

表情包库页 →「导入表情包 zip」按钮 + 隐藏 file input：**先 dryRun 预览 → `confirm()` 列出「将导入 N 个 / 新建分组 / 重名改名 M 个 / 跳过 K 项」与前 12 个名字 → 确认后才真导入** → 结果用 `alert()` 列问题 → 刷新表情库。

### 实测（临时实例，全链路真跑）
打包脚本产出的真 zip：预览 3 个 → 导入 3 个 → **再导一次自动变 `大笑2/偷笑2/瞪眼2`** 并在报告里注明；手工造"填好场景 + 子文件夹"的包：场景按序号正确落到对应图、子文件夹「开心」自动建组、`瞪眼3` 落在开心组；GBK 内容的 TXT 回退解码正确（`B4F3 D0A6` → 大笑）。

### 部署状态（已上线）
本机 tsc/build 全绿 → 上传 → 服务器 build + restart 全通过；生产用**打包脚本产出的真 zip** 跑 dryRun：解析出 3 个（大笑/偷笑/瞪眼）、确认没落库；表情页的「导入表情包 zip」按钮与前缀说明都在。

**⚠️ 本次踩到的真坑（跨境 SSH 反复 Connection reset 的真因）**：不是被 fail2ban 封，也不是服务器挂了（站点一直 200）——是**握手阶段**被中途 reset：OpenSSH 9.6 默认启用后量子 KEX `sntrup761x25519-sha512`，握手包大，跨境线路上会被丢。**解法：固定小 KEX** —— `ssh -o KexAlgorithms=curve25519-sha256 sb` 立刻通；已写进 `~/.ssh/config` 的 `Host sb`（`KexAlgorithms curve25519-sha256`，原文件备份 `config.bak-kex`），**现在裸 `ssh sb` 就能连**。
**另一个教训**：大包上传中途断开时，`tar -xzf -` 流式解包可能只写了一半（而 `web/app.js` 是线上直接提供的文件！）——本次是**先查线上 md5 + `node --check`** 确认没被写坏，之后改成"上传完先 md5 校验两端一致，再 build/restart"。以后再传大包都照这个顺序。

---

## §51 通道消息复刻到 App（App 关着也复刻 + 本地永久副本）—— 2026-09-17，**已上线服务器**

**用户原话**：「加强微信QQ消息复刻到APP上，不能因为APP没开，所以以后都不复刻了」。
背景：用户平时在 QQ/微信里跟机器人聊，App 经常是关着的。

### 修之前的三个真问题（都读代码确认过，不是猜的）
1. **观察器只在「网页停在那张卡上」时才跑**：`startMirrorObserver` 是**无作用域的启动期定时器** → `listBots()` 读的是运营者的全局 `data/bots.json`，只扫运营者自己的卡；用户设备那边的通道消息，只有前端 `wbMirrorSync`（3 秒轮询 `/mirror/sync`）在补 —— **App 关着 = 一段都没进过记录**。
2. **游标按「会话文件 + 消息 id」定位**，而 OpenClaw 重置会话是把老文件改名成 `<sessionId>.jsonl.reset.<时间>`（服务器上实测有这种文件）→ 重置那一刻游标指向的文件没了，重置前没同步的那段**永久丢失**。
3. **App 侧没有本地副本**：网页每次从服务器读 `conversations/*.jsonl`，而服务器按保留策略只留 15 天 → 用户看到的「完整历史」其实是被裁过的。

### 改了什么
**① 服务端按设备扫描（App 关不关都复刻）—— `src/server.ts`**
- `sweepMirrors()`：先扫运营者全局卡（原逻辑），再**遍历注册表里每台设备、进各自 ALS 作用域**扫它自己的卡（`runAsUser`）。每 5 秒一轮，`mirrorSweeping` 防重入。
- 保留期外没露过面的设备跳过（`lastSeen` 早于 15 天）：它的记录本来就要被保留策略清掉，不必花 IO。
- **同卡去重锁** `observeCardLocked`（键带设备前缀）：定时扫描与前端轮询会同时观察同一张卡，撞车有重复导入风险。
- **游标后置提交**：`pollSessionTurns` 只读不写游标，`observeCard` 把消息真正 `appendConv` 成功后才 `commitObserveCursor` 推进 → 中途失败只会下一轮重读（按来源 id 去重丢掉），**宁可重复读，绝不漏**。

**② 观察器抗会话重置 —— `src/core/sessionMirror.ts`（核心改动）**
- 游标从「sessionId → 最后一条消息 id」换成 **时间水位 `lastTs` + 已知会话 id 列表 `known`**（`{ lastTs, known: [...] }`）。时间不受会话重置影响。
- `readSessionTurns` 现在一并读**该会话的 reset 归档**（`<sessionId>.jsonl` + `<sessionId>.jsonl.reset*`），并跳过「mtime 比水位老 60s 以上」的归档，避免每轮重读旧归档。
- 没写 `timestamp` 的行沿用同文件上一行的时间（保证有序可比）；**没有 id 的行合成稳定 id**（否则每轮都当新消息重复导入）。
- 水位比较用 `>=`（同毫秒的多条宁可重复读，靠去重挡），单轮最多补 400 条（老账号首次同步分批，水位只推进到已返回的位置）。
- 游标里读到老格式（有 `sessions` 没 `lastTs`）→ 走一次全量重扫，重复的由导入去重挡掉，**不会重复入库**。

**③ 增量拉取端点 `POST /api/sync/pull`（设备作用域）—— `src/server.ts`**
- 先对本命名空间所有绑卡补一次观察，再返回游标之后的新条目（**所有卡**，不只当前打开那张）。
- 按 `conversations/*.jsonl` 枚举而不是按卡片列表（卡被删/改名时日志还在；自测里就踩到「卡片不存在 → 一条都拉不到」）。
- 返回 `cursor` / `more` / `retentionDays` / **`horizon`**（保留期起点，前端用它判断老消息该保留还是不复活）；单页 800 条，`more=true` 时前端接着拉。

**④ App 本地永久副本 —— `web/app.js`**
- IndexedDB `ocs-media` **升到 v2**，新增 `messages` 库（按 `slug|条目id` 去重）。
- 启动即 `ocStartSyncLoop()`：打开就拉一次 + 回前台/重新聚焦再拉 + 页面开着时每 60 秒一次（都是增量，没新消息就是空响应）。
- `wbReloadHistoryInner`：先拉增量 → 服务器记录入本地 → **渲染用「服务器 + 本地」合并结果**（过了保留期的老消息从本地取，用户看到的是完整历史）；而**发给模型的上下文仍只用服务器那份**（别把 15 天前的老记录喂给模型白涨 token）。
- 合并规则里的坑：本地条目**在保留期内、服务器却不在** = 用户删过 → 不复活（另有删除墓碑，`wbRemoveRowsByIds` 删消息时同步删本地并记墓碑）；「一键删除」走 `ocMsgClearSlug`。「一键删除」清空时本地副本也清。

### 验证（都是真跑，不是看代码）
- **新增自测 `scripts/test-channel-replay.mjs`（15 项全绿，已进仓库）**：伪造 OpenClaw 会话文件起临时实例，验 ① 设备一次请求都不发（= App 没开）时记录照样进该设备命名空间，且**运营者全局空间不被污染**；② 会话重置（老文件改名成归档 + 新会话）后，重置前没同步的那段从归档补回、**整段顺序完全正确无重复**；③ `/api/sync/pull` 增量、游标推进、第二次不重复给；④ 跨设备不串。端口被占用会直接报错退出（防「请求打到别的实例上」造成假失败）。
- **隔离回归** `scripts/test-device-isolation.mjs` 21/21 仍全绿。
- **浏览器端到端**（临时实例 + 真浏览器）：App 打开 → IDB 落到 6 条（含"App 关着时通道里新聊的"两条）→ 通讯录预览与聊天页 6 个气泡顺序正确。
- **线上**：上传 → 两端 md5 一致 → `npm run build` + restart → 接口 200、`/api/sync/pull` 返回真实数据、站点 200。旧文件备份在服务器 `/data/backups/pre-sync-20260917/`。

### 性能（用户专门问过，实测数字）
空闲卡每轮：**1.22ms（有门）vs 7.1ms（无门重解析会话）**；会话文件 839KB / 4000 条、索引 50 条会话的基准下测的。
按 **10 台设备 × 每台 3 个绑定机器人 = 30 张卡、每 5 秒一轮**算：**≈0.73% 单核**（无门是 4%）。
省下来的关键在 `sessionMirror.ts` 的**空闲门**（`observedState`）：当前会话文件自上次观察后没被写过（`mtime < 上次观察时刻`，避免同毫秒误判）且会话 id 没变 → 直接返回，只花一次 `stat`；会话 id 变了（重置）一定不跳过。另外 `mirrorTargetOf` 顺手把查到的 session 传给 `pollSessionTurns`，省掉一次 `sessions.json` 重读。有门也不会漏消息：追加必然改 mtime → 下一轮必读。

### 语义边界（别混淆，用户特意问过）
- 这条管的是「**用户看**的记录」——服务器只留 15 天，**用户自己的完整历史留在用户自己设备上**（App 本地永久）。
- AI 的「**记性**」是另一条线：服务器上的记忆（永久）+ 窗口期会话，跟 App 开不开无关；用户 15 天没聊直接在 QQ 发消息，机器人照样凭记忆接得上。
- 超过 15 天**没打开过** App 的用户，那段消息服务器已按策略清掉、本地也没副本 → 拿不回来（与「只保存 15 天」的既有承诺一致）。
- 本地副本按卡存纯文本（单条上限 20KB），**不做自动清理**（用户的"永久记录"就是它）；「一键删除」会把该卡的服务器记录与本地副本一起清掉。存储页目前只统计图片/语音，**没有统计本地聊天条数**，也**没加"清空本地记录"按钮**（那会删掉用户唯一的那份历史，容易误点）。

### 部署
本机 `npx tsc --noEmit` + `npm run build` 全绿 → **跨境 SSH 大包老被 reset，改成分片传**：`split -b 80000` 切成 4 块 → 每块单独传 + md5 校验 → 服务器上 `cat $(ls | sort) > server.ts` → 整体 md5 一致才 `mv` 就位（先 `cp` 备份旧文件）。**这条路子以后再传大文件都照做。**


---

## §52 表情包页改版 + 全站原生弹窗清零（2026-09-17，**已上线**）

**用户原话（第一轮）**：「在表情包导入页面，把压缩包导入和图片导入融合在一起，一个按键就能解决的不要再搞一个，然后是，不要有那么多说明，一整包导入也不需要说。表情包新建分组页面太过潦草，重新设计渲染，**不要露出我的网址**」。
**用户原话（第二轮纠正）**：「你删那么多干什么，现在添加表情包，用户可能会直接忽略写表情包名字还有应用场景，**我只是让你把两个导入按键融合**，原来只能导入图片的也可以导入文件。然后是那些删除的提示啥的，你自己看着搞，确实还漏着网址且特别简陋」。

> ⚠️ **教训**：第一轮我顺手把「表情名 / 什么场合用」两个输入框一起删了（自以为符合"一个按键解决"），被用户明确纠正 —— **用户要的只是"两个导入入口合一、图片入口也能吃 zip"，不是把填写项砍掉**。做界面改动时把用户点名的那一处改到位即可，别顺手扩大范围。

### 一、表情包库页（`web/app.js` + `web/style.css`）
1. **两个导入入口合成一个**：「添加表情」按钮的 `<input type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.zip,application/zip">` 同时吃图片与 zip，选完按扩展名分流 —— 图片走 `/api/emojis/raw`（支持多选批量），zip 走 `importEmojiZipFile()`（后端解析逻辑没动）。
2. **「表情名 / 什么场合用」两个输入框保留**（第二轮恢复）：填了就用于添加的图片（名字留空则退回文件名），加完清空两个框（与原「添加到当前分组」行为一致）；zip 用包内自带的序号名字与 `说明.txt`，两个框对它不生效。
3. **说明文字只留一行**：删掉了原来那段「zip 里放 1.大笑.gif…外加说明.txt…用 scripts/make-emoji-pack.bat 打包」和跨组导入弹窗里的解释句；现在只在添加卡片下留一句 `图片可多选；选 zip 就是整包导入。`
4. **分组管理重做**（原来新建/重命名走原生 `prompt()`、删除走原生 `confirm()` = "潦草"）：分组标签只剩名字+数量，**设置入口「⋯」只出现在当前选中的分组上**（原来每个标签挂两个小图标），点开是自绘弹窗（重命名分组 / 删除分组）；新建与重命名共用一个输入弹窗 `ocInputDialog()`；删除走 `wbConfirm()`。新增 CSS：`.em-list-head` `.em-menu-item` `.em-info-lines` `.emoji-group-tab .g-more`（旧 `.g-del/.g-rename` 规则已删）。
5. 顺手修既存 bug：**切分组时标题与计数不跟着变**（原来只在整页加载时更新）→ 挪进 `renderEmojiList()`。

### 二、不露网址 = 清掉浏览器原生弹窗（本轮真正的根因）
原生 `alert/confirm/prompt` 在移动浏览器与套壳 WebView 里会把**站点地址显示在标题栏/来源行**上 —— 这就是用户看到的"露出网址"。做法：
- **表情页 4 处**：`confirm`→`wbConfirm()`、报错列表→新增 `emojiInfoDialog()`、输入→新增通用 `ocInputDialog()`（**空串是有效值**，取消才返回 null，供"留空 = 恢复原编号"这类语义用）。
- **全站其余 25 处 `confirm()`**（用户第二轮授权"你自己看着搞"）：删卡 / 删记忆 / 删账号 / 换绑 / 清日志 / 清图片语音等，**逐处**换成 `await wbConfirm({...})`。原来那 27 处里有 4 处所在函数不是 async（`cardFormDelHandler` / `wbDelete` / `deleteArtist` / 预设条目删除的 click 回调），一并改成 async。
- **两处 `prompt()`**：通道连接「给账号起昵称」（空串 = 恢复显示原编号，取消 = null，语义保持）、预设页「新建预设名称」→ 都用 `ocInputDialog()`。

### 三、验证（静态 + 浏览器双保险）
- **静态**（`node --check` + 自写检查脚本）：全站 `confirm(` / `prompt(` / `alert(` 计数为 **0**；34 处 `wbConfirm(` **全部**带 `await`/`return`。这两条合起来堵住最大的坑：`confirm()` 是同步返回布尔，换页内弹窗若漏加 `await`，`!promise` 恒为 false → **删除类操作会静默跳过确认**（不报错、极难发现）；而 `await` 出现在非 async 函数里是**语法错误**，`node --check` 会直接拦下。
- **浏览器回归**（临时实例 + 真浏览器，全程给 `window.confirm/prompt/alert` 打桩）：
  - 表情：填名字+场景加图片 → 表情名与场景**确实来自输入框**（详情里能看到"占了上风想炫耀的时候"）、加完输入框清空、zip 整包导入 ✓；
  - 确认真实生效：表情删除 / 删卡（卡库 `.cc-op[data-op=del]`）/ 清空运行日志 —— **点"取消"后目标仍在、点确定后才消失**（两条路径都验了）；
  - 分组：「＋ 新建分组」标签 + 自绘输入弹窗 ✓；
  - **`window.__native` 全程空数组**：一次原生弹窗都没有。
- **部署**：纯前端（只传 `web/app.js` + `web/style.css`，**不重启服务**）；线上首页引用 `app.js?v=lo`（`?v=` 由 mtime+size 自动生成，刷新即生效），交付内容已确认含新代码且 `confirm(` 计数为 0。旧文件备份在服务器 `/data/backups/pre-sync-20260917/`（`app.js.bak3` / `style.css.bak3`）。
---

## §53 通道扫码登录修好了（服务器上二维码出不来）—— 2026-09-17，**已上线验证**

**用户报的现象**：通道连接里点扫码，二维码出不来，服务端日志是——
```
Error: Cannot find module '/root/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs'
```

### 两个根因（一个路径、一个 TTY），缺一个都出不来码
**① CLI 入口路径只认 Windows**（`src/core/openclawCli.ts`）
```js
const appData = process.env.APPDATA ?? "";
if (appData) return path.join(appData, "npm", "node_modules", "openclaw", "openclaw.mjs");
return path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "openclaw", "openclaw.mjs");
```
Linux 上 `APPDATA` 为空 → 回退成 `~/AppData/Roaming/...` = `/root/AppData/...` → 直接 MODULE_NOT_FOUND。
**服务器实际位置**：`/usr/lib/node_modules/openclaw/openclaw.mjs`（`npm root -g` = `/usr/lib/node_modules`，`/usr/bin/openclaw` 是指向它的软链）。
**改法**：按「`OPENCLAW_ENTRY` 环境变量 → 各平台常见全局根（Windows 的 `%APPDATA%\npm`；Unix 的 `/usr/lib`、`/usr/local/lib`、`/opt/homebrew/lib`、`~/.npm-global`、`~/.local`，并扫 nvm/fnm 的版本目录）→ PATH 里 `openclaw` 可执行文件的真实目标 → `npm root -g`」依次解析，结果**缓存**、文件消失会自动重解析（启动时没装、后来装上了也不用重启）。

**② Linux 下交互式登录没有 TTY 就零输出**（同一个文件）
实测：`timeout 20 node openclaw.mjs channels login --channel qqbot` 在服务器上 **stdout/stderr 都是 0 字节**（进程活着、静默）；套一层伪终端立刻正常吐二维码与链接：
```
script -qec "node /usr/lib/node_modules/openclaw/openclaw.mjs channels login --channel qqbot" /dev/null
```
**改法**：新增 `spawnOpenclawInteractive()`——Unix 上走 `script -qec '<命令>' /dev/null`（参数逐个单引号转义；macOS 用 BSD 写法 `script -q /dev/null <cmd...>`；找不到 `script(1)` 就退回直起不崩），Windows 保持原样；`detached: true` 让子进程自成进程组，配 `killOpenclawInteractive()` 整组杀（否则 `script` 被杀、里面的 node 还挂着，登录进程回收不掉）。**只给登录这类交互命令加 PTY**，`runOpenclaw` 的一次性命令（`pairing list` 等）保持原样，免得 ANSI/横幅污染解析。

### 验证（在线上服务器真跑）
- 解析：服务内 `openclawEntry()` = `/usr/lib/node_modules/openclaw/openclaw.mjs`，文件存在 ✓
- 走**接口本身**（不是手工敲命令）：`POST /api/channels/qq/login` → 轮询 `GET` → **第 25 秒拿到二维码**：`qrDataUrl` 5426 字符（`data:image/png`）、`qrUrl` 域名 `q.qq.com` ✓ → 取消收尾 ✓
- 前端轮询本来就没有次数上限（300ms 抢首帧、出现后 1.5s），25 秒等得起；弹窗期间显示"二维码生成中…" ✓
- **微信那条不是 bug**：`POST /api/channels/wechat/login` 回 `{"error":"微信账号已存满（2/2）…","accountSlotFull":true}` —— 是账号槽位上限的设计拦截（要扫码得先在账号列表里彻底删掉一个）。

### 顺带确认的服务器事实
- systemd 单元的 `PATH` 含 `/usr/bin`、`ExecStart=/usr/bin/node`（所以子进程 `spawn("node", …)` 没问题；单元里也没有 `OPENCLAW_ENTRY`，不需要配）
- 旧文件备份：`/data/backups/pre-sync-20260917/openclawCli.ts`

### 教训
「本机（Windows）能跑通」的代码搬到 Linux 服务器上要专门过一遍**平台假设**：路径拼接只是最显眼的一处，**交互式命令的 TTY 依赖**是更隐蔽的一处（不报错、只是静默）。凡是「CLI 起了但什么都不输出」，先怀疑 TTY。
---

## §54 扫码体验三改：状态标签说清楚、生成过程不外露、把十几秒藏起来（2026-09-17，**已上线**）

**用户反馈原话**：「二维码出来了，但是[为什么]我还没扫码就出现了已连接提示，还有，二维码的生成过程不要漏出来，做一个小的生成中提示或者动画，二维码的生成速度能够再快点更好，这会一次码生成要在 20s 以上」。

### 一、「没扫码就显示已连接」不是逻辑 bug，是标签含义没写清楚
后端状态实测是干净的：**不扫码的情况下轮询 64 秒，`running=true / done=false / ok=false` 全程不变**（没有任何假成功）。
真凶是通道卡片上那个状态标签 `#qq-status`：它的含义是**「这个通道已经绑了几个账号」**——用户已经有 2 个 QQ 账号，所以它一直写着「已连接 ✓」；用户此时正在扫码**添加第三个**，看到这四个字自然会以为"我还没扫怎么就连接了"。
**改法**：
- QQ 标签补上账号数（与微信一致）：`已连接 ✓（2 个账号）`，一眼能看出它讲的是"已有几个号"；
- 扫码流程期间标签切成 **`扫码中…`**（中性态），扫完/取消/失败后再回到真实状态；
- 复位用「非强制」状态（走服务端 5 分钟缓存，秒回），**只有成功后才 0.8 秒再强制刷一次**拿新账号（强制刷要跑一次 CLI，很慢，失败时没必要）。

### 二、生成过程不外露：转圈提示，失败才露终端输出
原来前端在等二维码时会把后端的 `s.output`（CLI 原始输出：banner、ASCII 二维码、ANSI 碎片）直接倒进 `<pre>`，用户看到一堆乱码。
**改法**：等待期间只显示既有的 `.conn-loading` 转圈样式 + 「二维码生成中，大约十几秒…」；二维码一到直接换成高清图；**只有失败时**才把原始输出铺出来（"未成功，下面是终端输出，可对照平台侧排查："）——诊断信息保留，但不再干扰正常流程。通道页（`startLogin`）与机器人弹窗（`startBotLogin`）两处都改了，并把"拿不到 URL 就退化成 ASCII"这条兜底路径删掉。

### 三、那 20 秒：查清了是什么，能做的是把它藏起来
**实测时间线**（服务器上带时间戳跑）：banner 出现 → **静默约 15 秒** → `[plugins] loading ...` → 二维码（整体 17~25 秒，且会波动）。
那 15 秒的定性：
- **不是网络等待**：以 1 秒粒度采样 `ss -tnp` 跟这个 pid 的连接，**全程没有任何远端连接**；
- **不是我们的代码**：debug 级日志（`--log-level debug`）在那段也不吐一行；
- 落在 CLI 自己的启动路径里（包 376MB；`--version`/`--help` 秒回，说明是登录这条路径特有的初始化）。
→ **我们改不了它**。产品层的做法是把等待挪到用户不盯着的时候：**打开「通道连接」页就预生成**（`prefetchQrLogin`）——CLI 那十几秒在用户读页面说明时就走掉了，等他点「开始扫码绑定」时二维码通常已经好了（同一个进程按 channel 键复用，不会重复生成）。
边界（避免白占资源）：只在 QQ 插件已安装时预生成；**90 秒没人点就自动取消**（`POST /api/channels/qq/login/cancel`）；用户点了按钮则标记 `qrPrefetchUsed` 不再取消。微信没做预生成——它现在账号槽位是满的（2/2），预生成只会拿到"存满"错误。
> 想彻底关掉预生成：注释掉 `initChannels()` 末尾的 `void prefetchQrLogin();` 即可，代价是点击后仍旧等十几秒。

### 验证（临时实例 + 真浏览器）
- 点「开始扫码绑定」后：**立刻**出现转圈提示（不等 POST 返回）、标签变 `扫码中…`、`#qq-qr` 原始输出框保持隐藏 ✓
- 失败分支（临时实例里 QQ 插件没装，CLI 会问"Install QQ Bot plugin?"而卡住 → 取消）：消息变成"未成功…排查"、原始输出才显示、转圈消失 ✓
- 流程结束后标签**立刻**复位（实测 2.5 秒内从「扫码中…」回到真实状态）✓
- 预生成在**插件未安装时不启动**（`prefetchQrLogin` 先查 status 再决定）✓
- **部署**：纯前端（只传 `web/app.js`，不重启服务）；线上首页引用 `app.js?v=9s`，交付内容已确认含 `扫码中…` 与 `prefetchQrLogin`、且"生成期间倒原始输出"那段代码计数为 0。备份 `/data/backups/pre-sync-20260917/app.js.bak4`。

### 另记：排查时踩的坑
`pkill -f "channels login"` 会**把自己这条 SSH 命令一起杀掉**（我的命令行里就含这几个字，正则自匹配）→ 表现是"命令毫无输出"。要写成 `pkill -f "[c]hannels login"`。
---

## §55 清空历史账号 + 内置画师串只留三条（2026-09-17，**已上线**）

**用户原话**：「QQ微信原来自带的账号全部解绑再删掉，我不希望我自己的号影响到全局使用，后面我自己会跟普通用户一样再连一次，我不希望别人的号被我的这个号所影响」+「把画师串删一下，我的默认画师串只留前三个（2.5D写实、超写实二次元、同人风），其他三个都是不要的」。

### 一、那些账号是哪来的（结论：电脑当服务器那阵绑的，跟着数据搬过来的）
- 账号实体在**共享网关家目录** `~/.openclaw`（服务器 `/data/openclaw`）下，不是按设备分开的 —— 设备隔离靠的是**账号归属表** `data/channel-owners.json` + 命名空间，凭证本身是同一份。
- 时间戳证据：`qqbot/qq-6eht`、`qqbot/qq-xj5u`、`qqbot/default` 三个目录**同秒创建于 2026-09-16 06:34**（数据搬迁那一刻），而其中 `default` 的内容 mtime 还是 **2026-08-25 18:25** —— 典型的"带时间戳拷贝"：这些是 8 月 25 号在**电脑**（当时电脑当服务器）上绑的账号。
- 它们在共享 `openclaw.json` 里的路由（本次已解绑）：
  - `persona-mt9xijkd ← openclaw-weixin:be1f34aa93f9-im-bot`
  - `anxia ← qqbot:qq-xj5u`
  - `persona-mtusl05c ← qqbot:qq-6eht`
- 可见性实测（同一时刻三个设备身份）：App 设备 `1ba5242d…` → `accounts=[]`；测试设备 → `[]`；**标了 admin 的设备 → 看得见全部**。所以"看到两个账号"只可能发生在管理员/全局视角，普通设备本来就看不见、也删不了。

### 二、清空步骤（先备份、再解绑、最后删）
1. **备份**（仅 root 可读）：`/data/backups/legacy-accounts-20260917/`（`openclaw.json`、`qqbot/`、`openclaw-weixin/`、`channel-owners.json`，另存 `openclaw.json.before-wx-clean`）。**要回滚就从这个目录捞凭证回来**。
2. **解绑**：`openclaw agents unbind --agent <id> --bind <channel[:accountId]>` ×3 → `agents bindings` 变成 `No routing bindings.`
3. **删账号**：走 shell 自己的 `POST /api/channels/accounts/delete {channel, accountId}`（管理员身份）×4 —— 它会跑 `agents delete` + `channels remove --delete` + 清插件残留 + 释放槽位 + 清归属。结果：`qq-xj5u`、`qq-6eht`、`be1f34aa93f9-im-bot`、`f41317d1b1e5-im-bot` 全部删除成功。
4. **发现一条界面删不到的黑账号**：`channels list` 还剩 `QQ Bot default` —— 那是插件第一次登录时自动建的兜底账号，**shell 的账号列表不显示它**，只能走 CLI 删：`openclaw channels remove --channel qqbot --account default --delete`。删完 `channels list` 报 **`no configured chat channels`**。
5. **清插件私有残留**（CLI 与 shell 都不管的部分，含**别人跟你老机器人聊过的东西**）：
   - `qqbot/data/qq-6eht/`、`qqbot/data/qq-xj5u/` 的 `ref-index.jsonl`（30KB / 258KB 消息索引）
   - `qqbot/data/known-users.json` 里 3 条 **别人的 openid**（`F5D0…`/`FCAF…`/群 `853C…`，都挂在被删的两个账号上）
   - `qqbot/data/credential-backup/current.json`（**存着 qq-6eht 的 appId 与 clientSecret**）
   - `qqbot/default/`（空壳目录）
6. **重启网关**（`systemctl restart openclaw-gateway`）让运行态丢掉老账号；核实：状态接口 `connected=false, accounts=[]`（QQ 与微信都是）、网关日志无报错、站点 200。

### 三、删除接口的两个漏项（本次已修，`src/server.ts`）
1. **微信的 per-account 配置条目不会被清**：`channels remove --delete` 只清微信插件的 `accounts.json` 索引与账号态文件，**`openclaw.json` 里 `channels["openclaw-weixin"].accounts[<acc>]` 会一直留着**（实测留下两条残壳）。现在跟 QQ 分支一样按 key 删掉。
2. **QQ 的插件私有目录没清**：原来只删 `~/.openclaw/qqbot/<acc>`，没删 `qqbot/data/<acc>`（消息索引）、`qqbot/data/known-users.json` 里该账号的记录、`qqbot/data/credential-backup/current.json`。现在按 accountId 一并清，并在 `notes` 里报出清了几条。

### 四、内置画师串只留三条（`src/core/imageConfig.ts`）
`BUILTIN_ARTISTS` 里原有 6 条：2.5D写实 / 超写实二次元 / 同人风 + 09-15 交付的「可爱粉彩偶像系三候选」（经典可爱基底 / 偶像梦幻感 / 清透水彩感）。按用户要求**删掉后三条**，现在正好三条。
内置串是"代码里定义 + 读写时合并"，所以从表里删掉就**在所有设备、所有配置里一起消失，不需要数据迁移**（normalize 会丢掉同名的用户条目；`activeArtist` 指向已删条目时自动清空）。线上核实：管理员视角与设备视角都是 `2.5D写实 / 超写实二次元 / 同人风`，`activeArtist` 仍为 `2.5D写实`。
> 注意这条改动**也在用户版（main）的范围里**：推到 `main` 时三个候选会一起从用户版消失（用户已确认不要）。

### 五、留了一条没动的（等用户决定）
QQ 通道级还留着迁移过来的 `allowFrom: ["F5D0…"]` + `dmPolicy: "allowlist"`（老机器人时代允许跟你聊天的 openid 白名单）。账号没了它目前是惰性的，但它会影响**以后新绑的机器人谁能聊天**（新号 openid 不同就可能被挡）。语义我不确定（清空白名单 + allowlist 可能变成"谁都不能聊"），所以没敢自作主张，留给用户定。
---

## §56 设备标记 + 查看返回不丢位置 + **修掉一个提权漏洞**（2026-09-17，**已上线**）

**用户原话**：「管理员在查看用户消息时，点击查看，再退出来，会直接回到最顶部，导致来回定位麻烦。然后是增加一个标记功能，给非管理员加上一个我自己觉得好用的标记，也就相当于昵称，只是用来方便搜索，我可以加可以不加。标记不会传给其他任何人，只有管理员能看见」。

### 一、🔴 顺手挖到的提权漏洞（比这两个需求都重要，已修）
`ADMIN_ONLY_PREFIXES` 那道网关原来注册在 `/api/users/*` 那几条路由**后面**，而 Express 按注册顺序匹配 → 那几条**整个绕过拦截**。实测（线上、普通设备带头请求）：

| 端点 | 修之前 | 修之后 |
|---|---|---|
| `POST /api/users/admin`（把自己设成管理员） | **200（提权成功）** | 403 |
| `GET /api/users/<别人的id>/cards`、`/chats/<slug>`（读别人的卡与聊天记录） | **200** | 403 |
| `POST /api/users/retention`（删别人过期数据） | **200** | 403 |
| `POST /api/users/label`（本次新增） | 200 | 403 |
| `GET /api/users` | 403（写在网关后面，本来就挡住了） | 403 |

提权的后果尤其严重：设备把自己标成 admin 后，设备中间件就把它当**管理员设备**（走全局作用域、免密码），等于拿到所有人的卡与聊天记录。**修法**：把那 12 行网关**提到所有 `/api/users/*` 路由之前**（认证/身份中间件之后），并写上"新增路由别写在网关前面"的警告。验证：6 个端点对普通设备全 403；管理员（Basic）与 admin 设备仍 200；管理员页用的 3 个接口正常；普通设备的日常接口（`/api/cards`、`/api/emojis`）没被误伤。

### 二、"查看"再退出会跳回顶部（已修）
原因：路由切页会把 `#view` 整块内容换掉（`router()` 还显式 `scrollTop = 0`），退回时列表是**重新拉取重画**的，滚动位置必然丢、搜索框也被清空。
做法：`rememberViewScroll(key)` / `restoreViewScroll(key)` 一对小工具 —— 点「查看」（以及卡库页点某张卡）时记下 `#view.scrollTop` 并置 `uKeepState`，退回时用一个"追帧"循环把位置滚回去（内容异步落定前赋值会被顶回顶部，追到稳定为止），同时保留搜索框内容与筛选结果。层级也顺带覆盖：设备列表↔卡库↔聊天记录来回都不再回顶。
> **踩坑**：追帧一开始用 `requestAnimationFrame`，实测**后台标签页里 rAF 根本不触发**（诊断值显示回调一次都没跑），改成 `setTimeout` 立刻好。凡是"渲染后校正"的逻辑都别只依赖 rAF。

### 三、设备标记（昵称，只有管理员可见）
- 存储直接用注册表里**本来就空着**的 `label` 字段（`data/users/registry.json`），新增 `setDeviceLabel()` + `POST /api/users/label`。
- 界面：设备行 ID 前面一个胶囊 —— 没标记时显示虚线「＋标记」，有标记就显示标记名，**点一下弹输入框**（复用了通用 `ocInputDialog`：留空 = 取消标记）；搜索框同时匹配 **ID 或 标记**，占位文案改成"搜索设备 ID 或标记"；卡库页头部也会显示「标记：xxx」。
- **不会外传**：注册表只经 `/api/users`（管理员专属）返回，设备端连端点都碰不到（上面那张表 403）；`label` 也不进任何用户接口。已在夹具上实测：设置/取消/按标记搜索/落盘都正常。

### 四、部署与验证
纯前端（`web/app.js` + `web/style.css`）+ 服务端（`src/server.ts`、`src/core/users.ts` → build + restart）。线上核实：首页引用 `app.js?v=i4k`，交付内容含 timer 版滚动恢复与 `u-label`/**api/users/label**；四服务 active、站点 200；线上用**真实的普通设备 ID** 复测了那 6 个端点（全 403）与提权（`/api/admin/me` 仍 `admin:false`）。备份在 `/data/backups/pre-sync-20260917/`（`server.ts.bak4`、`users.ts.bak`、`app.js.bak5`、`style.css.bak4`）。

### 五、顺带一句
这次是"做小功能顺手发现大洞"：**新加路由时一定要确认它注册在权限网关之后**。以后凡是碰 `/api/users`、`/api/plugins`、`/api/logs` 这些前缀，先看一眼网关在文件里的位置。
---

## §57 聊天输入区加高 1/3 + 三个模型选择器合成一个「模型」大面板（2026-09-17，**已上线**）

**用户原话**：「输入框高度大小增加原来的 1/3 左右，发送按键和表情包按键同步增加。然后是上面的 API 选择，用一个按键同时操控提供商、模型和思考深度……只留一个按键叫做模型，点开后分成三块，最左边是模型商的名字，用一条竖线分隔，中间是该模型商的模型名字，再加一条竖线，最右边是思考深度选择。思考深度变成一列圆形小按键，按键里面是它们代表的思考深度。整个按键打开宽度和整个输入板块一样大，模型占用宽度 > 模型商 > 思考深度，不要有任何额外说明，名字过长用省略号。」

### 一、输入区 +1/3（`web/style.css`）
生效值原来被后一段规则覆盖成紧凑版（30px），按 +33% 改成 **40px**：
| | 改前 | 改后 |
|---|---|---|
| 输入框 `min-height` | 30px（padding 6/12） | **40px**（padding 9/14） |
| 发送键 | 30×30（圆角 11，图标 13） | **40×40**（圆角 14，图标 17） |
| 表情键 | 30×30 | **40×40** |
| 输入框最大高 | 120px | 160px（`wbAutoGrow` 上限同步 160→190） |
前面那套"基础值"（42px 那组）也是死代码（被后面的覆盖），一并按同样比例抬到 56px，免得以后有人以为它就是生效值。

### 二、一个「模型」按键 = 三栏面板
- **按键**：`#lc-opt-pill`，文字**固定写「模型」**（用户要求），当前选择放进 `title`（鼠标停一下能看到"模型商 · 模型 · 思考深度"）。原来「模型商 ▾ / 模型 ▾ / 思考深度 ▾」三个按键与两套 `.lc-pop*` 样式全部删除。
- **面板**：`.lc-opt-panel` 挂在 `.lc-island`（新增 `position: relative`）上，用 `left:0;right:0;bottom:calc(100% + 8px)` → **宽度永远等于整个输入岛**。内部三栏，栏间用 `border-left` 画**竖线**：
  - 左 `lc-opt-prov`（模型商名）/ 中 `lc-opt-models`（该商的模型）/ 右 `lc-opt-think`；
  - 占比 `flex: 1.1 / 1.7 / 0 0 62px` → **模型 > 模型商 > 思考深度**（实测 390px 手机上 179 / 119 / 62px）。
  - 长名字 `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` + `title` 带全名（实测超长商名显示为「Soul API 官…」）。
  - **面板里一句说明文字都没有**；没有可选项时那一栏就是空的（不再有"先在左边选一个模型商"这类提示）。
- **交互**：点面板左侧的模型商 → 中间栏立刻换成它的模型（模型归零到该商第一个，沿用原行为）；点模型、点圆形深度键都是即时生效并按卡记住（`saveLcModelPick` = "手动选过"的标记）。**面板不自动关**（三件事可以在一个面板里连着调），点面板外任意处才关。外面点击的监听只注册一次（原来每次进聊天页都会叠一个）。
- **思考深度**：`LC_THINKING` 六档 不思考/自动/浅/中/深/极深 → 一列 40px **圆形**按键（`border-radius:50%`），键面就是档位文字（10.5px，3 字也放得下），选中态蓝底白字。

### 三、验证（临时实例 + 真浏览器 + 截图）
- 尺寸：输入框 40px、发送 40×40、表情 40×40（改前 30）。
- 只有一个 pill 且文字是「模型」；面板宽度 = 输入岛宽度（桌面 872/872，手机 362/362）。
- 三栏配比与竖线 ✓；手机上长模型商名省略号 ✓（1 项被截断）。
- 交互：切换模型商 → 模型栏跟着换 ✓；选模型 / 选「极深」→ 按键 title 依次变成「短名 · m-2 · 中」→「短名 · m-2 · 极深」✓；面板保持打开 ✓；点外面关闭 ✓。
- 截图确认：三栏竖线、右栏一列圆圈（极深高亮）、长名字省略号、无任何说明文字。
- 部署：纯前端两个文件；线上首页引用 `app.js?v=um`，`lc-opt-panel` 在、旧的 `lc-prov-pill` 归零、`.lc-pop*` 样式归零、站点 200、四服务 active。备份 `app.js.bak6` / `style.css.bak5`。

### 四、注意
`/api/providers` 返回的"启用的模型商"里除了用户自己加的，还包含**内置预设里默认启用的**几个（s3 / agnes / 老黄 / jiyuan / st / 。。。）——面板左栏会一起列出来，这是原本的行为，不是本次改动引入的。
---

## §58 聊天页五连改：面板瘦身 / 键盘不再顶走顶栏 / 撤销入输入区 / 正在输入中 / **开场白丢失修复**（2026-09-17，**已上线**）

用户一次提了五件事，逐条记录。

### ① 面板再瘦一圈（`web/style.css`）
| | 改前 | 改后 |
|---|---|---|
| 思考深度列宽 | 62px | **46px（−26%）** |
| 圆形深度键 | 40px / 字号 10.5 | **32px / 9.5** |
| 模型商列 | `flex 1.1` | **`flex 1`（约 −1/6）** |
| 模型列 | `flex 1.7` | **`flex 2.1`（腾出的全给它）** |
| 面板最高 | 44vh | **36vh** |
| 条目 | padding 8/10、字号 13 | 7/9、12.5 |
实测（720px 高、桌面宽）：三栏 269 / 555 / 46px，模型列最宽；面板最高 259px。两栏各自 `overflow-y:auto`（原有），**超出就在栏内上下滑**。

### ② 升键盘不再把顶栏（头像/名字）顶走 —— 根因在 APK，不在网页
查下来是 `MainActivity`：Android 11+ 调了 `window.setDecorFitsSystemWindows(false)`（边到边），而**窗口没设软键盘模式**，且 insets 监听**只避让状态栏、根本没管键盘高度** → 键盘弹出时系统只能把整页往上"平移"，顶栏被推出屏幕（微信/QQ 那种"只顶起输入区"自然做不到）。三处一起修：
- **APK 清单**：`android:windowSoftInputMode="adjustResize"`；
- **MainActivity**：insets 里把 **IME 高度当底部 padding**（键盘收起时回到 0，内容仍延伸进手势区，保持原设计）；
- **网页兜底**（不用重装 App 也生效）：用 `visualViewport.height` 写 CSS 变量 `--app-h`，`#app` 与 `.lc-root` 改用它（键盘弹起正好缩到可视区，顶栏留在顶部）；并把 viewport meta 加上 `interactive-widget=resizes-content`。顺带：输入框聚焦时把聊天滚到底，光标不被挡。
- **APK 已重打**：`D:\ai_workspace\apk-build\soulbox\SoulBox-v3.apk`（同签名，覆盖安装保数据）。当前手机上那个旧壳靠网页兜底也会明显改善，想要彻底就装 v3。

### ③ 「撤掉上一轮」挪进输入区并改名「撤销」
从顶栏移到 `.lc-tools-row`（模型按键右侧），改名**撤销**、复用 `.lc-pill` 样式（id 仍是 `wb-undo-round`，处理逻辑没动）。顶栏只剩「⋯ 更多」。

### ④ 「对方正在输入中…」取代占位气泡
原来每次生成都往聊天里插一条"（正在输出… 发新消息可截断重来）"气泡。现在：**AI 一开始思考/生成，顶栏的名字直接变成「对方正在输入中...」**（灰色），头像一个 1.2s 呼吸动画（`.lc-name.typing` / `.lc-who.typing .lc-avatar`），回复到达或出错时自动还原。
- 新增 `setTypingIndicator(on)`，**6 处** `wbThinkingBubble`（含变量声明、截断、成功、失败、快照接回）全部换掉，零残留；
- 切卡/切页设名字的地方先清一次提示态，避免把提示文字当名字存进快照；
- 实测：生成期间名字 = 对方正在输入中... ✓、头像呼吸 ✓、`#chat-log` 里占位气泡数 **0** ✓、结束/报错后名字复原为角色名 ✓。

### ⑤ 🔴 开场白丢失（用户反馈"开场白却没有发出"）—— 真 bug，已修
**根因**：后端 `/greeting/claim` 只写了个"已开场"标记、**不写会话日志**；前端在 `wbReloadHistory()` **之前**把开场白画成气泡，而重载会清空聊天区 → **刚画上的开场白立刻被自己擦掉**；更糟的是标记已置位，以后永远不再返回 → 用户彻底看不到开场白、开场冷场。
**修法**（端到端）：
- 后端 claim 成功时**把开场白写进统一会话日志**（`appendConv(surface:"web", ns:"local")`，**只对 `userKey=local` 的网页会话**；通道侧是 qq:/wx:，那边由主动推送 + 镜像负责，不受影响）；
- 前端删掉那句手动画气泡，交给随后的 `wbReloadHistory()` 正常渲染。
**验证**：临时实例放一张带 `first_mes` 的卡 → 进聊天页 → 聊天区出现开场白气泡 ✓（改前是空的）。附带好处：开场白现在真的是历史的一部分，模型上下文里也有了（服务端原本只在"前端无历史"时补注入，现在天然不缺）。

### ⑤-b 补丁：**老卡也看不到开场白**（同一天追加修复）
上一版只修了"新开场"这一半：`claimGreeting` 对**已经开场过**的卡直接返回 null（用户此前已经开过场的卡都算），所以用户的卡还是看不到开场白。
**修法（一次性补写）**：`/greeting/claim` 在"已开场过"分支里，检查会话日志里到底有没有这段 first_mes —— 没有就补写一条并返回；用一个专用标记 `#first_mes_logged`（存在 greeted 文件里，不是真实对话方 key，不会撞）保证**只补一次**，这样"用户手动删掉开场白"不会被反复翻出来；整卡重置（`clearGreeted(slug)` 清整个文件）会把标记一起清掉，重置后能重新开场。
**验证**：夹具造一张"已开场过、日志为空"的老卡 → 第一次 claim 返回 `{greeted:true, backfilled:true}` 并写入日志 ✓；第二次 claim `{greeted:false}` ✓；greeted 文件里 `local` 与 `#first_mes_logged` 并存 ✓。已上线（备份 `server.ts.bak6`）。

### ⑤-c 关于"要不要装新 APK"
网页侧兜底（`--app-h` + `interactive-widget`）**已经上线且对旧壳生效**，所以"升键盘顶走顶栏"这个现象在旧壳上就会明显好转 —— 用户实测确认已不再被顶走。
区别在于：**旧壳靠 JS 补偿**（系统仍在平移窗口，键盘动画过程中可能有一瞬跳动；页面滚动或键盘很高时仍可能偏），**v3 是治本**（窗口真被 resize + 键盘高度当原生 padding，不依赖 JS、任何页面都对）。所以：不装也能用，方便时再装（覆盖安装保数据）。

### 部署与验证
- 前端 `app.js` / `style.css` / `index.html` + 服务端 `server.ts`（build + restart）；线上首页引用 `app.js?v=0k`，交付内容含 `对方正在输入中`、`撤销`、`bindVisualViewport`，`index.html` 含 `interactive-widget`；站点 200、服务 active。备份：`app.js.bak7`、`style.css.bak6`、`index.html.bak`、`server.ts.bak5`。
- **一处没验到的**：用自造夹具卡（该卡没有完整 schema，缺 `voice.tone_rules` 等）走不出**成功回复**路径，所以"成功时复位提示"是靠代码核对（与已实测的错误路径是同一处调用）；真机上发一条消息即可确认。


---

## §59 字体设置页 + 新卡默认风格「纯对话」+ 报错不再拆条（2026-09-17，已上线服务器与本机）

### ① 设置新增「字体设置」页（对话字体大小）
- 位置：抽屉 → 设置 → 「字体设置」（路由 `#/font`）。**页名是用户点名的「字体设置」**（我第一版起名「聊天显示」，用户找不到 → 已改）。
- 实现：`<select>` 选项 `默认 / 12px … 20px`（照 RP-Hub 的 12–20 九档）；默认值＝样式表原值 **13.5px**，选了才覆盖。本机偏好存 localStorage `ocs_chat_font`，写 CSS 变量 `--chat-font-size`，`.bubble` 用它（`web/style.css` 的 `.bubble` 那条；**没有任何 `.lc-root .bubble` 覆盖字号**，所以聊天页气泡跟着变）。
- 启动路径：`ocApplyChatFont()` 放在文件末尾 `router()` 之前（必须放末尾：`CHAT_FONT_SIZES` 等 const 要先初始化）。
- **字体族刻意没做**：等找到差异明显、无版权顾虑的来源再加，位置就在这一页。

### ② 卡风格默认「纯对话」= 只对新卡生效
- **别用解析兜底**：第一版我在 `presets.ts` 里"风格为空就补 chat"，会把**已经在用的老卡**也一起改掉；用户口径是"老卡没选风格就一直用无风格，只管后面新加的卡"。
- 正确做法：默认值写在**创建那一刻**——`cardStore.ts` 的 `save()` 里，仅当 **`prev` 为空（首次落盘）**且卡上没写风格时补 `chat`。放存储层是为了覆盖所有创建路径（做卡页新建 / 导入 / 蒸馏），不只某一个入口。
- `presets.ts` 两处**恢复成不兜底**（风格不 fallback，档位仍默认破甲）→ 老卡的 `null` 永远保持「无风格」。
- 「不使用风格」选项值改成固定值 **`none`**（原来空串）：与"没写过风格"区分，新卡上明确选它才不会被默认值盖掉；下拉显示用 `curStyle = style && style !== "none" ? style : "none"`。
- 实测（临时数据目录跑真 CardStore）：新卡无 presets→`chat`、显式 `rich`→`rich`、显式 `none`→`none`；老卡 `style=null` / 无 presets 字段 / 已是 `chat` 三种再保存都不变。

### ③ API 报错 / 纯英文不再拆条
- 入口在 `splitter.ts` 的 `splitReply()` 最前面加 `isMachineOutput()` 短路：命中就**整段一条**，不去句号、**保留内部换行**（气泡 pre-wrap，报错/堆栈按行看才清楚），也**不参与条数收敛**（不会被 max 切开）。
- 判据（任一命中）：① 整段**纯 ASCII**（＝全是英文/数字/半角符号，用户说的"全是英文和数字的不分段"就是这条）；② 含 API 报错特征词（`invalid api key` / `status code 401` / `upstream` / `fetch failed` / `请求失败` / `报错`…，夹带中文也算）。
- **通道消息进 App 时同口径**：`server.ts` 的 `observeCard` 里"按换行拆气泡"那处也加了同一道闸。
- **通道插件内的那份拆条没同步**（有意）：`scripts/patch-channels.mjs` 里 QQ/微信各有一份内嵌拆条，只在"全新安装"路径整体写入，老安装走锚点升级；为这一条去动它要改两处 + 重打插件 + 重载线上机器人，收益≈0（API 报错不会作为消息发给 QQ 用户）。**下次动通道插件时一起同步。**
- 验证 13 个用例：6 个旧规则回归 + 6 个新判据 + 1 个"超长报错 max=1 仍 1 条"。

### 部署与验证（本次）
- 提交：`4bb70e5`（三项功能）→ `20cf31b`（页改名 聊天显示→字体设置）→ `a18f1cb`（默认值只对新卡生效）。已 `git push origin prod`。
- 上服务器：6 个文件分片传（小文件打包成 tar 一条流；`server.ts` 2 段、`app.js` 3 段、`style.css` 1 段，**每段与合并后的整体 md5 全部一致才 mv**）；备份 `/data/backups/pre-sync-a18f1cb/`；`npm run build` + `systemctl restart openclaw-shell` + `chown -R root:root`。
- 线上：站点 200、四服务 active、首页引用 `app.js?v=y92.6gaub7`（含 `字体设置` / `chat-font-size`）。
- 本机：`scripts/stop-stack.ps1` + `start-stack.ps1` 重启（三件套换新 PID），`/api/admin/me` 回 `hosted:false`（普通用户形态）；页面 `app.js?v=jf6.l9aub7`，`#/font` 标题「字体设置」、选项 `默认/12–20`、预览 13.5px。
- ⚠️ **踩坑记录**：浏览器里用 hash 跳转（`#/display`→`#/font`）**不会重载文档**，页面还在跑上一次加载的 `app.js`，看起来像"改了没生效" → 必须整页重载（Ctrl+F5）。

---

## §60 生图专项 v2：强制信号清单 + 生图自检 CoT + 「必须生成」按键（2026-09-17，**已上线服务器与本机**）

### 病根（用真实会话记录定位，不是猜的）
模型会「在剧情层同意」但根本不落地。09-16 下午「安夏」那张卡连续三条：「可不可以再发一张我还想看」→「我就给你…不论你要多少，我都给你拍」（没图）；「不发自拍我就不回复你」→「好，我发，我发还不行吗…**你看，你现在满意了吧**」（没图）。而**同一张卡 15:28/15:36 是成功出图的**（记录里带服务端写的 `（图片：1girl, solo, long pink hair…）`）。
→ 结论：不是配置错、不是能力没开、也不是"忘了有这功能"，而是**所有约束都是陈述句，没有任何一处要求它输出前做检查动作**；而"可以拒绝"是明确许可、权重更大。
扫描口径（只统计开了生图能力的卡）：47 次要图请求里 16 次真出图/带指令，31 次只有文字（66%，是上限，含关键词误命中）。

### ① 生图规则重构成 builder（6 种组合）
`presets.ts` 的 `imageRule({ where, provider, forced })`：网页/通道 × NAI/OpenAI × 常规/强制。手写 6 份必然改漏，所以按参数生成。**别再用「按内容 identity 替换」那套老 swap**（旧 compiler 里的做法已删）——现在由 `resolveCardPresetBlocks(card, { channel, forceImage })` 直接生成对应形态。
- `IMAGE_WHEN` 补上**追问式触发词**（"再发一张""我还想看""刚才那张呢""图呢""自拍在哪""你拍给我看"）与 **【强制生图】信号清单**：① 直接下生成指令 ② 催讨上一张 ③ 把要图当条件 ④ 在纠正你 → 这一轮不许拒绝、不许用文字代替。另加【禁止假装已发】。
- `IMAGE_WHEN_FORCED`：「必须生成」按下时**整段替换**判定段 → "必须依据当前剧情与角色形象生成一张有合理理由的图，没有任何商量的余地"。

### ② 生图自检（CoT）
`imageCot({ where, forced })`，结构仿 RP-Hub 的 `<cot_protocol>`（标签 + `[分区]` + 闭合要求），**只针对生图**，四段：`[对话回顾]`（回看用户这几轮+我上一轮回的，含追问式要图）→ `[本轮裁决]`（拒绝/生成二选一，或强制版"没有拒绝这条路"）→ `[输出预演自检]`（① 有没有假装已发的口吻 ② 画面是否照人设与剧情 ③ 提示词格式对不对）→ `[格式确认]`（网页=调用 `image_gen`；通道=写 `<生图:提示词>`）+ "必须闭合 `</cot>` 再输出正文"。
- **三态**：`IMAGE_COT_WEB` / `IMAGE_COT_WEB_FORCED` / `IMAGE_COT_CHANNEL`。
- **存放**：作为「默认」（break）组里的一条**内置条目** `image-cot`（与防神化并列，预设页里**不显示编辑键**，谁都改不了，用户点名要求）。但它**不随组注入**：`ABILITY_GATED_ITEM_IDS` 让 `resolveGroup` 跳过它，由 `resolveCardPresetBlocks` 按生图能力门控注入。
- **通道侧也有 CoT**（用户点名：「QQ微信端就全靠提示和cot了」）。

### ③ 网页「必须生成」按键（一次性）
位置：输入岛工具行、**撤销右边**（`#wb-force-image`，`.lc-pill` + `.on` 点亮态）。**只在当前卡 `tools.enabled` 含 `image_gen` 时出现**（`wbApplyForceImage()`，在 `refreshLcPills()` 里同步）。
- **一次性**：点亮 → 发出这一条 → `wbDoSend` 里取走并**立刻熄灭**。
- 只是 `/api/chat` 的一次性参数 `forceImage`：**不进会话记录、不影响 QQ/微信侧**（通道没这个键，且两端共享会话记录，写进历史会污染通道）。
- 异步任务里没有它：`forceImage` 只在当轮的 system 提示里生效。

### ④ 出口剥离 `<cot>`（**不做会把思维链发给用户**）
- **网页**：`sanitize.ts` 的 `COT_BLOCK_RE` 加 4 条规则（成对 `<cot>`/`<cot_protocol>` + **未闭合兜底**）。同时修了一个真 bug：剥完为空时原来会 `return out || text.trim()` **回退成原文** → 等于把整段思维链原样发出去；现在只要检测到 `<cot` 标签就以剥离结果为准。网页侧另加空回复兜底（只剩 CoT 没正文 → 给一个停顿，别让用户收到空气）。
- **通道**：补丁在 `__ocsExtractMediaDirectives()`（出口第一站；QQ 出口调 `__ocsExtractMediaLocal` → 内部调它，两个都覆盖）里插 `__ocsStripCot`。
- ⚠️ **通道补丁的坑（试打时踩到）**：两处「已打过补丁就跳过」的判定（QQ / WX）必须**把新函数名一起算进去**（`src.includes("function __ocsStripCot")`），否则整份新逻辑只会被"跳过"，永远装不上。**以后每次给插件加新 helper 都要同步改这两个判定。**
- 验证方式：在服务器 `/tmp` 用**线上插件副本**试打（`HOME=/tmp/faketest`）→ 函数与调用装上、重复执行幂等、从打好的 dist 里抠出函数实测（成对剥净 / 未闭合全剥 / 普通正文不动）→ 再打真文件。

### 验证与部署
- 本地用例 14 项全过：剥离 5（含未闭合、回显的协议段、角色动作括号不误伤）、剥完再拆条不被换行炸开 1、注入形态 7（网页/强制/通道/无生图卡/不重复注入）、预设条目 1。
- 提交 `b4aff5b`（`git push origin prod` 已推）。
- 顺序很重要：**先补通道插件（剥离）再上代码**，否则 CoT 会泄漏到 QQ/微信。实际执行：备份两个 dist 到 `/data/backups/pre-v14-cot/` → 打补丁 → `systemctl restart openclaw-gateway`（5 插件加载、微信 provider 起、ready）→ 传 6 个文件（小文件打包、`server.ts` 2 片、`app.js` 3 片，整体 md5 全对）→ build + restart 管理台 + chown。备份 `/data/backups/pre-cot-b4aff5b/`。
- 本机：重建 dist + `stop-stack`/`start-stack`，前端 `必须生成`/`wb-force-image`/`forceImage` 都在，模式仍是 `hosted:false`。
- ⚠️ **通道侧要重新编译才生效**：CoT 是进 AGENTS.md 的，得**重新保存一次那张卡**（或在卡上改一下再存）触发重编译，通道机器人才能拿到新规则。

### 已知取舍
- CoT 每轮多一段推理 → **通道侧每条消息都付这个成本**。短版影响可控；若以后写长要重新评估。
- 「可以拒绝」这条许可仍保留（除了按下「必须生成」与命中强制信号清单时）。想连"随口说想看"也不许拒绝，可再加一个「生图不许拒绝」开关。
- CoT 只是**事前预防**，不能保证 100%；**事后兜底**（出口检测到"假装已发但没生成"就重试一次）还没做，留在下一步。
