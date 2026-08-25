// 独立 TTS 售卖服务：对外暴露 OpenAI 兼容 /v1/audio/speech，可单独部署到服务器赚钱
// 启动: npm run tts-server  →  http://0.0.0.0:17900
// 客户直接用 OpenAI SDK（baseUrl 指向本服务）即可调用，上游由 data/ttsConfig.json 决定，赚差价
// 认证：Bearer key（data/ttsKeys.json 或环境变量 TTS_API_KEYS="k1,k2"）；本机 127.0.0.1 直连免 key 方便自测
import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { dataDir } from "./core/cardStore.js";
import { getTtsConfig, synthesize, maskKey } from "./core/ttsConfig.js";
import { recordUsage } from "./core/ttsUsage.js";

const PORT = Number(process.env.TTS_PORT ?? 17900);
const HOST = process.env.TTS_HOST ?? "0.0.0.0";
/** 允许本机自用时的本地兜底合成（售卖部署请勿设置，避免把本地音质卖给客户） */
const ALLOW_LOCAL = String(process.env.TTS_ALLOW_LOCAL ?? "0") === "1";
const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- 认证：Bearer key ----------
async function loadKeys(): Promise<string[]> {
  const envKeys = String(process.env.TTS_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let fileKeys: string[] = [];
  try {
    const j = JSON.parse(await fs.readFile(path.join(dataDir(), "ttsKeys.json"), "utf8"));
    if (Array.isArray(j)) fileKeys = j.map((x) => String(x.key ?? "")).filter(Boolean);
    else if (typeof j === "object") fileKeys = Object.values(j).map((x) => String((x as { key?: string }).key ?? "")).filter(Boolean);
  } catch {
    /* 未配置 key 文件 */
  }
  return [...new Set([...fileKeys, ...envKeys])];
}

app.use(async (req, res, next) => {
  const remote = req.socket.remoteAddress ?? "";
  if (remote.startsWith("127.") || remote === "::1" || remote === "::ffff:127.0.0.1") return next(); // 本机免 key
  const keys = await loadKeys();
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!keys.length || !token || !keys.includes(token)) {
    res.status(401).json({ error: "无效的 API key（未配置 key 或 key 错误）" });
    return;
  }
  next();
});

// ---------- OpenAI 兼容 /v1/audio/speech ----------
app.post("/v1/audio/speech", async (req, res) => {
  const started = Date.now();
  const { model, input, voice, response_format, speed } = req.body ?? {};
  const text = String(input ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "input（合成文本）不能为空" });
    return;
  }
  // 记录用的模型/音色名（客户视角）
  const askedModel = String(model ?? "");
  const askedVoice = String(voice ?? "");
  try {
    const cfg = await getTtsConfig();
    // model 路由：客户填的 model 匹配到哪个上游就用哪个；否则用默认上游（非 local）
    let providerId: string | undefined;
    const matched = cfg.providers.find((p) => p.enabled && (p.model === askedModel || askedModel.includes(p.model.split("/").pop() ?? "____")));
    if (matched) providerId = matched.id;
    if (!providerId && cfg.defaultProvider !== "local") providerId = cfg.defaultProvider;
    // 本机自用允许本地兜底（OpenClaw 调本服务、无上游时用 SAPI/Edge）；售卖部署不设 TTS_ALLOW_LOCAL 则保持不卖本地音质
    if (!providerId && ALLOW_LOCAL) providerId = "local";
    if (!providerId) {
      res.status(503).json({ error: "服务端未配置可用的 TTS 上游（请先在上游供应商里填写并启用，或设置默认上游）" });
      return;
    }
    const buf = await synthesize(text, {
      providerId,
      voice: askedVoice || undefined,
      speed: typeof speed === "number" ? speed : undefined,
    });
    const fmt = ["mp3", "wav", "opus", "pcm", "aac", "flac"].includes(String(response_format)) ? String(response_format) : "mp3";
    const ctype: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      opus: "audio/opus",
      pcm: "audio/x-pcm",
      aac: "audio/aac",
      flac: "audio/flac",
    };
    res.setHeader("Content-Type", ctype[fmt] ?? "application/octet-stream");
    res.setHeader("X-TTS-Provider", providerId);
    res.setHeader("X-TTS-Chars", String(text.length));
    res.send(buf);
    void recordUsage({
      ts: new Date().toISOString(),
      provider: providerId,
      model: askedModel || "(default)",
      voice: askedVoice || "(default)",
      chars: text.length,
      ms: Date.now() - started,
      bytes: buf.length,
      ok: true,
      via: "api",
    }).catch(() => {});
  } catch (e) {
    const err = String(e);
    void recordUsage({
      ts: new Date().toISOString(),
      provider: "?",
      model: askedModel || "?",
      voice: askedVoice || "?",
      chars: text.length,
      ms: Date.now() - started,
      bytes: 0,
      ok: false,
      err,
      via: "api",
    }).catch(() => {});
    res.status(500).json({ error: err.slice(0, 300) });
  }
});

app.get("/health", async (_req, res) => {
  const cfg = await getTtsConfig();
  const providers = cfg.providers.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, key: maskKey(p.key) }));
  res.json({ ok: true, service: "openclaw-shell-tts", defaultProvider: cfg.defaultProvider, providers });
});

app.listen(PORT, HOST, () => {
  console.log(`TTS 售卖服务已启动: http://${HOST}:${PORT}  (POST /v1/audio/speech，OpenAI 兼容)`);
});
