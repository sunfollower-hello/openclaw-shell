// 媒体与临时文件巡检（2026-09-18，P1 体检结论落地）。
// retention.ts 只管设备命名空间里的聊天记录/记忆；这里管"没有任何人清理、会随使用无限增长"的媒体：
//   ① 通道生图落盘 gen-*（~/.openclaw/media/gen-<ts>.<ext>，QQ/微信补丁出图时写）→ 2 小时后删
//   ② 测试生图 data[/users/<id>]/images/_test/ → 7 天后删
//   ③ 表情通道副本孤儿（~/.openclaw/media/emojis[/u<8>/]，网页端删除/改名表情后留下的）→ 对账删除
//   ④ 导出 md（history-export / memory-export）→ 与 retention 同周期（15 天）后删
//   ⑤ 孤儿用户目录（data/users/<id> 不在注册表且 30 天无动静）→ 先 tar 备份再删
// 只动"可再生/副本/过期"性质的文件，绝不碰 conversation/memory 正文与注册表内设备的数据。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { baseDataDir, DEVICE_ID_RE } from "./dataRoot.js";
import { RETENTION_DAYS } from "./retention.js";
import { logInfo, logWarn } from "./logger.js";
import { safeEmojiName } from "./emojiStore.js";

const DAY = 24 * 3600 * 1000;

/** 网关媒体根（QQ/微信插件与通道生图的落盘点，服务器上 = /data/openclaw） */
function gatewayMediaDir(): string {
  return path.join(os.homedir(), ".openclaw", "media");
}

/** 递归取目录内最新文件的 mtime（空目录/不存在 → 0） */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  await walk(dir);
  return newest;
}

/** 删除目录里的过期文件（不递归）；返回删除数 */
async function deleteOldFiles(dir: string, maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fsp.rm(p, { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/** 用户命名空间列表（全局 data/users/ 下的 32 位 hex 目录） */
async function deviceUserDirs(): Promise<string[]> {
  const usersDir = path.join(baseDataDir(), "users");
  const list = await fsp.readdir(usersDir, { withFileTypes: true }).catch(() => []);
  return list.filter((e) => e.isDirectory() && DEVICE_ID_RE.test(e.name)).map((e) => e.name);
}

/** ① 通道生图残留：gen-* 发送后就没人用了，留 2 小时兜底（排查窗口）后删 */
async function sweepChannelGenFiles(): Promise<number> {
  const dir = gatewayMediaDir();
  const cutoff = Date.now() - 2 * 3600 * 1000;
  let removed = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !e.name.startsWith("gen-")) continue;
    const p = path.join(dir, e.name);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fsp.rm(p, { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/** ② 测试生图（「测试出图」按钮每次点都新增文件，且没有删除端点）→ 7 天滚动删 */
async function sweepTestImages(): Promise<number> {
  const base = baseDataDir();
  const targets = [path.join(base, "images", "_test")];
  for (const id of await deviceUserDirs()) {
    targets.push(path.join(base, "users", id, "images", "_test"));
  }
  let removed = 0;
  for (const t of targets) removed += await deleteOldFiles(t, 7 * DAY).catch(() => 0);
  return removed;
}

/** 从表情库文件取合法文件名词干集合（通道副本文件名 = safeEmojiName(名) + 源扩展名） */
async function emojiStems(libraryPath: string): Promise<Set<string> | null> {
  // 库文件不存在 → 无法对账，宁可不删（绝不能把正常池清空）
  if (!fs.existsSync(libraryPath)) return null;
  try {
    const j = JSON.parse(await fsp.readFile(libraryPath, "utf8")) as { emojis?: { name?: string }[] };
    return new Set((j.emojis ?? []).map((e) => safeEmojiName(String(e?.name ?? ""))).filter(Boolean));
  } catch {
    return null;
  }
}

/** ③ 对单个通道表情目录做孤儿对账：词干不在库里的文件删除 */
async function reconcileEmojiDir(dir: string, libraryPath: string): Promise<number> {
  const stems = await emojiStems(libraryPath);
  if (!stems) return 0;
  let removed = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf(".");
    const stem = dot > 0 ? e.name.slice(0, dot) : e.name;
    if (!stems.has(stem)) {
      await fsp.rm(path.join(dir, e.name), { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/** ③ 表情孤儿对账：全局池 + 各设备 u<前8位>/ 子目录（按前缀回找对应设备空间） */
async function reconcileEmojiOrphans(): Promise<number> {
  const emojisRoot = path.join(gatewayMediaDir(), "emojis");
  const base = baseDataDir();
  let removed = 0;
  removed += await reconcileEmojiDir(emojisRoot, path.join(base, "emojis", "library.json"));
  const usersDir = path.join(base, "users");
  const deviceDirs = await deviceUserDirs();
  for (const sub of await fsp.readdir(emojisRoot, { withFileTypes: true }).catch(() => [])) {
    if (!sub.isDirectory() || !/^u[0-9a-f]{8}$/.test(sub.name)) continue;
    const prefix = sub.name.slice(1);
    const dev = deviceDirs.find((id) => id.startsWith(prefix));
    if (!dev) continue; // 设备空间已不存在 → 交给孤儿目录回收统一处理
    removed += await reconcileEmojiDir(path.join(emojisRoot, sub.name), path.join(usersDir, dev, "emojis", "library.json"));
  }
  return removed;
}

/** ④ 导出 md（聊天原文导出/记忆导出）：老的导出随卡常驻刷新，卡没了/不活跃的留 15 天 */
async function sweepExports(): Promise<number> {
  const base = baseDataDir();
  const targets = [path.join(base, "history-export"), path.join(base, "memory-export")];
  for (const id of await deviceUserDirs()) {
    targets.push(path.join(base, "users", id, "history-export"), path.join(base, "users", id, "memory-export"));
  }
  let removed = 0;
  for (const t of targets) removed += await deleteOldFiles(t, RETENTION_DAYS * DAY).catch(() => 0);
  return removed;
}

/** ⑤ 孤儿用户目录回收：不在注册表且 30 天无任何文件动静 → 整包 tar 备份后删除 */
async function reclaimOrphanUserDirs(): Promise<number> {
  const base = baseDataDir();
  const usersDir = path.join(base, "users");
  const known = new Set<string>();
  try {
    const j = JSON.parse(await fsp.readFile(path.join(usersDir, "registry.json"), "utf8")) as {
      devices?: { id?: string }[];
    };
    for (const d of j.devices ?? []) if (d?.id) known.add(String(d.id));
  } catch {
    /* 注册表读不到 → 全部按未知处理，靠 30 天门槛 + 备份兜底 */
  }
  const orphans: string[] = [];
  for (const id of await deviceUserDirs()) {
    if (known.has(id)) continue;
    const age = Date.now() - (await newestMtimeMs(path.join(usersDir, id)));
    if (age > 30 * DAY) orphans.push(id);
  }
  if (!orphans.length) return 0;
  // 先整目录拷贝备份，备份成功才删（绝不裸删用户数据）。用 fsp.cp 而不是 tar：
  // Windows 的 GNU tar 会把 "C:\..." 当远程主机名（Cannot connect to C:），跨平台不可靠。
  const backupDir = path.join(path.dirname(base), "backups", `orphan-users-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`);
  try {
    await fsp.mkdir(backupDir, { recursive: true });
    for (const name of orphans) {
      await fsp.cp(path.join(usersDir, name), path.join(backupDir, name), { recursive: true });
    }
  } catch (e) {
    logWarn("清理", `孤儿用户目录备份失败，本次跳过删除（${orphans.length} 个）`, e);
    return 0;
  }
  for (const name of orphans) await fsp.rm(path.join(usersDir, name), { recursive: true, force: true }).catch(() => {});
  logInfo("清理", `已回收 ${orphans.length} 个孤儿用户目录（备份：${path.relative(base, backupDir)}）`);
  return orphans.length;
}

/** 巡检入口：启动 + 每 6 小时（与 retention 同节奏） */
export async function runMediaSweep(): Promise<void> {
  const gen = await sweepChannelGenFiles().catch(() => 0);
  const test = await sweepTestImages().catch(() => 0);
  const emoji = await reconcileEmojiOrphans().catch(() => 0);
  const exportsRemoved = await sweepExports().catch(() => 0);
  const dirs = await reclaimOrphanUserDirs().catch(() => 0);
  logInfo(
    "清理",
    `媒体巡检：通道生图残留 -${gen} · 测试生图 -${test} · 表情孤儿副本 -${emoji} · 过期导出 -${exportsRemoved} · 孤儿目录回收 ${dirs}`
  );
}
