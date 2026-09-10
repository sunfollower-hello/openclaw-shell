#!/usr/bin/env node
// 清洗历史数据里的 MEDIA: 指令行（模型复读工具结果留下的坏样例，会教模型编造 MEDIA 路径/表情名）。
// 处理范围：data/conversations/*.jsonl、data/memory/*.chatlog.jsonl、~/.openclaw/agents/*/sessions/*.jsonl
// 幂等可重放；只剥离 MEDIA: 段（同行后续文字保留），不删消息、不动 id（会话游标安全）。
// 运行：node scripts/clean-media-lines.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// 与通道补丁同款的 MEDIA 行识别（支持反引号包裹含空格路径 + 裸路径，按扩展名截断）
const MEDIA_RE =
  /^\s*MEDIA:\s*(?:`([^`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv))`|([^\s`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv)))/i;

export function cleanMediaLines(text) {
  if (!String(text).includes("MEDIA:")) return String(text);
  const lines = String(text).split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(MEDIA_RE);
    if (m) {
      const rest = line.slice(m[0].length).trim();
      if (rest) out.push(rest); // 纯 MEDIA 行剔除；同行后续文字保留
    } else if (/^\s*MEDIA:\s*/i.test(line)) {
      // 无扩展名可截断的 MEDIA 行（如模型编造的 MEDIA:null、MEDIA:C:\Users）→ 整行剔除
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** 递归清洗对象内所有字符串字段（OpenClaw 会话消息是嵌套结构：message.content 数组） */
function cleanDeep(value) {
  if (typeof value === "string") {
    return value.includes("MEDIA:") ? cleanMediaLines(value) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const c = cleanDeep(v);
      if (c !== v) changed = true;
      return c;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    const out = { ...value };
    let changed = false;
    for (const k of Object.keys(out)) {
      const c = cleanDeep(out[k]);
      if (c !== out[k]) {
        out[k] = c;
        changed = true;
      }
    }
    return changed ? out : value;
  }
  return value;
}

async function cleanJsonlFile(file, label) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { file, label, changed: 0, skipped: true };
  }
  const lines = raw.split(/\r?\n/);
  let changed = 0;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      out.push(line); // 非 JSON 行（罕见）不动
      continue;
    }
    if (obj && typeof obj === "object") {
      const cleaned = cleanDeep(obj);
      if (cleaned !== obj) changed++;
      out.push(JSON.stringify(cleaned));
    } else {
      out.push(line);
    }
  }
  if (changed > 0) await fs.writeFile(file, out.join("\n"), "utf8");
  return { file, label, changed };
}

async function main() {
  const targets = [];
  const dataDir = path.join(import.meta.dirname, "..", "data");
  for (const f of await fs.readdir(path.join(dataDir, "conversations")).catch(() => [])) {
    if (f.endsWith(".jsonl")) targets.push([path.join(dataDir, "conversations", f), "conversations"]);
  }
  for (const f of await fs.readdir(path.join(dataDir, "memory")).catch(() => [])) {
    if (f.endsWith(".chatlog.jsonl")) targets.push([path.join(dataDir, "memory", f), "chatlog"]);
  }
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
  for (const agent of await fs.readdir(agentsDir).catch(() => [])) {
    const sessDir = path.join(agentsDir, agent, "sessions");
    for (const f of await fs.readdir(sessDir).catch(() => [])) {
      if (f.endsWith(".jsonl")) targets.push([path.join(sessDir, f), `sessions/${agent}`]);
    }
  }
  let total = 0;
  for (const [file, label] of targets) {
    const r = await cleanJsonlFile(file, label);
    if (!r.skipped && r.changed > 0) {
      console.log(`✅ ${label}: ${path.basename(file)} 清洗 ${r.changed} 行`);
      total += r.changed;
    }
  }
  console.log(total ? `完成，共清洗 ${total} 行` : "无需清洗（已是干净状态）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});