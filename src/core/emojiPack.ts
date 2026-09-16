// 表情包 zip 解析（纯函数，不碰库）：一个 zip → 待导入的表情列表 + 问题报告。
//
// 约定的包结构（scripts/make-emoji-pack.ps1 就是按这个生成的）：
//   1.大笑.gif        序号 + 名字（名字取"序号后面那段"）
//   2.偷笑.gif
//   开心/瞪眼.gif     子文件夹 = 分组（可选）
//   说明.txt          使用场景，按序号对应；`#` 开头是注释行
//     1.气氛轻松、想逗对方时用
//     2.
//     3.震惊的瞬间
//
// 容错（用户手攒的包什么样都有，尽量认，认不出就明确报告）：
//   - 序号前缀支持 `1.` `1、` `1)` `1_` `1-` `01 ` 等写法；没有序号的按名字配
//   - TXT 也支持"名字 空格 场景"这种写法（整份文件按形状自动判断用哪种）
//   - 序号/名字都对不上的：按 zip 内顺序兜底配剩下的行
//   - 文件名与 TXT 内容的编码：先按 UTF-8 严格解，失败回退 GBK（Windows 压缩包常见）
import AdmZip from "adm-zip";

export const PACK_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
/** 单张上限：表情本来就该是小的，超过基本是误拖了大图 */
export const MAX_ITEM_BYTES = 5 * 1024 * 1024;
const MAX_NAME_CHARS = 40;
const MAX_SCENE_CHARS = 200;
const MAX_GROUP_CHARS = 20;

export interface PackItem {
  /** 包里的序号（1 起）；没有序号时为 0 */
  index: number;
  name: string;
  scene: string;
  /** 目标分组名（子文件夹名），空 = 默认分组 */
  group: string;
  ext: string;
  data: Buffer;
  /** 包里的原始路径，报告里用 */
  path: string;
}

export interface PackProblem {
  what: string;
  reason: string;
}

export interface PackParse {
  items: PackItem[];
  problems: PackProblem[];
  /** 给用户看的解析说明（认出了几行说明、用的哪种模式…） */
  notes: string[];
  /** 说明文件的文件名（没有则空） */
  manifest: string;
}

/** 先 UTF-8 严格解，失败回退 GBK（两种都失败就用宽松 UTF-8，乱码也认） */
function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 不是合法 UTF-8，试 GBK */
  }
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/** zip 里的条目名：rawEntryName 是原始字节，按上面的规则解（adm-zip 给的字符串可能已经乱码） */
function decodeEntryName(entry: AdmZip.IZipEntry): string {
  const raw = (entry as unknown as { rawEntryName?: Buffer }).rawEntryName;
  return raw && raw.length ? decodeText(raw) : entry.entryName;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function cleanText(s: string, max: number): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 从文件名（去扩展名）里拆出序号与名字：`12.大笑` / `03、偷笑` / `7 瞪眼` */
function splitIndexed(base: string): { index: number; name: string } {
  const m = base.match(/^0*(\d{1,4})\s*[.、)_\-\uff0e]?\s*(.*)$/);
  if (m && m[2]) return { index: Number(m[1]), name: m[2].trim() };
  if (m && !m[2] && /^0*\d{1,4}$/.test(base.trim())) return { index: Number(m[1]), name: "" };
  return { index: 0, name: base.trim() };
}

/** 解析说明文件：返回 序号→场景 与 名字→场景 两套映射 + 模式判断 */
function parseManifest(text: string): {
  byIndex: Map<number, string>;
  byName: Map<string, string>;
  indexed: boolean;
  badLines: string[];
} {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const byIndex = new Map<number, string>();
  const byName = new Map<string, string>();
  const badLines: string[] = [];
  let indexedCount = 0;
  for (const line of lines) {
    const m = line.match(/^0*(\d{1,4})\s*[.、)_\-\uff0e]?\s*(.*)$/);
    // 形如 "1.场景" / "1." / "1、场景" 都算序号行
    if (m && (/^0*\d/.test(line))) {
      const idx = Number(m[1]);
      const rest = m[2].trim();
      if (byIndex.has(idx)) badLines.push(line);
      else byIndex.set(idx, rest);
      indexedCount++;
      continue;
    }
    // 名字模式："名字 场景" 或 纯名字
    const parts = line.split(/[\s|｜]+/);
    const name = cleanText(parts[0], MAX_NAME_CHARS);
    if (!name) {
      badLines.push(line);
      continue;
    }
    byName.set(name, cleanText(parts.slice(1).join(" "), MAX_SCENE_CHARS));
  }
  // 大部分行是"数字开头"就当序号模式（用户的写法），否则按名字模式
  return { byIndex, byName, indexed: indexedCount * 2 >= lines.length, badLines };
}

export function parseEmojiPack(zipBuf: Buffer, opts?: { group?: string }): PackParse {
  const problems: PackProblem[] = [];
  const notes: string[] = [];
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuf);
  } catch {
    throw new Error("这不是一个能读的 zip 文件（或者包已损坏）");
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  // 说明文件：优先「说明.txt」，其次任意 .txt
  const txts = entries.filter((e) => decodeEntryName(e).toLowerCase().endsWith(".txt"));
  const manifestEntry = txts.find((e) => /^说明\.txt$/i.test(decodeEntryName(e))) ?? txts[0];
  let manifest = { byIndex: new Map<number, string>(), byName: new Map<string, string>(), indexed: true, badLines: [] as string[] };
  if (manifestEntry) {
    manifest = parseManifest(decodeText(manifestEntry.getData()));
    if (manifestEntry !== txts[0] && txts.length > 1) notes.push(`包里有 ${txts.length} 个 txt，用了「${decodeEntryName(manifestEntry)}」`);
    notes.push(manifest.indexed ? "说明文件按「序号 + 场景」解析" : "说明文件按「名字 + 场景」解析");
    if (manifest.badLines.length) problems.push({ what: manifest.badLines.slice(0, 3).join(" / "), reason: `说明里有 ${manifest.badLines.length} 行没看明白，已忽略` });
  } else {
    notes.push("包里没有说明文件，所有表情的使用场景都留空");
  }

  // 收图片
  const files: { path: string; ext: string; base: string; index: number; name: string; group: string; data: Buffer }[] = [];
  for (const e of entries) {
    if (e === manifestEntry) continue;
    const full = decodeEntryName(e).replace(/\\/g, "/");
    const lower = full.toLowerCase();
    if (lower.startsWith("__macosx/") || lower.includes("/.") || lower.startsWith(".")) continue; // 系统垃圾
    if (/\.(ds_store|db)$/.test(lower) || lower.endsWith("thumbs.db")) continue;
    const ext = (lower.split(".").pop() || "").toLowerCase();
    if (!PACK_EXT.includes(ext)) {
      problems.push({ what: full, reason: `不是支持的图片格式（${PACK_EXT.join(" / ")}）` });
      continue;
    }
    const parts = full.split("/");
    const fileName = parts.pop() ?? full;
    const folder = parts.length ? parts[0] : "";
    const base = fileName.replace(/\.[^.]+$/, "");
    const { index, name } = splitIndexed(base);
    const buf = e.getData();
    if (buf.length > MAX_ITEM_BYTES) {
      problems.push({ what: full, reason: `单张超过 ${Math.round(MAX_ITEM_BYTES / 1024 / 1024)}MB，已跳过` });
      continue;
    }
    if (!buf.length) {
      problems.push({ what: full, reason: "空文件，已跳过" });
      continue;
    }
    files.push({
      path: full,
      ext,
      base,
      index,
      name: cleanText(name, MAX_NAME_CHARS),
      group: cleanText(folder.split("/").pop() ?? "", MAX_GROUP_CHARS),
      data: buf,
    });
  }
  if (!files.length) throw new Error("包里没找到可用的表情图片（支持 " + PACK_EXT.join(" / ") + "）");

  // 配场景：先按序号/名字配，配不上的按顺序兜底
  const usedScenes = new Set<number>();
  const items: PackItem[] = [];
  const noName: typeof files = [];
  for (const f of files) {
    let scene = "";
    if (manifest.indexed) {
      if (f.index && manifest.byIndex.has(f.index)) {
        scene = manifest.byIndex.get(f.index) ?? "";
        usedScenes.add(f.index);
      } else if (!f.index && f.name && manifest.byName.has(f.name)) {
        scene = manifest.byName.get(f.name) ?? "";
      }
    } else {
      const key = f.index && manifest.byName.has(f.name) ? f.name : f.name;
      if (manifest.byName.has(key)) scene = manifest.byName.get(key) ?? "";
      else if (f.index && manifest.byIndex.has(f.index)) {
        scene = manifest.byIndex.get(f.index) ?? "";
        usedScenes.add(f.index);
      }
    }
    if (!f.name) {
      noName.push(f);
      continue;
    }
    items.push({ index: f.index, name: f.name, scene, group: f.group || opts?.group || "", ext: f.ext, data: f.data, path: f.path });
  }

  // 兜底一：连名字都没有的图（文件名是纯数字）→ 按顺序配还没被用掉的序号行
  if (noName.length) {
    const freeLines = [...manifest.byIndex.entries()].filter(([i]) => !usedScenes.has(i)).sort((a, b) => a[0] - b[0]);
    noName.forEach((f, k) => {
      const line = freeLines[k];
      const scene = line ? line[1] : "";
      if (line) usedScenes.add(line[0]);
      problems.push({ what: f.path, reason: "文件名里没有名字，只用使用场景导入（建议改成有意义的文件名）" });
      items.push({ index: f.index, name: "", scene, group: f.group || opts?.group || "", ext: f.ext, data: f.data, path: f.path });
    });
  }

  // 兜底二：有图但没有对应说明行的 → 场景留空（照样导入，只是没场景）
  const withScene = items.filter((it) => it.scene).length;
  const noScene = items.length - withScene;
  notes.push(`共 ${items.length} 张图；有使用场景 ${withScene} 张，留空 ${noScene} 张`);

  return { items: items.filter((it) => it.name), problems, notes, manifest: manifestEntry ? decodeEntryName(manifestEntry) : "" };
}
