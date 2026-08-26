# 聊天体验与约束逻辑优化方案（v1）

> 日期：2026-08-26 · 状态：待用户把关（不慌改）
> 背景：用户实测后反馈分段/字数/发图/发语音/表情/预设等约束逻辑"用着不舒服"
> 依据：三份实地调研——①中文 bot 生态（AstrBot/CoW/LangBot/MaiBot/chatluna/mio/Shiro）；②SillyTavern 生态（预设/长度/世界书/生图/TTS）；③商业 AI 伴侣（C.AI/Janitor/Nomi/Replika）与破甲模板公开写法。全部带来源，见文末。

---

## 一、现状问题清单（上轮实测确认）

| 模块 | 现状 | 不舒服点 |
|---|---|---|
| 分段/条数 | 靠提示词"拆 2-4 条、空行分隔"，前端按空行切 | 模型自觉，无硬上限；`length`×`multi_send` 两维度可能打架；前后端各一套节奏 |
| 字数 | 仅 `voice.message_style.length`（短/中/长），无 max_tokens 硬参 | 模型随意发挥，长短不可控 |
| 发图 | 工具调用 + 回复文本带 `/img/...` URL 前端正则匹配渲染 | ①模型偶尔拒绝调工具（角色压制）；②**渲染依赖模型恰好把 URL 写进最终文本**；③未配置 key 时只报文字错 |
| 发语音 | 网页 🔊 按钮 + abilities.tts 自动朗读；**通道无** | 触发不可控；通道能力缺失（已决定暂不改） |
| 表情 | `[表情:名字]` 文本标记渲染（有解释注入） | 无概率/冷却/去重，模型可能滥用或不用 |
| 预设 | 档位×风格 两维度 prompt 文本 | 缺采样参数维度（温度/max_tokens 等）；片段顺序固定不可调 |
| 生图配置 | 单档参数（seed/sampler/负面可配但存一份） | 无"风格预设"多套切换（ST 的 {prefix,negative} 三件套） |
| 语音配置 | 音色/语速全局一份 | 无"角色→音色"绑定；触发策略不可配 |
| 做卡 | 表单 + 蒸馏四维 | 无角色卡"话术模板"预设（开场白长度/字段组织），蒸馏结果文风不可控 |

## 二、调研关键结论（别人怎么做的）

1. **分段是"发信层切分"，不是"模型自觉"**：成熟 bot 全都是**后处理按标点/语义切分**（AstrBot `segmented_reply` 正则 `[。？！~…]`、bubble-splitter 三级切分、MaiBot 独立小模型语义切）＋ **硬约束**（`max_segments` 上限如 5、`words_count_threshold` 超过 150 字不分段整条发、段间对数延时、per-session 锁防交错）。**SillyTavern 和 C.AI/Replika/Janitor/Nomi 明确不拆条**——网页端正解是单气泡流式打字机（C.AI 就是流式逐字+空行分段），拆条是 QQ/Telegram bot 场景的做法。
2. **QQ 官方机器人频控是硬边界**：被动回复单聊 60 分钟 4 次、群聊 5 分钟 5 次；AstrBot 官方渠道默认**禁分段**（宁可不拟人也不碰频控）。拆条条数必须 ≤ 配额，或走官方流式接口（`/v2/users/.../stream_messages`）实现打字机。
3. **字数靠 max_tokens 参数 + 提示词正表述**：ST 是 `max_tokens` 滑条 + `assistant_prefill` 预填 + Continue 续写；提示词用"回复<=30字"正表述（chatluna 伪装预设），负面列表写 don't 会反向放大（Karukaru BaseJB 作者实测）。
4. **图片主动发送 = 工具调用 + 场景上下文（SceneContext）**：`pc_generate_photo` 工具发图前先组装"时段/地点/穿搭/情绪"，保证图不脱节（astrbot_plugin_private_companion）；概率触发生图（Clawmate `probability: 0.1~0.3`）；**没有成熟项目靠"从模型文本里提取 URL 发图"**——工具调用是唯一主流。
5. **语音触发三层决策**（Shiro）：LLM 先决策 voice/text/block + 全局概率 + 安全词禁读；CyberPersona 每轮结构化输出 `sendVoiceNow: bool`；OpenClaw 原生 `messages.tts.auto = off/always/inbound/tagged`（tagged=模型输出 `[[tts]]` 才触发）；掘金反例教训——**不要默认每条都语音**。腾讯系语音 = SILK v3（ffmpeg→PCM 24k mono→pilk 编码→`\x02` 头）。
6. **表情包 = LLM 意图 → 语义匹配 → 概率+冷却+去重**：mio（情绪/场景/内容三维向量）、dsh-expression（`send_meme query=` 工具，搜不到就不发）；moellmchats 实测模型每句都想发表情，**概率要手动压到 0.1**；QQ 原生贴图可给一批 emoji_id 让模型输出 id 做 reaction（chatluna 伪装预设）。
7. **预设的正规形态（ST）**：预设 = **采样参数块（temp/top_p/max_tokens…）+ prompt 片段列表（main/jailbreak/worldInfoBefore/chatHistory 可拖拽排序、每片段可设 role/位置/触发）**。生图风格预设 = `{name, prefix, negative}` 三件套。语音 = 角色→音色字典（Voice Map）+ 三段式多音色（引号/动作/旁白各配一音色）。
8. **做卡/话术模板**：首条消息长度就是模型的话术模板（模型最服从开场白长度——30 张高分卡实测首条中位 178 词）；永久字段（personality+scenario）控制 800~1500 token；开场白用"社交压力动作"留钩子、不以提问结尾。
9. **破甲写法共识**：MAIN（格式+篇幅）+ JAILBREAK（叙述者身份+防跑偏）双段；XML 三件套（Session/Requirement/Ban）**拒绝用否定词**；篇幅硬约束放"注意力最高处"。我们现有档位文案结构已吻合，只需补"篇幅硬约束"和"正面表述"两条原则。
10. **OpenClaw 原生就是这套**：`blockStreamingChunk{minChars,maxChars,breakPreference:sentence}` + `humanDelay{natural}` 已支持"按句切块发送"——我们的通道端只要把提示词+配置用对，不需要自己发明。

## 三、分模块方案（结合 openclaw-shell 现状）

### A. 消息分段 / 条数 / 字数 —— 从"模型自觉"改为"分层控制"

**设计：提示词定风格 → 采样参数定长度 → 发信层切分定条数（硬约束）**

1. **网页端（对齐 C.AI）**：单气泡 + 流式打字机渲染 + 空行分段。模型输出按句子自然流出（SSE 流式或逐块拼接），不再"拆成多条气泡"。`multi_send` 语义改为"回复内部多用换行分段"，前端打字机渲染。字数由 `max_tokens` 参数控制（见下）。
   - 保留现有"空行分段逐条冒泡"作为可选模式（`depth` 卡片设置），默认改打字机。
2. **通道端（QQ/微信）**：发信层切分：
   - 分段规则：优先级 语义块（空行）→ 标点句（`[。！？～…~]` 边界，参考 AstrBot 正则）→ 长段按字数兜底（对齐 bubble-splitter：`target≈32 字、hard_max≈48`）；
   - **硬约束**：`max_segments` 默认 4（QQ 官方被动配额群聊 5 条内；单聊 4 条内单聊场景自动限 3），`words_count_threshold=150`（>150 字整条发不分段）；
   - 段间延时：对数/随机（AstrBot `log` 模式），按 per-session 队列 + 锁防交错；
   - 超长兜底：>400 字拆最大 3 段或截断（对齐 Hermes 5000 字符兜底思路上调为通道平台限制）。
3. **字数（卡片级新字段 `chat.max_tokens`）**：默认 300（对齐 ST Default），卡片高级配置加滑条/输入；提示词改正表述（如"每条回复不超过 60 字"由 max_tokens 推算提示），`length` 档位映射到 token 区间（short≈150/medium≈300/long≈600）。
4. **消除维度打架**：`multi_send` 与 `length` 合并语义——`length` 决定单条总长，`multi_send` 只决定"要不要在内部断句换行"，提示词不再同时给"中等长度+拆条 2-4 条"这种矛盾指令。

### B. 图片发送 —— 工具调用为主，结构化返回，渲染零依赖

1. **保留工具路线**（主流），修三处：
   - **强化工具引导**：档位/卡片提示词加一行（正面表述）"用户要求或场景需要视觉呈现时，请调用 image_gen 工具"（放注意力高处，对齐破甲"篇幅约束写高处"原则）；
   - **渲染不依赖模型文本**：工具返回改为结构化（`{ image: "/img/...", caption }`，聊天 API 响应新增 `images: string[]` 字段），前端按 `images` 渲染图片气泡，模型最终文本带不带 URL 都不影响发图——彻底解决"模型没写 URL 就不显示"；
   - **SceneContext 约束**：image_gen 工具参数加可选 `scene`（时段/地点/情绪由模型填），注入生图 prompt 前缀，图不脱节（对齐 pc_generate_photo）。
2. **概率主动发图（可选开关，通道尤其适合）**：卡片开关 + `probability 0.1~0.3`（对齐 Clawmate），模型在剧情/情绪合适时"随手发一张"；应用于通道时图随 MEDIA 协议发送。
3. **key 缺失时**：工具返回明确错误文本（现状已有），但再把"去生图配置页"提示留在前端 toast，避免模型角色化转述吞掉指引。

### C. 语音 —— 触发决策化（网页先行，通道待 TTS 启用后）

1. **触发三层**（对齐 Shiro/CyberPersona/OpenClaw）：
   - 卡片 `abilities.tts` 从布尔改为档位：`off / 手动（🔊按钮，现状）/ 自动（网页自动朗读，现状）/ 智能（LLM 每轮决策 sendVoiceNow + 概率 + 安全词禁读）`；
   - 智能档：prompt 让模型在回复前输出 `[[voice]]` 标记（对齐 OpenClaw `tagged` 模式），前端/通道检测标记才合成语音；`[[block]]` 标记禁止本条；概率层兜底（每条 20% 上限）。
2. **角色→音色字典**（对齐 ST Voice Map）：`ttsConfig.json` 加 `voiceMap: { 卡 slug/角色名: provider+voice }`，`DEFAULT`/`DISABLED` 保留字；卡高级配置可选音色。
3. **多段多音色（阶段 2）**：引号对白/星号动作/旁白三段各配音色（ST `parseMessageSegments` 思路）。
4. 通道 SILK（阶段 2，TTS 重新启用时）：`synthesizeTts` 输出 SILK（ffmpeg→PCM 24k→Node silk 编码→`\x02` 头），走 `[[audio_as_voice]]`。

### D. 表情包 —— 从"文本标记"升级为"意图匹配 + 概率 + 去重"

1. 保留 `[表情:名字]` 标记，新增**正反馈约束**：提示词改"需要表达情绪时使用表情，每次最多 1 个，别每句都用"（对齐 moellmchats 教训）。
2. **概率 + 冷却**（阶段 2）：`emotion_rate=0.15` 字段 + 每卡 N 分钟内最多发 K 条（防刷屏）。
3. **语义选择（阶段 2）**：表情解释文本已存在（explanation 字段），LLM 只输出意图短语（"开心"），系统按 explanation 关键词匹配 → 无匹配不发（对齐 dsh-expression）。
4. **QQ reaction（可选，通道）**：给内置一批 QQ emoji_id（对齐 chatluna 伪装预设），模型输出 id → 官方接口贴到消息上。

### E. 预设体系升级 —— 补"采样参数"维度 + 片段排序

1. **预设三元组**（对齐 ST）：`档位×风格` 保持（prompt 文本），**新增第三个正交维度"生成参数"**（temperature/top_p/max_tokens/seed），内置 3 套：`标准`、`稳健`（低温度，剧情推进）、`发散`（高温度，创意/破甲场景）。卡高级配置三个下拉：档位/风格/参数。
2. **prompt 片段顺序可调**（阶段 2）：把 system prompt 拆成命名片段（card设定/tier/style/能力规则/jailbreak）供拖拽排序——低成本先做"固定推荐顺序 + 每片段开关"。
3. **模板变量**：预设文本支持 `{{char}}`（角色名）/`{{user}}`（用户昵称）替换（对齐 ST 宏）。
4. **破甲文案修正**（基于调研）：现有破甲档位补"篇幅硬约束"（正表述）与"防跑偏"段已达标，去掉任何否定式长清单（Karukaru 教训：don't 列表反向放大）。

### F. 生图预设 —— Style 三件套（低成本高价值）

1. `imageConfig.json` 加 `styles: [{ name, prefix, negative }]`（对齐 ST defaultStyles），默认 2 套（标准/柔和），生图配置页 UI 下拉切换——比现有"固定负面词"灵活。
2. 卡级"固定妆造前缀"（可选 export，对齐 ST character-specific prefix）：角色卡存 `imagePrefix`，生图时自动拼在前缀。

### G. 做卡预设 —— 角色卡"话术模板" + 蒸馏文风预设

1. **做卡向导加"角色卡模板"选择**：内置 3 类——`日常陪伴`（开场白 2-3 句口语、轻描写默认）、`深度剧情`（开场白 150-300 字场景、重描写默认、鼓励世界书条目）、`群聊气泡`（开场白 1-2 条短句、纯对话默认）。选中即预填开场白示例/风格/档位建议（对齐"首条消息长度=话术模板"结论）。
2. **蒸馏文风预设**：蒸馏生成的卡默认附一段"话术模板"（从蒸馏样本的开场白长度统计得出），让人设卡天生带正确长度示范。

## 四、实施优先级（建议分批）

- **P0（改动小、立刻解决实测痛点）**：B1（工具强引导+结构化 images 渲染）、A3（max_tokens 字段+正表述提示）、A4（合并 multi_send×length 提示词）、E4（破甲文案正表述微调）。
- **P1（体验核心）**：A1 网页流式打字机、A2 通道发信层切分+硬约束（max_segments/150 字阈值/log 延时/会话锁）、C1 语音智能档 `[[voice]]` 标记、E1 生成参数维度（3 套内置）、F1 生图 Style 预设。
- **P2（增强，排后）**：C2 角色音色字典、C4 通道 SILK、D3 表情语义匹配、E2 片段排序、G1 做卡模板、B2 概率主动发图、D4 QQ reaction。

## 五、待把关点

1. 网页端默认改**流式打字机**（单气泡）还是保留"拆多条气泡"？调研结论是网页不该拆条（C.AI 模式），但你们现有"逐条冒出"也有用户喜欢——做成设置项？
2. 通道端拆条硬上限（max_segments=4）是否接受？（QQ 官方被动配额单聊 4/60min，超过会被平台拒）
3. 语音"智能档"要现在做网页端吗？（通道 TTS 仍按之前决定不动）
4. 生成参数维度（温度/max_tokens）三套内置是否够？要不要给卡级自定义参数保存？
5. 做卡模板 3 类划分是否合理？

## 附：调研来源（三份报告的完整 URL 清单见各 Agent 输出）

- 中文生态：AstrBot docs/issues/PR、CoW issue#1078、LangBot、moellmchats、MaiBot smart_segmentation_plugin、chatluna-character、mio、Shiro personification、CyberPersona、QQ 官方频控文档、pilk/graiax-silkcoder、掘金 QQ 语音实践
- SillyTavern：docs.sillytavern.app（presets/prompt-manager/common-settings/worldinfo/stable-diffusion/tts）、GitHub 仓库预设 JSON、issue#2394/#3371/#4213/#4367、Agnai、RisuAI
- 商业伴侣：Character.AI 逆向 gist/官方博客、Janitor AI 帮助文档、Nomi 主动消息 wiki、Replika 评测、bubble-splitter、openclaw-persona-template、rentry 破甲模板、狐狐教程、Karukaru BaseJB、DeepSeek 破甲实例、Chub 官方角色卡示例