// 出站文本清理：剥离模型泄漏的「纯文本思维链/推理前缀」。
// OpenClaw 核心的 stripAssistantInternalScaffolding 只剥 XML 标签（<think> 等），
// QQ 插件 sanitizeQQBotText 同理；低级模型常以「分析：」「思路：」「（思考）」等
// 纯文本形式输出思维链，无标签可剥，需要这里的规则兜底。
import type { PersonaCard } from "./schema.js";

/** 常见纯文本思维链/推理前缀（行首匹配，整行剥离） */
const COT_LINE_PREFIXES = [
  /^[（(]?\s*(?:思考|思路|推理|分析|内心|让我想想|让我想|想一想|思考中|分析中)[：:）)]\s*[^\n]*$/,
  /^[（(]?\s*(?:作为一个\s*(?:AI|助手|模型)|作为\s*(?:AI|助手|模型))[）)]?\s*[，,:：]?\s*[^\n]*$/,
  /^(?:好的|嗯|明白|收到|了解了)[，,。.\s]*让我(?:想想|思考|分析|确认)一下[^\n]*$/,
  /^\[?(?:思考|推理|思维链|CoT)[：:]\s*[^\n]*$/,
  /^分析[：:]\s*[^\n]*$/,
  /^思路[：:]\s*[^\n]*$/,
];

/** 行内包裹式思维链（整块剥离，如（让我想想……）/【推理：……】） */
const COT_BLOCK_RE = [
  /[（(]\s*(?:让我想想|思考|内心独白|自言自语)[^）)]*[）)]/g,
  /【\s*(?:推理|思考|分析)[：:][^】]*】/g,
  // 生图自检（CoT）：规则要求模型输出 <cot>…</cot>。成对的先剥；
  // 模型漏写闭合标签时按「从这里到文末全剥」兜底——否则整条消息都变成思维链发给用户。
  /<cot>[\s\S]*?<\/cot>\s*/gi,
  /<cot_protocol>[\s\S]*?<\/cot_protocol>\s*/gi,
  /<cot>[\s\S]*$/i,
  /<cot_protocol>[\s\S]*$/i,
];

/** 剥离后若文本以连接词开头（所以/总之/因此等），一并去掉残留 */
const LEADING_RESIDUE_RE = /^[\s\n]*(?:所以|总之|因此|综上所述|好，|好的，|那么，)[\s\n]*/;

/**
 * 剥离模型回复里的纯文本思维链。返回清理后的文本；无思维链时原样返回。
 * 规则保守：只剥「明显是推理前缀/思考块」的行与块，不误伤角色正文
 * （角色扮演里"（轻笑）"这类动作描写必须保留）。
 */
export function stripCoT(text: string): string {
  if (!text) return text;
  // 出现过 CoT 标签：剥完以结果为准（哪怕剩空），**不能**回退成原文——
  // 否则"只输出了自检、没有正文"时会把整段思维链原样发给用户（实测踩到）。
  const sawTagCot = /<cot/i.test(text);
  let out = text;
  for (const re of COT_BLOCK_RE) out = out.replace(re, "");
  const lines = out.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true; // 空行保留（分段/拆条语义）
    return !COT_LINE_PREFIXES.some((re) => re.test(t));
  });
  out = kept.join("\n").replace(LEADING_RESIDUE_RE, "").trim();
  if (sawTagCot) return out;
  return out || text.trim();
}

/** 网页聊天回复的完整清理：剥离纯文本思维链（结构化 reasoning 由通道侧处理） */
export function sanitizeChatReply(card: PersonaCard | undefined, reply: string): string {
  const text = stripCoT(reply);
  // 后续如需按卡片/渠道加更多清理（去 markdown 等），在此扩展
  void card;
  return text;
}
