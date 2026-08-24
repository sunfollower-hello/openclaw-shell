// 本地服务：卡片 API + Web 编辑器
// 启动: npm run server  →  http://127.0.0.1:17880
import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CardStore, dataDir, newCardId, nowIso } from "./core/cardStore.js";
import { defaultCard, SCHEMA_VERSION, personaCardSchema, type PersonaCard } from "./core/schema.js";
import { validateCard } from "./core/validator.js";
import { compileCard } from "./core/compiler.js";
import { findProjectRoot } from "./core/cardStore.js";
import {
  runOpenclaw,
  stripAnsi,
  startChannelLogin,
  getChannelLoginState,
  portListening,
} from "./core/openclawCli.js";
import { getModelConfig, saveModelConfig, testModelEndpoint, getModelLLMConfig } from "./core/modelConfig.js";
import {
  listProviders,
  saveProvider,
  deleteProvider,
  renameProvider,
  fetchModels,
  resolveChatLLM,
} from "./core/providers.js";
import { runDistill, saveDistilledCard } from "./distiller/pipeline.js";
import { parsePlainText } from "./distiller/parser.js";
import { RELATION_ROLES } from "./core/schema.js";
import { buildChatSystem } from "./core/chatPrompt.js";
import { TOOL_REGISTRY, toolsToOpenAI, type ToolDef, type ToolCtx } from "./tools/registry.js";
import { SKILL_LIBRARY } from "./core/skills.js";
import { getMCPTools, loadMCPConfig, saveMCPConfig, reloadMCP } from "./tools/mcp.js";
import { cardToCCv2, ccv2ToCard } from "./core/cardConvert.js";
import { solidPng, pngWithText, extractCardJson } from "./core/png.js";
import { getImageConfig, saveImageConfig, maskKey, testNovelaiKey, testOpenAIImageKey } from "./core/imageConfig.js";
import {
  getTtsConfig,
  saveTtsConfig,
  maskKey as maskTtsKey,
  synthesize as synthesizeTts,
  testTts,
  listEdgeVoices,
  COMMON_EDGE_VOICES,
  TTS_KINDS,
  type TtsProvider,
} from "./core/ttsConfig.js";
import { recordUsage, getUsageSummary } from "./core/ttsUsage.js";
import {
  listBots,
  addBot,
  removeBot,
  agentWorkspaceDir,
  CHANNEL_LABELS,
  MAX_BOTS,
  MAX_WEIXIN_BOTS,
} from "./core/botStore.js";
import {
  recall,
  appendEntry,
  deleteEntry,
  updateEntry,
  clearMemory,
  readAllMemories,
  MEMORY_CATEGORIES,
  type MemEntry,
  type MemoryCategory,
} from "./core/memoryStore.js";

// 加载项目 .env（仅补环境变量空缺，如 OPENCLAW_SHELL_UI_USER/PASS）
async function loadEnv(): Promise<void> {
  try {
    const text = await fs.readFile(path.join(findProjectRoot(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // .env 不存在则跳过
  }
}

await loadEnv();

const PORT = Number(process.env.PORT ?? 17880);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = express();
app.use(express.json({ limit: "2mb" }));
const store = new CardStore();

// 公网暴露时启用 Basic 认证（设置 OPENCLAW_SHELL_UI_USER / OPENCLAW_SHELL_UI_PASS）
const UI_USER = process.env.OPENCLAW_SHELL_UI_USER;
const UI_PASS = process.env.OPENCLAW_SHELL_UI_PASS;
if (UI_USER && UI_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization ?? "";
    const [type, token] = auth.split(" ");
    if (type === "Basic" && token) {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : "";
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (user === UI_USER && pass === UI_PASS) return next();
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="openclaw-shell"');
    res.status(401).json({ error: "需要认证（OPENCLAW_SHELL_UI_USER / PASS）" });
  });
}

const projectRoot = findProjectRoot();
// 静态资源不缓存（版本号 query 也已加，双保险防旧 JS/CSS 残留）
app.use(express.static(path.join(projectRoot, "web"), { etag: true, maxAge: 0, setHeaders: (res) => {
  res.setHeader("Cache-Control", "no-cache");
} }));
// 表情包与生图产物（挂在认证之后，公网同样受 Basic 保护）
app.use("/emojis", express.static(path.join(dataDir(), "emojis")));
app.use("/img", express.static(path.join(dataDir(), "images")));
// 语音合成产物
app.use("/tts", express.static(path.join(dataDir(), "tts")));

// ---------- API ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "soulbox", schema: SCHEMA_VERSION, port: PORT, dataDir: dataDir() });
});

// ---------- 用户资料（抽屉头像/昵称，可编辑） ----------
const PROFILE_FILE = () => path.join(dataDir(), "user-profile.json");
app.get("/api/profile", async (_req, res) => {
  try {
    res.json(JSON.parse(await fs.readFile(PROFILE_FILE(), "utf8")));
  } catch {
    res.json({ name: "本地用户", avatar: "" });
  }
});
app.post("/api/profile", async (req, res) => {
  try {
    const { name, avatar } = req.body ?? {};
    const profile = {
      name: String(name ?? "").trim().slice(0, 40) || "本地用户",
      avatar: typeof avatar === "string" && avatar.startsWith("data:image/") && avatar.length < 1_500_000 ? avatar : "",
    };
    await fs.writeFile(PROFILE_FILE(), JSON.stringify(profile), "utf8");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 首页公告 ----------
const ANNOUNCEMENT_FILE = () => path.join(dataDir(), "announcement.json");
app.get("/api/announcement", async (_req, res) => {
  try {
    res.json(JSON.parse(await fs.readFile(ANNOUNCEMENT_FILE(), "utf8")));
  } catch {
    res.json({ text: "", updatedAt: "" });
  }
});
app.post("/api/announcement", async (req, res) => {
  try {
    const announcement = { text: String(req.body?.text ?? "").slice(0, 2000), updatedAt: nowIso() };
    await fs.writeFile(ANNOUNCEMENT_FILE(), JSON.stringify(announcement), "utf8");
    res.json({ ok: true, announcement });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/cards", async (_req, res) => {
  try {
    res.json({ cards: await store.list() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/cards/:slug", async (req, res) => {
  try {
    const card = await store.get(req.params.slug);
    res.json(card);
  } catch {
    res.status(404).json({ error: `卡片不存在: ${req.params.slug}` });
  }
});

app.post("/api/cards", async (req, res) => {
  try {
    const { name, slug, role } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "name 不能为空" });
    let finalSlug = slug;
    if (!finalSlug) {
      finalSlug = /^[a-z0-9][a-z0-9-]*$/.test(String(name).toLowerCase())
        ? String(name).toLowerCase()
        : `persona-${Date.now().toString(36)}`;
    }
    const card = defaultCard(String(name), finalSlug);
    card.id = newCardId();
    card.created_at = nowIso();
    card.updated_at = nowIso();
    if (role) card.identity.role = role;
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(card);
    res.status(201).json({ card });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.put("/api/cards/:slug", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (body.slug && body.slug !== req.params.slug) {
      return res.status(400).json({ error: "slug 不可通过编辑修改（先删除再新建）" });
    }
    body.slug = req.params.slug;
    body.updated_at = nowIso();
    const result = validateCard(body);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(body);
    res.json({ card: body, warnings: result.warnings });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/cards/:slug", async (req, res) => {
  try {
    await store.remove(req.params.slug);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/cards/:slug/compile", async (req, res) => {
  try {
    const card = await store.get(req.params.slug);
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    const out = await compileCard(card, path.join(dataDir(), "workspace"));
    res.json({ workspace: out.workspace, files: out.files, warnings: result.warnings });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 通道：微信 ----------
app.get("/api/channels/wechat/status", async (_req, res) => {
  try {
    const probe = await runOpenclaw(["channels", "status", "--probe"], { timeoutMs: 25000 });
    const text = stripAnsi(probe.stdout + probe.stderr);
    const connected = /weixin|wechat/i.test(text) && !/not logged|not connected|offline|error/i.test(text);
    res.json({ connected, raw: text.slice(-2000) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/channels/wechat/login", (_req, res) => {
  res.json(startChannelLogin("openclaw-weixin"));
});

app.get("/api/channels/wechat/login", (_req, res) => {
  res.json(getChannelLoginState("openclaw-weixin"));
});

app.get("/api/channels/wechat/pairing", async (_req, res) => {
  try {
    const r = await runOpenclaw(["pairing", "list", "openclaw-weixin"], { timeoutMs: 20000 });
    res.json({ raw: stripAnsi(r.stdout + r.stderr) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/channels/wechat/pairing/approve", async (req, res) => {
  try {
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: "缺少 code" });
    const r = await runOpenclaw(["pairing", "approve", "openclaw-weixin", String(code)], { timeoutMs: 20000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-1000) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 通道：QQ (官方开放平台 qqbot) ----------
app.get("/api/channels/qq/status", async (_req, res) => {
  try {
    const plugin = await runOpenclaw(["plugins", "list"], { timeoutMs: 25000 });
    const hasPlugin = /qqbot|napcat/i.test(plugin.stdout + plugin.stderr);
    const napcatRunning = await portListening(6099); // NapCat WebUI 默认端口（仅 napcat 方案用）
    const onebot = await runOpenclaw(["channels", "status", "--probe"], { timeoutMs: 25000 });
    const onebotText = stripAnsi(onebot.stdout + onebot.stderr);
    res.json({
      pluginInstalled: hasPlugin,
      napcatRunning,
      onebotSeen: /onebot|napcat/i.test(onebotText),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/channels/qq/login", (_req, res) => {
  res.json(startChannelLogin("qqbot"));
});

app.get("/api/channels/qq/login", (_req, res) => {
  res.json(getChannelLoginState("qqbot"));
});

app.post("/api/channels/qq/install-plugin", async (_req, res) => {
  try {
    const r = await runOpenclaw(["plugins", "install", "@hyl_aa/napcat"], { timeoutMs: 180000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-1500) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 多机器人：每卡一个独立 bot（卡 × 渠道账号 × OpenClaw agent） ----------
// agent 存活检测缓存：openclaw CLI 冷启动要 5-15s，不能每次开面板都现跑
let agentsListCache: { text: string; at: number } | null = null;
let agentsListInflight: Promise<{ text: string; ok: boolean }> | null = null;
const AGENTS_CACHE_MS = 60000;

async function getAgentsList(force = false): Promise<{ text: string; ok: boolean }> {
  if (!force && agentsListCache && Date.now() - agentsListCache.at < AGENTS_CACHE_MS) {
    return { text: agentsListCache.text, ok: true };
  }
  // 并发合并：多个请求同时来只跑一次 CLI（并行跑 openclaw 会互相拖慢到超时）
  if (agentsListInflight) return agentsListInflight;
  agentsListInflight = (async () => {
    const r = await runOpenclaw(["agents", "list"], { timeoutMs: 60000 });
    const text = stripAnsi(r.stdout + r.stderr);
    const ok = r.code === 0 && /Agents:|main/i.test(text);
    if (ok) agentsListCache = { text, at: Date.now() };
    return { text, ok };
  })();
  try {
    return await agentsListInflight;
  } finally {
    agentsListInflight = null;
  }
}

function invalidateAgentsCache(): void {
  agentsListCache = null;
}

app.get("/api/bots", async (req, res) => {
  try {
    const bots = await listBots();
    const limits = { maxBots: MAX_BOTS, maxWeixin: MAX_WEIXIN_BOTS };
    // 没有实例就不必查 agent 状态，省掉 CLI 冷启动
    if (bots.length === 0) return res.json({ bots: [], limits });
    // skipStatus=1：只要实例数据不查存活（前端开面板首屏用，秒回）
    if (req.query.skipStatus === "1") {
      return res.json({
        bots: bots.map((b) => ({ ...b, channelLabel: CHANNEL_LABELS[b.channel], agentExists: null })),
        limits,
      });
    }
    const { text: agentsText, ok: listOk } = await getAgentsList(req.query.refresh === "1");
    res.json({
      bots: bots.map((b) => ({
        ...b,
        channelLabel: CHANNEL_LABELS[b.channel],
        // CLI 跑挂/超时时输出不完整，不能断言"不存在"，返回 null 表示未知
        agentExists: listOk ? new RegExp(`^-\\s+${b.agentId}(\\s|$)`, "m").test(agentsText) : null,
      })),
      limits,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bots", async (req, res) => {
  try {
    const { cardSlug, channel, accountId } = req.body ?? {};
    if (channel !== "qqbot" && channel !== "openclaw-weixin") {
      return res.status(400).json({ error: "channel 必须是 qqbot 或 openclaw-weixin" });
    }
    const card = await store.get(String(cardSlug)).catch(() => null);
    if (!card) {
      return res.status(400).json({ error: `人设卡 ${cardSlug} 不存在` });
    }
    if (!/^[a-z0-9-]+$/i.test(card.slug)) {
      return res.status(400).json({ error: "卡 slug 不能用作 agent 名（仅字母数字横线）" });
    }
    const account = String(accountId ?? "").trim() || (channel === "qqbot" ? `qq-${Date.now().toString(36).slice(-4)}` : "wx-main");
    const bot = await addBot({ cardSlug: card.slug, channel, accountId: account });

    // ① 编译卡到该 agent 专属 workspace（每 agent 一份 SOUL.md，互不覆盖）
    // zod parse 补全默认字段，避免残缺卡（缺 voice 等）编译崩溃
    const compile = await compileCard(personaCardSchema.parse(card), agentWorkspaceDir(bot.cardSlug));

    // ② 解析模型：卡单独配置优先，否则默认提供商
    const llm = await resolveChatLLM(card);
    if (!llm) {
      await removeBot(bot.id);
      return res.status(400).json({ error: "没有可用模型（先在 API 页配置模型提供商）" });
    }

    // ③ 创建隔离 agent 并绑定渠道路由；若 agent 已存在（上次残留），退化为补绑定
    const add = await runOpenclaw(
      [
        "agents", "add", bot.agentId,
        "--workspace", agentWorkspaceDir(bot.cardSlug),
        "--model", `${llm.provider}/${llm.model}`,
        "--bind", `${bot.channel}:${bot.accountId}`,
        "--non-interactive", "--json",
      ],
      { timeoutMs: 60000 }
    );
    invalidateAgentsCache(); // agent 列表变了，缓存作废
    let addOutput = stripAnsi(add.stdout + add.stderr);
    if (add.code !== 0 && !/already exist|已存在/i.test(addOutput)) {
      await removeBot(bot.id);
      return res.status(500).json({ error: `创建 agent 失败：${addOutput.slice(-800)}` });
    }
    if (add.code !== 0) {
      const bind = await runOpenclaw(
        ["agents", "bind", "--agent", bot.agentId, "--bind", `${bot.channel}:${bot.accountId}`, "--json"],
        { timeoutMs: 30000 }
      );
      addOutput += "\n" + stripAnsi(bind.stdout + bind.stderr);
    }

    res.json({
      bot,
      compileFiles: compile.files,
      model: `${llm.provider}/${llm.model}`,
      output: addOutput.slice(-1500),
      hint: "agent 已创建并绑定路由。下一步点「扫码绑定」完成渠道账号登录；网关在跑的话重启后生效（桌面开关）。",
      agentExists: true, // 刚 add 成功，前端直接采信，不必再等 CLI 查一遍
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.post("/api/bots/:id/login", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    res.json(startChannelLogin(bot.channel, bot.accountId));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/bots/:id/login", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    res.json(getChannelLoginState(bot.channel, bot.accountId));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 卡片更新后重编译到该 agent 的 workspace
app.post("/api/bots/:id/recompile", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    const card = personaCardSchema.parse(await store.get(bot.cardSlug));
    const out = await compileCard(card, agentWorkspaceDir(bot.cardSlug));
    res.json({ ok: true, files: out.files, workspace: out.workspace });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/bots/:id", async (req, res) => {
  try {
    const bot = await removeBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    const del = await runOpenclaw(["agents", "delete", bot.agentId, "--force"], { timeoutMs: 60000 });
    invalidateAgentsCache();
    res.json({
      ok: true,
      output: stripAnsi(del.stdout + del.stderr).slice(-800),
      hint: "agent 已删除（workspace/state 进入回收站）。网关重启后路由完全移除。",
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 模型配置 ----------
app.get("/api/config/model", async (_req, res) => {
  try {
    res.json(await getModelConfig());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/config/model", async (req, res) => {
  try {
    const { name, baseUrl, apiKey, modelId, setDefault } = req.body ?? {};
    if (!name || !baseUrl || !modelId) {
      return res.status(400).json({ error: "name / baseUrl / modelId 不能为空" });
    }
    if (!/^[a-z0-9-]+$/i.test(String(name))) {
      return res.status(400).json({ error: "name 只能包含字母数字和连字符" });
    }
    await saveModelConfig({ name, baseUrl, apiKey, modelId, setDefault: !!setDefault });
    res.json({ ok: true, hint: "已保存。若 gateway 正在运行，重启后生效（可用桌面开关）" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/config/model/test", async (req, res) => {
  try {
    const { baseUrl, apiKey, modelId } = req.body ?? {};
    if (!baseUrl || !apiKey || !modelId) {
      return res.status(400).json({ error: "baseUrl / apiKey / modelId 不能为空" });
    }
    res.json(await testModelEndpoint(baseUrl, apiKey, modelId));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- API 提供商管理（对话 + 生图；第一个为默认，模型自动拉取） ----------
app.get("/api/providers", async (_req, res) => {
  try {
    const data = await listProviders(true);
    res.json({
      chat: data.chat.map((p, i) => ({ ...p, isDefault: i === 0 })),
      image: data.image.map((p, i) => ({ ...p, isDefault: i === 0 })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/providers/save", async (req, res) => {
  try {
    const { type, name, baseUrl, apiKey, models } = req.body ?? {};
    if (type !== "chat" && type !== "image") return res.status(400).json({ error: "type 必须是 chat 或 image" });
    const entry = await saveProvider(type, { name, baseUrl, apiKey, models });
    res.json({ ok: true, entry: { ...entry, apiKey: entry.apiKey.slice(0, 6) + "…" } });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.post("/api/providers/delete", async (req, res) => {
  try {
    const { type, name } = req.body ?? {};
    if ((type !== "chat" && type !== "image") || !name) return res.status(400).json({ error: "缺少 type / name" });
    await deleteProvider(type, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/providers/rename", async (req, res) => {
  try {
    const { type, oldName, newName } = req.body ?? {};
    if ((type !== "chat" && type !== "image") || !oldName || !newName) {
      return res.status(400).json({ error: "缺少 type / oldName / newName" });
    }
    await renameProvider(type, oldName, newName);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.post("/api/providers/fetch-models", async (req, res) => {
  try {
    const { baseUrl, apiKey, type, name } = req.body ?? {};
    let url = baseUrl;
    let key = apiKey;
    // 未直接给凭证时，按名称读取已保存的提供商
    if (!key && name) {
      const data = await listProviders(false);
      const p = ((type === "image" ? data.image : data.chat) as { name: string; baseUrl: string; apiKey: string }[]).find(
        (x) => x.name === name
      );
      if (!p) return res.status(404).json({ error: `找不到提供商 ${name}` });
      url = p.baseUrl;
      key = p.apiKey;
    }
    if (!url || !key) return res.status(400).json({ error: "缺少 baseUrl / apiKey（或 type + name）" });
    const models = await fetchModels(url, key);
    res.json({ models });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.post("/api/providers/set-default", async (req, res) => {
  try {
    const { type, name } = req.body ?? {};
    if ((type !== "chat" && type !== "image") || !name) return res.status(400).json({ error: "缺少 type / name" });
    const { moveProviderDefault } = await import("./core/providers.js");
    await moveProviderDefault(type, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------- 蒸馏工厂 ----------
app.post("/api/distill", async (req, res) => {
  try {
    const { fileContent, fileName, name, role, target, selfNames, blockedWords } = req.body ?? {};
    if (!fileContent || !name || !role) {
      return res.status(400).json({ error: "fileContent / name / role 不能为空" });
    }
    if (!RELATION_ROLES.includes(role)) {
      return res.status(400).json({ error: `无效角色: ${role}` });
    }
    const llm = await resolveChatLLM();
    if (!llm || !llm.apiKey) {
      return res.status(400).json({ error: "未配置模型 API。请先到「API」页添加提供商并设为默认" });
    }
    // fileContent 支持 WeFlow JSON 或「昵称: 内容」纯文本
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(fileContent);
    } catch {
      const msgs = parsePlainText(fileContent);
      if (msgs.length === 0) {
        return res.status(400).json({ error: "无法解析：既不是 JSON，也不是「昵称: 内容」格式的文本" });
      }
      rawJson = {
        messages: msgs.map((m) => ({ sender: m.sender, accountName: m.senderName, timestamp: m.ts, type: 0, content: m.text })),
      };
    }
    const result = await runDistill({
      rawJson,
      file: fileName,
      name,
      role,
      target: target ?? "",
      selfNames: Array.isArray(selfNames) ? selfNames : [],
      blockedWords: Array.isArray(blockedWords) ? blockedWords : [],
      llm,
    });
    res.json({ card: result.card, talkers: result.talkers, stats: result.stats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/cards/import", async (req, res) => {
  try {
    const card = req.body?.card;
    if (!card) return res.status(400).json({ error: "缺少 card" });
    // 解析补全默认字段后保存（做卡/导入的卡可能只填了部分字段）
    const parsed = personaCardSchema.safeParse(card);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const result = validateCard(parsed.data);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(parsed.data);
    res.json({ card: parsed.data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 角色卡导出 / 导入（PNG / JSON，CCv2 标准） ----------
async function buildCardExport(card: PersonaCard, format: string): Promise<{ filename: string; dataUrl: string }> {
  const cc = cardToCCv2(card);
  const json = JSON.stringify(cc, null, 2);
  if (format === "json") {
    return {
      filename: `${card.slug}.json`,
      dataUrl: "data:application/json;charset=utf-8," + encodeURIComponent(json),
    };
  }
  let png: Buffer;
  const avatar = card.identity.avatar;
  if (typeof avatar === "string" && avatar.startsWith("data:image/png;base64,")) {
    png = Buffer.from(avatar.split(",")[1], "base64");
  } else {
    png = solidPng(512, 512, [24, 26, 36, 255]);
  }
  const out = pngWithText(png, "chara", Buffer.from(json, "utf8").toString("base64"));
  return { filename: `${card.slug}.png`, dataUrl: "data:image/png;base64," + out.toString("base64") };
}

app.post("/api/cards/:slug/export", async (req, res) => {
  try {
    const card = await store.get(req.params.slug);
    const out = await buildCardExport(card, req.body?.format === "json" ? "json" : "png");
    res.json({ format: req.body?.format === "json" ? "json" : "png", ...out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 未入库的卡片直接导出（蒸馏结果一键出卡）
app.post("/api/cards/export-card", async (req, res) => {
  try {
    const card = req.body?.card;
    if (!card) return res.status(400).json({ error: "缺少 card" });
    const validated = validateCard(card);
    if (!validated.ok) return res.status(400).json({ error: validated.errors.join("; ") });
    const out = await buildCardExport(card as PersonaCard, req.body?.format === "json" ? "json" : "png");
    res.json({ format: req.body?.format === "json" ? "json" : "png", ...out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/cards/import-card", async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body ?? {};
    if (!fileBase64) return res.status(400).json({ error: "缺少文件内容" });
    const buf = Buffer.from(fileBase64, "base64");
    let cc: unknown;
    if (/\.png$/i.test(String(fileName ?? ""))) {
      cc = extractCardJson(buf);
      if (!cc) return res.status(400).json({ error: "PNG 里未找到角色卡数据（chara 块）" });
    } else {
      cc = JSON.parse(buf.toString("utf8"));
    }
    const avatar = /\.png$/i.test(String(fileName ?? "")) ? "data:image/png;base64," + buf.toString("base64") : undefined;
    const card = ccv2ToCard(cc, avatar);
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(card);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- WeFlow 本机直连（尽力集成，失败则用指引） ----------
const WEFLOW_BASE = "http://127.0.0.1:5031";

app.post("/api/weflow/probe", async (req, res) => {
  const token = req.body?.token ?? "";
  const candidates = ["/api/v1/talkers", "/api/v1/conversations", "/api/v1/chats", "/api/v1/contacts"];
  const results: { path: string; status: number; hint: string }[] = [];
  for (const p of candidates) {
    try {
      const r = await fetch(`${WEFLOW_BASE}${p}?access_token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await r.text().catch(() => "");
      results.push({ path: p, status: r.status, hint: body.slice(0, 120) });
    } catch (e) {
      results.push({ path: p, status: 0, hint: String(e).slice(0, 120) });
    }
  }
  res.json({ base: WEFLOW_BASE, results });
});

app.post("/api/distill/weflow", async (req, res) => {
  try {
    const { token, talker, limit, name, role, target, selfNames, blockedWords } = req.body ?? {};
    if (!token || !talker || !name || !role) {
      return res.status(400).json({ error: "token / talker / name / role 不能为空" });
    }
    const llm = await resolveChatLLM();
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
    const url = `${WEFLOW_BASE}/api/v1/messages?access_token=${encodeURIComponent(token)}&talker=${encodeURIComponent(talker)}&limit=${Number(limit) || 500}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return res.status(502).json({ error: `WeFlow 返回 ${r.status}，请确认 WeFlow 已启动且 token 正确` });
    const data = await r.json();
    const result = await runDistill({
      rawJson: data,
      file: `weflow:${talker}`,
      name,
      role,
      target: target ?? "",
      selfNames: Array.isArray(selfNames) ? selfNames : [],
      blockedWords: Array.isArray(blockedWords) ? blockedWords : [],
      llm,
    });
    res.json({ card: result.card, talkers: result.talkers, stats: result.stats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 聊天测试（人设 + 工具 + 技能 + 记忆 + 思考深度 + ask 审批） ----------
async function chatCompletions(
  llm: { baseUrl: string; apiKey: string; model: string },
  messages: unknown[],
  tools?: unknown[],
  reasoning?: string
): Promise<{ choices?: { message?: { content?: string; tool_calls?: unknown[] } }[] }> {
  const doCall = async (effort?: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const r = await fetch(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages,
          temperature: 0.7,
          max_tokens: 2048,
          ...(tools && tools.length ? { tools } : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`模型调用失败 ${r.status}: ${body.slice(0, 200)}`);
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await doCall(reasoning);
  } catch (e) {
    // 极高(xhigh)不被中转支持（如 Agnes 只收 low/medium/high）时自动降为 high
    if (reasoning === "xhigh" && e instanceof Error && /reasoning_effort/i.test(e.message) && e.message.includes("400")) {
      return await doCall("high");
    }
    throw e;
  }
}

interface ToolCallMsg {
  id?: string;
  function?: { name?: string; arguments?: string };
}

async function executeToolCalls(tools: ToolDef[], toolCalls: ToolCallMsg[], messages: unknown[], ctx: ToolCtx): Promise<void> {
  for (const tc of toolCalls) {
    const def = tools.find((t) => t.id === tc.function?.name);
    let result = `未知工具: ${tc.function?.name ?? "?"}`;
    if (def) {
      try {
        result = await def.run(JSON.parse(tc.function?.arguments || "{}"), ctx);
      } catch (e) {
        result = `工具执行出错: ${String(e)}`;
      }
    }
    messages.push({ role: "tool", tool_call_id: tc.id ?? "", content: result });
  }
}

type LoopResult =
  | { type: "reply"; reply: string }
  | { type: "pending"; pending: { id: string; name: string; args: string }[]; messages: unknown[] };

async function runToolLoop(
  llm: { baseUrl: string; apiKey: string; model: string },
  messages: unknown[],
  tools: ToolDef[],
  ctx: ToolCtx,
  askAll: boolean,
  reasoning?: string
): Promise<LoopResult> {
  for (let i = 0; i < 4; i++) {
    const data = await chatCompletions(llm, messages, tools.length ? toolsToOpenAI(tools) : undefined, reasoning);
    const msg = data.choices?.[0]?.message;
    const toolCalls = ((msg?.tool_calls ?? []) as ToolCallMsg[]).filter((tc) => tc.function?.name);
    if (toolCalls.length === 0) return { type: "reply", reply: msg?.content ?? "（空回复）" };
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: toolCalls });
    const hasDangerous = toolCalls.some((tc) => tools.find((t) => t.id === tc.function?.name)?.dangerous);
    if (askAll || hasDangerous) {
      return {
        type: "pending",
        pending: toolCalls.map((tc) => ({
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          args: tc.function?.arguments ?? "{}",
        })),
        messages,
      };
    }
    await executeToolCalls(tools, toolCalls, messages, ctx);
  }
  return { type: "reply", reply: "（达到工具轮次上限）" };
}

async function resolveChatTools(enabledTools: string[], useMCP: boolean): Promise<{ defs: ToolDef[]; mcpErrors: string[] }> {
  const defs = TOOL_REGISTRY.filter((t) => enabledTools.includes(t.id));
  let mcpErrors: string[] = [];
  if (useMCP) {
    const m = await getMCPTools();
    defs.push(...m.tools);
    mcpErrors = m.errors;
  }
  return { defs, mcpErrors };
}

function chatCtx(slug: string): ToolCtx {
  return {
    slug,
    sandboxDir: path.join(dataDir(), "sandbox", slug),
    memoryPath: path.join(dataDir(), "memory", `${slug}.mem`),
    imagesDir: path.join(dataDir(), "images", slug),
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    const { slug, message, history, tools, skills, thinking, useMCP } = req.body ?? {};
    if (!slug || !message) return res.status(400).json({ error: "slug / message 不能为空" });
    const card = await store.get(slug);
    const llm = await resolveChatLLM(card);
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
    const enabledTools = Array.isArray(tools) ? (tools as string[]) : [];
    const { defs: toolDefs, mcpErrors } = await resolveChatTools(enabledTools, useMCP === true);

    const skillPrompts = (Array.isArray(skills) ? (skills as string[]) : [])
      .map((id) => SKILL_LIBRARY.find((s) => s.id === id)?.prompt)
      .filter(Boolean) as string[];

    // 相关召回：按关键词重合 + 新鲜度取与当前话题最相关的记忆（最多 30 条）
    const memories = await recall(slug, message, 30).catch(() => []);
    const memoryBlock = memories.length
      ? `\n\n【长期记忆（关于用户的事实，仅在相关时使用；要新增事实时调用 memory_save 工具）】\n- ${memories
          .map((m) => `[${m.cat}] ${m.fact}`)
          .join("\n- ")}`
      : "";

    // 思考档位：关闭/自动 → 不传（由模型默认）；低/中/高/极高 → reasoning_effort（对齐 rikkahub：极高=xhigh）
    const level = String(thinking ?? card.chat?.thinking ?? "auto");
    const reasoning =
      level === "low"
        ? "low"
        : level === "medium"
          ? "medium"
          : level === "high"
            ? "high"
            : level === "extreme"
              ? "xhigh"
              : undefined;
    let system =
      buildChatSystem(card) +
      (toolDefs.length
        ? "\n\n你可以使用工具完成任务（写代码/沙箱文件/搜索/天气/时间/记忆/生图）。用户请求适合用工具完成时，调用工具而不是凭空编造；危险工具会先征得用户同意。"
        : "") +
      skillPrompts.map((p) => "\n" + p).join("") +
      memoryBlock +
      (mcpErrors.length ? `\n\n（MCP 连接提示：${mcpErrors.join("；")}）` : "");

    // 表情包注入（关闭档不注入）
    const emojis = card.emojis ?? [];
    const emojiLevel = card.voice?.message_style?.emoji ?? "克制";
    if (emojis.length > 0 && emojiLevel !== "关闭") {
      const emojiLines = emojis
        .slice(0, 120)
        .map((e) => `- ${e.name}：${e.explanation || "（无解释）"}`)
        .join("\n");
      const usage =
        emojiLevel === "贴近原始" ? "尽量在合适位置使用" : emojiLevel === "克制" ? "偶尔在合适位置使用" : "少量使用";
      system +=
        `\n\n【表情包】你可以使用以下自定义表情包，${usage}。在回复中插入 [表情:名字] 标记（前端会渲染成图片），不要编造不存在的表情名字：\n` +
        emojiLines;
    }

    const messages: unknown[] = [
      { role: "system", content: system },
      ...(Array.isArray(history) ? history.slice(-20) : []),
      { role: "user", content: message },
    ];
    const result = await runToolLoop(llm, messages, toolDefs, chatCtx(slug), card.tools?.policy === "ask", reasoning);
    if (result.type === "reply") {
      // 每 N 轮自动总结记忆（后台执行，不阻塞回复）
      void autoMemorize(slug, card, messages).catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 每 N 轮自动记忆（参考 rphub 群聊定期总结思路） ----------
async function autoMemorize(slug: string, card: { memoryConfig?: { auto_rounds?: number } }, messages: unknown[]): Promise<void> {
  const rounds = card.memoryConfig?.auto_rounds ?? 20;
  if (!rounds || rounds < 1) return;
  const ctx = chatCtx(slug);
  const countFile = ctx.memoryPath + ".count";
  let count = Number(await fs.readFile(countFile, "utf8").catch(() => "0")) || 0;
  count++;
  if (count < rounds) {
    await fs.writeFile(countFile, String(count), "utf8");
    return;
  }
  await fs.writeFile(countFile, "0", "utf8");
  const llm = await resolveChatLLM(card as never);
  if (!llm?.apiKey) return;
  // 已记住的只带最近 100 条给 LLM，避免 token 随文件膨胀
  const existing = (await readAllMemories().then((m) => m[slug] ?? []).catch(() => []))
    .slice(-100)
    .map((e) => `- [${e.cat}] ${e.fact}`)
    .join("\n");
  const recent = messages
    .filter((m) => {
      const role = (m as { role?: string }).role;
      return role === "user" || role === "assistant";
    })
    .slice(-(rounds * 2))
    .map((m) => {
      const r = m as { role?: string; content?: string };
      return `${r.role === "user" ? "用户" : "角色"}: ${String(r.content ?? "").slice(0, 500)}`;
    })
    .join("\n");
  if (!recent.trim()) return;
  try {
    const r = await fetch(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          {
            role: "system",
            content:
              "你是记忆提取器。从下面的对话中提取【值得长期记住的用户事实】（名字/住址/喜好/重要事件/关系等），给每条打分类标签：" +
              `分类只能是：${MEMORY_CATEGORIES.join("/")}。已经记住的不要重复；没有新事实就返回空数组。` +
              "输出严格 JSON 数组，每项是 {fact: 事实文本, cat: 分类}，不要任何其他文字。",
          },
          { role: "user", content: `已记住的事实：\n${existing || "（无）"}\n\n最近对话：\n${recent}` },
        ],
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) return;
    const data = await r.json();
    const text = String(data.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) return;
    const facts = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(facts) || facts.length === 0) return;
    const items = facts
      .map((f) => {
        const o = f as { fact?: unknown; cat?: unknown };
        const fact = typeof o.fact === "string" ? o.fact.trim() : "";
        const cat = (MEMORY_CATEGORIES as readonly string[]).includes(String(o.cat ?? ""))
          ? (o.cat as MemoryCategory)
          : "信息";
        return fact ? { fact, cat } : null;
      })
      .filter((x): x is { fact: string; cat: MemoryCategory } => x !== null)
      .slice(0, 10);
    if (!items.length) return;
    for (const it of items) {
      await appendEntry(slug, { fact: it.fact, cat: it.cat, src: "auto" }).catch(() => {});
    }
  } catch {
    /* 自动记忆失败不影响聊天 */
  }
}

app.post("/api/chat/approve", async (req, res) => {
  try {
    const { slug, messages, approve, tools, useMCP } = req.body ?? {};
    if (!slug || !Array.isArray(messages)) return res.status(400).json({ error: "slug / messages 不能为空" });
    const llm = await resolveChatLLM();
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
    const card = await store.get(slug);
    const enabledTools = Array.isArray(tools) ? (tools as string[]) : [];
    const { defs: toolDefs } = await resolveChatTools(enabledTools, useMCP === true);
    const last = messages[messages.length - 1] as { tool_calls?: ToolCallMsg[] };
    const toolCalls = (last?.tool_calls ?? []).filter((tc) => tc.function?.name);
    if (approve) {
      await executeToolCalls(toolDefs, toolCalls, messages, chatCtx(slug));
    } else {
      for (const tc of toolCalls) {
        messages.push({ role: "tool", tool_call_id: tc.id ?? "", content: "用户拒绝执行此工具调用" });
      }
    }
    const result = await runToolLoop(llm, messages, toolDefs, chatCtx(slug), card.tools?.policy === "ask");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- MCP 配置 ----------
app.get("/api/mcp/config", async (_req, res) => {
  try {
    res.json(await loadMCPConfig());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/mcp/config", async (req, res) => {
  try {
    const servers = req.body?.servers;
    if (!Array.isArray(servers)) return res.status(400).json({ error: "servers 必须是数组" });
    const clean = servers
      .filter((s) => s && typeof s.name === "string" && typeof s.command === "string")
      .map((s) => ({ name: s.name, command: s.command, args: Array.isArray(s.args) ? s.args : [] }));
    await saveMCPConfig({ servers: clean });
    await reloadMCP();
    res.json({ ok: true, servers: clean.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 当前生效人设（最后编译进 workspace 的卡片） ----------
app.get("/api/active-persona", async (_req, res) => {
  try {
    const soul = await fs.readFile(path.join(dataDir(), "workspace", "SOUL.md"), "utf8").catch(() => "");
    const m = soul.match(/^# SOUL\.md\s*[—-]\s*(.+)$/m);
    res.json({ active: m ? m[1].trim() : null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 数据备份（卡片 + 长期记忆 + MCP 配置 → 单个 JSON） ----------
app.get("/api/backup", async (_req, res) => {
  try {
    const cards: Record<string, unknown> = {};
    for (const meta of await store.list()) cards[meta.slug] = await store.get(meta.slug);
    const memory = await readAllMemories();
    const bundle = {
      app: "openclaw-shell",
      version: 1,
      exported_at: new Date().toISOString(),
      cards,
      memory,
      mcp: await loadMCPConfig(),
    };
    res.json({
      filename: `openclaw-shell-backup-${new Date().toISOString().slice(0, 10)}.json`,
      dataUrl: "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(bundle, null, 2)),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 长期记忆查看 / 管理 ----------
app.get("/api/memory", async (_req, res) => {
  try {
    res.json({ memory: await readAllMemories() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 清空（定义在 :slug 之前，避免被当成 slug）
app.post("/api/memory/clear", async (req, res) => {
  try {
    const slug = req.body?.slug;
    if (slug) {
      await clearMemory(String(slug));
    } else {
      for (const f of await fs.readdir(path.join(dataDir(), "memory")).catch(() => [])) {
        if (f.endsWith(".mem")) await clearMemory(f.replace(/\.mem$/, ""));
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 手动添加一条记忆
app.post("/api/memory/:slug", async (req, res) => {
  try {
    const { fact, cat } = req.body ?? {};
    const result = await appendEntry(req.params.slug, {
      fact: String(fact ?? ""),
      cat: cat as MemoryCategory,
      src: "manual",
    });
    if (!result.ok) return res.json({ ok: false, duplicate: result.duplicate === true });
    res.json({ ok: true, entry: result.entry });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 删除单条记忆
app.post("/api/memory/:slug/delete", async (req, res) => {
  try {
    const id = String(req.body?.id ?? "");
    if (!id) return res.status(400).json({ error: "id 不能为空" });
    const removed = await deleteEntry(req.params.slug, id);
    res.json({ ok: removed });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 编辑单条记忆（fact / cat）
app.post("/api/memory/:slug/update", async (req, res) => {
  try {
    const { id, fact, cat } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "id 不能为空" });
    const entry = await updateEntry(req.params.slug, String(id), {
      fact: typeof fact === "string" ? fact : undefined,
      cat: cat as MemoryCategory,
    });
    if (!entry) return res.status(404).json({ error: "记忆不存在" });
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 表情包（每人设卡最多 120 个，带解释） ----------
app.post("/api/cards/:slug/emoji", async (req, res) => {
  try {
    const { name, explanation, imageBase64, ext } = req.body ?? {};
    if (!name || !imageBase64) return res.status(400).json({ error: "name / imageBase64 不能为空" });
    const card = await store.get(req.params.slug);
    const emojis = card.emojis ?? [];
    if (emojis.length >= 120) return res.status(400).json({ error: "最多 120 个自定义表情包" });
    const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const extName = /^[a-z0-9]{2,5}$/i.test(String(ext ?? "")) ? String(ext) : "png";
    const dir = path.join(dataDir(), "emojis", req.params.slug);
    await fs.mkdir(dir, { recursive: true });
    const file = `${id}.${extName}`;
    await fs.writeFile(path.join(dir, file), Buffer.from(imageBase64, "base64"));
    card.emojis = [...emojis, { id, name: String(name).slice(0, 40), file, explanation: String(explanation ?? "").slice(0, 200) }];
    await store.save(card);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/cards/:slug/emoji/:id", async (req, res) => {
  try {
    const card = await store.get(req.params.slug);
    const target = (card.emojis ?? []).find((e) => e.id === req.params.id);
    card.emojis = (card.emojis ?? []).filter((e) => e.id !== req.params.id);
    await store.save(card);
    if (target) await fs.unlink(path.join(dataDir(), "emojis", req.params.slug, target.file)).catch(() => {});
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 生图配置（NovelAI / OpenAI 兼容 / 本地 SD WebUI） ----------
app.get("/api/image/config", async (_req, res) => {
  try {
    const cfg = await getImageConfig();
    res.json({
      provider: cfg.provider,
      retentionDays: cfg.retentionDays,
      novelai: {
        key: maskKey(cfg.novelai.key),
        model: cfg.novelai.model,
        steps: cfg.novelai.steps,
        scale: cfg.novelai.scale,
        negative: cfg.novelai.negative,
        sampler: cfg.novelai.sampler,
        seed: cfg.novelai.seed,
        ucPreset: cfg.novelai.ucPreset,
        translate: cfg.novelai.translate,
      },
      openai: {
        baseUrl: cfg.openai.baseUrl,
        key: maskKey(cfg.openai.key),
        model: cfg.openai.model,
        size: cfg.openai.size,
        translate: cfg.openai.translate,
      },
      local: {
        baseUrl: cfg.local.baseUrl,
        model: cfg.local.model,
        steps: cfg.local.steps,
        cfg: cfg.local.cfg,
        sampler: cfg.local.sampler,
        negative: cfg.local.negative,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/image/config", async (req, res) => {
  try {
    const { provider, novelai, openai, local, retentionDays } = req.body ?? {};
    const cur = await getImageConfig();
    const next = {
      provider: ["novelai", "openai", "local"].includes(provider) ? provider : cur.provider,
      retentionDays: Number.isFinite(Number(retentionDays)) ? Math.max(0, Math.floor(Number(retentionDays))) : cur.retentionDays,
      novelai: {
        key: novelai?.key ? String(novelai.key) : cur.novelai.key,
        model: novelai?.model ?? cur.novelai.model,
        steps: Number(novelai?.steps) || cur.novelai.steps,
        scale: Number(novelai?.scale) || cur.novelai.scale,
        negative: novelai?.negative ?? cur.novelai.negative,
        sampler: novelai?.sampler ?? cur.novelai.sampler,
        seed: typeof novelai?.seed === "number" ? novelai.seed : cur.novelai.seed,
        ucPreset: ["none", "light", "heavy"].includes(novelai?.ucPreset) ? novelai.ucPreset : cur.novelai.ucPreset,
        translate: novelai?.translate !== undefined ? Boolean(novelai.translate) : cur.novelai.translate,
      },
      openai: {
        baseUrl: openai?.baseUrl ?? cur.openai.baseUrl,
        key: openai?.key ? String(openai.key) : cur.openai.key,
        model: openai?.model ?? cur.openai.model,
        size: openai?.size ?? cur.openai.size,
        translate: openai?.translate !== undefined ? Boolean(openai.translate) : cur.openai.translate,
      },
      local: {
        baseUrl: local?.baseUrl ?? cur.local.baseUrl,
        model: local?.model ?? cur.local.model,
        steps: Number(local?.steps) || cur.local.steps,
        cfg: Number(local?.cfg) || cur.local.cfg,
        sampler: local?.sampler ?? cur.local.sampler,
        negative: local?.negative ?? cur.local.negative,
      },
    };
    await saveImageConfig(next);
    res.json({ ok: true, hint: "已保存。工作模式勾选「生图」工具即可让 AI 生成图片" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/image/test", async (req, res) => {
  try {
    const { provider, novelai, openai, local } = req.body ?? {};
    if (provider === "novelai") {
      const key = novelai?.key ?? (await getImageConfig()).novelai.key;
      if (!key) return res.json({ ok: false, info: "未填 NovelAI Key" });
      res.json(await testNovelaiKey(String(key)));
      return;
    }
    if (provider === "openai") {
      const baseUrl = openai?.baseUrl ?? (await getImageConfig()).openai.baseUrl;
      const key = openai?.key ?? (await getImageConfig()).openai.key;
      if (!baseUrl || !key) return res.json({ ok: false, info: "未填 Base URL / Key" });
      res.json(await testOpenAIImageKey(String(baseUrl), String(key)));
      return;
    }
    if (provider === "local") {
      const baseUrl = local?.baseUrl ?? (await getImageConfig()).local.baseUrl;
      if (!baseUrl) return res.json({ ok: false, info: "未填本地生图 Base URL" });
      try {
        const r = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/sdapi/v1/options`, { signal: AbortSignal.timeout(10000) });
        res.json({ ok: r.ok, info: r.ok ? "本地服务可达（/sdapi/v1/options 正常）" : `HTTP ${r.status}` });
      } catch (e) {
        res.json({ ok: false, info: "本地服务不可达：" + String(e) });
      }
      return;
    }
    res.json({ ok: false, info: "未知提供商" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 真实生成一张测试图（保存到 data/images/_test/），配置页「试生一张」用
app.post("/api/image/generate", async (req, res) => {
  try {
    const { prompt, negative, aspect, provider, novelai, openai, local } = req.body ?? {};
    const { generateImage } = await import("./core/imageGen.js");
    const { getImageConfig } = await import("./core/imageConfig.js");
    const cfg = await getImageConfig();
    // 页面表单可能未保存，用提交值覆盖本次生成
    const override = {
      ...cfg,
      provider: ["novelai", "openai", "local"].includes(provider) ? provider : cfg.provider,
      novelai: {
        ...cfg.novelai,
        key: novelai?.key ? String(novelai.key) : cfg.novelai.key,
        model: novelai?.model ?? cfg.novelai.model,
        steps: Number(novelai?.steps) || cfg.novelai.steps,
        scale: Number(novelai?.scale) || cfg.novelai.scale,
        negative: novelai?.negative ?? cfg.novelai.negative,
        sampler: novelai?.sampler ?? cfg.novelai.sampler,
      },
      openai: {
        ...cfg.openai,
        baseUrl: openai?.baseUrl ?? cfg.openai.baseUrl,
        key: openai?.key ? String(openai.key) : cfg.openai.key,
        model: openai?.model ?? cfg.openai.model,
        size: openai?.size ?? cfg.openai.size,
      },
      local: {
        ...cfg.local,
        baseUrl: local?.baseUrl ?? cfg.local.baseUrl,
        steps: Number(local?.steps) || cfg.local.steps,
        cfg: Number(local?.cfg) || cfg.local.cfg,
        sampler: local?.sampler ?? cfg.local.sampler,
        negative: local?.negative ?? cfg.local.negative,
      },
    };
    const saveDir = path.join(dataDir(), "images", "_test");
    const r = await generateImage(
      {
        prompt: String(prompt ?? ""),
        negative: negative ? String(negative) : undefined,
        aspect: aspect ? String(aspect) : undefined,
        cfg: override,
      },
      saveDir
    );
    if (!r.ok) return res.json({ ok: false, error: r.error });
    const file = r.file ? path.basename(r.file) : "gen.png";
    res.json({ ok: true, url: `/img/_test/${file}`, promptUsed: r.promptUsed, width: r.width, height: r.height });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 图片库：列出 data/images 下全部图片（按时间倒序），供管理/删除；先顺手清理过期图片
app.get("/api/image/list", async (_req, res) => {
  try {
    await cleanupImages();
    const root = path.join(dataDir(), "images");
    const out: { dir: string; file: string; url: string; size: number; mtime: number }[] = [];
    for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
      const full = path.join(root, dir);
      const st = await fs.stat(full).catch(() => null);
      if (!st?.isDirectory()) continue;
      for (const f of await fs.readdir(full).catch(() => [] as string[])) {
        if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
        const fst = await fs.stat(path.join(full, f)).catch(() => null);
        if (!fst?.isFile()) continue;
        out.push({ dir, file: f, url: `/img/${dir}/${f}`, size: fst.size, mtime: fst.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    res.json({ images: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/image/delete", async (req, res) => {
  try {
    const { url } = req.body ?? {};
    if (typeof url !== "string") return res.status(400).json({ error: "缺少 url" });
    const m = /^\/img\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(url);
    if (!m || m[1].includes("\\") || m[1].includes("..")) return res.status(400).json({ error: "url 不合法" });
    const target = path.join(dataDir(), "images", m[1], m[2]);
    const root = path.join(dataDir(), "images");
    if (!target.startsWith(root + path.sep)) return res.status(400).json({ error: "非法路径" });
    await fs.unlink(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 图片自动清理：_test 试生图超 1 天即删；正式生图保留 retentionDays 天（0 = 不自动清理正式图） */
async function cleanupImages(): Promise<{ removed: number }> {
  try {
    const { getImageConfig } = await import("./core/imageConfig.js");
    const cfg = await getImageConfig();
    const root = path.join(dataDir(), "images");
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    let removed = 0;
    for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
      const full = path.join(root, dir);
      const st = await fs.stat(full).catch(() => null);
      if (!st?.isDirectory()) continue;
      const maxAge = dir === "_test" ? DAY : cfg.retentionDays > 0 ? cfg.retentionDays * DAY : Infinity;
      if (!Number.isFinite(maxAge)) continue;
      for (const f of await fs.readdir(full).catch(() => [] as string[])) {
        if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
        const fst = await fs.stat(path.join(full, f)).catch(() => null);
        if (fst?.isFile() && now - fst.mtimeMs > maxAge) {
          await fs.unlink(path.join(full, f)).catch(() => {});
          removed++;
        }
      }
    }
    return { removed };
  } catch {
    return { removed: 0 };
  }
}

// ---------- 语音合成（TTS）：上游聚合（OpenAI 兼容，可售卖）+ 本地兜底（Edge/SAPI） ----------
app.get("/api/tts/config", async (_req, res) => {
  try {
    const cfg = await getTtsConfig();
    res.json({
      defaultProvider: cfg.defaultProvider,
      local: { engine: cfg.local.engine, voice: cfg.local.voice, rate: cfg.local.rate, pitch: cfg.local.pitch },
      providers: cfg.providers.map((p) => ({ ...p, key: maskTtsKey(p.key) })),
      commonVoices: COMMON_EDGE_VOICES,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/tts/config", async (req, res) => {
  try {
    const { defaultProvider, local } = req.body ?? {};
    const cur = await getTtsConfig();
    const next = {
      ...cur,
      defaultProvider: defaultProvider && (defaultProvider === "local" || cur.providers.some((p) => p.id === defaultProvider))
        ? defaultProvider
        : cur.defaultProvider,
      local: {
        engine: ["edge", "sapi"].includes(local?.engine) ? local.engine : cur.local.engine,
        voice: local?.voice ?? cur.local.voice,
        rate: local?.rate ?? cur.local.rate,
        pitch: local?.pitch ?? cur.local.pitch,
      },
    };
    await saveTtsConfig(next);
    res.json({ ok: true, hint: "已保存。聊天里点「🔊」即可朗读 AI 回复" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 新增或更新上游（带 id 且已存在 → 更新；否则新增）
app.post("/api/tts/providers", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<TtsProvider>;
    const cur = await getTtsConfig();
    const providers = [...cur.providers];
    let id = String(body.id ?? "");
    const existing = providers.find((p) => p.id === id);
    const patch: Partial<TtsProvider> = {
      name: body.name,
      kind: body.kind && TTS_KINDS.includes(body.kind) ? body.kind : "openai",
      baseUrl: body.baseUrl,
      model: body.model,
      voice: body.voice,
      speed: typeof body.speed === "number" ? body.speed : undefined,
      markup: typeof body.markup === "number" ? body.markup : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      appId: typeof body.appId === "string" ? body.appId || undefined : undefined,
    };
    if (existing) {
      // 更新：key 为空表示保留旧 key
      const merged = { ...existing, ...patch };
      if (body.key) merged.key = String(body.key);
      providers[providers.indexOf(existing)] = merged;
    } else {
      if (!body.name || !body.baseUrl) return res.status(400).json({ error: "name / baseUrl 必填" });
      id = `p_${Date.now().toString(36)}`;
      providers.push({
        id,
        name: String(body.name),
        kind: body.kind && TTS_KINDS.includes(body.kind) ? body.kind : "openai",
        baseUrl: String(body.baseUrl),
        key: String(body.key ?? ""),
        model: String(body.model ?? ""),
        voice: String(body.voice ?? ""),
        speed: typeof body.speed === "number" ? body.speed : 1,
        markup: typeof body.markup === "number" ? body.markup : 1,
        enabled: body.enabled !== false,
        appId: typeof body.appId === "string" ? body.appId : "",
      });
    }
    await saveTtsConfig({ ...cur, providers });
    res.json({ ok: true, id, hint: existing ? "已更新上游" : "已新增上游" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/tts/providers/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    const cur = await getTtsConfig();
    const providers = cur.providers.filter((p) => p.id !== id);
    await saveTtsConfig({
      ...cur,
      providers,
      defaultProvider: cur.defaultProvider === id ? "local" : cur.defaultProvider,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 拉取 TTS 上游的模型/音色列表：openai 兼容走 GET {base}/models（+尽力 /audio/voice/list）；minimax/volc 给内置可选列表
function extractVoiceIds(j: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s && s.length < 120 && s !== "null") out.push(s);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["voice_id", "voiceId", "voice", "speaker", "name", "id"]) {
        const val = o[k];
        if (typeof val === "string" && val.trim() && val !== "null") {
          out.push(val.trim());
          break;
        }
      }
    }
  };
  walk((j as { data?: unknown })?.data ?? j);
  return [...new Set(out)];
}

app.post("/api/tts/fetch-models", async (req, res) => {
  try {
    const { kind, baseUrl, key } = req.body ?? {};
    const k: string = TTS_KINDS.includes(kind) ? kind : "openai";
    const base = String(baseUrl ?? "").replace(/\/+$/, "");
    if (!base || !key) return res.status(400).json({ error: "Base URL 与 API Key 必填" });
    let models: string[] = [];
    let voices: string[] = [];
    if (k === "openai") {
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return res.status(502).json({ error: `拉取模型失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` });
      const j = (await r.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = Array.isArray(j?.data) ? j.data.map((m) => String(m?.id ?? "")).filter(Boolean) : [];
      models = ids.filter((id) => /tts|speech|voice|audio|cosy|moss/i.test(id));
      if (!models.length) models = ids; // 过滤不到就全给
      // 尽力拉音色列表（硅基流动等支持 GET /audio/voice/list），失败不影响模型
      const vr = await fetch(`${base}/audio/voice/list`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (vr?.ok) {
        const vj = await vr.json().catch(() => null);
        voices = extractVoiceIds(vj);
      }
    } else if (k === "minimax") {
      models = ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo"];
    } else if (k === "volc") {
      models = ["seed-tts-1.0", "seed-tts-2.0", "seed-tts-1.0-concurr", "seed-icl-2.0"];
    }
    res.json({ models, voices });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/tts/voices", async (_req, res) => {
  try {
    res.json({ voices: await listEdgeVoices() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// target: "local" 或 provider id
app.post("/api/tts/test", async (req, res) => {
  try {
    const { target } = req.body ?? {};
    res.json(await testTts(String(target ?? "")));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/tts/synthesize", async (req, res) => {
  const started = Date.now();
  try {
    const { text, providerId, voice, speed } = req.body ?? {};
    const buf = await synthesizeTts(String(text ?? ""), { providerId, voice, speed });
    const ext = buf[0] === 0x52 && buf[1] === 0x49 ? "wav" : "mp3"; // RIFF → wav
    const file = `tts-${Date.now()}.${ext}`;
    const dir = path.join(dataDir(), "tts");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), buf);
    res.json({ url: `/tts/${file}`, bytes: buf.length });
    void recordUsage({
      ts: new Date().toISOString(),
      provider: providerId ?? (await getTtsConfig()).defaultProvider,
      model: "admin",
      voice: String(voice ?? ""),
      chars: String(text ?? "").length,
      ms: Date.now() - started,
      bytes: buf.length,
      ok: true,
      via: "admin",
    }).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/tts/usage", async (_req, res) => {
  try {
    res.json(await getUsageSummary());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`openclaw-shell 已启动: http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
  // 生图图片自动清理：启动清一次 + 每天清一次（_test 试生图超 1 天删；正式图超 retentionDays 删）
  void cleanupImages().then((r) => {
    if (r.removed > 0) console.log(`图片自动清理：已删除 ${r.removed} 张过期图片`);
  });
  setInterval(() => void cleanupImages(), 24 * 3600 * 1000);
});
