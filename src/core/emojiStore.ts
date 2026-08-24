// 共享表情包库：全局一份，所有角色卡共用（不再按卡分目录）
// 文件：data/emojis/_shared/<id>.<ext>，清单：data/emojis/library.json
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface EmojiItem {
  id: string;
  name: string; // AI 用 [表情:名字] 引用
  file: string; // 相对 _shared 的文件名
  explanation: string; // 给 AI 看的含义说明
  createdAt: string;
}

/** 库容量上限：注入 prompt 的是名字+解释，太多会挤占上下文 */
export const MAX_EMOJIS = 200;

const ALLOWED_EXT = ["png", "jpg", "jpeg", "gif", "webp"];

export function emojiDir(): string {
  return path.join(dataDir(), "emojis", "_shared");
}

function libraryPath(): string {
  return path.join(dataDir(), "emojis", "library.json");
}

/** 表情图片的公网访问前缀（server 把 data/emojis 挂在 /emojis） */
export function emojiUrl(file: string): string {
  return `/emojis/_shared/${file}`;
}

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
    createdAt: new Date().toISOString(),
  };
  await saveLibrary([...emojis, item]);
  return item;
}

export async function updateEmoji(id: string, patch: { name?: string; explanation?: string }): Promise<EmojiItem | null> {
  const emojis = await listEmojis();
  const item = emojis.find((e) => e.id === id);
  if (!item) return null;
  if (typeof patch.name === "string" && patch.name.trim()) {
    const name = patch.name.trim().slice(0, 40);
    if (emojis.some((e) => e.id !== id && e.name === name)) throw new Error(`表情名「${name}」已存在`);
    item.name = name;
  }
  if (typeof patch.explanation === "string") item.explanation = patch.explanation.trim().slice(0, 200);
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
      merged.push({ id, name, file, explanation: old.explanation ?? "", createdAt: new Date().toISOString() });
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
 */
export async function buildEmojiPrompt(level: string): Promise<string> {
  if (level === "关闭") return "";
  const emojis = await listEmojis();
  if (emojis.length === 0) return "";
  const usage = level === "贴近原始" ? "尽量在合适位置使用" : level === "克制" ? "偶尔在合适位置使用" : "少量使用";
  const lines = emojis.map((e) => `- ${e.name}：${e.explanation || "（无解释）"}`).join("\n");
  return (
    `\n\n【表情包】你有以下表情包可用，${usage}。` +
    `想发表情时在回复里写 [表情:名字]（会被渲染成图片），名字必须与下面完全一致，不要编造：\n` +
    lines
  );
}
