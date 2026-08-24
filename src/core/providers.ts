// API 提供商管理（对话 + 生图）：多提供商、自动拉取模型、第一个为默认
// 首次使用自动从 ~/.openclaw/openclaw.json 迁移已有配置
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";

export type ProviderType = "chat" | "image";

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ProvidersFile {
  chat: Provider[];
  image: Provider[];
}

async function filePath(): Promise<string> {
  return path.join(dataDir(), "providers.json");
}

function openclawConfigPath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

/** 从 openclaw.json 迁移已有 providers（仅首次） */
async function migrateFromOpenclaw(data: ProvidersFile): Promise<ProvidersFile> {
  if (data.chat.length > 0) return data;
  try {
    const cfg = JSON.parse(await fs.readFile(openclawConfigPath(), "utf8"));
    const providers = cfg.models?.providers ?? {};
    for (const [name, p] of Object.entries<any>(providers)) {
      if (!p?.baseUrl) continue;
      data.chat.push({
        name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey ?? "",
        models: (p.models ?? []).map((m: any) => m.id).filter(Boolean),
      });
    }
  } catch { /* 无配置则跳过 */ }
  return data;
}

export async function listProviders(maskKey = true): Promise<ProvidersFile> {
  let data: ProvidersFile;
  try {
    data = JSON.parse(await fs.readFile(await filePath(), "utf8"));
  } catch {
    data = { chat: [], image: [] };
  }
  data = await migrateFromOpenclaw(data);
  data.chat ??= [];
  data.image ??= [];
  if (maskKey) {
    const mask = (p: Provider): Provider => ({ ...p, apiKey: p.apiKey ? p.apiKey.slice(0, 6) + "…" : "" });
    return { chat: data.chat.map(mask), image: data.image.map(mask) };
  }
  return data;
}

async function writeProviders(data: ProvidersFile): Promise<void> {
  await fs.mkdir(path.dirname(await filePath()), { recursive: true });
  await fs.writeFile(await filePath(), JSON.stringify(data, null, 2), "utf8");
}

export async function saveProvider(
  type: ProviderType,
  input: { name: string; baseUrl: string; apiKey?: string; models?: string[] }
): Promise<Provider> {
  const data = await listProviders(false);
  const arr = data[type];
  const name = String(input.name ?? "").trim();
  if (!name || !/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    throw new Error("名称只能包含字母/数字/下划线/连字符（1-32 位）");
  }
  const i = arr.findIndex((x) => x.name === name);
  const prev = i >= 0 ? arr[i] : undefined;
  const entry: Provider = {
    name,
    baseUrl: String(input.baseUrl ?? "").trim(),
    apiKey: input.apiKey?.trim() ? input.apiKey.trim() : (prev?.apiKey ?? ""),
    models: input.models?.length ? input.models : (prev?.models ?? []),
  };
  if (!entry.baseUrl) throw new Error("Base URL 不能为空");
  if (i >= 0) arr[i] = entry;
  else arr.push(entry);
  await writeProviders(data);
  if (type === "chat") await syncToOpenclaw(data);
  return entry;
}

export async function deleteProvider(type: ProviderType, name: string): Promise<void> {
  const data = await listProviders(false);
  data[type] = data[type].filter((p) => p.name !== name);
  await writeProviders(data);
  if (type === "chat") await syncToOpenclaw(data);
}

/** 把某个提供商移到第一位（成为默认） */
export async function moveProviderDefault(type: ProviderType, name: string): Promise<void> {
  const data = await listProviders(false);
  const i = data[type].findIndex((x) => x.name === name);
  if (i < 0) throw new Error(`找不到提供商 ${name}`);
  const [p] = data[type].splice(i, 1);
  data[type].unshift(p);
  await writeProviders(data);
  if (type === "chat") await syncToOpenclaw(data);
}

/** 从提供商拉取可用模型列表（GET /models） */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`拉取失败 HTTP ${r.status}`);
  const data = await r.json();
  const list = (data.data ?? data.models ?? []) as Record<string, unknown>[];
  const ids = list
    .map((m) => String(m.id ?? m.model ?? m.name ?? ""))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/** 把 chat 提供商同步到 openclaw.json（第一个 = 默认 API，其第一个模型 = 默认模型） */
export async function syncToOpenclaw(data?: ProvidersFile): Promise<void> {
  const d = data ?? (await listProviders(false));
  if (d.chat.length === 0) return;
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(await fs.readFile(openclawConfigPath(), "utf8"));
  } catch {
    cfg = {};
  }
  cfg.models ??= {};
  cfg.models.providers ??= {};
  for (const k of Object.keys(cfg.models.providers)) {
    if (!d.chat.some((p) => p.name === k)) delete cfg.models.providers[k];
  }
  for (const p of d.chat) {
    cfg.models.providers[p.name] = {
      baseUrl: p.baseUrl,
      api: "openai-completions",
      apiKey: p.apiKey,
      models: (p.models.length ? p.models : [p.name + "-default"]).map((id) => ({ id, name: id })),
    };
  }
  const first = d.chat[0];
  const firstModel = first.models[0];
  if (firstModel) {
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.model = { primary: `${first.name}/${firstModel}` };
  }
  await fs.writeFile(openclawConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
}

/** 解析聊天用的 LLM 配置：卡片单独配置优先，否则第一个 chat 提供商 */
export async function resolveChatLLM(
  card?: { model?: { provider?: string; model?: string } }
): Promise<{ baseUrl: string; apiKey: string; model: string; provider: string } | null> {
  const d = await listProviders(false);
  let p = card?.model?.provider ? d.chat.find((x) => x.name === card.model?.provider) : undefined;
  let modelId = card?.model?.model;
  if (!p) {
    p = d.chat[0];
    modelId = undefined;
  }
  if (!p || !p.apiKey) return null;
  const model = modelId && p.models.includes(modelId) ? modelId : p.models[0];
  if (!model) return null;
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model, provider: p.name };
}
