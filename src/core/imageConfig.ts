// 生图配置：NovelAI / OpenAI 兼容 API / 本地（占位）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface ImageConfig {
  provider: "novelai" | "openai" | "local";
  novelai: { key: string; model: string; steps: number; scale: number; negative: string };
  openai: { baseUrl: string; key: string; model: string; size: string };
}

const DEFAULTS: ImageConfig = {
  provider: "novelai",
  novelai: {
    key: "",
    model: "nai-diffusion-4-5-full",
    steps: 28,
    scale: 6,
    negative: "bad anatomy,bad hands,bad proportions,blurry,low quality,worst quality,watermark,text",
  },
  openai: { baseUrl: "", key: "", model: "agnes-image-2.0-flash", size: "1024x1024" },
};

async function cfgPath(): Promise<string> {
  return path.join(dataDir(), "imageConfig.json");
}

export async function getImageConfig(): Promise<ImageConfig> {
  try {
    const c = JSON.parse(await fs.readFile(await cfgPath(), "utf8"));
    return {
      ...DEFAULTS,
      ...c,
      novelai: { ...DEFAULTS.novelai, ...(c.novelai ?? {}) },
      openai: { ...DEFAULTS.openai, ...(c.openai ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function saveImageConfig(cfg: ImageConfig): Promise<void> {
  await fs.mkdir(path.dirname(await cfgPath()), { recursive: true });
  await fs.writeFile(await cfgPath(), JSON.stringify(cfg, null, 2), "utf8");
}

export function maskKey(s?: string): string {
  return s ? s.slice(0, 6) + "…" : "";
}

/** NovelAI key 校验：查订阅信息，不实际生图（不消耗 Anlas） */
export async function testNovelaiKey(key: string): Promise<{ ok: boolean; info: string }> {
  try {
    const r = await fetch("https://api.novelai.net/user/subscription", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const j = (await r.json()) as { tier?: string; anlas_total?: number; anlas_remaining?: number };
      return { ok: true, info: `有效 key：${j.tier ?? "订阅"}，剩余 Anlas ${j.anlas_remaining ?? j.anlas_total ?? "?"}` };
    }
    return { ok: false, info: `HTTP ${r.status}（key 无效或无额度）` };
  } catch (e) {
    return { ok: false, info: String(e) };
  }
}

/** OpenAI 兼容 key 校验：访问 /models 验证（不消耗生成额度） */
export async function testOpenAIImageKey(baseUrl: string, key: string): Promise<{ ok: boolean; info: string }> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return { ok: true, info: "key 可访问 /models，可尝试生成" };
    return { ok: false, info: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, info: String(e) };
  }
}
