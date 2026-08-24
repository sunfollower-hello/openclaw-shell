// 生图核心：NovelAI / OpenAI 兼容 / 本地 SD WebUI（A1111/Forge）
// 供网页 image_gen 工具与 OpenClaw 端插件复用：统一读 data/imageConfig.json，
// 调用方只需传 prompt 与保存目录，返回结构化结果（含已保存文件路径）
import { promises as fs } from "node:fs";
import path from "node:path";
import { getImageConfig, type ImageConfig } from "./imageConfig.js";
// 翻译走与聊天同一套提供商配置（data/providers.json），避免两条独立的模型读取路径
import { resolveChatLLM } from "./providers.js";

export const ASPECT_SIZES: Record<string, [number, number]> = {
  square: [1024, 1024],
  portrait: [832, 1216],
  landscape: [1216, 832],
  tall: [768, 1344],
  wide: [1344, 768],
};

export interface GenParams {
  prompt: string;
  negative?: string;
  aspect?: string;
  seed?: number;
  /** 覆盖配置（配置页测试场景可注入）；默认读 data/imageConfig.json */
  cfg?: ImageConfig;
  /** 显式要求翻译（配置开启或工具参数要求时生效） */
  translate?: boolean;
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
  /** 实际使用的提示词（翻译后，未翻译时同原 prompt） */
  promptUsed?: string;
  provider?: string;
}

const GEN_TIMEOUT = 180_000;
const HAS_CJK = /[\u4e00-\u9fff]/;

function hasCjk(s: string): boolean {
  return HAS_CJK.test(s);
}

/** 中文 prompt → 英文 Danbooru 风格（用默认 chat 模型；失败返回 null 用原文） */
async function translatePrompt(prompt: string): Promise<string | null> {
  const llm = await resolveChatLLM();
  if (!llm?.baseUrl || !llm.apiKey || !llm.model) return null;
  try {
    const r = await fetch(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          {
            role: "system",
            content:
              "你是绘画提示词翻译助手。把用户的中文绘画描述翻译并扩写成英文 Danbooru 风格提示词（逗号分隔、含人物/服饰/动作/场景/光线/画质词），只输出提示词本身，不要任何解释或前言。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

const UC_PRESETS: Record<string, number> = { none: 0, light: 1, heavy: 2 };

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
  const aspect = params.aspect && ASPECT_SIZES[params.aspect] ? params.aspect : "square";
  const [w, h] = ASPECT_SIZES[aspect];

  // prompt 翻译：配置开启或显式要求，且 prompt 含中文时才调模型（英文直接跳过）
  let usedPrompt = prompt;
  const wantTranslate = params.translate ?? false;
  const translateOn = cfg.novelai.translate || cfg.openai.translate;
  if ((wantTranslate || translateOn) && hasCjk(prompt)) {
    const t = await translatePrompt(prompt);
    if (t) usedPrompt = t;
  }

  let buf: Buffer | null = null;
  let mimeType = "image/png";
  const provider = cfg.provider;

  try {
    if (provider === "novelai" && cfg.novelai.key) {
      const negative = String(params.negative ?? cfg.novelai.negative ?? "");
      const sampler = cfg.novelai.sampler || "k_dpmpp_2m_sde";
      const seed = params.seed ?? cfg.novelai.seed ?? 0;
      const ucPreset = UC_PRESETS[String(cfg.novelai.ucPreset ?? "heavy")] ?? 2;
      const r = await fetch("https://image.novelai.net/ai/generate-image", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.novelai.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: usedPrompt,
          model: cfg.novelai.model || "nai-diffusion-4-5-full",
          action: "generate",
          parameters: {
            width: w,
            height: h,
            scale: cfg.novelai.scale || 6,
            negative_prompt: negative,
            steps: cfg.novelai.steps || 28,
            sampler,
            seed,
            n_samples: 1,
            noise_schedule: "karras",
            ucPreset,
          },
        }),
        signal: AbortSignal.timeout(GEN_TIMEOUT),
      });
      if (!r.ok) return { ok: false, error: httpError("NovelAI", r.status, await r.text().catch(() => "")) };
      const ct = r.headers.get("content-type") ?? "";
      if (/jpeg|jpg/i.test(ct)) mimeType = "image/jpeg";
      buf = Buffer.from(await r.arrayBuffer());
    } else if (provider === "openai" && cfg.openai.key) {
      const size = `${w}x${h}`;
      const call = (sz: string): Promise<Response> =>
        fetch(`${cfg.openai.baseUrl.replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openai.key}` },
          body: JSON.stringify({ model: cfg.openai.model, prompt: usedPrompt, n: 1, size: sz, response_format: "b64_json" }),
          signal: AbortSignal.timeout(GEN_TIMEOUT),
        });
      let r = await call(size);
      // 部分兼容端点不支持任意尺寸：非正方形时失败可退回配置里的默认尺寸
      if (!r.ok && aspect !== "square" && cfg.openai.size && cfg.openai.size !== size) {
        r = await call(cfg.openai.size);
      }
      if (!r.ok) return { ok: false, error: httpError("生图 API", r.status, await r.text().catch(() => "")) };
      const j = (await r.json()) as { data?: { b64_json?: string }[] };
      const b64 = j.data?.[0]?.b64_json;
      if (!b64) return { ok: false, error: "生图 API 返回里没有图片数据" };
      buf = Buffer.from(b64, "base64");
    } else if (provider === "local" && cfg.local.baseUrl) {
      const negative = String(params.negative ?? cfg.local.negative ?? "");
      const r = await fetch(`${cfg.local.baseUrl.replace(/\/+$/, "")}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: usedPrompt,
          negative_prompt: negative,
          steps: cfg.local.steps || 24,
          cfg_scale: cfg.local.cfg || 7,
          sampler_name: cfg.local.sampler || "Euler a",
          width: w,
          height: h,
          seed: params.seed ?? -1,
          save_images: false,
        }),
        signal: AbortSignal.timeout(GEN_TIMEOUT),
      });
      if (!r.ok) return { ok: false, error: httpError("本地生图", r.status, await r.text().catch(() => "")) };
      const j = (await r.json()) as { images?: string[] };
      const b64 = j.images?.[0];
      if (!b64) return { ok: false, error: "本地生图未返回图片数据" };
      buf = Buffer.from(b64, "base64");
    } else {
      return {
        ok: false,
        error:
          provider === "local"
            ? "本地生图未配置地址（「生图配置」页填 Base URL 后启用）"
            : "未配置生图：请到「生图配置」页填写 Key 并选择提供商",
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

  return { ok: true, buffer: buf, mimeType, width: w, height: h, file, promptUsed: usedPrompt, provider };
}
