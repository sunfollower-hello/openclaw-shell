// 运行日志：内存里留最近若干条供网页直接查看，同时落盘一份（带大小上限，不会无限涨）。
// 目的是出问题能在设置页直接看见，而不用去翻 data/*.log。
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  /** 来源标签，如 聊天 / 通道 / 生图 / 语音 / 记忆 / 卡片 */
  tag: string;
  msg: string;
  /** 补充信息（错误原文、参数等），只在展开时看 */
  detail?: string;
}

/** 内存里保留的条数：够看最近的问题，又不至于吃内存 */
const MAX_ENTRIES = 500;
/** 落盘文件上限，超了就把前一半截掉（避免像 tunnel.err.log 那样无限涨） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const buffer: LogEntry[] = [];
let writeQueue: Promise<void> = Promise.resolve();

function logFile(): string {
  return path.join(dataDir(), "app.log");
}

function line(e: LogEntry): string {
  const base = `${e.ts} [${e.level}] [${e.tag}] ${e.msg}`;
  return e.detail ? `${base} | ${e.detail}` : base;
}

/** 落盘串行化，避免并发写串行；超限时截掉前一半 */
function appendFile(e: LogEntry): void {
  writeQueue = writeQueue
    .then(async () => {
      const f = logFile();
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.appendFile(f, line(e) + "\n", "utf8");
      const st = await fs.stat(f).catch(() => null);
      if (st && st.size > MAX_FILE_BYTES) {
        const text = await fs.readFile(f, "utf8").catch(() => "");
        const lines = text.split("\n");
        await fs.writeFile(f, lines.slice(Math.floor(lines.length / 2)).join("\n"), "utf8");
      }
    })
    .catch(() => {
      /* 写日志失败不能影响主流程 */
    });
}

export function log(level: LogLevel, tag: string, msg: string, detail?: unknown): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    tag,
    msg: String(msg ?? "").slice(0, 500),
    detail: detail === undefined ? undefined : String(detail instanceof Error ? detail.message : detail).slice(0, 1000),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  appendFile(entry);
  // 同时打到控制台，`data/server.log` 里也能看到
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(line(entry));
}

export const logInfo = (tag: string, msg: string, detail?: unknown): void => log("info", tag, msg, detail);
export const logWarn = (tag: string, msg: string, detail?: unknown): void => log("warn", tag, msg, detail);
export const logError = (tag: string, msg: string, detail?: unknown): void => log("error", tag, msg, detail);

export interface LogQuery {
  level?: LogLevel | "all";
  tag?: string;
  keyword?: string;
  limit?: number;
}

/** 查内存里的日志（最新的在前） */
export function queryLogs(q: LogQuery = {}): { entries: LogEntry[]; total: number; tags: string[] } {
  const kw = (q.keyword ?? "").trim().toLowerCase();
  let list = buffer;
  if (q.level && q.level !== "all") list = list.filter((e) => e.level === q.level);
  if (q.tag && q.tag !== "all") list = list.filter((e) => e.tag === q.tag);
  if (kw) list = list.filter((e) => (e.msg + " " + (e.detail ?? "")).toLowerCase().includes(kw));
  const limit = Math.min(500, Math.max(1, q.limit ?? 200));
  return {
    entries: list.slice(-limit).reverse(),
    total: list.length,
    tags: [...new Set(buffer.map((e) => e.tag))].sort(),
  };
}

export function clearLogs(): void {
  buffer.length = 0;
  writeQueue = writeQueue.then(() => fs.rm(logFile(), { force: true })).catch(() => {});
}
