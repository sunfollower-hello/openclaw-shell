// 解析器：WeFlow 导出（UI/API 两种形态）→ 统一消息流
// 参考字段：
//   UI 导出: sender / accountName / timestamp / type / content
//   API:     senderUsername / createTime / content / parsedContent / isSend
import type { NormalizedMessage } from "./types.js";

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return undefined;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  return 0;
}

/** 秒 vs 毫秒归一化：返回秒级时间戳 */
function normalizeTs(v: number): number {
  return v > 1e12 ? Math.floor(v / 1000) : v;
}

export interface ParseResult {
  messages: NormalizedMessage[];
  talkers: string[];
  skipped: number;
}

function normalizeMessage(raw: Record<string, unknown>): NormalizedMessage | null {
  const content =
    pick(raw, ["content", "parsedContent", "rawContent", "text"]) ?? "";
  if (!content.trim()) return null;

  // API 形态的 content 可能带 "wxid_xxx:" 前缀（WeFlow 已知问题），剥掉
  const clean = content.replace(/^wxid_[^\s:：]+[:：]\s*/, "").trim();
  if (!clean || /^\[(图片|视频|语音|文件|表情)\]$/.test(clean)) return null;

  const sender = pick(raw, ["sender", "senderUsername", "fromUser", "from"]) ?? "unknown";
  const senderName = pick(raw, ["accountName", "senderName", "nickname", "name", "remark"]) ?? sender;
  const ts = normalizeTs(toNumber(raw.createTime ?? raw.timestamp ?? raw.time ?? 0));

  return { sender, senderName, ts, text: clean };
}

/** 从任意导出的 JSON 里找出消息数组 */
export function parseWeFlowJson(input: unknown): ParseResult {
  let list: unknown[] = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.messages)) list = obj.messages as unknown[];
    else if (Array.isArray(obj.records)) list = obj.records as unknown[];
    else if (Array.isArray(obj.data)) list = obj.data as unknown[];
  }
  if (list.length === 0) {
    throw new Error("未找到消息数组（支持 WeFlow UI/API 导出、或含 messages/records/data 的 JSON）");
  }

  const messages: NormalizedMessage[] = [];
  let skipped = 0;
  for (const raw of list) {
    if (raw && typeof raw === "object") {
      const m = normalizeMessage(raw as Record<string, unknown>);
      if (m) messages.push(m);
      else skipped++;
    }
  }
  if (messages.length === 0) throw new Error("解析后没有可用的文本消息");

  const talkers = [...new Set(messages.map((m) => m.senderName))];
  return { messages, talkers, skipped };
}

/** 解析「昵称: 内容」每行一条的纯文本聊天记录（用户粘贴导入用） */
export function parsePlainText(text: string): NormalizedMessage[] {
  const msgs: NormalizedMessage[] = [];
  const nameRe = /^\s*([^:：]{1,24})\s*[：:]\s*(.+)$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(nameRe);
    if (m && m[2].trim()) {
      msgs.push({ sender: m[1].trim(), senderName: m[1].trim(), ts: 0, text: m[2].trim() });
    }
  }
  return msgs;
}
