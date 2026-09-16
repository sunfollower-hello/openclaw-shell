// 设备级隔离自测（Phase B）：模型 Key 命名空间 + agent 名设备前缀 + 本地语音/日志门槛。
// 不碰真实环境：测试前把 HOME 指到临时目录（openclaw.json 与 data/ 都在里面重建）。
//
// 跑法：node scripts/test-device-isolation.mjs   （需先 npm run build）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-isolation-"));
const openclawDir = path.join(tmp, ".openclaw");
const dataDir = path.join(tmp, "data");
fs.mkdirSync(openclawDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
// Node 在 Windows 上按 USERPROFILE 定位家目录；两条都设上，跨平台一致
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;
process.env.OPENCLAW_SHELL_DATA = dataDir;

// 管理员（运营者）既有的 openclaw.json：一个带明文 Key 的提供商 + 全局默认模型
const cfgPath = path.join(openclawDir, "openclaw.json");
const adminCfg = {
  models: { providers: { "Soul API": { baseUrl: "https://api.319274.xyz/v1", api: "openai-completions", apiKey: "sk-admin-secret", models: [{ id: "gpt-5", name: "gpt-5" }] } } },
  agents: { defaults: { model: { primary: "Soul API/gpt-5" } }, list: [] },
};
fs.writeFileSync(cfgPath, JSON.stringify(adminCfg, null, 2), "utf8");

const imp = (p) => import(pathToFileURL(path.join(root, "dist", p)).href);
const { runAsUser } = await imp("core/dataRoot.js");
const providers = await imp("core/providers.js");
const botStore = await imp("core/botStore.js");

const DEV_A = "aaaaaaaa111122223333444455556666";
const DEV_B = "bbbbbbbb111122223333444455556666";
const scope = (id) => ({ deviceId: id, root: path.join(dataDir, "users", id) });

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
const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));

console.log("\n[1] agent 名设备前缀（跨用户同名卡不撞车）");
const aId = runAsUser(scope(DEV_A), () => botStore.deviceAgentId("grandma"));
const bId = runAsUser(scope(DEV_B), () => botStore.deviceAgentId("grandma"));
const adminId = botStore.deviceAgentId("grandma");
check("设备 A 的 agent 名带自己的前缀", aId === "uaaaaaaaa-grandma", aId);
check("设备 B 的 agent 名与 A 不同", aId !== bId, `${aId} vs ${bId}`);
check("管理员保持原名（存量数据兼容）", adminId === "grandma", adminId);

console.log("\n[2] 设备不会继承管理员的 API Key（migrateFromOpenclaw 只在管理域跑）");
const devList = await runAsUser(scope(DEV_A), () => providers.listProviders(false));
check("设备侧看不到管理员的提供商", !devList.chat.some((p) => p.name === "Soul API" && p.apiKey), JSON.stringify(devList.chat.map((p) => p.name)));
check("设备侧没有任何管理员的 key", !JSON.stringify(devList).includes("sk-admin-secret"));

console.log("\n[3] 提供商写进 openclaw.json 时按设备命名空间隔离");
// 名字故意不用内置预设名（DeepSeek/硅基流动/OpenRouter 那种是默认停用的预设条目，
// 同名保存会被当成「编辑预设」而保持停用状态，测不到写入路径）
const SHARED = "同名的商";
const NS_A = `u${DEV_A.slice(0, 8)}-${SHARED}`;
const NS_B = `u${DEV_B.slice(0, 8)}-${SHARED}`;
await runAsUser(scope(DEV_A), () =>
  providers.saveProvider("chat", { name: SHARED, baseUrl: "https://a.example/v1", apiKey: "sk-dev-a", models: ["m-a"] })
);
const afterA = readCfg();
check("设备 A 的商写成了 u<8hex>-名字", Boolean(afterA.models.providers[NS_A]), Object.keys(afterA.models.providers).join(","));
check("设备 A 的 Key 是明文写进去的（网关要用）", afterA.models.providers[NS_A]?.apiKey === "sk-dev-a");
check("管理员的提供商原封不动", JSON.stringify(afterA.models.providers["Soul API"]) === JSON.stringify(adminCfg.models.providers["Soul API"]));
check("管理员的默认模型没被设备改掉", afterA.agents?.defaults?.model?.primary === "Soul API/gpt-5", JSON.stringify(afterA.agents?.defaults?.model));
check("设备保存不会创建全局 data/providers.json", !fs.existsSync(path.join(dataDir, "providers.json")));

// 设备 B 也加一个同名的商：两个 Key 必须各存各的（修之前是后写的直接覆盖，且会把管理员的清空）
await runAsUser(scope(DEV_B), () =>
  providers.saveProvider("chat", { name: SHARED, baseUrl: "https://b.example/v1", apiKey: "sk-dev-b", models: ["m-b"] })
);
const afterB = readCfg();
check("设备 A 的 Key 没被设备 B 覆盖", afterB.models.providers[NS_A]?.apiKey === "sk-dev-a", afterB.models.providers[NS_A]?.apiKey);
check("设备 B 的 Key 是自己的", afterB.models.providers[NS_B]?.apiKey === "sk-dev-b");

// 设备 A 删掉自己的商：只该清掉自己那条，管理员的与设备 B 的都要留着
await runAsUser(scope(DEV_A), () => providers.deleteProvider("chat", SHARED));
const afterDel = readCfg();
check("设备 A 删自己 → 自己的条目被清掉", !afterDel.models.providers[NS_A]);
check("设备 A 删自己 → 设备 B 的条目还在", Boolean(afterDel.models.providers[NS_B]));
check("设备 A 删自己 → 管理员的条目还在", Boolean(afterDel.models.providers["Soul API"]), JSON.stringify(Object.keys(afterDel.models.providers)));

// 管理员照旧写不带前缀的名字
await providers.saveProvider("chat", { name: "管理员新加的商", baseUrl: "https://admin.example/v1", apiKey: "sk-admin-2", models: ["m1"] });
const afterAdmin = readCfg();
check("管理员新增的商不带前缀", Boolean(afterAdmin.models.providers["管理员新加的商"]), Object.keys(afterAdmin.models.providers).join(","));
check("管理员写的时候没动别人命名空间里的条目", Boolean(afterAdmin.models.providers[NS_B]));

console.log("\n[4] 解析出的模型名对 agent 是网关里的真名（带前缀）");
const llmDev = await runAsUser(scope(DEV_B), () => providers.resolveChatLLM());
check("设备解析 → 带前缀的提供商名", llmDev?.provider === NS_B, JSON.stringify(llmDev));
const llmAdmin = await providers.resolveChatLLM();
check("管理员解析 → 原名", llmAdmin?.provider === "Soul API", JSON.stringify(llmAdmin));

console.log("\n[5] 设备数据落位在自己的命名空间里");
const devAProviders = path.join(dataDir, "users", DEV_A, "providers.json");
check("设备 A 的 providers.json 在自己的目录", fs.existsSync(devAProviders));
const devAJson = fs.readFileSync(devAProviders, "utf8");
check("设备 A 的配置文件里没有管理员的任何 Key", !devAJson.includes("sk-admin"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
