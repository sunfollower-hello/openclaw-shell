// 把内置预设的新文本同步进 data/presets.json（存储内容会**压过**代码内置，见 HANDOFF §v6/09-11 那个坑）。
//
// 用在改了内置文案之后：代码改完，data/presets.json 里那份旧副本不会自动更新，
// 于是网页试聊/通道编译读到的还是旧文案。这个脚本只动指定的条目，其余一律不碰。
//
// 跑法（本机或服务器都行，读的是 src 源码里的内置文本，纯文本抽取不需要编译）：
//   node scripts/sync-preset-text.mjs                       # 默认同步重描写规则 + 重描写示范对话
//   node scripts/sync-preset-text.mjs rich-rule chat-rule   # 指定条目 id
//   node scripts/sync-preset-text.mjs --file /path/presets.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DEFAULT_IDS = ["rich-rule", "rich-example-ai"];

const argv = process.argv.slice(2);
let file = path.join(root, "data", "presets.json");
const ids = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") { file = argv[++i]; continue; }
  ids.push(argv[i]);
}
if (!ids.length) ids.push(...DEFAULT_IDS);

/** 从内置源里抽出某个条目的 content（以 `id: "xxx"` 为锚，取其后第一个反引号块） */
function builtinContent(src, id) {
  const anchor = src.indexOf(`id: "${id}"`);
  if (anchor < 0) return null;
  const open = src.indexOf("content: `", anchor);
  if (open < 0) return null;
  const start = open + "content: `".length;
  const end = src.indexOf("`", start);
  if (end < 0) return null;
  return src.slice(start, end).replace(/\r\n/g, "\n"); // 统一成 \n，和前端保存出来的形态一致
}

const src = fs.readFileSync(path.join(root, "src", "core", "presets.ts"), "utf8");
const store = JSON.parse(fs.readFileSync(file, "utf8"));
let changed = 0;
for (const group of [...(store.tiers ?? []), ...(store.styles ?? [])]) {
  for (const item of group.items ?? []) {
    if (!ids.includes(item.id)) continue;
    const next = builtinContent(src, item.id);
    if (next == null) { console.log(`  ! 内置源里找不到 ${item.id}，跳过`); continue; }
    if ((item.content ?? "") === next) { console.log(`  = ${item.id} 已是最新`); continue; }
    console.log(`  ✓ ${item.id}（组 ${group.id}）${(item.content ?? "").length} → ${next.length} 字`);
    item.content = next;
    changed++;
  }
}
if (changed) {
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
  console.log(`已更新 ${changed} 条 → ${file}`);
} else {
  console.log(`没有需要更新的条目（${file}）`);
}
