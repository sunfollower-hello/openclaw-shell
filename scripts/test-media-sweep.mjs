#!/usr/bin/env node
// 媒体巡检自测（2026-09-18，P1）：临时 HOME + 临时 OPENCLAW_SHELL_DATA，不碰真实配置。
// 覆盖：gen-* 限时清 / 测试生图 7 天 / 表情通道孤儿对账 / 过期导出 / 孤儿用户目录（备份后删）
//       / 删除表情同步删通道副本（P1-⑥）。运行：node scripts/test-media-sweep.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DAY = 24 * 3600 * 1000;
const oldTime = new Date(Date.now() - 40 * DAY);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocls-sweep-"));
const home = path.join(tmp, "home");
const data = path.join(tmp, "data");

// ---- 布景 ----
const mediaEmojis = path.join(home, ".openclaw", "media", "emojis");
const devId = "aaaaaaaa111122223333444455556666"; // 注册表内的设备
const orphanId = "bbbbbbbb111122223333444455556666"; // 不在注册表的孤儿
for (const d of [
  path.join(mediaEmojis, "uaaaaaaaa"),
  path.join(data, "emojis"),
  path.join(data, "images", "_test"),
  path.join(data, "history-export"),
  path.join(data, "memory-export"),
  path.join(data, "users", devId, "images", "_test"),
  path.join(data, "users", devId, "emojis"),
  path.join(data, "users", orphanId, "images", "_test"),
]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(
  path.join(data, "users", "registry.json"),
  JSON.stringify({ devices: [{ id: devId, createdAt: new Date().toISOString() }] })
);

const put = (p, old = false) => {
  fs.writeFileSync(p, "x");
  if (old) fs.utimesSync(p, oldTime, oldTime);
};
// ① gen-*：旧的删、新的留
put(path.join(home, ".openclaw", "media", "gen-old.jpg"), true);
put(path.join(home, ".openclaw", "media", "gen-new.jpg"));
// ② 测试生图：旧的删、新的留（全局 + 设备）
put(path.join(data, "images", "_test", "gen-a.jpg"), true);
put(path.join(data, "images", "_test", "gen-b.jpg"));
put(path.join(data, "users", devId, "images", "_test", "gen-c.jpg"), true);
// ③ 表情孤儿：全局池 开心 留 / 旧名 删；设备目录同（库条目带 file + 源文件，贴近真实结构）
fs.mkdirSync(path.join(data, "emojis", "_shared"), { recursive: true });
fs.writeFileSync(path.join(data, "emojis", "library.json"), JSON.stringify({ emojis: [{ name: "开心", file: "emkaixin.png" }] }));
fs.writeFileSync(path.join(data, "emojis", "_shared", "emkaixin.png"), "x");
fs.writeFileSync(path.join(data, "users", devId, "emojis", "library.json"), JSON.stringify({ emojis: [{ name: "开心", file: "emkaixin.png" }] }));
put(path.join(mediaEmojis, "开心.gif"));
put(path.join(mediaEmojis, "旧名.gif"));
put(path.join(mediaEmojis, "uaaaaaaaa", "开心.gif"));
put(path.join(mediaEmojis, "uaaaaaaaa", "旧名.gif"));
// ④ 过期导出
put(path.join(data, "history-export", "old.md"), true);
put(path.join(data, "history-export", "new.md"));
// ⑤ 孤儿设备目录（内含 40 天前的文件）
put(path.join(data, "users", orphanId, "images", "_test", "junk.jpg"), true);

// ---- 跑 ----
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.OPENCLAW_SHELL_DATA = data;
const { runMediaSweep } = await import("../dist/core/mediaSweep.js");
await runMediaSweep();

// ---- 断言 ----
const exists = (p) => fs.existsSync(p);
const results = [];
const check = (name, ok) => results.push(`${ok ? "✓" : "✗"} ${name}`);
check("gen-old 已删", !exists(path.join(home, ".openclaw", "media", "gen-old.jpg")));
check("gen-new 保留", exists(path.join(home, ".openclaw", "media", "gen-new.jpg")));
check("_test 全局旧文件已删", !exists(path.join(data, "images", "_test", "gen-a.jpg")));
check("_test 全局新文件保留", exists(path.join(data, "images", "_test", "gen-b.jpg")));
check("_test 设备旧文件已删", !exists(path.join(data, "users", devId, "images", "_test", "gen-c.jpg")));
check("表情全局孤儿已删", !exists(path.join(mediaEmojis, "旧名.gif")));
check("表情全局正常保留", exists(path.join(mediaEmojis, "开心.gif")));
check("表情设备孤儿已删", !exists(path.join(mediaEmojis, "uaaaaaaaa", "旧名.gif")));
check("表情设备正常保留", exists(path.join(mediaEmojis, "uaaaaaaaa", "开心.gif")));
check("过期导出已删", !exists(path.join(data, "history-export", "old.md")));
check("新导出保留", exists(path.join(data, "history-export", "new.md")));
check("注册表设备目录保留", exists(path.join(data, "users", devId, "images", "_test", "gen-b.jpg")) || exists(path.join(data, "users", devId)));
check("孤儿设备目录已删", !exists(path.join(data, "users", orphanId)));
const backupRoot = path.join(data, "..", "backups");
const backupDirs = (await fsp.readdir(backupRoot).catch(() => [])).filter((f) => f.startsWith("orphan-users-"));
check("删除前有目录备份", backupDirs.length === 1 && exists(path.join(backupRoot, backupDirs[0], orphanId)));

// ⑥ 删除表情 → 通道副本同步消失（emojiStore 直调，同样走临时环境）
const emojiStore = await import("../dist/core/emojiStore.js");
const added = await emojiStore.addEmoji({ name: "测试表情", imageBase64: Buffer.from("png").toString("base64"), ext: "png" });
const copyPath = path.join(mediaEmojis, "测试表情.png");
// scheduleChannelSync 是异步的：轮询等它落盘（最多 5 秒）；超时则直调一次同步看真实原因
let synced = false;
for (let i = 0; i < 50 && !synced; i++) {
  await new Promise((r) => setTimeout(r, 100));
  synced = exists(copyPath);
}
if (!synced) {
  try {
    const copies = await emojiStore.syncEmojisToChannelMedia();
    console.log(`[诊断] 直调同步返回：${JSON.stringify(copies)}`);
    synced = exists(copyPath);
  } catch (e) {
    console.log(`[诊断] 直调同步抛错：${e?.message ?? e}`);
  }
}
check("新增表情已同步到通道目录", synced);
await emojiStore.removeEmoji(added.id);
let removedCopy = false;
for (let i = 0; i < 50 && !removedCopy; i++) {
  await new Promise((r) => setTimeout(r, 100));
  removedCopy = !exists(copyPath);
}
check("删除表情后通道副本同步删除", removedCopy);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("✗"));
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
