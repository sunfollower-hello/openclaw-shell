// 配置变更强提醒：每卡记录「上次生效的扮演配置 + 最近一次变更」。
// 风格/预设/条数改动后，网页 /api/chat 与通道 USER.md 都会强注入变更提醒，
// 对抗模型的上下文惯性（换风格后模型常按旧风格的句式/分段/描写习惯输出）。
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";
import type { PersonaCard } from "./schema.js";

export interface ConfigChange {
  what: string;
  from: string;
  to: string;
}

export interface ConfigState {
  style?: string;
  tier?: string;
  splitMin?: number;
  splitMax?: number;
  ts?: string;
  lastChange?: { at: string; changes: ConfigChange[] };
}

export function configStatePath(slug: string): string {
  return path.join(dataDir(), "cards", slug, "config-state.json");
}

export async function readConfigState(slug: string): Promise<ConfigState> {
  try {
    return JSON.parse(await fs.readFile(configStatePath(slug), "utf8")) as ConfigState;
  } catch {
    return {};
  }
}

async function writeConfigState(slug: string, s: ConfigState): Promise<void> {
  await fs.mkdir(path.dirname(configStatePath(slug)), { recursive: true });
  await fs.writeFile(configStatePath(slug), JSON.stringify(s, null, 2), "utf8");
}

export function styleLabel(style?: string): string {
  return style === "rich" ? "重描写" : "纯对话";
}

/** 保存卡后调用：对比旧配置，有变化则记录（供两端的强提醒注入） */
export async function recordConfigChange(card: PersonaCard): Promise<void> {
  const slug = card.slug;
  const prev = await readConfigState(slug);
  const cur = {
    style: card.presets?.style === "rich" ? "rich" : "chat",
    tier: card.presets?.tier ?? "",
    splitMin: Math.max(1, Math.min(7, Math.floor(card.chat?.split?.min ?? 1))),
    splitMax: Math.max(1, Math.min(7, Math.floor(card.chat?.split?.max ?? 7))),
  };
  const changes: ConfigChange[] = [];
  if (prev.style !== undefined && prev.style !== cur.style) {
    changes.push({ what: "回复风格", from: styleLabel(prev.style), to: styleLabel(cur.style) });
  }
  if (prev.splitMin !== undefined && (prev.splitMin !== cur.splitMin || prev.splitMax !== cur.splitMax)) {
    changes.push({
      what: "回复条数",
      from: `${prev.splitMin}~${prev.splitMax}`,
      to: `${cur.splitMin}~${cur.splitMax}`,
    });
  }
  if (prev.tier !== undefined && prev.tier !== cur.tier) {
    changes.push({ what: "预设档位", from: prev.tier || "（无）", to: cur.tier || "（无）" });
  }
  const lastChange = changes.length
    ? { at: new Date().toISOString(), changes }
    : prev.lastChange; // 无新变化保留旧提醒（直到下次变更覆盖）
  await writeConfigState(slug, { ...cur, ts: new Date().toISOString(), lastChange });
}

/** 生成强提醒文案（无变更返回空串） */
export function buildConfigChangeReminder(state: ConfigState): string {
  const changes = state?.lastChange?.changes;
  if (!changes || changes.length === 0) return "";
  const lines = changes.map((c) => `- ${c.what}：${c.from} → ${c.to}`);
  return (
    `【⚠️ 扮演配置变更提醒（必须立即执行，覆盖你之前的表达习惯）】\n` +
    `你的扮演配置最近发生了以下变更：\n${lines.join("\n")}\n` +
    `从本次回复开始严格按变更后的配置执行：不再沿用旧风格的句式、分段与描写习惯；` +
    `即使旧记忆、旧聊天记录里提到过旧的表达方式，也一律以新配置为准。`
  );
}

/** 通道 USER.md 用的配置段（当前配置 + 变更提醒，每轮注入） */
export function buildConfigSectionForUserMd(state: ConfigState): string {
  const lines: string[] = [];
  if (state?.style) {
    lines.push(`- 风格：${styleLabel(state.style)}`);
    lines.push(`- 回复条数：${state.splitMin ?? 1}~${state.splitMax ?? 7} 条`);
  }
  const reminder = buildConfigChangeReminder(state);
  const head = lines.length ? `\n\n### 当前扮演配置（以 SKILL.md 的规则为准）\n${lines.join("\n")}` : "";
  return reminder ? `${head}\n\n${reminder}` : head;
}
