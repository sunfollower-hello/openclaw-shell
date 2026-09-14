// 生图配置：NovelAI 网关（Nai2API）/ OpenAI 兼容（只保留这两家；参数用默认值不开放配置）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

/**
 * NovelAI 生图走**我们自己的中转站**（api.319274.xyz），不是 NovelAI 官方、
 * 也不直连上游网关——上游只作为中转站背后的一个渠道存在，用户完全看不到。
 * 这样用户填的是我们签发的密钥、用量与计价都在我们自己手里。
 * 站点地址固定在代码里（用户只填密钥、选模型），换站改这里一处。
 *
 * 中转站是 new-api（OpenAI 兼容），生图模型走 chat 接口：
 *   GET  <BASE>/v1/models              → 模型列表（我们自己的模型名，如 [次]nai-4.5）
 *   POST <BASE>/v1/chat/completions    → 出图，回复正文是 markdown 图片链接
 * 认证：Authorization: Bearer <我们签发的密钥>
 */
export const NAI_GATEWAY_BASE = "https://api.319274.xyz";
export const NAI_GATEWAY_NAME = "SoulBox 生图服务";
/** 默认模型：我们中转站里对外的生图模型名（按次计费，普通档） */
export const NAI_GATEWAY_DEFAULT_MODEL = "[次]nai-4.5";

export interface ArtistPreset {
  name: string;
  content: string;
}

/** 出图尺寸：auto=由 AI 按画面内容判断（默认）；其余为固定档 */
export type ImageAspect = "auto" | "square" | "portrait" | "landscape";
const ASPECTS: ImageAspect[] = ["auto", "square", "portrait", "landscape"];

export interface ImageConfig {
  provider: "novelai" | "openai";
  /** 图片自动清理：保留最近 N 天的正式生图（0 = 不自动清理） */
  retentionDays: number;
  /** 出图尺寸：auto=AI 按场景自行判断，其余定死（全局，聊天出图与试生共用） */
  aspect: ImageAspect;
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
  aspect: "auto",
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
      aspect: ASPECTS.includes(c.aspect as ImageAspect) ? (c.aspect as ImageAspect) : DEFAULTS.aspect,
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
 * 只接受本中转站签发的密钥——挡住「把上游密钥直接填进来绕过我的站」。
 * 上游密钥（STA1N-…）与 NovelAI 官方密钥（pst-…）都指向别的站点，
 * 用它们等于跳过我们的计量与计费，所以一律拒绝并给出明确指引。
 * 返回 null = 通过；返回字符串 = 拒绝原因。
 */
export function rejectForeignKey(key: string): string | null {
  const k = String(key ?? "").trim();
  if (!k) return null; // 空由调用方按「沿用已保存的值」处理
  if (/^STA1N[-_]/i.test(k) || /^STA1N/i.test(k)) {
    return "这是上游站点的密钥，本项目不直接使用它。请到「生图配置」页填入你自己站点签发的密钥（sk- 开头）。";
  }
  if (/^pst-/i.test(k)) {
    return "这是 NovelAI 官方密钥，本项目不走官方直连。请填入你站点签发的密钥（sk- 开头）。";
  }
  if (!/^sk-/i.test(k)) {
    return "密钥格式不对：请填入你站点签发的密钥（sk- 开头）。";
  }
  return null;
}

/**
 * 模型校验：必须是我们站点 /v1/models 里真实存在的模型。
 * 目的：挡住手填的上游模型名（如 `nai-diffusion-4-5-full:k_dpmpp_2m_sde`）——
 * 那是上游的命名，我们站点对外是 `[次]nai-4.5`，填上游名会调不通，
 * 也等于绕过我们自己的模型配置。校验要联网，故只在「保存配置」时做一次。
 */
export async function validateGatewayModel(
  key: string,
  model: string
): Promise<{ ok: boolean; info?: string }> {
  const m = String(model ?? "").trim();
  if (!m) return { ok: true }; // 空 = 沿用已保存的模型
  const r = await listNovelaiGatewayModels(key);
  if (!r.ok) return { ok: false, info: r.info || "拉取模型列表失败，无法校验模型" };
  const ids = r.models.map((x) => x.id);
  if (!ids.includes(m)) {
    return {
      ok: false,
      info: `模型「${m}」不在你站点的可用列表里，请点「拉取模型」从列表中选择。可用：${ids.slice(0, 5).join("、")}${ids.length > 5 ? " …" : ""}`,
    };
  }
  return { ok: true };
}

/**
 * 生图密钥校验：查中转站的额度接口，不实际生图（不扣费）。
 * 中转站是 new-api，走标准的 /dashboard/billing/subscription（返回额度上限与已用量）。
 * 实测无效 key 与空 key 都会 401，可安全用于校验。
 */
export async function testNovelaiKey(key: string): Promise<{ ok: boolean; info: string }> {
  const k = String(key ?? "").trim();
  if (!k) return { ok: false, info: "请先填写生图密钥" };
  // 先挡「上游/官方密钥」这类会绕过我们站点的密钥
  const bad = rejectForeignKey(k);
  if (bad) return { ok: false, info: bad };
  try {
    const r = await fetch(`${NAI_GATEWAY_BASE}/dashboard/billing/subscription`, {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const j = (await r.json()) as { hard_limit_usd?: number; system_hard_limit_usd?: number };
      const limit = Number(j.hard_limit_usd ?? j.system_hard_limit_usd ?? 0);
      return { ok: true, info: limit > 0 ? `密钥有效，可用额度 $${limit.toFixed(2)}` : "密钥有效" };
    }
    if (r.status === 401) return { ok: false, info: "密钥无效或已被禁用（HTTP 401）" };
    return { ok: false, info: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, info: String(e) };
  }
}

/**
 * 拉取中转站可用的生图模型（供前端下拉选择）。
 * 中转站的 /v1/models 会返回该密钥能用的**全部**模型（含聊天模型），
 * 所以这里过滤出生图相关的：模型名里带 nai / diffusion / image 的。
 * 注意：中转站的 /v1/models 对无效 key 会 401（与上游那个不校验的接口不同），所以必须带 key。
 */
export async function listNovelaiGatewayModels(
  key?: string
): Promise<{ ok: boolean; models: { id: string; cost?: number; tier?: string }[]; info?: string }> {
  const k = String(key ?? "").trim();
  if (!k) return { ok: false, models: [], info: "请先填写生图密钥（拉取模型需要密钥）" };
  const bad = rejectForeignKey(k);
  if (bad) return { ok: false, models: [], info: bad };
  try {
    const r = await fetch(`${NAI_GATEWAY_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      return { ok: false, models: [], info: r.status === 401 ? "密钥无效（HTTP 401）" : `HTTP ${r.status}` };
    }
    const j = (await r.json()) as { data?: { id?: string }[] };
    const all = (j.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean);
    // 只挑生图模型：名字里含 nai / diffusion / image（中转站里也有一堆聊天模型）
    const imageLike = all.filter((id) => /nai|diffusion|image/i.test(id));
    const models = (imageLike.length ? imageLike : all).map((id) => ({ id }));
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
