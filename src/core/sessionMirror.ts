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
  id: string; // 会话消息 id（导入去重用）
  role: "user" | "assistant";
  content: string;
  /** 消息时间（epoch ms）。游标靠它定位，不用消息 id —— 会话被重置后 id 会整段换新，
   *  按 id 找位置会把重置前那一段静默漏掉（见文件尾部 pollSessionTurns 注释）。 */
  ts: number;
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

/**
 * 某会话的全部文件：当前文件 + 它的 reset 归档。
 * OpenClaw 重置会话时不是删除，而是把老文件改名成 `<sessionId>.jsonl.reset.<时间戳>`
 * （服务器上实测存在：`266ab1c8-....jsonl.reset.2026-09-08T07-34-18.115Z`）——重置前那一段
 * 消息还在归档里。只读当前文件的话，App 关着期间恰好赶上会话重置，那一段就永远补不回来了。
 */
async function sessionFilesOf(agentId: string, sessionId: string): Promise<{ file: string; mtime: number }[]> {
  const dir = sessionsDir(agentId);
  const base = `${sessionId}.jsonl`;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: { file: string; mtime: number }[] = [];
  for (const n of names) {
    if (n !== base && !n.startsWith(`${base}.reset`)) continue;
    const file = path.join(dir, n);
    const st = await fs.stat(file).catch(() => null);
    if (st) out.push({ file, mtime: st.mtimeMs });
  }
  // 索引里有 sessionId 但文件还没落盘（或被手工删了）：仍按常规名字试读一次，读到空即返回空
  if (!out.length) out.push({ file: path.join(dir, base), mtime: 0 });
  return out;
}

/** 读某会话的消息轮次（user/assistant 文本，按时间序；跳过工具/系统消息）。
 *  sinceTs > 0 时跳过「最后写入时间都在水位之前」的归档文件，避免每次轮询都重读旧归档。 */
export async function readSessionTurns(
  agentId: string,
  sessionId: string,
  opts: { sinceTs?: number } = {}
): Promise<MirrorTurn[]> {
  const turns: MirrorTurn[] = [];
  let lastTs = 0; // 同一文件内时间单调：个别行没写 timestamp 就沿用上一行，保证排序与水位可比
  for (const f of await sessionFilesOf(agentId, sessionId)) {
    if (opts.sinceTs && f.mtime && f.mtime + 60_000 < opts.sinceTs) continue;
    const raw = await fs.readFile(f.file, "utf8").catch(() => "");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('"type":"message"')) continue;
      try {
        const o = JSON.parse(line) as {
          id?: string;
          timestamp?: string;
          message?: { role?: string; content?: unknown; timestamp?: number };
        };
        const role = o.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = contentText(o.message?.content).trim();
        if (!text) continue;
        const ts = Date.parse(String(o.timestamp ?? "")) || Number(o.message?.timestamp ?? 0) || lastTs;
        lastTs = ts;
        turns.push({
          // 没有 id 的行也要有稳定标识，否则每次轮询都会被当成新消息重复导入
          id: String(o.id ?? "") || `t${ts}-${role}-${text.length}`,
          role,
          content: text,
          ts,
        });
      } catch {
        /* 跳过损坏行 */
      }
    }
  }
  return turns;
}

/** 合并多个会话（当前会话 + 它重置前的老会话）的轮次，按时间升序、按消息 id 去重 */
export async function readSessionsTurnsMerged(
  agentId: string,
  sessionIds: string[],
  sinceTs = 0
): Promise<MirrorTurn[]> {
  const seen = new Set<string>();
  const out: MirrorTurn[] = [];
  for (const sid of sessionIds) {
    if (!sid) continue;
    for (const t of await readSessionTurns(agentId, sid, { sinceTs })) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ---------- 增量游标：data/memory/<slug>.observe.json = { lastTs, known: [sessionId...] } ----------
interface ObserveCursor {
  /** 已同步到的消息时间水位（epoch ms）。用时间而不是「最后一条消息 id」：会话被重置后
   *  消息 id 整段换新，按 id 找位置会把重置前那一段静默漏掉；时间水位不受重置影响。 */
  lastTs?: number;
  /** 这张卡同步过的会话 id（含已重置的老会话）——老会话的 reset 归档还要继续读 */
  known?: string[];
  /** 老版本游标（sessionId → 最后一条消息 id）；读到它说明 lastTs 缺失，会触发一次全量重扫
   *  （重复的部分由 observeCard 按来源 id 去重丢掉，不会重复入库） */
  sessions?: Record<string, string>;
}

/** 单轮最多补多少条：首次同步或很久没开 App 时一次拉太多会卡住轮询，
 *  剩下的下一轮接着补（水位只推进到「已真正写进日志」的位置）。 */
const MAX_TURNS_PER_POLL = 400;

/**
 * 进程内「上次观察到的会话文件状态」——性能门。
 * 通道大部分时间是空闲的，但扫描器每 5 秒会轮一遍所有设备的所有绑卡；没有这道门时
 * 每个绑卡每轮都要把会话 jsonl 整个解析一遍（实测会话文件可以到几百 KB~1MB）。
 * 有了它，空闲卡每轮只花一次 stat：文件自上次观察之后没被写过、且会话 id 没变 → 必定没有新消息。
 *
 * 用「上次观察时刻 at」而不是「上次 mtime」比较：文件若正好在我们观察的同一毫秒内被追加，
 * mtime 可能不小于 at，此时不跳过（宁可多读一次，不漏消息）。会话 id 变了（会话被重置）
 * 也一定不跳过 —— 老的归档里可能还压着没同步的消息。
 * 键用游标文件路径，天然带设备命名空间，多设备不会互相干扰。
 */
const observedState = new Map<string, { at: number; sessionId: string }>();

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
 * 轮询一次：返回该会话里水位之后的新轮次（首次观察返回全部）。
 * **只读不写游标** —— 游标由 observeCard 在真正写进会话日志之后调 commitObserveCursor 推进。
 * 这样中途失败只会导致下一轮重读（按来源 id 去重），不会静默漏消息。
 */
export async function pollSessionTurns(
  slug: string,
  bot: { agentId: string; accountId: string },
  openid: string,
  prefound?: SessionInfo | null
): Promise<{ sessionId: string; turns: MirrorTurn[]; sessionIds: string[] }> {
  const session = prefound ?? (await findSession(bot.agentId, bot.accountId, openid));
  const cursor = await readCursor(slug);
  const lastTs = Number(cursor.lastTs ?? 0) || 0;
  const current = session?.sessionId ?? "";
  const known = cursor.known ?? [];
  if (current && known.length && !known.includes(current)) {
    // 会话被重置过（旧文件改名成 .reset 归档）——这正是「App 关着期间的消息最容易丢」的时刻，
    // 日志留一条便于排查：会一并扫老会话归档，把重置前没同步的那段补上
    logWarn("sessionMirror", `会话已重置(${slug})：${known[known.length - 1]} → ${current}，连同归档一起补齐`);
  }
  // 当前会话 + 历史会话（重置过的老会话，其 reset 归档里还有没同步过的消息）
  const sessionIds = [...new Set([current, ...known])].filter(Boolean);
  if (!sessionIds.length) return { sessionId: "", turns: [], sessionIds: [] };
  // 便宜门：空闲卡别每 5 秒重解析一遍会话文件（见 observedState 注释）
  const gateKey = cursorFile(slug);
  const prevSeen = observedState.get(gateKey);
  const curStat = current
    ? await fs.stat(path.join(sessionsDir(bot.agentId), `${current}.jsonl`)).catch(() => null)
    : null;
  if (prevSeen && current && prevSeen.sessionId === current && curStat && curStat.mtimeMs < prevSeen.at) {
    return { sessionId: current, turns: [], sessionIds };
  }
  observedState.set(gateKey, { at: Date.now(), sessionId: current });
  const all = await readSessionsTurnsMerged(bot.agentId, sessionIds, lastTs);
  if (!all.length) return { sessionId: current, turns: [], sessionIds };
  // 水位用 >= 而不是 >：同一毫秒的多条消息宁可重复读（导入时按 id 去重），不能漏
  const fresh = (lastTs > 0 ? all.filter((t) => t.ts >= lastTs) : all).slice(0, MAX_TURNS_PER_POLL);
  return { sessionId: current, turns: fresh, sessionIds };
}

/** 推进水位：只按「已经写进会话日志的那些轮次」算，写盘失败就不推进（下一轮重来） */
export async function commitObserveCursor(
  slug: string,
  turns: MirrorTurn[],
  sessionIds: string[] = []
): Promise<void> {
  if (!turns.length && !sessionIds.length) return;
  const cursor = await readCursor(slug);
  const prev = Number(cursor.lastTs ?? 0) || 0;
  const maxTs = turns.reduce((m, t) => Math.max(m, t.ts), 0);
  const lastTs = Math.max(prev, maxTs);
  const known = [...new Set([...(cursor.known ?? []), ...sessionIds.filter(Boolean)])].slice(-8);
  if (lastTs === prev && known.length === (cursor.known ?? []).length) return;
  await writeCursor(slug, { lastTs, known });
}

/** 重置/清空某卡时一并清观察游标 */
export async function clearObserveCursor(slug: string): Promise<void> {
  await fs.rm(cursorFile(slug), { force: true }).catch(() => {});
}
