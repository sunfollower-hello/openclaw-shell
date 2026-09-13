// 网页侧聊天原文召回：用户提到「第一次/之前/上次」这类往事指代时，
// 从会话日志（conversations/<slug>.jsonl，全量带时间）里按相似度召回旧消息片段，
// 作为动态块注入（历史之后、本轮消息之前）。
//
// 为什么是模块级召回而不是检索工具：网页聊天没有 tool-use 检索通道（通道侧有 memory_search），
// 把召回结果直接贴在生成点附近是最可靠的方式。
//
// 缓存安全性：稳定态（无命中）返回空串 → 动态块为空 → 前缀完全命中缓存（93-96%）；
// 有命中的轮次只有"动态块+本轮消息"走全价（~300 token ≈ 0.0003 元），可忽略。
//
// 匹配算法：字符 bigram 相似度（中文无分词器的 FTS 替代）——
// 把当前消息与每条旧消息都拆成 bigram 集合，按交集大小打分，取分数最高的几条。
import { readConv } from "./conversationStore.js";

/** 与 history-export 同源的时间格式（通道侧检索文件也是这个口径） */
function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 提取文本的 bigram 集合（中英文数字；标点断开，避免跨词组出假 bigram） */
function bigrams(text: string): Set<string> {
  const clean = String(text ?? "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, " ").trim();
  const out = new Set<string>();
  for (const part of clean.split(/\s+/)) {
    if (!part) continue;
    if (/^[a-zA-Z0-9]+$/.test(part)) {
      out.add(part.toLowerCase()); // 英文/数字按整词
      continue;
    }
    if (part.length === 1) {
      out.add(part);
      continue;
    }
    for (let i = 0; i < part.length - 1; i++) out.add(part.slice(i, i + 2));
  }
  return out;
}

export interface ChatRecallOptions {
  /** 最多召回几条 */
  maxHits?: number;
  /** 排除最近 N 条（它们本来就在历史窗口里，召回会重复） */
  excludeTail?: number;
  /** bigram 文档频率上限（占旧消息池的比例）：超过视为通用词（如「今天」「怎么样」）不参与打分 */
  maxDfRatio?: number;
}
/**
 * 从该卡会话日志里召回与 query 最相关的旧消息原文（带精确时间）。
 * 打分 = 带 DF 过滤的 bigram 交集：
 *   1. 统计每个 bigram 在旧消息池里出现在多少条（文档频率 df）；
 *   2. query 的 bigram 里 df 过高的（「今天」「怎么样」这类通用组合）当停用词剔除；
 *   3. 剩下的低频组合（「烤鸭」「股票」这类实体词）每命中一条旧消息计 1 分。
 * 这样「我们之前说的烤鸭」能靠「烤鸭」这一个低频组合召回，而「今天怎么样」不会误召回。
 * 返回渲染好的动态块文本；无命中返回空串（调用方拼进 dynamicBlock）。
 */
export async function recallChatSnippets(
  slug: string,
  query: string,
  opts: ChatRecallOptions = {}
): Promise<string> {
  const maxHits = opts.maxHits ?? 3;
  const excludeTail = opts.excludeTail ?? 20;
  const maxDfRatio = opts.maxDfRatio ?? 0.05;
  const q = String(query ?? "").trim();
  if (q.length < 2) return "";
  const qSet = bigrams(q);
  if (qSet.size < 2) return "";

  const entries = await readConv(slug).catch(() => []);
  if (entries.length <= excludeTail) return "";
  // 滑窗内的不召回（已在上下文）。注意 excludeTail=0 时 slice(0,-0)=slice(0,0)=空数组，
  // 必须走全量分支——新对话第一条消息（history 为空）恰恰是最需要召回的场景
  const pool = excludeTail > 0 ? entries.slice(0, -excludeTail) : entries;
  if (!pool.length) return "";

  // 每条旧消息的 bigram 集合 + 全池文档频率
  const poolSets = pool.map((e) => ({ e, set: bigrams(e.content) }));
  const df = new Map<string, number>();
  for (const { set } of poolSets) for (const b of set) df.set(b, (df.get(b) ?? 0) + 1);
  // query 的 bigram：DF 超过池子 15% 的当停用词剔除（剩不下任何组合 = 没有可定位的实体词）
  const dfCap = Math.max(2, Math.floor(pool.length * maxDfRatio));
  const qTerms = [...qSet].filter((b) => (df.get(b) ?? 0) > 0 && (df.get(b) ?? 0) <= dfCap);
  if (!qTerms.length) return "";
  const qFilter = new Set(qTerms);

  const scored = poolSets
    .map(({ e, set }) => {
      let score = 0;
      let minDf = Infinity;
      for (const b of qFilter) {
        if (set.has(b)) {
          score++;
          minDf = Math.min(minDf, df.get(b) ?? Infinity);
        }
      }
      return { e, score, minDf };
    })
    .filter((x) => {
      if (x.score < 1 || !String(x.e.content ?? "").trim()) return false;
      if (x.score >= 2) return true; // 两个以上低频组合命中 = 强相关
      // 单命中必须是稀有组合（全池最多 3 条消息含它，如「烤鸭」「咖啡店」这类实体词）
      // 「么样」「好吗」这类半通用词 df 较高，单命中不召回（防误召回）
      return x.minDf <= 3;
    });
  if (!scored.length) return "";

  // 相关度优先，但保证最早的命中也在场（「第一次」类指代指向早期对话）
  scored.sort((a, b) => b.score - a.score || a.e.t.localeCompare(b.e.t));
  const picked = scored.slice(0, maxHits);
  const earliest = scored.reduce((min, x) => (x.e.t < min.e.t ? x : min), scored[0]);
  if (!picked.includes(earliest)) picked[picked.length - 1] = earliest;

  picked.sort((a, b) => a.e.t.localeCompare(b.e.t)); // 按时间正序呈现，像聊天时间线
  const lines = picked.map(({ e }) => {
    const who = e.role === "user" ? "用户" : "你";
    const t = e.t ? `[${fmtTime(e.t)}] ` : "";
    const content = String(e.content ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    return `${t}${who}：${content}`;
  });
  return (
    `【相关的旧聊天片段（更早的对话原文，用户提到「第一次/之前/上次」这类往事时参考；注意各片段的日期时间）】\n${lines.join("\n")}`
  );
}
