// 极简 PNG 读写：用于角色卡（SillyTavern CCv2 标准，tEXt "chara" 块存 base64 JSON）
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读取 PNG 全部 tEXt 块（keyword → text） */
export function pngExtractText(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return out;
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0) out[data.toString("latin1", 0, nul)] = data.toString("latin1", nul + 1);
    }
    off += 12 + len;
  }
  return out;
}

/** 生成纯色 RGBA PNG（作为无头像卡片的底图） */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const p = y * stride + 1 + x * 4;
      raw[p] = rgba[0];
      raw[p + 1] = rgba[1];
      raw[p + 2] = rgba[2];
      raw[p + 3] = rgba[3];
    }
  }
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 把 tEXt 块（base64 或原始文本）注入已有 PNG，返回新 PNG */
export function pngWithText(png: Buffer, keyword: string, text: string): Buffer {
  const chunks: Buffer[] = [PNG_SIG];
  let off = 8;
  let inserted = false;
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      const kw = nul > 0 ? data.toString("latin1", 0, nul) : "";
      if (kw === keyword) {
        off += 12 + len;
        continue; // 去掉旧的同名块
      }
    }
    chunks.push(png.subarray(off, off + 12 + len));
    if (type === "IEND" && !inserted) {
      const textData = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
      chunks.push(chunk("tEXt", textData));
      inserted = true;
    }
    off += 12 + len;
  }
  if (!inserted) {
    const textData = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
    chunks.push(chunk("tEXt", textData));
  }
  return Buffer.concat(chunks);
}

/** 从 tEXt 提取 CCv2 卡片 JSON（兼容 base64 与原始 JSON） */
export function extractCardJson(png: Buffer): unknown | null {
  const texts = pngExtractText(png);
  for (const kw of ["chara", "chara_card_v2", "ccv3"]) {
    const raw = texts[kw];
    if (!raw) continue;
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      try {
        return JSON.parse(raw);
      } catch {
        /* 继续尝试下一个关键字 */
      }
    }
  }
  return null;
}
