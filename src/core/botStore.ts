// 多机器人实例管理：一个实例 = 人设卡 × 渠道账号 × OpenClaw agent
// data/bots.json 持久化；每个 agent 的 workspace 编译到 data/agent-workspaces/<slug>/
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

// 用户拍板的限制：同时最多 2 个机器人实例（减少服务器压力，两个渠道组合都能测到）
export const MAX_BOTS = 2;
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
  if (bots.length >= MAX_BOTS) {
    throw new Error(`机器人实例已达上限（${MAX_BOTS} 个）。想换别的卡，先在卡片上删除现有机器人。`);
  }
  if (bots.some((b) => b.cardSlug === input.cardSlug)) {
    throw new Error("这张卡已经绑定了机器人（每卡一个）。先删除旧的再新建。");
  }
  if (bots.some((b) => b.channel === input.channel && b.accountId === input.accountId)) {
    throw new Error(`渠道账号 ${input.accountId} 已被其他机器人占用。`);
  }
  if (input.channel === "openclaw-weixin" && bots.filter((b) => b.channel === "openclaw-weixin").length >= MAX_WEIXIN_BOTS) {
    throw new Error(`微信机器人最多 ${MAX_WEIXIN_BOTS} 个（一个微信号只能当一个机器人）。`);
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

export async function removeBot(id: string): Promise<BotInstance | null> {
  const bots = await listBots();
  const idx = bots.findIndex((b) => b.id === id);
  if (idx < 0) return null;
  const [removed] = bots.splice(idx, 1);
  await saveBots(bots);
  return removed;
}
