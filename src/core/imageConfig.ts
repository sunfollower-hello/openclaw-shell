// 生图配置：NovelAI / OpenAI 兼容（只保留这两家；参数用默认值不开放配置）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface ArtistPreset {
  name: string;
  content: string;
}

export interface ImageConfig {
  provider: "novelai" | "openai";
  /** 图片自动清理：保留最近 N 天的正式生图（0 = 不自动清理） */
  retentionDays: number;
  novelai: { key: string };
  openai: { baseUrl: string; key: string; model: string };
  /** 画师串列表（用户可增删改），生成时拼到提示词末尾 */
  artists: ArtistPreset[];
  /** 当前生效的画师串名（空 = 不用画师串） */
  activeArtist: string;
}

const DEFAULTS: ImageConfig = {
  provider: "novelai",
  retentionDays: 30,
  novelai: { key: "" },
  openai: { baseUrl: "", key: "", model: "agnes-image-2.0-flash" },
  artists: [],
  activeArtist: "",
};

async function cfgPath(): Promise<string> {
  return path.join(dataDir(), "imageConfig.json");
}

export async function getImageConfig(): Promise<ImageConfig> {
  try {
    const c = JSON.parse(await fs.readFile(await cfgPath(), "utf8"));
    const artists = Array.isArray(c.artists)
      ? (c.artists as unknown[])
          .filter((a) => a && typeof a === "object")
          .map((a) => {
            const o = a as Record<string, unknown>;
            return { name: String(o.name ?? "").trim(), content: String(o.content ?? "").trim() };
          })
          .filter((a) => a.name && a.content)
      : [];
    return {
      provider: c.provider === "openai" ? "openai" : "novelai",
      retentionDays: Number(c.retentionDays) || DEFAULTS.retentionDays,
      novelai: { key: String(c.novelai?.key ?? "") },
      openai: { baseUrl: String(c.openai?.baseUrl ?? ""), key: String(c.openai?.key ?? ""), model: String(c.openai?.model ?? DEFAULTS.openai.model) },
      artists,
      activeArtist: artists.some((a) => a.name === c.activeArtist) ? String(c.activeArtist) : "",
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
