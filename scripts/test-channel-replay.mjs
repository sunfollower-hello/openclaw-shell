// 通道消息复刻自测（2026-09-17「App 没开就不复刻」修复的验收脚本）
//
// 验四件事：
//   [1] **App 一次都没打开**（不向设备命名空间发任何请求）时，服务端定时扫描也要把
//       QQ/微信里发生的对话复刻进该设备的数据（这是这次修复的核心）；
//   [2] 会话被重置（老文件改名成 .jsonl.reset.<ts> 归档）时，重置前那段没同步的消息
//       也要从归档里补回来，且不重复；
//   [3] /api/sync/pull 增量拉取：游标推进、第二次不多给；
//   [4] 跨设备不串（设备 B 拉不到设备 A 的记录），运营者全局空间也不被污染。
//
// 跑法：npm run build && node scripts/test-channel-replay.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-replay-"));
const dataDir = path.join(tmp, "data");
const sessionsDir = path.join(tmp, ".openclaw", "agents", "agentA", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "users"), { recursive: true });

const PORT = 17899;
const DEV_A = "aaaaaaaa111122223333444455556666";
const DEV_B = "bbbbbbbb111122223333444455556666";
const SLUG = "card-a";
const url = (p) => `http://127.0.0.1:${PORT}${p}`;

// 设备注册表：扫描器按它遍历设备命名空间（两台都在，B 什么都没绑）
const nowIso = new Date().toISOString();
fs.writeFileSync(
  path.join(dataDir, "users", "registry.json"),
  JSON.stringify({ devices: [{ id: DEV_A, createdAt: nowIso, lastSeen: nowIso }, { id: DEV_B, createdAt: nowIso, lastSeen: nowIso }] }, null, 2),
  "utf8"
);
// 设备 A：一张卡绑了 QQ 机器人（agent 名带设备前缀，与真实链路一致）
fs.mkdirSync(path.join(dataDir, "users", DEV_A), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "users", DEV_A, "bots.json"),
  JSON.stringify({ bots: [{ id: "bot_1", cardSlug: SLUG, channel: "qqbot", accountId: "acct1", agentId: "agentA", createdAt: nowIso }] }, null, 2),
  "utf8"
);

const t = (s) => new Date(Date.now() + s * 1000).toISOString();
const msgLine = (id, role, text, iso) =>
  JSON.stringify({ type: "message", id, parentId: `p_${id}`, timestamp: iso, message: { role, content: text } }) + "\n";
const writeSession = (sessionId, lines) => fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), lines.join(""), "utf8");
const writeIndex = (sessionId) =>
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [`agent:agentA:acct1:openid1`]: { sessionId, updatedAt: Date.now(), origin: { accountId: "acct1", from: "openid1", label: "openid1" } },
    }, null, 2),
    "utf8"
  );

// ---- 阶段 1：通道里聊了两句（App 关着） ----
writeSession("sess1", [msgLine("m1", "user", "通道第一句", t(-120)), msgLine("m2", "assistant", "通道回第一句", t(-110))]);
writeIndex("sess1");

const convFile = (dev, slug) => path.join(dataDir, "users", dev, "conversations", `${slug}.jsonl`);
const readContents = (dev, slug) => readEntries(dev, slug).map((e) => e.content);
const readEntries = (dev, slug) => {
  try {
    return fs
      .readFileSync(convFile(dev, slug), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待条件成立（最多 waitMs） */
async function until(fn, waitMs = 20000) {
  const end = Date.now() + waitMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(500);
  }
}

console.log(`\n临时目录：${tmp}`);
// 前置检查：端口上已经有实例在跑的话，本次测试的服务器起不来、请求会打到别人身上
// （表现为「什么都没同步」这种假失败）。宁可直接报错。
const busy = await fetch(url("/api/admin/me")).then(() => true).catch(() => false);
if (busy) {
  console.log(`  ✗ 端口 ${PORT} 已被占用：先停掉占用进程（netstat -ano | grep :${PORT}）再跑本测试\n`);
  process.exit(1);
}
const child = spawn(process.execPath, [path.join(root, "dist", "server.js")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOME: tmp,
    USERPROFILE: tmp,
    OPENCLAW_SHELL_DATA: dataDir,
    // 托管模式：只有 HOSTED_MODE 才启用设备命名空间隔离，本测试要验的正是设备空间
    OPENCLAW_SHELL_UI_USER: "admin",
    OPENCLAW_SHELL_UI_PASS: "test-pass",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += String(d)));
child.stderr.on("data", (d) => (serverLog += String(d)));

const stop = async () => {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(400);
};
process.on("exit", () => {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
});

try {
  const up = await until(async () => {
    try {
      const r = await fetch(url("/api/admin/me"));
      return r.ok;
    } catch {
      return false;
    }
  }, 30000);
  if (!up) throw new Error(`服务没起来：\n${serverLog.slice(-2000)}`);

  console.log("\n[1] App 没打开（设备一次请求都不发）时，服务端也要复刻通道消息");
  const got1 = await until(() => readContents(DEV_A, SLUG).length >= 2, 20000);
  check("设备 A 的记录里出现了通道对话（未发任何设备请求）", got1, JSON.stringify(readContents(DEV_A, SLUG)));
  check("内容与顺序正确", JSON.stringify(readContents(DEV_A, SLUG)) === JSON.stringify(["通道第一句", "通道回第一句"]), JSON.stringify(readContents(DEV_A, SLUG)));
  check("surface 标成 qq", readEntries(DEV_A, SLUG).every((e) => e.surface === "qq"), JSON.stringify(readEntries(DEV_A, SLUG).map((e) => e.surface)));
  check("运营者全局空间没被污染", !fs.existsSync(path.join(dataDir, "conversations", `${SLUG}.jsonl`)));
  check("游标落盘（水位 + 已知会话 id）", (() => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dataDir, "users", DEV_A, "memory", `${SLUG}.observe.json`), "utf8"));
      return Number(c.lastTs) > 0 && Array.isArray(c.known) && c.known.includes("sess1");
    } catch {
      return false;
    }
  })());

  console.log("\n[2] 会话被重置：重置前那段也要从归档里补回来，且不重复");
  // 重置前又聊了一轮（镜像还没看到），随后会话被重置：老文件改名成 .jsonl.reset.<ts>，
  // 新会话从一开始——现实中这正是「App 关着时最容易丢记录」的时刻
  writeSession("sess1", [
    msgLine("m1", "user", "通道第一句", t(-120)),
    msgLine("m2", "assistant", "通道回第一句", t(-110)),
    msgLine("m3", "user", "重置前最后一句", t(-40)),
    msgLine("m4", "assistant", "重置前回一句", t(-30)),
  ]);
  fs.renameSync(path.join(sessionsDir, "sess1.jsonl"), path.join(sessionsDir, `sess1.jsonl.reset.${new Date().toISOString().replace(/[:.]/g, "-")}`));
  // 新会话：一条普通回复 + 一条被拆成两段的回复（多行 assistant，网页端要拆回两个气泡）
  writeSession("sess2", [msgLine("m5", "user", "重置后第一句", t(-20)), msgLine("m6", "assistant", "重置后回一句\n第二段", t(-10))]);
  writeIndex("sess2");

  const expected = ["通道第一句", "通道回第一句", "重置前最后一句", "重置前回一句", "重置后第一句", "重置后回一句", "第二段"];
  const got2 = await until(() => readContents(DEV_A, SLUG).length >= expected.length, 25000);
  const contents2 = readContents(DEV_A, SLUG);
  check("归档里没同步过的那段补回来了", got2, JSON.stringify(contents2));
  check("整段内容与顺序完全正确（无重复、无缺失）", JSON.stringify(contents2) === JSON.stringify(expected), JSON.stringify(contents2));
  check("游标记住了新会话", (() => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dataDir, "users", DEV_A, "memory", `${SLUG}.observe.json`), "utf8"));
      return c.known.includes("sess1") && c.known.includes("sess2");
    } catch {
      return false;
    }
  })());

  console.log("\n[3] /api/sync/pull：App 打开时的增量拉取");
  const devFetch = (dev, body) =>
    fetch(url("/api/sync/pull"), { method: "POST", headers: { "Content-Type": "application/json", "X-Device-Id": dev }, body: JSON.stringify(body) }).then((r) => r.json());
  const p1 = await devFetch(DEV_A, { since: "" });
  check("返回本设备的记录", Array.isArray(p1.entries) && p1.entries.length >= expected.length, JSON.stringify(p1).slice(0, 300));
  check("条目带 slug（前端按卡落库）", (p1.entries ?? []).every((e) => e.slug === SLUG));
  check("带保留期起点 horizon（本地副本判断老消息是否已被策略清掉）", typeof p1.horizon === "string" && Number.isFinite(Date.parse(p1.horizon)), String(p1.horizon));
  check("保留天数透出", p1.retentionDays === 15, String(p1.retentionDays));
  const ids1 = new Set((p1.entries ?? []).map((e) => e.id));
  const p2 = await devFetch(DEV_A, { since: p1.cursor });
  const ids2 = (p2.entries ?? []).map((e) => e.id);
  check("第二次拉取不再重复给同一批消息", ids2.every((id) => ids1.has(id)), JSON.stringify(ids2));

  console.log("\n[4] 跨设备不串");
  const pb = await devFetch(DEV_B, { since: "" });
  check("设备 B 拉不到设备 A 的记录", (pb.entries ?? []).length === 0, JSON.stringify(pb).slice(0, 200));
  check("设备 B 没有被写进任何记录", !fs.existsSync(path.join(dataDir, "users", DEV_B, "conversations")));
} catch (e) {
  fail++;
  console.log(`\n  ✗ 异常：${e.message}`);
} finally {
  await stop();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(`临时目录（可删）：${tmp}\n`);
process.exit(fail ? 1 : 0);
