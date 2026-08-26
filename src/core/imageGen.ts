// 生图核心：NovelAI / OpenAI 兼容——供网页 image_gen 工具与 OpenClaw 端插件复用
// 统一读 data/imageConfig.json；调用方只需传 prompt 与保存目录
// 三档比例（NAI 标准普通分辨率）：方 1024x1024 / 竖 832x1216 / 横 1216x832
import { promises as fs } from "node:fs";
import path from "node:path";
import { getImageConfig, type ImageConfig } from "./imageConfig.js";

export const ASPECT_SIZES: Record<string, [number, number]> = {
  square: [1024, 1024],
  portrait: [832, 1216],
  landscape: [1216, 832],
};

/** 尺寸解析：传 square/portrait/landscape 用指定档；auto/未传时按提示词画面内容推断（AI 决定构图，后端从 prompt 识别） */
export function resolveAspect(prompt: string, aspect?: string): [number, number] {
  const a = String(aspect ?? "auto").toLowerCase();
  if (a === "square" || a === "portrait" || a === "landscape") return ASPECT_SIZES[a];
  const p = String(prompt ?? "").toLowerCase();
  // 竖构图：竖/全身/站/半身/塔等
  if (/(portrait|full[ -]?body|standing|tall|upper body|全身|站|竖|半身|一身)/.test(p)) return ASPECT_SIZES.portrait;
  // 横构图：风景/横/全景/场景/远景等
  if (/(landscape|scenery|panorama|wide|horizon|远景|全景|风景|横|场景|背景)/.test(p)) return ASPECT_SIZES.landscape;
  return ASPECT_SIZES.square;
}

// NovelAI 固定默认参数（不对用户开放；对齐 RP-Hub：steps 40 / scale 6 / k_dpmpp_2m_sde / karras）
const NAI_MODEL = "nai-diffusion-4-5-full";
const NAI_STEPS = 40;
const NAI_SCALE = 6;
const NAI_SAMPLER = "k_dpmpp_2m_sde";
const NAI_NOISE_SCHEDULE = "karras";
const NAI_UC_PRESET = 2; // heavy
// 负面提示词：由用户两套常用负面合并去重而来（保留 NAI 权重语法）
const NAI_NEGATIVE =
  "worst quality, bad quality, low quality, lowres, blurry, jpeg artifacts, film grain, scan artifacts, chromatic aberration, dithering, disorganized colors, unfinished, incomplete, sloppiness, cheesy, artistic error, " +
  "text, logo, signature, watermark, too many watermarks, username, 1990s (style), " +
  "oekaki, halftone, screentone, multiple views, negative space, blank page, variant set, large variant set, " +
  "artist:gaoo (frpjx283), artist:matsunaga kouyou, artist:nameo (judgemasterkou), artist:bb (baalbuddy), " +
  "{{{bad anatomy}}}, {bad hands}, {{{too many fingers}}}, extra fingers, extra digits, fewer digits, {{{fused fingers}}}, interlocked fingers, badly drawn hands, anatomically incorrect hands, poorly drawn hands, malformed limbs, " +
  "{{{extra arms}}}, {{{extra legs}}}, extra limbs, {{missing arms}}, {missing fingers}, {{missing legs}}, {{{long neck}}}, gross proportions, {{{bad proportions}}}, {bad feet}, " +
  "{{{deformed}}}, {{{disfigured}}}, {{{mutation}}}, cloned face, poorly drawn face, undetailed eyes, very displeasing, colored inner hair, " +
  // 内容尺度：图片一律 SFW（至少不露三点）。破甲档只管聊天文字，生图全局禁露骨标签
  "nsfw, {nudity}, {nude}, {naked}, topless, bottomless, exposed breasts, bare breasts, nipples, areola, crotch, pussy, penis, genitals, pubic hair, sex, sexual, intercourse, penetration, porn, hentai, uncensored, no clothes, undressing";

// OpenAI 兼容固定默认（配置里未选模型时的兜底）
const OAI_DEFAULT_MODEL = "agnes-image-2.0-flash";
const OAI_FALLBACK_SIZE = "1024x1024";

export interface GenParams {
  prompt: string;
  negative?: string;
  aspect?: string;
  seed?: number;
  /** 覆盖配置（配置页测试场景可注入）；默认读 data/imageConfig.json */
  cfg?: ImageConfig;
}

export interface GenResult {
  ok: boolean;
  error?: string;
  buffer?: Buffer;
  mimeType?: string;
  width?: number;
  height?: number;
  /** saveDir 提供时，保存后的文件绝对路径 */
  file?: string;
  provider?: string;
}

const GEN_TIMEOUT = 180_000;

function httpError(service: string, status: number, body: string): string {
  const b = body.slice(0, 160);
  if (status === 401) return `${service} Key 无效或已过期（HTTP 401）`;
  if (status === 402) return `${service} 余额不足（HTTP 402）`;
  if (status === 429) return `${service} 请求过于频繁或额度受限（HTTP 429）`;
  if (status >= 500) return `${service} 服务端错误（HTTP ${status}）：${b}`;
  return `${service} 生成失败 HTTP ${status}：${b}`;
}

function classifyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abor/i.test(msg)) return "生图超时（服务响应较慢），请稍后重试";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(msg)) return "网络错误：" + msg;
  return "生图失败: " + msg;
}

export async function generateImage(params: GenParams, saveDir?: string): Promise<GenResult> {
  const cfg = params.cfg ?? (await getImageConfig());
  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "提示词为空" };
  const [w, h] = resolveAspect(prompt, params.aspect);

  // 画师串：当前生效的画师串拼到提示词末尾
  const artist = cfg.artists.find((a) => a.name === cfg.activeArtist)?.content ?? "";
  const usedPrompt = artist ? `${prompt}, ${artist}` : prompt;

  let buf: Buffer | null = null;
  let mimeType = "image/png";
  const provider = cfg.provider;

  try {
    if (provider === "novelai" && cfg.novelai.key) {
      const r = await fetch("https://image.novelai.net/ai/generate-image", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.novelai.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: usedPrompt,
          model: NAI_MODEL,
          action: "generate",
          parameters: {
            width: w,
            height: h,
            scale: NAI_SCALE,
            negative_prompt: String(params.negative ?? NAI_NEGATIVE),
            steps: NAI_STEPS,
            sampler: NAI_SAMPLER,
            seed: params.seed ?? 0,
            n_samples: 1,
            noise_schedule: NAI_NOISE_SCHEDULE,
            ucPreset: NAI_UC_PRESET,
          },
        }),
        signal: AbortSignal.timeout(GEN_TIMEOUT),
      });
      if (!r.ok) return { ok: false, error: httpError("NovelAI", r.status, await r.text().catch(() => "")) };
      const ct = r.headers.get("content-type") ?? "";
      if (/jpeg|jpg/i.test(ct)) mimeType = "image/jpeg";
      buf = Buffer.from(await r.arrayBuffer());
    } else if (provider === "openai" && cfg.openai.baseUrl && cfg.openai.key) {
      const size = `${w}x${h}`;
      // 不带 response_format：部分兼容端点（如 agnes t2i）不支持 b64_json 参数，
      // 标准 OpenAI 端点默认返回 data[].url，下载即可；个别端点返回 b64_json 也兼容
      const call = (sz: string): Promise<Response> =>
        fetch(`${cfg.openai.baseUrl.replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openai.key}` },
          body: JSON.stringify({ model: cfg.openai.model || OAI_DEFAULT_MODEL, prompt: usedPrompt, n: 1, size: sz }),
          signal: AbortSignal.timeout(GEN_TIMEOUT),
        });
      let r = await call(size);
      // 部分兼容端点不支持高分辨率尺寸：失败可退回 1024x1024
      if (!r.ok && size !== OAI_FALLBACK_SIZE) {
        r = await call(OAI_FALLBACK_SIZE);
      }
      if (!r.ok) return { ok: false, error: httpError("生图 API", r.status, await r.text().catch(() => "")) };
      const j = (await r.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = j.data?.[0];
      if (item?.b64_json) {
        buf = Buffer.from(item.b64_json, "base64");
      } else if (item?.url) {
        const img = await fetch(item.url, { signal: AbortSignal.timeout(GEN_TIMEOUT) });
        if (!img.ok) return { ok: false, error: "生图成功但下载图片失败 HTTP " + img.status };
        buf = Buffer.from(await img.arrayBuffer());
      } else {
        return { ok: false, error: "生图 API 返回里没有图片数据" };
      }
    } else {
      return {
        ok: false,
        error:
          provider === "openai"
            ? "未配置生图：请到「生图配置」页填写 OpenAI 兼容的 Base URL 与 Key"
            : "未配置生图：请到「生图配置」页填写 NovelAI Key",
      };
    }
  } catch (e) {
    return { ok: false, error: classifyError(e) };
  }

  let file: string | undefined;
  if (saveDir && buf) {
    try {
      await fs.mkdir(saveDir, { recursive: true });
      const ext = mimeType === "image/jpeg" ? ".jpg" : ".png";
      const p = path.join(saveDir, `gen-${Date.now()}${ext}`);
      await fs.writeFile(p, buf);
      file = p;
    } catch (e) {
      return { ok: false, error: "图片已生成但保存失败：" + String(e) };
    }
  }

  return { ok: true, buffer: buf, mimeType, width: w, height: h, file, provider };
}
