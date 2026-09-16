// 压测辅助：向 openclaw.json 批量添加/移除假 agent
// 用法: node scripts/loadtest-agents.mjs add 25   |   node scripts/loadtest-agents.mjs remove
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
const wsRoot = "D:\\ai_workspace\\openclaw-shell\\data\\agent-workspaces";
const cmd = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? 25);

const j = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
j.agents = j.agents ?? {};
j.agents.list = j.agents.list ?? [];
const have = new Set(j.agents.list.map((a) => a.id));

if (cmd === "add") {
  let added = 0;
  for (let i = 1; i <= n; i++) {
    const id = "loadtest-" + String(i).padStart(3, "0");
    if (have.has(id)) continue;
    const ws = path.join("data", "agent-workspaces", id);
    fs.mkdirSync(ws, { recursive: true });
    const ag = path.join(ws, "AGENTS.md");
    if (!fs.existsSync(ag)) fs.writeFileSync(ag, "# " + id + "\n压测用空 agent，无任何绑定。\n");
    j.agents.list.push({ id, workspace: path.join(wsRoot, id) });
    added++;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(j, null, 2));
  console.log(`新增 ${added} 个，agent 总数 ${j.agents.list.length}`);
} else if (cmd === "remove") {
  const before = j.agents.list.length;
  j.agents.list = j.agents.list.filter((a) => !a.id.startsWith("loadtest-"));
  fs.writeFileSync(cfgPath, JSON.stringify(j, null, 2));
  console.log(`移除 ${before - j.agents.list.length} 个，agent 总数 ${j.agents.list.length}`);
} else {
  console.log("用法: node scripts/loadtest-agents.mjs add 25 | remove");
}
