// 四维蒸馏：用 LLM 从脱敏后的聊天记录里抽取人格维度
// 调用走 OpenAI 兼容接口（默认预填自有中转，可用环境变量覆盖）
import type { Dimension, DistillItem, LLMConfig, NormalizedMessage } from "./types.js";
import { RELATION_ROLES, type PersonaCard } from "../core/schema.js";

const ROLE_ZH: Record<(typeof RELATION_ROLES)[number], string> = {
  self: "自己",
  friend: "朋友",
  family: "家人",
  partner: "前任/恋人",
  colleague: "同事",
  "public-figure": "偶像/角色",
};

export function llmConfigFromEnv(): LLMConfig {
  return {
    baseUrl: process.env.OPENCLAW_SHELL_API_BASE ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENCLAW_SHELL_API_KEY ?? "",
    model: process.env.OPENCLAW_SHELL_MODEL ?? "gpt-4o-mini",
  };
}

export function llmConfigReady(cfg: LLMConfig): boolean {
  return Boolean(cfg.apiKey);
}

// 每条结果都要带 kind，落卡时按 kind 分流到对应字段。
// 不分类的话所有内容都会被塞进一个数组（性格特质里混着价值观和禁区），
// 而卡片的「价值观 / 情绪反应 / 禁区 / 时间线 / 人际关系」几个区块会永远空着。
const DIMENSION_INSTRUCTIONS: Record<Dimension, string> = {
  interaction: `抽取「互动风格」，每条用 kind 标明类别：
- kind="catchphrase"：口头禅、常用语（text 只写这句话本身）
- kind="tone"：说话习惯、句式长度、语气特征
- kind="quote"：值得保留的原话样本（evidence 必须是 verbatim）
另外整体判断三项，各输出一条：
- kind="length"，text 填 short / medium / long（单条消息长度倾向）
- kind="multi_send"，text 填 true / false（是否爱一次连发多条）
- kind="emoji"，text 填 关闭 / 克制 / 贴近原始（表情符号使用程度）`,
  personality: `抽取「人格」，每条用 kind 标明类别：
- kind="trait"：性格特质
- kind="value"：价值观、做事原则
- kind="emotion"：情绪反应模式，text 写成「触发条件→反应」（用箭头分隔）
- kind="boundary"：边界与禁区（不能碰的话题、绝不做的事）`,
  memory: `抽取「记忆」，每条用 kind 标明类别：
- kind="fact"：具体事实（附 scope 说明范围）
- kind="relation"：人物关系，text 写成「某人→关系描述」（用箭头分隔）
- kind="timeline"：有日期的事件，text 写成「日期→发生了什么」（用箭头分隔）`,
};

function buildSystemPrompt(
  role: (typeof RELATION_ROLES)[number],
  dimension: Dimension
): string {
  return `你是「人物蒸馏引擎」。目标人物与用户的关系：${ROLE_ZH[role] ?? role}（说话人 A=目标人物，B=对话对象）。

任务：从脱敏聊天记录中${DIMENSION_INSTRUCTIONS[dimension]}

要求：
1. 输出严格 JSON 数组，不要 Markdown，不要多余文字
2. 每条格式：{"text":"...","kind":"上面列出的类别","evidence":"verbatim|artifact|impression","topic":"可选分类","scope":"可选范围"}
3. evidence 分级：verbatim=原话直接支持；artifact=对话中提及的事实；impression=你的推断（会单独隔离）
4. 不编造：记录里没有的不要写
5. 数量：最多 30 条，覆盖尽量广
6. 这是脱敏后的数据，不要把任何 PII 原样输出`;
}

const FALLBACK: Record<Dimension, DistillItem[]> = {
  interaction: [
    { text: "（dry-run）语气偏短句，爱用关心式开场", evidence: "impression" },
  ],
  personality: [
    { text: "（dry-run）待接入 API 后生成", evidence: "impression" },
  ],
  memory: [
    { text: "（dry-run）待接入 API 后生成", evidence: "impression" },
  ],
};

/** 调用 OpenAI 兼容 chat completions，返回解析后的 JSON 数组 */
export async function callLLM(cfg: LLMConfig, system: string, user: string): Promise<DistillItem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`LLM 调用失败: ${e instanceof Error && e.name === "AbortError" ? "超时(60s)" : String(e)}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM 调用失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  // 找到第一个 [ 到最后一个 ]
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("LLM 未返回 JSON 数组");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("LLM 返回的不是数组");
  return parsed.map((it) => ({
    text: String(it.text ?? "").trim(),
    evidence: (["verbatim", "artifact", "impression"].includes(it.evidence) ? it.evidence : "impression"),
    kind: it.kind ? String(it.kind).trim().toLowerCase() : undefined,
    topic: it.topic ? String(it.topic) : undefined,
    scope: it.scope ? String(it.scope) : undefined,
  })).filter((it) => it.text);
}

/** 把消息流切成窗口，逐窗口抽取（骨架版：单次全量，超出 maxMessages 截尾） */
export async function extractDimension(
  cfg: LLMConfig,
  role: (typeof RELATION_ROLES)[number],
  dimension: Dimension,
  messages: NormalizedMessage[],
  opts: { dryRun?: boolean; maxMessages?: number } = {}
): Promise<DistillItem[]> {
  const window = (opts.maxMessages ?? 500) || messages.length;
  const sliced = messages.slice(-window);
  const convo = sliced
    .map((m) => `${m.senderName}: ${m.text}`)
    .join("\n");

  if (opts.dryRun || !llmConfigReady(cfg)) {
    return FALLBACK[dimension];
  }
  return callLLM(cfg, buildSystemPrompt(role, dimension), convo);
}

/** 把抽取结果写回人设卡（蒸馏专用，覆盖对应维度并保留证据分级） */
/** 把「触发→反应」这类箭头写法拆成两段 */
function splitArrow(text: string): [string, string] {
  const parts = text.split(/\s*(?:→|->|=>|：|:)\s*/);
  if (parts.length >= 2) return [parts[0].trim(), parts.slice(1).join("：").trim()];
  return [text.trim(), ""];
}

export function applyExtraction(card: PersonaCard, items: DistillItem[], dimension: Dimension): void {
  const clean = items.filter((i) => i.text);
  const byKind = (k: string) => clean.filter((i) => i.kind === k);
  // 模型没照格式带 kind 的不能丢，兜到该维度主字段
  const untagged = clean.filter((i) => !i.kind);

  switch (dimension) {
    case "interaction": {
      card.voice.catchphrases = byKind("catchphrase").slice(0, 12).map((i) => i.text.slice(0, 40));
      card.voice.quotes = clean
        .filter((i) => i.kind === "quote" || (!i.kind && i.evidence === "verbatim"))
        .slice(0, 20)
        .map((i) => ({ text: i.text.slice(0, 100), evidence: i.evidence, topic: i.topic }));
      card.voice.tone_rules = [...byKind("tone"), ...untagged.filter((i) => i.evidence !== "verbatim")]
        .slice(0, 10)
        .map((i) => i.text);
      // 消息风格是单值判断
      const len = byKind("length")[0]?.text?.toLowerCase();
      if (len === "short" || len === "medium" || len === "long") card.voice.message_style.length = len;
      const multi = byKind("multi_send")[0]?.text?.toLowerCase();
      if (multi === "true" || multi === "false") card.voice.message_style.multi_send = multi === "true";
      const emoji = byKind("emoji")[0]?.text?.trim();
      if (emoji === "关闭" || emoji === "克制" || emoji === "贴近原始") card.voice.message_style.emoji = emoji;
      break;
    }
    case "personality": {
      card.personality.traits = [...byKind("trait"), ...untagged].slice(0, 12).map((i) => i.text);
      card.personality.values = byKind("value").slice(0, 10).map((i) => i.text);
      card.personality.boundaries = byKind("boundary").slice(0, 10).map((i) => i.text);
      card.personality.emotion_patterns = byKind("emotion")
        .slice(0, 10)
        .map((i) => {
          const [trigger, response] = splitArrow(i.text);
          return { trigger, response: response || trigger };
        })
        .filter((p) => p.trigger);
      break;
    }
    case "memory": {
      card.memory.facts = [...byKind("fact"), ...untagged]
        .filter((i) => i.evidence !== "impression")
        .slice(0, 30)
        .map((i) => ({ fact: i.text, evidence: i.evidence, scope: i.scope }));
      card.memory.relationships = byKind("relation")
        .slice(0, 15)
        .map((i) => {
          const [who, how] = splitArrow(i.text);
          return { who, how: how || who, evidence: i.evidence };
        })
        .filter((r) => r.who);
      card.memory.timeline = byKind("timeline")
        .slice(0, 20)
        .map((i) => {
          const [date, event] = splitArrow(i.text);
          return { date, event: event || date, evidence: i.evidence };
        })
        .filter((t) => t.date);
      break;
    }
  }
}
