// 多机器人实例管理：一个实例 = 人设卡 × 渠道账号 × OpenClaw agent
// data/bots.json 持久化；每个 agent 的 workspace 编译到 data/agent-workspaces/<slug>/
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";
import { devicePrefix } from "./dataRoot.js";

// ---------- 两套上限，别混用（2026-09-08 用户拍板） ----------
// ① 绑卡上限：同时能有几个机器人在跑（bots.json 里的实例数）
//    QQ 5 个可以同时各绑一张卡；微信同时只有 1 个账号能绑卡，绑新的时候旧的自动掉落。
export const MAX_QQ_BOTS = 5;
export const MAX_WEIXIN_BOTS = 1;
// ② 账号槽位上限：本机最多保存几个已认证账号（凭证数，与绑卡无关）
//    达上限后二维码不再生成，必须先「彻底删除」一个账号才能扫新的。
export const MAX_QQ_ACCOUNTS = 5;
export const MAX_WEIXIN_ACCOUNTS = 2;

export type BotChannel = "qqbot" | "openclaw-weixin";

export const CHANNEL_LABELS: Record<BotChannel, string> = {
  qqbot: "QQ 机器人",
  "openclaw-weixin": "微信机器人",
};

export interface BotInstance {
  id: string; // bot_<ts36>
  cardSlug: string;
  channel: BotChannel;
  accountId: string; // 渠道账号 id（openclaw channels login --account）
  agentId: string; // openclaw agent 名（默认 = 卡 slug）
  createdAt: string;
}

function botsPath(): string {
  return path.join(dataDir(), "bots.json");
}

/** 每卡独立 agent 的 workspace 目录（与共享 data/workspace 区分） */
export function agentWorkspaceDir(slug: string): string {
  return path.join(dataDir(), "agent-workspaces", slug);
}

/**
 * agent 名（= OpenClaw 里 agents.list 的 id、bindings 的 agentId、侧车拆条表的键）。
 *
 * 【为什么必须带设备前缀】这三个地方都是**全局命名空间**（一份 openclaw.json、
 * 一份 split-styles.json，被所有设备共用），而 agent 的 workspace / memorySearch
 * extraPaths 却是按设备目录（data/users/<id>/）给出的。两台设备各建一张同名卡
 * （slug 都是 grandma）时，不加前缀就是同一个 agentId —— 后建的会覆盖前者，
 * 表现为「我的机器人回的是别人的卡」。管理员（全局作用域）保持原名不加前缀，
 * 与既有数据完全兼容（存量 bots.json 里存的就是 agentId，不受本函数影响）。
 */
export function deviceAgentId(slug: string): string {
  return devicePrefix() + slug;
}

export async function listBots(): Promise<BotInstance[]> {
  try {
    const raw = JSON.parse(await fs.readFile(botsPath(), "utf8"));
    return Array.isArray(raw?.bots) ? raw.bots : [];
  } catch {
    return [];
  }
}

async function saveBots(bots: BotInstance[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(botsPath(), JSON.stringify({ bots }, null, 2), "utf8");
}

export async function getBotByCard(cardSlug: string): Promise<BotInstance | null> {
  return (await listBots()).find((b) => b.cardSlug === cardSlug) ?? null;
}

/**
 * 新建机器人实例。
 * 微信绑卡上限为 1：不再报错拦下，而是把已在跑的那个微信实例「顶掉」（evicted 返回给调用方，
 * 由调用方删掉对应 agent）——用户拍板的语义是「绑新的，旧的直接掉落」。
 * QQ 到 5 个才拦（5 张卡可以同时各绑一个账号）。
 */
export async function addBot(input: {
  cardSlug: string;
  channel: BotChannel;
  accountId: string;
  /** 目标卡已有机器人时：确认后顶掉旧绑定，把这个账号放上去（前端已问过用户） */
  replace?: boolean;
}): Promise<{ bot: BotInstance; evicted: BotInstance[] }> {
  const bots = await listBots();
  const qqCount = bots.filter((b) => b.channel === "qqbot").length;
  if (input.channel === "qqbot" && qqCount >= MAX_QQ_BOTS) {
    throw new Error(`QQ 机器人已达上限（${MAX_QQ_BOTS} 个）。想换别的卡，先在卡片上删除现有机器人。`);
  }
  if (bots.some((b) => b.channel === input.channel && b.accountId === input.accountId)) {
    throw new Error(`渠道账号 ${input.accountId} 已被其他机器人占用。`);
  }
  const evicted: BotInstance[] = [];
  const existingOnCard = bots.find((b) => b.cardSlug === input.cardSlug);
  if (existingOnCard) {
    if (!input.replace) {
      throw new Error("这张卡已经绑定了机器人（每卡一个）。先删除旧的再新建。");
    }
    evicted.push(existingOnCard);
  }
  // 微信超额：把最早的微信实例顶下来，腾出唯一的那个位置
  if (input.channel === "openclaw-weixin") {
    const wx = bots.filter((b) => b.channel === "openclaw-weixin" && !evicted.some((e) => e.id === b.id));
    while (wx.length + 1 > MAX_WEIXIN_BOTS) {
      const drop = wx.shift();
      if (!drop) break;
      evicted.push(drop);
    }
  }
  const kept = bots.filter((b) => !evicted.some((e) => e.id === b.id));
  const bot: BotInstance = {
    id: "bot_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    cardSlug: input.cardSlug,
    channel: input.channel,
    accountId: input.accountId,
    agentId: deviceAgentId(input.cardSlug), // 设备作用域下带前缀防跨用户撞名，见 deviceAgentId
    createdAt: new Date().toISOString(),
  };
  kept.push(bot);
  await saveBots(kept);
  return { bot, evicted };
}

/**
 * 把「像真人一样发消息」的节奏配置写进 openclaw.json 的该 agent 条目。
 * OpenClaw 原生支持 humanDelay（分段回复之间的拟真停顿），不需要自己实现；
 * CLI 的 agents add 没有这个参数，只能直接改配置文件。
 */
export async function applyAgentHumanDelay(
  agentId: string,
  delay: { base_ms?: number; variance?: number } | undefined
): Promise<void> {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch {
    return; // 没有配置文件就不动（网关首启会生成）
  }
  const base = Math.max(200, Math.round(delay?.base_ms ?? 1500));
  const variance = Math.min(1, Math.max(0, delay?.variance ?? 0.4));
  const minMs = Math.max(200, Math.round(base * (1 - variance)));
  const maxMs = Math.round(base * (1 + variance));
  cfg.agents ??= {};
  cfg.agents.list ??= [];
  const entry = (cfg.agents.list as { id?: string; humanDelay?: unknown }[]).find((a) => a.id === agentId);
  const humanDelay = { mode: "custom", minMs, maxMs };
  if (entry) entry.humanDelay = humanDelay;
  else cfg.agents.list.push({ id: agentId, humanDelay });
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
}

/**
 * 侧车表路径：通道插件（openclaw-qqbot / openclaw-weixin 补丁）发送前按 agentId
 * 查这张表决定拆条风格（chat/rich）。表由本项目维护，插件升级丢补丁后
 * 用 scripts/patch-channels.mjs 重打即可恢复读取。
 */
export function splitStylesPath(): string {
  return path.join(os.homedir(), ".openclaw", "split-styles.json");
}

/**
 * 写「agent → 拆条风格」侧车表条目。风格随卡保存/编译写入（与 applyAgentBlockStreaming 并列调用）；
 * 通道插件按消息所属 agent（= 卡 slug）查表，实现每卡独立拆条风格。
 */
export async function applyAgentSplitStyle(
  agentId: string,
  style: "chat" | "rich" | undefined
): Promise<void> {
  if (!agentId) return;
  const file = splitStylesPath();
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(await fs.readFile(file, "utf8"))?.styles ?? {};
  } catch {
    // 表不存在/损坏 → 从空开始（首次创建）
  }
  const s = style === "rich" ? "rich" : "chat";
  if (map[agentId] === s) return; // 没变就别写盘（避免网关无谓感知）
  map[agentId] = s;
  await fs.writeFile(file, JSON.stringify({ styles: map }, null, 2), "utf8");
}

/**
 * 检索隔离（2026-09-08）：每张卡绑定的 agent 只检索自己卡的记忆/本地聊天原文。
 * 原理：memorySearch.extraPaths 的 defaults 级是全局（所有 agent 共用整个目录 = 跨卡互搜），
 * OpenClaw 的 agent 级 memorySearch.extraPaths 与 defaults 是**合并**关系，
 * 所以必须：① defaults.extraPaths 清空；② 每个绑定卡的 agent 级配指向本卡两个 md 文件。
 * 记忆/聊天文件按卡存（data/memory-export/<slug>.md、data/history-export/<slug>.md），
 * 同卡换绑定账号（QQ/微信）共享记忆不受影响——那是按卡文件天然成立的设计。
 */
export async function applyAgentMemoryScope(agentId: string, slug: string): Promise<void> {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let conf: Record<string, any>;
  try {
    conf = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch {
    return;
  }
  const files = [
    path.join(dataDir(), "memory-export", `${slug}.md`),
    path.join(dataDir(), "history-export", `${slug}.md`),
  ];
  conf.agents ??= {};
  conf.agents.list ??= [];
  // ① defaults 清空（全局检索池关闭，防止跨卡互搜；provider/store/query 等字段保留）
  conf.agents.defaults ??= {};
  if (conf.agents.defaults.memorySearch) {
    conf.agents.defaults.memorySearch.extraPaths = [];
  }
  // ② agent 级只指向本卡的两个 md
  const entry = (conf.agents.list as { id?: string; memorySearch?: unknown }[]).find((a) => a.id === agentId);
  const ms = { extraPaths: files };
  if (entry) entry.memorySearch = ms;
  else conf.agents.list.push({ id: agentId, memorySearch: ms });
  await fs.writeFile(cfgPath, JSON.stringify(conf, null, 2), "utf8");
}

/** 为所有绑定卡的 agent 应用检索隔离（启动/维护时调用，幂等） */
export async function applyAllAgentMemoryScopes(): Promise<number> {
  const bots = await listBots();
  for (const b of bots) {
    await applyAgentMemoryScope(b.agentId, b.cardSlug).catch(() => {});
  }
  return bots.length;
}

/**
 * 把「回复拆条」的 blockStreaming 配置写进 openclaw.json。
 * 【源码核证 2026-09-07】真正的语义拆条（换行必分 / 句号切分 / 括号外句号兜底）
 * 在通道插件补丁里做——OpenClaw 原生 chunker 的 sentence 断点是 ASCII 正则，
 * 中文 。！？ 不识别，只会按 maxChars 硬切词；微信插件硬编码 disableBlockStreaming:true
 * 也需补丁改 false。因此这里只负责：
 *   1. 把网关拆块参数调成「安全值」：不攒批（minChars 1）、不硬切（maxChars 500 兜底
 *      只防极端长行）、newline 优先按行自然断块，让插件收到的文本尽量是完整行；
 *   2. blockStreamingDefault "on" 开管线；QQ/微信账号级 streaming.mode "off"，
 *      否则 block 文本块被交给编辑式流式整条编辑、不分气泡；
 *   3. coalesce 调小（微信插件自带默认 200/3000 会把小段并回大块）。
 * 风格（chat/rich）与条数上限走侧车表 applyAgentSplitStyle + prompt 软约束，不再写全局数值。
 */
export async function applyAgentBlockStreaming(
  channel: string,
  accountId: string,
  cfg: { style?: "chat" | "rich"; enabled?: boolean }
): Promise<void> {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let conf: Record<string, any>;
  try {
    conf = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch {
    return; // 没有配置文件就不动（网关首启会生成）
  }
  const enabled = cfg?.enabled !== false;
  // 安全值（2026-09-07 v7）：插件侧做语义拆条，网关只负责完整送达
  const chunk = { minChars: 1, maxChars: 500, breakPreference: "newline" as const };
  conf.agents ??= {};
  conf.agents.defaults ??= {};
  conf.agents.defaults.blockStreamingDefault = enabled ? "on" : "off";
  conf.agents.defaults.blockStreamingChunk = chunk;
  // coalesce 调小：微信插件自带 blockStreamingCoalesceDefaults(200/3000)，不覆盖会被它并回大块
  conf.agents.defaults.blockStreamingCoalesce = { minChars: 1, maxChars: 500, idleMs: 250 };
  // qqbot / openclaw-weixin：编辑式流式必须 off，否则 block 文本块被吞（见函数头注释）
  if ((channel === "qqbot" || channel === "openclaw-weixin") && accountId) {
    conf.channels ??= {};
    conf.channels[channel] ??= {};
    conf.channels[channel].accounts ??= {};
    const acc = (conf.channels[channel].accounts[accountId] ??= {});
    // 整体覆盖 streaming 对象：顺带清掉旧版残留的死配置（微信 preview.chunk 只供 draft 流式）
    acc.streaming = { mode: "off", ...(enabled ? { block: { enabled: true } } : {}) };
  }
  await fs.writeFile(cfgPath, JSON.stringify(conf, null, 2), "utf8");
}

/**
 * 更新 agent 用的模型（`provider/model` 形式）。
 * 模型只在 `agents add --model` 时写过一次，卡片后来改了专属模型必须靠这里同步，
 * 否则通道端会一直用旧模型。返回 true 表示确实改动了配置。
 * openclaw.json 里 agent 的 model 字段可能是字符串（"p/m"，agents add 写入）
 * 也可能是对象（{ primary: "p/m" }，老代码写入）——两种都识别，写回时保持原形态。
 */
export async function applyAgentModel(agentId: string, model: string): Promise<boolean> {
  if (!model || !model.includes("/")) return false;
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch {
    return false;
  }
  cfg.agents ??= {};
  cfg.agents.list ??= [];
  const list = cfg.agents.list as { id?: string; model?: unknown }[];
  const entry = list.find((a) => a.id === agentId);
  const cur = entry?.model as string | { primary?: string } | undefined;
  const curPrimary = typeof cur === "string" ? cur : cur?.primary;
  if (curPrimary === model) return false; // 没变就别写盘（避免触发网关无谓的重载）
  if (entry) entry.model = typeof cur === "string" ? model : { primary: model };
  else list.push({ id: agentId, model: { primary: model } });
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  return true;
}

export async function removeBot(id: string): Promise<BotInstance | null> {
  const bots = await listBots();
  const idx = bots.findIndex((b) => b.id === id);
  if (idx < 0) return null;
  const [removed] = bots.splice(idx, 1);
  await saveBots(bots);
  return removed;
}

/** 改这个 bot 绑定的渠道账号 id（登录成功后用平台下发的真实 id 覆盖创建时的占位名） */
export async function updateBotAccount(id: string, accountId: string): Promise<BotInstance | null> {
  const bots = await listBots();
  const bot = bots.find((b) => b.id === id);
  if (!bot) return null;
  bot.accountId = accountId;
  await saveBots(bots);
  return bot;
}

// ============================================================
//  直写配置的绑定管理（2026-09-10）
//  换卡原来靠 openclaw CLI（agents add/unbind/delete），每条 CLI 冷启动 5-15s，
//  一次换卡十几秒。绑定本质只是 openclaw.json 里 bindings 数组的一个对象 +
//  agents.list 的一个条目，直接读写文件是毫秒级，且网关会重读配置。
//  CLI 仍保留作兜底（凭证登录等必须走 CLI 的场景）。
// ============================================================

function openclawConfigPath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

async function readOpenclawConfig(): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(openclawConfigPath(), "utf8"));
  } catch {
    return null; // 配置不存在（网关首启会生成）→ 交给调用方回退 CLI
  }
}

async function writeOpenclawConfig(cfg: Record<string, any>): Promise<void> {
  const p = openclawConfigPath();
  // 先写临时文件再改名：避免网关正好读到写了一半的配置
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, p);
}

/**
 * 建/更新 agents.list 里的 agent 条目（等价于 `openclaw agents add`，但不跑 CLI）。
 * workspace/model 会被更新；已存在的其它字段（humanDelay、memorySearch 等）保留。
 */
export async function upsertAgentEntry(opts: {
  agentId: string;
  workspace: string;
  model?: string;
}): Promise<boolean> {
  const cfg = await readOpenclawConfig();
  if (!cfg) return false;
  cfg.agents ??= {};
  cfg.agents.list ??= [];
  const list = cfg.agents.list as Record<string, any>[];
  const agentDir = path.join(os.homedir(), ".openclaw", "agents", opts.agentId, "agent");
  let entry = list.find((a) => a.id === opts.agentId);
  if (!entry) {
    entry = { id: opts.agentId, name: opts.agentId };
    list.push(entry);
  }
  entry.workspace = opts.workspace;
  entry.agentDir = agentDir;
  if (opts.model) {
    // model 字段两种形态都可能存在（CLI 写字符串，我们写 {primary}）——保持原形态
    if (typeof entry.model === "string") entry.model = opts.model;
    else entry.model = { primary: opts.model };
  }
  await writeOpenclawConfig(cfg);
  return true;
}

/**
 * 把 channel:accountId 的路由指到某个 agent（等价于 `agents add --bind` / `agents bind`）。
 * 同一个账号只能有一条路由：先删掉该账号的旧路由，再写新的（这就是"换卡"的本质动作）。
 * 返回被顶掉的旧 agentId（没有就返回 null），调用方据此清理旧会话。
 */
export async function bindAccountDirect(opts: {
  agentId: string;
  channel: string;
  accountId: string;
}): Promise<{ ok: boolean; previousAgentId: string | null }> {
  const cfg = await readOpenclawConfig();
  if (!cfg) return { ok: false, previousAgentId: null };
  const list: Record<string, any>[] = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  let previousAgentId: string | null = null;
  const kept = list.filter((b) => {
    const m = b?.match ?? {};
    const sameAccount = m.channel === opts.channel && m.accountId === opts.accountId;
    if (sameAccount && b.agentId && b.agentId !== opts.agentId) previousAgentId = String(b.agentId);
    return !sameAccount; // 该账号的旧路由一律移除（含指向同一 agent 的重复项）
  });
  kept.push({ type: "route", agentId: opts.agentId, match: { channel: opts.channel, accountId: opts.accountId } });
  cfg.bindings = kept;
  await writeOpenclawConfig(cfg);
  return { ok: true, previousAgentId };
}

/** 解除某个账号的路由（等价于 `agents unbind`） */
export async function unbindAccountDirect(channel: string, accountId: string): Promise<boolean> {
  const cfg = await readOpenclawConfig();
  if (!cfg) return false;
  const list: Record<string, any>[] = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  cfg.bindings = list.filter((b) => {
    const m = b?.match ?? {};
    return !(m.channel === channel && m.accountId === accountId);
  });
  await writeOpenclawConfig(cfg);
  return true;
}

/** 从 agents.list 移除 agent 条目（等价于 `agents delete`，但不删凭证/不跑 CLI） */
export async function removeAgentEntry(agentId: string): Promise<boolean> {
  const cfg = await readOpenclawConfig();
  if (!cfg) return false;
  const list: Record<string, any>[] = cfg.agents?.list ?? [];
  cfg.agents ??= {};
  cfg.agents.list = list.filter((a) => a.id !== agentId);
  // 顺带清掉指向它的路由，避免留下孤儿绑定
  if (Array.isArray(cfg.bindings)) {
    cfg.bindings = (cfg.bindings as Record<string, any>[]).filter((b) => b.agentId !== agentId);
  }
  await writeOpenclawConfig(cfg);
  return true;
}

/**
 * 清掉某个 agent 的会话记录。
 * 【这是"换卡后还是旧人格"的真正原因】：换卡只改了路由，但旧 agent 的 sessions 目录还在，
 * 同一个用户继续发消息时，网关沿用那条既有会话（连带旧人格的上下文），
 * 表现就是"网页显示换了卡，聊起来还是原来的人"。清掉会话即可让下一条消息开新会话。
 * 只删会话文件，不动凭证和 workspace。
 */
/**
 * 从 agent 会话链的【尾部】截掉若干轮对话（破甲被墙时把被拒绝的那轮摘掉，避免污染下一轮）。
 *
 * 为什么只能从尾部删：sessions/<id>.jsonl 是一条严格单链——每行的 parentId 指向上一行的 id，
 * 文件顺序 = 对话顺序。删中间某条会让它的子节点 parentId 指向不存在的 id，链就断了；
 * 从尾部截断则剩下的链依然完整（实测该文件分叉数 0、孤儿节点 0）。
 *
 * rounds = 要删掉的「assistant 回复」条数，每条连同它前面紧邻的 user 提问与 custom 标记行一起删。
 * 返回真正删掉的轮数；结构异常（有分叉）时返回 -1，由调用方退回「整会话清空」。
 */
export async function trimAgentSessionTail(agentId: string, rounds = 1): Promise<number> {
  if (!agentId || rounds < 1) return 0;
  const dir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
  const names = await fs.readdir(dir).catch(() => null);
  if (!names) return 0;
  // 只处理会话主文件（排除 trajectory / sessions.json）
  const files: { file: string; mtime: number }[] = [];
  for (const n of names) {
    if (!/^[0-9a-f-]{36}\.jsonl$/i.test(n)) continue;
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile()) files.push({ file: n, mtime: st.mtimeMs });
  }
  if (!files.length) return 0;
  files.sort((a, b) => b.mtime - a.mtime);
  const target = path.join(dir, files[0].file); // 最近活跃的那个会话
  const raw = await fs.readFile(target, "utf8").catch(() => "");
  const lines = raw.split("\n").filter(Boolean);
  const parsed: { raw: string; id?: string; parentId?: string; type?: string; role?: string }[] = [];
  for (const l of lines) {
    try {
      const j = JSON.parse(l) as { id?: string; parentId?: string; type?: string; message?: { role?: string } };
      parsed.push({ raw: l, id: j.id, parentId: j.parentId, type: j.type, role: j.message?.role });
    } catch {
      return -1; // 有坏行，不敢动
    }
  }
  // 安全校验：必须是严格单链（任一节点最多一个子节点），否则拒绝截断
  const childCount = new Map<string, number>();
  for (const p of parsed) if (p.parentId) childCount.set(p.parentId, (childCount.get(p.parentId) ?? 0) + 1);
  for (const [, n] of childCount) if (n > 1) return -1;

  let cut = parsed.length; // 保留到这个下标之前
  let done = 0;
  for (let r = 0; r < rounds; r++) {
    // 从尾部找最近的 assistant 消息
    let ai = -1;
    for (let i = cut - 1; i >= 0; i--) {
      if (parsed[i].type === "message" && parsed[i].role === "assistant") { ai = i; break; }
      // 尾部允许存在 custom 之类的非消息行，一起带走
      if (parsed[i].type === "message" && parsed[i].role === "user") break; // 只有提问没回复，也从这里切
    }
    if (ai < 0) {
      // 没有 assistant 了：看是否有落单的 user 提问
      let ui = -1;
      for (let i = cut - 1; i >= 0; i--) {
        if (parsed[i].type === "message" && parsed[i].role === "user") { ui = i; break; }
      }
      if (ui < 0) break;
      cut = ui;
      done++;
      continue;
    }
    // 往前吃掉这轮的 user 提问（以及夹在中间的 custom 行）
    let start = ai;
    for (let i = ai - 1; i >= 0; i--) {
      if (parsed[i].type === "message" && parsed[i].role === "user") { start = i; break; }
      if (parsed[i].type === "message" && parsed[i].role === "assistant") { start = ai; break; }
      start = i; // custom / 其它标记行，一并纳入
    }
    // 绝不删到头部元数据（session / model_change / thinking_level_change）
    const HEAD_TYPES = new Set(["session", "model_change", "thinking_level_change"]);
    while (start < parsed.length && HEAD_TYPES.has(String(parsed[start].type))) start++;
    if (start <= 0) break;
    cut = start;
    done++;
  }
  if (!done || cut >= parsed.length) return 0;
  const kept = parsed.slice(0, cut).map((p) => p.raw);
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  await fs.rename(tmp, target);
  // 同步 sessions.json 的时间戳，避免元数据与实际内容脱节
  const metaFile = path.join(dir, "sessions.json");
  try {
    const meta = JSON.parse(await fs.readFile(metaFile, "utf8")) as Record<string, any>;
    const now = Date.now();
    for (const k of Object.keys(meta)) {
      if (meta[k]?.sessionId && files[0].file.startsWith(String(meta[k].sessionId))) {
        meta[k].updatedAt = now;
        meta[k].lastInteractionAt = now;
      }
    }
    const mtmp = metaFile + ".tmp";
    await fs.writeFile(mtmp, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(mtmp, metaFile);
  } catch {
    // sessions.json 缺失/损坏不影响截断本身
  }
  return done;
}

export async function clearAgentSessions(agentId: string): Promise<number> {
  if (!agentId) return 0;
  const dir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
  let removed = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    // 会话数据：<uuid>.jsonl / .trajectory.jsonl / .trajectory-path.json / sessions.json
    if (!/\.jsonl$|^sessions\.json$|\.trajectory-path\.json$/.test(e.name)) continue;
    await fs.rm(path.join(dir, e.name), { force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
