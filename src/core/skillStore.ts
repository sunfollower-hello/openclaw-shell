// 用户自定义技能：内置技能库之外，用户可在设置页自己加「名称 + 提示词」
// 存 data/skills.json；与内置 SKILL_LIBRARY 合并后供聊天注入
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./cardStore.js";
import { SKILL_LIBRARY, type BuiltinSkill } from "./skills.js";

export interface UserSkill {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
}

function storePath(): string {
  return path.join(dataDir(), "skills.json");
}

function norm(raw: Partial<UserSkill> | undefined, idx: number): UserSkill {
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : `skill-${crypto.randomUUID().slice(0, 8)}`,
    name: String(raw?.name ?? "").trim() || `自定义技能 ${idx + 1}`,
    prompt: String(raw?.prompt ?? "").trim(),
    enabled: raw?.enabled !== false,
  };
}

export async function listUserSkills(): Promise<UserSkill[]> {
  try {
    const raw = JSON.parse(await fs.readFile(storePath(), "utf8"));
    const arr = Array.isArray(raw?.skills) ? (raw.skills as Array<Partial<UserSkill>>) : [];
    return arr.map(norm).filter((s) => s.prompt);
  } catch {
    return [];
  }
}

export async function saveUserSkills(skills: Array<Partial<UserSkill>>): Promise<UserSkill[]> {
  const clean = (Array.isArray(skills) ? skills : []).map(norm).filter((s) => s.prompt);
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify({ skills: clean }, null, 2), "utf8");
  return clean;
}

/** 内置 + 用户自定义（内置不可删，用户的可增删改） */
export async function allSkills(): Promise<Array<BuiltinSkill & { builtin: boolean; enabled: boolean }>> {
  const user = await listUserSkills();
  return [
    ...SKILL_LIBRARY.map((s) => ({ ...s, builtin: true, enabled: true })),
    ...user.map((s) => ({ id: s.id, name: s.name, prompt: s.prompt, builtin: false, enabled: s.enabled })),
  ];
}

/** 按 id 取提示词（聊天注入用），内置与自定义都能查到 */
export async function skillPromptsByIds(ids: string[]): Promise<string[]> {
  const all = await allSkills();
  return ids
    .map((id) => all.find((s) => s.id === id && s.enabled)?.prompt)
    .filter((p): p is string => Boolean(p));
}
