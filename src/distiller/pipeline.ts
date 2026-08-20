// 蒸馏流水线编排：导入 → 解析 → 脱敏 → 四维蒸馏 → 组装人设卡
import { promises as fs } from "node:fs";
import { parseWeFlowJson } from "./parser.js";
import { redactMessages } from "./redact.js";
import { applyExtraction, extractDimension, llmConfigFromEnv, llmConfigReady } from "./extract.js";
import { DIMENSIONS, type DistillItem, type LLMConfig, type NormalizedMessage, type RedactReport } from "./types.js";
import { defaultCard, type PersonaCard } from "../core/schema.js";
import { CardStore, newCardId, nowIso } from "../core/cardStore.js";

export interface DistillOptions {
  file?: string;
  rawJson?: unknown;
  name: string;
  slug?: string;
  role: PersonaCard["identity"]["role"];
  target: string; // 目标人物名（聊天中的昵称），空则用第一个非我方 talker
  selfNames: string[]; // 我方昵称，用于区分说话人
  dryRun?: boolean;
  maxMessages?: number;
  blockedWords?: string[];
  llm?: LLMConfig;
}

export interface DistillReport {
  card: PersonaCard;
  talkers: string[];
  stats: {
    totalMessages: number;
    usedMessages: number;
    redact: RedactReport;
    dimensions: Record<string, { items: number; via: string }>;
  };
}

export async function runDistill(opts: DistillOptions): Promise<DistillReport> {
  // 1. 读取输入
  let raw: unknown = opts.rawJson;
  if (!raw && opts.file) {
    const ext = opts.file.toLowerCase();
    if (ext.endsWith(".json")) {
      raw = JSON.parse(await fs.readFile(opts.file, "utf8"));
    } else {
      throw new Error(`暂不支持 ${ext}，请先用 WeFlow 导出为 JSON`);
    }
  }
  if (!raw) throw new Error("需要 --file 或原始 JSON");

  // 2. 解析 + 脱敏
  const parsed = parseWeFlowJson(raw);
  const { messages: cleaned, report: redactReport } = redactMessages(parsed.messages, {
    blockedWords: opts.blockedWords,
  });

  // 3. 识别目标人物：默认取聊天中除"我方"外最活跃的 talker
  const selfSet = new Set(opts.selfNames);
  const counts = new Map<string, number>();
  for (const m of cleaned) {
    if (selfSet.has(m.senderName)) continue;
    counts.set(m.senderName, (counts.get(m.senderName) ?? 0) + 1);
  }
  let target = opts.target;
  if (!target) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    target = sorted[0]?.[0] ?? "对方";
  }

  // 4. 抽取目标人物的发言
  const targetMsgs: NormalizedMessage[] = cleaned.filter((m) => m.senderName === target);
  if (targetMsgs.length === 0) {
    throw new Error(`没找到目标人物「${target}」的发言；可用 --target 指定，或 --self-names 指定我方昵称`);
  }

  // 5. 四维蒸馏
  const cfg = opts.llm ?? llmConfigFromEnv();
  const dims: Record<string, { items: number; via: string }> = {};
  const extracted: Record<string, DistillItem[]> = {};
  for (const dim of DIMENSIONS) {
    const items = await extractDimension(cfg, opts.role, dim, targetMsgs, {
      dryRun: opts.dryRun,
      maxMessages: opts.maxMessages,
    });
    extracted[dim] = items;
    dims[dim] = { items: items.length, via: opts.dryRun || !llmConfigReady(cfg) ? "dry-run(未配置API)" : cfg.model };
  }

  // 6. 组装人设卡
  const card = defaultCard(opts.name, opts.slug ?? slugify(opts.name));
  card.id = newCardId();
  card.created_at = nowIso();
  card.updated_at = nowIso();
  card.identity.role = opts.role;
  card.identity.relation = target;
  card.source = {
    kind: "distill",
    inputs: [
      {
        platform: opts.file?.includes("qq") ? "qq" : "wechat",
        scope: target,
        file: opts.file,
        messages: parsed.messages.length,
      },
    ],
    consent: { granted: false }, // 需用户在界面确认授权
  };
  card.ethics = { redacted: true, no_raw_quotes_in_prompt: true };
  for (const dim of DIMENSIONS) applyExtraction(card, extracted[dim], dim);

  return {
    card,
    talkers: parsed.talkers,
    stats: {
      totalMessages: parsed.messages.length,
      usedMessages: targetMsgs.length,
      redact: redactReport,
      dimensions: dims,
    },
  };
}

function slugify(name: string): string {
  return /^[a-z0-9][a-z0-9-]*$/.test(name.toLowerCase())
    ? name.toLowerCase()
    : `persona-${Date.now().toString(36)}`;
}

/** 蒸馏完成后保存卡并编译（供 CLI/服务端共用） */
export async function saveDistilledCard(card: PersonaCard): Promise<PersonaCard> {
  const store = new CardStore();
  return store.save(card);
}
