// 群聊存档：与网页单聊 / 私聊记忆完全隔离。
// 不做自动总结；检索时先按人名（member_openid）取近 N 轮，再在该人历史里做关键词打分。
// 数据：data/groupchat/<slug>/<gid>.jsonl + data/groupchat/<slug>/_meta.json
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export const GROUP_RECALL_ROUNDS = 6;
export const GROUP_KEEP_ROUNDS_PER_MEMBER = 200;

export interface GroupTurn {
  id: string;
  t: string;
  memberId: string;
  memberName: string;
  user: string;
  assistant: string;
}

export interface GroupMeta {
  gid: string;
  name: string;
  members: Record<string, string>;
  joinedAt?: string;
  lastAt?: string;
}

export interface GroupListItem {
  gid: string;
  name: string;
  turns: number;
  members: number;
  lastAt: string;
}

function groupDir(slug: string): string {
  return path.join(dataDir(), "groupchat", slug);
}

function turnsFile(slug: string, gid: string): string {
  return path.join(groupDir(slug), `${gid}.jsonl`);
}

function metaFile(slug: string): string {
  return path.join(groupDir(slug), "_meta.json");
}

function safeGid(gid: string): string {
  return String(gid ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80).toLowerCase();
}

function shortMember(id: string): string {
  const s = String(id ?? "").replace(/[^A-Za-z0-9]/g, "");
  return `成员_${(s.slice(-4) || "xxxx").toLowerCase()}`;
}

async function readMetaMap(slug: string): Promise<Record<string, GroupMeta>> {
  try {
    const raw = JSON.parse(await fs.readFile(metaFile(slug), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, GroupMeta>) : {};
  } catch {
    return {};
  }
}

async function writeMetaMap(slug: string, map: Record<string, GroupMeta>): Promise<void> {
  await fs.mkdir(groupDir(slug), { recursive: true });
  await fs.writeFile(metaFile(slug), JSON.stringify(map, null, 2), "utf8");
}

export async function ensureGroup(
  slug: string,
  gid: string,
  name?: string
): Promise<GroupMeta> {
  const id = safeGid(gid);
  const map = await readMetaMap(slug);
  const now = new Date().toISOString();
  const cur = map[id] ?? { gid: id, name: "", members: {}, joinedAt: now };
  if (name && name.trim() && (!cur.name || cur.name.startsWith("群_"))) cur.name = name.trim();
  if (!cur.name) cur.name = `群_${id.slice(-6) || "未知"}`;
  map[id] = cur;
  await writeMetaMap(slug, map);
  return cur;
}

export async function renameMember(
  slug: string,
  gid: string,
  memberId: string,
  name: string
): Promise<GroupMeta | null> {
  const id = safeGid(gid);
  const map = await readMetaMap(slug);
  const g = map[id];
  if (!g) return null;
  const nick = String(name ?? "").trim();
  if (!nick) delete g.members[memberId];
  else g.members[memberId] = nick.slice(0, 32);
  map[id] = g;
  await writeMetaMap(slug, map);
  return g;
}

export async function memberLabel(slug: string, gid: string, memberId: string, fallback?: string): Promise<string> {
  const map = await readMetaMap(slug);
  const nick = map[safeGid(gid)]?.members?.[memberId];
  if (nick) return nick;
  const fb = String(fallback ?? "").trim();
  if (fb && fb !== memberId) return fb;
  return shortMember(memberId);
}

async function readTurns(slug: string, gid: string): Promise<GroupTurn[]> {
  const raw = await fs.readFile(turnsFile(slug, safeGid(gid)), "utf8").catch(() => "");
  const out: GroupTurn[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<GroupTurn>;
      if (o && o.user && o.assistant) {
        out.push({
          id: String(o.id ?? ""),
          t: String(o.t ?? ""),
          memberId: String(o.memberId ?? ""),
          memberName: String(o.memberName ?? ""),
          user: String(o.user ?? ""),
          assistant: String(o.assistant ?? ""),
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

async function writeTurns(slug: string, gid: string, turns: GroupTurn[]): Promise<void> {
  await fs.mkdir(groupDir(slug), { recursive: true });
  const text = turns.map((t) => JSON.stringify(t)).join("\n");
  await fs.writeFile(turnsFile(slug, safeGid(gid)), text + (text ? "\n" : ""), "utf8");
}

function trimPerMember(turns: GroupTurn[]): GroupTurn[] {
  const count = new Map<string, number>();
  const keep: GroupTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const id = turns[i].memberId;
    const n = (count.get(id) ?? 0) + 1;
    count.set(id, n);
    if (n <= GROUP_KEEP_ROUNDS_PER_MEMBER) keep.push(turns[i]);
  }
  return keep.reverse();
}

export async function appendGroupTurn(
  slug: string,
  input: { gid: string; groupName?: string; memberId: string; memberName?: string; user: string; assistant: string }
): Promise<GroupTurn> {
  const gid = safeGid(input.gid);
  const meta = await ensureGroup(slug, gid, input.groupName);
  const memberName = meta.members[input.memberId] || String(input.memberName ?? "").trim() || shortMember(input.memberId);
  const turn: GroupTurn = {
    id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    t: new Date().toISOString(),
    memberId: input.memberId,
    memberName,
    user: String(input.user ?? "").trim(),
    assistant: String(input.assistant ?? "").trim(),
  };
  const turns = trimPerMember([...(await readTurns(slug, gid)), turn]);
  await writeTurns(slug, gid, turns);
  const map = await readMetaMap(slug);
  if (map[gid]) {
    map[gid].lastAt = turn.t;
    if (!map[gid].members[input.memberId] && memberName && !memberName.startsWith("成员_")) {
      map[gid].members[input.memberId] = memberName;
    }
    await writeMetaMap(slug, map);
  }
  return turn;
}

export async function listGroupsForCard(slug: string): Promise<GroupListItem[]> {
  const map = await readMetaMap(slug);
  const items: GroupListItem[] = [];
  for (const g of Object.values(map)) {
    const turns = await readTurns(slug, g.gid).catch(() => []);
    items.push({
      gid: g.gid,
      name: g.name || `群_${g.gid.slice(-6)}`,
      turns: turns.length,
      members: Object.keys(g.members ?? {}).length || new Set(turns.map((t) => t.memberId)).size,
      lastAt: g.lastAt || turns.at(-1)?.t || g.joinedAt || "",
    });
  }
  items.sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || ""));
  return items;
}

export async function getGroupDetail(slug: string, gid: string): Promise<{ meta: GroupMeta; members: { id: string; name: string; turns: number }[] } | null> {
  const map = await readMetaMap(slug);
  const meta = map[safeGid(gid)];
  if (!meta) return null;
  const turns = await readTurns(slug, gid);
  const count = new Map<string, number>();
  for (const t of turns) count.set(t.memberId, (count.get(t.memberId) ?? 0) + 1);
  const members = [...count.entries()].map(([id, n]) => ({
    id,
    name: meta.members[id] || shortMember(id),
    turns: n,
  }));
  return { meta, members };
}

export async function deleteGroup(slug: string, gid: string): Promise<boolean> {
  const id = safeGid(gid);
  const map = await readMetaMap(slug);
  if (!map[id]) return false;
  delete map[id];
  await writeMetaMap(slug, map);
  await fs.rm(turnsFile(slug, id), { force: true }).catch(() => {});
  return true;
}

function scoreText(text: string, query: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let n = 0;
  for (const tok of q.split(/[，,、。！？!?\s]+/).filter((s) => s.length >= 2)) {
    if (t.includes(tok)) n += tok.length;
  }
  if (t.includes(q)) n += q.length;
  return n;
}

export async function recallGroupContext(
  slug: string,
  gid: string,
  memberId: string,
  query: string,
  rounds = GROUP_RECALL_ROUNDS
): Promise<string> {
  const turns = await readTurns(slug, gid);
  if (!turns.length) return "";
  // 显示名一律取「当前起的名字」：历史行里的 memberName 是当时的快照，
  // 用户后来在网页上起了名字后，检索注入必须跟着变（否则 AI 还在叫旧短码）
  const nameNow = await memberLabel(slug, gid, memberId);
  const mine = turns.filter((t) => t.memberId === memberId);
  const recent = mine.slice(-rounds);
  const scored = mine
    .map((t, i) => ({ t, i, s: scoreText(`${t.user} ${t.assistant} ${t.memberName}`, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, rounds);
  const picked = new Set<number>();
  const extra: GroupTurn[] = [];
  for (const hit of scored) {
    const from = Math.max(0, hit.i - 1);
    const to = Math.min(mine.length - 1, hit.i + 1);
    for (let i = from; i <= to; i++) {
      if (picked.has(i)) continue;
      picked.add(i);
      extra.push(mine[i]);
    }
  }
  const seen = new Set(recent.map((t) => t.id));
  const merged = [...recent];
  for (const t of extra) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      merged.push(t);
    }
  }
  merged.sort((a, b) => (a.t || "").localeCompare(b.t || ""));
  if (!merged.length) return "";
  const name = nameNow || merged[0].memberName || shortMember(memberId);
  const lines = [`【群里 ${name} 之前与你的对话（共 ${merged.length} 轮，按人检索，不与网页/私聊记忆混用）】`];
  for (const t of merged) {
    lines.push(`${name}：${t.user}`);
    lines.push(`你：${t.assistant}`);
  }
  lines.push("对不同的人保持你们之间应有的相处方式，不要把别人的事说给当前这个人听。");
  return lines.join("\n");
}

export function formatGroupInject(context: string, memberName: string, text: string): string {
  const body = String(text ?? "").trim();
  const who = memberName || "群成员";
  const head = context ? `${context}\n\n` : "";
  return `${head}【当前群成员 ${who} @你】${body}`;
}
