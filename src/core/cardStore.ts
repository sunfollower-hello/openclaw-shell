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

/** slug 合法性：小写字母数字连字符。挡住 ../ 之类的路径穿越（slug 会被拼进文件路径） */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export class CardStore {
  constructor(private dir: string = cardsDir()) {}

  private cardPath(slug: string): string {
    if (!isValidSlug(slug)) throw new Error(`非法 slug: ${slug}`);
    return path.join(this.dir, slug, "persona.json");
  }

  /** 卡是否已存在（导入前查重用，避免静默覆盖别人辛苦做的卡） */
  async exists(slug: string): Promise<boolean> {
    if (!isValidSlug(slug)) return false;
    return existsSync(this.cardPath(slug));
  }

  /** 找一个没被占用的 slug：base、base-2、base-3… */
  async freeSlug(base: string): Promise<string> {
    const b = isValidSlug(base) ? base : `card-${Date.now().toString(36)}`;
    if (!(await this.exists(b))) return b;
    for (let i = 2; i < 1000; i++) {
      const cand = `${b}-${i}`;
      if (!(await this.exists(cand))) return cand;
    }
    return `${b}-${Date.now().toString(36)}`;
  }

  private versionsDir(slug: string): string {
    return path.join(this.dir, slug, "versions");
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(card: PersonaCard): Promise<PersonaCard> {
    await this.ensure();
    // 先落盘正式卡（这一步决定用户看到的"保存完成"快慢）
    const prev = await this.get(card.slug).catch(() => null);
    await fs.mkdir(path.dirname(this.cardPath(card.slug)), { recursive: true });
    await fs.writeFile(this.cardPath(card.slug), JSON.stringify(card, null, 2), "utf8");
    // 版本快照放到后台做，避免拖慢保存
    if (prev) {
      void (async () => {
        try {
          await fs.mkdir(this.versionsDir(card.slug), { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          // 快照不存头像：base64 头像能占到卡片的 99%（实测 1.28MB），
          // 10 份快照就是 13MB 垃圾。头像不是需要回溯的内容，回滚时沿用当前头像即可。
          const { avatar: _omit, ...identityRest } = prev.identity ?? ({} as PersonaCard["identity"]);
          const snapshot = { ...prev, identity: identityRest, _avatarOmitted: true };
          await fs.writeFile(
            path.join(this.versionsDir(card.slug), `v${prev.version}-${stamp}.json`),
            JSON.stringify(snapshot),
            "utf8"
          );
          await this.pruneVersions(card.slug);
        } catch {
          // 快照失败不影响正式保存
        }
      })();
    }
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

  /** 只保留最近 10 份快照，避免每次保存都堆文件 */
  private async pruneVersions(slug: string): Promise<void> {
    const dir = this.versionsDir(slug);
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 10))) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    }
  }

  async remove(slug: string): Promise<void> {
    if (!isValidSlug(slug)) throw new Error(`非法 slug: ${slug}`);
    await fs.rm(path.join(this.dir, slug), { recursive: true, force: true });
  }
}

export function newCardId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
