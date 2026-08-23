// TTS 用量记账：每次合成追加一行 jsonl，管理台可看汇总（为后续 one-api 计费/对账做准备）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface TtsUsageEntry {
  ts: string; // ISO 时间
  provider: string; // provider id 或 "local"
  model: string;
  voice: string;
  chars: number; // 输入字符数（对外计费按字符）
  ms: number; // 耗时毫秒
  bytes: number; // 音频字节数
  ok: boolean;
  err?: string;
  via?: "admin" | "api"; // admin=管理台朗读；api=对外售卖接口
}

function usagePath(): string {
  return path.join(dataDir(), "tts-usage.jsonl");
}

export async function recordUsage(e: TtsUsageEntry): Promise<void> {
  try {
    await fs.appendFile(usagePath(), JSON.stringify(e) + "\n", "utf8");
  } catch {
    /* 记账失败不影响合成 */
  }
}

export interface UsageSummary {
  total: number;
  ok: number;
  fail: number;
  totalChars: number;
  byProvider: { id: string; calls: number; chars: number }[];
  last24h: number;
  latest: TtsUsageEntry[];
}

export async function getUsageSummary(limit = 200): Promise<UsageSummary> {
  const lines = await fs.readFile(usagePath(), "utf8").catch(() => "");
  const entries = lines
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as TtsUsageEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TtsUsageEntry => e !== null);
  const ok = entries.filter((e) => e.ok);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const byProvider = new Map<string, { calls: number; chars: number }>();
  for (const e of entries) {
    const cur = byProvider.get(e.provider) ?? { calls: 0, chars: 0 };
    cur.calls++;
    cur.chars += e.chars;
    byProvider.set(e.provider, cur);
  }
  return {
    total: entries.length,
    ok: ok.length,
    fail: entries.length - ok.length,
    totalChars: ok.reduce((s, e) => s + e.chars, 0),
    byProvider: [...byProvider.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.calls - a.calls),
    last24h: entries.filter((e) => new Date(e.ts).getTime() >= dayAgo).length,
    latest: entries.slice(-limit).reverse(),
  };
}
