# 项目快速上手（给新任务 / 新 AI 会话）

> 目标：**你（接手的新 AI）打开这份文档，5 分钟内知道项目在哪、怎么跑起来、改什么、注意什么**。
> 详细复刻步骤见 `REPLICATE.md`；本文是"今天就要开始干活"的速览。

---

## 1. 这是什么

`openclaw-shell` —— 一个本地运行的角色扮演 AI 图形化外壳：
- **网页管理台**：人设卡（做卡/导入 CCv2）、本地聊天、QQ/微信机器人绑定、预设（破甲档×叙述风格）、表情包库、生图、TTS、记忆、设置。
- **底层**：OpenClaw（`openclaw` CLI + 网关）负责 QQ/微信通道，本仓库是它的管理界面 + 卡片编译层。
- **定位**：完全本地自包含，不需要任何云服务/Cloudflare。

## 2. 怎么跑起来（最重要）

项目在 `C:\zcodeai\openclaw-shell`。所有脚本在 `scripts\`。

```powershell
# 一键启动（网页 17880 + 网关 18789 + TTS 17900）
powershell -ExecutionPolicy Bypass -File C:\zcodeai\openclaw-shell\scripts\start-stack.ps1

# 停止
powershell -ExecutionPolicy Bypass -File C:\zcodeai\openclaw-shell\scripts\stop-stack.ps1
```

- 网页：`http://127.0.0.1:17880`（局域网：`http://192.168.0.119:17880`，免登录）
- 验证：`curl http://127.0.0.1:17880/api/health`；网关日志 `data\gateway.log`
- **改代码后**：`npm run build` + 重启 start-stack（前端 `web/` 改完刷新浏览器即可，不用重启后端）

## 3. 环境（本机已配好，不要重装）

| 工具 | 位置 |
|---|---|
| Node.js 24.20.0 | `C:\zcodeai\tools\nodejs`（已加入用户 PATH，新开终端生效） |
| Git 2.55 | `C:\zcodeai\tools\git\cmd` |
| OpenClaw CLI 2026.6.34 | `%APPDATA%\npm\node_modules\openclaw\openclaw.mjs` |
| 插件 | `openclaw-qqbot` 2.0.3、`openclaw-weixin` 2.4.6（npm 装的）、`openclaw-shell-imagegen`（仓库 `--link`） |

> 当前 shell 可能 PATH 没刷新：命令前加 `set PATH=C:\zcodeai\tools\nodejs;%APPDATA%\npm;%PATH%`。

## 4. 代码地图（改哪里）

| 文件/目录 | 干什么 |
|---|---|
| `src/server.ts`（~3000 行） | 网页后端：所有 `/api/*`、聊天、AI 写卡、机器人、调度器。**改接口先看这里** |
| `src/core/cardStore.ts` | 卡片存储（`data/cards/<slug>/persona.json`）、`findProjectRoot()` 自动探测项目根 |
| `src/core/schema.ts` | 卡片数据模型（persona-card/1）：身份/声音/性格/记忆/预设引用/emojiGroups/life 等 |
| `src/core/presets.ts` | 角色扮演预设：档位（不破甲/破甲最高）× 风格（纯对话/重描写）+ 全局输出护栏 |
| `src/core/chatPrompt.ts` | 网页聊天 system prompt 拼装（卡片 → 提示词） |
| `src/core/compiler.ts` | 卡片编译成 OpenClaw 的 SKILL.md（通道端生效） |
| `src/core/emojiStore.ts` | 表情包：分组体系 + 按卡片多选分组注入 |
| `src/core/lifeScheduler.ts` | AI 生命：主动发消息调度（间隔/静默时段/时间情绪/防骚扰） |
| `src/core/greetedStore.ts` | 开场白状态（按用户记录，避免重复开场） |
| `src/core/sanitize.ts` | 出站文本清理（剥思维链） |
| `plugins/openclaw-shell-imagegen/` | 通道插件：生图 + 表情发送（`emoji_send` 工具） |
| `web/app.js` | 前端全部逻辑（原生 JS，单文件 ~5000 行）；`web/style.css` 样式 |
| `data/` | 运行数据（卡片/记忆/日志/配置），gitignore，不入库 |
| `REPLICATE.md` | **另一台电脑复刻指南**（§6.x 记录了我们全部定制） |
| `DEPLOY.md` | 原始部署说明 |

## 5. 关键机制速览（接手前必读）

1. **卡片 → 聊天**：`/api/chat` 读卡片 → `buildChatSystemAsync` 拼 system（含档位/风格/护栏/表情/开场白上下文）→ `runToolLoop` 调模型 → `sanitizeChatReply` 清理返回。
2. **卡片 → 通道（QQ/微信）**：`compileForBot` → `compiler.ts` 编译 SKILL.md 到 agent workspace → OpenClaw 按路由把消息投给对应 agent。绑定时 `agents add --bind qqbot:<accountId>`。
3. **预设**：档位管尺度（破甲=露骨+反制），风格管叙述形式，**示例对话跟随风格**（`<example>` 块注入对话开头做 few-shot），全局护栏始终追加。
4. **表情包**：库按分组；卡片高级配置**多选分组**（`emojiGroups` 数组）→ AI 只从这些组选表情；通道端插件 `emoji_send` 发图。
5. **开场白**：`greeted.json` 按用户记录；本地聊天打开卡片时原子领取（首次显示，之后不重复）；通道端靠 SKILL.md 规则（新会话才开场）。
6. **AI 生命**：`lifeScheduler` 每分钟 tick → 对开了主动消息的卡，用 `openclaw system event --mode now --session-key <agentId>:<accountId>:<openid>` 唤醒 agent 主动发消息；0-6 点静默、时间情绪注入。
7. **机器人绑定**：卡片高级配置 → 选已认证账号直连（免扫码）；账号被占用二次确认换卡。

## 6. 改代码标准流程

```powershell
cd C:\zcodeai\openclaw-shell
set PATH=C:\zcodeai\tools\nodejs;%PATH%
npm run build            # tsc → dist/（改 src/ 后必做）
node C:\zcodeai\tools\check-appjs.mjs   # 改 web/app.js 后查语法
# 重启：stop-stack.ps1 + start-stack.ps1
```

提交：`git add -A && git commit -m "说明"`（本地仓库，未关联远程 push；origin 指向 sunfollower-hello/openclaw-shell）。

## 7. 常见坑（血泪教训）

1. **硬编码路径**：插件/脚本里曾有 `D:/ai_workspace/...` 旧路径。新机器/改目录后**先 grep `D:/|ai_workspace`**。详见 REPLICATE §6.6。
2. **PowerShell 5.1 中文乱码**：`.ps1` 必须纯 ASCII；`Set-Content -Encoding UTF8` 会重写整个文件（曾把 app.js 弄成 1052 行假 diff），**改 web/app.js 用 Edit 工具，别用 PowerShell 写**。
3. **`<a>` 链接默认蓝色**：新加 `<a>` 当按钮必须 `color: var(--text); text-decoration: none`。
4. **findstr 中文/正则坑**：`findstr /n "xxx"` 对中文文件匹配不到（GBK vs UTF-8）；含 `[`、`"` 会被当正则。定位代码用 PowerShell `Select-String` 或 `findstr /n /c:"精确串"`。
5. **Node 内联 `node -e` 在这个 shell 常静默失败**：写 `.mjs` 文件再 `node 文件`。
6. **改 openclaw.json / 插件后必须重启网关**（start-stack 重跑）；改前端只刷新浏览器。
7. **预设/表情/开场白/主动消息都在 `data/`**，删对应 json 会回退到代码内置默认（presets.json 会重建）。
8. **端口残留**：`netstat -ano | findstr :17880` → `taskkill /PID <pid> /F`。

## 8. 当前状态与已知事项

- **服务在跑**：网页 17880 / 网关 18789 / TTS 17900，全部健康。
- **测试卡**：`test-obey`（完全听命于用户的测试用角色）。
- **未完成/待验证**：
  - QQ/微信通道绑定尚未实测（known-users.json 为空 → 主动消息/开场白通道端需真机验证）。
  - 防火墙 17880 放行需管理员（`scripts\add-firewall-rule.bat` 右键管理员运行一次）。
  - 模型提供商：网关当前用 `基元/deepseek-v4-flash-0731`；网页「API 与模型」可再配。
- **git**：本地 main，7+ 次提交，工作区干净。

## 9. 新任务常见起点

| 你想做什么 | 从哪开始 |
|---|---|
| 调角色扮演效果（破甲/风格/护栏） | `src/core/presets.ts` + 网页「预设」页 |
| 改聊天行为/加能力 | `src/server.ts` `/api/chat` + `chatPrompt.ts` |
| 改通道机器人行为 | `compiler.ts`（SKILL.md）+ 插件 `plugins/openclaw-shell-imagegen` |
| 改 UI | `web/app.js` + `web/style.css` |
| 排查通道问题 | `data/gateway.log` + `openclaw` CLI 手工验证 |
| 换机器/复刻 | 照 `REPLICATE.md` 从头做 |

---

*生成于 2026-08-31。随项目维护；与 `REPLICATE.md`（复刻）、`DEPLOY.md`（原始部署）配套。*
