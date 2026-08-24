// 本地服务：卡片 API + Web 编辑器
// 启动: npm run server  →  http://127.0.0.1:17880
import express from "express";
import path from "node:path";
import os from "node:os";
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
import { buildChatSystemAsync } from "./core/chatPrompt.js";
import {
  listPresets,
  addPreset,
  updatePreset,
  deletePreset,
  resetBuiltinPresets,
  resolveCardPresetBlocks,
  type PresetKind,
} from "./core/presets.js";
import { TOOL_REGISTRY, toolsToOpenAI, resolveInSandbox, type ToolDef, type ToolCtx } from "./tools/registry.js";
import { SKILL_LIBRARY } from "./core/skills.js";
import {
  getMCPTools,
  loadMCPConfig,
  saveMCPConfig,
  reloadMCP,
  testMCPServer,
  type MCPServerConfig,
} from "./tools/mcp.js";
import { cardToCCv2, ccv2ToCard } from "./core/cardConvert.js";
import { solidPng, pngWithTexts, extractCardJson, pngStripCardMeta, isPng } from "./core/png.js";
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
app.use(express.json({ limit: "20mb" }));
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
    const slug = req.params.slug;
    await store.remove(slug);
    // 清理该卡的关联数据（卡删了这些失去归属，避免重建同名卡时出现"幽灵记忆/表情"）
    const root = dataDir();
    await fs.rm(path.join(root, "memory", `${slug}.mem`), { force: true }).catch(() => {});
    await fs.rm(path.join(root, "memory", `${slug}.mem.count`), { force: true }).catch(() => {});
    await Promise.all(
      ["sandbox", "emojis", "images", "agent-workspaces"].map((sub) =>
        fs.rm(path.join(root, sub, slug), { recursive: true, force: true }).catch(() => {})
      )
    );
    // 共享 workspace 里的人设产物（漏掉会留下"幽灵人格"，模型仍可能读到已删卡的 SKILL.md）
    await fs.rm(path.join(root, "workspace", "skills", "personas", slug), { recursive: true, force: true }).catch(() => {});
    // 绑定这张卡的机器人实例（卡没了 bot 就是死记录，还会占用"每卡一个"的名额）
    let removedBots = 0;
    for (const b of await listBots().catch(() => [])) {
      if (b.cardSlug !== slug) continue;
      await removeBot(b.id).catch(() => {});
      removedBots++;
      await runOpenclaw(["agents", "delete", b.agentId, "--force"], { timeoutMs: 60000 }).catch(() => {});
    }
    if (removedBots > 0) invalidateAgentsCache();
    res.json({ ok: true, removedBots });
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
    const onebot = await runOpenclaw(["channels", "status", "--probe"], { timeoutMs: 25000 });
    const onebotText = stripAnsi(onebot.stdout + onebot.stderr);
    res.json({
      pluginInstalled: hasPlugin,
      // QQ 官方开放平台插件（openclaw-qqbot）；保留 onebot/napcat 兼容旧输出
      onebotSeen: /qqbot|onebot|napcat/i.test(onebotText),
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

// ---------- AI 辅助做卡：想法 → 卡片草稿（用已保存的 API） ----------
function slugFromName(name: string): string {
  return /^[a-z0-9][a-z0-9-]*$/.test(name.toLowerCase()) ? name.toLowerCase() : `persona-${Date.now().toString(36)}`;
}

const ROLE_ZH_MAP: Record<string, string> = {
  self: "自己",
  friend: "朋友",
  family: "家人",
  partner: "前任/恋人",
  colleague: "同事",
  "public-figure": "偶像/角色",
};

app.post("/api/cards/ai-draft", async (req, res) => {
  try {
    const { idea, role } = req.body ?? {};
    const ideaText = String(idea ?? "").trim();
    if (!ideaText) return res.status(400).json({ error: "先描述你的想法，AI 才能帮你生成草稿" });
    const r = role && RELATION_ROLES.includes(role) ? role : "friend";
    const llm = await resolveChatLLM();
    if (!llm) return res.status(400).json({ error: "未配置模型 API。请先到「API 与模型」页添加提供商并设为默认" });

    const sys = `你是角色卡创作助手。用户会给你一段角色想法，请把它扩展成一张完整的角色卡草稿。
要求：
1. 输出严格 JSON（不要 Markdown、不要多余文字）
2. 结构：
{
  "name": "角色名（用户没给就起一个贴切的）",
  "bio": "一句话简介",
  "tags": ["标签1", "标签2"],
  "first_mes": "开场白：一段有画面感的小场景（3-5 句，包含动作和环境描写，别只写一句问候）",
  "voice": { "tone_rules": ["说话方式1（具体到语气/句式）", "说话方式2"], "catchphrases": ["口头禅"] },
  "personality": { "traits": ["性格特质"], "values": ["价值观"], "boundaries": ["雷区/不可逾越的"] },
  "worldbook": [
    { "name": "人物形象", "content": "完整角色设定（基本信息/外貌/性格/语言风格/背景/喜好/雷区，写成结构化文本）", "constant": true },
    { "name": "世界观", "content": "角色所在世界/场景的设定", "constant": true },
    { "name": "人物关系", "content": "与{{user}}的关系设定，{{user}}即用户，可自定义关系", "constant": true },
    { "name": "（其他条目，带关键词）", "keys": ["关键词1", "关键词2"], "content": "触发内容", "constant": false }
  ],
  "regex": []
}
3. 世界书 3-6 条；「人物形象」必须 constant=true 且内容完整（这是角色扮演的核心依据）
4. 语言风格要具体可执行：给出日常/情绪波动时不同的说话方式示例
5. 全程中文输出；regex 一般留空数组`;

    const userMsg = `角色的想法：${ideaText}\n关系类型：${ROLE_ZH_MAP[r] ?? "朋友"}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let llmRes: Response;
    try {
      llmRes = await fetch(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: "system", content: sys }, { role: "user", content: userMsg }],
          temperature: 0.8,
          max_tokens: 4000,
        }),
        signal: ctrl.signal, // 必须在 fetch options 层；放进 body 会被当成请求字段，超时永不生效
      });
    } catch (e) {
      clearTimeout(timer);
      return res.status(500).json({ error: `调用模型失败：${e instanceof Error && e.name === "AbortError" ? "超时(90s)" : String(e)}` });
    }
    clearTimeout(timer);
    if (!llmRes.ok) {
      return res.status(502).json({ error: `模型返回 ${llmRes.status}：${(await llmRes.text().catch(() => "")).slice(0, 200)}` });
    }
    const data = (await llmRes.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s === -1 || e === -1) return res.status(502).json({ error: "模型没有返回 JSON，请重试" });
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned.slice(s, e + 1));
    } catch {
      return res.status(502).json({ error: "模型返回的 JSON 解析失败，请重试" });
    }

    const name = String(parsed.name ?? "").trim().slice(0, 40) || "新角色";
    const draft = defaultCard(name, slugFromName(name));
    draft.id = newCardId();
    draft.created_at = nowIso();
    draft.updated_at = nowIso();
    draft.identity.role = r;
    draft.identity.relation = name;
    const bio = String(parsed.bio ?? "").trim();
    draft.identity.bio = bio.slice(0, 500);
    if (Array.isArray(parsed.tags)) draft.identity.tags = (parsed.tags as unknown[]).map(String).slice(0, 10);
    const voice = (parsed.voice ?? {}) as Record<string, unknown>;
    if (Array.isArray(voice.tone_rules)) draft.voice.tone_rules = (voice.tone_rules as unknown[]).map(String).slice(0, 8);
    if (Array.isArray(voice.catchphrases)) draft.voice.catchphrases = (voice.catchphrases as unknown[]).map(String).slice(0, 8);
    const pers = (parsed.personality ?? {}) as Record<string, unknown>;
    if (Array.isArray(pers.traits)) draft.personality.traits = (pers.traits as unknown[]).map(String).slice(0, 10);
    if (Array.isArray(pers.values)) draft.personality.values = (pers.values as unknown[]).map(String).slice(0, 6);
    if (Array.isArray(pers.boundaries)) draft.personality.boundaries = (pers.boundaries as unknown[]).map(String).slice(0, 6);

    const st = draft.sillytavern_v2 ?? {
      chara_card_v2: "0.0.1",
      description: "",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      alternate_greetings: [],
      regex_scripts: [],
      character_book: { entries: [] },
    };
    st.description = bio;
    st.first_mes = String(parsed.first_mes ?? "").trim();
    if (Array.isArray(parsed.worldbook)) {
      st.character_book = {
        entries: (parsed.worldbook as Record<string, unknown>[])
          .slice(0, 8)
          .map((wb) => {
            const constant = wb.constant === true;
            return {
              keys: Array.isArray(wb.keys) ? (wb.keys as unknown[]).map(String).slice(0, 8) : [],
              secondary_keys: [],
              content: String(wb.content ?? "").trim(),
              name: String(wb.name ?? "").trim() || undefined,
              comment: String(wb.name ?? "").trim() || undefined,
              constant,
              enabled: true,
              insertion_order: constant ? 0 : 100,
              priority: 10,
              selective: false,
              position: "before_char",
              probability: 100,
              depth: 4,
            };
          })
          .filter((x) => x.content),
      };
    }
    if (Array.isArray(parsed.regex)) {
      st.regex_scripts = (parsed.regex as Record<string, unknown>[])
        .slice(0, 10)
        .map((rx) => ({
          scriptName: String(rx.name ?? rx.scriptName ?? "").trim(),
          findRegex: String(rx.findRegex ?? rx.find ?? "").trim(),
          replaceString: String(rx.replaceString ?? rx.replace ?? ""),
          enabled: true,
        }))
        .filter((rx) => rx.findRegex);
    }
    draft.sillytavern_v2 = st;

    const vr = validateCard(draft);
    if (!vr.ok) return res.status(500).json({ error: "草稿校验失败：" + vr.errors.join("; ") });
    res.json({ draft, warnings: vr.warnings });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------- 角色卡封面：角色描述 → 生图（自动识别配置是否可用） ----------
app.post("/api/cards/cover", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt) return res.status(400).json({ ok: false, error: "缺少提示词" });
    const cfg = await getImageConfig();
    const ready =
      (cfg.provider === "novelai" && cfg.novelai.key) ||
      (cfg.provider === "openai" && cfg.openai.baseUrl && cfg.openai.key) ||
      (cfg.provider === "local" && cfg.local.baseUrl);
    if (!ready) {
      return res.json({ ok: false, info: "未配置生图：到「生图配置」页填好 Key 后回来一键生成封面" });
    }
    const { generateImage } = await import("./core/imageGen.js");
    const r = await generateImage({ prompt, aspect: "portrait" });
    if (!r.ok || !r.buffer) return res.json({ ok: false, error: r.error ?? "生成失败" });
    const mime = r.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
    res.json({ ok: true, dataUrl: `data:${mime};base64,${r.buffer.toString("base64")}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
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
  let png: Buffer | null = null;
  const avatar = card.identity.avatar;
  if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
    const raw = Buffer.from(avatar.split(",")[1] ?? "", "base64");
    // 头像必须是真 PNG：把 jpeg 当 PNG 写会产出打不开的坏文件（上游生图可能返回 jpeg）
    if (isPng(raw)) png = raw;
  }
  if (!png) png = solidPng(512, 512, [24, 26, 36, 255]);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  // 一次写入 chara（CCv2 通用）与 ccv3（新版读卡方优先读它），保证对方读到的都是最新数据
  const out = pngWithTexts(png, [
    { keyword: "chara", text: b64 },
    { keyword: "ccv3", text: b64 },
  ]);
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

// mode: "new"（默认，冲突则另存为 slug-2）/ "overwrite"（覆盖同 slug，旧卡进 versions/ 快照）
app.post("/api/cards/import-card", async (req, res) => {
  try {
    const { fileBase64, fileName, mode } = req.body ?? {};
    if (!fileBase64) return res.status(400).json({ error: "缺少文件内容" });
    const buf = Buffer.from(fileBase64, "base64");
    const isPngFile = /\.png$/i.test(String(fileName ?? "")) || isPng(buf);
    let cc: unknown;
    if (isPngFile) {
      cc = extractCardJson(buf);
      if (!cc) return res.status(400).json({ error: "PNG 里未找到角色卡数据（chara / ccv3 块）" });
    } else {
      cc = JSON.parse(buf.toString("utf8"));
    }
    // 头像存原图前先剥掉原作者的 chara/ccv3：否则再导出时对方可能优先读到旧数据，你的编辑全白做
    const avatar = isPngFile ? "data:image/png;base64," + pngStripCardMeta(buf).toString("base64") : undefined;
    const card = ccv2ToCard(cc, avatar);
    const conflict = await store.exists(card.slug);
    if (conflict && mode !== "overwrite") {
      // 默认不覆盖：另存为新 slug，并告知前端发生了改名
      const original = card.slug;
      card.slug = await store.freeSlug(card.slug);
      const result = validateCard(card);
      if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
      await store.save(card);
      return res.json({ card, renamedFrom: original, hint: `已存在同名卡「${original}」，本次另存为「${card.slug}」` });
    }
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(card);
    res.json({ card, overwrote: conflict === true });
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
    const card = await store.get(slug).catch(() => null);
    if (!card) return res.status(404).json({ error: `卡片不存在: ${slug}` });
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
      (await buildChatSystemAsync(card, await resolveCardPresetBlocks(card))) +
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
    // 与 /api/chat 保持一致：用卡片单独配置的模型（否则审批续聊会静默换回默认模型）
    const card = await store.get(slug).catch(() => null);
    if (!card) return res.status(404).json({ error: `卡片不存在: ${slug}` });
    const llm = await resolveChatLLM(card);
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
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
    if (result.type === "reply") {
      // 与 /api/chat 一致：审批续聊后的回复同样计入自动记忆轮数
      void autoMemorize(slug, card, messages).catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 角色扮演预设库（档位/风格，卡片高级配置引用） ----------
const isPresetKind = (k: string): k is PresetKind => k === "tier" || k === "style";

app.get("/api/presets", async (_req, res) => {
  try {
    res.json(await listPresets());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/presets", async (req, res) => {
  try {
    const { kind, name, content } = req.body ?? {};
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    res.status(201).json(await addPreset(kind, String(name ?? ""), String(content ?? "")));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.put("/api/presets/:kind/:id", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    const patch: { name?: string; content?: string } = {};
    if (typeof req.body?.name === "string") patch.name = req.body.name;
    if (typeof req.body?.content === "string") patch.content = req.body.content;
    res.json(await updatePreset(kind, String(req.params.id), patch));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/presets/:kind/:id", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    res.json(await deletePreset(kind, String(req.params.id)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/presets/reset", async (_req, res) => {
  try {
    res.json(await resetBuiltinPresets());
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
    const clean = await saveMCPConfig({ servers: servers as MCPServerConfig[] });
    await reloadMCP();
    res.json({ ok: true, servers: clean.servers.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 测试单个 MCP 服务器：连接 + 拉取工具列表（不保存），供配置表单的「测试连接」用
app.post("/api/mcp/test", async (req, res) => {
  try {
    const server = req.body?.server;
    if (!server || typeof server !== "object") return res.status(400).json({ error: "server 不能为空" });
    res.json(await testMCPServer(server as MCPServerConfig));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- 工作区文件管理（沙箱 data/sandbox/<slug>，供工作台文件面板用） ----------
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function sandboxOf(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  return path.join(dataDir(), "sandbox", slug);
}

app.get("/api/workspace/list", async (req, res) => {
  try {
    const slug = String(req.query.slug ?? "");
    const base = sandboxOf(slug);
    if (!base) return res.status(400).json({ error: "slug 无效" });
    const dir = resolveInSandbox(base, String(req.query.dir ?? ""));
    if (!dir) return res.status(400).json({ error: "路径越界" });
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (items === null) return res.status(404).json({ error: "目录不存在" });
    const out = [];
    for (const it of items) {
      const abs = path.join(dir, it.name);
      let size = 0;
      let mtime = 0;
      try {
        const st = await fs.stat(abs);
        size = it.isDirectory() ? 0 : st.size;
        mtime = st.mtimeMs;
      } catch { /* 忽略 stat 失败 */ }
      out.push({ name: it.name, dir: it.isDirectory(), size, mtime });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    res.json({ slug, dir: String(req.query.dir ?? ""), items: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/workspace/write", async (req, res) => {
  try {
    const { slug, file, content } = req.body ?? {};
    const base = sandboxOf(String(slug ?? ""));
    if (!base) return res.status(400).json({ error: "slug 无效" });
    const abs = resolveInSandbox(base, String(file ?? ""));
    if (!abs) return res.status(400).json({ error: "路径越界" });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(content ?? ""), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/workspace/mkdir", async (req, res) => {
  try {
    const { slug, dir } = req.body ?? {};
    const base = sandboxOf(String(slug ?? ""));
    if (!base) return res.status(400).json({ error: "slug 无效" });
    const abs = resolveInSandbox(base, String(dir ?? ""));
    if (!abs) return res.status(400).json({ error: "路径越界" });
    await fs.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/workspace/delete", async (req, res) => {
  try {
    const { slug, path: rel } = req.body ?? {};
    const base = sandboxOf(String(slug ?? ""));
    if (!base) return res.status(400).json({ error: "slug 无效" });
    const abs = resolveInSandbox(base, String(rel ?? ""));
    if (!abs) return res.status(400).json({ error: "路径越界" });
    if (abs === base) return res.status(400).json({ error: "不能删除工作区根目录" });
    await fs.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/workspace/download", async (req, res) => {
  try {
    const slug = String(req.query.slug ?? "");
    const base = sandboxOf(slug);
    if (!base) return res.status(400).json({ error: "slug 无效" });
    const abs = resolveInSandbox(base, String(req.query.file ?? ""));
    if (!abs) return res.status(400).json({ error: "路径越界" });
    const st = await fs.stat(abs).catch(() => null);
    if (!st || st.isDirectory()) return res.status(404).json({ error: "文件不存在" });
    res.download(abs);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/workspace/upload", async (req, res) => {
  try {
    const { slug, file, data } = req.body ?? {};
    const base = sandboxOf(String(slug ?? ""));
    if (!base) return res.status(400).json({ error: "slug 无效" });
    const abs = resolveInSandbox(base, String(file ?? ""));
    if (!abs) return res.status(400).json({ error: "路径越界" });
    let b64 = String(data ?? "");
    if (b64.includes(",")) b64 = b64.slice(b64.indexOf(",") + 1);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(b64, "base64"));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 工作区概览：所有沙箱目录的文件数与大小（工作台设置页用）
app.get("/api/workspace/overview", async (_req, res) => {
  try {
    const base = path.join(dataDir(), "sandbox");
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(base, e.name);
      let files = 0;
      let size = 0;
      const walk = async (d: string): Promise<void> => {
        const items = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const it of items) {
          const p = path.join(d, it.name);
          if (it.isDirectory()) await walk(p);
          else {
            files++;
            try { size += (await fs.stat(p)).size; } catch { /* 忽略 */ }
          }
        }
      };
      await walk(abs);
      out.push({ slug: e.name, files, size });
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    res.json({ dirs: out });
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

// ---------- 数据备份（卡片 + 长期记忆 + MCP + 各类配置 → 单个 JSON） ----------
app.get("/api/backup", async (_req, res) => {
  try {
    const cards: Record<string, unknown> = {};
    for (const meta of await store.list()) cards[meta.slug] = await store.get(meta.slug);
    const memory = await readAllMemories();
    const readJson = async (name: string): Promise<unknown> =>
      fs.readFile(path.join(dataDir(), name), "utf8").then(JSON.parse).catch(() => null);
    const bundle = {
      app: "openclaw-shell",
      version: 2,
      exported_at: new Date().toISOString(),
      cards,
      memory,
      mcp: await loadMCPConfig(),
      providers: await readJson("providers.json"), // 含 API key（本地备份，仅供本人持有）
      tts: await readJson("ttsConfig.json"),
      ttsKeys: await readJson("ttsKeys.json"),
      image: await readJson("imageConfig.json"),
      bots: await readJson("bots.json"),
      profile: await readJson("user-profile.json"),
      announcement: await readJson("announcement.json"),
      note: "表情包与生图产物是文件（data/emojis、data/images），不在本 JSON 备份内",
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

/** 图片自动清理：_test 试生图超 15 天即删；正式生图保留 retentionDays 天（0 = 不自动清理正式图） */
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
      const maxAge = dir === "_test" ? 15 * DAY : cfg.retentionDays > 0 ? cfg.retentionDays * DAY : Infinity;
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

// ---------- 插件商店：ClawHub 实时搜索 + 精选/分享/付费目录 + 安装管理 ----------
import AdmZip from "adm-zip";
import {
  readCatalog,
  addMarketPlugin,
  removeMarketPlugin,
  getMarketPlugin,
  saveUploadedZip,
  uploadDir,
  recordSale,
  listSales,
  splitPrice,
  DEFAULT_FEE_RATE,
  CATEGORY_LABELS,
  type MarketPlugin,
} from "./core/pluginMarket.js";

/** 解析 `openclaw plugins search` 的文本表格 → 结构化插件列表 */
function parseClawHubSearch(text: string): Array<{ pkg: string; name: string; kind: string; version: string; desc: string }> {
  const out: Array<{ pkg: string; name: string; kind: string; version: string; desc: string }> = [];
  const lines = stripAnsi(text).split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\|\s+(\S+)\s+\|\s+v?([\d.]+[^\s]*(?:\s|—|$))(?:\s*—\s*(.*))?$/);
    if (!m) continue;
    const name = m[1];
    const kind = m[2];
    const version = m[4].trim();
    const desc = (m[5] ?? "").trim();
    out.push({ pkg: `clawhub:${name}`, name, kind, version, desc });
  }
  return out;
}

let pluginsListCache: { map: Map<string, { version: string; enabled: boolean; id: string }>; at: number } | null = null;
let pluginsListInflight: Promise<Map<string, { version: string; enabled: boolean; id: string }>> | null = null;
const PLUGINS_CACHE_MS = 60000;

async function pluginInstalledMap(): Promise<Map<string, { version: string; enabled: boolean; id: string }>> {
  if (pluginsListCache && Date.now() - pluginsListCache.at < PLUGINS_CACHE_MS) return pluginsListCache.map;
  if (pluginsListInflight) return pluginsListInflight;
  pluginsListInflight = (async () => {
    const r = await runOpenclaw(["plugins", "list", "--json"], { timeoutMs: 60000 });
    const map = new Map<string, { version: string; enabled: boolean; id: string }>();
    try {
      for (const p of JSON.parse(r.stdout).plugins ?? []) {
        if (!p.id) continue;
        map.set(String(p.id).toLowerCase(), { version: p.version ?? "", enabled: p.enabled !== false, id: p.id });
      }
    } catch { /* 解析失败就返回空映射 */ }
    pluginsListCache = { map, at: Date.now() };
    return map;
  })();
  try {
    return await pluginsListInflight;
  } finally {
    pluginsListInflight = null;
  }
}

function invalidatePluginsCache(): void {
  pluginsListCache = null;
}

/** 解压用户上传的 zip 到项目 plugins/<id>/ 并 --link 安装；返回安装输出 */
async function installBundlePlugin(plugin: MarketPlugin): Promise<{ code: number; output: string }> {
  try {
    if (!plugin.zip) return { code: -1, output: "该插件缺少安装包" };
    const zipFile = path.join(dataDir(), "plugin-market", plugin.zip);
    const target = path.join(findProjectRoot(), "plugins", plugin.id);
    const tmp = path.join(dataDir(), "plugin-market", "uploads", plugin.id, "extract");
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });
    new AdmZip(zipFile).extractAllTo(tmp, true);
    // 若 zip 带顶层目录（plugins/<name>/manifest），把内容上移一层
    const entries = await fs.readdir(tmp);
    const hasManifestHere = entries.includes("openclaw.plugin.json") || entries.includes("index.js");
    if (!hasManifestHere && entries.length === 1) {
      const inner = path.join(tmp, entries[0]);
      const innerEntries = await fs.readdir(inner);
      if (innerEntries.includes("openclaw.plugin.json") || innerEntries.includes("index.js")) {
        const moved = path.join(tmp, "_flat");
        await fs.rename(inner, moved);
        for (const f of await fs.readdir(moved)) {
          await fs.rename(path.join(moved, f), path.join(tmp, f));
        }
        await fs.rmdir(moved);
      }
    }
    const manifestOk = (await fs.readdir(tmp)).some((f) => f === "openclaw.plugin.json" || f === "index.js");
    if (!manifestOk) {
      return { code: -1, output: "zip 里没找到 openclaw.plugin.json 或 index.js，不是有效的插件包" };
    }
    // 校验 manifest 完整性（OpenClaw 硬性要求 configSchema，缺失会导致安装失败）
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(tmp, "openclaw.plugin.json"), "utf8"));
      if (!manifest.configSchema) {
        return { code: -1, output: "openclaw.plugin.json 缺少 configSchema 字段（插件规范要求），请补上后重新打包" };
      }
      if (!manifest.id || !manifest.name) {
        return { code: -1, output: "openclaw.plugin.json 缺少 id / name 字段" };
      }
    } catch {
      return { code: -1, output: "openclaw.plugin.json 不是合法 JSON" };
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tmp, target);
    const r = await runOpenclaw(["plugins", "install", "--link", target], { timeoutMs: 120000 });
    if (r.code !== 0) {
      // 安装失败回滚：删目录 + 清 openclaw.json 里登记的路径/条目
      await fs.rm(target, { recursive: true, force: true });
      try {
        const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
        const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
        cfg.plugins = cfg.plugins ?? {};
        cfg.plugins.load = cfg.plugins.load ?? { paths: [] };
        cfg.plugins.load.paths = cfg.plugins.load.paths.filter((p: string) => !String(p).includes(`plugins${path.sep}${plugin.id}`));
        if (cfg.plugins.entries?.[plugin.id]) delete cfg.plugins.entries[plugin.id];
        await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      } catch { /* 回滚 config 失败不阻塞报错 */ }
    }
    return { code: r.code ?? -1, output: stripAnsi(r.stdout + r.stderr) };
  } catch (e) {
    return { code: -1, output: "解压/安装失败：" + String(e).slice(0, 400) };
  }
}

app.get("/api/plugins/market", async (_req, res) => {
  try {
    const catalog = await readCatalog();
    const installed = await pluginInstalledMap();
    const now = Date.now();
    res.json({
      feeRate: catalog.feeRate,
      categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
      plugins: catalog.plugins.map((p) => {
        const inst = installed.get(p.pkg.replace("clawhub:", "").toLowerCase()) ?? installed.get(p.id.toLowerCase());
        return { ...p, installed: Boolean(inst), installedVersion: inst?.version ?? "" };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/plugins/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const r = await runOpenclaw(["plugins", "search", ...(q ? [q] : [])], { timeoutMs: 60000 });
    const installed = await pluginInstalledMap();
    res.json({
      ok: r.code === 0,
      output: r.code !== 0 ? stripAnsi(r.stdout + r.stderr).slice(-800) : "",
      results: parseClawHubSearch(r.stdout + r.stderr).map((p) => ({
        ...p,
        installed: Boolean(installed.get(p.name.toLowerCase())),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/plugins/installed", async (_req, res) => {
  try {
    const r = await runOpenclaw(["plugins", "list", "--json"], { timeoutMs: 60000 });
    let plugins: Array<{ id: string; name: string; version: string; enabled: boolean; status: string; source: string }> = [];
    try {
      plugins = (JSON.parse(r.stdout).plugins ?? []).map((p: any) => ({
        id: p.id ?? "", name: p.name ?? p.id ?? "", version: p.version ?? "",
        enabled: p.enabled !== false, status: p.status ?? "", source: String(p.source ?? "").split(":")[0],
      }));
    } catch { /* 解析失败 */ }
    res.json({ ok: r.code === 0, plugins });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/plugins/install", async (req, res) => {
  try {
    const { pkg } = req.body ?? {};
    if (!pkg) return res.status(400).json({ error: "缺少 pkg" });
    let result: { code: number; output: string };
    if (pkg.startsWith("bundle:")) {
      const plugin = await getMarketPlugin(pkg.slice(7));
      if (!plugin) return res.status(404).json({ error: "目录里没有这个插件" });
      result = await installBundlePlugin(plugin);
    } else {
      const r = await runOpenclaw(["plugins", "install", String(pkg)], { timeoutMs: 180000 });
      result = { code: r.code ?? -1, output: stripAnsi(r.stdout + r.stderr) };
    }
    if (result.code === 0) invalidatePluginsCache();
    res.json({ ok: result.code === 0, output: result.output.slice(-1200), hint: "网关重启后插件才会被加载（多任务在跑可先攒着）" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/plugins/uninstall", async (req, res) => {
  try {
    const { id } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "缺少 id" });
    const r = await runOpenclaw(["plugins", "uninstall", String(id), "--force"], { timeoutMs: 120000 });
    let output = stripAnsi(r.stdout + r.stderr).slice(-800);
    // --link 本地安装的插件 openclaw uninstall 不删目录/config 路径，这里补清理（幂等）
    // 目录名可能是 shareId（sp_xxx）而非插件 id，按 manifest id 匹配扫描
    let dirRemoved = false;
    const projPlugins = path.join(findProjectRoot(), "plugins");
    try {
      for (const dir of await fs.readdir(projPlugins)) {
        try {
          const mf = JSON.parse(await fs.readFile(path.join(projPlugins, dir, "openclaw.plugin.json"), "utf8"));
          if (mf.id === String(id)) {
            await fs.rm(path.join(projPlugins, dir), { recursive: true, force: true });
            dirRemoved = true;
          }
        } catch { /* 非插件目录跳过 */ }
      }
    } catch { /* plugins 目录读取失败跳过 */ }
    try {
      const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
      cfg.plugins = cfg.plugins ?? {};
      cfg.plugins.load = cfg.plugins.load ?? { paths: [] };
      const gone = new Set<string>();
      for (const p of cfg.plugins.load.paths) {
        if (String(p).startsWith(projPlugins)) {
          const exists = await fs.stat(String(p)).then(() => true).catch(() => false);
          if (!exists) gone.add(String(p));
        }
      }
      cfg.plugins.load.paths = cfg.plugins.load.paths.filter((p: string) => !gone.has(String(p)));
      if (cfg.plugins.entries?.[String(id)]) delete cfg.plugins.entries[String(id)];
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      if (gone.size > 0) dirRemoved = true;
    } catch { /* config 清理失败不阻塞 */ }
    const ok = r.code === 0 || dirRemoved;
    if (ok) invalidatePluginsCache();
    res.json({ ok, output: ok && dirRemoved ? output + "\n已清理本地插件目录" : output });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/plugins/update", async (req, res) => {
  try {
    const { id } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "缺少 id" });
    const r = await runOpenclaw(["plugins", "update", String(id)], { timeoutMs: 120000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-800) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/plugins/toggle", async (req, res) => {
  try {
    const { id, enabled } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "缺少 id" });
    const r = await runOpenclaw(["plugins", enabled ? "enable" : "disable", String(id)], { timeoutMs: 60000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-800) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 免费分享：填 ClawHub 包名推荐，或上传自己的 zip 插件包
app.post("/api/plugins/share", async (req, res) => {
  try {
    const { name, descZh, category, pkg, zipBase64, fileName } = req.body ?? {};
    if (!name || !descZh) return res.status(400).json({ error: "名称和简介必填" });
    const cat = CATEGORY_LABELS[category] ? category : "other";
    const id = "sp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let storePkg = String(pkg ?? "").trim();
    if (zipBase64) {
      const zipPath = await saveUploadedZip(id, String(zipBase64));
      storePkg = "bundle";
      await addMarketPlugin({ id, type: "userShared", pkg: "bundle", name, descZh, category: cat, source: "用户分享", zip: zipPath.replace(/\\/g, "/").replace(dataDir().replace(/\\/g, "/") + "/plugin-market/", ""), uploadedAt: new Date().toISOString() });
    } else {
      if (!storePkg) return res.status(400).json({ error: "请填 ClawHub 包名（如 clawhub:xxx）或上传 zip" });
      await addMarketPlugin({ id, type: "userShared", pkg: storePkg, name, descZh, category: cat, source: "用户分享", uploadedAt: new Date().toISOString() });
    }
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 付费上架：用户上传自己的插件 zip + 自主定价（我们按 feeRate 收手续费）
app.post("/api/plugins/sell", async (req, res) => {
  try {
    const { name, descZh, category, price, zipBase64, fileName } = req.body ?? {};
    if (!name || !descZh || !zipBase64) return res.status(400).json({ error: "名称/简介/插件包(zip)必填" });
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: "价格必须大于 0" });
    if (p > 99999) return res.status(400).json({ error: "价格过大" });
    const cat = CATEGORY_LABELS[category] ? category : "other";
    const id = "pd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const zipPath = await saveUploadedZip(id, String(zipBase64));
    const catalog = await readCatalog();
    const { fee, sellerGets } = splitPrice(p, catalog.feeRate);
    await addMarketPlugin({
      id, type: "paid", pkg: "bundle", name, descZh, category: cat, source: "用户上架",
      price: p, sales: 0, zip: zipPath.replace(/\\/g, "/").replace(dataDir().replace(/\\/g, "/") + "/plugin-market/", ""),
      uploadedAt: new Date().toISOString(),
    });
    res.json({ ok: true, id, fee, sellerGets, feeRate: catalog.feeRate });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 购买付费插件：先记账（支付通道待开通），返回安装结果
app.post("/api/plugins/purchase", async (req, res) => {
  try {
    const { id } = req.body ?? {};
    const plugin = await getMarketPlugin(String(id ?? ""));
    if (!plugin) return res.status(404).json({ error: "插件不存在" });
    if (plugin.type !== "paid") return res.status(400).json({ error: "只有付费区插件可以购买" });
    const catalog = await readCatalog();
    const { fee } = splitPrice(plugin.price ?? 0, catalog.feeRate);
    await recordSale({ pluginId: plugin.id, name: plugin.name, seller: plugin.source, price: plugin.price ?? 0, fee, buyer: "local" });
    let install: { code: number; output: string } | null = null;
    if (plugin.pkg === "bundle") {
      install = await installBundlePlugin(plugin);
      if (install.code !== 0) {
        return res.status(500).json({ ok: false, error: "安装失败（款已记账）：" + install.output.slice(-500) });
      }
    }
    res.json({ ok: true, name: plugin.name, price: plugin.price, fee, install: install ? { ok: install.code === 0, output: install.output.slice(-500) } : null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/plugins/sales", async (_req, res) => {
  try {
    res.json(await listSales());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 从商店目录下架（自己的分享/付费条目；不卸载已安装的插件）
app.post("/api/plugins/remove", async (req, res) => {
  try {
    const { id } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "缺少 id" });
    await removeMarketPlugin(String(id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`openclaw-shell 已启动: http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
  // 生图图片自动清理：启动清一次 + 每天清一次（_test 试生图超 15 天删；正式图超 retentionDays 删）
  void cleanupImages().then((r) => {
    if (r.removed > 0) console.log(`图片自动清理：已删除 ${r.removed} 张过期图片`);
  });
  setInterval(() => void cleanupImages(), 24 * 3600 * 1000);
});
