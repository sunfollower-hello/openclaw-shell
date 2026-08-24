// 插件商店：目录（精选/用户分享/付费）+ 购买记账 + 上传包管理
// data/plugin-market/catalog.json   商店目录（feeRate + plugins[]）
// data/plugin-market/sales.jsonl    购买流水（每行一笔）
// data/plugin-market/uploads/<id>/  用户上传的插件包（zip / 解压目录）
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export const DEFAULT_FEE_RATE = 0.2; // 全局手续费率（卖家实得 = 价格 × (1 - feeRate)）

export type PluginType = "curated" | "userShared" | "paid";
export const CATEGORIES = ["image", "tts", "memory", "game", "tool", "channel", "other"] as const;
export const CATEGORY_LABELS: Record<string, string> = {
  image: "生图", tts: "语音", memory: "记忆", game: "游戏", tool: "工具", channel: "通道", other: "其他",
};

export interface MarketPlugin {
  id: string;
  type: PluginType;
  pkg: string; // clawhub:<package> | "bundle"（本地上传包）
  name: string;
  descZh: string;
  category: string;
  source: string; // 提供者（"官方精选" / 分享者 / 卖家）
  price?: number; // 付费区：人民币定价
  sales?: number; // 销量
  zip?: string; // bundle 型：uploads/<id>/plugin.zip（相对 data/plugin-market 的路径）
  uploadedAt?: string;
}

interface Catalog {
  feeRate: number;
  plugins: MarketPlugin[];
}

function marketDir(): string {
  return path.join(dataDir(), "plugin-market");
}

// ---------- 默认精选：指向 ClawHub 真实存在的包（2026-08-24 实测可搜到） ----------
const DEFAULT_CURATED: Omit<MarketPlugin, "type">[] = [
  {
    id: "lobster-werewolf", pkg: "clawhub:@lobster-republic/lobster-werewolf", name: "龙虾狼人杀",
    descZh: "9 人 LLM 多智能体狼人杀：让角色们陪你玩一局（含法官/投票/遗言全流程）",
    category: "game", source: "官方精选",
  },
  {
    id: "clawnify-html-to-image", pkg: "clawhub:@clawnify/html-to-image", name: "HTML 转图片",
    descZh: "把 HTML/CSS 渲染成 PNG：做状态卡片、摘要图、小图表，可直接发到 QQ/微信",
    category: "tool", source: "官方精选",
  },
  {
    id: "edge-tts-for-oc", pkg: "clawhub:edge-tts-for-oc", name: "Edge TTS 语音回复",
    descZh: "让机器人用微软 Edge 语音（免费）朗读回复，中文多音色可选",
    category: "tts", source: "官方精选",
  },
  {
    id: "openclaw-memory-graph", pkg: "clawhub:openclaw-memory-graph", name: "记忆知识图谱",
    descZh: "把记忆整理成知识图谱（本地 SQLite 零配置），长对话也记得住人物关系",
    category: "memory", source: "官方精选",
  },
  {
    id: "png-to-pdf", pkg: "clawhub:png-to-pdf", name: "图片转 PDF",
    descZh: "多张图片合成一个 PDF，可调页面方向/边距/压缩比",
    category: "tool", source: "官方精选",
  },
];

export async function readCatalog(): Promise<Catalog> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(marketDir(), "catalog.json"), "utf8"));
    return { feeRate: raw.feeRate ?? DEFAULT_FEE_RATE, plugins: Array.isArray(raw.plugins) ? raw.plugins : [] };
  } catch {
    // 首次运行：写入默认精选
    const catalog: Catalog = {
      feeRate: DEFAULT_FEE_RATE,
      plugins: DEFAULT_CURATED.map((p) => ({ ...p, type: "curated" as PluginType, uploadedAt: new Date().toISOString() })),
    };
    await saveCatalog(catalog);
    return catalog;
  }
}

async function saveCatalog(catalog: Catalog): Promise<void> {
  await fs.mkdir(marketDir(), { recursive: true });
  await fs.writeFile(path.join(marketDir(), "catalog.json"), JSON.stringify(catalog, null, 2), "utf8");
}

export async function addMarketPlugin(p: MarketPlugin): Promise<void> {
  const c = await readCatalog();
  if (c.plugins.some((x) => x.id === p.id)) throw new Error("该插件已上架");
  c.plugins.push(p);
  await saveCatalog(c);
}

export async function removeMarketPlugin(id: string): Promise<void> {
  const c = await readCatalog();
  c.plugins = c.plugins.filter((p) => p.id !== id);
  await saveCatalog(c);
}

export async function getMarketPlugin(id: string): Promise<MarketPlugin | null> {
  return (await readCatalog()).plugins.find((p) => p.id === id) ?? null;
}

export function uploadDir(id: string): string {
  return path.join(marketDir(), "uploads", id);
}

/** 保存用户上传的 zip（base64）到 uploads/<id>/plugin.zip */
export async function saveUploadedZip(id: string, base64: string): Promise<string> {
  const dir = uploadDir(id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "plugin.zip");
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

// ---------- 购买记账 ----------
export interface SaleRecord {
  ts: string;
  pluginId: string;
  name: string;
  seller: string;
  price: number;
  fee: number;
  buyer: string;
}

export async function recordSale(r: Omit<SaleRecord, "ts">): Promise<void> {
  await fs.mkdir(marketDir(), { recursive: true });
  const rec: SaleRecord = { ...r, ts: new Date().toISOString() };
  await fs.appendFile(path.join(marketDir(), "sales.jsonl"), JSON.stringify(rec) + "\n", "utf8");
  const c = await readCatalog();
  const p = c.plugins.find((x) => x.id === r.pluginId);
  if (p) {
    p.sales = (p.sales ?? 0) + 1;
    await saveCatalog(c);
  }
}

export async function listSales(): Promise<SaleRecord[]> {
  try {
    const text = await fs.readFile(path.join(marketDir(), "sales.jsonl"), "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 卖家实得 / 手续费：价格按分取整 */
export function splitPrice(price: number, feeRate: number): { fee: number; sellerGets: number } {
  const fee = Math.round(price * feeRate * 100) / 100;
  return { fee, sellerGets: Math.round((price - fee) * 100) / 100 };
}
