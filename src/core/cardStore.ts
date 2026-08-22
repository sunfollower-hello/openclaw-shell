// 本地卡库：卡片以 persona.json 文件存储，版本快照放 versions/ 目录
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import type { PersonaCard } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从 import.meta.url 向上找项目根（含 package.json 的目录） */
export function findProjectRoot(startDir = __dirname): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("找不到项目根目录（package.json）");
    dir = parent;
  }
}

export function dataDir(): string {
  return process.env.OPENCLAW_SHELL_DATA ?? path.join(findProjectRoot(), "data");
}

export function cardsDir(): string {
  return path.join(dataDir(), "cards");
}

export interface CardMeta {
  slug: string;
  name: string;
  version: number;
  role: string;
  updated_at?: string;
  tags: string[];
  avatar?: string;
}

export class CardStore {
  constructor(private dir: string = cardsDir()) {}

  private cardPath(slug: string): string {
    return path.join(this.dir, slug, "persona.json");
  }

  private versionsDir(slug: string): string {
    return path.join(this.dir, slug, "versions");
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(card: PersonaCard): Promise<PersonaCard> {
    await this.ensure();
    // 版本快照：保存上一个版本
    const prev = await this.get(card.slug).catch(() => null);
    if (prev && prev.version !== card.version) {
      await fs.mkdir(this.versionsDir(card.slug), { recursive: true });
      await fs.writeFile(
        path.join(this.versionsDir(card.slug), `v${prev.version}.json`),
        JSON.stringify(prev, null, 2),
        "utf8"
      );
    }
    await fs.mkdir(path.dirname(this.cardPath(card.slug)), { recursive: true });
    await fs.writeFile(this.cardPath(card.slug), JSON.stringify(card, null, 2), "utf8");
    return card;
  }

  async get(slug: string): Promise<PersonaCard> {
    const raw = await fs.readFile(this.cardPath(slug), "utf8");
    return JSON.parse(raw) as PersonaCard;
  }

  async list(): Promise<CardMeta[]> {
    await this.ensure();
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    const metas: CardMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const card = await this.get(e.name);
        metas.push({
          slug: e.name,
          name: card.name,
          version: card.version,
          role: card.identity?.role ?? "friend",
          updated_at: card.updated_at,
          tags: card.identity?.tags ?? [],
          avatar: card.identity?.avatar || undefined,
        });
      } catch {
        // 目录损坏/未完成导入，跳过
      }
    }
    metas.sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? ""));
    return metas;
  }

  async remove(slug: string): Promise<void> {
    await fs.rm(path.join(this.dir, slug), { recursive: true, force: true });
  }
}

export function newCardId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
