// 渠道账号昵称（备注名）：让用户用自己起的名字认账号，底层仍按 accountId 路由。
// 存在项目侧 data/account-labels.json，不写 openclaw.json——改个备注不该触发网关重载，
// 也避免插件升级/重装时被覆盖；备份走项目 data 目录一起带走。
// 键为 `${channel}:${accountId}`，值为用户填的昵称（空串 = 没起名，前端回落显示 accountId）。
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export type LabelMap = Record<string, string>;

function labelsPath(): string {
  return path.join(dataDir(), "account-labels.json");
}

function keyOf(channel: string, accountId: string): string {
  return `${channel}:${accountId}`;
}

export async function loadAccountLabels(): Promise<LabelMap> {
  try {
    const raw = JSON.parse(await fs.readFile(labelsPath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: LabelMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** 取昵称（没起名返回空串，调用方自行回落 accountId） */
export async function getAccountLabel(channel: string, accountId: string): Promise<string> {
  const all = await loadAccountLabels();
  return all[keyOf(channel, accountId)] ?? "";
}

/** 设置/清空昵称（传空串 = 删除备注，恢复显示 accountId） */
export async function setAccountLabel(channel: string, accountId: string, label: string): Promise<LabelMap> {
  const all = await loadAccountLabels();
  const key = keyOf(channel, accountId);
  const name = String(label ?? "").trim().slice(0, 40);
  if (name) all[key] = name;
  else delete all[key];
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(labelsPath(), JSON.stringify(all, null, 2), "utf8");
  return all;
}

/** 账号被彻底删除时顺手清掉它的昵称，避免残留 */
export async function removeAccountLabel(channel: string, accountId: string): Promise<void> {
  await setAccountLabel(channel, accountId, "");
}

/** 显示名：昵称 > 渠道自带 name > accountId */
export function displayName(labels: LabelMap, channel: string, accountId: string, fallbackName?: string): string {
  return labels[keyOf(channel, accountId)] || fallbackName || accountId;
}
