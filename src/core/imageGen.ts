// 生图核心：NovelAI / OpenAI 兼容——供网页 image_gen 工具与 OpenClaw 端插件复用
// 统一读 data/imageConfig.json；调用方只需传 prompt 与保存目录
// 三档比例（NAI 标准普通分辨率）：方 1024x1024 / 竖 832x1216 / 横 1216x832
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getImageConfig,
  NAI_GATEWAY_BASE,
  rejectForeignKey,
  type ImageConfig,
} from "./imageConfig.js";

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

// NovelAI 网关（Nai2API）固定默认参数（不对用户开放）。
// 采样器跟随所选模型（模型 id 形如 <底模>:<采样器>），这里只定引导值等。
const NAI_SCALE = 6;   // 提示词引导值
const NAI_CFG = 0;     // 缩放引导值（rescale）
// 网关按「竖图 / 横图 / 方图」三档收尺寸，不接受像素值；像素由网关按档位决定：
// 竖 832x1216 / 横 1216x832 / 方 1024x1024（普通档）
const NAI_SIZE_LABEL: Record<string, string> = {
  portrait: "竖图",
  landscape: "横图",
  square: "方图",
};
/** 像素尺寸 → 网关的中文档位标签 */
function naiSizeLabel(w: number, h: number): string {
  if (h > w) return NAI_SIZE_LABEL.portrait;
  if (w > h) return NAI_SIZE_LABEL.landscape;
  return NAI_SIZE_LABEL.square;
}
// 负面提示词：由用户两套常用负面合并去重而来（保留 NAI 权重语法）
const NAI_NEGATIVE =
  "worst quality, bad quality, low quality, lowres, blurry, jpeg artifacts, film grain, scan artifacts, chromatic aberration, dithering, disorganized colors, unfinished, incomplete, sloppiness, cheesy, artistic error, " +
  "text, logo, signature, watermark, too many watermarks, username, 1990s (style), " +
  "oekaki, halftone, screentone, multiple views, negative space, blank page, variant set, large variant set, " +
  "artist:gaoo (frpjx283), artist:matsunaga kouyou, artist:nameo (judgemasterkou), artist:bb (baalbuddy), " +
  "{{{bad anatomy}}}, {bad hands}, {{{too many fingers}}}, extra fingers, extra digits, fewer digits, {{{fused fingers}}}, interlocked fingers, badly drawn hands, anatomically incorrect hands, poorly drawn hands, malformed limbs, " +
  "{{{extra arms}}}, {{{extra legs}}}, extra limbs, {{missing arms}}, {missing fingers}, {{missing legs}}, {{{long neck}}}, gross proportions, {{{bad proportions}}}, {bad feet}, " +
  "{{{deformed}}}, {{{disfigured}}}, {{{mutation}}}, cloned face, poorly drawn face, undetailed eyes, very displeasing, colored inner hair";

// OpenAI 兼容固定默认（配置里未选模型时的兜底）
const OAI_FALLBACK_SIZE = "1024x1024";

/**
 * 试生用的内置提示词（配置页「测试」按钮用，用户不用自己写）。
 * 两套写法是因为两家模型吃的输入不同：NAI 吃 Danbooru 标签，OpenAI 兼容通道吃自然语言。
 * 画面：黑色风衣、黑长发、小猫耳发箍的可爱女生，雨夜倚在屋檐下等雨停。
 */
export const TEST_PROMPT_NAI =
  "1girl, solo, cute girl, long black hair, cat ear headband, black trench coat, " +
  "standing under eaves, leaning against wall, waiting for the rain to stop, " +
  "rainy night, rain, wet street, night, city lights, glowing windows, reflections, " +
  "looking at viewer, from side, upper body, detailed face, " +
  "masterpiece, best quality, very aesthetic, absurdres";

export const TEST_PROMPT_OPENAI =
  "A cute girl with long black hair, wearing a cat-ear headband and a black trench coat, " +
  "standing and leaning against the wall under the eaves of a building on a rainy night, " +
  "waiting for the rain to stop. Rain falls beyond the eaves, the wet street reflects warm city lights, " +
  "cinematic composition, moody atmosphere, soft rim light, highly detailed anime illustration.";

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
  /** NAI 网页直显模式：上游图床的原始 URL（不下载字节，浏览器直连显示） */
  url?: string;
}

const GEN_TIMEOUT = 180_000;

// ---------- 压缩（sharp，按需加载；缺失/失败时静默跳过用原图） ----------
type SharpFn = (buf: Buffer) => {
  webp(o: { quality: number }): { toBuffer(): Promise<Buffer> };
  jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> };
};
let sharpCache: SharpFn | null | undefined;
async function getSharp(): Promise<SharpFn | null> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    const mod = await import("sharp");
    sharpCache = ((mod as { default?: SharpFn }).default ?? mod) as unknown as SharpFn;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}
/** 重编码：webp=本地保存文件（体积最小）；jpeg=通道发送（腾讯接口兼容最稳）。失败返回 null 用原图。 */
export async function recompress(buf: Buffer, format: "webp" | "jpeg"): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    const sharp = await getSharp();
    if (!sharp) return null;
    const out =
      format === "webp"
        ? await sharp(buf).webp({ quality: 85 }).toBuffer()
        : await sharp(buf).jpeg({ quality: 88 }).toBuffer();
    return { buf: out, mime: format === "webp" ? "image/webp" : "image/jpeg" };
  } catch {
    return null;
  }
}

/** 网页聊天模式的附加行为 */
export interface GenOpts {
  /** NAI 只返回上游 URL 不下载；OpenAI 不落盘（字节交内存图库，由浏览器拉取自存） */
  web?: boolean;
}

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

export async function generateImage(params: GenParams, saveDir?: string, opts?: GenOpts): Promise<GenResult> {
  const cfg = params.cfg ?? (await getImageConfig());
  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "提示词为空" };
  // 尺寸：调用方显式传的优先（如封面固定竖图），否则用全局设置；
  // auto = 按提示词画面内容推断构图，选定了档位就定死
  const [w, h] = resolveAspect(prompt, params.aspect ?? cfg.aspect);

  // 画师串只拼 NovelAI（Danbooru 标签风格；OpenAI 兼容端点吃自然语言，拼标签会污染画面——
  // 2026-09-08 用户确认分流：OpenAI 生图走纯 prompt）
  const artist = cfg.artists.find((a) => a.name === cfg.activeArtist)?.content ?? "";
  const usedPrompt = cfg.provider === "novelai" && artist ? `${prompt}, ${artist}` : prompt;

  let buf: Buffer | null = null;
  let mimeType = "image/png";
  const provider = cfg.provider;

  try {
    if (provider === "novelai" && cfg.novelai.key) {
      // 兜底：挡上游/官方密钥（正常在配置页就被拦了，这里防手改配置文件绕过）
      const badKey = rejectForeignKey(cfg.novelai.key);
      if (badKey) return { ok: false, error: badKey };
      // 走我们自己的中转站（new-api，OpenAI 兼容）的 /v1/chat/completions。
      // 生图模型在中转站里按次计费，请求正文是固定字段行的纯文本，
      // 回复正文是 markdown 图片链接（要再下载一次拿图）。
      // 采样器由模型决定，这里不单独传采样器行。
      const model = String(cfg.novelai.model || "").trim();
      if (!model) throw new Error("还没选生图模型：到「生图配置」点一次「拉取模型」，选好再试");
      const lines = [
        `提示词:${usedPrompt}`,
        `画师串:`, // 画师串已拼进提示词，这里留空避免重复
        `尺寸:${naiSizeLabel(w, h)}`,
        `提示词引导值:${NAI_SCALE}`,
        `缩放引导值:${NAI_CFG}`,
        `负面提示词:${String(params.negative ?? NAI_NEGATIVE)}`,
      ];
      const r = await fetch(`${NAI_GATEWAY_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.novelai.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: lines.join("\n") }] }),
        signal: AbortSignal.timeout(GEN_TIMEOUT),
      });
      if (!r.ok) return { ok: false, error: httpError("生图服务", r.status, await r.text().catch(() => "")) };
      const j = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (j.error?.message) return { ok: false, error: "生图服务返回错误：" + j.error.message };
      const content = String(j.choices?.[0]?.message?.content ?? "");
      // 先取 markdown ![](url)，取不到再退回正文里的第一个裸链接
      const imgUrl = content.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1]
        ?? content.match(/https?:\/\/[^\s"'<>)]+/i)?.[0]
        ?? "";
      if (!imgUrl) {
        return { ok: false, error: "生图服务没返回图片地址：" + content.slice(0, 120) };
      }
      // 网页直显模式：URL 原样交前端（浏览器直连上游图床加载），不下载字节、不落盘
      if (opts?.web) {
        return { ok: true, url: imgUrl, provider, width: w, height: h };
      }
      const img = await fetch(imgUrl, { signal: AbortSignal.timeout(GEN_TIMEOUT) });
      if (!img.ok) return { ok: false, error: `图片已生成但下载失败 HTTP ${img.status}` };
      const ct = img.headers.get("content-type") ?? "";
      if (/jpeg|jpg/i.test(ct)) mimeType = "image/jpeg";
      else if (/webp/i.test(ct)) mimeType = "image/webp";
      buf = Buffer.from(await img.arrayBuffer());
    } else if (provider === "openai" && cfg.openai.baseUrl && cfg.openai.key) {
      const size = `${w}x${h}`;
      // 不带 response_format：部分兼容端点（如 agnes t2i）不支持 b64_json 参数，
      // 标准 OpenAI 端点默认返回 data[].url，下载即可；个别端点返回 b64_json 也兼容
      const oaiModel = String(cfg.openai.model || "").trim();
      if (!oaiModel) throw new Error("还没选生图模型：到「生图配置」点一次「拉取模型」，选好再试");
      const call = (sz: string): Promise<Response> =>
        fetch(`${cfg.openai.baseUrl.replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openai.key}` },
          body: JSON.stringify({ model: oaiModel, prompt: usedPrompt, n: 1, size: sz }),
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

  // 压缩开关（生图配置页）：网页模式 → WebP（本地保存/浏览器存储都小）；
  // 落盘模式（通道发 QQ/微信）→ JPEG（腾讯接口兼容最稳）。封面等其他调用保持原图。
  if (buf && cfg.compression?.enabled && (opts?.web || saveDir)) {
    const c = await recompress(buf, opts?.web ? "webp" : "jpeg");
    if (c) {
      buf = c.buf;
      mimeType = c.mime;
    }
  }

  let file: string | undefined;
  if (saveDir && buf) {
    try {
      await fs.mkdir(saveDir, { recursive: true });
      const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
      const p = path.join(saveDir, `gen-${Date.now()}${ext}`);
      await fs.writeFile(p, buf);
      file = p;
    } catch (e) {
      return { ok: false, error: "图片已生成但保存失败：" + String(e) };
    }
  }

  return { ok: true, buffer: buf, mimeType, width: w, height: h, file, provider };
}
