// 开场白状态仓库：记录「哪些对话方已经开场过」，避免重复发开场白导致冷场/重头再来。
// 文件：data/memory/<slug>.greeted.json，结构 { "greeted": { "<userKey>": "<iso ts>" } }
// userKey 约定：
//   local             —— 本地聊天（网页工作台）
//   qq:<openid>       —— QQ 某个用户（c2c 私聊）；群聊暂以群 id 记，避免群里刷屏
//   wx:<openid>       —— 微信某个用户
// 设计要点：
//   - 换机器人/重新绑定卡片时保留 greeted 状态（用户对这张卡聊过就是聊过，不重头再来）
//   - 手动清空对话（前端「清空当前对话」）时也清空该 userKey 的 greeted，允许重新开场
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

interface GreetedFile {
  greeted: Record<string, string>;
}

function greetedPath(slug: string): string {
  return path.join(dataDir(), "memory", `${slug}.greeted.json`);
}

async function readAll(slug: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(greetedPath(slug), "utf8");
    const j = JSON.parse(raw) as Partial<GreetedFile>;
    return j?.greeted && typeof j.greeted === "object" ? j.greeted : {};
  } catch {
    return {};
  }
}

async function writeAll(slug: string, greeted: Record<string, string>): Promise<void> {
  const file = greetedPath(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ greeted }, null, 2), "utf8");
}

/** 该对话方是否已经开场过 */
export async function hasGreeted(slug: string, userKey: string): Promise<boolean> {
  if (!userKey) return true; // 无身份标识时保守：不重复开场
  const all = await readAll(slug);
  return Object.prototype.hasOwnProperty.call(all, userKey);
}

/**
 * 领取开场白（原子语义：首次返回 first_mes 并标记已开场；已开场过返回 null）。
 * 用于本地聊天：打开卡片时调用一次；也供通道侧首次交互时消费。
 */
export async function claimGreeting(slug: string, userKey: string, firstMes: string): Promise<string | null> {
  const text = String(firstMes ?? "").trim();
  if (!text) return null;
  const all = await readAll(slug);
  if (Object.prototype.hasOwnProperty.call(all, userKey)) return null;
  all[userKey] = new Date().toISOString();
  await writeAll(slug, all);
  return text;
}

/** 手动标记已开场（通道侧确认开场白已推送时调用，防重复） */
export async function markGreeted(slug: string, userKey: string): Promise<void> {
  if (!userKey) return;
  const all = await readAll(slug);
  if (!Object.prototype.hasOwnProperty.call(all, userKey)) {
    all[userKey] = new Date().toISOString();
    await writeAll(slug, all);
  }
}

/** 清除某对话方的开场状态（前端「清空对话」时调用，允许重新开场） */
export async function clearGreeted(slug: string, userKey?: string): Promise<void> {
  if (userKey) {
    const all = await readAll(slug);
    if (Object.prototype.hasOwnProperty.call(all, userKey)) {
      delete all[userKey];
      await writeAll(slug, all);
    }
    return;
  }
  // 不指定 key：清空整张卡的 greeted（本地「清空当前对话」用 local 键即可，整卡清空留给重置）
  await writeAll(slug, {});
}

/** 查询某对话方是否已开场（只读，不消费） */
export async function isGreeted(slug: string, userKey: string): Promise<boolean> {
  return hasGreeted(slug, userKey);
}
