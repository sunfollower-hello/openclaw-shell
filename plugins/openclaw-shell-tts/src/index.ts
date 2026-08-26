// openclaw-shell 语音工具插件：让 QQ 里的机器人发原生语音条
//
// 为什么自己直发（源码级结论，勿再走核心 TTS）：
//   1. QQ 语音上传 file_type=3 只接受 SILK；mp3/wav 一律"请求数据异常"。
//   2. 核心只把 responseFormat==="opus" 的音频标记 voiceCompatible（speech-provider:227），
//      给 silk 会被整条丢弃（连文件都不发）。核心要 opus、腾讯要 silk，无解。
//   3. qqbot 插件 v2.0.1/2.0.3 的 silk 分支依赖核心不存在的 ttsRuntime.audioFileToSilkBase64，是死代码。
//   4. 工具 execute 拿不到会话上下文（实测第三参数为空对象），所以收件人从
//      ~/.openclaw/qqbot/data/known-users.json（含 openid/type/accountId/lastInteractionAt）解析。
// 链路：合成 → silk → QQ 官方两步式（上传拿 file_info → msg_type=7 发送）。
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const MEDIA_DIR = path.join(os.homedir(), ".openclaw", "media");
const QQ_DATA_DIR = path.join(os.homedir(), ".openclaw", "qqbot", "data");
const KNOWN_USERS = path.join(QQ_DATA_DIR, "known-users.json");
// openclaw-shell 编译产物（本机固定；可用环境变量覆盖）
const SHELL_DIST =
  process.env.OPENCLAW_SHELL_DIST ?? "file:///D:/ai_workspace/openclaw-shell/dist";

interface ShellTts {
  synthesize(text: string, opts?: { providerId?: string; voice?: string; speed?: number }): Promise<Buffer>;
  convertAudio(buf: Buffer, target: "mp3" | "wav" | "silk"): Promise<Buffer>;
}
interface QQVoice {
  sendVoice(params: { accountId?: string; scope: "c2c" | "group"; targetId: string; silk: Buffer; msgId?: string }): Promise<{ messageId: string }>;
}
interface KnownUser {
  type?: string;
  openid?: string;
  accountId?: string;
  lastInteractionAt?: number;
}

interface Recipient {
  scope: "c2c" | "group";
  targetId: string;
  accountId?: string;
  msgId?: string;
}

/**
 * 解析收件人：工具 execute 拿不到会话上下文，所以从 QQ 通道落盘的消息索引推断。
 * 优先扫各账号的 ref-index.jsonl 取"最近一条非机器人消息"（含 senderId/scope/messageId，
 * 比 known-users 的 lastInteractionAt 更精确、也能拿到被动回复用的 msgId）；
 * 读不到时退回 known-users.json。
 */
async function resolveRecipient(): Promise<Recipient> {
  let best: (Recipient & { ts: number }) | null = null;
  const accounts = await fs.readdir(QQ_DATA_DIR, { withFileTypes: true }).catch(() => []);
  for (const ent of accounts) {
    if (!ent.isDirectory()) continue;
    const file = path.join(QQ_DATA_DIR, ent.name, "ref-index.jsonl");
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let v: { senderId?: string; isBot?: boolean; scope?: string; timestamp?: string; messageId?: string } | undefined;
      try {
        v = (JSON.parse(t) as { v?: typeof v }).v;
      } catch {
        continue;
      }
      if (!v || v.isBot || !v.senderId) continue; // 只认用户发来的消息
      const ts = Date.parse(String(v.timestamp ?? "")) || 0;
      if (best && ts <= best.ts) continue;
      best = {
        ts,
        scope: v.scope === "group" ? "group" : "c2c",
        targetId: String(v.senderId),
        accountId: ent.name,
        // 被动回复窗口只有 5 分钟，过期就按主动消息发（不带 msgId）
        msgId: ts && Date.now() - ts < 4 * 60 * 1000 ? v.messageId : undefined,
      };
    }
  }
  if (best) return { scope: best.scope, targetId: best.targetId, accountId: best.accountId, msgId: best.msgId };
  // 退路：known-users.json
  const raw = await fs.readFile(KNOWN_USERS, "utf8").catch(() => "");
  if (!raw) throw new Error("找不到 QQ 会话记录，请先在 QQ 里和机器人说句话");
  const list = JSON.parse(raw) as KnownUser[];
  const u = list
    .filter((x) => x.openid)
    .sort((a, b) => Number(b.lastInteractionAt ?? 0) - Number(a.lastInteractionAt ?? 0))[0];
  if (!u?.openid) throw new Error("QQ 会话记录里没有可用的收件人");
  return { scope: u.type === "group" ? "group" : "c2c", targetId: String(u.openid), accountId: u.accountId };
}

export default definePluginEntry({
  id: "openclaw-shell-tts",
  name: "Openclaw Shell TTS",
  description: "openclaw-shell 语音合成：把文字合成语音并作为 QQ 原生语音条发送（SILK 直发）",
  register(api) {
    api.registerTool({
      name: "speak",
      label: "发语音（TTS）",
      description:
        "把一段文字合成语音，作为 QQ 语音条发给用户。当用户要求用语音回答、或你想用语音表达时调用。参数 text 为要朗读的文字（建议 200 字以内）。语音会独立发出，所以你的文字回复可以写得简短，不必重复语音内容。",
      parameters: Type.Object({
        text: Type.String({ description: "要合成为语音的文字" }),
      }),
      async execute(_id, params) {
        const p = (params ?? {}) as { text?: unknown };
        const text = String(p.text ?? "").trim();
        if (!text) return { content: [{ type: "text", text: "语音合成失败：文字为空" }] } as never;
        try {
          const tts = (await import(/* @vite-ignore */ `${SHELL_DIST}/core/ttsConfig.js`)) as ShellTts;
          const qq = (await import(/* @vite-ignore */ `${SHELL_DIST}/core/qqVoice.js`)) as QQVoice;
          const raw = await tts.synthesize(text);
          const silk = await tts.convertAudio(raw, "silk");
          const to = await resolveRecipient();
          const { messageId } = await qq.sendVoice({
            accountId: to.accountId,
            scope: to.scope,
            targetId: to.targetId,
            silk,
            msgId: to.msgId, // 5 分钟内走被动回复，不占主动消息频次
          });
          // 留档一份便于排查（不参与投递）
          await fs.mkdir(MEDIA_DIR, { recursive: true }).catch(() => {});
          await fs.writeFile(path.join(MEDIA_DIR, `voice-${Date.now()}.silk`), silk).catch(() => {});
          return {
            content: [
              {
                type: "text",
                text: `已作为 QQ 语音条发送（${(silk.length / 1024).toFixed(1)} KB${messageId ? `，messageId ${messageId.slice(0, 16)}…` : ""}）`,
              },
            ],
          } as never;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `语音发送失败：${msg}` }] } as never;
        }
      },
    });
  },
});
