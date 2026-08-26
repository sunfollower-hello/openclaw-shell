// SILK 转码：QQ 语音消息（file_type=3）上传接口只接受 silk，mp3/wav 会被腾讯 API 拒（"请求数据异常"）
// OpenClaw 核心当前版本不提供 silk 能力（qqbot 插件的 audioFileToSilkBase64 恒为 undefined，
// 它的 silk 分支是死代码），所以由我们在 tts-server 侧直接产出 silk。
import { encode, isSilk, isWav } from "silk-wasm";

/** QQ 语音推荐采样率 */
const SILK_SAMPLE_RATE = 24000;

export interface SilkResult {
  buffer: Buffer;
  durationMs: number;
}

/**
 * 音频转 SILK（#!SILK_V3）。silk-wasm 的 encode 接受 wav/pcm 输入；
 * 已是 silk 的直接返回。mp3 等压缩格式无法直接编码，调用方应传 wav。
 */
export async function toSilk(audio: Buffer, sampleRate = SILK_SAMPLE_RATE): Promise<SilkResult> {
  const input = new Uint8Array(audio);
  if (isSilk(input)) return { buffer: audio, durationMs: 0 };
  if (!isWav(input)) throw new Error("SILK 转码需要 WAV/PCM 输入（mp3 等压缩格式请先解码）");
  const r = await encode(input, sampleRate);
  const buffer = Buffer.from(r.data as unknown as Uint8Array);
  if (!buffer.length || !isSilk(new Uint8Array(buffer))) throw new Error("SILK 编码失败");
  return { buffer, durationMs: Number(r.duration ?? 0) };
}

export { isSilk, isWav };
