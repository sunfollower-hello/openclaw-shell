// 多机器人 API 端到端测试（跑完自动清理）
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync("D:/ai_workspace/openclaw-shell/.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const auth = "Basic " + Buffer.from(`${env.OPENCLAW_SHELL_UI_USER}:${env.OPENCLAW_SHELL_UI_PASS}`).toString("base64");
const H = { "Content-Type": "application/json", Authorization: auth };
const base = "http://127.0.0.1:17880";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
};
const req = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// 0. 现状
const g0 = await req("GET", "/api/bots");
ok("GET /api/bots 初始", g0.status === 200 && Array.isArray(g0.data.bots), `bots=${g0.data.bots?.length}`);

// 1. 创建 QQ 机器人（奶奶卡）
const c1 = await req("POST", "/api/bots", { cardSlug: "persona-mt19uxkn", channel: "qqbot", accountId: "qq-test1" });
ok("创建 QQ bot（奶奶卡）", c1.status === 200 && c1.data.bot?.agentId === "persona-mt19uxkn",
  `model=${c1.data.model} files=${c1.data.compileFiles?.length} hint=${(c1.data.hint || "").slice(0, 20)}…`);
if (c1.status !== 200) console.log("  error:", JSON.stringify(c1.data).slice(0, 300));
const bot1 = c1.data.bot?.id;

// 2. workspace 编译产物检查
const soul = fs.readFileSync("D:/ai_workspace/openclaw-shell/data/agent-workspaces/persona-mt19uxkn/SOUL.md", "utf8");
ok("独立 workspace SOUL.md 已编译", soul.includes("SOUL.md"));

// 3. 创建微信机器人（前任卡）→ 应成功（1 QQ + 1 微信 = 2）
const c2 = await req("POST", "/api/bots", { cardSlug: "ex-2020", channel: "openclaw-weixin" });
ok("创建微信 bot（前任卡，账号默认 wx-main）", c2.status === 200 && c2.data.bot?.accountId === "wx-main");
const bot2 = c2.data.bot?.id;

// 4. 第三个 → 总数上限拦截
const c3 = await req("POST", "/api/bots", { cardSlug: "nope", channel: "qqbot" });
ok("第三个被总数上限拦截", c3.status === 400, (c3.data.error || "").slice(0, 40));

// 5. 同卡重复 → 拦截
const c4 = await req("POST", "/api/bots", { cardSlug: "persona-mt19uxkn", channel: "qqbot", accountId: "qq-test1b" });
ok("同卡重复绑定被拦截", c4.status === 400, (c4.data.error || "").slice(0, 30));

// 6. GET 带 agentExists
const g1 = await req("GET", "/api/bots");
ok("GET /api/bots 显示 agent 已创建", g1.data.bots?.length === 2 && g1.data.bots.every((b) => b.agentExists));
ok("limits 字段", g1.data.limits?.maxBots === 2 && g1.data.limits?.maxWeixin === 1);

// 7. 重编译
const r1 = await req("POST", `/api/bots/${bot1}/recompile`);
ok("重编译", r1.status === 200 && r1.data.files?.length > 0);

// 8. 扫码登录端点（只验证 GET 状态接口，不真启动扫码进程避免挂起）
const l0 = await req("GET", `/api/bots/${bot1}/login`);
ok("扫码状态接口（未启动时）", l0.status === 200 && l0.data.running === false);

// 9. 删除两个
const d1 = await req("DELETE", `/api/bots/${bot1}`);
ok("删除 bot1", d1.status === 200 && d1.data.ok);
const d2 = await req("DELETE", `/api/bots/${bot2}`);
ok("删除 bot2", d2.status === 200);

// 10. 恢复干净
const g2 = await req("GET", "/api/bots");
ok("清理完毕 bots=0", g2.data.bots?.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
