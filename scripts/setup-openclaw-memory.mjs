// 把本项目的记忆导出目录登记进 OpenClaw 的 memorySearch，让 QQ/微信 里的机器人能搜到网页侧记忆
// 方案（2026-08-24 已实测通过）：
//   - extraPaths 指向 data/memory-export（server 每次记忆变更自动重写 <slug>.md）
//   - 嵌入用本机 Ollama + nomic-embed-text（零 API key，向量+关键词混合检索）
// 前置：本机已装 Ollama 且已拉模型 →  ollama pull nomic-embed-text
// 用法：node scripts/setup-openclaw-memory.mjs  （幂等，可重复执行；改完重启网关生效）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const exportDir = path.join(projectRoot, "data", "memory-export");

const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.memorySearch ??= {};
const ms = cfg.agents.defaults.memorySearch;

// 导出目录（网页侧记忆 → md，供 memory_search 索引）
const arr = ms.extraPaths ?? [];
const cleaned = arr.filter((x) => typeof x === "string" && x.includes(path.sep) && x !== "");
if (!cleaned.includes(exportDir)) cleaned.push(exportDir);
ms.extraPaths = cleaned;

// 嵌入：本机 Ollama（无 key；nomic-embed-text 需先 ollama pull）
ms.provider = "ollama";
ms.model = "nomic-embed-text";
// 恢复向量/混合检索默认（去掉可能残留的禁用项）
delete ms.store;
delete ms.query;

writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
console.log("memorySearch =", JSON.stringify(ms, null, 1));
console.log("导出目录存在:", existsSync(exportDir) ? "是" : "否（server 启动后会自动生成）");
console.log("改完请重启网关（gateway）使配置生效，并跑 openclaw memory index --force --agent main 重建索引");
