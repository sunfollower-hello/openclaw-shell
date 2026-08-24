// 长期记忆仓库：JSONL 存储（每行一个 JSON 对象）+ 旧纯文本自动迁移 + 去重 + 容量上限 + 相关召回
// 文件：data/memory/<slug>.mem，每行 { id, fact, cat, ts, src }
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./cardStore.js";

export const MEMORY_CATEGORIES = ["信息", "偏好", "关系", "事件", "待定"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemorySource = "manual" | "auto" | "tool" | "legacy";

export interface MemEntry {
  id: string;
  fact: string;
  cat: MemoryCategory;
  ts: string; // ISO 时间戳
  src: MemorySource;
}

/** 每卡记忆条数上限，超出后淘汰最旧的 */
export const MAX_FACTS = 300;

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

/** 相关度打分：关键词重合（主要）+ 新鲜度（次要）。query 为空时按新鲜度排序 */
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
  return overlap * 3 + freshness;
}

function parseLine(line: string): MemEntry | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as Partial<MemEntry>;
    if (typeof o.fact !== "string" || !o.fact.trim()) return null;
    return {
      id: typeof o.id === "string" && o.id ? o.id : newId(),
      fact: o.fact.trim(),
      cat: (MEMORY_CATEGORIES as readonly string[]).includes(String(o.cat ?? ""))
        ? (o.cat as MemoryCategory)
        : "信息",
      ts: typeof o.ts === "string" ? o.ts : new Date().toISOString(),
      src: (["manual", "auto", "tool", "legacy"] as const).includes(o.src as MemorySource)
        ? (o.src as MemorySource)
        : "auto",
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
      .map((fact) => ({ id: newId(), fact, cat: "信息" as MemoryCategory, ts: mtime, src: "legacy" as MemorySource }));
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

/** 追加一条事实：自动去重（精确 + 相似）、容量上限（淘汰最旧）。重复时返回 duplicate */
export function appendEntry(
  slug: string,
  input: { fact: string; cat?: MemoryCategory; src?: MemorySource }
): Promise<AppendResult> {
  return withLock(slug, async () => {
    const fact = String(input.fact ?? "").trim();
    if (!fact) return { ok: false };
    const cat: MemoryCategory = (MEMORY_CATEGORIES as readonly string[]).includes(String(input.cat ?? ""))
      ? (input.cat as MemoryCategory)
      : "信息";
    const src: MemorySource = ["manual", "auto", "tool"].includes(String(input.src ?? ""))
      ? (input.src as MemorySource)
      : "auto";
    const entries = await readEntries(slug);
    for (const e of entries) {
      if (normalizeFact(e.fact) === normalizeFact(fact) || similarity(e.fact, fact) > 0.8) {
        return { ok: false, duplicate: true };
      }
    }
    const entry: MemEntry = { id: newId(), fact, cat, ts: new Date().toISOString(), src };
    const next = [...entries, entry];
    // 超上限：优先淘汰「事件」类中最旧的，仍超则淘汰最旧
    if (next.length > MAX_FACTS) {
      const excess = next.length - MAX_FACTS;
      const evictable = next.filter((e) => e.cat === "事件");
      const victims = new Set<MemEntry>();
      if (evictable.length >= excess) {
        evictable.sort((a, b) => a.ts.localeCompare(b.ts));
        for (const v of evictable.slice(0, excess)) victims.add(v);
      }
      let trimmed = next.filter((e) => !victims.has(e));
      if (trimmed.length > MAX_FACTS) {
        trimmed.sort((a, b) => a.ts.localeCompare(b.ts));
        trimmed = trimmed.slice(trimmed.length - MAX_FACTS);
      }
      await writeEntries(slug, trimmed);
    } else {
      await writeEntries(slug, next);
    }
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

/** 编辑单条记忆（fact / cat） */
export function updateEntry(
  slug: string,
  id: string,
  patch: { fact?: string; cat?: MemoryCategory }
): Promise<MemEntry | null> {
  return withLock(slug, async () => {
    const entries = await readEntries(slug);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const e = entries[idx];
    if (typeof patch.fact === "string" && patch.fact.trim()) e.fact = patch.fact.trim();
    if ((MEMORY_CATEGORIES as readonly string[]).includes(String(patch.cat ?? ""))) e.cat = patch.cat as MemoryCategory;
    await writeEntries(slug, entries);
    return e;
  });
}

/** 清空某卡记忆文件（含旧计数器与导出 md） */
export async function clearMemory(slug: string): Promise<void> {
  await fs.rm(memoryFile(slug), { force: true }).catch(() => {});
  await fs.rm(memoryFile(slug) + ".count", { force: true }).catch(() => {});
  await fs.rm(path.join(memoryExportDir(), `${slug}.md`), { force: true }).catch(() => {});
}

/** 相关召回：按关键词重合 + 新鲜度打分取前 limit 条；query 为空时返回最新 limit 条 */
export async function recall(slug: string, query: string, limit = 30): Promise<MemEntry[]> {
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

/** 把某卡记忆导出为 <slug>.md：按分类分组，带记录时间；供 OpenClaw 索引 */
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
    "> 由 openclaw-shell 自动同步自聊天记忆。仅在话题相关时引用；每条为关于用户的事实。",
    "",
  ];
  for (const cat of MEMORY_CATEGORIES) {
    const group = entries.filter((e) => e.cat === cat);
    if (!group.length) continue;
    lines.push(`## ${cat}`, "");
    for (const e of group) {
      const when = e.ts ? `（${e.ts.slice(0, 10)}）` : "";
      lines.push(`- ${e.fact}${when}`);
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
