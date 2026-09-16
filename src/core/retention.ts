// 用户数据保留策略：只作用于设备命名空间（data/users/<id>/），15 天滚动删除。
// 规则（2026-09-16 用户拍板）：服务器只帮用户留着最近 15 天的聊天记录（不慎删 App 可凭设备 ID 找回），
// 记忆/总结产物同样只留 15 天；到期从最早的消息开始删。**运营者自己的全局数据不受影响。**
import fs from "node:fs";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { baseDataDir } from "./dataRoot.js";

export const RETENTION_DAYS = Number(process.env.OC_RETENTION_DAYS ?? 15);

interface TrimStat {
  device: string;
  conversationsRemoved: number;
  chatlogRemoved: number;
  memoryRemoved: number;
  imagesRewritten: number;
}

function cutoffMs(days = RETENTION_DAYS): number {
  return Date.now() - days * 24 * 3600 * 1000;
}

/** 取一行的 ISO 时间戳（不同文件用的字段不同：t / ts / createdAt） */
function lineTime(line: string): number {
  try {
    const o = JSON.parse(line) as { t?: string; ts?: string; createdAt?: number };
    if (typeof o.t === "string") return Date.parse(o.t) || 0;
    if (typeof o.ts === "string") return Date.parse(o.ts) || 0;
    if (typeof o.createdAt === "number") return o.createdAt;
  } catch {
    /* 坏行按 0 处理（会被当作过期删掉） */
  }
  return 0;
}

/** 把「已生成图片：<url>」这类行换成只带提示词的括号标记（服务器不留图链） */
const IMG_LINE_RE = /已生成图片：\S+/g;
function rewriteImageLines(text: string, prompts: string[]): { text: string; changed: number } {
  let i = 0;
  let changed = 0;
  const out = text.replace(IMG_LINE_RE, () => {
    const p = prompts[i++] ?? "";
    changed++;
    return p ? `（图片：${p}）` : "（图片）";
  });
  return { text: out, changed };
}

async function trimJsonl(file: string, cutoff: number): Promise<number> {
  const raw = await fsp.readFile(file, "utf8").catch(() => "");
  if (!raw.trim()) return 0;
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const kept = lines.filter((l) => lineTime(l) >= cutoff);
  const removed = lines.length - kept.length;
  if (removed > 0) await fsp.writeFile(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  return removed;
}

/** 记忆文件：按 ts 删过期条目；顺带把图片行改成提示词标记 */
async function trimMemory(file: string): Promise<{ removed: number; rewritten: number }> {
  const raw = await fsp.readFile(file, "utf8").catch(() => "");
  if (!raw.trim()) return { removed: 0, rewritten: 0 };
  const cutoff = cutoffMs();
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const kept: string[] = [];
  let removed = 0;
  let rewritten = 0;
  for (const l of lines) {
    if (lineTime(l) < cutoff) {
      removed++;
      continue;
    }
    let out = l;
    try {
      const o = JSON.parse(l) as { fact?: string; images?: { prompt?: string }[] };
      if (typeof o.fact === "string" && IMG_LINE_RE.test(o.fact)) {
        IMG_LINE_RE.lastIndex = 0;
        const prompts = (o.images ?? []).map((x) => String(x?.prompt ?? ""));
        const r = rewriteImageLines(o.fact, prompts);
        o.fact = r.text;
        out = JSON.stringify(o);
        rewritten += r.changed;
      }
    } catch {
      /* 保持原样 */
    }
    kept.push(out);
  }
  if (removed || rewritten) await fsp.writeFile(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  return { removed, rewritten };
}

/** 会话日志：按 t 删过期；有 images 元数据时把图链行换成提示词标记 */
async function trimConversations(file: string): Promise<{ removed: number; rewritten: number }> {
  const raw = await fsp.readFile(file, "utf8").catch(() => "");
  if (!raw.trim()) return { removed: 0, rewritten: 0 };
  const cutoff = cutoffMs();
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const kept: string[] = [];
  let removed = 0;
  let rewritten = 0;
  for (const l of lines) {
    if (lineTime(l) < cutoff) {
      removed++;
      continue;
    }
    let out = l;
    try {
      const o = JSON.parse(l) as { content?: string; parts?: string[]; images?: { prompt?: string }[] };
      const prompts = (o.images ?? []).map((x) => String(x?.prompt ?? ""));
      if (typeof o.content === "string" && IMG_LINE_RE.test(o.content)) {
        IMG_LINE_RE.lastIndex = 0;
        const r = rewriteImageLines(o.content, prompts);
        o.content = r.text;
        rewritten += r.changed;
      }
      if (Array.isArray(o.parts)) {
        o.parts = o.parts.map((p) => {
          if (!IMG_LINE_RE.test(String(p))) return p;
          IMG_LINE_RE.lastIndex = 0;
          const r = rewriteImageLines(String(p), prompts);
          rewritten += r.changed;
          return r.text;
        });
      }
      out = JSON.stringify(o);
    } catch {
      /* 保持原样 */
    }
    kept.push(out);
  }
  if (removed || rewritten) await fsp.writeFile(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  return { removed, rewritten };
}

/** 已知设备 ID 列表（注册表；只处理这些命名空间，不碰全局数据） */
function deviceIds(): string[] {
  try {
    const raw = fs.readFileSync(path.join(baseDataDir(), "users", "registry.json"), "utf8");
    const j = JSON.parse(raw) as { devices?: { id?: string }[] };
    return (j.devices ?? []).map((d) => String(d.id ?? "")).filter((x) => /^[a-f0-9]{32}$/.test(x));
  } catch {
    return [];
  }
}

/** 对单个设备命名空间执行保留策略；dryRun=true 只统计不写盘 */
export async function runRetentionForDevice(deviceId: string, opts: { days?: number; dryRun?: boolean } = {}): Promise<TrimStat> {
  const days = opts.days ?? RETENTION_DAYS;
  const cutoff = cutoffMs(days);
  const root = path.join(baseDataDir(), "users", deviceId);
  const stat: TrimStat = { device: deviceId, conversationsRemoved: 0, chatlogRemoved: 0, memoryRemoved: 0, imagesRewritten: 0 };
  if (!fs.existsSync(root)) return stat;

  const convDir = path.join(root, "conversations");
  for (const f of await fsp.readdir(convDir).catch(() => [] as string[])) {
    if (!f.endsWith(".jsonl")) continue;
    const file = path.join(convDir, f);
    if (opts.dryRun) {
      const raw = await fsp.readFile(file, "utf8").catch(() => "");
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      stat.conversationsRemoved += lines.filter((l) => lineTime(l) < cutoff).length;
      stat.imagesRewritten += (raw.match(IMG_LINE_RE) ?? []).length;
    } else {
      const r = await trimConversations(file);
      stat.conversationsRemoved += r.removed;
      stat.imagesRewritten += r.rewritten;
    }
  }

  const memDir = path.join(root, "memory");
  for (const f of await fsp.readdir(memDir).catch(() => [] as string[])) {
    const file = path.join(memDir, f);
    if (f.endsWith(".chatlog.jsonl")) {
      if (opts.dryRun) {
        const raw = await fsp.readFile(file, "utf8").catch(() => "");
        stat.chatlogRemoved += raw.split(/\r?\n/).filter((l) => l.trim() && lineTime(l) < cutoff).length;
      } else {
        stat.chatlogRemoved += await trimJsonl(file, cutoff);
      }
    } else if (f.endsWith(".mem")) {
      if (opts.dryRun) {
        const raw = await fsp.readFile(file, "utf8").catch(() => "");
        stat.memoryRemoved += raw.split(/\r?\n/).filter((l) => l.trim() && lineTime(l) < cutoff).length;
      } else {
        const r = await trimMemory(file);
        stat.memoryRemoved += r.removed;
        stat.imagesRewritten += r.rewritten;
      }
    }
  }
  return stat;
}

/** 对所有已注册设备执行保留策略 */
export async function runRetention(opts: { days?: number; dryRun?: boolean } = {}): Promise<TrimStat[]> {
  const out: TrimStat[] = [];
  for (const id of deviceIds()) {
    out.push(await runRetentionForDevice(id, opts));
  }
  return out;
}
