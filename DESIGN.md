# OpenClaw 图形化外壳 —— 人设卡与蒸馏工厂设计方案

> 版本: v0.1 (设计稿) · 日期: 2026-08-20
> 定位: 开源获客 + 自建 API 中转赚钱的 QQ/微信 AI 机器人软件
> 核心差异化: 引导流程 + 人设卡系统 + 聊天记录蒸馏（数字分身）

---

## 0. 设计原则

1. **源格式与产物分离**：GUI 只编辑 `persona.json`（单一事实源），编译层把卡片渲染成 OpenClaw 原生产物（SOUL.md / SKILL.md / memory）。
2. **对齐既有标准，不发明新标准**：人设卡兼容 Agent Skills 标准（SKILL.md frontmatter）、OpenClaw Soul Spec（SOUL.md 行为规则）、SillyTavern Spec V2（角色卡生态）、immortal-skill 蒸馏结构（四维人格 + 证据分级）。
3. **本地优先**：聊天记录、卡片、记忆全部本地存储；蒸馏与聊天的 LLM 调用都走用户自己配置的 API，不绑定任何渠道、不干预用户选择。
4. **隐私与伦理内置**：脱敏默认开启、证据分级、矛盾保留、授权记录、防注入、correction 闭环。

---

## 1. 总体架构

```
openclaw-shell/
├── app/                          # 界面层（Electron 或本地 Web 配置台）
│   ├── wizard/                   # 接入引导：平台选择 → 扫码/安装 → 连通测试
│   ├── persona-editor/           # 人设卡可视化编辑器
│   └── distillery/               # 蒸馏工厂向导（导入→脱敏→蒸馏→试聊）
├── core/
│   ├── persona/                  # 卡片 schema、校验器、版本管理、本地卡库
│   ├── compiler/                 # persona.json → OpenClaw 产物（SOUL.md/skill/memory）
│   ├── distiller/                # 蒸馏流水线
│   │   ├── parsers/              # weflow / qq / 纯文本 解析器 → 统一消息流
│   │   ├── redact/               # PII 脱敏引擎 + 脱敏报告
│   │   ├── extract/              # 四维蒸馏 LLM 提示词 + 关系模板
│   │   └── quality/              # 卡片质量校验器
│   ├── relay/                    # API 客户端（OpenAI 兼容，默认预填自有中转）
│   └── store/                    # SQLite：卡片索引、会话、配置
├── openclaw/                     # OpenClaw 托管：子进程管理、配置生成、Gateway 状态
├── channels/                     # 通道适配：openclaw-weixin（官方）/ napcat（QQ）
└── docs/
```

数据流（一次完整使用）：

```
用户导出聊天记录 → 导入 → 脱敏 → 四维蒸馏(LLM) → persona.json → 编译 → OpenClaw 生效
                                                        ↓
                                          试聊 → 纠错 → correction 层写回
```

---

## 2. 人设卡格式（persona-card v1.0，源格式）

单一 JSON 文件，GUI 的编辑对象，也是蒸馏工厂的输出物。示例：

```jsonc
{
  "schema": "persona-card/1",
  "id": "uuid-v4",
  "name": "奶奶",
  "slug": "grandma",                 // 必须与产物目录名一致（Agent Skills 标准）
  "version": 3,
  "created_at": "2026-08-20T10:00:00+08:00",
  "updated_at": "2026-08-20T18:30:00+08:00",
  "license": "MIT",

  // —— 来源与授权（伦理层）——
  "source": {
    "kind": "distill",               // distill | manual | import
    "inputs": [
      { "platform": "wechat", "scope": "family-group", "file": "data/family.json", "messages": 3540 }
    ],
    "fingerprint": "sha256:...",     // 输入指纹，防重复导入
    "consent": {
      "granted": true,
      "person": "奶奶（本人）",
      "scope": "仅个人回忆与陪伴使用",
      "recorded_at": "2026-08-20"
    }
  },

  // —— 身份锚点（→ personality.md / 卡封面）——
  "identity": {
    "role": "family",                // self|friend|family|partner|colleague|public-figure
    "relation": "奶奶",
    "bio": "80 岁的北方奶奶，说话直接但心软",
    "tags": ["长辈", "方言", "勤俭"],
    "avatar": "local/path.png"       // 或 base64 小图
  },

  // —— 声音（→ SOUL.md 行为规则 + interaction.md）——
  "voice": {
    "tone_rules": [
      "话不多，但每句都落在关心上",
      "爱用'多喝水''早点睡'开场",
      "生气时不发火，是句号变多"
    ],
    "catchphrases": ["多喝水", "别乱花钱", "嗯呐"],
    "message_style": {
      "length": "short",             // short|medium|long
      "multi_send": true,            // 一句话拆多条发
      "emoji": "克制"                 // 关闭|克制|贴近原始
    },
    "quotes": [                       // 真实语录样本库（脱敏后，用于复用语气）
      { "text": "多喝水，别又熬夜", "evidence": "verbatim", "topic": "关心" }
    ]
  },

  // —— 人格（→ personality.md）——
  "personality": {
    "traits": ["刀子嘴豆腐心", "节俭", "固执"],
    "values": ["不浪费", "家和万事兴"],
    "emotion_patterns": [
      { "trigger": "家人吵架", "response": "先沉默，再劝和" }
    ],
    "boundaries": ["不借钱", "不聊已故亲友的伤疤"]
  },

  // —— 记忆（→ memory.md，分库）——
  "memory": {
    "facts": [
      { "fact": "爷爷 2019 年去世，忌辰清明全家扫墓", "evidence": "artifact", "scope": "family" }
    ],
    "timeline": [
      { "date": "2019-04", "event": "爷爷去世", "evidence": "artifact" }
    ],
    "relationships": [
      { "who": "小儿子", "how": "最心疼，嘴上总念叨", "evidence": "verbatim" }
    ]
  },

  // —— 程序性知识（可选，→ procedural.md，如"怎么包饺子"）——
  "procedural": {
    "how_we_do_things": [
      { "topic": "腌咸菜", "steps": "...", "evidence": "verbatim" }
    ]
  },

  // —— 知识边界（防编造）——
  "knowledge": {
    "known": ["孙辈的小名", "老家地址"],
    "unknown": ["智能手机操作", "近两年的网络流行语"],
    "no_evidence_policy": "降低确定性或追问，不编造"
  },

  // —— 多场景变体（同一人不同表现）——
  "variants": {
    "partner": { "voice_delta": { "tone_rules": ["更撒娇"] } }
  },

  // —— 聊天行为配置（GUI 可调，渲染进 skill 运行时规则）——
  "chat": {
    "quote_style": "reuse",          // reuse 复用真实语录 | original 原创
    "delay": { "base_ms": 1500, "variance": 0.4, "merge_burst": true },
    "trigger": { "dm": "any", "group": "@" }
  },

  // —— 预设（RP-Hub 生态兼容）——
  "presets": {
    "jailbreak": "",                 // 破甲预设
    "worldbook": []                  // 世界书条目（keyword→content）
  },

  // —— SillyTavern Spec V2 兼容段（导出到卡生态用）——
  "sillytavern_v2": {
    "chara_card_v2": "0.0.1",
    "description": "",
    "personality": "",
    "scenario": "",
    "first_mes": "",
    "mes_example": "",
    "character_book": { "entries": [] }
  },

  // —— 伦理与版本（元信息）——
  "ethics": {
    "redacted": true,
    "redact_report": "reports/redaction.json",
    "no_raw_quotes_in_prompt": true  // 蒸馏时原话不进 system prompt，只进样本库
  }
}
```

关键决策：
- **证据分级**：每个记忆/语录条目带 `evidence`（verbatim 原话 > artifact 事实 > impression 印象），蒸馏时 impression 单独隔离，防止模型把猜测当事实。
- **矛盾保留**：蒸馏出的矛盾（conflicts）不强行洗白，编译时单独生成 `conflicts.md` 供 OpenClaw 在对话中处理（"人本来就前后不一致"）。
- **变体优先默认**：`variants` 对应 OpenClaw 的多 agent 路由，一个卡可编译成多个 agent 或一个 skill 多个入口。

---

## 3. 编译层：persona.json → OpenClaw 产物

编译器产出（每个卡片一个目录，放在 OpenClaw workspace）：

```
~/.openclaw/workspace/skills/personas/<slug>/
├── SKILL.md            # Agent Skills 标准入口（<100 行）
├── personality.md      # 人格维度
├── interaction.md      # 互动风格维度（含语录样本索引）
├── memory.md           # 记忆维度
├── procedural.md       # 程序性知识（可选）
├── conflicts.md        # 矛盾证据
└── manifest.json       # 注册元数据（slug/persona/sources/版本）
~/.openclaw/workspace/SOUL.md   # 声线规则（voice.tone_rules → 祈使句规则）
```

SKILL.md frontmatter（对齐 Agent Skills + OpenClaw 标准）：

```yaml
---
name: grandma                     # 与目录名一致
description: "用奶奶的语气、记忆和关心方式与用户对话。适用场景：日常陪伴、回忆聊天、被问到家庭往事时检索 memory.md。"
license: MIT
metadata:
  openclaw:
    requires:
      bins: []
    emoji: "👵"
  personas: ["family"]
  platforms: ["wechat", "qq"]
---
```

SOUL.md 生成规则：把 `voice.tone_rules` + `personality.boundaries` 转成祈使句行为规则（OpenClaw Soul Spec 是自由格式行为规则，不是 schema——所以编译是模板拼接，不是字段映射）。

---

## 4. 蒸馏工厂流水线

分 6 个阶段，每阶段可独立重跑，产物持久化：

```
P0 接入 → P1 解析+脱敏 → P2 分路蒸馏 → P3 卡片组装 → P4 质量校验 → P5 编译部署 → P6 试聊纠错
```

### P0 数据接入（向导驱动）
| 来源 | 方式 | 产物 |
|---|---|---|
| 微信 | 引导安装 WeFlow 导出 JSON/HTML | 统一消息流 |
| QQ | 官方客户端导出 txt/mht | 同上 |
| 粘贴文本 | 直接粘贴 | 同上 |
| 截图（可选） | 本地 LLM/视觉模型 OCR | 文本流 |

### P1 解析 + 脱敏（本地，无 LLM）
- 各格式 parser → 统一的 message 流（sender/ts/text/media）
- PII 脱敏：手机号、邮箱、身份证、银行卡、IP、地址、年龄（Presidio 规则 + 自定义屏蔽词表）
- 输出：`redact_report.json`（替换映射），脱敏后数据才进下一步

### P2 四维分路蒸馏（LLM，消耗 API）
- 按关系模板（见 §5）选择蒸馏 prompt
- 四个维度分开提取（不一次全提，防稀释）：interaction / personality / memory / procedural
- 每条产出带 `evidence` 标签；impression 隔离；矛盾写入 conflicts
- 蒸馏调用走用户自己配置的 API（与聊天同一套配置）

### P3 卡片组装
- 蒸馏结果 → persona.json（§2 格式）
- 语录样本库：按主题聚类，脱敏后的原话样本（仅存本地，不进 prompt）

### P4 质量校验（自动 + 可人工）
- 风格完整度：消息长度分布、问句占比、多行消息占比、表情/符号倾向（缺什么 warning）
- 样本泄漏检查：蒸馏产物不得含未脱敏原文
- 身份边界：不得包含"我是 AI"类污染；注入防护检查
- 输出校验报告，不达标提示补材料

### P5 编译部署
- 编译器 → §3 产物 → 写入 OpenClaw workspace → `openclaw gateway restart`
- 自动注册到卡库，可被 QQ/微信通道直接调用

### P6 试聊 + 纠错闭环
- 内置本地试聊页（浏览器打开 localhost）
- 用户说"ta 不会这样说" → 写入 correction 层 → 增量再蒸馏（追加，不覆盖已有维度，版本快照 + 回滚）

---

## 5. 关系模板

| 模板 | 输入重点 | 伦理底线 | 记忆侧重 |
|---|---|---|---|
| self 自己 | 全量 | 数据自己做主 | 全维度 |
| friend 朋友 | 共同经历、社交偏好 | 对方知情同意 | 友谊互动 |
| family 家人 | 生活智慧、唠叨语气 | 家人知情同意 | 家族记忆、时间线 |
| partner 前任/恋人 | 争吵模式、共同记忆 | 严格脱敏、正面回忆 | 关系互动 |
| colleague 同事 | 工作流程、沟通风格 | 仅团队内部 | 程序性知识 |
| public-figure 偶像/角色 | 公开资料 | 可追溯出处 | 人物弧线、经典语录 |

---

## 6. 与产品其他模块的集成

1. **引导流程**：wizard 里"创建人设卡"两条路——手动编辑 / 蒸馏导入；蒸馏导入对小白是卖点，对开发者是编辑起点。
2. **API 中转**：relay 默认预填自有中转 base_url（new-api 后端），用户可改任意 OpenAI 兼容地址。聊天消耗走这里 → 收入；蒸馏只用用户自己配置的 API，不干预。
3. **OpenClaw 托管**：统一管理 openclaw 安装/升级/Gateway 启动；版本不匹配时给出修复指引（openclaw-weixin 插件与 core 版本线绑定）。
4. **通道**：微信单聊走官方 openclaw-weixin；QQ 走 napcat；群聊能力由通道能力声明驱动，界面按通道能力隐藏不可用选项。

---

## 7. MVP 落地路线

1. **M1 人设卡内核**：schema + 校验器 + 本地卡库 + 手动编辑器（不依赖 OpenClaw，先跑通）
2. **M2 编译器**：persona.json → SOUL.md + skill 目录 + manifest，装进 OpenClaw 生效
3. **M3 蒸馏流水线**：WeFlow 微信导入 → 脱敏 → 四维蒸馏 → 卡片 → 试聊纠错
4. **M4 通道接入**：openclaw-weixin（扫码登录引导）+ napcat（QQ）
5. **M5 商业化**：relay 预填 + new-api 计费 + 代部署服务说明页

---

## 8. 风险与合规清单

- 蒸馏真实人物需知情同意；项目内展示免责声明与授权记录流程
- 聊天记录导出属于用户本地数据，软件不得上传（蒸馏仅调 LLM 文本接口）
- API 中转需 ICP 备案 + 内容安全过滤 + 防滥用（限流/封 key）
- OpenClaw 依赖：版本升级兼容、插件灰度、单聊限制需在产品内明示
