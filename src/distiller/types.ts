// 蒸馏流水线 · 类型定义
export interface NormalizedMessage {
  sender: string;      // 发送者标识（wxid / 昵称）
  senderName: string;  // 展示名
  ts: number;          // 秒级时间戳
  text: string;        // 清洗后的文本
}

export interface RedactReport {
  replaced: number;
  samples: string[];   // 脱敏示例（前后对照）
  blockedWordsHit: string[];
}

export interface DistillItem {
  text: string;
  evidence: "verbatim" | "artifact" | "impression";
  /** 细分类别（catchphrase/tone/quote/length/multi_send/emoji/trait/value/emotion/boundary/fact/relation/timeline） */
  kind?: string;
  topic?: string;
  scope?: string;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DIMENSIONS = ["interaction", "personality", "memory"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
