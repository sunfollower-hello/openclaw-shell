// PII 脱敏：在蒸馏（LLM）之前必须执行
import type { NormalizedMessage, RedactReport } from "./types.js";

const RULES: { re: RegExp; mask: string }[] = [
  { re: /1[3-9]\d{9}/g, mask: "[手机号]" },
  { re: /[\w.-]+@[\w-]+(\.[\w-]+)+/g, mask: "[邮箱]" },
  { re: /\b\d{17}[\dXx]\b/g, mask: "[身份证]" },
  { re: /\b(?:\d[ -]?){13,19}\b/g, mask: "[银行卡]" },
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, mask: "[IP]" },
  { re: /\bwxid_[a-zA-Z0-9_-]+\b/g, mask: "[微信号]" },
  { re: /https?:\/\/\S+/g, mask: "[链接]" },
];

export interface RedactOptions {
  blockedWords?: string[]; // 用户自定义屏蔽词，命中则整条消息移除
}

export function redactText(text: string): string {
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.mask);
  return out;
}

/** 返回脱敏后的消息流 + 报告；blocked 词命中的消息被剔除 */
export function redactMessages(
  messages: NormalizedMessage[],
  options: RedactOptions = {}
): { messages: NormalizedMessage[]; report: RedactReport } {
  const samples: string[] = [];
  const blockedWordsHit = new Set<string>();
  let replaced = 0;
  const out: NormalizedMessage[] = [];

  for (const m of messages) {
    const before = m.text;
    const blocked = (options.blockedWords ?? []).find((w) => w && before.includes(w));
    if (blocked) {
      blockedWordsHit.add(blocked);
      continue;
    }
    const after = redactText(before);
    if (after !== before) {
      replaced++;
      if (samples.length < 10) {
        samples.push(`${m.senderName}: ${before.slice(0, 30)} → ${after.slice(0, 30)}`);
      }
    }
    out.push({ ...m, text: after });
  }

  return {
    messages: out,
    report: { replaced, samples, blockedWordsHit: [...blockedWordsHit] },
  };
}
