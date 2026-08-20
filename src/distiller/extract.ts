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

const DIMENSION_INSTRUCTIONS: Record<Dimension, string> = {
  interaction: `抽取「互动风格」：说话习惯、口头禅、句式长度、多行/拆条倾向、表情符号使用、回复节奏、语气特征。
每条输出一项风格规则（text），evidence 用 verbatim（原话可证）/ impression（推断印象）。`,
  personality: `抽取「人格」：性格特质、价值观、情绪反应模式（触发→反应）、边界与禁区。
每条输出一项（text），evidence 用 verbatim / artifact（事实）/ impression。`,
  memory: `抽取「记忆」：涉及的具体事实、人物关系、共同经历、时间线事件（含日期）。
每条输出一项（text，附 topic 或 scope），evidence 用 verbatim / artifact；没有原话依据的只允许 impression。`,
};

function buildSystemPrompt(
  role: (typeof RELATION_ROLES)[number],
  dimension: Dimension
): string {
  return `你是「人物蒸馏引擎」。目标人物与用户的关系：${ROLE_ZH[role] ?? role}（说话人 A=目标人物，B=对话对象）。

任务：从脱敏聊天记录中${DIMENSION_INSTRUCTIONS[dimension]}

要求：
1. 输出严格 JSON 数组，不要 Markdown，不要多余文字
2. 每条格式：{"text":"...","evidence":"verbatim|artifact|impression","topic":"可选分类","scope":"可选范围"}
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
export function applyExtraction(card: PersonaCard, items: DistillItem[], dimension: Dimension): void {
  const clean = (arr: DistillItem[]) => arr.filter((i) => i.text);
  switch (dimension) {
    case "interaction": {
      const quotes = clean(items)
        .filter((i) => i.evidence === "verbatim")
        .slice(0, 20)
        .map((i) => ({ text: i.text.slice(0, 100), evidence: i.evidence, topic: i.topic }));
      card.voice.quotes = quotes;
      card.voice.tone_rules = clean(items)
        .filter((i) => i.evidence !== "verbatim")
        .slice(0, 10)
        .map((i) => i.text);
      break;
    }
    case "personality": {
      card.personality.traits = clean(items).slice(0, 12).map((i) => i.text);
      break;
    }
    case "memory": {
      card.memory.facts = clean(items)
        .filter((i) => i.evidence !== "impression")
        .slice(0, 30)
        .map((i) => ({ fact: i.text, evidence: i.evidence, scope: i.scope }));
      break;
    }
  }
}
