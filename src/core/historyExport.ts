// 本地聊天原文 → 通道可检索：把网页聊天（surface=web）轮次整理成 md 导出到
// data/history-export/<slug>.md，追加进 OpenClaw memorySearch.extraPaths
// （qmd 检索时即读文件，无需重建索引），QQ/微信 agent 的 memory_search 即可检索到
// 本地聊天记录 —— 「在 QQ/微信 上聊天能读到在网页聊过的内容」。
// 范围：最近 HISTORY_EXPORT_ROUNDS 轮（以用户消息计数）；私密性：仅本地文件，永不推送通道。
// 网页聊天落盘后调 scheduleHistoryExport(slug)（防抖 5s）即可。
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";
import { readConv } from "./conversationStore.js";

/** 导出深度：最近多少轮（用户消息计数）本地聊天原文进可检索范围（用户拍板 100） */
export const HISTORY_EXPORT_ROUNDS = 100;

/** USER.md / SKILL.md 注入的本地聊天轮数（每轮对话必带的近聊天锚点） */
export const RECENT_CHAT_INJECT_ROUNDS = 10;

// 与 scripts/clean-media-lines.mjs 同源：剥离文本里的 MEDIA: 指令行（模型复读工具结果的坏样例，
// 会教模型编造 MEDIA 路径/表情名）。这里用于导出/注入前过滤，防止坏样例再流进 USER.md / history-export / SKILL。
const MEDIA_RE =
  /^\s*MEDIA:\s*(?:`([^`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv))`|([^\s`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv)))/i;
export function cleanMediaLines(text: string): string {
  const raw = String(text ?? "");
  if (!raw.includes("MEDIA:")) return raw;
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(MEDIA_RE);
    if (m) {
      const rest = line.slice(m[0].length).trim();
      if (rest) out.push(rest); // 同行后续文字保留
    } else if (/^\s*MEDIA:\s*/i.test(line)) {
      // 无扩展名的 MEDIA 行（如 MEDIA:null）→ 整行剔除
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function historyExportDir(): string {
  return path.join(dataDir(), "history-export");
}

export function historyExportFile(slug: string): string {
  return path.join(historyExportDir(), `${slug}.md`);
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 导出某卡的本地聊天记录。没有本地聊天时不写（返回 null，保留旧文件）。
 * 返回写出的 md 文本（或 null）。
 */
export async function exportHistoryToMarkdown(slug: string): Promise<string | null> {
  const entries = await readConv(slug).catch(() => []);
  const local = entries.filter((e) => e.surface === "web");
  if (!local.length) return null;

  // 取最近 HISTORY_EXPORT_ROUNDS 轮（按 user 消息计数），其后所有消息都保留
  let userCount = 0;
  let startIdx = 0;
  for (let i = local.length - 1; i >= 0; i--) {
    if (local[i].role === "user") userCount++;
    if (userCount >= HISTORY_EXPORT_ROUNDS) {
      startIdx = i;
      break;
    }
  }
  const slice = local.slice(startIdx);

  const lines: string[] = [
    `# ${slug} · 本地聊天记录（最近 ${Math.min(userCount, HISTORY_EXPORT_ROUNDS)} 轮）`,
    "",
    "> 这是用户在 openclaw-shell 网页上与该角色聊过的历史原文。用户可能在网页端和你聊过天；",
    "> 当话题涉及以前的聊天内容时，从这些记录里找线索自然接续，不要复述「网页记录」这类字眼。",
    "",
  ];
  for (const e of slice) {
    const who = e.role === "user" ? "用户" : "你";
    const t = e.t ? fmtTime(e.t) : "";
    const content = cleanMediaLines(String(e.content ?? "")).replace(/\n+/g, " ").trim();
    if (!content) continue;
    lines.push(`${t ? `[${t}] ` : ""}${who}：${content}`);
  }

  const md = lines.join("\n") + "\n";
  await fs.mkdir(historyExportDir(), { recursive: true });
  await fs.writeFile(historyExportFile(slug), md, "utf8");
  return md;
}

// 防抖导出：网页聊天落盘后调用，避免连续消息反复刷盘
const timers = new Map<string, NodeJS.Timeout>();
export function scheduleHistoryExport(slug: string, delayMs = 5000): void {
  const old = timers.get(slug);
  if (old) clearTimeout(old);
  timers.set(slug, setTimeout(() => {
    timers.delete(slug);
    void exportHistoryToMarkdown(slug).catch(() => {});
  }, delayMs));
}

/** 启动时对全部卡跑一遍（保证新卡也有导出） */
export async function exportAllHistoriesToMarkdown(): Promise<string[]> {
  const dir = path.join(dataDir(), "cards");
  const names = await fs.readdir(dir).catch(() => []);
  const out: string[] = [];
  for (const n of names) {
    const md = await exportHistoryToMarkdown(n).catch(() => null);
    if (md) out.push(n);
  }
  return out;
}

/** 取某卡本地网页聊天（surface=web）最近 rounds 轮（按用户消息计数），供 USER.md / SKILL.md 注入 */
export async function readRecentLocalChat(
  slug: string,
  rounds: number = RECENT_CHAT_INJECT_ROUNDS
): Promise<{ role: string; content: string }[]> {
  const entries = await readConv(slug).catch(() => []);
  const local = entries.filter((e) => e.surface === "web");
  if (!local.length) return [];
  let userCount = 0;
  let startIdx = 0;
  for (let i = local.length - 1; i >= 0; i--) {
    if (local[i].role === "user") userCount++;
    if (userCount >= rounds) {
      startIdx = i;
      break;
    }
  }
  return local
    .slice(startIdx)
    .map((e) => ({ role: e.role, content: cleanMediaLines(String(e.content ?? "")).replace(/\n+/g, " ").trim() }))
    .filter((r) => r.content);
}
