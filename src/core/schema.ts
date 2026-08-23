// persona-card v1.0 schema —— 人设卡单一事实源格式
// 对齐：Agent Skills 标准 / OpenClaw Soul Spec / SillyTavern Spec V2 / immortal-skill 蒸馏结构
import { z } from "zod";

export const SCHEMA_VERSION = "persona-card/1";

export const RELATION_ROLES = [
  "self",
  "friend",
  "family",
  "partner",
  "colleague",
  "public-figure",
] as const;

export const EVIDENCE_LEVELS = ["verbatim", "artifact", "impression"] as const;

export const EMOJI_LEVELS = ["关闭", "克制", "贴近原始"] as const;

const evidence = z.enum(EVIDENCE_LEVELS);

// ---------- 来源与授权 ----------
const sourceSchema = z.object({
  kind: z.enum(["distill", "manual", "import"]).default("manual"),
  inputs: z
    .array(
      z.object({
        platform: z.enum(["wechat", "qq", "paste", "screenshot", "other"]),
        scope: z.string().optional(),
        file: z.string().optional(),
        messages: z.number().int().nonnegative().optional(),
      })
    )
    .default([]),
  fingerprint: z.string().optional(),
  consent: z
    .object({
      granted: z.boolean().default(false),
      person: z.string().optional(),
      scope: z.string().optional(),
      recorded_at: z.string().optional(),
    })
    .default({ granted: false }),
});

// ---------- 身份锚点 ----------
const identitySchema = z.object({
  role: z.enum(RELATION_ROLES).default("friend"),
  relation: z.string().optional(),
  bio: z.string().max(500).optional(),
  tags: z.array(z.string()).default([]),
  avatar: z.string().optional(),
});

// ---------- 声音（→ SOUL.md + interaction.md） ----------
const quoteSchema = z.object({
  text: z.string(),
  evidence: evidence,
  topic: z.string().optional(),
});

const voiceSchema = z.object({
  tone_rules: z.array(z.string()).default([]),
  catchphrases: z.array(z.string()).default([]),
  message_style: z
    .object({
      length: z.enum(["short", "medium", "long"]).default("medium"),
      multi_send: z.boolean().default(false),
      emoji: z.enum(EMOJI_LEVELS).default("克制"),
    })
    .default({}),
  quotes: z.array(quoteSchema).default([]),
});

// ---------- 人格（→ personality.md） ----------
const personalitySchema = z.object({
  traits: z.array(z.string()).default([]),
  values: z.array(z.string()).default([]),
  emotion_patterns: z
    .array(
      z.object({
        trigger: z.string(),
        response: z.string(),
      })
    )
    .default([]),
  boundaries: z.array(z.string()).default([]),
});

// ---------- 记忆（→ memory.md） ----------
const memorySchema = z.object({
  facts: z
    .array(
      z.object({
        fact: z.string(),
        evidence: evidence,
        scope: z.string().optional(),
      })
    )
    .default([]),
  timeline: z
    .array(
      z.object({
        date: z.string(),
        event: z.string(),
        evidence: evidence,
      })
    )
    .default([]),
  relationships: z
    .array(
      z.object({
        who: z.string(),
        how: z.string(),
        evidence: evidence,
      })
    )
    .default([]),
});

// ---------- 程序性知识（可选，→ procedural.md） ----------
const proceduralSchema = z.object({
  how_we_do_things: z
    .array(
      z.object({
        topic: z.string(),
        steps: z.string(),
        evidence: evidence,
      })
    )
    .default([]),
});

// ---------- 知识边界（防编造） ----------
const knowledgeSchema = z.object({
  known: z.array(z.string()).default([]),
  unknown: z.array(z.string()).default([]),
  no_evidence_policy: z
    .string()
    .default("降低确定性或追问，不编造"),
});

// ---------- 多场景变体 ----------
const variantsSchema = z
  .record(z.string(), z.object({ voice_delta: voiceSchema.partial().optional() }))
  .default({});

// ---------- 聊天行为配置 ----------
const chatSchema = z.object({
  quote_style: z.enum(["reuse", "original"]).default("reuse"),
  thinking: z.enum(["off", "auto", "low", "medium", "high", "extreme"]).default("auto"),
  delay: z
    .object({
      base_ms: z.number().int().nonnegative().default(1500),
      variance: z.number().min(0).max(1).default(0.4),
      merge_burst: z.boolean().default(true),
    })
    .default({}),
  trigger: z
    .object({
      dm: z.enum(["any", "allowlist", "disabled"]).default("any"),
      group: z.enum(["@", "any", "disabled"]).default("@"),
    })
    .default({}),
});

// ---------- 预设（RP-Hub 生态兼容） ----------
const presetsSchema = z.object({
  jailbreak: z.string().default(""),
  worldbook: z
    .array(
      z.object({
        keyword: z.string(),
        content: z.string(),
      })
    )
    .default([]),
});

// ---------- SillyTavern Spec V2 兼容段（世界书/正则/简介/开场白） ----------
const worldbookEntry = z.object({
  keys: z.array(z.string()).default([]),
  secondary_keys: z.array(z.string()).default([]),
  content: z.string().default(""),
  name: z.string().optional(),
  comment: z.string().optional(),
  enabled: z.boolean().default(true),
  selective: z.boolean().default(false),
  constant: z.boolean().default(false),
  insertion_order: z.number().default(100),
  priority: z.number().default(10),
  id: z.number().optional(),
  // 酒馆卡(SillyTavern CCv2/v3)兼容字段：保留原样，编辑/导出不丢
  position: z.string().optional(),
  use_regex: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

const sillytavernSchema = z.object({
  chara_card_v2: z.literal("0.0.1").default("0.0.1"),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  first_mes: z.string().default(""),
  mes_example: z.string().default(""),
  alternate_greetings: z.array(z.string()).default([]),
  regex_scripts: z.array(z.record(z.string(), z.unknown())).default([]),
  character_book: z
    .object({ entries: z.array(worldbookEntry).default([]) })
    .default({ entries: [] }),
});

// ---------- 伦理与版本 ----------
const ethicsSchema = z.object({
  redacted: z.boolean().default(false),
  redact_report: z.string().optional(),
  no_raw_quotes_in_prompt: z.boolean().default(true),
});

// ---------- 工具（能力层，让机器人不只是聊天） ----------
export const TOOL_IDS = [
  "code_exec",
  "web_search",
  "weather",
  "datetime",
  "memory_save",
  "image_gen",
] as const;

const toolsSchema = z
  .object({
    enabled: z.array(z.enum(TOOL_IDS)).default([]),
    policy: z.enum(["auto", "ask"]).default("auto"),
    deny: z.array(z.string()).default([]),
  })
  .default({});

// ---------- 高级配置：能力开关（每卡，普通聊天/机器人的默认行为） ----------
const cardAbilitiesSchema = z
  .object({
    skills: z.boolean().default(true), // 技能库（代码专家/翻译/写作/陪伴）
    tts: z.boolean().default(false), // 自动朗读回复（网页聊天）
  })
  .default({});

// ---------- 表情包（最多 120 个，每个带解释供 AI 理解） ----------
const emojiSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "表情名不能为空"),
  file: z.string(),
  explanation: z.string().default(""),
});

// ---------- 卡片独立模型配置（每张卡可用不同 API/模型） ----------
const cardModelSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
  })
  .default({});

// ---------- 记忆配置（每 N 轮自动总结一次，默认 20，1-50） ----------
const memoryConfigSchema = z
  .object({
    auto_rounds: z.number().int().min(1).max(50).default(20),
  })
  .default({});

// ---------- 卡片主体 ----------
export const personaCardSchema = z.object({
  schema: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().uuid().optional(),
  name: z.string().min(1, "name 不能为空"),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug 只能是小写字母/数字/连字符，且以字母数字开头"),
  version: z.number().int().positive().default(1),
  created_at: z.string().datetime({ offset: true }).optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
  license: z.string().default("MIT"),
  source: sourceSchema.default({}),
  identity: identitySchema.default({}),
  voice: voiceSchema.default({}),
  personality: personalitySchema.default({}),
  memory: memorySchema.default({}),
  procedural: proceduralSchema.optional(),
  knowledge: knowledgeSchema.default({}),
  variants: variantsSchema,
  chat: chatSchema.default({}),
  presets: presetsSchema.default({}),
  tools: toolsSchema,
  model: cardModelSchema,
  abilities: cardAbilitiesSchema,
  memoryConfig: memoryConfigSchema,
  emojis: z.array(emojiSchema).max(120).default([]),
  sillytavern_v2: sillytavernSchema.optional(),
  ethics: ethicsSchema.default({}),
});

export type PersonaCard = z.infer<typeof personaCardSchema>;

export const defaultCard = (name: string, slug: string): PersonaCard =>
  personaCardSchema.parse({
    name,
    slug,
    // 空白卡：世界书第一条固定为「人物形象」（角色定义核心，常驻生效）
    sillytavern_v2: {
      chara_card_v2: "0.0.1",
      character_book: {
        entries: [
          {
            keys: ["人物形象"],
            content:
              "（在这里完整定义角色：基本信息、外貌、性格、语言风格、背景故事、喜好雷区等。这一条常驻生效，是角色扮演的核心依据）",
            name: "人物形象",
            comment: "人物形象",
            constant: true,
            insertion_order: 0,
          },
        ],
      },
    },
  });
