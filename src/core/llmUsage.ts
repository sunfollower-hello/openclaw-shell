// 模型调用用量与「上下文缓存命中」记账：data/llm-usage.jsonl（每行一次调用）
// 目的：角色扮演的 system prompt（人设+预设+世界书+记忆）动辄几千 token，每轮都当新输入算钱很贵；
// DeepSeek 等上游对「缓存命中的输入」按 1/50 计价（命中省 ~98%），但命中要求**前缀逐字节稳定**。
// 没有实测数据就没法判断改动是否真的吃到缓存，所以这里把每次调用的
// 输入/输出/命中/未命中 token 都记下来，供日志与 /api/llm-usage 统计。
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface LlmUsageEntry {
  ts: string;
  provider: string;
  model: string;
  /** 调用来源：web=网页聊天 / memory=记忆总结 / distill=蒸馏 / other */
  kind: string;
  slug?: string;
  promptTokens: number;
  completionTokens: number;
  /** 命中缓存的输入 token（便宜的那部分） */
  cacheHitTokens: number;
  /** 未命中的输入 token（全价） */
  cacheMissTokens: number;
  /** 本次请求耗时 ms */
  ms?: number;
}

function usagePath(): string {
  return path.join(dataDir(), "llm-usage.jsonl");
}

/**
 * 从上游返回的 usage 对象里解析缓存字段。两种形状都要认：
 *  - DeepSeek 原生：prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *  - OpenAI 兼容（含 LiteLLM 归一化后）：prompt_tokens_details.cached_tokens（无 miss 字段，靠减法）
 * 拿不到缓存字段时 hit=0（当作未命中），不猜数字。
 */
export function parseUsage(raw: unknown): {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 上游是否真的报告了缓存字段（false = 无法判断命中情况，可能是中转没透传） */
  cacheReported: boolean;
} {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  // DeepSeek 原生字段
  let hit = num(u.prompt_cache_hit_tokens);
  let miss = num(u.prompt_cache_miss_tokens);
  let reported = typeof u.prompt_cache_hit_tokens === "number" || typeof u.prompt_cache_miss_tokens === "number";
  if (!reported) {
    // OpenAI 兼容形状
    const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
    if (typeof details.cached_tokens === "number") {
      hit = num(details.cached_tokens);
      miss = Math.max(0, promptTokens - hit);
      reported = true;
    }
  } else if (!miss && promptTokens) {
    miss = Math.max(0, promptTokens - hit);
  }
  return { promptTokens, completionTokens, cacheHitTokens: hit, cacheMissTokens: miss, cacheReported: reported };
}

/** 追加一条用量记录（失败静默，不影响聊天） */
export async function recordLlmUsage(entry: LlmUsageEntry): Promise<void> {
  try {
    await fs.mkdir(path.dirname(usagePath()), { recursive: true });
    await fs.appendFile(usagePath(), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* 记账失败不影响主流程 */
  }
}

export interface LlmUsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 命中率 = 命中 / 总输入（0-1） */
  hitRate: number;
  /** 最近 24 小时的调用数 */
  last24h: number;
  byModel: { id: string; calls: number; hitRate: number; promptTokens: number; completionTokens: number }[];
  recent: LlmUsageEntry[];
}

/** 汇总统计（默认读全量，recent 返回最近 N 条明细） */
export async function summarizeLlmUsage(recentLimit = 30): Promise<LlmUsageSummary> {
  const text = await fs.readFile(usagePath(), "utf8").catch(() => "");
  const entries: LlmUsageEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LlmUsageEntry);
    } catch {
      /* 跳过坏行 */
    }
  }
  const sum = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  let last24h = 0;
  const byModelMap = new Map<string, { calls: number; hit: number; prompt: number; completion: number }>();
  for (const e of entries) {
    sum.calls++;
    sum.promptTokens += e.promptTokens || 0;
    sum.completionTokens += e.completionTokens || 0;
    sum.cacheHitTokens += e.cacheHitTokens || 0;
    sum.cacheMissTokens += e.cacheMissTokens || 0;
    if (new Date(e.ts).getTime() >= dayAgo) last24h++;
    const key = `${e.provider}/${e.model}`;
    const m = byModelMap.get(key) ?? { calls: 0, hit: 0, prompt: 0, completion: 0 };
    m.calls++;
    m.hit += e.cacheHitTokens || 0;
    m.prompt += e.promptTokens || 0;
    m.completion += e.completionTokens || 0;
    byModelMap.set(key, m);
  }
  return {
    ...sum,
    hitRate: sum.promptTokens > 0 ? sum.cacheHitTokens / sum.promptTokens : 0,
    last24h,
    byModel: [...byModelMap.entries()]
      .map(([id, m]) => ({
        id,
        calls: m.calls,
        hitRate: m.prompt > 0 ? m.hit / m.prompt : 0,
        promptTokens: m.prompt,
        completionTokens: m.completion,
      }))
      .sort((a, b) => b.calls - a.calls),
    recent: entries.slice(-recentLimit).reverse(),
  };
}
