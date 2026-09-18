// API 提供商管理（对话 + 生图）：多提供商、自动拉取模型、第一个为默认
// 首次使用自动从 ~/.openclaw/openclaw.json 迁移已有配置（仅管理员/单用户，见下）
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";
import { currentDeviceId, devicePrefix } from "./dataRoot.js";
import { ensureGatewayToolPolicy } from "./gatewayToolPolicy.js";

export type ProviderType = "chat" | "image";

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** false = 停用（配置留着但不参与选择/解析）；缺省视为启用 */
  enabled?: boolean;
  /** 内置预设厂商标记（默认停用；用户未删除则始终补在列表尾部，新加的自定义商排在它前面） */
  builtin?: boolean;
  /** 官方自营中转站：永远置顶（不被新增挤下去），多机器人第 3 个起强制走它 */
  official?: boolean;
}

/**
 * 官方中转站（自营）：永远排在列表第一位，用户新增的提供商一律插在它下面，
 * 不像其他内置预设那样被新增挤下去。多机器人从第 3 个起强制走它（见 OFFICIAL_PROVIDER_NAME 用法）。
 */
export const OFFICIAL_PROVIDER_NAME = "Soul API";
export const OFFICIAL_PROVIDER: { name: string; baseUrl: string; models: string[] } = {
  name: OFFICIAL_PROVIDER_NAME,
  baseUrl: "https://api.319274.xyz/v1",
  models: [],
};

/** 内置预设厂商：默认停用，只给 name/baseUrl/预填模型，用户自己填 key 并启用 */
export const BUILTIN_CHAT_PROVIDERS: { name: string; baseUrl: string; models: string[] }[] = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", models: [] },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: [] },
];

function isBuiltinProvider(name: string): boolean {
  return BUILTIN_CHAT_PROVIDERS.some((b) => b.name === name);
}

// ---------- 模型 Key 的设备级隔离（Phase B） ----------
// openclaw.json 的 models.providers 是**全局**的（一台服务器一份配置、一个网关），
// 而每台设备填的 Key 是各自的。若两台设备都加一个叫「DeepSeek」的商：
//   ① 后写的直接覆盖先写的（Key 被顶掉，且互相能用量）；
//   ② 旧的清理逻辑会把"本设备列表里没有"的条目一律删掉 —— 设备一保存就把管理员的
//      所有提供商从配置里删干净（这是修之前真实存在的线上 bug）。
// 方案：把提供商名按设备加前缀写进 openclaw.json（u3a012510-DeepSeek），各写各的键、
// 各清各的条目；agent 的 model 字段引用带前缀的名字（resolveChatLLM 返回的 provider）。
// 设备自己的 providers.json 里始终存**不带前缀**的原名，卡片里引用的也是原名。
/** openclaw.json 里带设备前缀的提供商名（前缀形如 u3a012510-） */
export function namespacedProviderName(name: string): string {
  return devicePrefix() + name;
}

/** 是否是「某台设备私有」的提供商键（用于清理时区分归属，管理员的名字不带前缀） */
export function isDeviceScopedProviderKey(key: string): boolean {
  return /^u[0-9a-f]{8}-/.test(key);
}

export function isOfficialProvider(name: string): boolean {
  return name === OFFICIAL_PROVIDER_NAME;
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

/**
 * 从 openclaw.json 迁移已有 providers（仅首次）。
 * 【只在管理员/单用户作用域跑】openclaw.json 里的提供商是运营者自己的（带明文 Key），
 * 设备作用域迁移等于把管理员的所有 Key 复制给任意用户 —— 设备一律从空列表开始。
 */
async function migrateFromOpenclaw(data: ProvidersFile): Promise<ProvidersFile> {
  if (data.chat.length > 0) return data;
  if (currentDeviceId()) return data;
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

/** 用户删除过的内置预设不再补回（记 name）；会话级足够（重启后也不补——删了就是删了） */
const dismissedBuiltins = new Set<string>();

/** 确保内置预设厂商存在（默认停用、排在列表尾部，用户新加的自定义商自然排在它前面） */
function ensureBuiltinProviders(data: ProvidersFile): void {
  data.chat ??= [];
  for (const b of BUILTIN_CHAT_PROVIDERS) {
    if (dismissedBuiltins.has(b.name)) continue;
    if (data.chat.some((p) => p.name === b.name)) continue;
    data.chat.push({
      name: b.name,
      baseUrl: b.baseUrl,
      apiKey: "",
      models: [...b.models],
      enabled: false,
      builtin: true,
    });
  }
  ensureOfficialFirst(data);
}

/**
 * 官方中转站置顶：不存在就补（默认停用，等用户填 key），已存在就挪到第 0 位。
 * 与其他内置预设的区别：它不会被用户新增的提供商挤下去，永远是列表第一个。
 */
function ensureOfficialFirst(data: ProvidersFile): void {
  data.chat ??= [];
  const i = data.chat.findIndex((p) => p.name === OFFICIAL_PROVIDER_NAME);
  if (i < 0) {
    if (dismissedBuiltins.has(OFFICIAL_PROVIDER_NAME)) return; // 用户本会话删过就不补回
    data.chat.unshift({
      name: OFFICIAL_PROVIDER.name,
      baseUrl: OFFICIAL_PROVIDER.baseUrl,
      apiKey: "",
      models: [...OFFICIAL_PROVIDER.models],
      enabled: false,
      builtin: true,
      official: true,
    });
    return;
  }
  const [p] = data.chat.splice(i, 1);
  p.official = true; // 老数据补标记
  p.builtin = true;
  data.chat.unshift(p);
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
  // 老数据没有 enabled 字段，一律视为启用
  for (const arr of [data.chat, data.image]) {
    for (const p of arr) p.enabled = p.enabled !== false;
  }
  ensureBuiltinProviders(data);
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
  // 名称不限制字符集（允许中文/空格等）；仅限制长度防滥用，并禁止纯空白
  if (!name || name.length > 32) {
    throw new Error("名称不能为空且长度不超过 32 字符");
  }
  const i = arr.findIndex((x) => x.name === name);
  const prev = i >= 0 ? arr[i] : undefined;
  const entry: Provider = {
    name,
    baseUrl: String(input.baseUrl ?? "").trim(),
    apiKey: input.apiKey?.trim() ? input.apiKey.trim() : (prev?.apiKey ?? ""),
    models: input.models?.length ? input.models : (prev?.models ?? []),
    enabled: prev ? prev.enabled !== false : true, // 编辑不改停用状态，新建默认启用
  };
  if (!entry.baseUrl) throw new Error("Base URL 不能为空");
  if (i >= 0) {
    arr[i] = entry;
  } else {
    // 新加的自定义商排在内置预设前面（用户要求：新加的上浮，预设往下挤），
    // 但官方中转站永远置顶：从索引 1 起找第一个内置预设的位置插入（0 号位留给官方）
    const firstBuiltin = arr.findIndex((x, idx) => idx > 0 && (x.builtin === true || isBuiltinProvider(x.name)));
    if (firstBuiltin >= 0) arr.splice(firstBuiltin, 0, entry);
    else arr.push(entry);
  }
  if (type === "chat") ensureOfficialFirst(data); // 插入后再兜一次，确保官方仍在首位
  await writeProviders(data);
  if (type === "chat") await syncToOpenclaw(data);
  return entry;
}

export async function deleteProvider(type: ProviderType, name: string): Promise<void> {
  const data = await listProviders(false);
  data[type] = data[type].filter((p) => p.name !== name);
  await writeProviders(data);
  // 内置预设被用户删除：本会话内不再自动补回（不然删了又出现）
  if (isBuiltinProvider(name)) dismissedBuiltins.add(name);
  if (type === "chat") await syncToOpenclaw(data);
}

/** 启用 / 停用某个提供商（配置保留，只是不再参与选择与解析） */
export async function setProviderEnabled(type: ProviderType, name: string, enabled: boolean): Promise<Provider> {
  const data = await listProviders(false);
  const p = data[type].find((x) => x.name === name);
  if (!p) throw new Error(`找不到提供商 ${name}`);
  p.enabled = enabled;
  await writeProviders(data);
  if (type === "chat") await syncToOpenclaw(data);
  return p;
}

/**
 * 把某个提供商移到第一位（成为默认）。
 * 官方中转站占 0 号位不动：设别的商为默认时排到它后面（索引 1），
 * 「默认」的实际含义是「第一个启用中的商」——官方没填 key/未启用时不影响用户的默认选择。
 */
export async function moveProviderDefault(type: ProviderType, name: string): Promise<void> {
  const data = await listProviders(false);
  const i = data[type].findIndex((x) => x.name === name);
  if (i < 0) throw new Error(`找不到提供商 ${name}`);
  const [p] = data[type].splice(i, 1);
  if (type === "chat" && !isOfficialProvider(name) && data.chat.some((x) => x.name === OFFICIAL_PROVIDER_NAME)) {
    data.chat.splice(1, 0, p); // 官方之后
  } else {
    data[type].unshift(p);
  }
  if (type === "chat") ensureOfficialFirst(data);
  await writeProviders(data);
  if (type === "chat") await syncToOpenclaw(data);
}

/** 取某个提供商的完整 API Key（编辑页「眼睛」查看用；页面本身有 Basic 认证保护） */
export async function revealApiKey(type: ProviderType, name: string): Promise<string> {
  const data = await listProviders(false);
  const p = data[type].find((x) => x.name === name);
  return p?.apiKey ?? "";
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

/**
 * 把 chat 提供商同步到 openclaw.json（第一个 = 默认 API，其第一个模型 = 默认模型）。
 *
 * 分作用域写（见文件上方「模型 Key 的设备级隔离」）：
 *  - 提供商键名加设备前缀，只写/只清**本作用域自己的**条目，别人的一个都不动；
 *  - `agents.defaults.model`（全局默认模型）只有管理员作用域才改 —— 设备保存一次自己的
 *    模型就顺手改掉全服默认模型，会把运营者的默认模型带跑偏。
 */
export async function syncToOpenclaw(data?: ProvidersFile): Promise<void> {
  const all = data ?? (await listProviders(false));
  // 停用的提供商不写进 openclaw.json（否则通道端仍会用到它）
  const d: ProvidersFile = { chat: all.chat.filter((p) => p.enabled !== false), image: all.image };
  const mine = d.chat.map((p) => namespacedProviderName(p.name));
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(await fs.readFile(openclawConfigPath(), "utf8"));
  } catch {
    cfg = {};
  }
  cfg.models ??= {};
  cfg.models.providers ??= {};
  // 清理：只删「本作用域拥有」但已不在启用列表里的条目。
  // 管理员作用域 = 无前缀的条目；设备作用域 = 本设备前缀的条目。
  const scopePrefix = devicePrefix();
  const ownsKey = (k: string): boolean => (scopePrefix ? k.startsWith(scopePrefix) : !isDeviceScopedProviderKey(k));
  // 一个启用的提供商都没有时，原来是直接返回（绝不把配置清空）——只删自己那几条：
  // 自己名下本来就没有条目就什么都不做（避免无意义地重写配置触发网关重载）
  if (d.chat.length === 0 && !Object.keys(cfg.models.providers).some(ownsKey)) return;
  for (const k of Object.keys(cfg.models.providers)) {
    if (ownsKey(k) && !mine.includes(k)) delete cfg.models.providers[k];
  }
  for (const p of d.chat) {
    cfg.models.providers[namespacedProviderName(p.name)] = {
      baseUrl: p.baseUrl,
      api: "openai-completions",
      apiKey: p.apiKey,
      models: (p.models.length ? p.models : [p.name + "-default"]).map((id) => ({ id, name: id })),
    };
  }
  // 默认模型是全局设置：只有运营者（管理员/单用户）作用域能改
  if (!scopePrefix) {
    const first = d.chat[0];
    const firstModel = first?.models[0];
    if (first && firstModel) {
      cfg.agents ??= {};
      cfg.agents.defaults ??= {};
      cfg.agents.defaults.model = { primary: `${first.name}/${firstModel}` };
    }
  }
  await fs.writeFile(openclawConfigPath(), JSON.stringify(ensureGatewayToolPolicy(cfg), null, 2), "utf8");
}

/**
 * 解析聊天用的 LLM 配置：卡片单独配置优先，否则第一个「启用中」的 chat 提供商。
 * 卡片指定的提供商若已被停用，同样回落到默认，避免聊天直接失败。
 *
 * 返回的 `provider` 是**写给 openclaw.json / 日志用**的名字（设备作用域带前缀），
 * 网页聊天只用 baseUrl/apiKey/model，卡片里存的仍是提供商原名。
 */
export async function resolveChatLLM(
  card?: { model?: { provider?: string; model?: string } },
  opts?: { forceOfficial?: boolean }
): Promise<{ baseUrl: string; apiKey: string; model: string; provider: string } | null> {
  const d = await listProviders(false);
  const usable = d.chat.filter((x) => x.enabled !== false);
  // 强制官方（多机器人第 3 个起）：只认官方中转站，卡片选的别的商一律忽略；
  // 卡片指定的模型若是官方站也有的同名模型则保留，否则用官方第一个模型。
  if (opts?.forceOfficial) {
    const official = usable.find((x) => isOfficialProvider(x.name));
    if (!official || !official.apiKey) return null;
    const want = card?.model?.model;
    const model = want && official.models.includes(want) ? want : official.models[0];
    if (!model) return null;
    return { baseUrl: official.baseUrl, apiKey: official.apiKey, model, provider: namespacedProviderName(official.name) };
  }
  let p = card?.model?.provider ? usable.find((x) => x.name === card.model?.provider) : undefined;
  let modelId = card?.model?.model;
  if (!p) {
    p = usable[0];
    modelId = undefined;
  }
  if (!p || !p.apiKey) return null;
  const model = modelId && p.models.includes(modelId) ? modelId : p.models[0];
  if (!model) return null;
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model, provider: namespacedProviderName(p.name) };
}
