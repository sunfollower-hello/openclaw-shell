// 生图配置：NovelAI 网关（Nai2API）/ OpenAI 兼容（只保留这两家；参数用默认值不开放配置）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

/**
 * NovelAI 生图走自建/指定的 Nai2API 网关（不是 NovelAI 官方 image.novelai.net）。
 * 站点地址固定在代码里（用户只填 key、选模型），换站要改这里一处。
 * 契约见网关的 OPENAI_CALLING_GUIDE.md：
 *   GET  <BASE>/v1/models              → 模型列表（id 形如 nai-diffusion-4-5-full:k_dpmpp_2m_sde）
 *   POST <BASE>/v1/chat/completions    → 出图，回复正文是 markdown 图片链接
 * 认证：Authorization: Bearer <用户密钥>
 */
export const NAI_GATEWAY_BASE = "https://nai.sta1n.cn";
export const NAI_GATEWAY_NAME = "NovelAI 网关";
/** 网关默认模型（V4.5 普通档 + 默认采样器，成本最低的一档） */
export const NAI_GATEWAY_DEFAULT_MODEL = "nai-diffusion-4-5-full:k_dpmpp_2m_sde";

export interface ArtistPreset {
  name: string;
  content: string;
}

export interface ImageConfig {
  provider: "novelai" | "openai";
  /** 图片自动清理：保留最近 N 天的正式生图（0 = 不自动清理） */
  retentionDays: number;
  /** NovelAI 网关：站点地址固定（NAI_GATEWAY_BASE），用户只填 key 与选模型 */
  novelai: { key: string; model: string };
  openai: { baseUrl: string; key: string; model: string };
  /** 画师串列表（用户可增删改），生成时拼到提示词末尾 */
  artists: ArtistPreset[];
  /** 当前生效的画师串名（空 = 不用画师串） */
  activeArtist: string;
}

const DEFAULTS: ImageConfig = {
  provider: "novelai",
  retentionDays: 30,
  novelai: { key: "", model: NAI_GATEWAY_DEFAULT_MODEL },
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
      novelai: {
        key: String(c.novelai?.key ?? ""),
        model: String(c.novelai?.model ?? DEFAULTS.novelai.model) || DEFAULTS.novelai.model,
      },
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

/**
 * NovelAI 网关 key 校验：查网关自己的额度接口，不实际生图（不扣点）。
 * 网关的 /api/me?token=<key> 返回 { balance, enabled, ... }；
 * 注意不能用 /v1/models 验 key —— 那个接口不校验密钥，任何字符串都会返回模型列表（实测），
 * 拿它当校验会把无效 key 判成有效。
 */
export async function testNovelaiKey(key: string): Promise<{ ok: boolean; info: string }> {
  const k = String(key ?? "").trim();
  if (!k) return { ok: false, info: "请先填写网关密钥" };
  try {
    const r = await fetch(`${NAI_GATEWAY_BASE}/api/me?token=${encodeURIComponent(k)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const j = (await r.json()) as { balance?: number; enabled?: boolean };
      if (j.enabled === false) return { ok: false, info: "这个密钥已被禁用" };
      const bal = Number(j.balance ?? 0);
      // 普通档 1 点/张，直接把可出图张数算给用户看
      return { ok: true, info: `密钥有效，剩余 ${bal} 点（普通档约可出 ${bal} 张）` };
    }
    if (r.status === 401) return { ok: false, info: "密钥无效或已被禁用（HTTP 401）" };
    return { ok: false, info: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, info: String(e) };
  }
}

/** 拉取网关可用模型列表（供前端下拉选择；这个接口不需要 key 也能读） */
export async function listNovelaiGatewayModels(
  key?: string
): Promise<{ ok: boolean; models: { id: string; cost?: number; tier?: string }[]; info?: string }> {
  try {
    const headers: Record<string, string> = {};
    const k = String(key ?? "").trim();
    if (k) headers.Authorization = `Bearer ${k}`;
    const r = await fetch(`${NAI_GATEWAY_BASE}/v1/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, models: [], info: `HTTP ${r.status}` };
    const j = (await r.json()) as { data?: { id?: string; cost?: number; resolution_tier?: string }[] };
    const models = (j.data ?? [])
      .map((m) => ({ id: String(m?.id ?? ""), cost: Number(m?.cost ?? 0), tier: String(m?.resolution_tier ?? "") }))
      .filter((m) => m.id);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], info: String(e) };
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
