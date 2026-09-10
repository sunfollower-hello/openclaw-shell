// 把本项目各卡的记忆/聊天导出登记进 OpenClaw 的 memorySearch，让 QQ/微信 里的机器人能搜到
// 网页侧记忆与本地聊天（检索隔离版，2026-09-08）：
//   - 每个绑定卡的 agent 级 memorySearch.extraPaths 只指向本卡的 memory-export/history-export 两个 md
//     （跨卡互搜已关闭：defaults.extraPaths 清空，因为 OpenClaw 的 agent 级与 defaults 级是合并关系）
//   - provider:"none" = OpenClaw 显式纯关键词模式（SQLite FTS5 BM25 打分，索引不写向量，全程不碰 embedding）
//   - store.fts.tokenizer:"trigram"（中文友好：短词自动降级 LIKE 包含匹配）
// 用法：node scripts/setup-openclaw-memory.mjs  （幂等，可重复执行；改完跑 openclaw memory index --force 重建索引）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const exportDir = path.join(projectRoot, "data", "memory-export");
const historyDir = path.join(projectRoot, "data", "history-export");

const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.memorySearch ??= {};
const ms = cfg.agents.defaults.memorySearch;

// ① 全局检索池关闭（defaults.extraPaths 清空）
ms.extraPaths = [];

// 纯关键词（FTS-only）：provider:"none" 是唯一显式关闭 embedding 的特判值（"off"/删字段都会回落 openai 无 key 报错）
ms.provider = "none";
delete ms.model;
ms.store = { fts: { tokenizer: "trigram" }, vector: { enabled: false } };
ms.query = { hybrid: { vectorWeight: 0, textWeight: 1 } };

// ② 每个绑定卡的 agent 只搜本卡的两个 md（读 data/bots.json 配对）
cfg.agents.list ??= [];
try {
  const bots = JSON.parse(readFileSync(path.join(projectRoot, "data", "bots.json"), "utf8")).bots ?? [];
  for (const b of bots) {
    const files = [
      path.join(exportDir, `${b.cardSlug}.md`),
      path.join(historyDir, `${b.cardSlug}.md`),
    ];
    const entry = cfg.agents.list.find((a) => a.id === b.agentId);
    if (entry) entry.memorySearch = { extraPaths: files };
    else cfg.agents.list.push({ id: b.agentId, memorySearch: { extraPaths: files } });
  }
} catch (e) {
  console.log("⚠️ 读 data/bots.json 失败（没有绑定卡则跳过 agent 级配置）:", String(e));
}

writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
console.log("memorySearch.defaults =", JSON.stringify(ms, null, 1));
console.log("导出目录存在:", existsSync(exportDir) ? "是" : "否（server 启动后会自动生成）", "/", existsSync(historyDir) ? "是" : "否");
console.log("改完请重启网关并跑 openclaw memory index --force 重建索引（纯关键词同样需要 FTS 索引）");
