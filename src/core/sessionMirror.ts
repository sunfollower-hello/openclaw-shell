// 通道会话观察器：把 OpenClaw agent 会话（QQ/微信与用户聊的那段）里新产生的对话轮次
// 增量同步给 openclaw-shell —— 用于：① 网页聊天页显示通道消息（互传，聊天记录相同）；
// ② 通道对话喂给 autoMemorize 总结进记忆库（通道记忆网页可见）。
// 数据来源（OpenClaw 本地文件，无需轮询 CLI）：
//   ~/.openclaw/agents/<agentId>/sessions/sessions.json      会话索引（key/sessionId）
//   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl  会话消息（type:"message" 行）
// 会话键约定（与 lifeScheduler 的 system event 一致）：agent:<agentId>:<accountId>:<openid>
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";
import { logWarn } from "./logger.js";

export interface MirrorTurn {
  id: string; // 会话消息 id（游标用）
  role: "user" | "assistant";
  content: string;
}

export interface SessionInfo {
  key: string;
  sessionId: string;
  updatedAt: number; // epoch ms
  kind?: string;
  /** 会话来源（OpenClaw 会话索引里的 origin 字段：accountId/from/label），findSession 用它兜底匹配 */
  origin?: { accountId?: string; from?: string; label?: string };
}

/** 会话键（agent CLI 用）：agent:<agentId>:<accountId>:<openid> */
export function sessionKeyOf(agentId: string, accountId: string, openid: string): string {
  return `agent:${agentId}:${accountId}:${openid}`;
}

function sessionsDir(agentId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
}

/** 读某 agent 的会话索引（文件不存在返回空数组）。
 *  原始 sessions.json 是「会话键 → 对象」的 Map；CLI 输出是 {sessions:[...]} 数组，两种都兼容。 */
export async function listAgentSessions(agentId: string): Promise<SessionInfo[]> {
  const file = path.join(sessionsDir(agentId), "sessions.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return [];
  }
  let items: Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { sessions?: unknown }).sessions)) {
    items = (raw as { sessions: Record<string, unknown>[] }).sessions;
  } else if (raw && typeof raw === "object") {
    // 原始文件形态：{"agent:a:b:c": { sessionId, ... }, ...}
    items = Object.entries(raw as Record<string, unknown>).map(([key, v]) => ({
      key,
      ...(v && typeof v === "object" ? (v as Record<string, unknown>) : {}),
    }));
  } else {
    return [];
  }
  return items
    .map((s) => ({
      key: String(s.key ?? ""),
      sessionId: String(s.sessionId ?? ""),
      updatedAt: Number(s.updatedAt ?? 0),
      kind: typeof s.kind === "string" ? s.kind : undefined,
      origin:
        s.origin && typeof s.origin === "object"
          ? {
              accountId: typeof (s.origin as Record<string, unknown>).accountId === "string" ? String((s.origin as Record<string, unknown>).accountId) : undefined,
              from: typeof (s.origin as Record<string, unknown>).from === "string" ? String((s.origin as Record<string, unknown>).from) : undefined,
              label: typeof (s.origin as Record<string, unknown>).label === "string" ? String((s.origin as Record<string, unknown>).label) : undefined,
            }
          : undefined,
    }))
    .filter((s) => s.sessionId);
}

/** 收集某 agent 会话索引里的最近互动用户（按 origin 的 from/label，过滤账号）。
 *  QQ/微信统一走这里：QQ known-users.json 的 openid 是大写、微信 accounts.json 是账号 id，
 *  都不如会话索引的 origin 可靠。 */
export function isGroupSessionKey(key: string): boolean {
  return /:(group|channel):/i.test(String(key ?? ""));
}

export async function listAgentSessionUsers(
  agentId: string,
  accountId: string
): Promise<{ openid: string; updatedAt: number }[]> {
  const sessions = await listAgentSessions(agentId);
  const out: { openid: string; updatedAt: number }[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    // 群会话不进网页单聊镜像，避免群消息污染本地聊天
    if (isGroupSessionKey(s.key) || s.kind === "group") continue;
    const o = s.origin ?? {};
    if (o.accountId && o.accountId !== accountId) continue;
    const openid = String(o.from ?? o.label ?? "").trim();
    if (!openid || openid === accountId || seen.has(openid)) continue;
    seen.add(openid);
    out.push({ openid, updatedAt: s.updatedAt ?? 0 });
  }
  return out;
}

/** 找与 (agentId, accountId, openid) 对应的会话：先精确匹配键，再按 openid 后缀兜底 */
export async function findSession(agentId: string, accountId: string, openid: string): Promise<SessionInfo | null> {
  const sessions = await listAgentSessions(agentId);
  const exact = sessionKeyOf(agentId, accountId, openid);
  const norm = (s: string) => s.toLowerCase();
  const hit =
    sessions.find((s) => s.key === exact && !isGroupSessionKey(s.key) && s.kind !== "group") ??
    sessions.find((s) => norm(s.key) === norm(exact) && !isGroupSessionKey(s.key) && s.kind !== "group") ??
    sessions.find((s) => (s.key.endsWith(`:${openid}`) || norm(s.key).endsWith(`:${norm(openid)}`)) && !isGroupSessionKey(s.key) && s.kind !== "group") ??
    // 兜底：按会话索引的 origin 匹配（QQ 会话 key 是小写 openid、微信 key 是 agent:<id>:main，
    // 精确/结尾匹配都对不上，origin.from/label 是权威来源）
    sessions.find((s) => {
      if (isGroupSessionKey(s.key) || s.kind === "group") return false;
      const o = s.origin ?? {};
      const oa = o.accountId ?? "";
      const of = String(o.from ?? o.label ?? "");
      return (!oa || oa === accountId) && (of === openid || norm(of) === norm(openid));
    });
  return hit ?? null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === "object" && typeof (p as { type?: string }).type === "string") {
          const c = (p as { text?: unknown }).text;
          if (typeof c === "string") return c;
        }
        if (typeof p === "string") return p;
        return "";
      })
      .join("");
  }
  return "";
}

/** 读某会话的消息轮次（user/assistant 文本，按时间序；跳过工具/系统消息） */
export async function readSessionTurns(agentId: string, sessionId: string): Promise<MirrorTurn[]> {
  const file = path.join(sessionsDir(agentId), `${sessionId}.jsonl`);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const turns: MirrorTurn[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || !line.includes('"type":"message"')) continue;
    try {
      const o = JSON.parse(line) as { id?: string; message?: { role?: string; content?: unknown } };
      const role = o.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = contentText(o.message?.content).trim();
      if (!text) continue;
      turns.push({ id: String(o.id ?? ""), role, content: text });
    } catch {
      /* 跳过损坏行 */
    }
  }
  return turns;
}

// ---------- 增量游标：data/memory/<slug>.observe.json = { "<sessionId>": "<lastMessageId>" } ----------
interface ObserveCursor {
  sessions?: Record<string, string>;
}

function cursorFile(slug: string): string {
  return path.join(dataDir(), "memory", `${slug}.observe.json`);
}

async function readCursor(slug: string): Promise<ObserveCursor> {
  try {
    return JSON.parse(await fs.readFile(cursorFile(slug), "utf8")) as ObserveCursor;
  } catch {
    return {};
  }
}

async function writeCursor(slug: string, c: ObserveCursor): Promise<void> {
  const file = cursorFile(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(c, null, 2), "utf8");
}

/**
 * 轮询一次：返回该会话里从上次游标以来的新轮次（首次观察返回全部）。
 * 游标按 (slug, sessionId) 记忆「最后处理过的消息 id」，即使中间没跑也不会重复处理。
 */
export async function pollSessionTurns(
  slug: string,
  bot: { agentId: string; accountId: string },
  openid: string
): Promise<{ sessionId: string; turns: MirrorTurn[] }> {
  const session = await findSession(bot.agentId, bot.accountId, openid);
  if (!session) return { sessionId: "", turns: [] };
  const all = await readSessionTurns(bot.agentId, session.sessionId);
  if (!all.length) return { sessionId: session.sessionId, turns: [] };
  const cursor = await readCursor(slug);
  const sessions = cursor.sessions ?? {};
  const lastId = sessions[session.sessionId];
  const lastIndex = lastId ? all.findIndex((t) => t.id === lastId) : -1;
  if (lastId && lastIndex < 0) {
    // 游标指向的消息已不在会话文件里（文件被清/重建/截断）——跳过本轮并重置游标，
    // 否则每次轮询都会静默停在新消息之前，通道消息不再同步。
    logWarn("sessionMirror", `游标消息已不存在(${slug}/${session.sessionId})，重置游标后继续`);
    delete sessions[session.sessionId];
    await writeCursor(slug, { sessions });
  }
  const start = lastId ? (lastIndex >= 0 ? lastIndex + 1 : all.length) : 0;
  const fresh = all.slice(start);
  if (!fresh.length) return { sessionId: session.sessionId, turns: [] };
  sessions[session.sessionId] = fresh[fresh.length - 1].id;
  await writeCursor(slug, { sessions });
  return { sessionId: session.sessionId, turns: fresh };
}

/** 重置/清空某卡时一并清观察游标 */
export async function clearObserveCursor(slug: string): Promise<void> {
  await fs.rm(cursorFile(slug), { force: true }).catch(() => {});
}
