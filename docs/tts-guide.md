# TTS（语音合成）构建指引

> 创建：2026-08-23 · 用途：TTS 专项的完整交接文档，新对话/新窗口读完本文即可接手
> 配套：`HANDOFF.md`（项目总交接）、`D:\ai_workspace\未来规划书.md`（TTS 开卖条件）

---

## 0. 一句话定位

**商业化架构：聚合上游 TTS（硅基流动等 OpenAI 兼容 API）→ 对外暴露一个 OpenAI 兼容接口卖给别人赚差价；本地合成（SAPI/Edge）只做测试和兜底，不卖钱。** 这是用户明确拍板的方向（"我是要赚钱的"），别再把本地当主力做。

已验证的事实：**Agnes 没有任何 TTS 模型**（/models 全列表查过，只有文本/图像/视频），卖 TTS 必须接新上游。上游第一版选定 **硅基流动 SiliconFlow**（用户拍板：OpenAI 兼容、国内直连、便宜、中文好）。计费策略：先做接口+记账，等 one-api/new-api 中转站（规划书 M5）。

## 1. 文件地图（改哪里找哪里）

```
src/core/ttsConfig.ts    核心模块：TtsProvider 多上游定义（kind: openai/minimax/volc）+ TtsConfig
                         + 合成后端：synthProvider=OpenAI 兼容 /v1/audio/speech、
                           synthMinimax=海螺 t2a_v2（hex/url 自动解码）、
                           synthVolc=豆包 openspeech V3（NDJSON base64）、
                           synthEdge=Edge 在线 / synthSapi=Windows 离线
                         + synthByKind 按 kind 分派 + synthesize() 总入口 + testTts()
                         + COMMON_EDGE_VOICES 22 个中文语音表
src/core/ttsUsage.ts     用量记账：recordUsage() 追加 jsonl / getUsageSummary() 汇总
src/tts-server.ts        独立售卖服务：POST /v1/audio/speech（OpenAI 兼容）+ /health，17900 端口
src/server.ts            管理台路由（搜 "语音合成（TTS）" 段）：/api/tts/* 共 8 个端点 + /tts 静态目录
web/app.js               前端：renderTtsPage/initTtsPage（**独立页 #/tts**，导航在生图配置下面）
                         + TTS_PRESETS 服务商预设（硅基流动/OpenAI 官方/MiniMax/火山豆包/自定义）
                         + 添加向导：选服务商 → 填 Key → 「保存并拉取模型」→ 模型/音色 chips 点选 → 完成
                         + addChatBubble 的 🔊 按钮 + speakText()（聊天朗读）
web/style.css            .tts-speak-btn 样式（气泡 hover 显示）
data/ttsConfig.json      运行配置（gitignored）：defaultProvider + local + providers[]
data/tts-usage.jsonl     用量流水（gitignored）：每行 {ts,provider,model,voice,chars,ms,bytes,ok,via}
data/ttsKeys.json        售卖 key 列表（gitignored，自建）：[{"key":"sk-xxx","name":"客户A"}]
data/tts/                朗读音频产物（gitignored）
package.json             scripts: "tts-server"（tsx 开发）/ "start:tts"（dist 生产）
```

## 2. 架构与数据流

```
                     ┌─ 管理台（17880，Basic 认证）
                     │   API 页 TTS 区块 → /api/tts/* → 读写 data/ttsConfig.json
                     │   聊天 🔊 朗读 → /api/tts/synthesize → 存 data/tts/ → 返回 url → 前端 new Audio 播放
                     │
data/ttsConfig.json ─┤
                     │
                     └─ 售卖服务（17900，独立进程 npm run tts-server）
                         客户 OpenAI SDK → POST /v1/audio/speech（Bearer key）
                         → 按 body.model 匹配上游（匹配不到用 defaultProvider，local 不可售卖会 503）
                         → 调上游 /audio/speech → 音频流返回客户 + 记账 via:"api"
```

合成后端选择逻辑（`synthesize(text, opts)`）：
- `opts.providerId` 显式指定 → 必须用该上游（未启用报错）
- 否则用 `defaultProvider`：是 provider id 且启用 → 走该上游；未启用 → **兜底本地**；是 "local" → 本地
- 合成后端按 `provider.kind` 分派：`openai` → POST {baseUrl}/audio/speech（硅基流动/OpenAI 官方等）；
  `minimax` → POST {baseUrl}/t2a_v2（text + voice_setting.voice_id + audio_setting，`output_format: url` 拿下载链接，hex/base64 兜底自动解码）；
  `volc` → POST {baseUrl}（X-Api-Key 新版单 Key / X-Api-App-Id+X-Api-Access-Key 旧版，X-Api-Resource-Id 按 `model` 字段，留空按音色名自动推断：S_→seed-icl-2.0、_uranus_/saturn_→seed-tts-2.0、其余→seed-tts-1.0；响应 NDJSON 逐行解析拼 base64）
- 本地：`local.engine` = sapi（离线必可用）或 edge（在线免费，本网络 403）
- **售卖接口（tts-server）不用 local 兜底**——没配上游时返回 503 提示，别把本地音质卖给客户

## 3. API 清单

管理台（挂 Basic 认证后）：
| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/tts/config` | GET/POST | 读/写配置（GET 时 key 打码、附 commonVoices；POST 只改 defaultProvider+local） |
| `/api/tts/providers` | POST | 新增或更新上游（带已存在 id=更新，key 留空=保留旧值；新 id 形如 `p_<ts36>`） |
| `/api/tts/providers/:id` | DELETE | 删上游（删的是默认则 defaultProvider 回落 local） |
| `/api/tts/fetch-models` | POST | body `{kind, baseUrl, key}` → `{models, voices}`：openai 拉 `{base}/models`（过滤 tts/speech/voice/audio/cosy/moss，过滤不到全给）+ 尽力拉 `{base}/audio/voice/list`；minimax/volc 返回内置可选列表 |
| `/api/tts/test` | POST | body `{target: "local"\|"providerId"}` 合成一小段测试，不记账 |
| `/api/tts/voices` | GET | Edge 全部语音列表（在线接口） |
| `/api/tts/synthesize` | POST | body `{text, providerId?, voice?, speed?}` → `{url:"/tts/xx.mp3", bytes}`，记账 via:admin |
| `/api/tts/usage` | GET | 用量汇总（总次数/成败/字符/24h/按上游/最近记录） |

售卖服务（独立认证）：
| 端点 | 说明 |
|---|---|
| `POST /v1/audio/speech` | 标准 OpenAI TTS：`{model, input, voice, response_format, speed}` → 音频二进制；响应头 X-TTS-Provider/X-TTS-Chars |
| `GET /health` | 服务状态 + 上游列表（key 打码） |

认证规则：remote 是 127.0.0.1 → 免 key；否则必须 Bearer 且 key 在 `data/ttsKeys.json`（数组 `[{"key","name"}]`）或环境变量 `TTS_API_KEYS="k1,k2"` 里；**一个 key 都没配时外部全部 401**。

## 4. 配置结构（data/ttsConfig.json）

```json
{
  "defaultProvider": "local",            // provider id 或 "local"
  "local": {
    "engine": "sapi",                     // "sapi"=Windows 离线（当前默认，必可用） | "edge"=在线（本网络 403）
    "voice": "zh-CN-XiaoxiaoNeural",      // edge 语音名（22 个常用在 COMMON_EDGE_VOICES）
    "rate": "+0%", "pitch": "+0Hz"        // edge 的语速/音调语法
  },
  "providers": []
}
```

`providers` 默认空，由前端「TTS 提供商 → ＋ 添加提供商」向导录入（服务商预设见 `web/app.js` 的 `TTS_PRESETS`：硅基流动 / OpenAI 官方 / MiniMax 海螺 / 火山豆包 / 自定义 OpenAI 兼容）。添加后形如：

```json
{
  "id": "siliconflow",                  // 内部 id（defaultProvider 引用它）
  "name": "硅基流动",                    // 显示名
  "kind": "openai",                     // 协议类型：openai=OpenAI 兼容 | minimax=海螺 t2a_v2 | volc=豆包 openspeech V3
  "baseUrl": "https://api.siliconflow.cn/v1",
  "key": "",                            // ← 注册后填入（PUT 时留空=保留旧值）
  "model": "FunAudioLLM/CosyVoice2-0.5B",
  "voice": "FunAudioLLM/CosyVoice2-0.5B:alex",   // 硅基流动音色必须带模型前缀 "模型:音色"
  "speed": 1,                           // openai 0.25~4；minimax 0.5~2 自动 clamp；volc 暂不支持忽略
  "markup": 1,                          // 加价倍率：one-api 计费预留字段，UI 已移除，当前不参与计算
  "enabled": false,                     // ← 填 key 后改 true 并设为 defaultProvider
  "appId": ""                           // 仅 volc：火山旧版鉴权 App ID；新版单 Key 鉴权留空
}
```

硅基流动要点（官方文档核对过）：端点 `POST /v1/audio/speech`；模型两个：`FunAudioLLM/CosyVoice2-0.5B`（自然语言指令控情感）和 `fnlp/MOSS-TTSD-v0.5`（双语对话合成）；音色名带模型前缀（alex/anna/bella/benjamin/claire/david/diana…）；response_format: mp3/opus/wav/pcm；speed 0.25~4；**stream 默认 true，我们代码里显式传 false**。

## 5. 启动与部署

```bash
cd /d/ai_workspace/openclaw-shell
npm run build                # 改 src 后必做（管理台跑的是 dist/server.js）
# 管理台（已由 start-stack 托管，改代码后需重启进程才生效）
npm run server               # 开发（tsx）  /  node dist/server.js 生产
# TTS 售卖服务（独立进程，按需启动，不在 start-stack 里）
npm run tts-server           # 开发；生产 node dist/tts-server.js；端口 TTS_PORT=17900 可改
```

服务器部署（开卖形态）：拷 `dist/ + package.json + node_modules`（或 npm i --omit=dev）+ `data/ttsConfig.json` + `data/ttsKeys.json`，跑 `node dist/tts-server.js` 即可，不需要管理台和 OpenClaw。建议挂 Cloudflare 或反代加 HTTPS。

## 6. 当前状态（2026-08-23 验证记录）

| 项 | 状态 |
|---|---|
| SAPI 离线合成 | ✅ 151KB wav 实测 |
| 售卖链路（mock 上游） | ✅ model 路由/默认路由/空文本 400/音频返回/记账 via:api 全过 |
| 真实聊天朗读 | ✅ 浏览器实测：Agnes 奶奶人设回复 → 🔊 → SAPI 合成播放 → usage+1 |
| API 页 TTS 区块 UI | ✅ 渲染/22 语音下拉/上游卡片/协议类型选择/用量显示/视觉检查通过 |
| edge 在线合成 | ❌ 本网络 WS 握手 403（语音列表接口 200，网络通）；保留选项，换网络可能恢复 |
| MiniMax 适配器 | ✅ 代码就绪（kind=minimax，t2a_v2 + url/hex 解码；build + 分派冒烟通过，无 key 未实测） |
| 火山豆包适配器 | ✅ 代码就绪（kind=volc，openspeech V3 + NDJSON 解析 + Resource ID 自动推断；无 key 未实测） |
| 添加向导（预设） | ✅ 独立页 #/tts：4 家服务商预设可选（硅基流动/OpenAI 官方/MiniMax/火山豆包/自定义），**不预写配置**；注册任一家→添加→填 key 即用，这是开卖唯一缺口 |
| 自动拉取模型 | ✅ `/api/tts/fetch-models`：openai 兼容走 `{base}/models`（过滤 tts 相关）+尽力拉音色列表；minimax/volc 返回内置可选列表（未注册 key 未实测真实拉取） |
| 加价倍率（markup） | 已从 UI 移除（数据模型保留，默认 1，one-api 计费预留，当前不参与计算） |
| 当前生效配置 | defaultProvider=local，local.engine=sapi（朗读开箱可用），providers 空 |

## 7. 开卖三步（等用户做）

1. 注册上游拿 key（任选一家或多家：siliconflow.cn / MiniMax 开放平台 / 火山引擎豆包语音 / OpenAI）→ 「语音合成」页 → ＋ 添加提供商 → 选服务商 → 填 key → 保存并拉取模型 → 点选模型/音色 → 完成 → 测试 → 启用（或直接启用+设默认通道）。OpenAI 官方国内需代理
2. `npm run tts-server` → 写 `data/ttsKeys.json` 发 key 给客户 → 客户 OpenAI SDK baseUrl 指 `http://服务器:17900/v1`，model 填你启用的上游 model（如 `FunAudioLLM/CosyVoice2-0.5B` / `speech-02-hd` / `seed-tts-2.0`）
3. 部署公网服务器（第 5 节），后续接 one-api 计费（用量数据已在 tts-usage.jsonl）

## 8. 踩坑记录（TTS 专属，接手必读）

1. **edge-tts npm 包 `main` 指向 index.ts**：必须 `import { tts } from "edge-tts/out/index.js"`（编译产物），否则 dist 下 node 跑不起来（dev 的 tsx 能跑会掩盖问题）
2. **Edge 在线合成本网络 403**：列表接口 `GET speech.platform.bing.com/.../voices/list` 200（322 语音）但 WS 合成握手 403——token/风控问题，不是代码 bug；本地兜底认准 SAPI
3. **SAPI 中文乱码**：PowerShell 5.1 按 BOM 识别 UTF-8，synthSapi 写 .ps1 脚本必须带 UTF-8 BOM（代码已处理）；文本里的单引号用 `''` 转义
4. **管理台改代码必须重启**：管理台跑的是 `node dist/server.js`，改 server.ts 后 build+杀进程重启才有新路由（netstat 找 17880 的 PID）
5. **/tts 音频在 Basic 认证后**：curl 测音频要带 `-u`；浏览器登录后 `<audio>` 会自动带凭据，用户无感
6. **售卖接口音频格式**：上游固定 mp3（response_format: mp3 透传给上游），但 SAPI 兜底产 wav——synthesize 路由按 RIFF 头判扩展名；tts-server 的 response_format 参数透传给上游，本地兜底不支持格式选择
7. **杀 tts-server**：npm 外层杀了 node 子进程会残留占 17900，`netstat -ano | grep :17900` 找 PID taskkill
8. **MiniMax 响应编码有坑**：文档说 data.audio 是 hex，但示例看着像 base64/zip——别赌编码。适配器请求 `output_format: "url"` 拿 24h 下载链接再 fetch，hex/base64 仅兜底（纯 hex 字符串按 hex 解码，否则 base64）
9. **豆包 Resource ID 必须跟音色对得上**：克隆音色（S_ 开头）→ seed-icl-2.0；官方 2.0（_uranus_/saturn_ 开头）→ seed-tts-2.0；官方 1.0（_mars_/_moon_）→ seed-tts-1.0。对不上报 55000000，适配器按 model 字段（留空按音色名自动推断）
10. **豆包鉴权两套**：新版单 API Key（X-Api-Key，推荐）+ 旧版 AppID/Token（X-Api-App-Id + X-Api-Access-Key）。配置里填了 `appId` 就走旧版（key 即 access token），否则新版。豆包 V3 暂不支持语速参数，speed 会被忽略
10.4 **QQ 语音条走「官方 API 直发」，不走 OpenClaw 投递**（2026-08-26 打通）：OpenClaw 核心只把 `responseFormat==="opus"` 标记为 voiceCompatible（`speech-provider:227`），给 silk 会被整条丢弃；qqbot 插件的 silk 分支依赖核心不存在的 `ttsRuntime.audioFileToSilkBase64`（死代码）。**实现在 `src/core/qqVoice.ts`**：`getAccessToken`（POST https://bots.qq.com/app/getAppAccessToken）→ `uploadMedia`（POST https://api.sgroup.qq.com/v2/users/{openid}/files，header `Authorization: QQBot {token}`，body `{file_type:3, file_data:base64}` → file_info）→ `sendMediaMessage`（POST /v2/users/{openid}/messages，`{msg_type:7, media:{file_info}}`）。插件 `plugins/openclaw-shell-tts` 的 `speak` 工具调用它；**工具 execute 拿不到会话上下文**，收件人从 `~/.openclaw/qqbot/data/known-users.json` 取最近交互者。三步已实测成功并在 QQ 收到语音条。
10.5 **QQ 语音条必须 silk**（2026-08-26 实测）：QQ 上传接口 `/v2/users/{openid}/files` 的 `file_type=3` 只接受 **silk**，mp3/wav 一律 `请求数据异常` → 插件回退发文件。链路：`response_format=silk` → tts-server `convertAudio(buf,"silk")` → `src/core/silk.ts` 用 silk-wasm encode 24kHz（**只能从 wav 编码**，所以 synthSapi 返回原始 wav、mp3 按需转）。让 OpenClaw 索取 silk 的开关是 `channels.qqbot.tts.providers.openai.extraBody={response_format:"silk"}`（核心请求体里 extraBody 在 response_format 之后展开，可覆盖）。注意：OpenClaw 核心 **没有** silk 能力（qqbot 插件的 `audioFileToSilkBase64` 分支是死代码），别指望装 silk-wasm 到插件目录
11. **新 kind 的 model 路由**：tts-server 按客户填的 model 匹配 `p.model === 客户 model || 客户 model 含 p.model 末段`——minimax 的 speech-02-hd、豆包的 seed-tts-2.0 都能命中，`seed-tts-2.0-expressive` 也会命中豆包

## 9. 待办与扩展点（按价值排序）

- [ ] **用户注册上游填 key**（硅基流动 / MiniMax / 火山豆包 / OpenAI 官方任选，开卖唯一前置；适配器+添加向导已就绪）
- [x] OpenAI 官方 TTS / MiniMax / 火山豆包 上游适配（2026-08-24：kind 扩为 openai/minimax/volc，MiniMax 与豆包适配器已实现并通过分派冒烟；OpenAI 官方直接走 openai kind 零代码）
- [x] TTS 独立页改造（2026-08-24：从 API 页区块迁到独立页 #/tts（导航在生图配置下）；添加方式同 API 配置——选服务商→填 key→自动拉取模型/音色 chips 点选；默认不再预置任何供应商；加价倍率字段从 UI 移除，数据模型保留待 one-api 计费）
- [ ] 新增上游实测：注册后填 key 逐家跑 `/api/tts/test`，验证真实合成 + 音频可播放（当前只验证了报错路径）
- [ ] GPT-SoVITS 声音克隆（付费增值）：加 `kind: "sovits"` 分支，需 NVIDIA 显卡，用户已有本地推理条件时做
- [ ] one-api/new-api 计费对接（等中转站，markup 字段就是为这准备的）
- [ ] 语音 STT（语音输入）——TTS 做了，STT 完全没做
- [ ] QQ/微信通道发语音（让机器人用 TTS 说话，对应规划书 MetaPact voice skill——依赖通道插件能力，复杂度高，单独专项）
- [ ] 客户 key 管理 UI（现在手写 ttsKeys.json；客户多了做管理界面+用量按 key 统计）
