// 内存图库：OpenAI 网页生图的字节中转站。
// 生成后不落盘（图片归用户浏览器 IndexedDB 管），字节暂存内存、前端拉走即存；
// 2 小时 TTL 自动过期（用户没拉走就是丢了，重新生成即可）。
import crypto from "node:crypto";

interface MemImage {
  buf: Buffer;
  mime: string;
  createdAt: number;
}

const store = new Map<string, MemImage>();
const TTL = 2 * 3600 * 1000;

export function storeMemImage(buf: Buffer, mime: string): string {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.createdAt > TTL) store.delete(k);
  const id = "m" + crypto.randomBytes(9).toString("base64url");
  store.set(id, { buf, mime, createdAt: now });
  return id;
}

export function getMemImage(id: string): { buf: Buffer; mime: string } | null {
  const v = store.get(id);
  if (!v) return null;
  if (Date.now() - v.createdAt > TTL) {
    store.delete(id);
    return null;
  }
  return { buf: v.buf, mime: v.mime };
}
