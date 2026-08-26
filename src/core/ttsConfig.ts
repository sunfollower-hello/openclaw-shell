// 语音合成（TTS）配置：多上游聚合（OpenAI 兼容 / MiniMax / 火山豆包，可售卖） + 本地兜底（Edge 在线 / Windows SAPI 离线）
// 商业模式：聚合上游 TTS → 对外暴露 OpenAI 兼容 /v1/audio/speech 售卖，赚差价；本地仅作测试/兜底
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";
import { tts as edgeTts, getVoices } from "edge-tts/out/index.js";

/** 上游协议类型：openai=OpenAI 兼容 /v1/audio/speech；minimax=海螺 t2a_v2；volc=火山豆包 openspeech V3 */
export type TtsProviderKind = "openai" | "minimax" | "volc";
export const TTS_KINDS: TtsProviderKind[] = ["openai", "minimax", "volc"];

export interface TtsProvider {
  id: string;
  name: string; // 显示名，如 硅基流动
  kind: TtsProviderKind; // 上游协议类型
  baseUrl: string; // 端点：openai 以 /v1 结尾（如 https://api.siliconflow.cn/v1）；minimax 以 /v1 结尾（自动拼 /t2a_v2）；volc 填完整接口地址（默认 https://openspeech.bytedance.com/api/v3/tts/unidirectional）
  key: string;
  model: string; // 默认模型：openai 如 FunAudioLLM/CosyVoice2-0.5B；minimax 如 speech-02-hd；volc=Resource ID（seed-tts-1.0/2.0/icl-2.0，留空按音色自动推断）
  voice: string; // 默认音色：openai 如 FunAudioLLM/CosyVoice2-0.5B:alex；minimax 为 voice_id；volc 为 Speaker ID
  speed: number; // 默认语速（openai 0.25~4 / minimax 0.5~2 / volc 暂不支持）
  markup: number; // 加价倍率（预留计费用：1=原价，1.5=加价 50%）
  enabled: boolean;
  appId?: string; // 仅 volc 用：火山旧版鉴权 X-Api-App-Id；新版单 Key 鉴权留空
}

export interface TtsConfig {
  defaultProvider: string; // provider id，或 "local" 走本地兜底
  local: {
    engine: "edge" | "sapi"; // edge：微软 Edge 神经语音（在线、免费、音质好）；sapi：Windows 离线（音质一般）
    voice: string; // edge 语音名，如 zh-CN-XiaoxiaoNeural
    rate: string; // 语速，如 +0%
    pitch: string; // 音调，如 +0Hz
  };
  providers: TtsProvider[];
}

/** 常用中文 Edge 神经语音（前端下拉可选） */
export const COMMON_EDGE_VOICES: { id: string; label: string }[] = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓（女·温暖）" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊（女）" },
  { id: "zh-CN-XiaochenNeural", label: "晓辰（女·冷静）" },
  { id: "zh-CN-XiaohanNeural", label: "晓涵（女）" },
  { id: "zh-CN-XiaomengNeural", label: "晓梦（女）" },
  { id: "zh-CN-XiaomoNeural", label: "晓墨（女）" },
  { id: "zh-CN-XiaoruiNeural", label: "晓睿（女）" },
  { id: "zh-CN-XiaoshuangNeural", label: "晓双（女·儿童）" },
  { id: "zh-CN-XiaoxuanNeural", label: "晓萱（女）" },
  { id: "zh-CN-XiaoyanNeural", label: "晓颜（女·儿童）" },
  { id: "zh-CN-XiaozhenNeural", label: "晓甄（女）" },
  { id: "zh-CN-YunxiNeural", label: "云希（男·少年）" },
  { id: "zh-CN-YunjianNeural", label: "云健（男·成熟）" },
  { id: "zh-CN-YunyangNeural", label: "云扬（男·新闻）" },
  { id: "zh-CN-YunfengNeural", label: "云枫（男）" },
  { id: "zh-CN-YunhaoNeural", label: "云皓（男）" },
  { id: "zh-CN-YunxiaNeural", label: "云夏（男）" },
  { id: "zh-CN-YunzeNeural", label: "云泽（男）" },
  { id: "zh-TW-HsiaoChenNeural", label: "曉臻（台湾·女）" },
  { id: "zh-TW-YunJheNeural", label: "雲哲（台湾·男）" },
  { id: "zh-HK-HiuMaanNeural", label: "曉曼（香港·女）" },
  { id: "zh-HK-WanLungNeural", label: "雲龍（香港·男）" },
];

const DEFAULTS: TtsConfig = {
  defaultProvider: "local",
  local: { engine: "edge", voice: "zh-CN-XiaoxiaoNeural", rate: "+0%", pitch: "+0Hz" },
  // 默认不预置供应商：由前端「添加提供商 → 选择服务商」向导录入（预设见 web/app.js TTS_PRESETS）
  providers: [],
};

async function cfgPath(): Promise<string> {
  return path.join(dataDir(), "ttsConfig.json");
}

export async function getTtsConfig(): Promise<TtsConfig> {
  try {
    const c = JSON.parse(await fs.readFile(await cfgPath(), "utf8"));
    return {
      ...DEFAULTS,
      ...c,
      local: { ...DEFAULTS.local, ...(c.local ?? {}) },
      providers: Array.isArray(c.providers) ? c.providers : DEFAULTS.providers,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function saveTtsConfig(cfg: TtsConfig): Promise<void> {
  await fs.mkdir(path.dirname(await cfgPath()), { recursive: true });
  await fs.writeFile(await cfgPath(), JSON.stringify(cfg, null, 2), "utf8");
}

export function maskKey(s?: string): string {
  return s ? s.slice(0, 6) + "…" : "";
}

/** 拉取 Edge 全部可用语音（含各语言） */
export async function listEdgeVoices(): Promise<{ id: string; label: string }[]> {
  try {
    const voices = await getVoices();
    return voices.map((v) => ({
      id: v.ShortName,
      label: `${v.Locale} · ${v.FriendlyName}（${v.Gender === "Male" ? "男" : "女"}）`,
    }));
  } catch (e) {
    throw new Error(`获取 Edge 语音列表失败: ${String(e)}`);
  }
}

// ---------- 上游：OpenAI 兼容 /v1/audio/speech ----------
async function synthProvider(text: string, p: TtsProvider, voice?: string, speed?: number): Promise<Buffer> {
  const base = p.baseUrl.replace(/\/+$/, "");
  if (!base || !p.key) throw new Error(`上游「${p.name}」未配置 Base URL / Key`);
  const v = voice || p.voice;
  if (!v) throw new Error(`上游「${p.name}」未配置音色（OpenAI 兼容 TTS 的 voice 必填），请到「语音合成」页编辑该提供商填写「默认音色」`);
  const r = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      input: text,
      voice: v,
      response_format: "mp3",
      speed: speed ?? p.speed ?? 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`TTS API 失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error("TTS API 返回空音频");
  return buf;
}

// ---------- 上游：MiniMax 海螺 t2a_v2（协议与 OpenAI 不同：text/voice_setting/audio_setting + hex/url 响应） ----------
async function synthMinimax(text: string, p: TtsProvider, voice?: string, speed?: number): Promise<Buffer> {
  const base = (p.baseUrl || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
  if (!p.key) throw new Error(`上游「${p.name}」未配置 Key`);
  const r = await fetch(`${base}/t2a_v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model || "speech-02-hd",
      text,
      stream: false,
      voice_setting: {
        voice_id: voice || p.voice || "male-qn-qingse",
        speed: Math.min(2, Math.max(0.5, speed ?? p.speed ?? 1)),
        vol: 1,
        pitch: 0,
      },
      audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1 },
      output_format: "url", // 直接拿下载链接，绕开 hex/base64 编码歧义
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`MiniMax 失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json().catch(() => null)) as { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } } | null;
  const code = j?.base_resp?.status_code;
  if (code !== undefined && code !== 0) throw new Error(`MiniMax 失败 code=${code}: ${j?.base_resp?.status_msg ?? ""}`);
  const audio = j?.data?.audio;
  if (!audio) throw new Error("MiniMax 返回空音频");
  // data.audio 可能是下载链接 / hex / base64，自适应解码
  const str = String(audio).trim();
  if (/^https?:\/\//i.test(str)) {
    const ar = await fetch(str, { signal: AbortSignal.timeout(60000) });
    if (!ar.ok) throw new Error(`下载 MiniMax 音频失败 HTTP ${ar.status}`);
    const buf = Buffer.from(await ar.arrayBuffer());
    if (buf.length) return buf;
    throw new Error("MiniMax 音频链接返回空");
  }
  if (/^[0-9a-fA-F]+$/.test(str)) return Buffer.from(str, "hex"); // 纯 hex 字符串按 hex 解码
  const buf = Buffer.from(str, "base64");
  if (!buf.length) throw new Error("MiniMax 音频解码失败");
  return buf;
}

// ---------- 上游：火山豆包 openspeech V3 单向流式（X-Api-* 头 + req_params + NDJSON base64 流） ----------
function deriveVolcResourceId(speaker: string): string {
  if (speaker.startsWith("S_")) return "seed-icl-2.0"; // 声音复刻
  if (speaker.includes("_uranus_") || speaker.startsWith("saturn_")) return "seed-tts-2.0"; // 官方 2.0 音色
  return "seed-tts-1.0"; // *_mars_ / *_moon_ 等官方 1.0 音色
}

async function synthVolc(text: string, p: TtsProvider, voice?: string): Promise<Buffer> {
  const url = (p.baseUrl || "https://openspeech.bytedance.com/api/v3/tts/unidirectional").replace(/\/+$/, "");
  if (!p.key) throw new Error(`上游「${p.name}」未配置 Key`);
  const speaker = voice || p.voice || "";
  if (!speaker) throw new Error(`上游「${p.name}」未配置音色（Speaker ID）`);
  // 新版单 API Key 用 X-Api-Key；旧版（控制台 AppID/Access Token）填了 appId 则用 X-Api-App-Id + X-Api-Access-Key
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Api-Resource-Id": p.model || deriveVolcResourceId(speaker) };
  if (p.appId) {
    headers["X-Api-App-Id"] = p.appId;
    headers["X-Api-Access-Key"] = p.key;
  } else {
    headers["X-Api-Key"] = p.key;
  }
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user: { uid: "openclaw-shell" },
      req_params: { text, speaker, audio_params: { format: "mp3", sample_rate: 24000 } },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`豆包失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const raw = await r.text();
  const chunks: Buffer[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j: { code?: number; data?: string; message?: string } | null = null;
    try { j = JSON.parse(t); } catch { continue; }
    if (!j) continue;
    if (j.code === 20000000) break; // 合成结束标记
    if (j.code !== undefined && j.code !== 0) throw new Error(`豆包失败 code=${j.code}: ${j.message ?? ""}`);
    if (j.data) chunks.push(Buffer.from(String(j.data), "base64"));
  }
  if (!chunks.length) throw new Error("豆包返回空音频");
  return Buffer.concat(chunks);
}

/** 按 kind 分派到对应上游适配器 */
function synthByKind(text: string, p: TtsProvider, voice?: string, speed?: number): Promise<Buffer> {
  if (p.kind === "minimax") return synthMinimax(text, p, voice, speed);
  if (p.kind === "volc") return synthVolc(text, p, voice);
  return synthProvider(text, p, voice, speed);
}

// ---------- 本地：Edge 在线免费合成 ----------
async function synthEdge(text: string, voice: string, rate: string, pitch: string): Promise<Buffer> {
  const buf = await edgeTts(text, { voice: voice || DEFAULTS.local.voice, rate: rate || "+0%", pitch: pitch || "+0Hz" });
  if (!buf.length) throw new Error("Edge 返回空音频（可能网络受限）");
  return buf;
}

// ---------- 本地：Windows SAPI 离线合成（音质一般，离线可用） ----------
const SAPI_SCRIPT_TEMPLATE = (text: string, outFile: string): string =>
  [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}",
    "$s.SetOutputToWaveFile('" + outFile.replace(/'/g, "''") + "')",
    "$s.Speak('" + text.replace(/'/g, "''") + "')",
    "$s.Dispose()",
  ].join("\n");

/** SAPI 的 PCM WAV 转 MP3（纯 JS lamejs）：网页播放/售卖接口默认用 mp3 */
export async function wavToMp3(wav: Buffer): Promise<Buffer> {
  const lameMod: { Mp3Encoder?: unknown } = (await import("@breezystack/lamejs")) as { Mp3Encoder?: unknown };
  const Mp3Encoder = lameMod.Mp3Encoder as
    | (new (channels: number, sampleRate: number, kbps: number) => {
        encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
        flush(): Int8Array;
      })
    | undefined;
  if (!Mp3Encoder) throw new Error("MP3 编码器加载失败");
  // SAPI 产标准 44 字节头 WAV（16kHz 16bit mono）；找不到 data 块时按 44 偏移
  let dataOffset = 44;
  for (let i = 12; i < wav.length - 8; i++) {
    if (wav[i] === 0x64 && wav[i + 1] === 0x61 && wav[i + 2] === 0x74 && wav[i + 3] === 0x61) {
      dataOffset = i + 8;
      break;
    }
  }
  const channels = wav.length > 23 ? wav.readUInt16LE(22) : 1;
  const sampleRate = wav.length > 27 ? wav.readUInt32LE(24) : 16000;
  const pcm = wav.subarray(dataOffset);
  const encoder = new Mp3Encoder(channels, sampleRate, 64);
  const blockBytes = 1152 * 2 * channels;
  const out: Buffer[] = [];
  for (let i = 0; i + blockBytes <= pcm.length; i += blockBytes) {
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset + i, 1152 * channels);
    const data = channels === 1 ? encoder.encodeBuffer(samples) : encoder.encodeBuffer(samples, samples);
    if (data && data.length) out.push(Buffer.from(data));
  }
  const end = encoder.flush();
  if (end && end.length) out.push(Buffer.from(end));
  if (!out.length) throw new Error("MP3 编码失败：无输出");
  return Buffer.concat(out);
}

async function synthSapi(text: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocls-sapi-"));
  const script = path.join(tmpDir, "speak.ps1");
  const wav = path.join(tmpDir, "out.wav");
  try {
    // PowerShell 5.1 按 BOM 识别 UTF-8，写带 BOM 的脚本保证中文不乱码
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await fs.writeFile(script, Buffer.concat([bom, Buffer.from(SAPI_SCRIPT_TEMPLATE(text, wav), "utf8")]));
    await new Promise<void>((resolve, reject) => {
      execFile(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
        { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => (err ? reject(new Error(`SAPI 失败: ${String(stderr || err).slice(0, 200)}`)) : resolve())
      );
    });
    const buf = await fs.readFile(wav);
    if (!buf.length) throw new Error("SAPI 返回空音频");
    return buf; // 返回原始 WAV：silk 编码需要 wav 输入，mp3 由 convertAudio 按需转换
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface SynthesizeOptions {
  providerId?: string; // 指定上游；缺省用 defaultProvider
  voice?: string;
  speed?: number;
}

/** 按配置合成文本，返回音频 Buffer；providerId 不存在时抛错 */
export async function synthesize(text: string, opts?: SynthesizeOptions): Promise<Buffer> {
  const cfg = await getTtsConfig();
  const t = String(text ?? "").trim();
  if (!t) throw new Error("文本为空");
  const target = opts?.providerId ?? cfg.defaultProvider;
  const provider = cfg.providers.find((p) => p.id === target) ?? null;
  if (target !== "local") {
    if (!provider) throw new Error(`未找到 TTS 上游「${target}」`);
    if (!provider.enabled && !opts?.providerId) {
      // 默认上游未启用 → 兜底到本地（显式指定上游则报错）
    } else {
      if (!provider.enabled) throw new Error(`TTS 上游「${provider.name}」未启用`);
      return synthByKind(t, provider, opts?.voice, opts?.speed);
    }
  }
  // 本地兜底
  if (cfg.local.engine === "sapi") return synthSapi(t);
  return synthEdge(t, cfg.local.voice, cfg.local.rate, cfg.local.pitch);
}

/** 音频格式判定：RIFF=wav，#!SILK=silk，其余按 mp3/压缩格式对待 */
export function detectAudioKind(buf: Buffer): "wav" | "silk" | "other" {
  if (buf.length > 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "wav";
  const head = buf.subarray(0, 10).toString("latin1");
  if (head.includes("#!SILK")) return "silk";
  return "other";
}

/**
 * 把合成结果转成目标格式。silk（QQ 语音消息唯一接受的上传格式）只能从 wav 编码，
 * 上游直接返回 mp3 时无法转 silk，会抛出可读错误提示改用本地兜底或让上游输出 wav。
 */
export async function convertAudio(buf: Buffer, target: "mp3" | "wav" | "silk"): Promise<Buffer> {
  const kind = detectAudioKind(buf);
  if (target === "silk") {
    if (kind === "silk") return buf;
    if (kind !== "wav") throw new Error("生成 SILK 需要 WAV 音频；当前上游返回的是压缩格式（mp3 等），请让上游输出 wav 或使用本地兜底");
    const { toSilk } = await import("./silk.js");
    return (await toSilk(buf)).buffer;
  }
  if (target === "wav") {
    if (kind === "wav") return buf;
    throw new Error("上游返回的不是 WAV，无法转换为 WAV");
  }
  // mp3：wav 本地编码，其他（已是 mp3/压缩格式）原样返回
  return kind === "wav" ? await wavToMp3(buf) : buf;
}

/** 测试某个上游（或本地兜底），返回可读结果（不落盘、不记账） */
export async function testTts(target?: string): Promise<{ ok: boolean; info: string }> {
  const cfg = await getTtsConfig();
  const id = target ?? cfg.defaultProvider;
  try {
    if (id === "local") {
      const buf = cfg.local.engine === "sapi" ? await synthSapi("你好，我是离线语音测试。") : await synthEdge("你好，我是语音合成测试。", cfg.local.voice, cfg.local.rate, cfg.local.pitch);
      const engine = cfg.local.engine === "sapi" ? "Windows SAPI（离线）" : `Edge（${cfg.local.voice}）`;
      return { ok: true, info: `${engine} 合成成功，音频 ${(buf.length / 1024).toFixed(1)} KB` };
    }
    const p = cfg.providers.find((x) => x.id === id);
    if (!p) return { ok: false, info: `未找到上游「${id}」` };
    const buf = await synthByKind("你好，我是语音合成测试。Hello, voice test.", p);
    return { ok: true, info: `「${p.name}」${p.model} / ${p.voice} 合成成功，音频 ${(buf.length / 1024).toFixed(1)} KB` };
  } catch (e) {
    return { ok: false, info: String(e) };
  }
}
