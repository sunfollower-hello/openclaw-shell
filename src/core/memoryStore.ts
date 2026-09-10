// 长期记忆仓库：JSONL 存储（每行一个 JSON 对象）+ 旧纯文本自动迁移 + 去重 + 容量上限 + 相关召回
// 文件：data/memory/<slug>.mem，每行 { id, fact, keywords, important, ts, src, ns }
// 记忆形态（2026-09-01 改版）：不再分「信息/偏好/关系/事件」分类，每条 = 一段总结性记忆（fact）；
//   - keywords[]  关键词：聊天里出现这些词时该条记忆优先/必注入（关键词识别注入）
//   - important   关键记忆：识别到「总是/以后都/永远/记住/无论如何」等绝对化词时标记，始终优先注入
// 记忆归属（2026-09-04 简化）：整卡记忆对所有入口（网页/QQ/微信）通用，ns 一律为 shared——
//   本产品定位「一张卡 = 一个用户自己的 AI」，网页与通道都是同一个人，无需按用户隔离。
//   保留 ns 字段仅为兼容旧数据（历史 qq:/wx:/local 标签统一视为 shared）。
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./cardStore.js";

export type MemorySource = "manual" | "auto" | "tool" | "legacy";

export interface MemEntry {
  id: string;
  fact: string; // 单条总结性记忆（不再有分类）
  keywords: string[]; // 关键词（关键词识别注入用）
  important: boolean; // 关键记忆标记（"总是/以后都/永远"等绝对化词）
  ts: string; // ISO 时间戳
  src: MemorySource;
  /** 记忆作用域：统一为 shared（整卡通用）。保留字段仅为兼容旧数据，读入时强制 shared。 */
  ns: string;
  /**
   * 溯源指纹：这条记忆是从哪几轮对话总结出来的（每轮一个 roundKey）。
   * 用途：用户删聊天记录时，凡「总结自被删轮次」的记忆一并删除——
   * 记忆不该替被删内容留底，删了就按剩余原文重新总结。旧数据无此字段，视为不可溯源（不动）。
   */
  roundKeys?: string[];
}

/** 轮次指纹：与 repairChatlogAfterDelete 的内容匹配口径一致（各取前 500 字） */
export function roundKeyOf(round: { u?: string; a?: string }): string {
  const u = String(round.u ?? "").slice(0, 500);
  const a = String(round.a ?? "").slice(0, 500);
  return crypto.createHash("sha1").update(u + "\u0000" + a).digest("hex").slice(0, 16);
}

export function memoryFile(slug: string): string {
  return path.join(dataDir(), "memory", `${slug}.mem`);
}

function newId(): string {
  return Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
}

/** 规范化：去空白、去中英文标点，用于去重比较 */
export function normalizeFact(fact: string): string {
  return fact
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？；：、,.!?;:"'“”‘’（）()\[\]【】《》<>\-—_~·]/g, "")
    .toLowerCase();
}

/** 抽取检索用 token：CJK 二元组 + 连续拉丁词（数字/英文），用于召回打分与相似度 */
function tokens(fact: string): Set<string> {
  const s = new Set<string>();
  const normalized = normalizeFact(fact);
  for (let i = 0; i + 1 < normalized.length; i++) {
    const pair = normalized.slice(i, i + 2);
    if (/[a-z0-9\u4e00-\u9fa5]/.test(pair[0]) && /[a-z0-9\u4e00-\u9fa5]/.test(pair[1])) s.add(pair);
  }
  for (const m of normalized.match(/[a-z0-9]{2,}/g) ?? []) s.add(m);
  return s;
}

/** 相似度：Jaccard（公共 token / 并集），共享 token 太少（<3）不算相似。数字/短句不易误判 */
function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (inter < 3) return 0;
  return inter / (ta.size + tb.size - inter);
}

/** 相关度打分：关键词重合（主要）+ 新鲜度（次要）+ 关键记忆加权 + 关键词命中加权。
 *  query 为空时按新鲜度排序；关键记忆（important）恒优先，keywords 命中当前消息的强相关。 */
export function scoreEntry(entry: MemEntry, query: string): number {
  const q = tokens(query);
  let overlap = 0;
  if (q.size) {
    const ft = tokens(entry.fact);
    for (const t of q) if (ft.has(t)) overlap++;
    overlap = overlap / Math.max(1, Math.sqrt(q.size));
  }
  const ageDays = Math.max(0, (Date.now() - new Date(entry.ts).getTime()) / 86400000);
  const freshness = 1 / (1 + ageDays / 30);
  // 关键记忆恒优先（打分封底，避免被大量普通记忆挤出）
  const importantBoost = entry.important ? 5 : 0;
  // 关键词命中：当前消息出现记忆关键词 → 强相关（关键词识别注入）
  let kwBoost = 0;
  if (q.size && entry.keywords.length) {
    const normQ = normalizeFact(query);
    for (const k of entry.keywords) {
      if (k && normQ.includes(normalizeFact(k))) kwBoost += 6;
    }
  }
  return overlap * 3 + freshness + importantBoost + kwBoost;
}

function parseLine(line: string): MemEntry | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as Partial<MemEntry>;
    if (typeof o.fact !== "string" || !o.fact.trim()) return null;
    return {
      id: typeof o.id === "string" && o.id ? o.id : newId(),
      fact: o.fact.trim(),
      keywords: Array.isArray(o.keywords)
        ? o.keywords.map((k) => String(k).trim()).filter(Boolean)
        : [],
      important: o.important === true,
      ts: typeof o.ts === "string" ? o.ts : new Date().toISOString(),
      src: (["manual", "auto", "tool", "legacy"] as const).includes(o.src as MemorySource)
        ? (o.src as MemorySource)
        : "auto",
      ns: "shared", // 旧数据里的 qq:/wx:/local 标签一律并入 shared（整卡通用）
      ...(Array.isArray(o.roundKeys) && o.roundKeys.length
        ? { roundKeys: o.roundKeys.map((k) => String(k)).filter(Boolean) }
        : {}),
    };
  } catch {
    return null;
  }
}

function isJsonlLine(line: string): boolean {
  return /^\s*\{/.test(line.trim());
}

/** 读取记忆；若文件是旧纯文本格式（首行非 JSON）则自动迁移为 JSONL 并写回 */
export async function readEntries(slug: string): Promise<MemEntry[]> {
  const file = memoryFile(slug);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/);
  const first = lines.find((l) => l.trim());
  if (first && !isJsonlLine(first)) {
    const mtime = await fs.stat(file).then((s) => s.mtime.toISOString()).catch(() => new Date().toISOString());
    const migrated: MemEntry[] = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((fact) => ({ id: newId(), fact, keywords: [], important: false, ts: mtime, src: "legacy" as MemorySource, ns: "shared" }));
    const entries = migrated;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return entries;
  }
  const entries: MemEntry[] = [];
  for (const l of lines) {
    const e = parseLine(l);
    if (e) entries.push(e);
  }
  return entries;
}

// ---------- 写锁：同文件串行化读改写，避免并发丢数据 ----------
const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(slug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(slug, next.catch(() => {}));
  return next;
}

async function writeEntries(slug: string, entries: MemEntry[]): Promise<void> {
  const file = memoryFile(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

export interface AppendResult {
  ok: boolean;
  duplicate?: boolean;
  entry?: MemEntry;
}

/** 追加一条记忆：自动去重（精确 + 相似）。重复时返回 duplicate。
 *  keywords：关键词（聊天出现这些词时优先注入）；important：关键记忆（始终优先注入）。
 *  记忆对整张卡所有入口通用，ns 恒为 shared（保留入参仅为兼容旧调用，不再产生隔离）。 */
export function appendEntry(
  slug: string,
  input: { fact: string; keywords?: string[]; important?: boolean; src?: MemorySource; ns?: string; roundKeys?: string[] }
): Promise<AppendResult> {
  return withLock(slug, async () => {
    const fact = String(input.fact ?? "").trim();
    if (!fact) return { ok: false };
    const src: MemorySource = ["manual", "auto", "tool"].includes(String(input.src ?? ""))
      ? (input.src as MemorySource)
      : "auto";
    const keywords = Array.isArray(input.keywords) ? input.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
    const important = input.important === true;
    const entries = await readEntries(slug);
    for (const e of entries) {
      if (normalizeFact(e.fact) === normalizeFact(fact) || similarity(e.fact, fact) > 0.8) {
        return { ok: false, duplicate: true };
      }
    }
    const roundKeys = Array.isArray(input.roundKeys) ? input.roundKeys.map(String).filter(Boolean) : [];
    const entry: MemEntry = {
      id: newId(), fact, keywords, important, ts: new Date().toISOString(), src, ns: "shared",
      ...(roundKeys.length ? { roundKeys } : {}),
    };
    await writeEntries(slug, [...entries, entry]);
    return { ok: true, entry };
  });
}

/** 删除单条记忆 */
export function deleteEntry(slug: string, id: string): Promise<boolean> {
  return withLock(slug, async () => {
    const entries = await readEntries(slug);
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    await writeEntries(slug, next);
    return true;
  });
}

/** 编辑单条记忆（fact / keywords / important） */
export function updateEntry(
  slug: string,
  id: string,
  patch: { fact?: string; keywords?: string[]; important?: boolean }
): Promise<MemEntry | null> {
  return withLock(slug, async () => {
    const entries = await readEntries(slug);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const e = entries[idx];
    if (typeof patch.fact === "string" && patch.fact.trim()) e.fact = patch.fact.trim();
    if (Array.isArray(patch.keywords)) {
      e.keywords = patch.keywords.map((k) => String(k).trim()).filter(Boolean);
    }
    if (typeof patch.important === "boolean") e.important = patch.important;
    await writeEntries(slug, entries);
    return e;
  });
}

/** 清空某卡记忆文件（含旧计数器、导出 md 与全部对话日志，含按用户拆分的） */
export async function clearMemory(slug: string): Promise<void> {
  await fs.rm(memoryFile(slug), { force: true }).catch(() => {});
  await fs.rm(memoryFile(slug) + ".count", { force: true }).catch(() => {});
  await fs.rm(path.join(memoryExportDir(), `${slug}.md`), { force: true }).catch(() => {});
  // 对话日志：老格式 <slug>.chatlog.jsonl + 按用户拆分的 <slug>.<ns>.chatlog.jsonl 全清
  const dir = path.join(dataDir(), "memory");
  const prefix = `${slug}.`;
  for (const f of await fs.readdir(dir).catch(() => [])) {
    if (f.startsWith(prefix) && f.endsWith(".chatlog.jsonl")) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    }
  }
}

// ---------- 每卡对话日志（自动总结用：只保留「未总结」的轮次，总结过即删除） ----------
export interface ChatRound {
  u: string; // 用户消息（截断）
  a: string; // 角色回复（截断）
  t: string; // 时间戳
  r?: number; // 巡回标记：1 = 上次总结失败待补记（下次总结时与新段一起重试）
}

/** 对话日志文件：统一为每卡单文件 <slug>.chatlog.jsonl（ns 参数保留仅为兼容旧调用，不再按用户拆分） */
export function chatLogFile(slug: string, _ns?: string): string {
  return path.join(dataDir(), "memory", `${slug}.chatlog.jsonl`);
}

/** 读取未总结的对话轮次（不加重写锁，仅供内部/调试读取） */
export async function readChatLog(slug: string, _ns?: string): Promise<ChatRound[]> {
  const raw = await fs.readFile(chatLogFile(slug), "utf8").catch(() => "");
  const out: ChatRound[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<ChatRound>;
      out.push({
        u: String(o.u ?? ""),
        a: String(o.a ?? ""),
        t: String(o.t ?? ""),
        ...(o.r === 1 ? { r: 1 } : {}),
      });
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out;
}

/**
 * 追加一轮对话到日志，并按「N 轮一批」规则处理（含最新轮，无保护门槛）：
 * 新轮次攒够 batch 轮就把「失败巡回段 + 最早 batch 轮新段」取出返回（已从日志删除），
 * 之前总结失败被标记的轮次（r=1）会搭车下一次总结一起补记（记忆巡回）。
 * 最近 20 轮的原文仍由聊天历史窗口完整注入，不被记忆替代——总结只影响记忆产物。
 * 返回需要总结的段（数组为空 = 未到阈值）。整段操作在写锁内原子完成。
 * 网页与通道（QQ/微信）的对话进同一份日志、同一份记忆（整卡通用）。
 */
export async function pushChatRound(slug: string, round: ChatRound, batch: number, _ns?: string): Promise<ChatRound[]> {
  const b = Math.max(1, Math.min(50, batch || 5));
  return withLock(slug, async () => {
    const file = chatLogFile(slug);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(round) + "\n", "utf8");
    const lines = await readChatLog(slug);
    const flagged = lines.filter((l) => l.r === 1); // 上次失败的巡回段
    const fresh = lines.filter((l) => l.r !== 1);
    if (fresh.length < b) return [];
    const segment = [...flagged, ...fresh.slice(0, b)];
    const rest = lines.filter((l) => !segment.includes(l));
    const text = rest.map((r) => JSON.stringify(r)).join("\n");
    await fs.writeFile(file, text + (text ? "\n" : ""), "utf8");
    return segment;
  });
}

/**
 * 记忆巡回：总结失败时把该段标记回日志头部（r=1），下次总结自动搭车重试。
 * 在写锁内原子完成，避免与并发追加互相覆盖。
 */
export async function markChatRetry(slug: string, segment: ChatRound[], _ns?: string): Promise<void> {
  if (!segment.length) return;
  await withLock(slug, async () => {
    const lines = await readChatLog(slug);
    const marked = segment.map((r) => ({ ...r, r: 1 }));
    const text = [...marked, ...lines].map((r) => JSON.stringify(r)).join("\n");
    await fs.writeFile(chatLogFile(slug), text + "\n", "utf8");
  });
}

/**
 * 消息删除后的日志修复：从对话日志里移除与被删消息同内容的轮次
 * （被删的未总结消息不再参与总结）。返回移除的轮数。
 */
export async function repairChatlogAfterDelete(
  slug: string,
  removed: { role: string; content: string }[]
): Promise<number> {
  if (!removed.length) return 0;
  const delSet = new Set(removed.map((r) => (r.role === "user" ? "u:" : "a:") + String(r.content).slice(0, 500)));
  return withLock(slug, async () => {
    const lines = await readChatLog(slug);
    const kept = lines.filter((r) => !delSet.has("u:" + r.u) && !delSet.has("a:" + r.a));
    const removedRounds = lines.length - kept.length;
    if (removedRounds > 0) {
      const text = kept.map((r) => JSON.stringify(r)).join("\n");
      await fs.writeFile(chatLogFile(slug), text + (text ? "\n" : ""), "utf8");
    }
    return removedRounds;
  });
}

/**
 * 按被删轮次清理记忆：凡「总结自这些轮次」的记忆一律删除。
 * 用户诉求：记忆不能替被删的聊天内容留底——删了聊天记录，由它总结出的记忆也必须消失，
 * 之后按剩余原文重新注入/重算。只对带 roundKeys 的记忆生效（旧数据无溯源信息，交给调用方兜底）。
 * 返回被删掉的记忆条数。
 */
export function deleteMemoriesByRounds(slug: string, rounds: { u?: string; a?: string }[]): Promise<number> {
  if (!rounds.length) return Promise.resolve(0);
  const killSet = new Set(rounds.map(roundKeyOf));
  return withLock(slug, async () => {
    const entries = await readEntries(slug);
    const kept = entries.filter((e) => !(e.roundKeys ?? []).some((k) => killSet.has(k)));
    const gone = entries.length - kept.length;
    if (gone > 0) await writeEntries(slug, kept);
    return gone;
  });
}

/**
 * 记忆解散：删掉最新一条记忆（消息删除破坏了它时用），
 * 其内容会在后续总结周期里随剩余对话自然重算。
 */
export function dissolveNewestMemory(slug: string): Promise<MemEntry | null> {
  return withLock(slug, async () => {
    const entries = await readEntries(slug);
    if (!entries.length) return null;
    const newest = entries.reduce((a, b) => (a.ts >= b.ts ? a : b));
    await writeEntries(slug, entries.filter((e) => e.id !== newest.id));
    return newest;
  });
}

/**
 * 相关召回：按关键词重合 + 新鲜度打分取前 limit 条；query 为空时返回最新 limit 条。
 * 整卡记忆通用（ns 参数保留仅为兼容旧调用，不过滤）。
 */
export async function recall(slug: string, query: string, limit = 30, _ns?: string): Promise<MemEntry[]> {
  const entries = await readEntries(slug);
  const scored = entries
    .map((e) => ({ e, s: scoreEntry(e, query ?? "") }))
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, Math.max(1, limit)).map((x) => x.e);
}

/** 读取 memory 目录下全部卡的记忆（用于 API/备份展示），slug 不含 .mem 后缀 */
export async function readAllMemories(): Promise<Record<string, MemEntry[]>> {
  const dir = path.join(dataDir(), "memory");
  const out: Record<string, MemEntry[]> = {};
  for (const f of await fs.readdir(dir).catch(() => [])) {
    if (!f.endsWith(".mem")) continue;
    const slug = f.replace(/\.mem$/, "");
    out[slug] = await readEntries(slug).catch(() => []);
  }
  return out;
}

// ---------- 导出为 Markdown（供 OpenClaw memorySearch.extraPaths 索引，QQ/微信可搜到这些事实） ----------
export function memoryExportDir(): string {
  return path.join(dataDir(), "memory-export");
}

/** 导出某卡记忆为 <slug>.md：关键记忆（important）置顶、再普通记忆；带记录时间；
 *  供 OpenClaw memorySearch.extraPaths 索引，QQ/微信可搜到这些事实（整卡通用）。 */
export async function exportMemoryToMarkdown(slug: string): Promise<void> {
  const entries = await readEntries(slug).catch(() => []);
  const dir = memoryExportDir();
  await fs.mkdir(dir, { recursive: true });
  if (!entries.length) {
    await fs.rm(path.join(dir, `${slug}.md`), { force: true }).catch(() => {});
    return;
  }
  const lines: string[] = [
    `# 用户长期记忆（${slug}）`,
    "",
    "> 由 openclaw-shell 自动同步自聊天记忆。**关键记忆**（用户明确表达「总是/以后都/永远/记住」等长期约定）必须严格遵守，优先于普通记忆；仅在话题相关时引用普通记忆。",
    "",
  ];
  const important = entries.filter((e) => e.important).sort((a, b) => a.ts.localeCompare(b.ts));
  const normal = entries.filter((e) => !e.important).sort((a, b) => a.ts.localeCompare(b.ts));
  if (important.length) {
    lines.push("### 关键记忆（必须遵守）", "");
    for (const e of important) {
      const when = e.ts ? `（${e.ts.slice(0, 10)}）` : "";
      const kw = e.keywords?.length ? ` ［关键词：${e.keywords.join("、")}］` : "";
      lines.push(`- ${e.fact}${kw}${when}`);
    }
    lines.push("");
  }
  if (normal.length) {
    lines.push("### 普通记忆", "");
    for (const e of normal) {
      const when = e.ts ? `（${e.ts.slice(0, 10)}）` : "";
      const kw = e.keywords?.length ? ` ［关键词：${e.keywords.join("、")}］` : "";
      lines.push(`- ${e.fact}${kw}${when}`);
    }
    lines.push("");
  }
  await fs.writeFile(path.join(dir, `${slug}.md`), lines.join("\n"), "utf8");
}

/** 导出全部卡的记忆；同时清理已无 .mem 文件的残留导出 */
export async function exportAllMemoriesToMarkdown(): Promise<string[]> {
  const all = await readAllMemories();
  const exported: string[] = [];
  for (const slug of Object.keys(all)) {
    await exportMemoryToMarkdown(slug);
    exported.push(slug);
  }
  const dir = memoryExportDir();
  for (const f of await fs.readdir(dir).catch(() => [])) {
    if (f.endsWith(".md") && !all[f.replace(/\.md$/, "")]) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    }
  }
  return exported;
}
