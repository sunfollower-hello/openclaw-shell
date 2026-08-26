// 封面文件存储：AI 生成/上传的封面落盘到 data/covers/<slug>.<ext>，卡片里只存 /covers/... URL
// （参考 RP-Hub：卡 JSON 不背图，体积小、保存快；PNG 导出时封面作为图面、JSON 只嵌文字）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export function coversDir(): string {
  return path.join(dataDir(), "covers");
}

/** 封面 URL → 本地文件路径（仅接受 /covers/<slug>.<ext> 形式，防穿越） */
export function coverPathFromUrl(url: string): string | null {
  const m = /^\/covers\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!m || m[1].includes("..")) return null;
  return path.join(coversDir(), m[1]);
}

/** 落盘封面（固定 slug 名，覆盖写不累积），返回 /covers/<slug>.<ext> */
export async function saveCover(slug: string, buf: Buffer, mimeType?: string): Promise<string> {
  await fs.mkdir(coversDir(), { recursive: true });
  const ext = mimeType === "image/jpeg" ? "jpg" : "png";
  const safe = slug.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "tmp";
  await fs.writeFile(path.join(coversDir(), `${safe}.${ext}`), buf);
  return `/covers/${safe}.${ext}`;
}

/** 读封面文件 → Buffer（不存在/非法路径返回 null） */
export async function readCover(url: string): Promise<Buffer | null> {
  const p = coverPathFromUrl(url);
  if (!p) return null;
  return fs.readFile(p).catch(() => null);
}

/** 迁移：avatar 是 data: base64 → 落盘成文件并返回 URL；是 /covers/ URL 或空 → 原样返回 */
export async function normalizeAvatar(avatar: string | undefined, slug: string): Promise<string | undefined> {
  if (!avatar) return avatar;
  if (avatar.startsWith("/covers/")) return avatar;
  if (avatar.startsWith("data:image/")) {
    const [meta, b64] = avatar.split(",");
    const mime = /image\/(png|jpeg|webp|gif)/.exec(meta)?.[1] ?? "png";
    return saveCover(slug, Buffer.from(b64 ?? "", "base64"), mime);
  }
  return avatar;
}