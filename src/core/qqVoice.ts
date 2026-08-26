// QQ 官方 API 直发语音消息：绕开 OpenClaw 的投递管线
//
// 为什么绕开（源码级结论）：
//   - 核心 TTS 只把 responseFormat==="opus" 的音频标记为 voiceCompatible
//     （speech-provider:227），给 silk 会被整条丢弃；
//   - qqbot 插件 v2.0.1/2.0.3 的 silk 分支依赖核心不存在的 ttsRuntime.audioFileToSilkBase64，
//     是死代码；插件出站也没有转码能力。
// 官方两步式（bot.q.qq.com 文档）：
//   1) POST /v2/users/{openid}/files    file_type=3(语音) + file_data(base64) -> file_info
//   2) POST /v2/users/{openid}/messages msg_type=7(富媒体) + media.file_info
// 鉴权：POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret} -> access_token
//       调用时 header: Authorization: QQBot {access_token}
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";

export interface QQCreds {
  appId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** 取 access_token（带缓存，官方有效期 7200s，这里提前 120s 过期） */
export async function getAccessToken(creds: QQCreds): Promise<string> {
  const cached = tokenCache.get(creds.appId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.clientSecret }),
    signal: AbortSignal.timeout(20000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`取 access_token 失败 HTTP ${r.status}: ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt) as { access_token?: string; expires_in?: string | number; message?: string };
  if (!j.access_token) throw new Error(`取 access_token 失败: ${txt.slice(0, 200)}`);
  const ttl = Number(j.expires_in ?? 7200);
  tokenCache.set(creds.appId, { token: j.access_token, expiresAt: Date.now() + Math.max(60, ttl - 120) * 1000 });
  return j.access_token;
}

/** 读 ~/.openclaw/openclaw.json 里指定 QQ 账号的凭证 */
export async function readQQCreds(accountId?: string): Promise<QQCreds> {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as {
    channels?: { qqbot?: { appId?: string; clientSecret?: string; accounts?: Record<string, { appId?: string; clientSecret?: string }> } };
  };
  const qq = cfg.channels?.qqbot;
  if (!qq) throw new Error("openclaw.json 里没有 channels.qqbot 配置");
  const accounts = qq.accounts ?? {};
  const acct = accountId ? accounts[accountId] : undefined;
  const appId = acct?.appId ?? qq.appId ?? Object.values(accounts).find((a) => a.appId)?.appId;
  const clientSecret = acct?.clientSecret ?? qq.clientSecret ?? Object.values(accounts).find((a) => a.clientSecret)?.clientSecret;
  if (!appId || !clientSecret) throw new Error(`找不到 QQ 凭证（accountId=${accountId ?? "(未指定)"}）`);
  return { appId: String(appId), clientSecret: String(clientSecret) };
}

export type QQScope = "c2c" | "group";

/** 第一步：上传富媒体，拿 file_info。fileType 3=语音 */
export async function uploadMedia(params: {
  creds: QQCreds;
  scope: QQScope;
  targetId: string; // c2c: 用户 openid；group: group_openid
  fileType: 1 | 2 | 3 | 4;
  data: Buffer;
}): Promise<string> {
  const token = await getAccessToken(params.creds);
  const url =
    params.scope === "c2c"
      ? `${API_BASE}/v2/users/${params.targetId}/files`
      : `${API_BASE}/v2/groups/${params.targetId}/files`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_type: params.fileType, file_data: params.data.toString("base64"), srv_send_msg: false }),
    signal: AbortSignal.timeout(60000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`上传语音失败 HTTP ${r.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt) as { file_info?: string; message?: string; code?: number };
  if (!j.file_info) throw new Error(`上传语音未返回 file_info: ${txt.slice(0, 300)}`);
  return j.file_info;
}

/** 第二步：发富媒体消息（msg_type=7）。msgId 为被动回复的消息 id（5 分钟内有效），不传则算主动消息 */
export async function sendMediaMessage(params: {
  creds: QQCreds;
  scope: QQScope;
  targetId: string;
  fileInfo: string;
  msgId?: string;
  msgSeq?: number;
}): Promise<string> {
  const token = await getAccessToken(params.creds);
  const url =
    params.scope === "c2c"
      ? `${API_BASE}/v2/users/${params.targetId}/messages`
      : `${API_BASE}/v2/groups/${params.targetId}/messages`;
  const body: Record<string, unknown> = { msg_type: 7, media: { file_info: params.fileInfo } };
  if (params.msgId) {
    body.msg_id = params.msgId;
    body.msg_seq = params.msgSeq ?? Math.floor(Math.random() * 900000) + 1000;
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`发送语音消息失败 HTTP ${r.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt) as { id?: string };
  return j.id ?? "";
}

/** 一步到位：silk 音频 → QQ 语音条 */
export async function sendVoice(params: {
  accountId?: string;
  scope: QQScope;
  targetId: string;
  silk: Buffer;
  msgId?: string;
}): Promise<{ messageId: string }> {
  const creds = await readQQCreds(params.accountId);
  const fileInfo = await uploadMedia({ creds, scope: params.scope, targetId: params.targetId, fileType: 3, data: params.silk });
  const messageId = await sendMediaMessage({ creds, scope: params.scope, targetId: params.targetId, fileInfo, msgId: params.msgId });
  return { messageId };
}
