// 角色卡宏替换：{{user}} / {{char}} 等（酒馆卡生态标配，导入的卡几乎都带）
// 不替换会让角色把模板变量当字面量念出来，破坏沉浸感
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

/** 用户昵称：读 data/user-profile.json，缺失时用「你」 */
export async function userName(): Promise<string> {
  try {
    const p = JSON.parse(await fs.readFile(path.join(dataDir(), "user-profile.json"), "utf8"));
    const n = String(p?.name ?? "").trim();
    // 默认占位名不适合当角色对用户的称呼
    if (n && n !== "本地用户") return n;
  } catch {
    /* 无资料文件 */
  }
  return "你";
}

export interface MacroValues {
  user: string;
  char: string;
}

/**
 * 替换文本里的角色卡宏（大小写不敏感，兼容 {{ user }} 带空格写法）：
 * {{user}}/{{name}} → 用户昵称，{{char}} → 角色名，{{original}} → 空（占位宏）
 */
export function applyMacros(text: string, v: MacroValues): string {
  if (!text || !text.includes("{{")) return text;
  return text
    .replace(/\{\{\s*(?:user|name)\s*\}\}/gi, v.user)
    .replace(/\{\{\s*char\s*\}\}/gi, v.char)
    .replace(/\{\{\s*original\s*\}\}/gi, "");
}
