// 共享表情包库：全局一份，所有角色卡共用（不再按卡分目录）
// 文件：data/emojis/_shared/<id>.<ext>，清单：data/emojis/library.json，分组：data/emojis/groups.json
// v3（2026-08-31）：分组体系（默认分组 + 用户自建分组；表情可复制/移动）；
//   卡片「高级配置」里可多选分组，AI 从所选分组里挑表情。
//   已移除内置 QQ 原生表情（face id）：腾讯官方 API 无 face 消息段，发不出去，留了是虚假功能。
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface EmojiItem {
  id: string;
  name: string; // AI 用 [表情:名字] 引用
  file: string; // 相对 _shared 的文件名
  explanation: string; // 给 AI 看的含义说明
  group: string; // 所属分组 id
  createdAt: string;
}

export interface EmojiGroup {
  id: string;
  name: string;
  builtin: boolean; // 内置分组：默认分组不可删
}

/** 库容量上限：注入 prompt 的是名字+解释，太多会挤占上下文 */
export const MAX_EMOJIS = 300;
export const DEFAULT_GROUP_ID = "default";

const ALLOWED_EXT = ["png", "jpg", "jpeg", "gif", "webp"];

export function emojiDir(): string {
  return path.join(dataDir(), "emojis", "_shared");
}

function libraryPath(): string {
  return path.join(dataDir(), "emojis", "library.json");
}

function groupsPath(): string {
  return path.join(dataDir(), "emojis", "groups.json");
}

/** 表情图片的公网访问前缀（server 把 data/emojis 挂在 /emojis） */
export function emojiUrl(file: string): string {
  return `/emojis/_shared/${file}`;
}

// ---------- 分组 ----------
const BUILTIN_GROUPS: EmojiGroup[] = [{ id: DEFAULT_GROUP_ID, name: "默认", builtin: true }];

export async function listGroups(): Promise<EmojiGroup[]> {
  try {
    const raw = JSON.parse(await fs.readFile(groupsPath(), "utf8"));
    const arr = Array.isArray(raw?.groups) ? raw.groups : [];
    // 补内置分组（缺失时）
    const seen = new Set(arr.map((g: EmojiGroup) => g.id));
    for (const b of BUILTIN_GROUPS) if (!seen.has(b.id)) arr.push({ ...b });
    return arr;
  } catch {
    return BUILTIN_GROUPS.map((g) => ({ ...g }));
  }
}

async function saveGroups(groups: EmojiGroup[]): Promise<void> {
  await fs.mkdir(path.dirname(groupsPath()), { recursive: true });
  await fs.writeFile(groupsPath(), JSON.stringify({ groups }, null, 2), "utf8");
}

export async function addGroup(name: string): Promise<EmojiGroup> {
  const n = String(name ?? "").trim().slice(0, 20);
  if (!n) throw new Error("分组名不能为空");
  const groups = await listGroups();
  if (groups.some((g) => g.name === n)) throw new Error(`分组「${n}」已存在`);
  const g: EmojiGroup = { id: `g${Date.now().toString(36)}`, name: n, builtin: false };
  await saveGroups([...groups, g]);
  return g;
}

export async function renameGroup(id: string, name: string): Promise<EmojiGroup | null> {
  const n = String(name ?? "").trim().slice(0, 20);
  if (!n) throw new Error("分组名不能为空");
  const groups = await listGroups();
  const g = groups.find((x) => x.id === id);
  if (!g) return null;
  if (groups.some((x) => x.id !== id && x.name === n)) throw new Error(`分组「${n}」已存在`);
  g.name = n;
  await saveGroups(groups);
  return g;
}

export async function deleteGroup(id: string): Promise<void> {
  if (id === DEFAULT_GROUP_ID) throw new Error("默认分组不能删除");
  const groups = await listGroups();
  const target = groups.find((x) => x.id === id);
  if (!target) return;
  if (target.builtin) throw new Error("内置分组不能删除");
  // 组内表情移回默认分组
  const emojis = await listEmojis();
  let changed = false;
  for (const e of emojis) {
    if (e.group === id) {
      e.group = DEFAULT_GROUP_ID;
      changed = true;
    }
  }
  if (changed) await saveLibrary(emojis);
  await saveGroups(groups.filter((x) => x.id !== id));
}

// ---------- 表情 ----------
export async function listEmojis(): Promise<EmojiItem[]> {
  try {
    const raw = JSON.parse(await fs.readFile(libraryPath(), "utf8"));
    return Array.isArray(raw?.emojis) ? raw.emojis : [];
  } catch {
    return [];
  }
}

async function saveLibrary(emojis: EmojiItem[]): Promise<void> {
  await fs.mkdir(path.dirname(libraryPath()), { recursive: true });
  await fs.writeFile(libraryPath(), JSON.stringify({ emojis }, null, 2), "utf8");
}

export interface AddEmojiInput {
  name: string;
  explanation?: string;
  imageBase64: string;
  ext?: string;
  group?: string; // 目标分组 id，缺省默认分组
}

export async function addEmoji(input: AddEmojiInput): Promise<EmojiItem> {
  const name = String(input.name ?? "").trim().slice(0, 40);
  if (!name) throw new Error("表情名不能为空");
  if (!input.imageBase64) throw new Error("缺少图片内容");
  const emojis = await listEmojis();
  if (emojis.length >= MAX_EMOJIS) throw new Error(`表情库已满（最多 ${MAX_EMOJIS} 个），先删掉一些再上传`);
  // 名字唯一：AI 靠名字引用，重名会指向不确定的图
  if (emojis.some((e) => e.name === name)) throw new Error(`表情名「${name}」已存在，换个名字`);
  const ext = ALLOWED_EXT.includes(String(input.ext ?? "").toLowerCase()) ? String(input.ext).toLowerCase() : "png";
  const id = `em${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const file = `${id}.${ext}`;
  await fs.mkdir(emojiDir(), { recursive: true });
  await fs.writeFile(path.join(emojiDir(), file), Buffer.from(input.imageBase64, "base64"));
  const item: EmojiItem = {
    id,
    name,
    file,
    explanation: String(input.explanation ?? "").trim().slice(0, 200),
    group: input.group || DEFAULT_GROUP_ID,
    createdAt: new Date().toISOString(),
  };
  await saveLibrary([...emojis, item]);
  return item;
}

export async function updateEmoji(id: string, patch: { name?: string; explanation?: string; group?: string }): Promise<EmojiItem | null> {
  const emojis = await listEmojis();
  const item = emojis.find((e) => e.id === id);
  if (!item) return null;
  if (typeof patch.name === "string" && patch.name.trim()) {
    const name = patch.name.trim().slice(0, 40);
    if (emojis.some((e) => e.id !== id && e.name === name)) throw new Error(`表情名「${name}」已存在`);
    item.name = name;
  }
  if (typeof patch.explanation === "string") item.explanation = patch.explanation.trim().slice(0, 200);
  if (typeof patch.group === "string" && patch.group) item.group = patch.group;
  await saveLibrary(emojis);
  return item;
}

export async function removeEmoji(id: string): Promise<boolean> {
  const emojis = await listEmojis();
  const item = emojis.find((e) => e.id === id);
  if (!item) return false;
  await saveLibrary(emojis.filter((e) => e.id !== id));
  await fs.rm(path.join(emojiDir(), item.file), { force: true }).catch(() => {});
  return true;
}

/** 复制/移动表情到目标分组：copy=true 复制（新文件），false 移动（改 group） */
export async function moveEmojiToGroup(id: string, targetGroup: string, copy: boolean): Promise<EmojiItem | null> {
  const emojis = await listEmojis();
  const item = emojis.find((e) => e.id === id);
  if (!item) return null;
  if (item.group === targetGroup) return item;
  if (copy) {
    // 复制：新 id + 新文件
    const newId = `em${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const newItem: EmojiItem = { ...item, id: newId, group: targetGroup, createdAt: new Date().toISOString() };
    const src = path.join(emojiDir(), item.file);
    const buf = await fs.readFile(src).catch(() => null);
    if (!buf) return null;
    const newFile = `${newId}.${item.file.split(".").pop() ?? "png"}`;
    await fs.mkdir(emojiDir(), { recursive: true });
    await fs.writeFile(path.join(emojiDir(), newFile), buf);
    newItem.file = newFile;
    await saveLibrary([...emojis, newItem]);
    return newItem;
  }
  item.group = targetGroup;
  await saveLibrary(emojis);
  return item;
}

/**
 * 一次性迁移：把旧的「按卡表情」（data/emojis/<slug>/ + card.emojis）并入共享库。
 * 首次访问表情库时调用；重名的加卡名后缀区分。
 */
export async function migrateLegacyEmojis(
  cards: { slug: string; emojis?: { id: string; name: string; file: string; explanation?: string }[] }[]
): Promise<number> {
  const existing = await listEmojis();
  const names = new Set(existing.map((e) => e.name));
  const merged = [...existing];
  let added = 0;
  for (const card of cards) {
    for (const old of card.emojis ?? []) {
      if (merged.length >= MAX_EMOJIS) break;
      const src = path.join(dataDir(), "emojis", card.slug, old.file);
      const buf = await fs.readFile(src).catch(() => null);
      if (!buf) continue;
      let name = old.name;
      if (names.has(name)) name = `${name}-${card.slug}`.slice(0, 40);
      if (names.has(name)) continue;
      const ext = (old.file.split(".").pop() ?? "png").toLowerCase();
      const id = `em${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const file = `${id}.${ALLOWED_EXT.includes(ext) ? ext : "png"}`;
      await fs.mkdir(emojiDir(), { recursive: true });
      await fs.writeFile(path.join(emojiDir(), file), buf);
      merged.push({ id, name, file, explanation: old.explanation ?? "", group: DEFAULT_GROUP_ID, createdAt: new Date().toISOString() });
      names.add(name);
      added++;
    }
  }
  if (added > 0) await saveLibrary(merged);
  return added;
}

/**
 * 生成注入 prompt 的表情清单说明。
 * level 来自卡片 voice.message_style.emoji（关闭/克制/贴近原始）；关闭时返回空串。
 * groupIds 来自卡片 emojiGroups（高级配置里多选的分组）：
 *   - undefined/null = 不限定（兼容旧调用，全量注入）；
 *   - 数组 = 只注入这些分组的表情；空数组 = 不启用表情包，返回空串。
 * mode 决定告诉模型"怎么发表情"：
 * - "inline"（网页聊天）：写 [表情:名字] 标记，前端会替换成图片；
 * - "tool"（QQ/微信）：调 emoji_send 工具，由插件把图片投递到通道。
 *   通道端没有前端做标记替换，若还教它写标记，用户会看到字面的 `[表情:xxx]`。
 */
export async function buildEmojiPrompt(
  level: string,
  mode: "inline" | "tool" = "inline",
  groupIds?: string[] | null
): Promise<string> {
  if (level === "关闭") return "";
  const emojis = await listEmojis();
  if (emojis.length === 0) return "";
  // 卡片选了分组：空数组 = 不启用表情包；undefined/null = 全量（兼容旧调用）
  let picked: EmojiItem[];
  if (Array.isArray(groupIds)) {
    if (groupIds.length === 0) return "";
    picked = emojis.filter((e) => groupIds.includes(e.group));
  } else {
    picked = emojis;
  }
  if (picked.length === 0) return "";
  const usage = level === "贴近原始" ? "尽量在合适位置使用" : level === "克制" ? "偶尔在合适位置使用" : "少量使用";
  const lines = picked.map((e) => `- ${e.name}：${e.explanation || "（无解释）"}`).join("\n");
  const how =
    mode === "tool"
      ? "想发表情时调用 emoji_send 工具（参数 name 填表情名），不要在文字里写 [表情:名字]。"
      : "想发表情时在回复里写 [表情:名字]（会被渲染成图片）。";
  // P4：频率礼仪——单条回复最多 1-2 个表情，禁止刷屏
  const etiquette = "表情是点缀不是主体：单条回复最多用 1-2 个，不要连续堆叠，不要为了用而用。";
  return `\n\n【表情包】你有以下表情包可用，${usage}。${how}名字必须与下面完全一致，不要编造。${etiquette}\n` + lines;
}
