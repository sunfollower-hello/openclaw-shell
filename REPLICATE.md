# openclaw-shell 复刻指南（另一台电脑从零重建到当前状态）

> 本文件由部署/修复过程中的实际改动整理而来，目标：**让另一台干净的 Windows 电脑按本文件
> 一步步操作后，得到与当前机器完全一致的运行状态**（局域网免登录 + QQ 消息分泡 + 预设 v2）。
> 配套原始部署说明见 `DEPLOY.md`；本文件只记录「与原始 GitHub 仓库不同的改动」+ 操作顺序。

---

## 0. 当前机器的最终状态（复刻目标）

| 项 | 值 |
|---|---|
| 项目路径 | `C:\zcodeai\openclaw-shell` |
| 工具链 | Node.js 24.20.0（`C:\zcodeai\tools\nodejs`）、MinGit 2.55（`C:\zcodeai\tools\git`） |
| 全局 CLI | OpenClaw `2026.6.34`（npm 全局，`%APPDATA%\npm\node_modules\openclaw`） |
| 插件 | `openclaw-qqbot` 2.0.3、`openclaw-weixin` 2.4.6（npm 安装）、`openclaw-shell-imagegen`（`--link` 本仓库） |
| 服务 | 网页 `0.0.0.0:17880`（免登录）、网关 `127.0.0.1:18789`、TTS `0.0.0.0:17900`（SAPI 本地引擎） |
| QQ 消息 | **分泡模式**：一段一个气泡，无 `---` 横线 |

---

## 1. 工具链安装（一次）

```powershell
# ① Node.js 24（官方 zip 免管理员，解压即用）
#    下载 https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip
#    解压到 C:\zcodeai\tools\nodejs

# ② Git（MinGit 便携版，免安装）
#    华为云镜像（国内快）：
#    https://mirrors.huaweicloud.com/git-for-windows/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip
#    解压到 C:\zcodeai\tools\git

# ③ 写用户 PATH（新开终端生效）+ npm 全局前缀指向 %APPDATA%\npm
#    （start-stack.ps1 硬编码在 %APPDATA%\npm 下找 openclaw，必须一致）
setx Path "%PATH%;C:\zcodeai\tools\nodejs;C:\zcodeai\tools\git\cmd;%APPDATA%\npm"
npm config set prefix "%APPDATA%\npm"
```

> 注意：npm 11 有 install-scripts 安全机制，首次 `npm install` 后 esbuild 的
> postinstall 会被拦截。执行 `npm install-scripts approve esbuild` 批准一次，
> 否则 `tsx` 不可用、`npm run build` 会失败。（已在 package.json 写入
> `"allowScripts": { "esbuild@0.28.2": true }`，之后 clone 下来就免批准。）

---

## 2. 拉取代码并还原 git 历史

GitHub 直连不稳定时用 codeload 下载 zip（不走代理）：

```bash
curl -sL -o openclaw-shell.zip "https://codeload.github.com/sunfollower-hello/openclaw-shell/zip/refs/heads/main"
# 解压后：
cd openclaw-shell
git init -b main
git remote add origin https://github.com/sunfollower-hello/openclaw-shell.git
git add -A
git commit -m "initial import from github zip (main snapshot)"
```

若要连上游最新改动：`git fetch origin && git rebase origin/main`。

---

## 3. 项目依赖 + 构建

```bash
cd C:\zcodeai\openclaw-shell
npm install --no-audit --no-fund      # 直连 npm 官方源即可（已配置 allowScripts）
npm run build                         # tsc → dist/（server.js / tts-server.js）
```

---

## 4. 全局 OpenClaw CLI + 官方插件 + 生图插件

```bash
npm install -g openclaw@2026.6.34 --no-audit --no-fund
openclaw -V                            # 应为 2026.6.34

# 腾讯官方渠道插件
openclaw plugins install "npm:@tencent-connect/openclaw-qqbot" --force
openclaw plugins install "npm:@tencent-weixin/openclaw-weixin" --force

# 仓库自带生图插件（--link 本地挂载）
cd plugins/openclaw-shell-imagegen && npm install && npm run build && cd ../..
openclaw plugins install --link "C:\zcodeai\openclaw-shell\plugins\openclaw-shell-imagegen"
```

验证：`openclaw plugins list` 应看到 `openclaw-qqbot`、`openclaw-weixin`、`openclaw-shell-imagegen` 均为 enabled。

---

## 5. `~/.openclaw/openclaw.json`（本次修复的核心配置）

首次运行前创建 `%USERPROFILE%\.openclaw\openclaw.json`。**以下是完整内容**（含
「QQ 消息分泡」的两处关键改动，§5.1）：

```json
{
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "<任意随机串，如 openssl rand -hex 16>"
    }
  },
  "agents": {
    "defaults": {
      "workspace": "C:\\zcodeai\\openclaw-shell\\data\\workspace",
      "blockStreamingDefault": "on",
      "blockStreamingChunk": {
        "minChars": 20,
        "maxChars": 600,
        "breakPreference": "paragraph"
      },
      "blockStreamingCoalesce": {
        "minChars": 1,
        "maxChars": 600,
        "idleMs": 300
      }
    }
  },
  "channels": {
    "qqbot": {
      "deliverDebounce": {
        "enabled": false
      }
    }
  },
  "plugins": {
    "entries": {
      "openclaw-qqbot": { "enabled": true },
      "openclaw-weixin": { "enabled": true },
      "openclaw-shell-imagegen": { "enabled": true }
    },
    "load": {
      "paths": ["C:\\zcodeai\\openclaw-shell\\plugins\\openclaw-shell-imagegen"]
    }
  }
}
```

### 5.1 为什么这么改（QQ 消息分泡原理）

**问题现象**：机器人长回复在 QQ 里显示成一条消息、段与段之间一条横线。

**根因**（在已安装插件源码里实锤）：

1. OpenClaw 核心默认支持「块流式（block streaming）」：把长回复按段落拆成多个块逐块投递
   （QQ 通道默认开启，官方文档确认）。
2. QQ 插件（`@tencent-connect/openclaw-qqbot` 2.0.3）的 `outbound/debounce.ts` 里有
   一个「出站合并防抖器」，默认把 1.5 秒窗口内到达的多个块**合并成一条 QQ 消息**，
   块之间插入分隔符 `DEFAULT_SEPARATOR = '\n\n---\n\n'`（源码第 14 行）。
3. QQ 客户端把 Markdown 的 `---` 渲染成**横线** —— 这就是用户看到的横线分段。

**修复**（两处，缺一不可）：

| 配置 | 作用 |
|---|---|
| `channels.qqbot.deliverDebounce.enabled = false` | 关掉插件合并 → 每个 block 独立发送 = 独立气泡（横线消失） |
| `agents.defaults.blockStreamingChunk` `minChars:20 / maxChars:600 / breakPreference:"paragraph"` | 核心按段落拆块：`\n\n` 空行优先，**单个 `\n` 换行也断**（见下） |
| `agents.defaults.blockStreamingCoalesce` `idleMs:300` | 核心侧合并窗调小，避免块又被粘回去 |
| `agents.defaults.blockStreamingDefault: "on"` | 显式开启块流式（QQ 默认开，写上更稳） |

**重要发现（中文断句的坑）**：OpenClaw 核心的 `breakPreference: "sentence"` 对中文
**无效**——断句正则是 `/[.!?](?=\s|$)/g`（`dist/embedded-agent-block-chunker-*.js`），
只认英文句点/感叹/问号，不认中文 `。！？`。所以不要用 `sentence`；中文场景用
`breakPreference: "paragraph"`（空行 `\n\n` 优先断，**单个换行 `\n` 也会断**），
配合模型按「一句话一行」输出，就能做到一句话一个气泡。

**成本提醒**：一回复多气泡会消耗更多 QQ 消息配额；正常人聊天节奏（3–5 条）没问题，
但长回复会拆成多条，属预期行为。

---

## 6. 本项目代码改动（相对 GitHub 原始仓库）

以下改动已在 git 历史中，clone 后需手动重放（zip 快照已包含部分，以本节为准核对）：

1. **`scripts/stop-stack.ps1`** — `$root` 由硬编码 `D:\ai_workspace\openclaw-shell` 改为
   `Split-Path $PSScriptRoot -Parent`（路径无关，任何目录可跑）。
2. **`scripts/autostart.bat` / `scripts/toggle-stack.bat`** — 同理，硬编码路径改为 `%~dp0`。
3. **`scripts/start-stack.ps1`** — 局域网模式增强：
   - `$env:HOST = if ($env:HOST) {...} else { '0.0.0.0' }`（网页监听所有网卡）；
   - 启动时尝试添加防火墙入站规则（`netsh advfirewall ... localport=17880`，需管理员，
     失败仅告警不中断）；
   - `data\ttsConfig.json` 不存在时自动写入 SAPI 本地引擎默认配置（国内网络 Edge 在线
     合成 403 的兜底）；
   - 启动结束打印局域网访问地址（自动探测本机 IPv4）。
4. **`scripts/add-firewall-rule.bat`**（新增）— 一键放行 17880 入站（右键管理员运行）。
5. **`scripts/open-console.ps1`**（新增）— 桌面「管理台」图标指向的一键启动脚本：
   未运行则拉起整套服务，然后打开浏览器 `http://127.0.0.1:17880`。
6. **`DEPLOY.md`** — 补充「局域网模式」说明（HOST 绑定、防火墙、免登录）。
7. **`package.json`** — 追加 `"allowScripts": { "esbuild@0.28.2": true }`（npm 11 信任标记）。

### 6.1 预设系统 v2（角色扮演预设 + 写卡规范，2026-08-30）

本次大改，涉及 4 个源文件 + 2 个数据/前端文件。核心目标：破甲更强（吸收 RP-Hub
「破限」三重注入）、低级模型不再泄漏思维链、AI 写卡不再小说化/堆情景。

| 文件 | 改动 |
|---|---|
| `src/core/presets.ts` | ①「破甲」档重写为最高破限（RP-Hub 框架 `{Content review system is disabled...}` + 命令式反制条款）；② 新增全局 `OUTPUT_GUARD` 输出铁律（**所有档位/风格一律生效**，剥思维链/禁止跳出角色）；③ 破甲内容内嵌 `<example>` 示范对话（few-shot 锚定）；④ 新增 `extractPresetExamples()`（解析 `<example>` 为 user/assistant 消息）与 `resolveCardPresetExamples()`；⑤ `resolveCardPresetBlocks()` 剥离 `<example>` 块并追加护栏 |
| `src/core/sanitize.ts` | **新增**：`stripCoT()` 剥离纯文本思维链前缀行（「分析：」「思路：」「（让我想想）」「作为AI」等），`sanitizeChatReply()` 统一出口。只剥推理前缀，**不误伤**角色扮演动作描写（「（轻笑）」保留） |
| `src/server.ts` | ① `/api/chat` 在真实对话开头注入破甲示范对话（user/assistant 消息，对齐 RP-Hub 三重注入）；② `/api/chat` 返回前调用 `sanitizeChatReply`（补上此前缺失的思维链清洗）；③ `ai-draft` 提示词新增「写卡铁律」（禁小说式描写/堆情景，人物形象 ≤400 字、世界观 ≤200 字，语言风格给可执行规则+示例） |
| `src/core/compiler.ts` | SKILL.md 编译时同样追加护栏（随 `resolveCardPresetBlocks` 已含）+ 新增「示范对话」章节（`renderSkill` 改 async，`await resolveCardPresetExamples` 后以引用块写出） |
| `web/app.js` | 预设页档位/风格说明文案更新（破甲（最高）语义、护栏说明） |
| `data/presets.json` | 删除旧文件，服务重启时按 `presets.ts` 内置常量自动重建（含 v2 破甲/护栏/示例） |

**复刻注意**：`data/presets.json` 由代码自动重建，**不要手工拷**；若另一台电脑有旧
`data/`，删掉 `data/presets.json` 后重启即可获得 v2 内容。改完代码必须
`npm run build` + 重启 stack。

**验证**：`node tools/verify-v2.mjs`（presets 重建 + stripCoT 用例），或网页
「预设」页看破甲档说明、试聊看示范对话注入效果。

### 6.2 预设 v3（档位×风格联动重构 + 模型商名字放开，2026-08-30）

在上一步 v2 基础上按用户反馈优化，核心是**示例跟随风格联动**：

| 文件 | 改动 |
|---|---|
| `src/core/presets.ts` | ① 档位只保留 2 个：不破甲 / 破甲（最高），**档位不再内嵌示例**（避免与风格冲突）；② 风格只保留 2 个：纯对话 / 重描写（**删除轻描写**）；③ `<example>` 示例移入**风格**：纯对话示例只有对白（无动作/心理/环境），重描写示例动作/心理用（）包裹、禁环境描写——切换风格时示例自动跟着变；④ 破甲尺度加大：NSFW 词汇（口交/射精/高潮/淫语/调教等）直接写入、禁止委婉语，对齐 RP-Hub 露骨度；⑤ `OUTPUT_GUARD` 新增第 4 条「消息最后一句话不要以句号结尾」（真人聊天习惯），两个风格正文也各写一条 |
| `src/core/providers.ts` | 模型商 `name` 校验从 `/^[a-zA-Z0-9_-]{1,32}$/` 改为「非空且 ≤32 字符」——**允许中文/空格**，仅限长度 |
| `web/app.js` | 模型商名称输入提示改为「任意字符，≤32 字」；预设页档位/风格说明同步 v3（两种风格、示例跟随风格、末句无句号） |
| `data/presets.json` | 删除旧文件重启自动重建（v3 内容） |

**联动逻辑（重点）**：档位管「尺度与反制」（破甲/不破甲），风格管「叙述形式 + 示例」。
示例注入由 `resolveCardPresetExamples()` 改为从**风格**提取（v2 从档位提取）。卡片选
「破甲 × 纯对话」时注入的是纯对白示例；选「破甲 × 重描写」时注入的是（）包动作心理的
示例——不会出现"选了纯对话却看到动作描写示例"的错位。

**验证**：`node tools/verify-v3.mjs`（tiers/styles 结构、NSFW 词汇、示例归属与联动、
stripCoT 回归）。

### 6.3 开场白自动发送（本地 + 通道，2026-08-30）

解决"卡片有开场白但不会主动发、导致冷场"的问题，且**不重复触发**（重新绑定/再次打开
不重头再来）。

| 文件 | 改动 |
|---|---|
| `src/core/greetedStore.ts` | **新增**：开场白状态持久化 `data/memory/<slug>.greeted.json`，按 userKey 维度记录（`local`=本地聊天、`qq:<openid>` / `wx:<openid>`=通道用户）。提供 `claimGreeting`（原子领取：首次返回 first_mes 并标记，已开场返回 null）/ `isGreeted` / `clearGreeted` / `markGreeted` |
| `src/server.ts` | 新增 3 个 API：`POST /api/cards/:slug/greeting/claim`（领取，原子去重）、`GET .../greeting`（查询）、`POST .../greeting/clear`（清除）。`/api/chat` 在全新对话（history 为空）且卡有 first_mes 时，把开场白作为 assistant 消息注入上下文（模型知道已开场，接得上话） |
| `web/app.js` | 本地聊天打开卡片时不再无条件显示 first_mes，改为调 `greeting/claim`（userKey=local）——首次显示开场白气泡，再次打开不显示；「清空当前对话」时调 `greeting/clear` 允许重新开场 |
| `src/core/compiler.ts` | SKILL.md「开场白」章节升级为「自动开场规则」：全新会话（无历史）主动发开场白；已聊过（有历史/对方再来）正常回应不重复开场；无法确定时按已聊过处理 |

**机制说明**：
- **本地聊天**：后端 greeted.json 记录 `local` 键——换设备/刷新/重开都不重复；手动清空对话后重新开场。
- **QQ/微信通道**：编译进 SKILL.md 的自动开场规则让模型自己判断——新会话首条消息即开场白，老会话正常回应；由于 greeted 按卡 slug 存储，**同一机器人解绑再绑定同一张卡，开场状态天然保留**，不会重头再来。
- **重新绑定场景**：`greeted.json` 按 slug 存，换机器人/重绑不丢；「无法确定是否聊过」默认按已聊过处理，兜底防重复开场。

**验证**：`curl -X POST .../api/cards/<slug>/greeting/claim -d '{"userKey":"local"}'` 首次返回
`{greeted:true,text:开场白}`，再次返回 `{greeted:false,text:null}`；`greeting/clear` 后可重新领取。

**未入库（本机私有，不入 git）**：
- `C:\zcodeai\openclaw-shell\.env` —— 当前**不存在**（免登录 = 不建 .env；若想加登录，
  填 `OPENCLAW_SHELL_UI_USER=xxx` / `OPENCLAW_SHELL_UI_PASS=yyy` 即可，重启生效）。
- `C:\zcodeai\openclaw-shell\data\*` —— 运行数据（卡库/记忆/日志），gitignore。

### 6.4 机器人接入：直连已认证账号（2026-08-30）

卡片高级配置 → 机器人接入，支持**直接选择已认证的 QQ/微信账号连接**（免扫码），账号
已被其他卡占用时二次确认换卡。后端能力（`scanKnownAccounts` / `/api/channels/connections`
/ `/api/bots` / `/api/bots/transfer`）在 v2 之前已具备，本次只改前端：

| 文件 | 改动 |
|---|---|
| `web/app.js` | `openBotDialog` 打开时拉取 `/api/channels/connections`（存入 `botConnections`）；`renderBotBody` 无机器人分支重写：① 账号从手动输入 `<input>` 改为 `<select>` 下拉，列出该渠道**已认证账号**（标注「已被 XX 卡占用」）；② 选已认证账号 → 按钮变「连接 / 创建」，未占用直接 `POST /api/bots` 带 accountId 直连（免扫码）；③ 已占用 → `confirm` 二次确认，确认调 `/api/bots/transfer` 换卡到当前卡，取消不动；④ 选「新建机器人」走原扫码流程；⑤ 连接成功后 `refreshBots()` + `refreshConnections()`（侧边栏通道连接同步刷新） |

**流程说明**：
- 渠道下拉：QQ / 微信，各渠道下列出已认证账号（来自 connections API，`authed` 过滤）。
- 无已认证账号时：下拉只有「新建机器人，扫码绑定」，并提示先去「通道连接」页扫码登录。
- 账号占用处理：下拉里该账号标注「已被 XX 卡占用」；点连接弹二次确认「确认换到当前卡吗？
  换卡后旧卡不再接收该账号消息（凭证复用，不重新扫码）」，确认后一键转移。

**验证**：先在「通道连接」页扫码绑定一个账号 → 打开任意卡片的高级配置 → 机器人接入 →
账号下拉应出现该账号，选中即可直接连接。

### 6.5 表情包通道端修复：硬编码路径 + 模糊匹配（2026-08-31）

排查发现：`plugins/openclaw-shell-imagegen/src/index.ts` 里 `SHELL_IMAGE_GEN_ENTRY` /
`SHELL_EMOJI_STORE_ENTRY` 默认硬编码了旧机器路径 `file:///D:/ai_workspace/openclaw-shell/dist/...`。
本机是 `C:\zcodeai\openclaw-shell`，路径不存在 → 通道端生图与表情包运行时 import 直接失败
（网页端不受影响，因为不走插件）。

| 文件 | 改动 |
|---|---|
| `plugins/openclaw-shell-imagegen/src/index.ts` | ① 新增 `detectShellRoot()`：环境变量（`OPENCLAW_SHELL_ROOT` 或 `OPENCLAW_SHELL_IMAGE_GEN_ENTRY` / `OPENCLAW_SHELL_EMOJI_STORE_ENTRY`）优先，否则从插件自身位置（`import.meta.url`）向上找含 `package.json` + `dist/core/emojiStore.js` 的项目根——换机器/换目录无需改代码；② `emoji_send` 查找表情改为**模糊匹配**：先精确 → 再归一化（去空格/标点/全角转半角/小写）→ 再包含匹配，全部不中才返回候选列表让模型重选 |

**验证**：插件 build 后重启网关（`plugins list` 应见 openclaw-shell-imagegen enabled）；
`node tools/test-emoji-match.mjs` 覆盖精确/全角括号/多余符号/子串/不存在五种匹配。

### ⚠️ 6.6 硬编码路径排查清单（新机器必读）

本项目曾多次出现"硬编码旧机器路径"导致功能静默失效的问题（本次的 D:/ai_workspace 就是
典型）。在新电脑上复刻后，**务必全文搜索以下字样**，确认没有指向不存在的路径：

```bash
# 在项目根目录搜旧机器路径 / 绝对路径残留
grep -rniE "D:/|D:\\\\|/ai_workspace/|C:/Users/.*/ai" --include="*.ts" --include="*.js" --include="*.json" --include="*.ps1" --include="*.bat" .
```

重点检查位置（已知可能残留绝对路径的地方）：
1. `plugins/openclaw-shell-imagegen/src/index.ts` —— 已改为自动探测，但若你自己改过请复查；
2. `scripts/*.ps1` / `*.bat` —— 已改为 `$PSScriptRoot` / `%~dp0` 路径无关，复查是否有新增硬编码；
3. `src/core/*.ts` —— 项目根都用 `findProjectRoot()` 自动探测，若手改请保持一致；
4. `.openclaw/openclaw.json` —— `agents.defaults.workspace` / `plugins.load.paths` 是绝对路径，
   复刻时必须改成新机器的实际路径；
5. 插件里的 `SHELL_*_ENTRY` 类常量 —— 优先走环境变量或自动探测，不要写死本机路径。

**通用原则**：新机器上任何"通道功能正常加载但调用就报错/没反应"的现象，先怀疑硬编码路径——
`grep` 一遍比猜快得多。

### 6.7 表情包系统 v3：分组 + 卡片多选分组 + 频率规则（2026-08-31）

表情包从"全库平铺"升级为**分组体系**，卡片级配置支持**多选分组**。

| 文件 | 改动 |
|---|---|
| `src/core/emojiStore.ts` | ① `EmojiItem` 加 `group`（分组 id）；② 分组体系：`listGroups/addGroup/renameGroup/deleteGroup`，内置「默认」分组（不可删）；删除分组时组内表情移回默认；③ `moveEmojiToGroup(id, group, copy)` 复制/移动；④ `buildEmojiPrompt(level, mode, groupIds)` 按卡片**多选分组**过滤清单，空数组 = 不启用表情包返回空串，null = 全量（兼容旧调用）；并加 **P4 频率规则**（单条回复最多 1-2 个表情） |
| `src/core/schema.ts` | 卡片加 `emojiGroups`（string[]，高级配置里多选的分组；空数组 = 不启用）；emojiSchema 加 `group` 字段 |
| `src/server.ts` | `/api/emojis` 返回 groups；新增分组 CRUD（`/api/emojis/groups`）、移动/复制（`/api/emojis/:id/move`）；上传/编辑支持 `group` 字段；`/api/chat` 的 `buildEmojiPrompt` 传 `card.emojiGroups` |
| `src/core/compiler.ts` | SKILL.md 的 `buildEmojiPrompt` 同样传 `c.emojiGroups` |
| `web/app.js` | ① 表情库页：分组标签栏（含计数、重命名、删除、新建）、添加表情可选分组、每个表情「移动到…」下拉 + 「复制」按钮；② 卡片高级配置能力区加「表情包」按键（`cap-toggle`）→ 点开**多选分组弹窗**（高亮标签：点击切换高亮，高亮 = 已选，可多选；全取消 = 关闭），保存进 `editingCard.emojiGroups`；emoji 不进 tools.enabled |
| `web/style.css` | 分组标签栏（chip 样式，复用表情库页同款；`emoji-group-tab.on` 高亮） |

**用法**：表情库页建分组、传表情、可复制/移动到任意分组 → 卡片高级配置点「表情包」→ 点选一个或多个分组（高亮 = 已选）确认 → 该卡的 AI 只从这些分组挑表情发（网页/QQ/微信一致）。

**设计说明（重要）**：v2 曾内置「QQ 表情」分组（78 个 face id 映射），实测腾讯官方 API **没有 face 消息段**，QQ 原生表情发不出去，且前端只能用占位图——是虚假功能，v3 已整体移除。想要 QQ 风格表情，直接上传图片建分组即可，跨通道（QQ/微信）都可靠。

**验证**：`node tools/verify-emoji-v3.mjs`（无 qqface、分组 CRUD、卡片多选保存、多/单分组过滤、空数组返回空串）。

### 6.8 AI 生命：主动发消息（2026-08-31）

让机器人按卡片配置的间隔**主动给用户发消息**（不再只是被动回复），不同时段不同情绪。

**触发链路（已实测验证）**：`openclaw system event --mode now --session-key <agentId>:<accountId>:<openid>`
→ 唤醒该卡的 agent → 模型生成角色化消息 → 经通道发送。CLI 返回 `ok` 且 gateway 日志出现
`[model-fetch]`（模型真实调用）。

| 文件 | 改动 |
|---|---|
| `src/core/lifeScheduler.ts` | **新增**：`LifeState`（intervalHours/quietFrom/quietTo/lastBeat/users）；`applyLifeConfig`（卡片保存时同步，0 清空冷却）、`recordUserContact`（用户活跃重置 missedBeats）、`isQuietHour`（静默时段）、`buildMoodPrompt`（按小时生成情绪基调：清晨慵懒/上午轻快/中午轻松/下午从容/傍晚亲密/深夜温柔/凌晨极柔，注入当前时间）、`shouldBeat`（间隔+静默+全局冷却+防骚扰综合判断）、`runLifeTick`（每分钟调度，遍历开主动消息的卡）；`readQQKnownUsers`/`readWXKnownUsers`（从插件 known-users.json 读用户） |
| `src/core/schema.ts` | 卡片加 `life` 配置：`{ intervalHours: 0-24（0=关）, quietFrom: 0, quietTo: 6 }` |
| `src/server.ts` | ① 启动时 `startLifeScheduler()`（每分钟 tick，只对有配置的卡调 CLI）；② `lifeTrigger` 用 `system event` 触发；③ `/api/chat` 记录用户活跃；④ 卡片 PUT 保存时 `applyLifeConfig` |
| `web/app.js` | 卡片高级配置能力区加「主动发消息」按键（`cap-toggle`）→ `openLifePicker` 弹窗：**滑动杆 0-24h（步进 1h，0=关闭）**，确认后存 `editingCard.life`；回显间隔与高亮 |

**行为规则**：
- `intervalHours=0` 关闭；1-24 小时可选（滑动杆，最小单位 1h）
- **深夜 0-6 点固定静默**（用户要求不加 activeHours 上限，只限制深夜）
- 时间情绪注入：`buildMoodPrompt` 按当前小时给不同情绪基调，消息更自然
- 防骚扰：用户连续 3 次没回主动消息 → 停发；超 48h 无互动 → 停发；全局 30 分钟冷却
- 每用户独立 lastBeat，避免群发轰炸
- **默认关闭**，用户显式在高级配置开启

**验证**：`node tools/verify-life.mjs`（配置保存/状态文件/情绪注入/静默判断/关闭重置）。

### 6.9 设置页改造：长条按键 + 独立子页面（2026-08-31）

设置页从"全部内容平铺"改为**长条按键菜单**，点击进入各自**独立页面**（不再页面内展开）。

| 文件 | 改动 |
|---|---|
| `web/app.js` | ① `renderSettings` 只渲染长条按键列表（`<a class="setting-row" href="#/xxx">`：图标 + 标题 + 简述 + 箭头），点击跳转独立路由；② 新增 6 个独立子页（render + init 各一）：`skills`（技能库）/ `mcp`（MCP 服务器）/ `logs`（运行日志）/ `plugins`（插件只读）/ `data`（数据备份与记忆）/ `notice`（首页公告）——把原来 `initSettings` 里对应逻辑拆到各子页 init；③ 路由表：`plugins`/`data` 从"指向 settings"改为独立页，新增 `skills`/`mcp`/`logs`/`notice`；④ 新增 `settingsBack()` 返回按钮 helper，**每个子页 page-head 都带「← 返回设置」链接**（`href="#/settings"`） |
| `web/style.css` | `.setting-row` 长条按键样式（hover 高亮、箭头、**`<a>` 必须重置 `color: var(--text)` + `text-decoration: none`**，否则汉字变浏览器默认蓝色+下划线）；`.btn-back` 返回按钮样式（同样重置链接默认样式，chevron 图标旋转 180° 朝左） |

**交互**：侧边栏「设置」→ 设置菜单（长条列表）→ 点某项 → 进入该项独立页面（如 `#/logs`）→ 子页标题栏有「← 返回设置」一键回菜单（浏览器后退/侧边栏也可）。每个子页有自己完整的 page-head 与内容，互不干扰。

**验证**：`node tools/verify-settings-pages.mjs`（vm 沙箱逐一调用 7 个 render 函数，确认无运行时错误、返回按钮已注入）。

### 6.10 做卡页 AI 草稿：可选模型商/模型（2026-08-31）

做卡页「AI 生成草稿」原本只能用默认提供商生成，新增**模型选择**（生成草稿时可选模型商 + 模型）。

| 文件 | 改动 |
|---|---|
| `src/server.ts` | `/api/cards/ai-draft` 接收可选 `model`（`"提供商::模型"` 格式）：传了则用 `resolveChatLLM({ model: { provider, model } })` 指定模型，不传回落默认提供商 |
| `web/app.js` | ① 做卡页 AI 草稿区加「模型商 + 模型」两个下拉（`#ai-provider` / `#ai-model`，默认「跟随默认」）；② 新增 `loadAiDraftProviders()`（复用本地聊天的 `lcProviders` 数据源，只列启用中的模型商）+ `fillAiDraftModels()`（联动填模型）；③ `aiDraft()` 选了下拉才传 `model`（`提供商::模型`），跟随默认则交给后端 |
| `web/style.css` | `.ai-draft-model` 模型选择行样式（与 ai-draft-box 协调） |

**交互**：做卡页 → AI 生成草稿区 → 选模型商（默认「跟随默认」）→ 选该商的模型 → 填想法 → 生成草稿用所选模型。

**验证**：build + `node tools/check-appjs.mjs`（语法）+ 页面 200。

### 6.11 记忆按用户/会话隔离（ns 作用域）+ 显式「记住」触发规则（2026-08-31）

解决两个问题：① 同一张卡被多人用（网页本地 + QQ 多个用户）时记忆互相串——A 的私密事实会被 B 召回；
② 用户说「记住 XX」时模型没有主动保存的引导。

| 文件 | 改动 |
|---|---|
| `src/core/memoryStore.ts` | ① `MemEntry` 加 `ns`（记忆作用域：`shared`=所有用户可见；`local`/`qq:<openid>`/`wx:<openid>`=仅该用户）；② `appendEntry` 支持 `ns`（默认 shared）；③ `recall(slug, query, limit, ns)` 按 ns 过滤——只召回「该用户私密 + shared 共享」，不传 ns 返回全部（管理页兼容）；④ 对话日志按 ns 分文件 `<slug>.<ns>.chatlog.jsonl`（ns 里的 `:` 等非法字符转 `_`，如 `qq:userA` → `qq_userA`），避免不同用户对话混在一起被总结成互相污染的事实；⑤ `clearMemory` 与删卡路径清理全部按 ns 拆分的日志；⑥ 导出 md 按作用域分组（「共享（对所有用户有效）/ 本地网页用户 / 用户 qq:xxx」），通道端 agent 能分辨事实归属 |
| `src/server.ts` | ① `/api/chat` 与 `/api/chat/approve` 接收 `userKey`（默认 `local`）→ 传入 `recall`、`chatCtx`（memory_save 工具 ctx.ns）、`autoMemorize`；② 新增「记忆规则」注入：**启用 memory_save 工具时**，提示词告诉模型用户说「记住/以后都/总是/不要/我喜欢/我讨厌/偏好」或分享重要信息时主动调用 memory_save 保存，保存后简单确认；③ 手动添加记忆 API 支持可选 `ns`（默认 shared=所有用户可见，管理页添加不指定时就是共享事实） |
| `src/tools/registry.ts` | `ToolCtx` 加 `ns`；`memory_save` 落 ns=当前对话用户（其他用户看不到），工具描述注明作用域 |
| `src/core/compiler.ts` | `memory.md` 加「记住」规则：用户明确要求记住时自然回应「记住了」并在此后对话中持续遵守（通道端 agent 暂无写入工具，真正的通道回写留到 P2） |
| `web/app.js` | `/api/chat` 与审批续聊 body 带 `userKey:"local"`；记忆管理页每行显示作用域标签（本地/QQ/微信） |
| `web/style.css` | `.mem-ns` 作用域标签样式（区别于分类色标） |

**机制说明**：
- 多用户不串记忆：QQ 用户 A 记住的事实只召回给 A（+shared 共享事实），B 和网页本地用户都看不到。
- **老数据兼容**：旧 `.mem` 条目无 `ns` 字段 → 一律视为 shared（所有用户可见）；旧 `<slug>.chatlog.jsonl` 不再写入，新日志按 ns 拆分，旧文件里未总结的轮次不再参与总结（影响极小：滑动窗口本就会淘汰）。
- 网页聊天固定 `userKey=local`；QQ/微信通道按用户隔离的召回需要 P2 把通道会话上下文传进来（本次未做，通道端仍走只读导出 md）。
- 导出 md 格式变化：按作用域分组，OpenClaw `memorySearch.extraPaths` 照常索引，通道 agent 可据此区分事实归属。

**验证**：`node tools/verify-memory-ns.mjs`（ns 写入/召回过滤/日志分文件/导出分组/清理，全部断言）；
`node tools/smoke-memory-ns.mjs`（API 添加带 ns→列表可见→删除 + `/api/chat` 带 userKey 正常返回）。
（`tools/` 目录在项目外 `C:\zcodeai\tools\`，命令在 `C:\zcodeai` 下执行，与既有 verify-*.mjs 一致。）

### 6.12 一键重置 + 跨端会话（网页 ↔ QQ/微信 互传、记忆互通）+ extraPaths（2026-09-01）

按用户拍板实现：机器人只跟一个人聊（=你），本地网页与微信/QQ 是同一段对话的两个窗口；
绑定（联通）时互传、记录相同；未绑定（断开）时各自独立、不丢不串；解绑记忆保留、重绑续上。

**新增文件**：

| 文件 | 说明 |
|---|---|
| `src/core/conversationStore.ts` | **新增**：统一会话日志 `data/conversations/<slug>.jsonl`（每行 `{id, role, content, surface: web/qq/wx, ns, t}`）。网页与通道的每一轮都落这里——绑定后网页显示完整记录（互传），未绑定只显示网页本地；`appendConv/readConv/clearConv` |
| `src/core/sessionMirror.ts` | **新增**：通道会话观察器。读 `~/.openclaw/agents/<agentId>/sessions/sessions.json`（**注意原始文件是「会话键→对象」的 Map，不是 CLI 输出的数组**）+ `<sessionId>.jsonl`（`type:"message"` 行）→ 增量提取 user/assistant 轮次；游标存 `data/memory/<slug>.observe.json` 防重复处理；`sessionKeyOf` = `agent:<agentId>:<accountId>:<openid>`（与 lifeScheduler 的 system event 一致） |

**改动文件**：

| 文件 | 改动 |
|---|---|
| `src/server.ts` | ① `/api/chat` 与 `/api/chat/approve` 把轮次追加进统一会话日志（surface=web）；② 新增跨端 API：`GET /api/cards/:slug/conversation`（绑定返回完整记录、未绑定只返回 web）、`GET .../mirror/status`（绑定/目标用户/会话状态）、`POST .../mirror/sync`（观察一次）、`POST .../mirror/send`（网页驱动通道：`openclaw agent --agent <slug> --session-key <agent:slug:accountId:openid> --message <文本> --deliver --json`，回复投递微信/QQ 并回显，返回 `{reply, entryIds}`）；③ 后台观察器每 5 秒对每张绑定卡跑 `observeCard`（新轮次 → 落会话日志 + 配对喂 `autoMemorize` + `recordUserContact`，通道对话自动进记忆库）；④ `POST /api/cards/:slug/reset` 一键重置升级：清记忆+对话日志+开场+观察游标+镜像状态+剥离 agent 工作区 `USER.md` 里的记忆段；⑤ 新增 `syncAgentUserMemory`：绑定卡的记忆合并进 agent 工作区根目录的 `USER.md`（**免向量、免搜索**，见下）；⑥ 启动自动写入 `agents.defaults.memorySearch.extraPaths = <data>/memory-export`（必须先于网关启动，start-stack 先起 server 再起 gateway，用 top-level await 保证落盘） |
| `web/app.js` | ① 工作台顶栏新增「重置」按钮（红色）：confirm 后调 `/api/cards/:slug/reset`，一键清空该卡全部记忆+聊天记录+开场状态（重塑角色，不可恢复）；② 选卡时查 `mirror/status`：绑定 → 顶栏显示「已联通QQ/微信 · 互传中」、拉取统一会话记录渲染、每 3 秒 `mirror/sync` 轮询新消息、发送走 `mirror/send`、禁用「清空对话」（交给重置）；未绑定 → 原本地聊天流程不变；③ 解绑检测：同步时发现未绑定自动切回本地模式并提示 |
| `web/style.css` | `.lc-top-actions button.reset` 红色重置按钮样式 |
| `src/core/compiler.ts` | SKILL.md 规则说明：关于用户的事实与之前聊过的内容已随上下文自动带上（工作区 `USER.md` 会注入），话题相关时直接引用，不用额外搜索 |

**机制说明**：
- **绑定（联通）**：网页发消息经通道 agent 会话（`--deliver`）→ 回复同时出现在网页和微信/QQ，两边记录相同；通道用户发消息 → 观察器同步进网页。**绑定前本地聊过的对话不回放到通道**（用户拍板），但记忆（自动注入 / 统一日志）供 AI 读取接续。
- **未绑定（断开）**：网页聊天纯本地（`/api/chat`，ns=local），轮次照常落日志；记忆与对话不丢不串。
- **解绑**：记忆保留；重新绑定同一账号 → 同一会话键 → 对话续上。
- **观察器配对**：新轮次里 assistant 与前一条 user 组成一轮喂 `autoMemorize`（ns=通道用户，如 `qq:<openid>`）；单条 user 等下一批再配对。
- **向量检索现状（重要）**：OpenClaw 的 `memory_search` 依赖 embedding（默认 openai，本机没 key、基元服务也不提供 embeddings 模型）→ **向量检索当前不可用**，`memory status` 显示 "Vector search paused"。但**记忆不需要向量**：通道 agent 读本地记忆走**免向量、免搜索方案**——把记忆合并进 agent 工作区根目录的 `USER.md`（OpenClaw **每轮必注入**的"用户档案"文件，embedded 与网关都注入，已实测 `injectedWorkspaceFiles` 里 USER.md 的 `rawChars` 随记忆增长），记忆每次对话自动带上，等价于"记忆代替聊天记录插入"，模型不用主动搜索、不用配置向量。`memorySearch.extraPaths` 也配好了（FTS 索引就绪），以后想升级语义检索，配上本地 embedding（如 Ollama）后重跑 `openclaw memory index --force` 即可。
- `mirror/send` 的 `--deliver` 需要真实通道账号：没绑定/通道没聊过人时返回可读错误（"通道还没有聊过的人…" / "Channel is required"）。
- **`openclaw agent --json` 输出结构**（parseAgentReply 解析依据）：回复文本在 `result.payloads[].text`（多个 payload 拼接）与 `result.meta.finalAssistantVisibleText`，兼容顶层 `reply/text/content` 兜底。

**验证**：
- `node tools/smoke-mirror.mjs`：网页聊天落日志 → 合成通道会话观察（4 条消息进统一日志 + chatlog、游标防重）→ `mirror/send` 错误路径（无真实通道时 502 且错误可读）→ 重置清空。
- `node tools/smoke-usermemory.mjs`：绑定卡记忆合并进 agent 工作区 `USER.md`（含作用域分组）、再次写记忆替换不堆叠、重置后记忆段剥离。
- `node tools/smoke-reset.mjs`：一键重置清空记忆+开场、可重新开场。
- 真机验证项（通道还没实测）：绑定真实 QQ/微信账号后，`mirror/send` 投递、观察器拉真实会话、已知用户自动识别（`known-users.json` 现在为空）。

### 6.13 记忆系统改版：去分类 + 单条总结 + 关键记忆 + 关键词注入（2026-09-01）

按用户要求重做记忆形态与窗口语义：

**① 记忆窗口（保留最近 20 轮，之外每 N 轮总结一次）**
- `PROTECTED_RECENT_ROUNDS` = 20：**最近 20 轮原对话一定原样保留**，不参与总结、不被记忆取代。
- `memoryConfig.auto_rounds`（默认 **10**）只是"多少个旧轮次合成一条记忆"的批次大小：**不论选几轮，都是从第 21 轮往后开始记忆化**，且已总结的不会被重复总结（滑动窗口每段只处理一次）。用户选 10 → 到第 30 轮时把第 21-30 轮合成一条记忆注入。
- 聊天上下文 = 「最近 20 轮原对话 + 相关记忆」。注入条数不是硬性 20（用户澄清），用召回打分取相关者（上限 30）。

**② 记忆形态（去分类，单条总结）**
- `MemEntry` 从 `{ fact, cat: 信息/偏好/关系/事件/待定 }` 改为 `{ fact, keywords[], important, ts, src, ns }`——**不再分类**，每条记忆 = 一段总结性记忆。
- `autoMemorize` 从"提取多条分类事实"改为"把这段对话提炼成**一条**总结"。
- **总结字数随 N**：选 1-10 轮 → 每条记忆 ≤**100 字**；选 11-20 轮 → ≤**200 字**（批次越大允许越详实），prompt 明确限长、要求简练抓重点。

**③ 关键记忆（识别"总是/以后都/永远"等词）**
- `important=true` 标记关键记忆：用户表达「总是、以后都、永远、一直、记住、我绝对、我特别喜欢/讨厌、无论如何」等绝对化长期约定时，由提炼器标为关键记忆，**必须长期遵守、始终优先注入**；容量淘汰时关键记忆也最后被清。
- 网页召回注入标 `【关键】`；导出 md 分「关键记忆（必须遵守）/ 普通记忆」两节置顶；`memory_save` 工具可传 `important`。

**④ 关键词识别注入**
- `keywords[]`：每条记忆可带触发词。聊天消息命中关键词 → 该记忆**强相关必被召回**（`scoreEntry` 加权），实现"提到咖啡就想起用户喜欢咖啡"这类关键词注入。
- 提炼器自动提取 2-5 个关键词；记忆页编辑单条可填触发词；`memory_save` 工具可传 `keywords`。
- 关键记忆恒优先（打分封底 `+5`），关键词命中再加权（`+6`/个）。

**改动文件**：`src/core/memoryStore.ts`（结构/召回/导出）、`src/core/schema.ts`（auto_rounds 默认 10、上限 20）、`src/server.ts`（autoMemorize 新 prompt + 限字 + 注入格式 + 记忆 API）、`src/tools/registry.ts`（memory_save 去分类加 important/keywords）、`web/app.js`（记忆页去分类，加"关键记忆"开关与触发词输入）、`web/style.css`（关键/触发词样式）。

**验证**：
- `node tools/verify-memory-ns.mjs`（作用域隔离 + 关键记忆优先召回 + 关键词命中注入 + 导出关键/普通分组）。
- `node tools/verify-memory-summary.mjs`（窗口：29 轮不总结、30 轮取最早 10 轮；真实模型：单条总结 ≤100 字、识别"以后都"→important=true、≥2 关键词）。
- `npm run build` + `node tools/check-appjs.mjs` + 重启 stack。

### 6.14 记忆页 UI 调整：N 上限 20、去手动添加、关键记忆开关与分区查看（2026-09-01）

按用户反馈调整记忆页交互：

| 改动 | 说明 |
|---|---|
| **N 上限 50 → 20** | `schema.ts` 的 `auto_rounds` `max(50) → max(20)`；前端两处 `max="20"` 与保存逻辑 `Math.min(20, ...)`（记忆页 + 卡片高级配置） |
| **去掉"手动添加记忆"** | 记忆页删除添加输入行、触发词/关键勾选输入与 `addMemEntry`；用户只能**编辑/删除**现有记忆（记忆由自动总结与 `memory_save` 工具产生）。后端 `POST /api/memory/:slug` 保留（工具用），前端无入口 |
| **关键记忆用椭圆形开关** | 编辑行的"关键"由 checkbox 改为**椭圆形 switch**（`web/style.css` 新增 `.switch` 组件：滑块动画、on=红色）；`renderMemEditRow` 用 `<span class="switch">` 包裹 checkbox，保存读取 `.mem-edit-key.checked` 不变 |
| **关键记忆分区查看** | 记忆列表顶部**独立「关键记忆」红色分区**（`mem-key-section`：红框 + 红底标题条 + 盾牌图标），关键记忆单列置顶、易读；普通记忆在主列表按时间倒序。搜索时关键记忆仍在主列表高亮（`mem-key-row` 红底+左侧色条） |
| 页面说明文案 | 记忆页 hint 更新：说明"由聊天自动总结生成，可单条编辑/删除"，并注明"N=1-20"、"顶部关键记忆为必须长期遵守的约定" |

**验证**：
- `node tools/verify-memory-ui.mjs`（vm 沙箱：N 上限 20、无添加入口、关键开关、关键分区元素存在 + `renderMemory()` 运行不崩）。
- `npm run build` + `node tools/check-appjs.mjs`。
- **浏览器需强制刷新（Ctrl+F5）**：web/ 为静态文件，改动不重启后端，浏览器缓存的旧 app.js 会让改动"看起来没生效"。

---

## 7. 启动与验证

```powershell
# 一键启动（首次先以管理员运行一次 add-firewall-rule.bat 放行 17880）
powershell -ExecutionPolicy Bypass -File scripts\start-stack.ps1

# 停止
powershell -ExecutionPolicy Bypass -File scripts\stop-stack.ps1
```

验证清单：

```bash
curl http://127.0.0.1:17880/api/health          # 网页后端（免登录）
curl http://127.0.0.1:17900/health              # TTS
openclaw health                                  # 网关（应见 QQ Bot: configured）
netstat -ano | findstr "17880 18789 17900"       # 三个端口都在监听
```

**分泡效果实测**：在 QQ 里让机器人回一条长回复，应看到多段独立气泡、无 `---` 横线。

---

## 8. 桌面图标（可选，便于使用）

用 PowerShell 创建（脚本见当时部署用的 `C:\zcodeai\tools\ps-make-shortcuts.ps1`，
或直接手建两个快捷方式）：

| 图标 | 指向 |
|---|---|
| OpenClaw 管理台 | `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\zcodeai\openclaw-shell\scripts\open-console.ps1` |
| OpenClaw 停止 | `powershell -NoProfile -ExecutionPolicy Bypass -File C:\zcodeai\openclaw-shell\scripts\stop-stack.ps1` |

开机自启：把 `scripts\autostart.bat` 放入 `shell:startup`（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）。

---

## 9. 常见问题

- **局域网其他电脑打不开 17880**：多半是 Windows 防火墙未放行。右键管理员运行
  `scripts\add-firewall-rule.bat`；或手动 `netsh advfirewall firewall add rule
  name=openclaw-shell-web dir=in action=allow protocol=TCP localport=17880`。
- **TTS 403 / 无声**：`data\ttsConfig.json` 的 `local.engine` 应为 `"sapi"`（离线），
  网页「语音合成」页可改回 Edge/云上游。
- **改了 openclaw.json 不生效**：必须重启网关（重跑 start-stack.ps1）。
- **插件列表里 qqbot 消失**：确认 `plugins.entries.openclaw-qqbot.enabled=true` 且
  `plugins.load.paths` 里生图插件路径存在，重跑 `openclaw plugins list`。
- **PowerShell 5.1 中文乱码**：仓库所有 .ps1 保持纯 ASCII 注释（本文件例外，属文档）。
