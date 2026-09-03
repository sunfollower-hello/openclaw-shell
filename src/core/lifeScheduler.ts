// AI 生命调度器：让机器人按卡片配置的间隔主动给用户发消息（心跳式主动消息）
// 文件：data/life/<slug>.json，结构：
//   { intervalHours, quietFrom, quietTo, lastBeat, users: { "<openid>": { lastContact, lastBeat } } }
// 触发链路（已验证）：openclaw system event --mode now --session-key <agentId>:<accountId>:<openid>
//   → 唤醒 agent → 模型生成角色化消息 → 经通道发送给该用户。
// 设计要点：
//   - intervalHours=0 关闭；1-24 小时可选（前端滑动杆，步进 1h）
//   - 静默时段默认 0:00-6:00（不打扰休息）；用户要求不加 activeHours 上限，只限制深夜
//   - 时间情绪注入：不同时段（清晨/上午/午后/傍晚/深夜）给不同的情绪基调，让消息自然
//   - 防骚扰：用户长时间不回复 → 拉长间隔（missedBeats 递增）；超阈值（24h 无互动）停发
//   - 每用户独立 lastBeat，避免群发轰炸
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";
import type { PersonaCard } from "./schema.js";

export interface LifeUserState {
  lastContact: string; // 用户最后一次主动联系（ISO）
  lastBeat: string; // 该用户上次收到主动消息（ISO）
  missedBeats: number; // 连续未回复的主动消息次数
}

export interface LifeState {
  intervalHours: number;
  quietFrom: number;
  quietTo: number;
  lastBeat: string; // 全局上次心跳（用于冷却）
  users: Record<string, LifeUserState>;
}

export const DEFAULT_QUIET_FROM = 0;
export const DEFAULT_QUIET_TO = 6;
/** 用户连续 N 次没回主动消息 → 停发（避免打扰） */
export const MAX_MISSED_BEATS = 3;
/** 用户超过 N 小时没互动 → 不主动发（冷场太久，发也没意义） */
export const MAX_IDLE_HOURS = 48;
/** 全局两次心跳最小间隔（分钟），防止误配置导致轰炸 */
export const MIN_GLOBAL_COOLDOWN_MIN = 30;

function lifePath(slug: string): string {
  return path.join(dataDir(), "life", `${slug}.json`);
}

export async function loadLife(slug: string): Promise<LifeState> {
  try {
    const raw = JSON.parse(await fs.readFile(lifePath(slug), "utf8"));
    return {
      intervalHours: Number(raw?.intervalHours ?? 0),
      quietFrom: Number(raw?.quietFrom ?? DEFAULT_QUIET_FROM),
      quietTo: Number(raw?.quietTo ?? DEFAULT_QUIET_TO),
      lastBeat: String(raw?.lastBeat ?? ""),
      users: raw?.users && typeof raw.users === "object" ? raw.users : {},
    };
  } catch {
    return { intervalHours: 0, quietFrom: DEFAULT_QUIET_FROM, quietTo: DEFAULT_QUIET_TO, lastBeat: "", users: {} };
  }
}

async function saveLife(slug: string, state: LifeState): Promise<void> {
  const file = lifePath(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

/** 应用卡片配置到调度状态（高级配置保存时调用）；intervalHours=0 清空 lastBeat 冷却 */
export async function applyLifeConfig(slug: string, cfg: { intervalHours?: number; quietFrom?: number; quietTo?: number }): Promise<void> {
  const state = await loadLife(slug);
  if (typeof cfg.intervalHours === "number") state.intervalHours = Math.max(0, Math.min(24, Math.round(cfg.intervalHours)));
  if (typeof cfg.quietFrom === "number") state.quietFrom = Math.max(0, Math.min(23, Math.round(cfg.quietFrom)));
  if (typeof cfg.quietTo === "number") state.quietTo = Math.max(0, Math.min(24, Math.round(cfg.quietTo)));
  if (state.intervalHours === 0) {
    state.lastBeat = "";
    state.users = {};
  }
  await saveLife(slug, state);
}

/** 记录用户主动联系（/api/chat 或通道入站时调用）——重置该用户的 missedBeats */
export async function recordUserContact(slug: string, openid: string): Promise<void> {
  if (!openid) return;
  const state = await loadLife(slug);
  const u = state.users[openid] ?? { lastContact: "", lastBeat: "", missedBeats: 0 };
  u.lastContact = new Date().toISOString();
  u.missedBeats = 0;
  state.users[openid] = u;
  await saveLife(slug, state);
}

/** 是否处于静默时段（默认 0-6 点） */
export function isQuietHour(now: Date, from: number, to: number): boolean {
  const h = now.getHours();
  if (from === to) return false; // 相等 = 无静默
  if (from < to) return h >= from && h < to;
  return h >= from || h < to; // 跨天（如 22-6）
}

/**
 * 按当前时间生成"情绪基调"注入文本（不同时段不同情绪，让主动消息自然）
 */
export function buildMoodPrompt(now: Date): string {
  const h = now.getHours();
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const hh = String(h).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  let mood: string;
  if (h >= 6 && h < 9) {
    mood = "现在是清晨，语气带着刚醒的慵懒与元气，像刚起床想到对方，发一句自然的早安或惦记。";
  } else if (h >= 9 && h < 12) {
    mood = "现在是上午，语气清醒、轻快，像工作间隙想起对方，聊点日常或关心。";
  } else if (h >= 12 && h < 14) {
    mood = "现在是中午，语气轻松，像饭点随口问候，可以问对方吃了没、休息得好不好。";
  } else if (h >= 14 && h < 18) {
    mood = "现在是下午，语气从容、温和，像午后闲下来想找人说话。";
  } else if (h >= 18 && h < 22) {
    mood = "现在是傍晚到晚上，语气放松、亲密，像一天结束想跟对方分享或陪伴。";
  } else if (h >= 22 || h < 1) {
    mood = "现在是深夜，语气温柔、安静、略带困意，像睡前轻轻道一声晚安或惦记。";
  } else {
    mood = "现在是凌晨，语气极轻极柔，像舍不得睡、悄悄发一句。";
  }
  return `当前时间：${weekday} ${hh}:${mm}。${mood}（主动消息：自然地以角色身份发起话题，像真人想到对方一样，不要提"心跳""主动消息""系统"等词）`;
}

/** 该用户现在是否应该收到主动消息（间隔 + 静默 + 冷却 + 防骚扰综合判断） */
export function shouldBeat(
  state: LifeState,
  openid: string,
  now: Date
): { due: boolean; reason: string } {
  if (state.intervalHours <= 0) return { due: false, reason: "关闭" };
  if (isQuietHour(now, state.quietFrom, state.quietTo)) return { due: false, reason: "静默时段" };
  const u = state.users[openid];
  if (!u) return { due: false, reason: "无用户记录" };
  // 用户最近互动超过 48h → 停发
  if (u.lastContact) {
    const idleH = (now.getTime() - new Date(u.lastContact).getTime()) / 3600000;
    if (idleH > MAX_IDLE_HOURS) return { due: false, reason: "久未互动" };
  }
  // 连续未回 N 次 → 停发
  if (u.missedBeats >= MAX_MISSED_BEATS) return { due: false, reason: "连续未回" };
  // 该用户上次主动消息距今
  if (u.lastBeat) {
    const sinceBeatH = (now.getTime() - new Date(u.lastBeat).getTime()) / 3600000;
    if (sinceBeatH < state.intervalHours) return { due: false, reason: "用户冷却中" };
  }
  // 全局冷却
  if (state.lastBeat) {
    const sinceGlobalMin = (now.getTime() - new Date(state.lastBeat).getTime()) / 60000;
    if (sinceGlobalMin < MIN_GLOBAL_COOLDOWN_MIN) return { due: false, reason: "全局冷却" };
  }
  return { due: true, reason: "ok" };
}

/**
 * 心跳调度（server 每分钟调用一次，遍历所有开了主动消息的卡）：
 * 对每张卡、每个已知用户检查 shouldBeat，due 则触发 system event。
 * 返回触发的（slug, openid）列表，供日志/前端查看。
 */
export async function runLifeTick(
  cards: { slug: string; life?: { intervalHours?: number; quietFrom?: number; quietTo?: number } }[],
  triggerFn: (slug: string, agentId: string, accountId: string, openid: string, moodPrompt: string) => Promise<boolean>,
  knownUsersOf: (slug: string) => Promise<{ openid: string }[]>,
  agentOf: (slug: string) => Promise<{ agentId: string; accountId: string } | null>
): Promise<{ slug: string; openid: string }[]> {
  const now = new Date();
  const fired: { slug: string; openid: string }[] = [];
  for (const card of cards) {
    if (!card.life?.intervalHours || card.life.intervalHours <= 0) continue;
    const state = await loadLife(card.slug);
    if (state.intervalHours <= 0) continue;
    const users = await knownUsersOf(card.slug);
    const agent = await agentOf(card.slug);
    if (!agent) continue;
    for (const u of users) {
      const { due, reason } = shouldBeat(state, u.openid, now);
      if (!due) continue;
      const ok = await triggerFn(card.slug, agent.agentId, agent.accountId, u.openid, buildMoodPrompt(now));
      if (ok) {
        // 更新状态
        const st = await loadLife(card.slug);
        const uu = st.users[u.openid] ?? { lastContact: "", lastBeat: "", missedBeats: 0 };
        // 未回判定：上次主动消息(lastBeat)发出后，用户至今没再联系(lastContact 晚于/等于它)才算一次未回。
        // 首次主动消息(lastBeat 为空)不算未回，给用户正常回复窗口；避免"午休/上班几小时没回"被立即计为骚扰。
        const noReplySinceLastBeat =
          !uu.lastBeat ||
          !uu.lastContact ||
          new Date(uu.lastContact).getTime() <= new Date(uu.lastBeat).getTime();
        if (noReplySinceLastBeat) uu.missedBeats += 1;
        uu.lastBeat = now.toISOString();
        st.users[u.openid] = uu;
        st.lastBeat = now.toISOString();
        await saveLife(card.slug, st);
        fired.push({ slug: card.slug, openid: u.openid });
      }
    }
  }
  return fired;
}

// ---------- 已知用户来源：qqbot 插件 known-users.json / 微信账号索引 ----------
/** 读 qqbot 插件记录的已知用户（openid 列表） */
export async function readQQKnownUsers(): Promise<{ openid: string; lastInteractionAt?: number }[]> {
  try {
    const f = path.join(os.homedir(), ".openclaw", "qqbot", "data", "known-users.json");
    const j = JSON.parse(await fs.readFile(f, "utf8"));
    // 结构可能是数组或 { users: [...] } 或 Map 序列化
    const arr = Array.isArray(j) ? j : Array.isArray(j?.users) ? j.users : Array.isArray(j?.knownUsers) ? j.knownUsers : [];
    return arr
      .filter((x: unknown) => x && typeof x === "object")
      .map((x: Record<string, unknown>) => ({
        openid: String(x.openid ?? x.id ?? x.userId ?? ""),
        lastInteractionAt: typeof x.lastInteractionAt === "number" ? x.lastInteractionAt : undefined,
      }))
      .filter((x: { openid: string }) => x.openid);
  } catch {
    return [];
  }
}

/** 读微信插件账号（多账号现实很少用，保留机制一致） */
export async function readWXKnownUsers(): Promise<{ openid: string }[]> {
  try {
    const f = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts.json");
    const list = JSON.parse(await fs.readFile(f, "utf8"));
    if (!Array.isArray(list)) return [];
    return list.filter((x: unknown) => typeof x === "string" && x).map((id: string) => ({ openid: id }));
  } catch {
    return [];
  }
}
