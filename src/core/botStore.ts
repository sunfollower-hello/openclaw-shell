// 多机器人实例管理：一个实例 = 人设卡 × 渠道账号 × OpenClaw agent
// data/bots.json 持久化；每个 agent 的 workspace 编译到 data/agent-workspaces/<slug>/
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir } from "./cardStore.js";

// 用户拍板的限制：QQ 最多 5 个机器人（平台上限，个体开发者一号 5 个 AppID）、微信最多 1 个
export const MAX_QQ_BOTS = 5;
// 微信最多 1 个：一个微信号 = 一个机器人身份（插件支持多账号，但没有多微信号就没意义）
export const MAX_WEIXIN_BOTS = 1;

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

export async function addBot(input: {
  cardSlug: string;
  channel: BotChannel;
  accountId: string;
}): Promise<BotInstance> {
  const bots = await listBots();
  const qqCount = bots.filter((b) => b.channel === "qqbot").length;
  const wxCount = bots.filter((b) => b.channel === "openclaw-weixin").length;
  if (input.channel === "qqbot" && qqCount >= MAX_QQ_BOTS) {
    throw new Error(`QQ 机器人已达上限（${MAX_QQ_BOTS} 个）。想换别的卡，先在卡片上删除现有机器人。`);
  }
  if (input.channel === "openclaw-weixin" && wxCount >= MAX_WEIXIN_BOTS) {
    throw new Error(`微信机器人最多 ${MAX_WEIXIN_BOTS} 个（一个微信号只能当一个机器人）。`);
  }
  if (bots.some((b) => b.cardSlug === input.cardSlug)) {
    throw new Error("这张卡已经绑定了机器人（每卡一个）。先删除旧的再新建。");
  }
  if (bots.some((b) => b.channel === input.channel && b.accountId === input.accountId)) {
    throw new Error(`渠道账号 ${input.accountId} 已被其他机器人占用。`);
  }
  const bot: BotInstance = {
    id: "bot_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    cardSlug: input.cardSlug,
    channel: input.channel,
    accountId: input.accountId,
    agentId: input.cardSlug, // agent 名 = 卡 slug（openclaw agents 约束小写字母数字横线，slug 天然满足）
    createdAt: new Date().toISOString(),
  };
  bots.push(bot);
  await saveBots(bots);
  return bot;
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
