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
  cancelChannelLogin,
} from "./core/openclawCli.js";
import {
  listProviders,
  saveProvider,
  deleteProvider,
  fetchModels,
  resolveChatLLM,
} from "./core/providers.js";
import { runDistill } from "./distiller/pipeline.js";
import { parsePlainText } from "./distiller/parser.js";
import { RELATION_ROLES } from "./core/schema.js";
import { buildChatSystemAsync } from "./core/chatPrompt.js";
import {
  listPresets,
  addGroup as addPresetGroup,
  renameGroup as renamePresetGroup,
  deleteGroup as deletePresetGroup,
  addItem as addPresetItem,
  updateItem as updatePresetItem,
  deleteItem as deletePresetItem,
  resetBuiltinPresets,
  resolveCardPresetBlocks,
  resolveCardPresetExamples,
  type PresetKind,
  type PresetRole,
} from "./core/presets.js";
import { sanitizeChatReply } from "./core/sanitize.js";
import { claimGreeting, isGreeted, clearGreeted } from "./core/greetedStore.js";
import {
  runLifeTick,
  applyLifeConfig,
  recordUserContact,
  readQQKnownUsers,
  readWXKnownUsers,
  buildMoodPrompt,
  type LifeState,
} from "./core/lifeScheduler.js";
import { TOOL_REGISTRY, toolsToOpenAI, resolveInSandbox, type ToolDef, type ToolCtx } from "./tools/registry.js";
import { FEATURES, filterDisabledTools } from "./core/features.js";
import { toUserError } from "./core/errors.js";
import { queryLogs, clearLogs, logInfo, logWarn, logError } from "./core/logger.js";
import { cardToCCv2, ccv2ToCard } from "./core/cardConvert.js";
import { solidPng, pngWithTexts, extractCardJson, pngStripCardMeta, isPng } from "./core/png.js";
import { getImageConfig, saveImageConfig, maskKey, testNovelaiKey, testOpenAIImageKey } from "./core/imageConfig.js";
import { coversDir, saveCover, readCover, normalizeAvatar } from "./core/covers.js";
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
import QRCode from "qrcode";
import {
  listEmojis,
  addEmoji,
  updateEmoji,
  removeEmoji,
  emojiUrl,
  buildEmojiPrompt,
  migrateLegacyEmojis,
  listGroups,
  addGroup,
  renameGroup,
  deleteGroup,
  moveEmojiToGroup,
  MAX_EMOJIS,
} from "./core/emojiStore.js";
import {
  listBots,
  addBot,
  removeBot,
  getBotByCard,
  agentWorkspaceDir,
  applyAgentHumanDelay,
  applyAgentModel,
  updateBotAccount,
  CHANNEL_LABELS,
  MAX_QQ_BOTS,
  MAX_WEIXIN_BOTS,
  type BotChannel,
  type BotInstance,
} from "./core/botStore.js";
import {
  recall,
  appendEntry,
  deleteEntry,
  updateEntry,
  clearMemory,
  readAllMemories,
  exportMemoryToMarkdown,
  exportAllMemoriesToMarkdown,
  pushChatRound,
} from "./core/memoryStore.js";
import { appendConv, readConv, clearConv, type ConvSurface } from "./core/conversationStore.js";
import {
  pollSessionTurns,
  findSession,
  sessionKeyOf,
  clearObserveCursor,
  type MirrorTurn,
} from "./core/sessionMirror.js";

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
    res.status(401).json({ error: "需要登录" });
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
app.use("/covers", express.static(coversDir(), { etag: true, maxAge: 0 }));
// 语音合成产物
// 语音不再落盘（/api/tts/synthesize 直接回音频流），所以没有 /tts 静态目录

// ---------- API ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "soulbox", schema: SCHEMA_VERSION, port: PORT, dataDir: dataDir() });
});

// ---------- 运行日志（设置页直接看，出问题不用翻文件） ----------
app.get("/api/logs", (req, res) => {
  try {
    res.json(
      queryLogs({
        level: (req.query.level as "info" | "warn" | "error" | "all") ?? "all",
        tag: typeof req.query.tag === "string" ? req.query.tag : "all",
        keyword: typeof req.query.q === "string" ? req.query.q : "",
        limit: Number(req.query.limit) || 200,
      })
    );
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/logs/clear", (_req, res) => {
  clearLogs();
  res.json({ ok: true });
});

// ---------- 用户资料（抽屉头像/昵称，可编辑） ----------
const PROFILE_FILE = () => path.join(dataDir(), "user-profile.json");
app.get("/api/profile", async (_req, res) => {
  try {
    const p = JSON.parse(await fs.readFile(PROFILE_FILE(), "utf8"));
    res.json({ name: p.name ?? "本地用户", avatar: p.avatar ?? "", bio: p.bio ?? "" });
  } catch {
    res.json({ name: "本地用户", avatar: "", bio: "" });
  }
});
app.post("/api/profile", async (req, res) => {
  try {
    const { name, avatar, bio } = req.body ?? {};
    const profile = {
      name: String(name ?? "").trim().slice(0, 40) || "本地用户",
      avatar: typeof avatar === "string" && avatar.startsWith("data:image/") && avatar.length < 1_500_000 ? avatar : "",
      // 用户自我简介：注入聊天 prompt，让 AI 知道"你是谁"（可留空）
      bio: String(bio ?? "").trim().slice(0, 800),
    };
    await fs.writeFile(PROFILE_FILE(), JSON.stringify(profile), "utf8");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/** 读用户资料（供聊天 prompt 注入用户身份） */
async function readUserProfile(): Promise<{ name: string; bio: string }> {
  try {
    const p = JSON.parse(await fs.readFile(PROFILE_FILE(), "utf8"));
    return { name: String(p.name ?? "").trim(), bio: String(p.bio ?? "").trim() };
  } catch {
    return { name: "", bio: "" };
  }
}

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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/cards", async (_req, res) => {
  try {
    const metas = await store.list();
    // 旧卡还存着 base64 头像时，一次性迁移成 /covers/ 文件 URL（list 卡库缩略图不能扛 2MB base64）
    for (const m of metas) {
      if (typeof m.avatar === "string" && m.avatar.startsWith("data:image/")) {
        const migrated = await normalizeAvatar(m.avatar, m.slug);
        if (migrated !== m.avatar) {
          m.avatar = migrated;
          const card = await store.get(m.slug).catch(() => null);
          if (card) {
            card.identity.avatar = migrated;
            await store.save(card).catch(() => {});
          }
        }
      }
    }
    res.json({ cards: metas });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/cards/:slug", async (req, res) => {
  try {
    const card = await store.get(req.params.slug);
    const migrated = await normalizeAvatar(card.identity?.avatar, card.slug);
    if (migrated !== card.identity?.avatar) {
      card.identity.avatar = migrated;
      await store.save(card).catch(() => {});
    }
    res.json(card);
  } catch {
    res.status(404).json({ error: "找不到这张卡，可能已被删除" });
  }
});

// ---------- 开场白：领取 / 查询 / 清除（避免冷场 + 不重复触发） ----------
// userKey 由调用方传：本地聊天用 "local"，通道侧用 "qq:<openid>" / "wx:<openid>"。
// claim = 原子领取：首次返回 first_mes 并标记已开场；已开场过返回 null（前端不再显示）。
app.post("/api/cards/:slug/greeting/claim", async (req, res) => {
  try {
    const { userKey } = req.body ?? {};
    const card = await store.get(req.params.slug);
    const firstMes = card.sillytavern_v2?.first_mes?.trim() ?? "";
    const text = await claimGreeting(card.slug, String(userKey ?? ""), firstMes);
    res.json({ greeted: text !== null, text });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/cards/:slug/greeting", async (req, res) => {
  try {
    const card = await store.get(req.params.slug);
    const userKey = String(req.query.userKey ?? "");
    const greeted = await isGreeted(card.slug, userKey);
    res.json({ greeted, firstMes: card.sillytavern_v2?.first_mes?.trim() ?? "" });
  } catch {
    res.status(404).json({ error: "找不到这张卡，可能已被删除" });
  }
});

app.post("/api/cards/:slug/greeting/clear", async (req, res) => {
  try {
    const { userKey } = req.body ?? {};
    const card = await store.get(req.params.slug);
    await clearGreeted(card.slug, userKey ? String(userKey) : undefined);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.put("/api/cards/:slug", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (body.slug && body.slug !== req.params.slug) {
      return res.status(400).json({ error: "卡片的英文标识不能改（如需更名请新建一张）" });
    }
    body.slug = req.params.slug;
    body.updated_at = nowIso();
    const tv0 = Date.now();
    const result = validateCard(body);
    const tv1 = Date.now();
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    if (body.identity?.avatar) {
      body.identity.avatar = await normalizeAvatar(body.identity.avatar, body.slug);
    }
    await store.save(body);
    const tv2 = Date.now();
    // AI 生命配置变更 → 同步到调度状态（intervalHours=0 时清空冷却）
    if (body.life) {
      await applyLifeConfig(body.slug, body.life).catch(() => {});
    }
    // 卡的变化 → 通道端（QQ/微信）：有绑定机器人时自动重编译 workspace + 同步模型/节奏。
    // 之前只靠手动点「重新应用」，改模型/人设后通道端一直用旧配置。
    let channelSyncNote = "";
    if (await getBotByCard(body.slug).catch(() => null)) {
      try {
        channelSyncNote = await syncCardToChannel(body as PersonaCard);
        logInfo("通道同步", `${body.name ?? body.slug} ${channelSyncNote}`);
      } catch (e) {
        logWarn("通道同步", `卡片保存后同步通道失败：${toUserError(e)}`);
      }
    }
    logInfo(
      "卡片",
      `更新 ${body.name ?? body.slug} 共 ${tv2 - tv0}ms`,
      `体积 ${Math.round(JSON.stringify(body).length / 1024)}KB · 校验 ${tv1 - tv0}ms · 落盘 ${tv2 - tv1}ms`
    );
    res.json({ card: body, warnings: result.warnings, channelSync: channelSyncNote || undefined });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    // 对话日志（每卡统一 <slug>.chatlog.jsonl，含历史按用户拆分的旧文件一并清）
    for (const f of await fs.readdir(path.join(root, "memory")).catch(() => [])) {
      if (f.startsWith(`${slug}.`) && f.endsWith(".chatlog.jsonl")) {
        await fs.rm(path.join(root, "memory", f), { force: true }).catch(() => {});
      }
    }
    // 工作区文件是所有卡共享的，删卡不动它；只清这张卡专属的目录
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
    invalidateChannelStatus();
    res.json({ ok: true, removedBots });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/**
 * 编译人设卡到通道端。写两个地方，缺一不可：
 * - `data/agent-workspaces/<slug>`：该卡专属 agent 读这里，多机器人互不覆盖；
 * - `data/workspace`（共享）：`agents.defaults.workspace` 指向它，凡是没有显式 workspace 的 agent
 *   （包括默认的 `main`）都读这里。只写前者的话，消息落到 main 时会读到"上一次编译的别的卡"，
 *   表现就是"绑定了 A 卡，QQ 里回话的却是 B 卡"。
 */
async function compileForBot(card: PersonaCard): Promise<{ workspace: string; files: string[] }> {
  const parsed = personaCardSchema.parse(card); // 补全默认字段，避免残缺卡编译崩溃
  const out = await compileCard(parsed, agentWorkspaceDir(parsed.slug));
  await compileCard(parsed, path.join(dataDir(), "workspace")).catch(() => {});
  return out;
}

/** 卡片保存后把变化同步到通道端：重编译 agent workspace + 同步模型/节奏。
 *  仅当该卡有绑定机器人时调用（卡片改动不再需要手动点「重新应用」）。 */
async function syncCardToChannel(card: PersonaCard): Promise<string> {
  const bot = await getBotByCard(card.slug);
  if (!bot) return "";
  const notes: string[] = [];
  // ① 重编译：人设/世界书/预设/开场白/表情分组 → agent workspace（SKILL.md 等）
  const out = await compileForBot(card);
  notes.push(`已重编译 ${out.files.length} 个文件`);
  // ② 模型：卡的高级配置改了模型 → agent 模型（agents add 只写了一次，必须这里同步）
  const llm = await resolveChatLLM(card);
  if (llm) {
    const model = `${llm.provider}/${llm.model}`;
    const changed = await applyAgentModel(bot.agentId, model).catch(() => false);
    if (changed) notes.push(`模型已切到 ${model}（重启网关后生效）`);
  }
  // ③ 节奏：humanDelay 同步（与创建/重编译接口一致）
  await applyAgentHumanDelay(bot.agentId, card.chat?.delay).catch(() => {});
  return notes.join("；");
}

app.post("/api/cards/:slug/compile", async (req, res) => {
  try {
    const card = await store.get(req.params.slug).catch(() => null);
    if (!card) return res.status(404).json({ error: "找不到这张卡，可能已被删除" });
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    const out = await compileForBot(card);
    res.json({ workspace: out.workspace, files: out.files, warnings: result.warnings });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 通道状态：读 openclaw 的结构化输出，不靠文本正则猜 ----------
// `channels status --probe` 的纯文本在"没有账号"时只打印 "Gateway reachable."，
// 拿它做正则永远判不出已连接；--json 直接给 configured/connected/running 和账号列表。
interface ChannelStatus {
  configured: boolean;
  connected: boolean;
  running: boolean;
  accounts: string[];
}

let channelStatusCache: { at: number; data: Record<string, ChannelStatus> } | null = null;
let channelStatusInflight: Promise<Record<string, ChannelStatus>> | null = null;
// 查一次要跑 CLI（冷启动 30s+），缓存短了等于没缓存；绑定成功等状态变化时会主动失效
const CHANNEL_STATUS_CACHE_MS = 5 * 60 * 1000;

function invalidateChannelStatus(): void {
  channelStatusCache = null;
}

async function getChannelStatuses(force = false): Promise<Record<string, ChannelStatus>> {
  if (!force && channelStatusCache && Date.now() - channelStatusCache.at < CHANNEL_STATUS_CACHE_MS) {
    return channelStatusCache.data;
  }
  // 并发合并：进通道页会同时查微信和 QQ，CLI 冷启动 5-15s，并行跑只会互相拖慢
  if (channelStatusInflight) return channelStatusInflight;
  channelStatusInflight = (async () => {
    const out: Record<string, ChannelStatus> = {};
    try {
      // 超时给足：CLI 冷启动实测能到 30s+，卡在超时上只会拿到被截断的输出，解析必然失败
      const r = await runOpenclaw(["channels", "status", "--probe", "--json"], { timeoutMs: 90000 });
      const text = stripAnsi(r.stdout).trim();
      // 个别版本会在 JSON 前多打提示行，从第一个 { 开始截
      const raw = JSON.parse(text.startsWith("{") ? text : text.slice(Math.max(0, text.indexOf("{"))));
      const accounts = (raw?.channelAccounts ?? {}) as Record<string, unknown[]>;
      for (const [id, st] of Object.entries((raw?.channels ?? {}) as Record<string, Record<string, unknown>>)) {
        // 账号字段是 accountId（不是 id）；顺带取每个账号的连通性——通道级 connected
        // 对微信这类无长连接的通道恒为 false，得看账号级才准
        const accList = Array.isArray(accounts[id]) ? (accounts[id] as Record<string, unknown>[]) : [];
        const accIds = accList.map((a) => String(a?.accountId ?? a?.id ?? a)).filter((s) => s && s !== "[object Object]");
        const anyAccountLive = accList.some((a) => a?.connected === true || a?.running === true || a?.configured === true);
        out[id] = {
          configured: st?.configured === true,
          connected: st?.connected === true || anyAccountLive,
          running: st?.running === true,
          accounts: accIds,
        };
      }
      channelStatusCache = { at: Date.now(), data: out };
    } catch (e) {
      // CLI 挂了/输出不是 JSON：返回空对象，调用方按"未知"处理，不要断言未连接
      logWarn("通道", "查询通道状态失败（按未知处理）", e instanceof Error ? e.message : String(e));
    }
    return out;
  })();
  try {
    return await channelStatusInflight;
  } finally {
    channelStatusInflight = null;
  }
}

/** 通道是否可用：账号已配置即算接上（connected 只在长连接型通道上有意义） */
function channelUsable(st?: ChannelStatus): boolean {
  if (!st) return false;
  return st.configured || st.connected || st.accounts.length > 0;
}

// ---------- 通道：微信 ----------
app.get("/api/channels/wechat/status", async (req, res) => {
  try {
    const all = await getChannelStatuses(req.query.refresh === "1");
    const st = all["openclaw-weixin"];
    res.json({
      connected: channelUsable(st),
      accounts: st?.accounts ?? [],
      detail: st ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/channels/wechat/login", (_req, res) => {
  res.json(startChannelLogin("openclaw-weixin"));
});

// 从 CLI 登录输出里揪出二维码链接（微信 weixin.qq.com/q/xxx，QQ q.qq.com/... 或带 qrcode= 的 URL），
// 后端用 qrcode 库渲染成高清 PNG dataURL，前端 <img> 直接显示——不再靠终端 ASCII 二维码（糊且会被容器裁切）
function extractQrUrl(output: string): string | null {
  if (!output) return null;
  const patterns = [
    /https?:\/\/[^\s"'）)]*qrcode=[^\s"'）)]+/i,
    /https?:\/\/(?:short\.)?weixin\.qq\.com\/[^\s"'）)]+/i,
    /https?:\/\/q\.qq\.com\/[^\s"'）)]+/i,
    /https?:\/\/[^\s"'）)]*(?:qr|login|bind)[^\s"'）)]*/i,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return m[0].replace(/[.,;：。]+$/, "");
  }
  return null;
}
async function loginStateWithQr(state: import("./core/openclawCli.js").ChannelLoginState) {
  const url = extractQrUrl(state.output);
  let qrDataUrl: string | undefined;
  if (url) {
    qrDataUrl = await QRCode.toDataURL(url, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#201d18", light: "#ffffff" },
    }).catch(() => undefined);
  }
  return { ...state, qrUrl: url ?? undefined, qrDataUrl };
}

app.get("/api/channels/wechat/login", async (_req, res) => {
  res.json(await loginStateWithQr(getChannelLoginState("openclaw-weixin")));
});

app.get("/api/channels/wechat/pairing", async (_req, res) => {
  try {
    const r = await runOpenclaw(["pairing", "list", "openclaw-weixin"], { timeoutMs: 20000 });
    res.json({ raw: stripAnsi(r.stdout + r.stderr) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/channels/wechat/pairing/approve", async (req, res) => {
  try {
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: "缺少 code" });
    const r = await runOpenclaw(["pairing", "approve", "openclaw-weixin", String(code)], { timeoutMs: 20000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-1000) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 通道：QQ (官方开放平台 qqbot) ----------
app.get("/api/channels/qq/status", async (req, res) => {
  try {
    const all = await getChannelStatuses(req.query.refresh === "1");
    const st = all["qqbot"];
    res.json({
      // 通道在 openclaw 的清单里出现即说明插件已装（不用再单独跑一次 plugins list）
      pluginInstalled: st !== undefined,
      connected: channelUsable(st),
      accounts: st?.accounts ?? [],
      detail: st ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/channels/qq/login", (_req, res) => {
  res.json(startChannelLogin("qqbot"));
});

app.get("/api/channels/qq/login", async (_req, res) => {
  res.json(await loginStateWithQr(getChannelLoginState("qqbot")));
});

// 取消扫码：前端关掉二维码弹窗/离开页面时调。登录进程会一直挂着等扫码（实测能占 200MB+），必须回收
app.post("/api/channels/:kind/login/cancel", (req, res) => {
  const kind = String(req.params.kind);
  const channel = kind === "qq" ? "qqbot" : kind === "wechat" ? "openclaw-weixin" : "";
  if (!channel) return res.status(400).json({ error: "未知通道" });
  res.json({ ok: cancelChannelLogin(channel) });
});

app.post("/api/bots/:id/login/cancel", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人不存在" });
    res.json({ ok: cancelChannelLogin(bot.channel, bot.accountId) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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

// ---------- 已认证渠道账号仓库（免扫码复用的依据） ----------
interface KnownAccount {
  channel: BotChannel;
  accountId: string;
  name?: string;
  authed: boolean; // 凭证在 → 可免扫码复用
}

/** 扫描已认证渠道账号：QQ 读 openclaw.json channels.qqbot（默认+多账号），微信读插件账号索引 */
async function scanKnownAccounts(): Promise<KnownAccount[]> {
  const out: KnownAccount[] = [];
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"));
    const qq = cfg.channels?.qqbot ?? {};
    // 默认账号（扫码绑定写到 channels.qqbot 根）
    if (qq.appId) out.push({ channel: "qqbot", accountId: "default", name: qq.name ?? "QQ 默认机器人", authed: true });
    // 多账号（channels.qqbot.accounts.<id>）
    for (const [accountId, acc] of Object.entries(qq.accounts ?? {})) {
      const a = acc as { appId?: string; name?: string };
      if (a.appId) out.push({ channel: "qqbot", accountId, name: a.name ?? accountId, authed: true });
    }
  } catch { /* openclaw.json 读不到就跳过 QQ */ }
  // 微信：账号索引（多账号现实很少用，但机制一致）
  try {
    const wxIdx = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts.json");
    const list = JSON.parse(await fs.readFile(wxIdx, "utf8"));
    if (Array.isArray(list)) {
      for (const id of list) {
        if (typeof id === "string" && id) out.push({ channel: "openclaw-weixin", accountId: id, name: id, authed: true });
      }
    }
  } catch { /* 微信未登录过则无账号 */ }
  return out;
}

/**
 * 校正 bot 的渠道账号 id。
 * 微信登录成功后，真实 accountId 是服务器下发的（形如 `xxxx-im-bot`），而我们创建 bot 时
 * 只能先填一个占位名（`wx-main`）。若不校正，`agents bind openclaw-weixin:wx-main` 指向的
 * 是个不存在的账号，微信消息永远路由不到这个 agent。
 * 做法：扫出该通道下真实存在、且没被别的 bot 占用的账号，改绑到它上面。
 */
async function reconcileBotAccount(bot: BotInstance): Promise<BotInstance | null> {
  const known = (await scanKnownAccounts()).filter((a) => a.channel === bot.channel);
  if (known.some((a) => a.accountId === bot.accountId)) return null; // 已经对得上
  const bots = await listBots();
  const taken = new Set(bots.filter((b) => b.id !== bot.id).map((b) => `${b.channel}:${b.accountId}`));
  const target = known.find((a) => !taken.has(`${a.channel}:${a.accountId}`));
  if (!target) return null;
  // 先解掉占位绑定（失败不致命：占位账号本来就不存在）
  await runOpenclaw(["agents", "unbind", "--agent", bot.agentId, "--bind", `${bot.channel}:${bot.accountId}`], {
    timeoutMs: 30000,
  }).catch(() => null);
  const bind = await runOpenclaw(
    ["agents", "bind", "--agent", bot.agentId, "--bind", `${bot.channel}:${target.accountId}`, "--json"],
    { timeoutMs: 30000 }
  );
  if (bind.code !== 0) return null;
  const updated = await updateBotAccount(bot.id, target.accountId);
  invalidateAgentsCache();
    invalidateChannelStatus();
  return updated;
}

/**
 * 修复缺失的路由绑定。
 * bots.json 里有实例、但 OpenClaw 的 routing bindings 里没有对应条目时，消息会落到默认
 * agent（用共享 workspace 的人设），表现就是"连上了却不是这张卡在回"。
 * 成因：agents add 时 bind 失败/后来被 agents delete 顺带清掉/手工改过配置。
 * 这里查一遍 bindings，缺的补上（幂等，已存在的不动）。
 */
async function repairBotBindings(bots: BotInstance[]): Promise<string[]> {
  if (bots.length === 0) return [];
  const r = await runOpenclaw(["agents", "bindings"], { timeoutMs: 60000 });
  const text = stripAnsi(r.stdout + r.stderr);
  if (r.code !== 0 || !/Routing bindings|No routing bindings/i.test(text)) return []; // CLI 没跑通就别乱补
  const repaired: string[] = [];
  for (const b of bots) {
    // 形如 "- <agentId> <- qqbot accountId=qq-xxxx"
    const hasBinding = new RegExp(`^-\\s+${b.agentId}\\s+<-\\s+${b.channel}\\s+accountId=${b.accountId}\\b`, "m").test(text);
    if (hasBinding) continue;
    const bind = await runOpenclaw(
      ["agents", "bind", "--agent", b.agentId, "--bind", `${b.channel}:${b.accountId}`, "--json"],
      { timeoutMs: 30000 }
    );
    if (bind.code === 0) {
      repaired.push(`${b.agentId} ← ${b.channel}:${b.accountId}`);
      logInfo("通道", `补齐缺失的路由绑定：${b.agentId} ← ${b.channel}:${b.accountId}`);
    }
  }
  if (repaired.length > 0) invalidateAgentsCache();
  return repaired;
}

/** 通道连接页数据：机器人实例 + 已知账号（含未绑定的可复用账号） */
app.get("/api/channels/connections", async (req, res) => {
  try {
    const bots = await listBots();
    const accounts = await scanKnownAccounts();
    // 顺手校正微信这类"真实账号 id 由服务器下发"的占位绑定（错过登录轮询也能自愈）
    let reconciled = 0;
    for (const b of bots) {
      if (!accounts.some((a) => a.channel === b.channel && a.accountId === b.accountId)) {
        const fixed = await reconcileBotAccount(b).catch(() => null);
        if (fixed) reconciled++;
      }
    }
    const freshBots = reconciled > 0 ? await listBots() : bots;
    // 补齐缺失的路由绑定（否则消息会落到默认 agent，表现为"回的不是这张卡"）
    const repaired = req.query.repair === "0" ? [] : await repairBotBindings(freshBots).catch(() => []);
    // 关联：账号 → 绑定它的 bot
    const boundByAccount = new Map<string, BotInstance>();
    for (const b of freshBots) boundByAccount.set(`${b.channel}:${b.accountId}`, b);
    // 卡名映射（前端要显示"正在连接哪张卡"，不能只给 slug）
    const cardNames = new Map<string, string>();
    for (const b of freshBots) {
      if (cardNames.has(b.cardSlug)) continue;
      const c = await store.get(b.cardSlug).catch(() => null);
      cardNames.set(b.cardSlug, c?.name ?? b.cardSlug);
    }
    const limits = { maxQq: MAX_QQ_BOTS, maxWeixin: MAX_WEIXIN_BOTS };
    res.json({
      bots: freshBots.map((b) => ({ ...b, cardName: cardNames.get(b.cardSlug) ?? b.cardSlug })),
      accounts: accounts.map((a) => {
        const bound = boundByAccount.get(`${a.channel}:${a.accountId}`);
        return {
          ...a,
          boundBotId: bound?.id ?? null,
          boundCardSlug: bound?.cardSlug ?? null,
          boundCardName: bound ? cardNames.get(bound.cardSlug) ?? bound.cardSlug : null,
        };
      }),
      limits,
      repaired,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/bots", async (req, res) => {
  try {
    const bots = await listBots();
    const limits = { maxQq: MAX_QQ_BOTS, maxWeixin: MAX_WEIXIN_BOTS };
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/bots", async (req, res) => {
  try {
    const { cardSlug, channel, accountId } = req.body ?? {};
    if (channel !== "qqbot" && channel !== "openclaw-weixin") {
      return res.status(400).json({ error: "请选择 QQ 或微信" });
    }
    const card = await store.get(String(cardSlug)).catch(() => null);
    if (!card) {
      return res.status(400).json({ error: "找不到这张卡，可能已被删除" });
    }
    if (!/^[a-z0-9-]+$/i.test(card.slug)) {
      return res.status(400).json({ error: "这张卡的英文标识含特殊字符，无法接入机器人，请重新建卡" });
    }
    const account = String(accountId ?? "").trim() || (channel === "qqbot" ? `qq-${Date.now().toString(36).slice(-4)}` : "wx-main");
    let bot: BotInstance;
    try {
      bot = await addBot({ cardSlug: card.slug, channel, accountId: account });
    } catch (e) {
      const msg = toUserError(e);
      // 账号被其他卡占用 → 409 + 占用者信息，前端引导"一键转移"
      const occupied = /已被其他机器人占用/.test(msg) || /账号.*占用/.test(msg);
      if (occupied) {
        const occupier = (await listBots()).find((b) => b.channel === channel && b.accountId === account);
        const occCard = occupier ? (await store.get(occupier.cardSlug).catch(() => null)) : null;
        return res.status(409).json({
          error: msg,
          conflict: true,
          occupiedBy: occupier ? { botId: occupier.id, cardSlug: occupier.cardSlug, cardName: occCard?.name ?? occupier.cardSlug } : null,
          accountId: account,
          channel,
        });
      }
      return res.status(400).json({ error: msg });
    }

    // ① 编译卡（agent 专属 workspace + 共享 workspace 兜底，见 compileForBot 注释）
    const compile = await compileForBot(card);

    // ② 解析模型：卡单独配置优先，否则默认提供商
    const llm = await resolveChatLLM(card);
    if (!llm) {
      await removeBot(bot.id);
      await fs.rm(agentWorkspaceDir(bot.cardSlug), { recursive: true, force: true }).catch(() => {});
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
    invalidateAgentsCache();
    invalidateChannelStatus(); // agent 列表变了，缓存作废
    // 拟真节奏：用卡里的 chat.delay 配 OpenClaw 原生 humanDelay（分段回复之间自然停顿）
    await applyAgentHumanDelay(bot.agentId, card.chat?.delay).catch(() => {});
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
      hint: "机器人已创建。下一步点「扫码绑定」登录账号；如果服务在跑，重启后生效。",
      agentExists: true, // 刚 add 成功，前端直接采信，不必再等 CLI 查一遍
    });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

// 免扫码绑定：把已认证渠道账号（凭证在）绑到已有 bot 的 agent（换绑，不重新扫码）
app.post("/api/bots/:id/bind", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    const { channel, accountId } = req.body ?? {};
    if (channel !== "qqbot" && channel !== "openclaw-weixin") return res.status(400).json({ error: "通道选择不正确" });
    const acc = String(accountId ?? "").trim();
    if (!acc) return res.status(400).json({ error: "缺少机器人编号" });
    // 校验账号已认证（凭证在 → 免扫码）
    const known = (await scanKnownAccounts()).find((a) => a.channel === channel && a.accountId === acc);
    if (!known) return res.status(400).json({ error: "该账号还没扫码认证过，无法免扫码绑定（先用扫码绑定创建）" });
    // 校验未被其他 bot 占用
    const others = (await listBots()).filter((b) => b.id !== bot.id);
    if (others.some((b) => b.channel === channel && b.accountId === acc)) {
      return res.status(409).json({ error: "该账号已被其他卡占用，可先删除或一键转移", conflict: true });
    }
    // 换绑：先解旧绑定，再绑新账号
    const unbind = await runOpenclaw(["agents", "unbind", "--agent", bot.agentId, "--bind", `${bot.channel}:${bot.accountId}`], { timeoutMs: 30000 });
    const bind = await runOpenclaw(["agents", "bind", "--agent", bot.agentId, "--bind", `${channel}:${acc}`], { timeoutMs: 30000 });
    if (bind.code !== 0) {
      return res.status(500).json({ error: `换绑失败：${stripAnsi(bind.stdout + bind.stderr).slice(-500)}` });
    }
    // 更新实例记录
    const bots = await listBots();
    const idx = bots.findIndex((b) => b.id === bot.id);
    bots[idx] = { ...bots[idx], channel, accountId: acc };
    await fs.writeFile(path.join(dataDir(), "bots.json"), JSON.stringify({ bots }, null, 2), "utf8");
    invalidateAgentsCache();
    invalidateChannelStatus();
    res.json({ ok: true, output: stripAnsi((unbind.stdout + bind.stdout + unbind.stderr + bind.stderr)).slice(-500), hint: "已换绑到已认证账号，网关重启后生效" });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 一键转移：把某账号的绑定从旧卡顶到新卡（复用同一账号，不扫码）
app.post("/api/bots/transfer", async (req, res) => {
  try {
    const { botId, toCardSlug } = req.body ?? {};
    const oldBot = (await listBots()).find((b) => b.id === String(botId ?? ""));
    if (!oldBot) return res.status(404).json({ error: "旧机器人实例不存在" });
    if (oldBot.cardSlug === toCardSlug) return res.status(400).json({ error: "目标卡和当前卡相同，无需转移" });
    const card = await store.get(String(toCardSlug)).catch(() => null);
    if (!card) return res.status(400).json({ error: `人设卡 ${toCardSlug} 不存在` });
    // 目标卡已有 bot？先顶掉它（以传入的 botId 为准）
    const targetExisting = (await listBots()).find((b) => b.cardSlug === toCardSlug && b.id !== oldBot.id);
    if (targetExisting) {
      const del = await runOpenclaw(["agents", "delete", targetExisting.agentId, "--force"], { timeoutMs: 60000 });
      if (del.code !== 0 && !/not found|no plugin/i.test(stripAnsi(del.stdout + del.stderr))) {
        return res.status(500).json({ error: `清理目标卡旧 agent 失败：${stripAnsi(del.stdout + del.stderr).slice(-400)}` });
      }
    }
    // ① 编译新卡
    const compile = await compileForBot(card);
    // ② 解析模型
    const llm = await resolveChatLLM(card);
    if (!llm) return res.status(400).json({ error: "没有可用模型（先在 API 页配置模型提供商）" });
    // ③ 建新 agent（复用旧账号，免扫码）+ bind
    const add = await runOpenclaw(
      ["agents", "add", card.slug, "--workspace", agentWorkspaceDir(card.slug), "--model", `${llm.provider}/${llm.model}`, "--bind", `${oldBot.channel}:${oldBot.accountId}`, "--non-interactive", "--json"],
      { timeoutMs: 60000 }
    );
    if (add.code !== 0 && !/already exist|已存在/i.test(stripAnsi(add.stdout + add.stderr))) {
      return res.status(500).json({ error: `创建新 agent 失败：${stripAnsi(add.stdout + add.stderr).slice(-500)}` });
    }
    // ④ 删旧 agent（旧卡被顶掉）
    const delOld = await runOpenclaw(["agents", "delete", oldBot.agentId, "--force"], { timeoutMs: 60000 });
    invalidateAgentsCache();
    invalidateChannelStatus();
    // ⑤ 更新记录：旧 bot 记录改为新卡（同一 id，账号不变）
    const bots = await listBots();
    const idx = bots.findIndex((b) => b.id === oldBot.id);
    if (idx >= 0) {
      bots[idx] = { ...bots[idx], cardSlug: card.slug, agentId: card.slug };
    }
    // 目标卡原有 bot 记录移除（被顶掉）
    const cleaned = bots.filter((b) => b.id !== targetExisting?.id);
    await fs.writeFile(path.join(dataDir(), "bots.json"), JSON.stringify({ bots: cleaned }, null, 2), "utf8");
    res.json({
      ok: true,
      bot: cleaned[idx],
      compileFiles: compile.files,
      output: stripAnsi((add.stdout + add.stderr + delOld.stdout + delOld.stderr)).slice(-600),
      hint: `已将 ${oldBot.channel === "qqbot" ? "QQ" : "微信"} 账号 ${oldBot.accountId} 从旧卡转移到「${card.name}」，凭证复用未重新扫码，网关重启后生效`,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/bots/:id/login", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    res.json(startChannelLogin(bot.channel, bot.accountId));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/bots/:id/login", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    const state = getChannelLoginState(bot.channel, bot.accountId);
    const payload = await loginStateWithQr(state);
    // 登录成功后校正 accountId：微信的真实账号 id 由服务器下发（形如 xxxx-im-bot），
    // 我们建 bot 时先占了个 wx-main 之类的占位名。不校正的话绑定会指向一个不存在的账号，
    // 消息永远路由不到这个 agent。
    if (state.done && state.ok) {
      const fixed = await reconcileBotAccount(bot).catch(() => null);
      if (fixed) return res.json({ ...payload, accountFixed: fixed.accountId });
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 卡片更新后重编译到该 agent 的 workspace
app.post("/api/bots/:id/recompile", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    const card = personaCardSchema.parse(await store.get(bot.cardSlug));
    const out = await compileForBot(card);
    // 卡里的节奏改了也要同步到 agent（humanDelay 在 openclaw.json 里）
    await applyAgentHumanDelay(bot.agentId, card.chat?.delay).catch(() => {});
    // 卡片专属模型改了也要跟着更新：模型只在 agents add 时写过一次，
    // 不在这里同步的话用户改完模型点了"重新应用"，通道端还在用旧模型。
    let modelNote = "";
    const llm = await resolveChatLLM(card);
    if (llm) {
      const model = `${llm.provider}/${llm.model}`;
      const changed = await applyAgentModel(bot.agentId, model).catch(() => false);
      if (changed) modelNote = `，模型已切到 ${model}（网关重启后生效）`;
    }
    res.json({ ok: true, files: out.files, workspace: out.workspace, modelNote });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.delete("/api/bots/:id", async (req, res) => {
  try {
    const bot = await removeBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    const del = await runOpenclaw(["agents", "delete", bot.agentId, "--force"], { timeoutMs: 60000 });
    invalidateAgentsCache();
    invalidateChannelStatus();
    res.json({
      ok: true,
      output: stripAnsi(del.stdout + del.stderr).slice(-800),
      hint: "机器人已删除。重启服务后彻底移除。",
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    const { idea, role, model } = req.body ?? {};
    const ideaText = String(idea ?? "").trim();
    if (!ideaText) return res.status(400).json({ error: "先描述你的想法，AI 才能帮你生成草稿" });
    const r = role && RELATION_ROLES.includes(role) ? role : "friend";
    // 允许指定模型（"提供商::模型"）；不传用默认提供商
    const draftModel = typeof model === "string" && model.trim() ? model.trim() : "";
    const llm = draftModel
      ? await resolveChatLLM({ model: { provider: draftModel.split("::")[0], model: draftModel.split("::")[1] ?? undefined } })
      : await resolveChatLLM();
    if (!llm) return res.status(400).json({ error: "未配置模型 API。请先到「API 与模型」页添加提供商并设为默认" });


    // 封面提示词风格跟随当前生图提供商：NovelAI=英文标签 / OpenAI=英文自然语言
    const imgCfg = await getImageConfig();
    const coverPromptRule =
      imgCfg.provider === "novelai"
        ? `"cover_prompt": "角色卡封面的生图提示词：用英文 Danbooru 标签风格（逗号分隔的英文标签，禁止中文和自然语言），体现角色外观（发型/瞳色/服装/气质）、角色所处场景与氛围（贴合世界观）、封面式构图（角色融入场景、适合竖版封面，不是证件照头像）；若是同人/已有作品角色，官方英文名或常用角色 Tag 放最前；只输出标签串",`
        : `"cover_prompt": "角色卡封面的生图提示词：用英文自然语言写 2-3 句连贯的英文句子（必须全英文，内容含角色外观、服饰、所处场景、氛围光线、竖版封面构图，角色融入场景而不是证件照头像）",`;
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
  "regex": [],
  ${coverPromptRule}
}
3. 世界书 3-6 条；「人物形象」必须 constant=true 且内容完整（这是角色扮演的核心依据）
4. 语言风格要具体可执行：给出日常/情绪波动时不同的说话方式示例
5. 全程中文输出（cover_prompt 必须全英文，除外）；regex 一般留空数组
6. cover_prompt 根据角色设定生成：必须全英文，体现"根据角色内容生成的封面"（角色在其世界场景中的画面），不要写成头像/证件照

## 写卡铁律（必须遵守，违反即不合格）
1. 所有设定用「陈述性条目」写，禁止小说式描写、禁止环境铺陈、禁止形容词堆砌。
   ❌ 错误示例："她站在月光下的窗前，微风拂过她的发梢，眼神中带着一丝落寞……"
   ✅ 正确示例："外貌：银白色长发，蓝瞳；性格：外冷内热，嘴硬心软；习惯：紧张时咬嘴唇。"
2. 「人物形象」只写角色的静态事实（身份/外貌/性格/语言习惯/喜好/雷区），
   不要写动态剧情、不要写场景、不要写任何叙事性文字。
3. 「世界观」只写角色需要知道的规则与背景，≤3 条核心事实；不写风土人情的长篇介绍。
4. 字数上限：人物形象 ≤400 字，世界观 ≤200 字，其余条目 ≤150 字。
5. 语言风格给「可执行规则 + 1-2 个对话示例」，不要抽象形容词（如"温柔""可爱"要落到具体句式）。
6. 整张卡的目的是「让模型能扮演这个角色」，不是「写一篇小说」——所有内容都要是
   扮演时可直接依据的设定，禁止任何与扮演无关的叙事、抒情或氛围描写。`;

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
      return res.status(500).json({ error: e instanceof Error && e.name === "AbortError" ? "模型响应超时（90 秒），换个模型或稍后再试" : toUserError(e, "调用模型失败") });
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

    const coverPrompt = String(parsed.cover_prompt ?? "").trim().slice(0, 800);
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
    logInfo("卡片", `AI 草稿 ${draft.name} 完成`, `封面提示词 ${coverPrompt ? coverPrompt.length + " 字符" : "无"}`);
    res.json({ draft, warnings: vr.warnings, coverPrompt });
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
      (cfg.provider === "openai" && cfg.openai.baseUrl && cfg.openai.key);
    if (!ready) {
      return res.json({ ok: false, info: "未配置生图：到「生图配置」页填好 Key 后回来一键生成封面" });
    }
    const { generateImage } = await import("./core/imageGen.js");
    const r = await generateImage({ prompt, aspect: "portrait" });
    if (!r.ok || !r.buffer) return res.json({ ok: false, error: r.error ?? "生成失败" });
    const coverSlug = String(req.body?.slug ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "cover";
    const url = await saveCover(coverSlug, r.buffer, r.mimeType);
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/providers/save", async (req, res) => {
  try {
    const { type, name, baseUrl, apiKey, models } = req.body ?? {};
    if (type !== "chat" && type !== "image") return res.status(400).json({ error: "类型不正确" });
    const entry = await saveProvider(type, { name, baseUrl, apiKey, models });
    res.json({ ok: true, entry: { ...entry, apiKey: entry.apiKey.slice(0, 6) + "…" } });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

app.post("/api/providers/delete", async (req, res) => {
  try {
    const { type, name } = req.body ?? {};
    if ((type !== "chat" && type !== "image") || !name) return res.status(400).json({ error: "缺少 type / name" });
    await deleteProvider(type, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    res.status(502).json({ error: toUserError(e) });
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
    res.status(400).json({ error: toUserError(e) });
  }
});

// 停用 / 启用某个提供商（配置保留，不参与选择与解析）
app.post("/api/providers/toggle", async (req, res) => {
  try {
    const { type, name, enabled } = req.body ?? {};
    if ((type !== "chat" && type !== "image") || !name) return res.status(400).json({ error: "缺少 type / name" });
    const { setProviderEnabled } = await import("./core/providers.js");
    const p = await setProviderEnabled(type, name, enabled !== false);
    res.json({ ok: true, name: p.name, enabled: p.enabled });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/cards/import", async (req, res) => {
  try {
    const t0 = Date.now();
    const card = req.body?.card;
    if (!card) return res.status(400).json({ error: "缺少 card" });
    const bodyKB = Math.round(JSON.stringify(card).length / 1024);
    // 解析补全默认字段后保存（做卡/导入的卡可能只填了部分字段）
    const parsed = personaCardSchema.safeParse(card);
    const tParse = Date.now();
    if (!parsed.success) {
      return res.status(400).json({ error: "卡片内容不合规：" + validateCard(card).errors.slice(0, 3).join("；") });
    }
    const result = validateCard(parsed.data);
    const tValidate = Date.now();
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    if (parsed.data.identity?.avatar) {
      parsed.data.identity.avatar = await normalizeAvatar(parsed.data.identity.avatar, parsed.data.slug);
    }
    await store.save(parsed.data);
    const tSave = Date.now();
    logInfo(
      "卡片",
      `保存 ${parsed.data.name} 共 ${tSave - t0}ms`,
      `体积 ${bodyKB}KB · schema ${tParse - t0}ms · 校验 ${tValidate - tParse}ms · 落盘 ${tSave - tValidate}ms`
    );
    res.json({ card: parsed.data });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 角色卡导出 / 导入（PNG / JSON，CCv2 标准） ----------
/** 导出文件名：用角色原名（去 Windows 非法字符），不用内部 slug */
function exportBaseName(card: PersonaCard): string {
  const n = (card.name || card.slug || "角色卡").replace(/[\\/:*?"<>|\r\n]+/g, "-").trim().slice(0, 60);
  return n || "角色卡";
}

async function buildCardExport(card: PersonaCard, format: string): Promise<{ filename: string; dataUrl: string }> {
  if (format === "chatlog") {
    // 聊天记录导出：data/memory/<slug>.chatlog.jsonl → 可读 JSON
    const logFile = path.join(dataDir(), "memory", `${card.slug}.chatlog.jsonl`);
    const raw = await fs.readFile(logFile, "utf8").catch(() => "");
    const messages = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          const m = JSON.parse(l) as { u?: string; a?: string; t?: string };
          return { user: m.u ?? "", assistant: m.a ?? "", time: m.t ?? "" };
        } catch { return null; }
      })
      .filter((x): x is { user: string; assistant: string; time: string } => Boolean(x?.user || x?.assistant));
    const json = JSON.stringify({ card: card.name, exported_at: new Date().toISOString(), messages }, null, 2);
    return {
      filename: `${exportBaseName(card)}-聊天记录.json`,
      dataUrl: "data:application/json;charset=utf-8," + encodeURIComponent(json),
    };
  }
  const cc = cardToCCv2(card);
  const json = JSON.stringify(cc, null, 2);
  if (format === "json") {
    return {
      filename: `${exportBaseName(card)}.json`,
      dataUrl: "data:application/json;charset=utf-8," + encodeURIComponent(json),
    };
  }
  let png: Buffer | null = null;
  const avatar = card.identity.avatar;
  if (typeof avatar === "string" && avatar.startsWith("/covers/")) {
    // 封面文件存储：读文件做图面
    png = await readCover(avatar);
  } else if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
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
  return { filename: `${exportBaseName(card)}.png`, dataUrl: "data:image/png;base64," + out.toString("base64") };
}

app.post("/api/cards/:slug/export", async (req, res) => {
  try {
    const te0 = Date.now();
    const card = await store.get(req.params.slug);
    const format = ["json", "chatlog"].includes(req.body?.format) ? req.body.format : "png";
    const out = await buildCardExport(card, format);
    logInfo("卡片", `导出 ${card.name} (${format}) 共 ${Date.now() - te0}ms`, `产物 ${Math.round(out.dataUrl.length / 1024)}KB`);
    res.json({ format, ...out });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
      if (card.identity?.avatar) card.identity.avatar = await normalizeAvatar(card.identity.avatar, card.slug);
      await store.save(card);
      return res.json({ card, renamedFrom: original, hint: `已存在同名卡「${original}」，本次另存为「${card.slug}」` });
    }
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    if (card.identity?.avatar) card.identity.avatar = await normalizeAvatar(card.identity.avatar, card.slug);
    await store.save(card);
    res.json({ card, overwrote: conflict === true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 聊天测试（人设 + 工具 + 记忆 + 思考深度 + ask 审批） ----------
async function chatCompletions(
  llm: { baseUrl: string; apiKey: string; model: string },
  messages: unknown[],
  tools?: unknown[],
  reasoning?: string,
  externalSignal?: AbortSignal // 客户端断开/截断时中止模型请求（省 API）
): Promise<{ choices?: { message?: { content?: string; tool_calls?: unknown[] } }[] }> {
  const doCall = async (effort?: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const onExternal = () => ctrl.abort();
    externalSignal?.addEventListener("abort", onExternal, { once: true });
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
      externalSignal?.removeEventListener("abort", onExternal);
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
        logError("工具", `${tc.function?.name ?? "?"} 执行出错`, e);
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
  reasoning?: string,
  externalSignal?: AbortSignal // 客户端断开/截断时中止模型请求
): Promise<LoopResult> {
  for (let i = 0; i < 4; i++) {
    if (externalSignal?.aborted) return { type: "reply", reply: "（已截断）" };
    const data = await chatCompletions(llm, messages, tools.length ? toolsToOpenAI(tools) : undefined, reasoning, externalSignal);
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

async function resolveChatTools(enabledTools: string[]): Promise<{ defs: ToolDef[] }> {
  // 未启用的功能在这里统一拦掉：即使请求里带了这些工具也不会生效
  const allowed = filterDisabledTools(enabledTools);
  const defs = TOOL_REGISTRY.filter((t) => allowed.includes(t.id));
  return { defs };
}

/**
 * 临时换模型：请求里的 "提供商::模型" 覆盖卡片自己的模型设置（只影响这一次请求）。
 * 传空或格式不对就原样返回，回落到卡片配置。
 */
function overrideCardModel<T extends { model?: { provider?: string; model?: string } }>(card: T, raw: unknown): T {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s.includes("::")) return card;
  const [provider, modelId] = s.split("::");
  if (!provider || !modelId) return card;
  return { ...card, model: { provider, model: modelId } };
}

/**
 * 共享工作区：所有卡片共用同一个文件目录（换卡=换对话，文件不换）。
 * 聊天记录与长期记忆仍按卡隔离，只有文件系统是共享的。
 */
function workspaceFilesDir(): string {
  return path.join(dataDir(), "workspace-files");
}

function chatCtx(slug: string, ns = "local"): ToolCtx {
  return {
    slug,
    ns,
    sandboxDir: workspaceFilesDir(),
    memoryPath: path.join(dataDir(), "memory", `${slug}.mem`),
    imagesDir: path.join(dataDir(), "images", slug),
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    const { slug, message, history, tools, thinking, model, userKey } = req.body ?? {};
    if (!slug || !message) return res.status(400).json({ error: "请选择卡片并输入内容" });
    const card = await store.get(slug).catch(() => null);
    if (!card) return res.status(404).json({ error: "找不到这张卡，可能已被删除" });
    // 对话身份标识（保留兼容）：记忆已整卡通用，ns 不再做隔离，仅作调用链兼容
    const ns = typeof userKey === "string" && userKey.trim() ? userKey.trim() : "local";
    // 本次聊天可临时换模型（"提供商::模型" 形式），不传则用卡片自己的设置
    const llm = await resolveChatLLM(overrideCardModel(card, model));
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
    const enabledTools = Array.isArray(tools) ? (tools as string[]) : [];
    const { defs: toolDefs } = await resolveChatTools(enabledTools);

    // 相关召回：按关键词重合 + 新鲜度取与当前话题最相关的记忆（最多 20 条）。
    // 只召回「当前用户私密 + 所有用户共享」的记忆，避免不同用户的事实互相污染
    const memories = await recall(slug, message, 30, ns).catch(() => []);
    const memoryBlock = memories.length
      ? `\n\n【长期记忆（关于你的事实，仅在相关时使用；【关键】为必须遵守的长期约定；要新增事实时调用 memory_save 工具）】\n- ${memories
          .map((m) => `${m.important ? "【关键】" : ""}${m.fact}`)
          .join("\n- ")}`
      : "";
    // 显式「记住」触发规则：只有启用了 memory_save 工具才注入，避免模型嘴上说记住却没工具可调
    const rememberRule = enabledTools.includes("memory_save")
      ? `\n\n【记忆规则】用户明确说「记住/以后都/总是/不要/我喜欢/我讨厌/偏好」或分享重要个人信息、决定、计划时，主动调用 memory_save 工具保存为长期记忆；保存后简单确认即可（如「记住了」），不要反复强调；一次性闲聊内容不要保存。`
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
    // 世界书关键词触发的检索文本：当前消息 + 最近几轮对话内容
    const recentText = [
      ...(Array.isArray(history) ? history.slice(-6) : []).map((m) => String((m as { content?: string })?.content ?? "")),
      String(message),
    ].join("\n");
    // 用户身份：让 AI 知道"对面是谁"（设置里的昵称/简介，留空则不注入）
    const me = await readUserProfile();
    const userBlock =
      me.name || me.bio
        ? `\n\n【和你说话的人】${me.name ? `称呼：${me.name}。` : ""}${me.bio ? `\n${me.bio}` : ""}`
        : "";
    let system =
      (await buildChatSystemAsync(card, await resolveCardPresetBlocks(card), recentText)) +
      userBlock +
      (toolDefs.length
        ? `\n\n你可以使用以下工具完成任务：${toolDefs.map((t) => t.name).join("、")}。用户请求适合用工具完成时，调用工具而不是凭空编造；危险工具会先征得用户同意。`
        : "") +
      memoryBlock +
      rememberRule;

    // 表情包注入：全局共享库（关闭档不注入）
    system += await buildEmojiPrompt(card.voice?.message_style?.emoji ?? "克制", "inline", card.emojiGroups);

    // 破甲示范对话（few-shot 锚定）：从所选档位预设的 <example> 块解析，注入在真实对话开头。
    // 对齐 RP-Hub 的「system 破限 + user/AI 消息注入」三重结构，弱模型靠模仿比靠指令更稳。
    const presetExamples = await resolveCardPresetExamples(card);

    // 开场白上下文：这是全新对话（前端无历史）且卡有 first_mes 时，把它作为已发出的
    // assistant 消息注入，模型才知道"已经开过场"，接得上话（配合前端 greeting API 显示气泡）。
    const isFreshChat = !Array.isArray(history) || history.length === 0;
    const firstMes = card.sillytavern_v2?.first_mes?.trim() ?? "";
    const openedWithGreeting = isFreshChat && firstMes ? firstMes : "";

    const messages: unknown[] = [
      { role: "system", content: system },
      ...(presetExamples.length
        ? presetExamples.map((e) => ({ role: e.role, content: `（示范对话，仅作语气/尺度参考，不要复述）${e.content}` }))
        : []),
      ...(openedWithGreeting ? [{ role: "assistant", content: openedWithGreeting }] : []),
      ...(Array.isArray(history) ? history.slice(-20) : []),
      { role: "user", content: message },
    ];
    logInfo("聊天", `${card.name} 用 ${llm.provider}/${llm.model}` + (toolDefs.length ? ` · 工具 ${toolDefs.length} 个` : "") + (presetExamples.length ? " · 破甲示范注入" : ""));
    // 记录用户活跃（AI 生命调度用：重置该用户 missedBeats）
    void recordUserContact(card.slug, "local").catch(() => {});
    // 统一会话日志：网页聊天轮次也落盘（通道消息由观察器同步进来；本地聊天不发送到通道）
    void appendConv(slug, { role: "user", content: String(message ?? ""), surface: "web", ns }).catch(() => {});
    // 客户端断开（截断）→ 中止模型请求，省 API
    const chatCtrl = new AbortController();
    req.on("close", () => { if (!res.writableEnded) chatCtrl.abort(); });
    const result = await runToolLoop(llm, messages, toolDefs, chatCtx(slug, ns), card.tools?.policy === "ask", reasoning, chatCtrl.signal);
    // 出站清理：剥离低级模型泄漏的纯文本思维链（「分析：」「（思考）」等前缀行）
    if (result.type === "reply" && typeof result.reply === "string") {
      const cleaned = sanitizeChatReply(card, result.reply);
      if (cleaned !== result.reply) {
        logWarn("清洗", `${card.name} 回复剥离了思维链残留`);
        result.reply = cleaned;
      }
    }
    if (result.type === "reply") {
      void appendConv(slug, { role: "assistant", content: String(result.reply ?? ""), surface: "web", ns }).catch(() => {});
      // 滑动分批自动总结记忆（后台执行，不阻塞回复）
      void autoMemorize(slug, card, message, (result as { reply?: string }).reply ?? "", ns).catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 每 N 轮自动记忆（滑动分批总结：最近 N 轮保留不总结，攒够 2N 轮总结最早 N 轮，每段只处理一次） ----------
async function autoMemorize(
  slug: string,
  card: { model?: { provider?: string; model?: string }; memoryConfig?: { auto_rounds?: number } },
  userMsg: string,
  reply: string,
  ns = "local"
): Promise<void> {
  const rounds = card.memoryConfig?.auto_rounds ?? 10;
  if (!rounds || rounds < 1) return;
  // 追加本轮并取回「最早的一段」（若未到 保护20+N 则返回空，最近 20 轮原样保留不总结）。
  // 网页与通道（QQ/微信）对话进同一份日志、同一份记忆（整卡通用）
  const segment = await pushChatRound(
    slug,
    { u: String(userMsg ?? "").slice(0, 500), a: String(reply ?? "").slice(0, 500), t: new Date().toISOString() },
    rounds,
    ns
  ).catch(() => []);
  if (!segment.length) return;
  // 记忆总结固定用这张卡的聊天模型
  const llm = await resolveChatLLM(card as never);
  if (!llm?.apiKey) return;
  // 总结字数上限随 N：1-10 轮 ≤100 字；11-20 轮 ≤200 字（批次越大允许越详实）
  const maxLen = rounds <= 10 ? 100 : 200;
  // 已记住的只带最近 100 条给 LLM，避免 token 随文件膨胀
  const existing = (await readAllMemories().then((m) => m[slug] ?? []).catch(() => []))
    .slice(-100)
    .map((e) => `- ${e.important ? "【关键】" : ""}${e.fact}`)
    .join("\n");
  const recent = segment
    .map((r) => `用户: ${r.u}\n角色: ${r.a}`)
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
              "你是记忆提炼器。把下面的对话提炼成【一条】简洁的长期记忆，抓住重点（用户的名字/住址/喜好/习惯/关系/重要决定/共同经历等）。要求：\n" +
              "1. 只输出一条总结性记忆（不是列表），口语化、简练，不超过 " +
              maxLen +
              " 字；\n" +
              "2. 若对话里用户表达了【长期、绝对的约定或强烈偏好】（出现「总是、以后都、永远、一直、记住、我绝对、我特别喜欢/讨厌、无论如何」等词），把 important 设为 true（关键记忆，必须长期遵守）；否则 false；\n" +
              "3. 提炼 2-5 个关键词放进 keywords（用于之后聊天出现这些词时召回这条记忆）。\n" +
              "4. 已记住的不要重复。没有值得记的内容就返回 {\"skip\": true}。\n" +
              "输出严格 JSON：{\"summary\":\"...\",\"important\":true/false,\"keywords\":[\"...\"]}，不要任何其他文字。",
          },
          { role: "user", content: `已记住的记忆：\n${existing || "（无）"}\n\n最近对话：\n${recent}` },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) return;
    const data = await r.json();
    const text = String(data.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return;
    const o = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; important?: unknown; keywords?: unknown; skip?: unknown };
    if (o.skip === true) return;
    const fact = typeof o.summary === "string" ? o.summary.trim().slice(0, maxLen) : "";
    if (!fact) return;
    const keywords = Array.isArray(o.keywords)
      ? o.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 5)
      : [];
    const important = o.important === true;
    await appendEntry(slug, { fact, keywords, important, src: "auto", ns }).catch(() => {});
    void (async () => {
      await exportMemoryToMarkdown(slug).catch(() => {});
      await syncAgentUserMemory(slug).catch(() => {});
    })().catch(() => {});
  } catch {
    /* 自动记忆失败不影响聊天 */
  }
}

app.post("/api/chat/approve", async (req, res) => {
  try {
    const { slug, messages, approve, tools, model, userKey } = req.body ?? {};
    if (!slug || !Array.isArray(messages)) return res.status(400).json({ error: "请选择卡片并输入内容" });
    // 与 /api/chat 保持一致：用卡片单独配置的模型（否则审批续聊会静默换回默认模型）
    const card = await store.get(slug).catch(() => null);
    if (!card) return res.status(404).json({ error: "找不到这张卡，可能已被删除" });
    const ns = typeof userKey === "string" && userKey.trim() ? userKey.trim() : "local";
    const llm = await resolveChatLLM(overrideCardModel(card, model));
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
    const enabledTools = Array.isArray(tools) ? (tools as string[]) : [];
    const { defs: toolDefs } = await resolveChatTools(enabledTools);
    const last = messages[messages.length - 1] as { tool_calls?: ToolCallMsg[] };
    const toolCalls = (last?.tool_calls ?? []).filter((tc) => tc.function?.name);
    if (approve) {
      await executeToolCalls(toolDefs, toolCalls, messages, chatCtx(slug, ns));
    } else {
      for (const tc of toolCalls) {
        messages.push({ role: "tool", tool_call_id: tc.id ?? "", content: "用户拒绝执行此工具调用" });
      }
    }
    // 客户端断开（截断）→ 中止模型请求，省 API
    const chatCtrl = new AbortController();
    req.on("close", () => { if (!res.writableEnded) chatCtrl.abort(); });
    const result = await runToolLoop(llm, messages, toolDefs, chatCtx(slug, ns), card.tools?.policy === "ask", undefined, chatCtrl.signal);
    if (result.type === "reply") {
      // 与 /api/chat 一致：审批续聊后的回复同样计入自动记忆（用户消息取 messages 里最后一条 user）
      const lastUser = [...messages].reverse().find((m) => (m as { role?: string }).role === "user");
      const userText = String((lastUser as { content?: string } | undefined)?.content ?? "");
      const replyText = (result as { reply?: string }).reply ?? "";
      void appendConv(slug, { role: "user", content: userText, surface: "web", ns }).catch(() => {});
      void appendConv(slug, { role: "assistant", content: String(replyText), surface: "web", ns }).catch(() => {});
      void autoMemorize(slug, card, userText, replyText, ns).catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 角色扮演预设库（档位/风格 = 预设组，组内一条一条独立条目，卡片高级配置引用组） ----------
const isPresetKind = (k: string): k is PresetKind => k === "tier" || k === "style";

app.get("/api/presets", async (_req, res) => {
  try {
    res.json(await listPresets());
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 新增档位/风格组（空组，可往里加条目）
app.post("/api/presets", async (req, res) => {
  try {
    const { kind, name } = req.body ?? {};
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    res.status(201).json(await addPresetGroup(kind, String(name ?? "")));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 重命名档位/风格组
app.put("/api/presets/:kind/:groupId", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    res.json(await renamePresetGroup(kind, String(req.params.groupId), String(req.body?.name ?? "")));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 删除档位/风格组（内置组不可删）
app.delete("/api/presets/:kind/:groupId", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    res.json(await deletePresetGroup(kind, String(req.params.groupId)));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 组内新增条目
app.post("/api/presets/:kind/:groupId/items", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    const { name, content, role } = req.body ?? {};
    res.status(201).json(await addPresetItem(kind, String(req.params.groupId), { name: String(name ?? ""), content: String(content ?? ""), role }));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 编辑组内条目（名称/内容/插入位置）
app.put("/api/presets/:kind/:groupId/items/:itemId", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    const patch: { name?: string; content?: string; role?: PresetRole } = {};
    if (typeof req.body?.name === "string") patch.name = req.body.name;
    if (typeof req.body?.content === "string") patch.content = req.body.content;
    if (typeof req.body?.role === "string") patch.role = req.body.role as PresetRole;
    res.json(await updatePresetItem(kind, String(req.params.groupId), String(req.params.itemId), patch));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 删除组内条目（内置条目不可删，可编辑或恢复内置）
app.delete("/api/presets/:kind/:groupId/items/:itemId", async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isPresetKind(kind)) return res.status(400).json({ error: "kind 必须是 tier 或 style" });
    res.json(await deletePresetItem(kind, String(req.params.groupId), String(req.params.itemId)));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/presets/reset", async (_req, res) => {
  try {
    res.json(await resetBuiltinPresets());
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/** 功能未启用时挡在 API 层：前端藏了界面，这里保证接口也不生效 */
function requireFeature(name: keyof typeof FEATURES): express.RequestHandler {
  return (_req, res, next) => {
    if (FEATURES[name]) return next();
    res.status(404).json({ error: `该功能当前未启用（${name}）` });
  };
}

// ---------- 工作区文件管理（共享单目录 data/workspace-files） ----------
// 所有卡片共用同一份文件；换卡只换对话，不换工作区。请求里的 slug 已不再决定目录，
// 保留参数只为兼容旧前端调用。
async function wsBase(): Promise<string> {
  const base = workspaceFilesDir();
  await fs.mkdir(base, { recursive: true });
  await migrateLegacySandboxes(base);
  return base;
}

/**
 * 一次性迁移：把旧的每卡沙箱 data/sandbox/<slug>/* 合并进共享工作区。
 * 同名文件加 <slug>- 前缀避免互相覆盖；迁移完留下 .migrated 标记不再重复执行。
 */
let legacyMigrated = false;
async function migrateLegacySandboxes(base: string): Promise<void> {
  if (legacyMigrated) return;
  legacyMigrated = true;
  const legacyRoot = path.join(dataDir(), "sandbox");
  const marker = path.join(legacyRoot, ".migrated");
  if (await fs.stat(marker).then(() => true).catch(() => false)) return;
  const entries = await fs.readdir(legacyRoot, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const src = path.join(legacyRoot, e.name);
    const items = await fs.readdir(src, { withFileTypes: true }).catch(() => []);
    for (const it of items) {
      const from = path.join(src, it.name);
      let to = path.join(base, it.name);
      if (await fs.stat(to).then(() => true).catch(() => false)) to = path.join(base, `${e.name}-${it.name}`);
      await fs.rename(from, to).catch(() => {});
    }
  }
  await fs.writeFile(marker, new Date().toISOString(), "utf8").catch(() => {});
}

app.get("/api/workspace/list", requireFeature("workspace"), async (req, res) => {
  try {
    const base = await wsBase();
    const dir = resolveInSandbox(base, String(req.query.dir ?? ""));
    if (!dir) return res.status(400).json({ error: "这个位置不允许访问" });
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
    res.json({ dir: String(req.query.dir ?? ""), items: out });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/workspace/write", requireFeature("workspace"), async (req, res) => {
  try {
    const base = await wsBase();
    const abs = resolveInSandbox(base, String(req.body?.file ?? ""));
    if (!abs) return res.status(400).json({ error: "这个位置不允许访问" });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(req.body?.content ?? ""), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/workspace/mkdir", requireFeature("workspace"), async (req, res) => {
  try {
    const base = await wsBase();
    const abs = resolveInSandbox(base, String(req.body?.dir ?? ""));
    if (!abs) return res.status(400).json({ error: "这个位置不允许访问" });
    await fs.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/workspace/delete", requireFeature("workspace"), async (req, res) => {
  try {
    const base = await wsBase();
    const abs = resolveInSandbox(base, String(req.body?.path ?? ""));
    if (!abs) return res.status(400).json({ error: "这个位置不允许访问" });
    if (abs === base) return res.status(400).json({ error: "不能删除工作区根目录" });
    await fs.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/workspace/download", requireFeature("workspace"), async (req, res) => {
  try {
    const base = await wsBase();
    const abs = resolveInSandbox(base, String(req.query.file ?? ""));
    if (!abs) return res.status(400).json({ error: "这个位置不允许访问" });
    const st = await fs.stat(abs).catch(() => null);
    if (!st || st.isDirectory()) return res.status(404).json({ error: "文件不存在" });
    res.download(abs);
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/workspace/upload", requireFeature("workspace"), async (req, res) => {
  try {
    const base = await wsBase();
    const abs = resolveInSandbox(base, String(req.body?.file ?? ""));
    if (!abs) return res.status(400).json({ error: "这个位置不允许访问" });
    let b64 = String(req.body?.data ?? "");
    if (b64.includes(",")) b64 = b64.slice(b64.indexOf(",") + 1);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(b64, "base64"));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 工作区概览：所有沙箱目录的文件数与大小（工作台设置页用）
// 工作区概览：共享工作区的文件数与总大小
app.get("/api/workspace/overview", requireFeature("workspace"), async (_req, res) => {
  try {
    const base = await wsBase();
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
    await walk(base);
    res.json({ path: base, files, size });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 当前生效人设（最后编译进 workspace 的卡片） ----------
app.get("/api/active-persona", async (_req, res) => {
  try {
    const soul = await fs.readFile(path.join(dataDir(), "workspace", "SOUL.md"), "utf8").catch(() => "");
    const m = soul.match(/^# SOUL\.md\s*[—-]\s*(.+)$/m);
    res.json({ active: m ? m[1].trim() : null });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 数据备份（卡片 + 长期记忆 + 各类配置 → 单个 JSON） ----------
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
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 长期记忆查看 / 管理 ----------
app.get("/api/memory", async (_req, res) => {
  try {
    res.json({ memory: await readAllMemories() });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    void exportAllMemoriesToMarkdown().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 一键重置（网页聊天页「重置」按钮）：清空该卡全部记忆 + 对话日志 + 开场状态，
// 让 AI 忘掉之前的所有事（含通道用户记住的事实），可重新开场、重塑角色形象。不可恢复。
app.post("/api/cards/:slug/reset", async (req, res) => {
  try {
    const slug = req.params.slug;
    await clearMemory(slug); // 记忆 + 统一对话日志 + 导出 md
    await clearGreeted(slug); // 全部开场状态（local 与通道用户都清），允许重新开场
    await clearConv(slug); // 统一会话日志
    await clearObserveCursor(slug); // 通道观察游标
    await fs.rm(mirrorStateFile(slug), { force: true }).catch(() => {}); // 镜像目标状态
    // 剥离 agent 工作区 USER.md 里的记忆段（记忆没了，这个也该清，否则通道 agent 读到幽灵记忆）
    const userMd = path.join(agentWorkspaceDir(slug), "USER.md");
    const existing = await fs.readFile(userMd, "utf8").catch(() => "");
    if (existing.includes(USER_MEMORY_START)) {
      const base = existing.replace(new RegExp(`${USER_MEMORY_START}[\\s\\S]*?${USER_MEMORY_END}\\s*`, "g"), "").trimEnd();
      await fs.writeFile(userMd, base + "\n", "utf8");
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 跨端会话（本地网页 ↔ QQ/微信）：统一日志 + 通道观察 + 网页驱动通道 ----------
// 设计（用户拍板）：机器人只跟一个人聊（=你），本地网页与微信/QQ 是同一段对话的两个窗口。
//   绑定（联通）：网页发消息经通道 agent 会话驱动（回复同时投递到微信/QQ 并回显网页）；
//               通道里用户发来的消息由观察器轮询同步进网页 —— 两边记录相同。
//   未绑定（断开）：网页聊天照常走 /api/chat（local），轮次也落日志；记忆与对话不丢不串。
//   解绑：记忆保留；重新绑定同一账号 → 同一会话键 → 对话续上。

function nsOfChannel(channel: BotChannel): string {
  return channel === "qqbot" ? "qq" : "wx";
}

function surfaceOfChannel(channel: BotChannel): ConvSurface {
  return channel === "qqbot" ? "qq" : "wx";
}

// 镜像状态：data/memory/<slug>.mirror.json = { openid, sessionId, lastSyncAt }
function mirrorStateFile(slug: string): string {
  return path.join(dataDir(), "memory", `${slug}.mirror.json`);
}

async function readMirrorState(slug: string): Promise<{ openid?: string; sessionId?: string; lastSyncAt?: string }> {
  try {
    return JSON.parse(await fs.readFile(mirrorStateFile(slug), "utf8"));
  } catch {
    return {};
  }
}

async function writeMirrorState(slug: string, s: { openid?: string; sessionId?: string; lastSyncAt?: string }): Promise<void> {
  const file = mirrorStateFile(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(s, null, 2), "utf8");
}

/** 绑定的目标用户：优先上次用过的 openid（用户说了机器人只跟一个人聊，不弹选择），
 *  否则取该通道最近互动的已知用户；通道还没人聊过时返回 null。
 *  已知用户里带 accountId 的（QQ known-users.json）先按当前 bot 的账号过滤，
 *  避免 bot 绑 A 账号却把消息投给 B 账号的用户（串台）。 */
async function mirrorTargetOf(bot: BotInstance): Promise<{ openid: string } | null> {
  const state = await readMirrorState(bot.cardSlug);
  if (state.openid) return { openid: state.openid };
  const users = bot.channel === "qqbot" ? await readQQKnownUsers() : await readWXKnownUsers();
  if (!users.length) return null;
  const lastAt = (u: { openid: string; lastInteractionAt?: number }): number => u.lastInteractionAt ?? 0;
  // 优先取当前账号下的用户；账号无记录时才回退到全局最近互动（老数据/微信无账号维度）
  const mine = users.filter((u) => !("accountId" in u) || u.accountId === bot.accountId);
  const pool = mine.length ? mine : users;
  const sorted = [...pool].sort((a, b) => lastAt(b) - lastAt(a));
  return { openid: sorted[0].openid };
}

/** 观察一张卡的通道会话：增量同步进统一日志 + 喂自动记忆。返回新增轮次数。 */
async function observeCard(slug: string): Promise<number> {
  const bot = await getBotByCard(slug);
  if (!bot) return 0;
  const target = await mirrorTargetOf(bot);
  if (!target) return 0;
  const ns = `${nsOfChannel(bot.channel)}:${target.openid}`;
  const { sessionId, turns } = await pollSessionTurns(slug, bot, target.openid);
  if (!turns.length) return 0;
  for (const t of turns) {
    void appendConv(slug, { role: t.role, content: t.content, surface: surfaceOfChannel(bot.channel), ns }).catch(() => {});
  }
  // 配对 user/assistant 喂自动记忆（assistant 与前一条 user 组成一轮；单条不配对等下一批）
  const card = await store.get(slug).catch(() => null);
  let pendingUser = "";
  for (const t of turns) {
    if (t.role === "user") pendingUser = t.content;
    else if (t.role === "assistant" && pendingUser) {
      if (card) void autoMemorize(slug, card, pendingUser, t.content, ns).catch(() => {});
      void recordUserContact(slug, target.openid).catch(() => {});
      pendingUser = "";
    }
  }
  if (sessionId) {
    await writeMirrorState(slug, { openid: target.openid, sessionId, lastSyncAt: new Date().toISOString() });
  }
  return turns.length;
}

/** 解析 `openclaw agent --json` 输出里的回复文本（实测结构：result.payloads[].text /
 *  result.meta.finalAssistantVisibleText；另兼容顶层 reply/text/content 形态） */
function parseAgentReply(stdout: string): string {
  const clean = stripAnsi(stdout).trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(clean) as Record<string, unknown> | null;
  if (!obj) {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryParse(clean.slice(start, end + 1)) as Record<string, unknown> | null;
  }
  if (!obj) return "";
  // 形态 1（openclaw agent --json 实测）：result.payloads[].text 拼接
  const result = obj.result as { payloads?: { text?: unknown }[]; meta?: { finalAssistantVisibleText?: unknown } } | undefined;
  if (result && typeof result === "object") {
    if (Array.isArray(result.payloads) && result.payloads.length) {
      const texts = result.payloads.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean);
      if (texts.length) return texts.join("\n").trim();
    }
    if (typeof result.meta?.finalAssistantVisibleText === "string") {
      return result.meta.finalAssistantVisibleText.trim();
    }
  }
  // 形态 2：顶层 reply/text/content/message/output
  const cand = (["reply", "text", "content", "message", "output"] as const).find((k) => obj?.[k] !== undefined);
  if (cand) {
    const v = obj[cand];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const t = (v as { text?: unknown }).text ?? (v as { content?: unknown }).content;
      if (typeof t === "string" && t.trim()) return t.trim();
    }
  }
  return "";
}

// 会话日志：绑定（联通）返回完整记录；未绑定只返回网页本地会话
app.get("/api/cards/:slug/conversation", async (req, res) => {
  try {
    const slug = req.params.slug;
    const bot = await getBotByCard(slug);
    const entries = await readConv(slug);
    const list = bot ? entries : entries.filter((e) => e.surface === "web");
    res.json({ bound: !!bot, entries: list });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 镜像状态（前端判断「已联通」与显示提示用）
app.get("/api/cards/:slug/mirror/status", async (req, res) => {
  try {
    const slug = req.params.slug;
    const bot = await getBotByCard(slug);
    if (!bot) return res.json({ bound: false });
    const target = await mirrorTargetOf(bot);
    const state = await readMirrorState(slug);
    res.json({
      bound: true,
      channel: bot.channel,
      accountId: bot.accountId,
      agentId: bot.agentId,
      openid: target?.openid ?? "",
      ns: target ? `${nsOfChannel(bot.channel)}:${target.openid}` : "",
      sessionId: state.sessionId ?? "",
      lastSyncAt: state.lastSyncAt ?? "",
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 手动触发一次观察同步（前端轮询/打开页面时用）
app.post("/api/cards/:slug/mirror/sync", async (req, res) => {
  try {
    const added = await observeCard(req.params.slug);
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 网页驱动通道：把网页消息发给绑定账号的用户（agent 会话生成回复 → 投递微信/QQ → 回显网页）
app.post("/api/cards/:slug/mirror/send", async (req, res) => {
  try {
    const slug = req.params.slug;
    const text = String(req.body?.message ?? "").trim();
    if (!text) return res.status(400).json({ error: "消息不能为空" });
    const card = await store.get(slug).catch(() => null);
    if (!card) return res.status(404).json({ error: "找不到这张卡" });
    const bot = await getBotByCard(slug);
    if (!bot) return res.status(400).json({ error: "这张卡没有绑定机器人，无法投递到微信/QQ" });
    const target = await mirrorTargetOf(bot);
    if (!target) {
      return res.status(400).json({ error: "通道还没有聊过的人：先在微信/QQ 里和机器人说句话，再来这里接续会话。" });
    }
    const ns = `${nsOfChannel(bot.channel)}:${target.openid}`;
    const uEntry = await appendConv(slug, { role: "user", content: text, surface: surfaceOfChannel(bot.channel), ns }).catch(() => null);
    void recordUserContact(slug, target.openid).catch(() => {});
    const r = await runOpenclaw(
      [
        "agent",
        "--agent",
        bot.agentId,
        "--session-key",
        sessionKeyOf(bot.agentId, bot.accountId, target.openid),
        "--message",
        text,
        "--deliver",
        "--json",
      ],
      { timeoutMs: 180000 }
    );
    if (r.code !== 0) {
      return res.status(502).json({ error: `通道代理执行失败（${r.code}）：${stripAnsi(r.stdout + r.stderr).slice(-300)}` });
    }
    const reply = parseAgentReply(r.stdout);
    if (!reply) {
      return res.status(502).json({ error: `无法解析通道回复：${stripAnsi(r.stdout).slice(-300)}` });
    }
    const aEntry = await appendConv(slug, { role: "assistant", content: reply, surface: surfaceOfChannel(bot.channel), ns }).catch(() => null);
    void autoMemorize(slug, card, text, reply, ns).catch(() => {});
    res.json({
      ok: true,
      reply,
      entryIds: [uEntry?.id, aEntry?.id].filter(Boolean),
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 手动添加一条记忆（管理页添加 = 所有用户可见；ns 可传 local / qq:xxx 指定归属；important=关键记忆；keywords=触发词）
app.post("/api/memory/:slug", async (req, res) => {
  try {
    const { fact, ns, important, keywords } = req.body ?? {};
    const result = await appendEntry(req.params.slug, {
      fact: String(fact ?? ""),
      important: important === true,
      keywords: Array.isArray(keywords) ? keywords : [],
      src: "manual",
      ns: typeof ns === "string" && ns.trim() ? ns.trim() : "shared",
    });
    if (!result.ok) return res.json({ ok: false, duplicate: result.duplicate === true });
    void (async () => {
      await exportMemoryToMarkdown(req.params.slug).catch(() => {});
      await syncAgentUserMemory(req.params.slug).catch(() => {});
    })().catch(() => {});
    res.json({ ok: true, entry: result.entry });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 删除单条记忆
app.post("/api/memory/:slug/delete", async (req, res) => {
  try {
    const id = String(req.body?.id ?? "");
    if (!id) return res.status(400).json({ error: "id 不能为空" });
    const removed = await deleteEntry(req.params.slug, id);
    void (async () => {
      await exportMemoryToMarkdown(req.params.slug).catch(() => {});
      await syncAgentUserMemory(req.params.slug).catch(() => {});
    })().catch(() => {});
    res.json({ ok: removed });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 编辑单条记忆（fact / important / keywords）
app.post("/api/memory/:slug/update", async (req, res) => {
  try {
    const { id, fact, important, keywords } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "id 不能为空" });
    const entry = await updateEntry(req.params.slug, String(id), {
      fact: typeof fact === "string" ? fact : undefined,
      important: typeof important === "boolean" ? important : undefined,
      keywords: Array.isArray(keywords) ? keywords : undefined,
    });
    if (!entry) return res.status(404).json({ error: "记忆不存在" });
    void (async () => {
      await exportMemoryToMarkdown(req.params.slug).catch(() => {});
      await syncAgentUserMemory(req.params.slug).catch(() => {});
    })().catch(() => {});
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 表情包库（全局共享，所有角色卡共用一套） ----------
let emojiMigrated = false;
app.get("/api/emojis", async (_req, res) => {
  try {
    // 首次访问：把旧的「按卡表情」并进共享库（老卡里可能已经上传过）
    if (!emojiMigrated) {
      emojiMigrated = true;
      const cards = [];
      for (const meta of await store.list().catch(() => [])) {
        const c = await store.get(meta.slug).catch(() => null);
        if (c?.emojis?.length) cards.push({ slug: c.slug, emojis: c.emojis });
      }
      if (cards.length) await migrateLegacyEmojis(cards).catch(() => 0);
    }
    const emojis = await listEmojis();
    const groups = await listGroups();
    res.json({
      emojis: emojis.map((e) => ({ ...e, url: emojiUrl(e.file) })),
      groups,
      max: MAX_EMOJIS,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 分组管理 ----------
app.post("/api/emojis/groups", async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const g = await addGroup(String(name ?? ""));
    res.status(201).json({ ok: true, group: g, groups: await listGroups() });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

app.put("/api/emojis/groups/:id", async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const g = await renameGroup(req.params.id, String(name ?? ""));
    if (!g) return res.status(404).json({ error: "分组不存在" });
    res.json({ ok: true, group: g, groups: await listGroups() });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

app.delete("/api/emojis/groups/:id", async (req, res) => {
  try {
    await deleteGroup(req.params.id);
    res.json({ ok: true, groups: await listGroups() });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

// 移动 / 复制表情到其他分组（copy=true 复制，false 移动）
app.post("/api/emojis/:id/move", async (req, res) => {
  try {
    const { group, copy } = req.body ?? {};
    const item = await moveEmojiToGroup(req.params.id, String(group ?? ""), copy === true);
    if (!item) return res.status(404).json({ error: "表情不存在" });
    res.json({ ok: true, emoji: { ...item, url: emojiUrl(item.file) } });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

app.post("/api/emojis", async (req, res) => {
  try {
    const { name, explanation, imageBase64, ext, group } = req.body ?? {};
    const item = await addEmoji({ name, explanation, imageBase64, ext, group });
    res.json({ ok: true, emoji: { ...item, url: emojiUrl(item.file) } });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

// 表情导入（二进制直传）：前端跳过 FileReader/base64/JSON，体积省 33%、无大字符串序列化
app.post("/api/emojis/raw", express.raw({ type: "application/octet-stream", limit: "20mb" }), async (req, res) => {
  try {
    const name = String(req.query?.name ?? "").trim();
    const explanation = String(req.query?.exp ?? "").slice(0, 100);
    const ext = String(req.query?.ext ?? "png").toLowerCase();
    const group = String(req.query?.group ?? "") || undefined;
    const buf = req.body as Buffer;
    if (!name) return res.status(400).json({ error: "表情名不能为空" });
    if (!buf || !buf.length) return res.status(400).json({ error: "缺少图片内容" });
    const item = await addEmoji({ name, explanation, imageBase64: buf.toString("base64"), ext, group });
    res.json({ ok: true, emoji: { ...item, url: emojiUrl(item.file) } });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});


app.post("/api/emojis/:id", async (req, res) => {
  try {
    const { name, explanation, group } = req.body ?? {};
    const item = await updateEmoji(req.params.id, { name, explanation, group });
    if (!item) return res.status(404).json({ error: "表情不存在" });
    res.json({ ok: true, emoji: { ...item, url: emojiUrl(item.file) } });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

app.delete("/api/emojis/:id", async (req, res) => {
  try {
    const ok = await removeEmoji(req.params.id);
    if (!ok) return res.status(404).json({ error: "表情不存在" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 生图配置（NovelAI / OpenAI 兼容 / 本地 SD WebUI） ----------
app.get("/api/image/config", async (_req, res) => {
  try {
    const cfg = await getImageConfig();
    res.json({
      provider: cfg.provider,
      retentionDays: cfg.retentionDays,
      novelai: { key: maskKey(cfg.novelai.key) },
      openai: { baseUrl: cfg.openai.baseUrl, key: maskKey(cfg.openai.key), model: cfg.openai.model },
      artists: cfg.artists,
      activeArtist: cfg.activeArtist,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/image/config", async (req, res) => {
  try {
    const { provider, novelai, openai, artists, activeArtist, retentionDays } = req.body ?? {};
    const cur = await getImageConfig();
    // 画师串列表：name/content 去空白过滤
    const nextArtists = Array.isArray(artists)
      ? (artists as { name?: string; content?: string }[])
          .map((a) => ({ name: String(a?.name ?? "").trim(), content: String(a?.content ?? "").trim() }))
          .filter((a) => a.name && a.content)
      : cur.artists;
    const next = {
      provider: provider === "openai" ? "openai" : provider === "novelai" ? "novelai" : cur.provider,
      retentionDays: Number.isFinite(Number(retentionDays)) ? Math.max(0, Math.floor(Number(retentionDays))) : cur.retentionDays,
      novelai: { key: novelai?.key ? String(novelai.key) : cur.novelai.key },
      openai: {
        baseUrl: openai?.baseUrl !== undefined ? String(openai.baseUrl) : cur.openai.baseUrl,
        key: openai?.key ? String(openai.key) : cur.openai.key,
        model: openai?.model !== undefined ? String(openai.model) : cur.openai.model,
      },
      artists: nextArtists,
      activeArtist:
        typeof activeArtist === "string" && nextArtists.some((a) => a.name === activeArtist) ? activeArtist : "",
    };
    await saveImageConfig(next);
    res.json({ ok: true, hint: "已保存。工作模式勾选「生图」工具即可让 AI 生成图片" });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/image/test", async (req, res) => {
  try {
    const { provider, novelai, openai } = req.body ?? {};
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
    res.json({ ok: false, info: "未知提供商" });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 拉取 OpenAI 兼容生图可用模型（中转站一般不会单独放出生图模型，需从 /models 里选）
app.post("/api/image/openai-models", async (req, res) => {
  try {
    const { baseUrl, key } = req.body ?? {};
    const b = baseUrl ?? (await getImageConfig()).openai.baseUrl;
    const k = key ?? (await getImageConfig()).openai.key;
    if (!b || !k) return res.json({ error: "未填 Base URL / Key" });
    const models = await fetchModels(String(b), String(k));
    res.json({ models });
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

// 真实生成一张测试图（保存到 data/images/_test/），配置页「试生一张」用
app.post("/api/image/generate", async (req, res) => {
  try {
    const { prompt, negative, aspect, provider, novelai, openai } = req.body ?? {};
    const { generateImage } = await import("./core/imageGen.js");
    const { getImageConfig } = await import("./core/imageConfig.js");
    const cfg = await getImageConfig();
    // 页面表单可能未保存，用提交值覆盖本次生成
    const override = {
      ...cfg,
      provider: provider === "openai" ? "openai" : provider === "novelai" ? "novelai" : cfg.provider,
      novelai: {
        ...cfg.novelai,
        key: novelai?.key ? String(novelai.key) : cfg.novelai.key,
      },
      openai: {
        ...cfg.openai,
        baseUrl: openai?.baseUrl !== undefined ? String(openai.baseUrl) : cfg.openai.baseUrl,
        key: openai?.key ? String(openai.key) : cfg.openai.key,
        model: openai?.model !== undefined ? String(openai.model) : cfg.openai.model,
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
    res.json({ ok: true, url: `/img/_test/${file}`, width: r.width, height: r.height });
  } catch (e) {
    res.status(500).json({ ok: false, error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
      if (!body.name || !body.baseUrl) return res.status(400).json({ error: "名称和地址都要填" });
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
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
  }
});

// 拉取 TTS 上游的模型/音色列表：openai 兼容走 GET {base}/models（+尽力 /audio/voice/list）；minimax/volc 给内置可选列表
/** 宽容提取模型 id：兼容 {data:[...]} / {models:[...]} / 根数组 / 嵌套容器 / 条目字段 id|model|name */
function extractModelIds(j: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const key of ["data", "models", "items", "list", "model_list"]) {
        const c = o[key];
        if (Array.isArray(c)) {
          walk(c);
          return;
        }
      }
      if (typeof o.id === "string" && o.id.trim() || typeof o.model === "string" && o.model.trim() || typeof o.name === "string" && o.name.trim()) {
        const idv = typeof o.id === "string" ? o.id : typeof o.model === "string" ? o.model : o.name;
        if (typeof idv === "string" && idv.trim()) out.push(idv.trim());
        return;
      }
      for (const child of Object.values(o)) {
        if (Array.isArray(child)) walk(child);
      }
    }
  };
  walk(j);
  return [...new Set(out.filter((s) => s.length > 0 && s.length < 200))];
}

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
    const { kind, baseUrl, key, id } = req.body ?? {};
    const k: string = TTS_KINDS.includes(kind) ? kind : "openai";
    let base = String(baseUrl ?? "").replace(/\/+$/, "");
    let apiKey = String(key ?? "");
    // 编辑重拉：key/baseUrl 留空时回退已保存的提供商配置（同 API 页按名称回退）
    if ((!base || !apiKey) && id) {
      const cur = await getTtsConfig();
      const p = cur.providers.find((x) => x.id === id);
      if (p) {
        if (!base) base = p.baseUrl;
        if (!apiKey) apiKey = p.key;
      }
    }
    if (!base) return res.status(400).json({ error: "Base URL 必填" });
    let models: string[] = [];
    let voices: string[] = [];
    if (k === "openai") {
      if (!apiKey) return res.status(400).json({ error: "API Key 必填（编辑留空时应先保存过 Key，或重新填写）" });
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return res.status(502).json({ error: `拉取模型失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` });
      const j: unknown = await r.json().catch(() => null);
      if (j === null) return res.status(400).json({ error: "接口返回的不是 JSON，无法解析模型列表；请确认 baseUrl 正确（OpenAI 兼容以 /v1 结尾）" });
      const ids = extractModelIds(j);
      models = ids.filter((id) => /tts|speech|voice|audio|cosy|moss/i.test(id));
      if (!models.length) models = ids.slice(0, 200); // 过滤不到就全给（限 200 防巨列表卡界面）
      if (!models.length) return res.status(400).json({ error: "该接口未返回任何模型（/models 空或结构无法识别），请手动填写「默认模型/默认音色」后点完成" });
      // 尽力拉音色列表（硅基流动等支持 GET /audio/voice/list），失败不影响模型
      const vr = await fetch(`${base}/audio/voice/list`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/tts/voices", async (_req, res) => {
  try {
    res.json({ voices: await listEdgeVoices() });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// target: "local" 或 provider id
app.post("/api/tts/test", async (req, res) => {
  try {
    const { target } = req.body ?? {};
    res.json(await testTts(String(target ?? "")));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/tts/synthesize", async (req, res) => {
  const started = Date.now();
  try {
    const { text, providerId, voice, speed } = req.body ?? {};
    const buf = await synthesizeTts(String(text ?? ""), { providerId, voice, speed });
    // 直接把音频回给浏览器，不落盘：本地 SAPI 输出未压缩 WAV，单次朗读可达数 MB，
    // 存下来只为播一次不值得（想再听就重新合成）。
    // QQ/微信 的语音走 tts-server:17900，那边本来就是 res.send 不落盘，不受这里影响。
    const isWav = buf[0] === 0x52 && buf[1] === 0x49; // RIFF
    res.setHeader("Content-Type", isWav ? "audio/wav" : "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/tts/usage", async (_req, res) => {
  try {
    res.json(await getUsageSummary());
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 插件商店：ClawHub 实时搜索 + 精选/分享/付费目录 + 安装管理 ----------
import AdmZip from "adm-zip";
import {
  readCatalog,
  getMarketPlugin,
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
    res.json({
      feeRate: catalog.feeRate,
      categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
      plugins: catalog.plugins.map((p) => {
        const inst = installed.get(p.pkg.replace("clawhub:", "").toLowerCase()) ?? installed.get(p.id.toLowerCase());
        return { ...p, installed: Boolean(inst), installedVersion: inst?.version ?? "" };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
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
    res.json({ ok: result.code === 0, output: result.output.slice(-1200), hint: "网关重启后插件才会被加载" });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/plugins/update", async (req, res) => {
  try {
    const { id } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "缺少 id" });
    const r = await runOpenclaw(["plugins", "update", String(id)], { timeoutMs: 120000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-800) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/plugins/toggle", async (req, res) => {
  try {
    const { id, enabled } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "缺少 id" });
    const r = await runOpenclaw(["plugins", enabled ? "enable" : "disable", String(id)], { timeoutMs: 60000 });
    res.json({ ok: r.code === 0, output: stripAnsi(r.stdout + r.stderr).slice(-800) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});






// ---------- 记忆检索路径：确保 OpenClaw 能索引 memory-export（通道 agent 可搜到本地记忆） ----------
// shell 把记忆导出到 data/memory-export/*.md；OpenClaw 靠 agents.defaults.memorySearch.extraPaths
// 把这些 md 纳入 memory_search 索引，通道端（QQ/微信）agent 才能检索到网页聊出来的记忆。
// 之前只做了导出、没配索引路径——"通道读不到本地记忆"的根因之一。路径用 dataDir() 动态算，不硬编码。
async function ensureMemorySearchExtraPaths(): Promise<boolean> {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch {
    return false; // 没有配置文件不动（网关首启会生成）
  }
  const exportDir = path.join(dataDir(), "memory-export");
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.memorySearch ??= {};
  const arr = Array.isArray(cfg.agents.defaults.memorySearch.extraPaths)
    ? (cfg.agents.defaults.memorySearch.extraPaths as string[])
    : [];
  if (arr.includes(exportDir)) return false; // 已配置
  arr.push(exportDir);
  cfg.agents.defaults.memorySearch.extraPaths = arr;
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  return true;
}

/**
 * USER.md 里记忆段的起止标记（便于重置时精确剥离，不破坏 OpenClaw 自己的用户档案）
 */
const USER_MEMORY_START = "<!-- openclaw-shell:user-memory-start -->";
const USER_MEMORY_END = "<!-- openclaw-shell:user-memory-end -->";

/**
 * 通道读本地记忆（免向量、免搜索）：把该卡的记忆合并进绑定 agent 工作区根目录的 USER.md。
 * USER.md 是 OpenClaw 每轮必注入的"用户档案"文件（embedded 与网关都注入，已实测），
 * 所以记忆每次对话都自动带上——等价于"记忆代替聊天记录插入"，不依赖 memory_search/向量。
 * 保留 USER.md 原有内容（OpenClaw 自己的用户档案），只追加一段带标记的记忆区。
 */
async function syncAgentUserMemory(slug: string): Promise<void> {
  const bot = await getBotByCard(slug);
  if (!bot) return;
  const mdPath = path.join(dataDir(), "memory-export", `${slug}.md`);
  const content = await fs.readFile(mdPath, "utf8").catch(() => "");
  const userMd = path.join(agentWorkspaceDir(slug), "USER.md");
  // 剥离旧的记忆段（若存在），保留原档案
  const existing = await fs.readFile(userMd, "utf8").catch(() => "");
  const base = existing.replace(new RegExp(`${USER_MEMORY_START}[\\s\\S]*?${USER_MEMORY_END}\\s*`, "g"), "").trimEnd();
  const memSection = content.trim()
    ? `\n\n${USER_MEMORY_START}\n${content.trim()}\n${USER_MEMORY_END}`
    : "";
  await fs.mkdir(agentWorkspaceDir(slug), { recursive: true });
  await fs.writeFile(userMd, base + memSection + "\n", "utf8");
}

/** 通道会话观察器：每 5 秒把绑定卡的通道新对话同步进统一日志与记忆（网页可见） */
let mirrorTimer: ReturnType<typeof setInterval> | null = null;
function startMirrorObserver(): void {
  if (mirrorTimer) return;
  mirrorTimer = setInterval(() => {
    void (async () => {
      for (const bot of await listBots().catch(() => [])) {
        try {
          await observeCard(bot.cardSlug);
        } catch {
          /* 单卡观察失败不影响其他 */
        }
      }
    })();
  }, 5000);
  if (mirrorTimer.unref) mirrorTimer.unref();
}

// 确保 OpenClaw 索引 memory-export（通道 agent 可搜索本地记忆）。必须在 listen 前完成：
// start-stack 先起 server 再起 gateway，这里 await 落盘后网关读到的一定是新配置。
await ensureMemorySearchExtraPaths().then((changed) => {
  if (changed) logInfo("记忆", "已写入 OpenClaw memorySearch.extraPaths 索引路径");
});

app.listen(PORT, HOST, () => {
  logInfo("启动", `服务已启动 http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
  // 生图图片自动清理：启动清一次 + 每天清一次（_test 试生图超 15 天删；正式图超 retentionDays 删）
  void cleanupImages().then((r) => {
    if (r.removed > 0) logInfo("生图", `自动清理了 ${r.removed} 张过期图片`);
  });
  setInterval(() => void cleanupImages(), 24 * 3600 * 1000);
  // 记忆导出：启动时同步全部卡的记忆到 md（供 OpenClaw memorySearch.extraPaths 索引）
  void exportAllMemoriesToMarkdown().then((slugs) => {
    if (slugs.length) logInfo("记忆", `已导出 ${slugs.length} 张卡的记忆`);
    // 免向量方案：绑定卡的记忆同步进 agent 工作区 user-memory.md（通道 agent 直接读取）
    void (async () => {
      for (const b of await listBots().catch(() => [])) {
        await syncAgentUserMemory(b.cardSlug).catch(() => {});
      }
    })();
  });
  // 通道会话观察器：网页 ↔ 微信/QQ 互传、通道对话进记忆（每 5 秒）
  startMirrorObserver();
  // 预热通道状态：这条查询要跑 openclaw CLI（冷启动 30s+），
  // 先在后台跑一次填进缓存，用户进通道页就不用干等
  void getChannelStatuses(true).then((all) => {
    const ids = Object.keys(all);
    if (ids.length) logInfo("通道", `状态已预热：${ids.join(", ")}`);
  });
  // AI 生命调度：每分钟检查一次有哪些卡的主动消息到期
  startLifeScheduler();
});

// ---------- AI 生命调度器（主动发消息） ----------
// 触发链路：openclaw system event --mode now --session-key <agentId>:<accountId>:<openid>
//   → 唤醒该卡的 agent → 模型生成角色化消息 → 经通道发给用户（已验证可行）。
let lifeTimer: ReturnType<typeof setInterval> | null = null;

/** 查某卡绑定的机器人（agentId + accountId） */
async function lifeAgentOf(slug: string): Promise<{ agentId: string; accountId: string } | null> {
  const bot = (await listBots()).find((b) => b.cardSlug === slug);
  if (!bot) return null;
  return { agentId: bot.agentId, accountId: bot.accountId };
}

/** 查某卡的所有已知用户（QQ known-users + 微信账号） */
async function lifeKnownUsersOf(slug: string): Promise<{ openid: string }[]> {
  const bot = (await listBots()).find((b) => b.cardSlug === slug);
  if (!bot) return [];
  if (bot.channel === "qqbot") return readQQKnownUsers();
  return readWXKnownUsers();
}

/** 触发一次主动消息：system event 唤醒 agent 会话 */
async function lifeTrigger(
  slug: string,
  agentId: string,
  accountId: string,
  openid: string,
  moodPrompt: string
): Promise<boolean> {
  const sessionKey = `${agentId}:${accountId}:${openid}`;
  const r = await runOpenclaw(
    ["system", "event", "--mode", "now", "--session-key", sessionKey, "--text", moodPrompt, "--timeout", "60000"],
    { timeoutMs: 90000 }
  );
  if (r.code === 0) {
    logInfo("AI生命", `${slug} → ${openid} 主动消息已触发`);
    return true;
  }
  logWarn("AI生命", `${slug} → ${openid} 触发失败：${stripAnsi(r.stdout + r.stderr).slice(-300)}`);
  return false;
}

/** 启动心跳循环（每分钟检查；只在有配置的卡时才真正调 CLI） */
function startLifeScheduler(): void {
  if (lifeTimer) return;
  lifeTimer = setInterval(async () => {
    try {
      const bots = await listBots();
      if (bots.length === 0) return;
      const cards = [];
      for (const b of bots) {
        const c = await store.get(b.cardSlug).catch(() => null);
        if (c?.life?.intervalHours && c.life.intervalHours > 0) cards.push({ slug: c.slug, life: c.life });
      }
      if (cards.length === 0) return;
      const fired = await runLifeTick(cards, lifeTrigger, lifeKnownUsersOf, lifeAgentOf);
      if (fired.length) logInfo("AI生命", `本轮主动消息 ${fired.length} 条`);
    } catch (e) {
      logWarn("AI生命", `调度异常：${String(e).slice(0, 300)}`);
    }
  }, 60 * 1000);
  logInfo("AI生命", "调度器已启动（每分钟检查一次主动消息）");
}
