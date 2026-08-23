// 语音合成（TTS）配置：多上游聚合（OpenAI 兼容 API，可售卖） + 本地兜底（Edge 在线 / Windows SAPI 离线）
// 商业模式：聚合上游 TTS（如硅基流动）→ 对外暴露 OpenAI 兼容 /v1/audio/speech 售卖，赚差价；本地仅作测试/兜底
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";
import { tts as edgeTts, getVoices } from "edge-tts/out/index.js";

export interface TtsProvider {
  id: string;
  name: string; // 显示名，如 硅基流动
  kind: "openai"; // 上游协议类型（第一版仅 OpenAI 兼容；后续可加 minimax/volc 等适配器）
  baseUrl: string; // OpenAI 兼容端点，如 https://api.siliconflow.cn/v1
  key: string;
  model: string; // 默认模型，如 FunAudioLLM/CosyVoice2-0.5B
  voice: string; // 默认音色（硅基流动需带模型前缀，如 FunAudioLLM/CosyVoice2-0.5B:alex）
  speed: number; // 默认语速 0.25~4.0
  markup: number; // 加价倍率（预留计费用：1=原价，1.5=加价 50%）
  enabled: boolean;
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
  providers: [
    {
      id: "siliconflow",
      name: "硅基流动",
      kind: "openai",
      baseUrl: "https://api.siliconflow.cn/v1",
      key: "",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "FunAudioLLM/CosyVoice2-0.5B:alex",
      speed: 1,
      markup: 1,
      enabled: false,
    },
  ],
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
      providers: Array.isArray(c.providers) && c.providers.length ? c.providers : DEFAULTS.providers,
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
  const r = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      input: text,
      voice: voice || p.voice || undefined,
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
    return buf;
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
      return synthProvider(t, provider, opts?.voice, opts?.speed);
    }
  }
  // 本地兜底
  if (cfg.local.engine === "sapi") return synthSapi(t);
  return synthEdge(t, cfg.local.voice, cfg.local.rate, cfg.local.pitch);
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
    const buf = await synthProvider("你好，我是语音合成测试。Hello, voice test.", p);
    return { ok: true, info: `「${p.name}」${p.model} / ${p.voice} 合成成功，音频 ${(buf.length / 1024).toFixed(1)} KB` };
  } catch (e) {
    return { ok: false, info: String(e) };
  }
}
