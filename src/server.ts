// 本地服务：卡片 API + Web 编辑器
// 启动: npm run server  →  http://127.0.0.1:17880
import express from "express";
import path from "node:path";
import os from "node:os";
import dns from "node:dns";
import crypto from "node:crypto";
import { promises as fs, existsSync, statSync, readFileSync } from "node:fs";

// 出站请求一律优先 IPv4。本机（以及部分国内网络）IPv6 路由不通，而 Node 默认按 DNS
// 返回顺序尝试，解析结果里 IPv6 排前时会连接超时（实测：fetch 报 UND_ERR_CONNECT_TIMEOUT
// 而同一时刻 curl 正常——curl 有 Happy Eyeballs 兜底，Node 没有）。
// 生图/密钥校验都要出国访问自己的中转站，这里统一兜住，省得以后又踩。
dns.setDefaultResultOrder("ipv4first");
import { CardStore, dataDir, newCardId, nowIso, isValidSlug } from "./core/cardStore.js";
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
  moveProviderDefault,
  setProviderEnabled,
  revealApiKey,
  syncToOpenclaw,
  OFFICIAL_PROVIDER_NAME,
  isOfficialProvider,
} from "./core/providers.js";
import { runDistill } from "./distiller/pipeline.js";
import { parsePlainText } from "./distiller/parser.js";
import { RELATION_ROLES } from "./core/schema.js";
import { buildChatSystemAsync, selectTriggeredWorldbook } from "./core/chatPrompt.js";
import { splitReply, describeSplit, isMachineOutput, type SplitStyle } from "./core/splitter.js";
import {
  listPresets,
  addGroup as addPresetGroup,
  renameGroup as renamePresetGroup,
  deleteGroup as deletePresetGroup,
  addItem as addPresetItem,
  updateItem as updatePresetItem,
  deleteItem as deletePresetItem,
  resetBuiltinPresets,
  isBuiltinTierGroup,
  resolveCardPresetBlocks,
  resolveCardPresetExamples,
  type PresetKind,
  type PresetRole,
} from "./core/presets.js";
import { sanitizeChatReply } from "./core/sanitize.js";
import { claimGreeting, isGreeted, clearGreeted, markGreeted } from "./core/greetedStore.js";
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
import { runAsUser, userRoot, DEVICE_ID_RE, currentDeviceId, devicePrefix } from "./core/dataRoot.js";
import { ensureDevice, isDeviceAdmin, listDevices, setDeviceAdmin, setDeviceDisabled, setDeviceLabel } from "./core/users.js";
import {
  accountOwner,
  setAccountOwner,
  clearAccountOwner,
  moveAccountOwner,
  ownsAccount,
  beginLoginClaim,
  endLoginClaim,
  claimNewAccounts,
  attributeWeChatLogin,
} from "./core/channelOwners.js";
import { runRetention, runRetentionForDevice, RETENTION_DAYS } from "./core/retention.js";
import { runMediaSweep } from "./core/mediaSweep.js";
import { getMemImage } from "./core/memImages.js";
import { toUserError } from "./core/errors.js";
import { queryLogs, clearLogs, logInfo, logWarn, logError } from "./core/logger.js";
import { parseUsage, recordLlmUsage, summarizeLlmUsage } from "./core/llmUsage.js";
import { cardToCCv2, ccv2ToCard } from "./core/cardConvert.js";
import { solidPng, pngWithTexts, extractCardJson, pngStripCardMeta, isPng } from "./core/png.js";
import {
  getImageConfig,
  saveImageConfig,
  maskKey,
  testNovelaiKey,
  testOpenAIImageKey,
  listNovelaiGatewayModels,
  rejectForeignKey,
  validateGatewayModel,
  isBuiltinArtist,
  NAI_GATEWAY_BASE,
} from "./core/imageConfig.js";
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
  TTS_PROVIDER_PRESETS,
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
  importEmojisToGroup,
  listGroups,
  addGroup,
  renameGroup,
  deleteGroup,
  moveEmojiToGroup,
  syncEmojisToChannelMedia,
  MAX_EMOJIS,
} from "./core/emojiStore.js";
import { parseEmojiPack } from "./core/emojiPack.js";
import {
  listBots,
  addBot,
  removeBot,
  getBotByCard,
  agentWorkspaceDir,
  deviceAgentId,
  applyAgentHumanDelay,
  applyAgentModel,
  applyAgentBlockStreaming,
  applyAgentSplitStyle,
  applyAgentMemoryScope,
  applyAllAgentMemoryScopes,
  updateBotAccount,
  upsertAgentEntry,
  bindAccountDirect,
  unbindAccountDirect,
  removeAgentEntry,
  clearAgentSessions,
  trimAgentSessionTail,
  CHANNEL_LABELS,
  MAX_QQ_BOTS,
  MAX_WEIXIN_BOTS,
  MAX_QQ_ACCOUNTS,
  MAX_WEIXIN_ACCOUNTS,
  type BotChannel,
  type BotInstance,
} from "./core/botStore.js";
import {
  loadAccountLabels,
  setAccountLabel,
  removeAccountLabel,
  displayName as accountDisplayName,
} from "./core/accountLabels.js";
import {
  readEntries,
  appendEntry,
  deleteEntry,
  updateEntry,
  clearMemory,
  readAllMemories,
  exportMemoryToMarkdown,
  exportAllMemoriesToMarkdown,
  pushChatRound,
  markChatRetry,
  repairChatlogAfterDelete,
  dissolveNewestMemory,
  deleteMemoriesByRounds,
  roundKeyOf,
  evtRangeText,
} from "./core/memoryStore.js";
import { appendConv, readConv, readConvSrcIds, deleteConvByIds, clearConv, type ConvSurface, type ConvEntry } from "./core/conversationStore.js";
import { readChatListState, setPinned, forgetChatListEntry } from "./core/chatListStore.js";
import { recallChatSnippets } from "./core/chatRecall.js";
import {
  listGroupsForCard,
  getGroupDetail,
  deleteGroup as deleteGroupChat,
  renameMember as renameGroupMember,
  recallGroupContext,
  appendGroupTurn,
  ensureGroup,
  memberLabel,
  formatGroupInject,
} from "./core/groupChatStore.js";
import { exportHistoryToMarkdown, exportAllHistoriesToMarkdown, readRecentLocalChat } from "./core/historyExport.js";
import { readConfigState, recordConfigChange, buildConfigChangeReminder, buildConfigSectionForUserMd } from "./core/configState.js";
import {
  pollSessionTurns,
  commitObserveCursor,
  findSession,
  sessionKeyOf,
  listAgentSessionUsers,
  clearObserveCursor,
  type MirrorTurn,
  type SessionInfo,
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

// 公网暴露时启用管理员认证（设置 OPENCLAW_SHELL_UI_USER / OPENCLAW_SHELL_UI_PASS）
// 有认证 = 托管模式（多租户：设备各自命名空间）；无认证 = 单用户模式（全部走全局 data/，
// 就像用户自己拉代码在本机跑起来那样，不需要设备隔离）。
const UI_USER = process.env.OPENCLAW_SHELL_UI_USER;
const UI_PASS = process.env.OPENCLAW_SHELL_UI_PASS;
const HOSTED_MODE = !!(UI_USER && UI_PASS);

// ---------- 设备身份（分发形态：无注册无登录，设备随机 ID 即身份） ----------
// 识别顺序：X-Device-Id 头 > oc_device cookie（<img> 等子资源带不了自定义头，靠 cookie）。
// 识别结果挂 res.locals，Basic 认证在其后：管理员（Basic 有效）覆盖设备身份走全局 data/，
// 设备请求免 Basic、整条链路跑在 data/users/<id>/ 作用域里（AsyncLocalStorage）。
app.use((req, res, next) => {
  const cookies: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* 忽略坏 cookie */
      }
    }
  }
  res.locals.ocCookies = cookies;
  if (!HOSTED_MODE) return next(); // 单用户模式：不做设备隔离
  const cand = String(req.headers["x-device-id"] ?? cookies["oc_device"] ?? "").toLowerCase();
  if (DEVICE_ID_RE.test(cand) && ensureDevice(cand)) {
    if (isDeviceAdmin(cand)) {
      // 管理员设备（运营者自己的浏览器/App）：全局作用域，免密码
      res.locals.ocAdmin = true;
      res.locals.ocAdminVia = "device";
    } else {
      res.locals.ocDevice = cand;
    }
  }
  next();
});

// 两条身份路线互不干扰：
//   ① 管理员 = Basic 凭据 或 管理员登录 cookie（oc_admin）；走全局 data/，能看到全部用户数据
//   ② 分发用户 = 设备随机 ID（cookie/头）；走 data/users/<id>/，免任何登录
// 管理员登录 cookie 让"浏览器已经带了设备 cookie"的情况下也能进管理端（否则 Basic 弹窗永远不出现）。
/** 无状态管理员令牌：HMAC(账号:密码)，改密码即全体失效，不需要会话存储 */
const ADMIN_COOKIE = "oc_admin";
function adminToken(): string {
  if (!UI_USER || !UI_PASS) return "";
  return crypto.createHmac("sha256", "openclaw-shell-admin").update(`${UI_USER}:${UI_PASS}`).digest("hex");
}
function setAdminCookie(req: express.Request, res: express.Response): void {
  const secure = /^https/i.test(String(req.headers["x-forwarded-proto"] ?? "")) || req.secure;
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${adminToken()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}
// 免认证页面/接口：登录页要能打开（外壳静态 + 登录相关端点）
const PUBLIC_SHELL_PATHS = ["/", "/index.html", "/app.js", "/style.css"];
function isPublicPath(p: string): boolean {
  return (
    PUBLIC_SHELL_PATHS.includes(p) ||
    p.startsWith("/assets/") ||
    p.startsWith("/api/admin/")
  );
}
if (UI_USER && UI_PASS) {
  app.use((req, res, next) => {
    const ip = String(req.ip || req.socket.remoteAddress || "");
    const local = ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1");
    if (local && req.path.startsWith("/api/internal/")) return next();
    if (isPublicPath(req.path)) return next();
    // 管理员设备已在设备中间件识别（ocAdmin=true）→ 直接放行走全局 data/
    if (res.locals.ocAdmin) return next();
    const auth = req.headers.authorization ?? "";
    const [type, token] = auth.split(" ");
    if (type === "Basic" && token) {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : "";
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (user === UI_USER && pass === UI_PASS) {
        res.locals.ocDevice = null; // 管理员压过设备身份
        res.locals.ocAdmin = true;
        res.locals.ocAdminVia = "basic";
        return next();
      }
    }
    // 管理员登录 cookie（浏览器里没有 Basic 也能进管理端）
    if (res.locals.ocCookies?.[ADMIN_COOKIE] && res.locals.ocCookies[ADMIN_COOKIE] === adminToken()) {
      res.locals.ocDevice = null;
      res.locals.ocAdmin = true;
      res.locals.ocAdminVia = "cookie";
      return next();
    }
    // 分发用户：设备身份免登录
    if (res.locals.ocDevice) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="openclaw-shell"');
    res.status(401).json({ error: "需要登录" });
  });
}

// ⚠️ 管理员专属前缀的拦截**必须在所有 /api/users/* 路由之前**注册。
// 【2026-09-17 修】原来这段写在 /api/users/admin、/api/users/retention、/api/users/:id/cards(和 chats)
// 的后面，而 Express 是按注册顺序匹配的 → 那几条路由**整个绕过了拦截**。实测：
//   · 设备带头 POST /api/users/admin {id: 自己的id, admin:true} → 200，**任何用户都能把自己提成管理员**
//     （提成后设备中间件会把它当管理员设备，走全局作用域 = 能看到所有人的卡与聊天记录）；
//   · 设备带头 GET /api/users/<别人的id>/chats/<slug> → 200，能读别人的聊天记录；
//   · /api/users/retention 能让设备去删别的设备的过期数据。
// 这类"写在网关前面"的路由以后新增也可能重犯，所以把网关提到最前面（认证/身份中间件之后）。
const ADMIN_ONLY_PREFIXES = [
  "/api/plugins",
  "/api/mcp",
  "/api/users",
  "/api/backup",
  "/api/workspace/",
  "/api/logs",
  "/api/llm-usage",
  "/api/llm/usage",
];
app.use((req, res, next) => {
  if (res.locals.ocDevice && ADMIN_ONLY_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) {
    return res.status(403).json({ error: "该功能不在此版本开放" });
  }
  next();
});

// 管理员登录/登出/状态（免认证，见 isPublicPath）
app.post("/api/admin/login", (req, res) => {
  if (!UI_USER || !UI_PASS) return res.json({ ok: true, admin: true, hint: "未启用认证" });
  const { user, pass } = req.body ?? {};
  if (String(user ?? "") === UI_USER && String(pass ?? "") === UI_PASS) {
    setAdminCookie(req, res);
    return res.json({ ok: true, admin: true });
  }
  res.status(401).json({ error: "账号或密码不对" });
});
app.post("/api/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});
app.get("/api/admin/me", (req, res) => {
  // 该路径在免认证清单里（登录页要能查状态），所以这里自行判定管理员身份
  // hosted 供前端区分「托管多租户」与「单用户自部署」：只有托管形态才需要对用户隐藏管理向功能
  if (!UI_USER || !UI_PASS) return res.json({ admin: true, authDisabled: true, hosted: false });
  if (res.locals.ocAdmin) return res.json({ admin: true, via: res.locals.ocAdminVia, hosted: true });
  const cookie = res.locals.ocCookies?.[ADMIN_COOKIE];
  if (cookie && cookie === adminToken()) return res.json({ admin: true, via: "cookie", hosted: true });
  const auth = req.headers.authorization ?? "";
  const [type, token] = auth.split(" ");
  if (type === "Basic" && token) {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (decoded.slice(0, idx) === UI_USER && decoded.slice(idx + 1) === UI_PASS) {
      return res.json({ admin: true, via: "basic", hosted: true });
    }
  }
  res.json({ admin: false, hosted: true });
});
/**
 * 管理员看某个设备的卡库。
 * **管理员设备要读全局空间**：管理员身份的请求一律走全局 data/，它从不往
 * data/users/<自己的id>/ 里写东西 —— 按命名空间读会永远是空的（运营者实测：
 * "我电脑里明明有卡，打开我的却看不见聊天记录"）。所以：
 *   管理员设备 → 读全局（它平时看到的就是全局那份）；普通设备 → 读它自己的命名空间。
 */
app.get("/api/users/:id/cards", async (req, res) => {
  const id = String(req.params.id ?? "").toLowerCase();
  if (!DEVICE_ID_RE.test(id)) return res.status(400).json({ error: "设备 ID 不合法" });
  const admin = isDeviceAdmin(id);
  // 顺手带上标记：管理员在这一页也想看到"这是谁"（同样只在管理员端点返回）
  const label = listDevices().find((d) => d.id === id)?.label ?? "";
  try {
    const list = admin
      ? await store.list()
      : await runAsUser({ deviceId: id, root: userRoot(id) }, () => store.list());
    res.json({
      admin,
      label,
      cards: list.map((c) => ({ slug: c.slug, name: c.name, updated_at: c.updated_at, avatar: c.avatar })),
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 管理员看某个设备某张卡的聊天记录（纯文本条目，前端一行一句渲染）
app.get("/api/users/:id/chats/:slug", async (req, res) => {
  const id = String(req.params.id ?? "").toLowerCase();
  const slug = String(req.params.slug ?? "");
  if (!DEVICE_ID_RE.test(id) || !isValidSlug(slug)) return res.status(400).json({ error: "参数不合法" });
  const admin = isDeviceAdmin(id);
  try {
    const rows = admin
      ? await readConv(slug)
      : await runAsUser({ deviceId: id, root: userRoot(id) }, () => readConv(slug));
    const entries = rows.map((e) => ({ t: e.t, role: e.role, surface: e.surface, content: e.content }));
    res.json({ entries, admin, retentionDays: RETENTION_DAYS });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 管理员手动跑保留策略（或预演）
app.post("/api/users/retention", async (req, res) => {
  try {
    const days = Number(req.body?.days) > 0 ? Number(req.body.days) : RETENTION_DAYS;
    const dryRun = req.body?.dryRun === true;
    const one = typeof req.body?.id === "string" && DEVICE_ID_RE.test(req.body.id.toLowerCase()) ? req.body.id.toLowerCase() : "";
    const stats = one ? [await runRetentionForDevice(one, { days, dryRun })] : await runRetention({ days, dryRun });
    res.json({ ok: true, dryRun, days, stats });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 管理员把某台设备设为/取消管理员（跨设备迁移管理端用）
app.post("/api/users/admin", (req, res) => {
  const { id, admin } = req.body ?? {};
  const ok = setDeviceAdmin(String(id ?? ""), admin === true);
  if (!ok) return res.status(400).json({ error: "设备不存在或 id 不合法" });
  res.json({ ok: true });
});

// 设备标记（管理员的"昵称"，只为方便搜索）：存在全局注册表里，只有管理员能读写。
// 设备端根本触达不到这个端点（/api/users 在 ADMIN_ONLY_PREFIXES 里），也不会从任何用户接口漏出去。
app.post("/api/users/label", (req, res) => {
  const { id, label } = req.body ?? {};
  const ok = setDeviceLabel(String(id ?? ""), String(label ?? ""));
  if (!ok) return res.status(400).json({ error: "设备不存在或 id 不合法" });
  res.json({ ok: true, label: String(label ?? "").trim().slice(0, 40) });
});

// 设备请求包进用户作用域（此后所有 dataDir() 都指向 data/users/<id>/）
app.use((req, res, next) => {
  const dev = res.locals.ocDevice;
  if (dev) return runAsUser({ deviceId: dev, root: userRoot(dev) }, () => next());
  next();
});

/**
 * 预设：普通用户**照旧能用**预设页 —— 新增预设组、新增/改风格、改自定义组的条目都放行；
 * 唯一的例外是**内置档位组（对外叫「默认」，id=break）**：那是运营者管的破甲预设，
 * 用户既不能打开它（前端不给点），也不能通过接口改它（组名/条目/恢复内置全部拦住）。
 * 管理员不受限（读接口本来就不拦，卡片高级配置的档位下拉还要靠它填）。
 */
app.use((req, res, next) => {
  if (!res.locals.ocDevice || req.method === "GET") return next();
  const m = req.path.match(/^\/api\/presets\/(tier|style)\/([^/]+)/);
  if (m && isBuiltinTierGroup(m[1], m[2])) {
    return res.status(403).json({ error: "该预设不在此版本开放" });
  }
  next();
});

// 内容资源（表情/生图/封面）按请求作用域取目录：<img> 靠 oc_device cookie 带身份。
// 注意必须挂在 ALS 包装之后。同根缓存静态中间件实例，避免每请求重建。
const ocStaticCache = new Map<string, ReturnType<typeof express.static>>();
function ocScopedStatic(sub: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const root = path.join(dataDir(), sub);
    let mw = ocStaticCache.get(root);
    if (!mw) {
      mw = express.static(root);
      ocStaticCache.set(root, mw);
    }
    mw(req, res, next);
  };
}
app.use("/emojis", ocScopedStatic("emojis"));
app.use("/img", ocScopedStatic("images"));
app.use("/covers", ocScopedStatic("covers"));

const projectRoot = findProjectRoot();

/**
 * index.html 的资源版本号自动跟随文件内容（mtime+大小的短哈希）。
 * 背景：静态资源改成 immutable 长效缓存后，如果 html 里的 `?v=` 号忘了手动改，
 * 浏览器会一直用旧的 app.js —— 开发时改了代码看不到效果（实测踩过）。
 * 现在每次请求首页时按 web/app.js 与 style.css 的真实状态重写版本号，改完文件刷新即生效。
 */
async function serveIndexHtml(res: express.Response): Promise<void> {
  const webDir = path.join(projectRoot, "web");
  const stamp = async (file: string): Promise<string> => {
    try {
      const st = await fs.stat(path.join(webDir, file));
      return (st.mtimeMs.toString(36) + st.size.toString(36)).slice(-10);
    } catch {
      return "0";
    }
  };
  const [jsV, cssV] = await Promise.all([stamp("app.js"), stamp("style.css")]);
  let html = await fs.readFile(path.join(webDir, "index.html"), "utf8");
  html = html
    .replace(/app\.js\?v=[^"']*/g, `app.js?v=${jsV}`)
    .replace(/style\.css\?v=[^"']*/g, `style.css?v=${cssV}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(html);
}

app.get("/", (_req, res, next) => {
  void serveIndexHtml(res).catch(next);
});
app.get("/index.html", (_req, res, next) => {
  void serveIndexHtml(res).catch(next);
});

/**
 * 静态资源缓存策略（2026-09-08 优化）。
 * 背景：走 Cloudflare 隧道时每个请求往返 0.5-1.7s，而原来全站 `Cache-Control: no-cache`
 * → app.js（266KB）每次刷新都重新下载、Cloudflare 也 BYPASS 不缓存，首屏白屏 1-2s。
 * 现在：
 *  - app.js / style.css 带 `?v=` 版本号访问 → 视为不可变内容，长效缓存（改版号即刷新）；
 *  - index.html 与无版本号访问 → 仍然 no-cache（保证发版后能立刻拿到新的 html 与版本号）。
 */
app.use(
  express.static(path.join(projectRoot, "web"), {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res, filePath, stat) => {
      const isVersioned = typeof res.req?.query?.v === "string" && res.req.query.v.length > 0;
      const isAsset = /\.(js|css|png|jpe?g|gif|webp|svg|woff2?)$/i.test(filePath);
      if (isVersioned && isAsset) {
        // 版本号变了 URL 就变了，所以内容可以当作不可变（immutable）长期缓存
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);
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

// ---------- 模型用量与缓存命中统计（角色扮演成本优化的实测依据） ----------
// DeepSeek 等上游对「缓存命中的输入」按 1/50 计价，但命中要求前缀逐字节稳定。
// 这里给出真实命中率，用来验证 prompt 结构改动是否生效。
app.get("/api/llm-usage", async (_req, res) => {
  try {
    res.json(await summarizeLlmUsage(30));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
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
// 这个特殊 key 记录"开场白已经写进过会话日志"，用于老数据的一次性补写（不是真实对话方，不会撞）。
const FIRST_MES_LOGGED_KEY = "#first_mes_logged";
app.post("/api/cards/:slug/greeting/claim", async (req, res) => {
  try {
    const { userKey } = req.body ?? {};
    const key = String(userKey ?? "");
    const card = await store.get(req.params.slug);
    const firstMes = card.sillytavern_v2?.first_mes?.trim() ?? "";
    const text = await claimGreeting(card.slug, key, firstMes);
    if (text !== null) {
      // 【2026-09-17 修】开场白同时写进统一会话日志：原来只置了个"已开场"标记，
      // 前端把气泡画在 wbReloadHistory 之前、被随后清空聊天区吃掉 → 用户永远看不到开场白。
      // 只对网页本地会话（userKey=local）写；通道侧 userKey 是 qq:/wx:，由主动推送与镜像负责。
      const entry = key === "local"
        ? await appendConv(card.slug, { role: "assistant", content: text, surface: "web", ns: "local" }).catch(() => null)
        : null;
      if (key === "local") await markGreeted(card.slug, FIRST_MES_LOGGED_KEY).catch(() => {});
      return res.json({ greeted: true, text, entry });
    }
    // 已经开场过（老版本遗留：标记置了、日志里却没有开场白）→ **一次性补写**，让老卡也能看到开场白。
    // 用专门的一次性标记兜住，避免"用户手动删掉开场白后又每次都被翻出来"。
    if (key === "local" && firstMes) {
      const done = await isGreeted(card.slug, FIRST_MES_LOGGED_KEY).catch(() => true);
      if (!done) {
        await markGreeted(card.slug, FIRST_MES_LOGGED_KEY).catch(() => {});
        const entries = await readConv(card.slug).catch(() => []);
        const already = entries.some((e) => e.role === "assistant" && String(e.content ?? "").trim() === firstMes);
        if (!already) {
          const entry = await appendConv(card.slug, { role: "assistant", content: firstMes, surface: "web", ns: "local" }).catch(() => null);
          if (entry) return res.json({ greeted: true, text: firstMes, entry, backfilled: true });
        }
      }
    }
    res.json({ greeted: false, text: null });
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

// ---------- 主动开场白（QQ / 微信）：给绑定该卡的账号下「互动过但还没开场」的用户主动推送开场白 ----------
// QQ：known-users.json 记录 c2c 用户 openid，走 /app/getAppAccessToken + api.sgroup.qq.com/v2/users/{openid}/messages
// 微信：accounts/<id>.context-tokens.json 记录互动用户 ilink_user_id → contextToken，走 ilink/bot/sendmessage
// 只发私聊（c2c），群聊不主动开场；发过即 markGreeted，不重复。
async function sendQQProactiveText(appId: string, clientSecret: string, openid: string, content: string): Promise<boolean> {
  try {
    const tr = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    if (!tr.ok) return false;
    const token = ((await tr.json()) as { access_token?: string }).access_token;
    if (!token) return false;
    const r = await fetch(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(openid)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({ msg_type: 0, content }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** 微信主动发消息：账号文件里有 token/baseUrl，context-tokens 文件里有互动用户的 ilink_user_id → contextToken */
async function sendWeixinProactiveText(accountId: string, userKey: string, contextToken: string | undefined, content: string): Promise<boolean> {
  try {
    const accFile = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts", `${accountId}.json`);
    const acc = JSON.parse(await fs.readFile(accFile, "utf8")) as { token?: string; baseUrl?: string };
    if (!acc.token || !acc.baseUrl) return false;
    // 与插件一致的请求头（iLink-App-Id=bot，版本 2.4.6 → clientVersion 0x020406）
    const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
    const r = await fetch(`${String(acc.baseUrl).replace(/\/+$/, "")}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": uin,
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff)),
        Authorization: `Bearer ${acc.token}`,
      },
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: userKey,
          client_id: `ocw-${Date.now().toString(36)}`,
          message_type: 2, // MessageType.BOT
          message_state: 2, // MessageState.FINISH
          item_list: [{ type: 1, text_item: { text: content } }], // MessageItemType.TEXT
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: { channel_version: "2.4.6", bot_agent: "OpenClaw" },
      }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 给一张卡的所有已绑定通道（QQ/微信）下「互动过但未开场」的私聊用户主动发开场白。
 * 绑定成功后自动调用；也供「清空对话」后补发。幂等：发过即标记，不会重复。
 */
async function pushGreetingForCard(slug: string): Promise<{ sent: string[]; skipped: string[]; channels: string[] }> {
  const card = await store.get(slug).catch(() => null);
  const firstMes = card?.sillytavern_v2?.first_mes?.trim();
  if (!card || !firstMes) return { sent: [], skipped: [], channels: [] };
  const sent: string[] = [];
  const skipped: string[] = [];
  const channels: string[] = [];
  const bots = await listBots().catch(() => [] as { cardSlug: string; channel: string; accountId: string }[]);

  for (const bot of bots.filter((b) => b.cardSlug === slug)) {
    if (bot.channel === "qqbot") {
      channels.push("qq");
      const usersFile = path.join(os.homedir(), ".openclaw", "qqbot", "data", "known-users.json");
      const known = JSON.parse(await fs.readFile(usersFile, "utf8").catch(() => "[]")) as {
        type?: string; openid?: string; accountId?: string;
      }[];
      const targets = known.filter((u) => u.type === "c2c" && u.accountId === bot.accountId && u.openid);
      const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"));
      const acc = cfg.channels?.qqbot?.accounts?.[bot.accountId];
      if (!acc?.appId || !acc?.clientSecret) continue;
      for (const u of targets) {
        const key = `qq:${u.openid}`;
        if (await isGreeted(slug, key)) { skipped.push(key); continue; }
        const ok = await sendQQProactiveText(String(acc.appId), String(acc.clientSecret), String(u.openid), firstMes);
        if (ok) { await markGreeted(slug, key); sent.push(key); } else { skipped.push(key); }
      }
    } else if (bot.channel === "openclaw-weixin") {
      channels.push("wx");
      const ctxFile = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts", `${bot.accountId}.context-tokens.json`);
      const ctxMap = JSON.parse(await fs.readFile(ctxFile, "utf8").catch(() => "{}")) as Record<string, string>;
      for (const [userKey, contextToken] of Object.entries(ctxMap)) {
        const key = `wx:${userKey}`;
        if (await isGreeted(slug, key)) { skipped.push(key); continue; }
        const ok = await sendWeixinProactiveText(bot.accountId, userKey, contextToken, firstMes);
        if (ok) { await markGreeted(slug, key); sent.push(key); } else { skipped.push(key); }
      }
    }
  }
  return { sent, skipped, channels };
}

app.post("/api/cards/:slug/greeting/push", async (req, res) => {
  try {
    const r = await pushGreetingForCard(req.params.slug);
    res.json({
      ok: r.sent.length > 0,
      sent: r.sent,
      skipped: r.skipped,
      info: r.channels.length === 0
        ? "这张卡没绑 QQ/微信机器人"
        : r.sent.length
          ? `✓ 已主动发送开场白 ${r.sent.length} 条${r.skipped.length ? `（${r.skipped.length} 个已开场过/发送失败，跳过）` : ""}`
          : r.skipped.length
            ? "没有可发送的用户：都已开场过，或发送失败（检查 48h 互动窗口）"
            : "还没有互动过的用户——用户先给机器人发一条消息后，才能主动开场",
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
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
    // 记录扮演配置变更（风格/条数/预设档位）→ 供网页与通道的「变更强提醒」注入
    await recordConfigChange(body as PersonaCard).catch(() => {});
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
    await forgetChatListEntry(slug).catch(() => {}); // 通讯录置顶记录
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
    // 封面也按卡存（covers/<slug>.<ext>，扩展名不定 → 按前缀清；漏掉会留孤儿封面）
    for (const f of await fs.readdir(path.join(root, "covers")).catch(() => [] as string[])) {
      if (f === slug || f.startsWith(`${slug}.`)) {
        await fs.rm(path.join(root, "covers", f), { force: true }).catch(() => {});
      }
    }
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
    invalidateBindingsCache();
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
/**
 * 这个机器人是否必须走官方中转站（Soul API）。
 * 规则（用户拍板）：通道机器人按创建时间排序，**第 3 个起**强制锁定官方中转站，
 * 不能改用其他模型商（前两个自由选）。本地网页聊天完全不受影响（它不走这里）。
 * @param cardSlug 目标卡；该卡还没有 bot 时按"即将成为第 N 个"预判
 */
async function mustUseOfficialProvider(cardSlug?: string): Promise<boolean> {
  const bots = await listBots().catch(() => []);
  const idx = cardSlug ? bots.findIndex((b) => b.cardSlug === cardSlug) : -1;
  // 已存在：按它在创建顺序中的位次（0/1 自由，2 起锁定）
  if (idx >= 0) return idx >= OFFICIAL_LOCK_FROM - 1;
  // 还没建：算上自己是第 bots.length + 1 个
  return bots.length + 1 >= OFFICIAL_LOCK_FROM;
}

/** 从第几个机器人开始强制用官方中转站（第 1、2 个自由选商） */
const OFFICIAL_LOCK_FROM = 3;

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
  //    第 3 个起的机器人强制官方中转站（卡里选了别的商也忽略）
  const llm = await resolveChatLLM(card, { forceOfficial: await mustUseOfficialProvider(card.slug) });
  if (llm) {
    const model = `${llm.provider}/${llm.model}`;
    const changed = await applyAgentModel(bot.agentId, model).catch(() => false);
    if (changed) notes.push(`模型已切到 ${model}`);
  }
  // ③ 节奏：humanDelay 同步（与创建/重编译接口一致）
  await applyAgentHumanDelay(bot.agentId, card.chat?.delay).catch(() => {});
  // ④ 拆条：blockStreaming 安全值写渠道账号（真正的语义拆条在通道插件补丁）+ 风格写侧车表（每卡独立）
  const splitStyle: SplitStyle = card.presets?.style === "rich" ? "rich" : "chat";
  await applyAgentBlockStreaming(bot.channel, bot.accountId, { style: splitStyle }).catch(() => {});
  await applyAgentSplitStyle(bot.agentId, splitStyle).catch(() => {});
  // ⑤ 检索隔离：该 agent 只搜本卡的记忆/本地聊天原文（defaults 全局检索池已关闭）
  await applyAgentMemoryScope(bot.agentId, bot.cardSlug).catch(() => {});
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

/**
 * 设备作用域下把通道状态里的账号列表过滤成自己的（管理员原样返回）。
 * 通道级的状态缓存是全服共用的，所以过滤必须在**返回前**按请求做，不能塞进缓存里。
 */
function filterChannelStatus(channel: string, st: ChannelStatus | undefined, dev: string | null | undefined): ChannelStatus | undefined {
  if (!dev || !st) return st;
  const mine = (st.accounts ?? []).filter((id) => ownsAccount(channel, id, dev));
  const has = mine.length > 0;
  // 设备作用域下，通道级 configured 是"服务器装没装这个通道"，不代表"你有账号"——
  // 不按账号数压掉的话会出现「已连接 ✓」与「还没有绑定账号，点上方按钮扫码」并存的矛盾 UI（09-17 线上实锤）
  return { ...st, accounts: mine, connected: has ? st.connected : false, configured: has ? st.configured : false };
}

/** 设备作用域下必须拥有该账号才能操作；返回 false 时已经写过 403 响应 */
function requireOwnedAccount(channel: string, accountId: string, res: express.Response): boolean {
  const dev = res.locals.ocDevice as string | null | undefined;
  if (!dev) return true;
  if (ownsAccount(channel, accountId, dev)) return true;
  res.status(403).json({ error: "这个账号不属于你" });
  return false;
}

/** 设备点了扫码：记下当前账号快照，之后新出现的账号才算它扫的（老账号含运营者的不会被认领） */
async function beginClaimForDevice(channel: BotChannel, res: express.Response): Promise<void> {
  const dev = res.locals.ocDevice as string | null | undefined;
  if (!dev) return;
  const known = (await scanAllAccounts().catch(() => [])).filter((a) => a.channel === channel).map((a) => a.accountId);
  beginLoginClaim(channel, dev, known);
}

/**
 * QQ 登录成功后的归属判定（事件驱动，替代快照差集）：
 * 官方 bot 的 appId 写在 channels.qqbot 根 = 单槽位 "default"，谁扫码谁所有。
 * 快照差集在这个槽位上失效（重扫覆盖同一个槽位名，永远不算"新账号"→ 之前"App 提示成功但列表空"的根源），
 * 所以登录成功（凭证已落盘）时直接把槽位判给发起设备。
 */
async function attributeQqLoginToDevice(deviceId: string): Promise<void> {
  setAccountOwner("qqbot", "default", deviceId);
  const cleaned = await cleanupForeignBots("qqbot", "default", deviceId);
  invalidateChannelStatus();
  logInfo("通道", `QQ 登录归属完成：default → 设备 ${deviceId.slice(0, 8)}…${cleaned.length ? `；清理他人残留 bot ${cleaned.length} 个` : ""}`);
}

/**
 * 清理其他设备/管理员名下绑在 <channel>:<accountId> 上的僵尸 bot 并解除路由：
 * 设备重新扫码会覆盖槽位凭证，旧主人的 bot 记录与路由若不清理，
 * 新用户的私聊会被路由进旧主人的卡（跨用户串话）。
 * 只动 bot 记录与路由绑定（直写 openclaw.json，毫秒级），不删对方 agent（卡的运行时保留）。
 */
async function cleanupForeignBots(channel: BotChannel, accountId: string, newOwnerId: string): Promise<string[]> {
  const removed: string[] = [];
  const cleanScope = async (label: string, remove: (id: string) => Promise<unknown>) => {
    for (const b of await listBots().catch(() => [])) {
      if (b.channel !== channel || b.accountId !== accountId) continue;
      await unbindAccountDirect(channel, accountId).catch(() => null);
      await remove(b.id).catch(() => null);
      removed.push(`${label}:${b.agentId}`);
    }
  };
  await cleanScope("全局", (id) => removeBot(id));
  for (const d of listDevices()) {
    const devId = String(d?.id ?? "");
    if (!DEVICE_ID_RE.test(devId) || devId === newOwnerId || d.disabled) continue;
    await runAsUser({ deviceId: devId, root: userRoot(devId) }, async () => {
      await cleanScope(devId.slice(0, 8), (id) => removeBot(id));
    }).catch(() => {});
  }
  invalidateBindingsCache();
  return removed;
}

/**
 * 微信顶掉式归属（2026-09-18 业主拍板，与 QQ 同语义）：登录成功后真实账号可能晚几秒才落盘，
 * 轮询重入 attributeWeChatLogin（判定规则见 channelOwners.ts），命中即无条件改判给发起设备，
 * 有旧主的连旧主僵尸 bot 一起清。判定不到（账号一直没落盘）只告警不报错。
 */
async function attributeWeChatLoginWithCleanup(deviceId: string): Promise<void> {
  const credMtime = (id: string): number => {
    try {
      return statSync(path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts", `${id}.json`)).mtimeMs;
    } catch {
      return 0;
    }
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const ids = (await scanAllAccounts().catch(() => []))
      .filter((a) => a.channel === "openclaw-weixin")
      .map((a) => a.accountId);
    const { attributed, needBotCleanup } = attributeWeChatLogin(deviceId, ids, credMtime);
    if (attributed.length) {
      const cleaned: string[] = [];
      for (const accountId of needBotCleanup) {
        cleaned.push(...(await cleanupForeignBots("openclaw-weixin", accountId, deviceId).catch(() => [] as string[])));
      }
      invalidateChannelStatus();
      invalidateBindingsCache();
      logInfo(
        "通道",
        `微信登录归属完成（顶掉式）：→ 设备 ${deviceId.slice(0, 8)}…：${attributed
          .map((a) => `${a.accountId}${a.prevOwner ? `（顶掉 ${a.prevOwner.slice(0, 8)}…）` : "（新认领）"}`)
          .join("、")}${cleaned.length ? `；清理他人残留 bot ${cleaned.length} 个` : ""}`
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  logWarn("通道", `微信登录归属：登录成功但 15s 内没有扫到可归属的账号变化（账号未落盘或已归自己）`);
}

// ---------- 通道：微信 ----------
/**
 * 微信账号掉线侦测（2026-09-18）：个人号会话失效是**静默**的——插件 running 只代表在空转，
 * 无报错无断连事件，通道页会一直显示"已连接 ✓"。唯一免费的存活信号是**续期令牌**文件的
 * mtime（活账号持续续期刷新，死账号永远停摆）。⚠️ 只看 context-tokens：sync.json 是插件
 * 簿记文件，死账号也在刷，会污染信号。超过 12h 没续期 = 微信侧会话已死。
 * QQ 不需要（官方连接器的 connected 是真状态）。只在通道页/槽满提示里点名死账号，平常不显示。
 */
const WECHAT_STALE_MS = 12 * 3600 * 1000;

function wechatStaleIds(): string[] {
  const base = path.join(os.homedir(), ".openclaw", "openclaw-weixin");
  let list: string[] = [];
  try {
    const idx = JSON.parse(readFileSync(path.join(base, "accounts.json"), "utf8")) as unknown[];
    list = idx.filter((x): x is string => typeof x === "string" && !!x);
  } catch {
    return []; // 索引读不到就不报警（宁可漏报不误报）
  }
  const out: string[] = [];
  const now = Date.now();
  for (const id of list) {
    // 存活信号只认续期令牌；令牌缺失时退回登录凭证本体
    let mtimeMs = 0;
    for (const suffix of [".context-tokens.json", ".json"]) {
      try {
        mtimeMs = statSync(path.join(base, "accounts", `${id}${suffix}`)).mtimeMs;
        break;
      } catch { /* 该文件不存在，试下一个 */ }
    }
    if (mtimeMs && now - mtimeMs > WECHAT_STALE_MS) out.push(id);
  }
  return out;
}

app.get("/api/channels/wechat/status", async (req, res) => {
  try {
    const all = await getChannelStatuses(req.query.refresh === "1");
    const st = filterChannelStatus("openclaw-weixin", all["openclaw-weixin"], res.locals.ocDevice);
    const staleAll = wechatStaleIds();
    res.json({
      connected: channelUsable(st),
      accounts: st?.accounts ?? [],
      // 只报请求者可见账号里已掉线的；前端仅在其中有死账号时点名，平常不加显示
      stale: (st?.accounts ?? []).filter((id) => staleAll.includes(id)),
      detail: st ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/channels/wechat/login", async (_req, res) => {
  // 槽位满了就不生成二维码：必须先彻底删掉一个账号（用户拍板的语义）
  const slot = await accountSlotState("openclaw-weixin").catch(() => null);
  if (slot?.full) {
    // 槽满时点名已掉线的账号（业主 09-18 实测痛点：死账号占着名额，用户不知道该删谁）
    const dead = wechatStaleIds();
    const hint = dead.length ? `看起来「${dead.join("」「")}」已经掉线，删除它可以腾出名额。` : "";
    return res.status(400).json({
      error: `微信账号已存满（${slot.used}/${slot.max}）。请先在下方账号列表里彻底删除一个，再扫码添加新的。${hint}`,
      accountSlotFull: true,
      slot,
    });
  }
  const dev = res.locals.ocDevice as string | null | undefined;
  const devLabel = dev ? `设备 ${dev.slice(0, 8)}…` : "管理员";
  await beginClaimForDevice("openclaw-weixin", res);
  logInfo("通道", `扫码登录[微信]：发起（${devLabel}）`);
  // 设备作用域：传一次性临时账号名（UUID 形状 → 微信插件视作"临时会话键"，不落持久别名、不做别名冲突检查）。
  // 不传的话 CLI 会拿通道现有默认账号当请求 alias，与该 alias 已存凭证必然冲突
  // （09-17 实锤：already has credentials for a different bot——每个用户扫码产生的是自己的新 bot）。
  // 凭证最终落在真实 bot hash 名下并登记进账号索引，由认领机制判给发起设备。
  res.json(
    startChannelLogin("openclaw-weixin", {
      cliAccount: dev ? crypto.randomUUID() : undefined,
      onDone: ({ ok, note, elapsedMs }) => {
        logInfo("通道", `扫码登录[微信]：${ok ? "成功" : "失败"}（${devLabel}，耗时 ${(elapsedMs / 1000).toFixed(0)}s${note ? `，${note}` : ""}）`);
        // 微信顶掉式归属（2026-09-18）：登录成功 → 无条件把摸过的账号改判给发起设备（后扫顶前扫），
        // 与 QQ 的 attributeQqLoginToDevice 同语义；真实账号晚几秒落盘，函数内部轮询重入。
        if (ok && dev) {
          const devId = dev;
          void attributeWeChatLoginWithCleanup(devId).catch((e) => logWarn("通道", `微信归属判定异常`, e));
        }
      },
    })
  );
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
  // 配对是运营者自己 ClawBot 账号的事（灰度通道），不给分发用户用
  if (res.locals.ocDevice) return res.json({ raw: "" });
  try {
    const r = await runOpenclaw(["pairing", "list", "openclaw-weixin"], { timeoutMs: 20000 });
    res.json({ raw: stripAnsi(r.stdout + r.stderr) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/channels/wechat/pairing/approve", async (req, res) => {
  if (res.locals.ocDevice) return res.status(403).json({ error: "该功能不在此版本开放" });
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
    const st = filterChannelStatus("qqbot", all["qqbot"], res.locals.ocDevice);
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

app.post("/api/channels/qq/login", async (_req, res) => {
  const dev = res.locals.ocDevice as string | null | undefined;
  const devLabel = dev ? `设备 ${dev.slice(0, 8)}…` : "管理员";
  await beginClaimForDevice("qqbot", res);
  logInfo("通道", `扫码登录[QQ]：发起（${devLabel}）`);
  const slot = await accountSlotState("qqbot").catch(() => null);
  if (slot?.full) {
    return res.status(400).json({
      error: `QQ 账号已存满（${slot.used}/${slot.max}）。请先在下方账号列表里彻底删除一个，再扫码添加新的。`,
      accountSlotFull: true,
      slot,
    });
  }
  // 设备作用域：登录成功（CLI exit 0，appId 已写入根槽位）后把槽位判给发起设备，并清理他人残留绑定。
  // 快照差集对 QQ 单槽位是失效的（重扫永远覆盖同一个槽位名 "default"，不算"新账号"）→ 假成功的根源。
  if (dev) {
    const d: string = dev;
    res.json(
      startChannelLogin("qqbot", {
        deviceId: d,
        onOk: () => attributeQqLoginToDevice(d),
        onDone: ({ ok, note, elapsedMs }) =>
          logInfo("通道", `扫码登录[QQ]：${ok ? "成功" : "失败"}（${devLabel}，耗时 ${(elapsedMs / 1000).toFixed(0)}s${note ? `，${note}` : ""}）`),
      })
    );
  } else {
    res.json(
      startChannelLogin("qqbot", {
        onDone: ({ ok, note, elapsedMs }) =>
          logInfo("通道", `扫码登录[QQ]：${ok ? "成功" : "失败"}（${devLabel}，耗时 ${(elapsedMs / 1000).toFixed(0)}s${note ? `，${note}` : ""}）`),
      })
    );
  }
});

app.get("/api/channels/qq/login", async (_req, res) => {
  res.json(await loginStateWithQr(getChannelLoginState("qqbot")));
});

// 取消扫码：前端关掉二维码弹窗/离开页面时调。登录进程会一直挂着等扫码（实测能占 200MB+），必须回收
app.post("/api/channels/:kind/login/cancel", (req, res) => {
  // 用户放弃扫码：清掉待领取快照（管理员无快照，调用无副作用）
  if (res.locals.ocDevice) endLoginClaim(String(req.params.kind) === "qq" ? "qqbot" : "openclaw-weixin", String(res.locals.ocDevice));
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

/**
 * 账号槽位是否还有空位（与「绑卡上限」不是一回事）。
 * 本机最多保存 QQ 5 / 微信 2 个已认证账号；满了就不再生成二维码，
 * 必须先在通道连接页「彻底删除」一个账号（连凭证一起删）才能扫新的。
 */
async function accountSlotState(channel: BotChannel): Promise<{ used: number; max: number; full: boolean }> {
  const all = await scanKnownAccounts();
  const used = all.filter((a) => a.channel === channel).length;
  const max = channel === "qqbot" ? MAX_QQ_ACCOUNTS : MAX_WEIXIN_ACCOUNTS;
  return { used, max, full: used >= max };
}

/** 扫描已认证渠道账号：QQ 读 openclaw.json channels.qqbot（默认+多账号），微信读插件账号索引 */
/**
 * 全局扫一遍网关里已认证的渠道账号（不过滤归属）。
 * 设备作用域下**必须**走 scanKnownAccounts() 那个带过滤的版本，否则会把别人的账号摊出来。
 */
async function scanAllAccounts(): Promise<KnownAccount[]> {
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
 * 带归属过滤的账号扫描（全项目读账号都走这里）：
 *  - 管理员/单用户作用域（currentDeviceId 为空）：全部可见，与以前完全一致；
 *  - 设备作用域：只看得到**归属自己的**账号；没有归属记录的（老账号、运营者自己的）
 *    一律看不见；同时把"本次扫码新出现的账号"认领给正在扫码的那台设备。
 */
async function scanKnownAccounts(): Promise<KnownAccount[]> {
  const all = await scanAllAccounts();
  const dev = currentDeviceId();
  if (!dev) return all;
  for (const ch of ["qqbot", "openclaw-weixin"]) {
    claimNewAccounts(ch, all.filter((a) => a.channel === ch).map((a) => a.accountId));
  }
  return all.filter((a) => accountOwner(a.channel, a.accountId) === dev);
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
  // 归属跟着搬：占位名（wx-main）换成网关下发的真实 id，别让它变成"无主的运营者账号"
  moveAccountOwner(bot.channel, bot.accountId, target.accountId);
  invalidateAgentsCache();
    invalidateChannelStatus();
    invalidateBindingsCache();
  return updated;
}

/**
 * 修复缺失的路由绑定。
 * bots.json 里有实例、但 OpenClaw 的 routing bindings 里没有对应条目时，消息会落到默认
 * agent（用共享 workspace 的人设），表现就是"连上了却不是这张卡在回"。
 * 成因：agents add 时 bind 失败/后来被 agents delete 顺带清掉/手工改过配置。
 * 这里查一遍 bindings，缺的补上（幂等，已存在的不动）。
 */
// bindings 查询缓存：这条 CLI 实测 5-15s，进通道页/换卡刷新都要用，没缓存等于每次都卡住
let bindingsCache: { text: string; at: number } | null = null;
let bindingsInflight: Promise<{ text: string; ok: boolean }> | null = null;
const BINDINGS_CACHE_MS = 60000;

function invalidateBindingsCache(): void {
  bindingsCache = null;
}

async function getBindingsText(force = false): Promise<{ text: string; ok: boolean }> {
  if (!force && bindingsCache && Date.now() - bindingsCache.at < BINDINGS_CACHE_MS) {
    return { text: bindingsCache.text, ok: true };
  }
  if (bindingsInflight) return bindingsInflight; // 并发合并：并行跑 openclaw 会互相拖慢
  bindingsInflight = (async () => {
    const r = await runOpenclaw(["agents", "bindings"], { timeoutMs: 60000 });
    const text = stripAnsi(r.stdout + r.stderr);
    const ok = r.code === 0 && /Routing bindings|No routing bindings/i.test(text);
    if (ok) bindingsCache = { text, at: Date.now() };
    return { text, ok };
  })();
  try {
    return await bindingsInflight;
  } finally {
    bindingsInflight = null;
  }
}

async function repairBotBindings(bots: BotInstance[]): Promise<string[]> {
  if (bots.length === 0) return [];
  const r = await getBindingsText();
  const text = r.text;
  if (!r.ok) return []; // CLI 没跑通就别乱补
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

/**
 * 通道连接页数据：机器人实例 + 已知账号（含未绑定的可复用账号）。
 * 【提速 2026-09-08】默认只读本地文件（bots.json / openclaw.json / 微信 accounts.json），毫秒级返回。
 * 原来每次进页面都跑 reconcile + repair 两轮 openclaw CLI（5-15s 起），换完卡刷新要等它跑完才更新，
 * 用户体感就是"换卡没成功"。现在自愈动作只在 `?repair=1` 时做（前端渲染完再后台补一次）。
 */
app.get("/api/channels/connections", async (req, res) => {
  try {
    const doRepair = req.query.repair === "1";
    const bots = await listBots();
    const accounts = await scanKnownAccounts();
    let repaired: string[] = [];
    let freshBots = bots;
    if (doRepair) {
      // 顺手校正微信这类"真实账号 id 由服务器下发"的占位绑定（错过登录轮询也能自愈）
      let reconciled = 0;
      for (const b of bots) {
        if (!accounts.some((a) => a.channel === b.channel && a.accountId === b.accountId)) {
          const fixed = await reconcileBotAccount(b).catch(() => null);
          if (fixed) reconciled++;
        }
      }
      freshBots = reconciled > 0 ? await listBots() : bots;
      // 补齐缺失的路由绑定（否则消息会落到默认 agent，表现为"回的不是这张卡"）
      repaired = await repairBotBindings(freshBots).catch(() => []);
    }
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
    const labels = await loadAccountLabels();
    const limits = {
      maxQq: MAX_QQ_BOTS,
      maxWeixin: MAX_WEIXIN_BOTS,
      maxQqAccounts: MAX_QQ_ACCOUNTS,
      maxWeixinAccounts: MAX_WEIXIN_ACCOUNTS,
    };
    // 账号槽位用量：前端据此显示 3/5 与「已存满」，并禁掉扫码按钮
    const slots = {
      qqbot: {
        used: accounts.filter((a) => a.channel === "qqbot").length,
        max: MAX_QQ_ACCOUNTS,
      },
      "openclaw-weixin": {
        used: accounts.filter((a) => a.channel === "openclaw-weixin").length,
        max: MAX_WEIXIN_ACCOUNTS,
      },
    };
    res.json({
      bots: freshBots.map((b) => ({
        ...b,
        cardName: cardNames.get(b.cardSlug) ?? b.cardSlug,
        // 机器人行显示昵称，accountId 只在详情里露出
        accountLabel: accountDisplayName(labels, b.channel, b.accountId),
      })),
      accounts: accounts.map((a) => {
        const bound = boundByAccount.get(`${a.channel}:${a.accountId}`);
        return {
          ...a,
          label: accountDisplayName(labels, a.channel, a.accountId, a.name),
          hasLabel: Boolean(labels[`${a.channel}:${a.accountId}`]),
          boundBotId: bound?.id ?? null,
          boundCardSlug: bound?.cardSlug ?? null,
          boundCardName: bound ? cardNames.get(bound.cardSlug) ?? bound.cardSlug : null,
        };
      }),
      limits,
      slots,
      repaired,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 账号昵称：用户自己起名，底层仍按 accountId 路由 ----------
app.post("/api/channels/accounts/label", async (req, res) => {
  try {
    const { channel, accountId, label } = req.body ?? {};
    if (channel !== "qqbot" && channel !== "openclaw-weixin") return res.status(400).json({ error: "通道选择不正确" });
    const acc = String(accountId ?? "").trim();
    if (!acc) return res.status(400).json({ error: "缺少账号 id" });
    if (!requireOwnedAccount(channel, acc, res)) return;
    const labels = await setAccountLabel(channel, acc, String(label ?? ""));
    res.json({ ok: true, labels });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/**
 * 彻底删除渠道账号（连凭证一起删）——账号槽位满了之后腾位置的唯一手段。
 * 顺序：先卸掉占用它的 bot 实例与 agent → openclaw channels remove --delete 删配置与会话
 * → 清插件侧残留（微信 accounts.json / accounts 下的 json、QQ 的账号目录）→ 清昵称。
 */
app.post("/api/channels/accounts/delete", async (req, res) => {
  try {
    const { channel, accountId } = req.body ?? {};
    if (channel !== "qqbot" && channel !== "openclaw-weixin") return res.status(400).json({ error: "通道选择不正确" });
    const acc = String(accountId ?? "").trim();
    if (!acc) return res.status(400).json({ error: "缺少账号 id" });
    if (!requireOwnedAccount(channel, acc, res)) return;
    const notes: string[] = [];

    // ① 该账号若还绑着卡，先把 bot 实例和 agent 一起卸掉
    for (const b of (await listBots()).filter((x) => x.channel === channel && x.accountId === acc)) {
      await runOpenclaw(["agents", "delete", b.agentId, "--force"], { timeoutMs: 60000 }).catch(() => null);
      await removeBot(b.id).catch(() => null);
      notes.push(`已卸下机器人（卡 ${b.cardSlug}）`);
    }

    // ② 官方 CLI 删账号配置（--delete 直接删条目，不留 disabled 残壳）
    const rm = await runOpenclaw(
      ["channels", "remove", "--channel", channel, "--account", acc, "--delete"],
      { timeoutMs: 60000 }
    ).catch(() => null);
    if (rm && rm.code === 0) notes.push("已删除通道账号配置");

    // ③ 清残留：CLI 对插件私有目录不负责，不清会被 scanKnownAccounts 再扫出来
    const ocHome = path.join(os.homedir(), ".openclaw");
    if (channel === "openclaw-weixin") {
      const base = path.join(ocHome, "openclaw-weixin");
      const idxPath = path.join(base, "accounts.json");
      try {
        const list = JSON.parse(await fs.readFile(idxPath, "utf8"));
        if (Array.isArray(list)) {
          const next = list.filter((id) => id !== acc);
          await fs.writeFile(idxPath, JSON.stringify(next, null, 2), "utf8");
          notes.push("已从微信账号索引移除");
        }
      } catch { /* 索引不存在就不用清 */ }
      // 账号态文件：<acc>.json / .sync.json / .context-tokens.json
      const accDir = path.join(base, "accounts");
      for (const f of await fs.readdir(accDir).catch(() => [] as string[])) {
        if (f.startsWith(acc)) await fs.rm(path.join(accDir, f), { force: true }).catch(() => {});
      }
      // openclaw.json 里的账号条目：CLI 的 channels remove 不动微信这一段（2026-09-17 实测漏了，
      // 不清的话配置里永远留着一条 per-account 残壳），跟 QQ 分支一样按 key 删掉
      const wxCfg = path.join(ocHome, "openclaw.json");
      try {
        const conf = JSON.parse(await fs.readFile(wxCfg, "utf8"));
        if (conf?.channels?.["openclaw-weixin"]?.accounts?.[acc]) {
          delete conf.channels["openclaw-weixin"].accounts[acc];
          await fs.writeFile(wxCfg, JSON.stringify(conf, null, 2), "utf8");
          notes.push("已从配置移除微信账号");
        }
      } catch { /* 配置读不到就跳过 */ }
    } else {
      // QQ：openclaw.json 里的账号条目 + ~/.openclaw/qqbot/<acc> 目录
      const cfgPath = path.join(ocHome, "openclaw.json");
      try {
        const conf = JSON.parse(await fs.readFile(cfgPath, "utf8"));
        if (conf?.channels?.qqbot?.accounts?.[acc]) {
          delete conf.channels.qqbot.accounts[acc];
          await fs.writeFile(cfgPath, JSON.stringify(conf, null, 2), "utf8");
          notes.push("已从配置移除 QQ 账号");
        }
      } catch { /* 配置读不到就跳过 */ }
      // 插件私有目录：<acct> 的账号态 + data/<acct> 的消息索引（实测能到几百 KB）
      await fs.rm(path.join(ocHome, "qqbot", acc), { recursive: true, force: true }).catch(() => {});
      await fs.rm(path.join(ocHome, "qqbot", "data", acc), { recursive: true, force: true }).catch(() => {});
      // 跟这个账号聊过的人（别人 openid 躺在 known-users.json 里）+ 该账号的凭证备份
      // —— 用户明确"不希望自己的号影响到别处"，这两样必须一起清
      const kuPath = path.join(ocHome, "qqbot", "data", "known-users.json");
      try {
        const raw = JSON.parse(await fs.readFile(kuPath, "utf8"));
        if (Array.isArray(raw)) {
          const next = raw.filter((x) => String((x as { accountId?: unknown })?.accountId ?? "") !== acc);
          if (next.length !== raw.length) {
            await fs.writeFile(kuPath, JSON.stringify(next, null, 2), "utf8");
            notes.push(`已清 ${raw.length - next.length} 条该账号的 known-users 记录`);
          }
        }
      } catch { /* 没有这个文件 */ }
      const cbPath = path.join(ocHome, "qqbot", "data", "credential-backup", "current.json");
      try {
        const cb = JSON.parse(await fs.readFile(cbPath, "utf8"));
        if (String((cb as { accountId?: unknown })?.accountId ?? "") === acc) {
          await fs.rm(cbPath, { force: true }).catch(() => {});
          notes.push("已删除该账号的凭证备份");
        }
      } catch { /* 没有备份文件 */ }
    }

    await removeAccountLabel(channel, acc).catch(() => {});
    clearAccountOwner(channel, acc); // 槽位释放后 id 可能被复用，归属一并清掉
    invalidateAgentsCache();
    invalidateChannelStatus();
    invalidateBindingsCache();
    logInfo("通道", `彻底删除账号 ${channel}:${acc}（${notes.join("；") || "无残留"}）`);
    res.json({ ok: true, notes, hint: "账号已彻底删除，槽位已释放，可以扫码添加新账号了" });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/bots", async (req, res) => {
  try {
    const bots = await listBots();
    const limits = { maxQq: MAX_QQ_BOTS, maxWeixin: MAX_WEIXIN_BOTS };
    // 没有实例就不必查 agent 状态，省掉 CLI 冷启动
    if (bots.length === 0) {
      return res.json({ bots: [], limits, official: { name: OFFICIAL_PROVIDER_NAME, lockFrom: OFFICIAL_LOCK_FROM, nextLocked: false } });
    }
    const labels = await loadAccountLabels();
    // skipStatus=1：只要实例数据不查存活（前端开面板首屏用，秒回）
    // 官方锁定：第 3 个起（按创建顺序）强制走官方中转站，前端据此禁用模型选择
    const official = { name: OFFICIAL_PROVIDER_NAME, lockFrom: OFFICIAL_LOCK_FROM, nextLocked: bots.length + 1 >= OFFICIAL_LOCK_FROM };
    const withLock = (b: BotInstance, i: number) => ({ officialLocked: i >= OFFICIAL_LOCK_FROM - 1 });
    if (req.query.skipStatus === "1") {
      return res.json({
        bots: bots.map((b, i) => ({
          ...b,
          channelLabel: CHANNEL_LABELS[b.channel],
          accountLabel: accountDisplayName(labels, b.channel, b.accountId),
          agentExists: null,
          ...withLock(b, i),
        })),
        limits,
        official,
      });
    }
    const { text: agentsText, ok: listOk } = await getAgentsList(req.query.refresh === "1");
    res.json({
      bots: bots.map((b, i) => ({
        ...b,
        channelLabel: CHANNEL_LABELS[b.channel],
        accountLabel: accountDisplayName(labels, b.channel, b.accountId),
        // CLI 跑挂/超时时输出不完整，不能断言"不存在"，返回 null 表示未知
        agentExists: listOk ? new RegExp(`^-\\s+${b.agentId}(\\s|$)`, "m").test(agentsText) : null,
        ...withLock(b, i),
      })),
      limits,
      official,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/bots", async (req, res) => {
  try {
    const { cardSlug, channel, accountId, replace } = req.body ?? {};
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
    // 设备侧归属检查：这次要绑的账号必须
    //   ① 已归它自己（之前扫过/建过），或 ② 是个还没在网关里出现过的新占位名（它正要扫码）
    // —— 别人的账号（含运营者的老账号）一律拒绝，别看列表里没有就能硬绑
    const dev = res.locals.ocDevice as string | null | undefined;
    if (dev) {
      const alreadyOwned = accountOwner(channel, account) === dev;
      const existsInGateway = (await scanAllAccounts()).some((a) => a.channel === channel && a.accountId === account);
      if (!alreadyOwned && existsInGateway) {
        return res.status(403).json({ error: "这个账号不属于你" });
      }
      setAccountOwner(channel, account, dev); // 新占位名直接认领；已归自己的幂等
    }
    // 新建扫码账号（没传 accountId）前先看槽位：满了就别让用户白扫一次码
    if (!String(accountId ?? "").trim()) {
      const slot = await accountSlotState(channel);
      if (slot.full) {
        return res.status(400).json({
          error: `${channel === "qqbot" ? "QQ" : "微信"}账号已存满（${slot.used}/${slot.max}）。请先到「通道连接」页彻底删除一个账号，再扫码添加新的。`,
          accountSlotFull: true,
          slot,
        });
      }
    }
    let bot: BotInstance;
    let evictedBots: BotInstance[] = [];
    try {
      const added = await addBot({ cardSlug: card.slug, channel, accountId: account, replace: replace === true });
      bot = added.bot;
      evictedBots = added.evicted;
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

    // ⓿ 被顶掉的旧实例（同卡替换 / 微信超额）：直写配置卸绑定 + 清会话（原来两条 CLI 要 5-15s）
    const evictedNames: string[] = [];
    for (const ev of evictedBots) {
      await unbindAccountDirect(ev.channel, ev.accountId).catch(() => null);
      await clearAgentSessions(ev.agentId).catch(() => 0);
      const evCard = await store.get(ev.cardSlug).catch(() => null);
      evictedNames.push(evCard?.name ?? ev.cardSlug);
      logInfo("通道", `已卸下旧卡 ${ev.cardSlug}（${ev.channel}:${ev.accountId}）`);
    }

    // ① 编译卡（agent 专属 workspace + 共享 workspace 兜底，见 compileForBot 注释）
    const compile = await compileForBot(card);

    // ② 解析模型：卡单独配置优先，否则默认提供商；第 3 个起强制官方中转站
    const forceOfficial = await mustUseOfficialProvider(card.slug);
    const llm = await resolveChatLLM(card, { forceOfficial });
    if (!llm) {
      await removeBot(bot.id);
      await fs.rm(agentWorkspaceDir(bot.cardSlug), { recursive: true, force: true }).catch(() => {});
      if (forceOfficial) {
        return res.status(400).json({
          error: `第 ${OFFICIAL_LOCK_FROM} 个及以后的机器人必须使用「${OFFICIAL_PROVIDER_NAME}」。请先到「API 与模型」页给它填好 Key 并启用（拉取一次模型），再来创建。`,
          officialRequired: true,
        });
      }
      return res.status(400).json({ error: "没有可用模型（先在 API 页配置模型提供商）" });
    }

    // ③ 创建隔离 agent 并绑定渠道路由（直写 openclaw.json，毫秒级；原来 agents add 要 5-15s）
    const upserted = await upsertAgentEntry({
      agentId: bot.agentId,
      workspace: agentWorkspaceDir(bot.cardSlug),
      model: `${llm.provider}/${llm.model}`,
    });
    if (!upserted) {
      await removeBot(bot.id);
      return res.status(500).json({ error: "写入 openclaw 配置失败（~/.openclaw/openclaw.json 不可读写）" });
    }
    const bound = await bindAccountDirect({ agentId: bot.agentId, channel: bot.channel, accountId: bot.accountId });
    if (!bound.ok) {
      await removeBot(bot.id);
      return res.status(500).json({ error: "写入绑定失败（~/.openclaw/openclaw.json 不可读写）" });
    }
    // 新绑定先清一次会话：这个 agent 可能残留上次绑定时的上下文，不清会带着旧对话回来
    await clearAgentSessions(bot.agentId).catch(() => 0);
    if (bound.previousAgentId && bound.previousAgentId !== bot.agentId) {
      await clearAgentSessions(bound.previousAgentId).catch(() => 0);
    }
    invalidateAgentsCache();
    invalidateChannelStatus();
    invalidateBindingsCache(); // agent 列表变了，缓存作废
    // 拟真节奏：用卡里的 chat.delay 配 OpenClaw 原生 humanDelay（分段回复之间自然停顿）
    await applyAgentHumanDelay(bot.agentId, card.chat?.delay).catch(() => {});
    const addOutput = `agent ${bot.agentId} 已就绪，绑定 ${bot.channel}:${bot.accountId}`;

    res.json({
      ok: true,
      bot,
      compileFiles: compile.files,
      model: `${llm.provider}/${llm.model}`,
      output: addOutput,
      hint: evictedNames.length
        ? `机器人已创建。微信只能绑 1 张卡，已自动卸下「${evictedNames.join("、")}」。`
        : "机器人已创建。下一步点「扫码绑定」登录账号。",
      evicted: evictedNames,
      agentExists: true, // 刚 add 成功，前端直接采信，不必再等 CLI 查一遍
    });
    // 绑定成功后自动发开场白（有互动过的私聊用户就发，没有就等下次触发）
    void pushGreetingForCard(card.slug).catch(() => {});
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
    // 设备只能绑自己名下的账号（别人的账号列表本来就看不见，这里再兜一层）
    if (!requireOwnedAccount(channel, acc, res)) return;
    // 校验账号已认证（凭证在 → 免扫码）
    const known = (await scanKnownAccounts()).find((a) => a.channel === channel && a.accountId === acc);
    if (!known) return res.status(400).json({ error: "该账号还没扫码认证过，无法免扫码绑定（先用扫码绑定创建）" });
    // 校验未被其他 bot 占用
    const others = (await listBots()).filter((b) => b.id !== bot.id);
    if (others.some((b) => b.channel === channel && b.accountId === acc)) {
      return res.status(409).json({ error: "该账号已被其他卡占用，可先删除或一键转移", conflict: true });
    }
    // 换绑：直写配置（解旧账号路由 → 绑新账号），毫秒级；原来两条 CLI 要 10-30s
    await unbindAccountDirect(bot.channel, bot.accountId).catch(() => null);
    const bound = await bindAccountDirect({ agentId: bot.agentId, channel, accountId: acc });
    if (!bound.ok) return res.status(500).json({ error: "写入绑定失败（~/.openclaw/openclaw.json 不可读写）" });
    // 换了账号 = 换了对话对象，清掉旧会话避免带着上一个账号的上下文
    const cleared = await clearAgentSessions(bot.agentId).catch(() => 0);
    if (bound.previousAgentId && bound.previousAgentId !== bot.agentId) {
      await clearAgentSessions(bound.previousAgentId).catch(() => 0);
    }
    // 更新实例记录
    const bots = await listBots();
    const idx = bots.findIndex((b) => b.id === bot.id);
    bots[idx] = { ...bots[idx], channel, accountId: acc };
    await fs.writeFile(path.join(dataDir(), "bots.json"), JSON.stringify({ bots }, null, 2), "utf8");
    invalidateAgentsCache();
    invalidateChannelStatus();
    invalidateBindingsCache();
    res.json({ ok: true, output: `已绑定 ${channel}:${acc}，清理会话 ${cleared} 个文件`, hint: "已换绑到已认证账号，已立即生效" });
    // 换绑成功后自动发开场白（新账号下互动过的私聊用户）
    void pushGreetingForCard(bot.cardSlug).catch(() => {});
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
      await unbindAccountDirect(targetExisting.channel, targetExisting.accountId).catch(() => null);
    }
    // ① 编译新卡
    const compile = await compileForBot(card);
    // ② 解析模型（换卡：位次跟着被转移的那个 bot，仍按第 3 个起强制官方）
    const forceOfficialTransfer = await mustUseOfficialProvider(oldBot.cardSlug);
    const llm = await resolveChatLLM(card, { forceOfficial: forceOfficialTransfer });
    if (!llm) {
      return res.status(400).json({
        error: forceOfficialTransfer
          ? `第 ${OFFICIAL_LOCK_FROM} 个及以后的机器人必须使用「${OFFICIAL_PROVIDER_NAME}」，请先在「API 与模型」页为它填 Key 并启用。`
          : "没有可用模型（先在 API 页配置模型提供商）",
        officialRequired: forceOfficialTransfer || undefined,
      });
    }
    // ③ 直写配置完成换卡（原来跑 3 条 openclaw CLI，每条冷启动 5-15s；直接改
    //    openclaw.json 的 agents.list + bindings 是毫秒级，网关会重读配置）
    //    agent 名一律走 deviceAgentId（设备作用下带前缀），不能用裸 slug——否则跨用户撞名
    const newAgentId = deviceAgentId(card.slug);
    const upserted = await upsertAgentEntry({
      agentId: newAgentId,
      workspace: agentWorkspaceDir(card.slug),
      model: `${llm.provider}/${llm.model}`,
    });
    if (!upserted) {
      return res.status(500).json({ error: "写入 openclaw 配置失败（~/.openclaw/openclaw.json 不可读写）" });
    }
    const bound = await bindAccountDirect({ agentId: newAgentId, channel: oldBot.channel, accountId: oldBot.accountId });
    if (!bound.ok) return res.status(500).json({ error: "写入绑定失败（~/.openclaw/openclaw.json 不可读写）" });
    // ④ 清掉旧 agent 的会话：不清的话同一用户继续发消息会沿用旧会话（连带旧人格上下文），
    //    表现就是"网页换卡成功但聊起来还是原来的卡"。这一步是换卡真正生效的关键。
    const clearedOld = await clearAgentSessions(oldBot.agentId).catch(() => 0);
    // 新卡也清一次：它可能残留上一次绑定时的会话，否则会带着上次的上下文回来
    const clearedNew = oldBot.agentId === newAgentId ? 0 : await clearAgentSessions(newAgentId).catch(() => 0);
    if (targetExisting && targetExisting.agentId !== newAgentId) {
      await clearAgentSessions(targetExisting.agentId).catch(() => 0);
    }
    invalidateAgentsCache();
    invalidateChannelStatus();
    invalidateBindingsCache();
    // ⑤ 更新记录：旧 bot 记录改为新卡（同一 id，账号不变）
    const bots = await listBots();
    const idx = bots.findIndex((b) => b.id === oldBot.id);
    if (idx >= 0) {
      bots[idx] = { ...bots[idx], cardSlug: card.slug, agentId: newAgentId };
    }
    // 目标卡原有 bot 记录移除（被顶掉）
    const cleaned = bots.filter((b) => b.id !== targetExisting?.id);
    await fs.writeFile(path.join(dataDir(), "bots.json"), JSON.stringify({ bots: cleaned }, null, 2), "utf8");
    res.json({
      ok: true,
      bot: cleaned[idx],
      compileFiles: compile.files,
      output: `绑定已切到 ${card.slug}${bound.previousAgentId ? `（顶掉 ${bound.previousAgentId}）` : ""}；清理会话 ${clearedOld + clearedNew} 个文件`,
      hint: `已将 ${oldBot.channel === "qqbot" ? "QQ" : "微信"} 账号 ${oldBot.accountId} 转移到「${card.name}」，已立即生效（下一条消息就是新卡）`,
    });
    // 换绑成功后自动发开场白（新卡对互动过的私聊用户）
    void pushGreetingForCard(card.slug).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/bots/:id/login", async (req, res) => {
  try {
    const bot = (await listBots()).find((b) => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: "机器人实例不存在" });
    // 设备扫自己的机器人：先把账号认在自己名下（bot 本来就在它自己的空间里），
    // 再记快照 —— 之后网关下发的真实 id（微信的 xxx-im-bot）也会算它的
    const dev = res.locals.ocDevice as string | null | undefined;
    if (dev) {
      setAccountOwner(bot.channel, bot.accountId, dev);
      await beginClaimForDevice(bot.channel, res);
    }
    // 这个 bot 的账号还不在已认证列表里 = 要占一个新槽位，满了就别扫（已认证账号重扫不受限）
    const known = await scanKnownAccounts();
    const isNewSlot = !known.some((a) => a.channel === bot.channel && a.accountId === bot.accountId);
    if (isNewSlot) {
      const slot = await accountSlotState(bot.channel);
      if (slot.full) {
        return res.status(400).json({
          error: `${bot.channel === "qqbot" ? "QQ" : "微信"}账号已存满（${slot.used}/${slot.max}）。请先到「通道连接」页彻底删除一个账号，再扫码。`,
          accountSlotFull: true,
          slot,
        });
      }
    }
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
    const forceOfficialRecompile = await mustUseOfficialProvider(card.slug);
    const llm = await resolveChatLLM(card, { forceOfficial: forceOfficialRecompile });
    if (llm) {
      const model = `${llm.provider}/${llm.model}`;
      const changed = await applyAgentModel(bot.agentId, model).catch(() => false);
      if (changed) modelNote = `，模型已切到 ${model}`;
    } else if (forceOfficialRecompile) {
      // 锁定官方但官方还没配好：保持原模型继续跑（不打断服务），但要如实告知
      modelNote = `（该机器人为第 ${OFFICIAL_LOCK_FROM} 个及以后，需使用「${OFFICIAL_PROVIDER_NAME}」；它还没填 Key/拉取模型，暂时沿用原模型）`;
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
    // 直写配置移除 agent 条目 + 路由，并清掉会话（原来 agents delete CLI 要 5-15s）
    await unbindAccountDirect(bot.channel, bot.accountId).catch(() => null);
    await removeAgentEntry(bot.agentId).catch(() => null);
    const cleared = await clearAgentSessions(bot.agentId).catch(() => 0);
    invalidateAgentsCache();
    invalidateChannelStatus();
    invalidateBindingsCache();
    res.json({
      ok: true,
      output: `已移除 agent ${bot.agentId} 与其绑定，清理会话 ${cleared} 个文件`,
      hint: "机器人已删除，已立即生效。",
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
    const sys = `你是角色卡创作助手。目标是做出一张「聊天就能立刻贴上人设」的卡，不是提纲卡。
好卡的核心是：大量情景判别 + 大量真实台词 + 解释她为什么会这样说话。性格不是单一的，要有转折、有多种说话方式、有缘由。

输出严格 JSON（不要 Markdown、不要多余文字）：
{
  "name": "角色名（用户没给就起一个贴切的）",
  "bio": "一句话简介（≤40 字，点出身份 + 最鲜明的性格反差）",
  "tags": ["标签"],
  "first_mes": "开场白（只一句话，见下方规则）",
  "voice": { "tone_rules": ["说话方式规则"], "catchphrases": ["口头禅"] },
  "personality": { "traits": ["性格特质"], "values": ["价值观"], "boundaries": ["雷区"] },
  "worldbook": [ 见下方三块内容，条目数量不限 ],
  "regex": [],
  ${coverPromptRule}
}

每个世界书条目对象键名固定为：{ "name": "条目名", "keys": [...], "content": "...", "constant": true/false }
条目名必须放在 "name" 键。keys 数组可空。

## 三块内容（最低字数，宁多勿少；条目数量不限）

你可以选择：把同一块写成一条上千字的长条目（爱语那种写法），也可以按关键词拆成多条（用 keys 区分不同场景/性格侧面）。怎么规划由你根据角色决定，只要三块都写满、不互相抄。

### 第一块：人物档案　合计不少于 1000 字　全部 constant=true
写清能让模型「认识这个人」的静态事实：姓名年龄性别身高体重生日职业身份居住地家庭；外貌（发瞳肤五官身材服饰配饰，以及和外表相关的习惯）；经历（发生了什么、在她身上留下了什么，要能解释现在的性格）；与 {{user}} 的关系纽带（怎么认识、现在什么关系、对 {{user}} 平时/亲密/生气分别怎么称呼、她记得 {{user}} 哪些事、她怕 {{user}} 做什么）。
【禁止写「重要 NPC」这类配角名单】这是一对一聊天软件里的对话，不是小说也不是群像剧，多余的配角只会让模型跑偏去演别人。要提别人只能顺带一句（例如"她提过室友爱抢她外卖"），不要单独立条目、不要列人物表。
这一块少写对话。对话放到第二块。

### 第二块：对话与性格　合计不少于 2000 字　这是整张卡的灵魂
这是聊天卡能不能立住的关键。必须把「性格特点 + 语言特色的缘由 + 情景转变 + 大量台词」写在一起。
必须包含：
- 她对 {{user}} 说话的总基调，以及为什么会这样说（经历/性格怎么造成这种语气）
- 性格不是单一的：至少写出几种说话方式，以及什么条件下从一种切到另一种（表面 vs 底色、温柔突然变脸、占有欲上来、示弱、吃醋等）
- 每种说话方式都要解释缘由（例如：因为怕被抛弃，所以先用刺把人推开）
- 大量情景判别：{{user}} 做什么时，她怎么接、怎么转折、下一句会变成什么样。情景数量不设上限，写到这个人说话的变化被覆盖住为止
- 每个情景都要有：触发条件 → 她为什么会这样反应 → 至少 2 句真实台词（刚触发时一句，持续/被安抚后一句）
- 对 {{user}} 的称呼变化、哪些话只对 {{user}} 说、关系升温/受伤后话术怎么变
整块台词要多。宁可多写情景和例句，不要写空洞总结。
如果拆条：keys 用场景或性格侧面（如 ["吃醋","冷落","示弱","被夸奖"]），每条写透那一个侧面；如果合写：可以一条写满两千字。

### 第三块：动作心理描写　合计不少于 1200 字　【必须生成】
keys 必须包含 "<重描写>"（可另加场景词）。constant=false。
这条只在用户选「重描写」风格时生效，纯对话风格下系统会自动跳过。

【最重要的前提：她和 {{user}} 是隔着手机在 QQ / 微信上聊天，不在同一个地方，彼此看不见对方。】
所以动作和心理必须**依托"打字发消息"这件事本身**来写，全部围绕：她握着手机时的身体反应、打字这个动作的变化、看到 {{user}} 消息时的反应、她所在环境里她自己能做的事。

✅ 正确（依托聊天）：
- 被骂时：眼睛发酸浮起泪花，手指颤抖着打字，删了三遍才发出去；心里想"他是不是真的讨厌我了"
- 等回复时：一直盯着屏幕不敢锁屏，看到"正在输入"又消失，指甲掐进掌心
- 高兴时：抱着手机在床上打滚，回得飞快还打错字，又赶紧撤回重发
- 吃醋时：盯着那条消息看了很久，故意等了十分钟才回，打了一长段又全删掉，只发一个"哦"
- 想靠近又怕被拒绝：打了"你想我吗"，盯着看了半天，最后删掉改成"睡了吗"

❌ 禁止（现实同处一室的描写，聊天里根本不成立）：
- "死死盯着我"、"凑到你耳边"、"抓住你的手腕"、"把你按在墙上"、"贴着你的胸口"
- 任何需要两人身体在同一空间才能发生的动作
- 例外：她在**用文字描述自己想对 {{user}} 做什么**（那属于台词内容，写在第二块），不是这一块的动作

按情绪/情景写细：高兴、生气、紧张、害羞、难过、吃醋、被冷落、示弱、心软、想靠近又怕被拒绝、深夜发消息……每种都要写：手机/打字的具体动作 + 她当时的身体反应 + 心里真实想法，以及「发出去的字」和「心里想的」怎么不一致。

【动作和心理要分清，分两栏写，别混在一起】
- 动作 = 这一瞬间能被摄像头拍到的身体行为（手指停在屏幕上、删了又重打、眼睛一下热了、抱着手机打滚、指甲掐进掌心）
- 心理 = 只在脑子里的念头（他是不是讨厌我了、这次真的过分了、不想让他知道我在等）
- 【禁止旁白】不要写时间跨度（"过了一会儿""沉默了很久""十分钟后"）、不要写语气说明（"语气慢悠悠""声音压低""冷冷地"）、不要写场面调度。聊天是瞬时的，语气要靠台词本身传达。
  允许的极短迟疑必须带情绪或动作，如"迟疑了一下还是点了发送"。
- 情绪不要直接命名，要落到身体上：不写"有点委屈"，写"眼睛一下就热了"；不写"很生气"，写"手指用力戳着屏幕"。
每个情景都按「动作：…… / 心理：……」两行写清楚，方便模型区分。
不要写括号、不要写排版格式（（）和 {} 由系统按风格自动加）。

（可选）「世界观」：仅异世界/末世/特定作品才加。现代日常不要加。

## 开场白（first_mes）
只有一句话。不许环境描写、不许动作、不许括号。事由全用说话带出来，结尾留话头。≤40 字。
✅ "哥哥你终于回消息了，我便当都热第三遍了，你到底还要不要吃？"
❌ "夕阳透过窗帘，她抬起头：你回来了。"

## 铁律
1. 聊天卡靠「情景 + 台词 + 缘由」立人，不靠提纲。写完自问：模型只看第二块，能不能连续演她说话而不塌成普通人。
2. 性格要有转折，不要从头到尾一种味道。
3. 禁止条目之间互相抄；同一句台词只出现一次。密度靠新信息，不靠重复。
4. 禁止在条目里写（）、{}、*星号*。动作心理只放第三块。
5. 禁止抒情散文/环境铺陈。要的是可执行信息：什么情境说什么、为什么、伴随什么动作心理。
6. 全程中文（cover_prompt 全英文除外）。regex 一般 []。
7. cover_prompt 全英文，角色在其世界场景中的竖版封面，不要证件照。`;

    const userMsg = `角色的想法：${ideaText}\n关系类型：${ROLE_ZH_MAP[r] ?? "朋友"}`;
    const ctrl = new AbortController();
    // 世界书约 4200 字（档案+对话+重描写），慢模型可能要几分钟
    const timer = setTimeout(() => ctrl.abort(), 300000);
    let llmRes: Response;
    try {
      llmRes = await fetch(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: "system", content: sys }, { role: "user", content: userMsg }],
          temperature: 0.85,
          // 三块合计约 4200 字，12000 tokens 容易截断成坏 JSON
          max_tokens: 16000,
        }),
        signal: ctrl.signal, // 必须在 fetch options 层；放进 body 会被当成请求字段，超时永不生效
      });
    } catch (e) {
      clearTimeout(timer);
      return res.status(500).json({ error: e instanceof Error && e.name === "AbortError" ? "模型响应超时（5 分钟），换个更快的模型或稍后再试" : toUserError(e, "调用模型失败") });
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
          .slice(0, 24)
          .map((wb) => {
            const constant = wb.constant === true;
            return {
              keys: Array.isArray(wb.keys) ? (wb.keys as unknown[]).map(String).slice(0, 8) : [],
              secondary_keys: [],
              content: String(wb.content ?? "").trim(),
              // 条目名：模型可能用 name/title/comment 任一键，全都兼容（缺了会导致条目显示成 undefined）
              name: String(wb.name ?? wb.title ?? wb.comment ?? "").trim() || undefined,
              comment: String(wb.name ?? wb.title ?? wb.comment ?? "").trim() || undefined,
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

// 查看某个提供商的完整 API Key（编辑页「眼睛」按钮；页面已有 Basic 认证保护）
app.get("/api/providers/reveal-key", async (req, res) => {
  try {
    const type = String(req.query.type ?? "");
    const name = String(req.query.name ?? "");
    if ((type !== "chat" && type !== "image") || !name) return res.status(400).json({ error: "缺少 type / name" });
    const { revealApiKey } = await import("./core/providers.js");
    res.json({ ok: true, apiKey: await revealApiKey(type, name) });
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
    const { fileContent, fileName, name, role, target, selfNames, blockedWords, model } = req.body ?? {};
    if (!fileContent || !name || !role) {
      return res.status(400).json({ error: "fileContent / name / role 不能为空" });
    }
    if (!RELATION_ROLES.includes(role)) {
      return res.status(400).json({ error: `无效角色: ${role}` });
    }
    // 允许指定模型（"提供商::模型"）；不传用默认提供商
    const chosenModel = typeof model === "string" && model.trim() ? model.trim() : "";
    const llm = chosenModel
      ? await resolveChatLLM({ model: { provider: chosenModel.split("::")[0], model: chosenModel.split("::")[1] ?? undefined } })
      : await resolveChatLLM();
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


// ---------- 聊天测试（人设 + 工具 + 记忆 + 思考深度 + ask 审批） ----------
async function chatCompletions(
  llm: { baseUrl: string; apiKey: string; model: string; provider?: string },
  messages: unknown[],
  tools?: unknown[],
  reasoning?: string,
  externalSignal?: AbortSignal, // 客户端断开/截断时中止模型请求（省 API）
  /** 记账用：调用来源（web/memory/distill…）与卡 slug，便于按场景看缓存命中率 */
  meta?: { kind?: string; slug?: string }
): Promise<{ choices?: { message?: { content?: string; tool_calls?: unknown[] } }[]; usage?: unknown }> {
  const doCall = async (effort?: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const onExternal = () => ctrl.abort();
    externalSignal?.addEventListener("abort", onExternal, { once: true });
    const t0 = Date.now();
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
      const data = await r.json();
      // 用量与缓存命中记账（DeepSeek 命中的输入按 1/50 计价，没有实测就无法判断优化是否生效）
      void logAndRecordUsage(data?.usage, llm, Date.now() - t0, meta);
      return data;
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

/**
 * 把一次模型调用的 usage 写进运行日志 + 落盘记账。
 * 日志一行看清四件事：输入多少、其中命中多少（省钱的部分）、输出多少、耗时。
 * 上游没报告缓存字段时明确写「上游未报告缓存」——那说明中转没透传，不能当成没命中。
 */
async function logAndRecordUsage(
  rawUsage: unknown,
  llm: { model: string; provider?: string },
  ms: number,
  meta?: { kind?: string; slug?: string }
): Promise<void> {
  if (!rawUsage) return;
  const u = parseUsage(rawUsage);
  const provider = llm.provider ?? "unknown";
  const kind = meta?.kind ?? "other";
  const hitPct = u.promptTokens > 0 ? Math.round((u.cacheHitTokens / u.promptTokens) * 100) : 0;
  const cacheText = u.cacheReported
    ? `缓存命中 ${u.cacheHitTokens}/${u.promptTokens}（${hitPct}%）· 未命中 ${u.cacheMissTokens}`
    : "上游未报告缓存字段（中转可能没透传）";
  logInfo(
    "用量",
    `${kind}${meta?.slug ? `·${meta.slug}` : ""} ${provider}/${llm.model} 输入 ${u.promptTokens} · 输出 ${u.completionTokens} · ${cacheText} · ${ms}ms`,
    JSON.stringify(rawUsage)
  );
  await recordLlmUsage({
    ts: new Date().toISOString(),
    provider,
    model: llm.model,
    kind,
    slug: meta?.slug,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    cacheHitTokens: u.cacheHitTokens,
    cacheMissTokens: u.cacheMissTokens,
    ms,
  });
}

interface ToolCallMsg {
  id?: string;
  function?: { name?: string; arguments?: string };
}

// 工具结果里提取图片 URL：三种形态 —— ① /img/... 本地历史图 ② /api/image/<id> 内存图
// ③ https 上游图链（NAI 直显）；模型可能不复述工具结果，服务端在返回回复时强制附加，前端 CHAT_IMG_RE 渲染成图
const TOOL_IMG_URL_RE =
  /(?:https?:\/\/[^\s"'<>()]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>()]*)?|\/api\/image\/[A-Za-z0-9_-]+|\/img\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|gif))/g;

/**
 * 剔除回复里「指向不存在文件」的 /img/ 地址（模型没调工具却编造图片地址时，
 * 前端渲染 <img> 会 404 显示 alt 文本，实锤现象「AI生成的图片」）。
 * 只针对 /img/（本地文件，可直接校验）；远程图链与内存图不做校验、一律保留。
 */
function stripFakeImgUrls(text: string): string {
  const urls = text.match(TOOL_IMG_URL_RE);
  if (!urls) return text;
  let bad = false;
  const imgRoot = path.join(dataDir(), "images");
  for (const u of urls) {
    if (!u.startsWith("/img/")) continue;
    // /img/<dir>/<file> → data/images/<dir>/<file>
    const rel = u.replace(/^\/img\//, "");
    if (rel && rel.split("/").length === 2) {
      const file = path.join(imgRoot, rel);
      try {
        if (!existsSync(file)) bad = true;
      } catch {
        bad = true;
      }
    }
  }
  if (!bad) return text;
  // 有不存在的 → 逐个剔除，顺带清理残留空行
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(TOOL_IMG_URL_RE);
      if (!m) return line;
      let out = line;
      for (const u of m) {
        if (!u.startsWith("/img/")) continue;
        const rel = u.replace(/^\/img\//, "");
        const file = path.join(imgRoot, rel);
        let ok = false;
        try {
          ok = existsSync(file);
        } catch {
          ok = false;
        }
        if (!ok) out = out.replace(u, "");
      }
      return out.trim();
    })
    .filter(Boolean)
    .join("\n");
}

interface ImageMeta {
  url: string;
  prompt: string;
}

async function executeToolCalls(
  tools: ToolDef[],
  toolCalls: ToolCallMsg[],
  messages: unknown[],
  ctx: ToolCtx
): Promise<{ imgs: string[]; imageMeta: ImageMeta[] }> {
  const imgs: string[] = [];
  const imageMeta: ImageMeta[] = [];
  for (const tc of toolCalls) {
    const def = tools.find((t) => t.id === tc.function?.name);
    let result = `未知工具: ${tc.function?.name ?? "?"}`;
    if (def) {
      try {
        result = await def.run(JSON.parse(tc.function?.arguments || "{}"), ctx);
        for (const m of result.matchAll(TOOL_IMG_URL_RE)) {
          if (!imgs.includes(m[0])) imgs.push(m[0]);
        }
        // 生图工具结果带「已生成图片：<url>\n提示词：<prompt>」——抓成元数据给前端；
        // 图链可能没有扩展名（如 sta1n 的 /api/images/xxx/content），所以这里必须**按前缀取 URL**，
        // 不能只靠扩展名正则（否则图不会追加进回复、前端也渲染不出来）
        const gen = result.match(/已生成图片：(\S+)\n提示词：([\s\S]*)/);
        if (gen && !imageMeta.some((x) => x.url === gen[1])) imageMeta.push({ url: gen[1], prompt: gen[2].trim() });
        if (gen && !imgs.includes(gen[1])) imgs.push(gen[1]);
      } catch (e) {
        logError("工具", `${tc.function?.name ?? "?"} 执行出错`, e);
        result = `工具执行出错: ${String(e)}`;
      }
    }
    messages.push({ role: "tool", tool_call_id: tc.id ?? "", content: result });
  }
  return { imgs, imageMeta };
}

type LoopResult =
  | { type: "reply"; reply: string; toolImages?: string[]; imageMeta?: ImageMeta[] }
  | { type: "pending"; pending: { id: string; name: string; args: string }[]; messages: unknown[] };

async function runToolLoop(
  llm: { baseUrl: string; apiKey: string; model: string; provider?: string },
  messages: unknown[],
  tools: ToolDef[],
  ctx: ToolCtx,
  askAll: boolean,
  reasoning?: string,
  externalSignal?: AbortSignal, // 客户端断开/截断时中止模型请求
  meta?: { kind?: string; slug?: string }
): Promise<LoopResult> {
  const toolImages: string[] = [];
  const imageMeta: ImageMeta[] = [];
  for (let i = 0; i < 4; i++) {
    if (externalSignal?.aborted) return { type: "reply", reply: "（已截断）" };
    const data = await chatCompletions(llm, messages, tools.length ? toolsToOpenAI(tools) : undefined, reasoning, externalSignal, meta);
    const msg = data.choices?.[0]?.message;
    const allCalls = ((msg?.tool_calls ?? []) as ToolCallMsg[]).filter((tc) => tc.function?.name);
    // 幻觉工具防护（2026-09-18）：模型调了没注册的工具（如已下线的 image_gen）→ 不进工具回合
    // （省一次模型调用），正文直接当回复；日志记一笔便于发现还在教模型调工具的文案残留
    const toolCalls = allCalls.filter((tc) => tools.some((t) => t.id === tc.function?.name));
    if (allCalls.length > 0 && toolCalls.length === 0) {
      logWarn("工具", `模型调用了未注册工具（${allCalls.map((t) => t.function?.name).join("、")}），已忽略并直接收尾`);
      return { type: "reply", reply: msg?.content ?? "（空回复）", toolImages, imageMeta };
    }
    if (toolCalls.length === 0) {
      return { type: "reply", reply: msg?.content ?? "（空回复）", toolImages, imageMeta };
    }
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
    const { imgs, imageMeta: metas } = await executeToolCalls(tools, toolCalls, messages, ctx);
    if (imgs.length) toolImages.push(...imgs);
    if (metas.length) imageMeta.push(...metas);
  }
  return { type: "reply", reply: "（达到工具轮次上限）", toolImages, imageMeta };
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
    // forceImage = 输入区「必须生成」按键（一次性）：只影响**这一轮**的注入（把生图判定段整段换成
    // 强制版 + CoT 换强制版），不写进任何会话记录、也不影响 QQ/微信侧（通道没有这个按键）。
    const { slug, message, history, tools, thinking, model, userKey, forceImage } = req.body ?? {};
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
    // 生图改指令式（2026-09-18，对齐通道与爱语）：image_gen 不再作为工具下发，模型在正文里写
    // <生图:提示词>，回复后由服务端解析并直接生成——一次模型调用完成，不再有工具双回合。
    const imageGenEnabled = toolDefs.some((t) => t.id === "image_gen");
    const loopToolDefs = toolDefs.filter((t) => t.id !== "image_gen");

    // 【上下文缓存优化（2026-09-11）】system prompt 必须是**逐字节稳定的前缀**。
    // 长期记忆改为全量注入（不再按当前消息检索），这样同一张卡的 system 在记忆没新增时
    // 完全不变；世界书只注入常驻条目（关键词触发条目后置到动态块，避免每轮集合变化）。
    // 记忆检索结果如果每轮按当前消息变，system 前缀就整段失效——实测基线每轮 170-380 token
    // 未命中就是这块在作祟。
    const allMems = (await readEntries(slug).catch(() => [])).slice().sort(
      (a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0)
    );
    // 事件时间锚点（evtFrom 才有 = 新版总结的记忆；括号日期是事情聊到/发生的时间，非总结时刻）
    const memLines = allMems.map((m) => {
      const imp = m.important ? "【关键】" : "";
      const evt = m.evtFrom ? evtRangeText(m) : "";
      const when = evt ? `（聊于 ${evt}）` : "";
      return `${imp}${m.fact}${when}`;
    });
    const memoryBlock = allMems.length
      ? `\n\n【长期记忆（关于你的事实，仅在相关时使用；【关键】为必须遵守的长期约定；要新增事实时调用 memory_save 工具）】\n- ${memLines
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
    // 用户身份：让 AI 知道"对面是谁"（设置里的昵称/简介，留空则不注入）
    const me = await readUserProfile();
    const userBlock =
      me.name || me.bio
        ? `\n\n【和你说话的人】${me.name ? `称呼：${me.name}。` : ""}${me.bio ? `\n${me.bio}` : ""}`
        : "";
    // 【上下文缓存优化（2026-09-11）】system prompt 必须是**逐字节稳定的前缀**，
    // 上游（DeepSeek 等）才会命中上下文缓存——命中的输入按 1/50 计价，省 ~98%。
    // 所以这里只放静态内容（人设/预设/常驻世界书/工具说明/表情清单），
    // 每轮都会变的东西（长期记忆检索结果、关键词触发的世界书条目）一律后置到
    // 聊天历史之后作为独立 system 消息注入——既不破坏前缀，又因为贴着生成点而更有效。
    // recentText 传空 = 只注入常驻（constant）世界书条目，保证 system 稳定。
    let system =
      (await buildChatSystemAsync(card, await resolveCardPresetBlocks(card, { forceImage: forceImage === true }), "")) +
      userBlock +
      (loopToolDefs.length
        ? `\n\n你可以使用以下工具完成任务：${loopToolDefs.map((t) => t.name).join("、")}。用户请求适合用工具完成时，调用工具而不是凭空编造；危险工具会先征得用户同意。`
        : "") +
      (imageGenEnabled
        ? "\n【生图强约束】如果角色设定/剧情让你拒绝用户的图片请求，可以直接拒绝（符合人设）；但只要你【同意】生成图片，就必须在回复正文里插入 <生图:提示词> 指令真实生成——绝不能只口头描述画面、编造图片地址或假装已生成（那样用户什么也收不到）。图片生成后系统会自动附带在回复末尾，你【不要】在回复正文里写图片地址/路径，也【不要】为生图调用任何工具。"
        : "") +
      rememberRule +
      // 记忆放 system 末尾（全量、稳定）：新增记忆时才变一次，其余轮次完全命中缓存
      memoryBlock;

    // 表情包注入：全局共享库（关闭档不注入）。清单是静态的，留在 system 里。
    system += await buildEmojiPrompt(card.voice?.message_style?.emoji ?? "克制", "inline", card.emojiGroups);

    // ---- 动态块（每轮可能变化，放在聊天历史之后，不进 system 前缀）----
    // 世界书关键词触发：只挑「非常驻且命中当前话题关键词」的条目（常驻的已在 system 里）
    const recentText = [
      ...(Array.isArray(history) ? history.slice(-6) : []).map((m) => String((m as { content?: string })?.content ?? "")),
      String(message),
    ].join("\n");
    const triggeredWb = selectTriggeredWorldbook(card, recentText);
    // 旧聊天原文召回：用户提到「第一次/之前/上次」等往事时，从会话日志按相似度召回
    // 带精确时间的旧消息片段（滑窗外的部分；稳定态无命中 = 空串，不影响缓存命中）
    const chatRecallBlock = await recallChatSnippets(slug, String(message ?? ""), {
      excludeTail: Array.isArray(history) ? Math.min(20, history.length) : 20,
    }).catch(() => "");

    // 配置变更强提醒：风格/条数/预设档位最近改过。
    // 【位置很关键】不能只放 system 顶部——那里离生成点最远，会被末尾 20 条旧风格聊天记录
    // 的近因效应压过去（实测：轻描写切重描写后模型仍按旧风格输出）。改为放在
    // 聊天记录之后、用户消息之前作为独立 system 消息注入，贴着生成点提醒。
    const cfgState = await readConfigState(card.slug).catch(() => ({}));
    const cfgReminder = buildConfigChangeReminder(cfgState);

    // 破甲示范对话（few-shot 锚定）：从所选档位预设的 <example> 块解析，注入在真实对话开头。
    // 对齐 RP-Hub 的「system 破限 + user/AI 消息注入」三重结构，弱模型靠模仿比靠指令更稳。
    const presetExamples = await resolveCardPresetExamples(card);

    // 开场白上下文：这是全新对话（前端无历史）且卡有 first_mes 时，把它作为已发出的
    // assistant 消息注入，模型才知道"已经开过场"，接得上话（配合前端 greeting API 显示气泡）。
    const isFreshChat = !Array.isArray(history) || history.length === 0;
    const firstMes = card.sillytavern_v2?.first_mes?.trim() ?? "";
    const openedWithGreeting = isFreshChat && firstMes ? firstMes : "";

    // 动态块：只放「必须贴近生成点才生效」的内容——配置变更强提醒（靠近因效应压过旧风格惯性）、
    // 关键词触发的世界书条目、旧聊天原文召回。记忆已全量进 system（稳定前缀），不在这里重复。
    // 稳定态下这里应为空 → 整轮请求前缀完全一致 → 缓存命中率最高（实测 93-96%）。
    const dynamicBlock = [triggeredWb, chatRecallBlock, cfgReminder].filter(Boolean).join("\n\n");
    if (dynamicBlock) {
      // 有动态内容才会破坏本轮缓存，记一行便于回溯（正常情况下不该频繁出现）
      logInfo("缓存", `动态块 ${dynamicBlock.length} 字符（世界书触发 ${triggeredWb ? "是" : "否"} / 聊天召回 ${chatRecallBlock ? "是" : "否"} / 配置提醒 ${cfgReminder ? "是" : "否"}）`);
    }

    const messages: unknown[] = [
      { role: "system", content: system },
      ...(presetExamples.length
        ? presetExamples.map((e) => ({ role: e.role, content: `（示范对话，仅作语气/尺度参考，不要复述）${e.content}` }))
        : []),
      ...(openedWithGreeting ? [{ role: "assistant", content: openedWithGreeting }] : []),
      ...(Array.isArray(history) ? history.slice(-20) : []),
      // 动态块贴着生成点：记忆/相关设定/配置提醒放这里，既不破坏前缀缓存，
      // 又靠近因效应压过旧聊天记录的惯性（配置变更提醒原本就必须放这个位置才生效）
      ...(dynamicBlock ? [{ role: "system", content: dynamicBlock }] : []),
      { role: "user", content: message },
    ];
    logInfo("聊天", `${card.name} 用 ${llm.provider}/${llm.model}` + (loopToolDefs.length ? ` · 工具 ${loopToolDefs.length} 个` : "") + (imageGenEnabled ? " · 生图走指令" : "") + (presetExamples.length ? " · 破甲示范注入" : ""));
    // 记录用户活跃（AI 生命调度用：重置该用户 missedBeats）
    void recordUserContact(card.slug, "local").catch(() => {});
    // 统一会话日志：网页聊天轮次也落盘（通道消息由观察器同步进来；本地聊天不发送到通道）
    const userEntry = await appendConv(slug, { role: "user", content: String(message ?? ""), surface: "web", ns }).catch(() => null);
    // 客户端断开（截断）→ 中止模型请求，省 API
    const chatCtrl = new AbortController();
    req.on("close", () => { if (!res.writableEnded) chatCtrl.abort(); });
    const chatCtxOpts = chatCtx(slug, ns);
    const result = await runToolLoop(llm, messages, loopToolDefs, chatCtxOpts, card.tools?.policy === "ask", reasoning, chatCtrl.signal, { kind: "web", slug });
    // 出站清理：剥离低级模型泄漏的纯文本思维链（「分析：」「（思考）」等前缀行）
    if (result.type === "reply" && typeof result.reply === "string") {
      const cleaned = sanitizeChatReply(card, result.reply);
      if (cleaned !== result.reply) {
        logWarn("清洗", `${card.name} 回复剥离了思维链残留`);
        result.reply = cleaned;
      }
    }
    // 生图指令落地（网页指令式，2026-09-18）：剥完 <cot> 后解析 <生图:提示词>，服务端直接调
    // image_gen 的 run() 生成（复用生图配置/内存图库/URL 形态），结果并入 toolImages/imageMeta，
    // 后续展示/落盘/拆条链路原样复用。全程一次模型调用，无工具回合。
    // 「必须生成」按下但模型没写指令时，兜底用用户这条消息当提示词——按键语义就是"这一轮必须出图"。
    if (result.type === "reply" && imageGenEnabled) {
      const m = String(result.reply ?? "").match(/<生图:([^<>]+)>|＜生图:([^＜＞]+)＞/);
      const prompt = (m ? (m[1] ?? m[2]) : "").trim() || (forceImage ? String(message ?? "").trim().slice(0, 400) : "");
      if (prompt) {
        if (m) result.reply = String(result.reply ?? "").replace(/<生图:[^<>]*>|＜生图:[^＜＞]*＞/, "").trim();
        const imgTool = TOOL_REGISTRY.find((t) => t.id === "image_gen");
        try {
          const out = imgTool ? await imgTool.run({ prompt }, chatCtxOpts) : "生图失败";
          const gen = out.match(/已生成图片：(\S+)\n提示词：([\s\S]*)/);
          if (gen) {
            result.toolImages ??= [];
            result.imageMeta ??= [];
            if (!result.toolImages.includes(gen[1])) result.toolImages.push(gen[1]);
            if (!result.imageMeta.some((x) => x.url === gen[1])) result.imageMeta.push({ url: gen[1], prompt: gen[2].trim() });
            logInfo("生图", `${card.name} 指令生图完成（单次模型调用，未走工具回合）`);
          } else {
            result.reply = `${String(result.reply ?? "").trim()}\n（生图失败）`.trim();
            logWarn("生图", `${card.name} 指令生图失败：${out.slice(0, 160)}`);
          }
        } catch (e) {
          result.reply = `${String(result.reply ?? "").trim()}\n（生图失败）`.trim();
          logWarn("生图", `${card.name} 指令生图异常`, e);
        }
      } else if (forceImage) {
        result.reply = `${String(result.reply ?? "").trim()}\n（生图失败）`.trim();
        logWarn("生图", `${card.name} 「必须生成」未落地：模型既没写指令、用户消息也没法当提示词`);
      }
    }
    let convIds: string[] = userEntry ? [userEntry.id] : [];
    if (result.type === "reply") {
      // 模型可能不复述工具结果里的图片 URL → 服务端强制附加（前端 CHAT_IMG_RE 渲染成图）；
      // 落盘/拆条用附加后的文本（刷新后图仍在），记忆总结用原始回复（避免路径噪音进记忆）
      const rawReply = String(result.reply ?? "");
      // 图片行归一化：模型复述的图链（带前缀或裸 URL）一律从正文剔掉，再由服务端统一以
      // 「已生成图片：<url>」追加一次——保证 URL 不会以文本形式出现在气泡里，且无扩展名的图链也能成图
      const allToolImages = result.toolImages ?? [];
      let replyText = rawReply;
      for (const u of allToolImages) {
        replyText = replyText.split(`已生成图片：${u}`).join("").split(u).join("");
      }
      const displayReply = stripFakeImgUrls(
        `${replyText.trim()}${allToolImages.length ? `\n\n${allToolImages.map((u) => `已生成图片：${u}`).join("\n")}` : ""}`
      );
      // 回复拆条（活人感分段）：按卡配置的条数区间 + 风格字数约束拆成多条。
      // 段落/句号/逗号四级拆法见 core/splitter.ts；表情包/图片由通道侧独立发送，这里只拆文本。
      const style: SplitStyle = card.presets?.style === "rich" ? "rich" : "chat";
      const splitCfg = card.chat?.split ?? { min: 1, max: 7 };
      // 空回复保护：模型偶尔只输出生图自检（<cot>…</cot>）没写正文，剥完就是空的 ——
      // 那样用户会收到"自己的消息 + 没有任何回复"，这里给一个无语义的停顿，别让轮次凭空消失。
      const splitRes = splitReply(displayReply.trim() || "……", { style, min: splitCfg.min, max: splitCfg.max });
      if (splitRes.count > 1) {
        logInfo("拆条", `${card.name} 回复拆成 ${describeSplit(splitRes)}`);
      }
      // 服务器侧只留「（图片：提示词）」，不留图链（用户图片在自己设备上，凭提示词可重现）
      const imgLine = /已生成图片：\S+/g;
      const meta = result.imageMeta ?? [];
      let imgIdx = 0;
      const storeReply = displayReply.replace(imgLine, () => {
        const p = meta[imgIdx++]?.prompt ?? "";
        return p ? `（图片：${p}）` : "（图片）";
      });
      const aEntry = await appendConv(slug, {
        role: "assistant",
        content: storeReply,
        surface: "web",
        ns,
        parts: splitRes.parts.map((p) => p.replace(imgLine, () => {
          const q = meta[imgIdx - 1]?.prompt ?? "";
          return q ? `（图片：${q}）` : "（图片）";
        })),
        images: meta,
      }).catch(() => null);
      if (aEntry) convIds.push(aEntry.id);
      // 滑动分批自动总结记忆（后台执行，不阻塞回复）
      void autoMemorize(slug, card, message, rawReply, ns).catch(() => {});
      // 本地聊天原文 → 通道侧刷新（防抖 6s）：history md 导出（100 轮可检索）+ USER.md 注入近 3 轮
      scheduleChannelMemoryRefresh(slug);
      res.json({ ...result, reply: displayReply, parts: splitRes.parts, convIds, images: result.imageMeta ?? [] });
      return;
    }
    // convIds：这轮对话在统一日志里的 id（网页端长按删除消息要用）
    res.json({ ...result, convIds });
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
  const rounds = card.memoryConfig?.auto_rounds ?? 5;
  if (!rounds || rounds < 1) return;
  // 每 N 轮总结一批（含最新轮，无保护门槛）；最近 20 轮原文仍由聊天历史窗口完整注入，不被记忆替代。
  // 总结失败的记忆巡回：失败段标记回日志（markChatRetry），下次总结搭车补记。
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
  if (!llm?.apiKey) {
    // 无可用模型时不能静默丢段：标回日志等下次搭车，否则聊天轮次会凭空消失、记忆永不总结
    logWarn("记忆", `${slug} 总结失败：卡无可用模型/API Key，${segment.length} 轮已标回待重试`);
    await markChatRetry(slug, segment, ns).catch(() => {});
    return;
  }
  // 总结字数上限随 N：1-10 轮 ≤100 字；11-20 轮 ≤200 字（批次越大允许越详实）
  const maxLen = rounds <= 10 ? 100 : 200;
  // 已记住的只带最近 100 条给 LLM，避免 token 随文件膨胀
  const existing = (await readAllMemories().then((m) => m[slug] ?? []).catch(() => []))
    .slice(-100)
    .map((e) => `- ${e.important ? "【关键】" : ""}${e.fact}`)
    .join("\n");
  const recent = segment
    .map((r) => {
      // 每轮带上它真实发生的日期：总结出的记忆才能锚定事件时间
      // （否则记忆只有"总结时刻"，攒批/巡回后事件时间就丢了）
      const day = r.t ? new Date(r.t) : null;
      const dayText = day && !isNaN(day.getTime()) ? `（${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日）` : "";
      return `${dayText}用户: ${r.u}\n角色: ${r.a}`;
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
              "你是记忆提炼器。把下面的对话提炼成【一条】简洁的长期记忆，抓住重点（用户的名字/住址/喜好/习惯/关系/重要决定/共同经历等）。要求：\n" +
              "1. 只输出一条总结性记忆（不是列表），口语化、简练，不超过 " +
              maxLen +
              " 字；\n" +
              "2. 若对话里用户表达了【长期、绝对的约定或强烈偏好】（出现「总是、以后都、永远、一直、记住、我绝对、我特别喜欢/讨厌、无论如何」等词），把 important 设为 true（关键记忆，必须长期遵守）；否则 false；\n" +
              "3. 提炼 2-5 个关键词放进 keywords（用于之后聊天出现这些词时召回这条记忆）。\n" +
              "4. 每轮对话前标注了日期。如果记忆内容与时间有关（什么时候说的/打算什么时候做/共同经历发生在何时），在记忆里自然地写上日期（如「9月3日提到周末想去露营」），方便以后回忆时间线。\n" +
              "5. 已记住的不要重复。没有值得记的内容就返回 {\"skip\": true}。\n" +
              "输出严格 JSON：{\"summary\":\"...\",\"important\":true/false,\"keywords\":[\"...\"]}，不要任何其他文字。",
          },
          { role: "user", content: `已记住的记忆：\n${existing || "（无）"}\n\n最近对话：\n${recent}` },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      // 记忆巡回：总结失败 → 该段标记回日志，下次总结搭车补记
      logWarn("记忆", `${slug} 总结失败：HTTP ${r.status}，${segment.length} 轮已标回`);
      await markChatRetry(slug, segment, ns).catch(() => {});
      return;
    }
    const data = await r.json();
    // 记忆总结也在花钱（每 N 轮一次），一并记账便于看整体成本构成
    void logAndRecordUsage(data?.usage, llm, 0, { kind: "memory", slug });
    const text = String(data.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      logWarn("记忆", `${slug} 总结失败：模型未返回 JSON（${text.slice(0, 60)}），${segment.length} 轮已标回`);
      await markChatRetry(slug, segment, ns).catch(() => {});
      return;
    }
    const o = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; important?: unknown; keywords?: unknown; skip?: unknown };
    if (o.skip === true) return; // 没有值得记的内容：正常消费，不巡回
    const fact = typeof o.summary === "string" ? o.summary.trim().slice(0, maxLen) : "";
    if (!fact) {
      logWarn("记忆", `${slug} 总结失败：模型返回空摘要，${segment.length} 轮已标回`);
      await markChatRetry(slug, segment, ns).catch(() => {});
      return;
    }
    const keywords = Array.isArray(o.keywords)
      ? o.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 5)
      : [];
    const important = o.important === true;
    // 记下这条记忆总结自哪几轮：用户删掉那些聊天记录时，这条记忆要一并删掉（不给被删内容留底）
    const roundKeys = segment.map((r) => roundKeyOf(r));
    // 事件时间 = 这段对话实际发生的区间（轮次各自带 t；与 ts=总结时刻区分开）
    const times = segment.map((r) => new Date(r.t).getTime()).filter((n) => !isNaN(n));
    const evtFrom = times.length ? new Date(Math.min(...times)).toISOString() : undefined;
    const evtTo = times.length ? new Date(Math.max(...times)).toISOString() : undefined;
    await appendEntry(slug, { fact, keywords, important, src: "auto", ns, roundKeys, evtFrom, evtTo }).catch(() => {});
    logInfo("记忆", `${slug} 自动总结 1 条${important ? "（关键）" : ""}：${fact.slice(0, 40)}`);
    void (async () => {
      await exportMemoryToMarkdown(slug).catch(() => {});
      await syncAgentUserMemory(slug).catch(() => {});
    })().catch(() => {});
  } catch (e) {
    // 记忆巡回：网络异常/解析异常 → 该段标记回日志，下次总结搭车补记
    logWarn("记忆", `${slug} 总结异常：${String((e as Error)?.message ?? e).slice(0, 80)}，${segment.length} 轮已标回`);
    await markChatRetry(slug, segment, ns).catch(() => {});
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
    // 生图已改指令式（2026-09-18）：审批续聊同样不下发 image_gen 工具
    //（pending 队列里升级前遗留的 image_gen 调用仍按原样执行，用的是完整 toolDefs）
    const loopToolDefs = toolDefs.filter((t) => t.id !== "image_gen");
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
    const result = await runToolLoop(llm, messages, loopToolDefs, chatCtx(slug, ns), card.tools?.policy === "ask", undefined, chatCtrl.signal, { kind: "approve", slug });
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

app.post("/api/presets/reset", async (req, res) => {
  try {
    // 设备侧只重置风格：内置档位组（默认）是运营者管的，用户点一下不能把它一起冲回代码默认
    res.json(await resetBuiltinPresets(res.locals.ocDevice ? "style" : undefined));
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

app.get("/api/groupchat/:slug", async (req, res) => {
  try {
    res.json({ groups: await listGroupsForCard(req.params.slug) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/groupchat/:slug/:gid", async (req, res) => {
  try {
    const detail = await getGroupDetail(req.params.slug, req.params.gid);
    if (!detail) return res.status(404).json({ error: "没有这个群聊记录" });
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/groupchat/:slug/:gid/delete", async (req, res) => {
  try {
    const ok = await deleteGroupChat(req.params.slug, req.params.gid);
    if (!ok) return res.status(404).json({ error: "没有这个群聊记录" });
    res.json({ ok: true, groups: await listGroupsForCard(req.params.slug) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/groupchat/:slug/:gid/member", async (req, res) => {
  try {
    const { memberId, name } = req.body ?? {};
    if (!memberId) return res.status(400).json({ error: "缺少成员 id" });
    const g = await renameGroupMember(req.params.slug, req.params.gid, String(memberId), String(name ?? ""));
    if (!g) return res.status(404).json({ error: "没有这个群聊记录" });
    res.json({ ok: true, group: await getGroupDetail(req.params.slug, req.params.gid) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

function internalOk(req: express.Request): boolean {
  const ip = String(req.ip || req.socket.remoteAddress || "");
  if (ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1")) return true;
  if (!UI_USER || !UI_PASS) return true;
  const auth = req.headers.authorization ?? "";
  const [type, token] = auth.split(" ");
  if (type === "Basic" && token) {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : "";
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    return user === UI_USER && pass === UI_PASS;
  }
  return false;
}

async function resolveGroupSlug(body: { slug?: unknown; accountId?: unknown; agentId?: unknown }): Promise<string> {
  const direct = String(body.slug ?? "").trim();
  if (direct) return direct;
  const agentId = String(body.agentId ?? "").trim();
  const accountId = String(body.accountId ?? "").trim();
  const bots = await listBots().catch(() => []);
  const hit = bots.find((b) => (agentId && b.agentId === agentId) || (accountId && b.accountId === accountId && b.channel === "qqbot"));
  return hit?.cardSlug ?? "";
}

app.post("/api/internal/groupchat/recall", async (req, res) => {
  try {
    if (!internalOk(req)) return res.status(401).json({ error: "需要登录" });
    const { gid, memberId, memberName, text, groupName } = req.body ?? {};
    const slug = await resolveGroupSlug(req.body ?? {});
    if (!slug || !gid || !memberId) return res.status(400).json({ error: "缺少参数" });
    await ensureGroup(slug, String(gid), groupName ? String(groupName) : undefined);
    const who = await memberLabel(slug, String(gid), String(memberId), memberName ? String(memberName) : undefined);
    const ctx = await recallGroupContext(slug, String(gid), String(memberId), String(text ?? ""));
    res.json({ ok: true, slug, memberName: who, context: ctx, inject: formatGroupInject(ctx, who, String(text ?? "")) });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/internal/groupchat/turn", async (req, res) => {
  try {
    if (!internalOk(req)) return res.status(401).json({ error: "需要登录" });
    const { gid, memberId, memberName, user, assistant, groupName } = req.body ?? {};
    const slug = await resolveGroupSlug(req.body ?? {});
    if (!slug || !gid || !memberId || !user || !assistant) return res.status(400).json({ error: "缺少参数" });
    const turn = await appendGroupTurn(slug, {
      gid: String(gid),
      groupName: groupName ? String(groupName) : undefined,
      memberId: String(memberId),
      memberName: memberName ? String(memberName) : undefined,
      user: String(user),
      assistant: String(assistant),
    });
    res.json({ ok: true, turn });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/internal/groupchat/join", async (req, res) => {
  try {
    if (!internalOk(req)) return res.status(401).json({ error: "需要登录" });
    const { gid, groupName } = req.body ?? {};
    const slug = await resolveGroupSlug(req.body ?? {});
    if (!slug || !gid) return res.status(400).json({ error: "缺少参数" });
    const g = await ensureGroup(slug, String(gid), groupName ? String(groupName) : undefined);
    logInfo("群聊", `${slug} 加入群 ${g.name} (${g.gid})`);
    res.json({ ok: true, group: g });
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

/**
 * 绑定的目标用户：优先上次用过的 openid（用户说了机器人只跟一个人聊，不弹选择），
 * 否则取该 agent 会话索引里最近互动的用户。
 * 不依赖 QQ known-users.json（openid 大写与会话 key 小写不一致）和微信 accounts.json
 * （里面是账号 id 不是用户）——会话索引的 origin.from/label 是权威来源。
 */
async function mirrorTargetOf(bot: BotInstance): Promise<{ openid: string; session: SessionInfo | null } | null> {
  const state = await readMirrorState(bot.cardSlug);
  if (state.openid) {
    // 校验旧 openid 是否仍对应当前会话（换绑/换渠道后旧值会失配——曾出现 QQ 时代的
    // openid 残留导致微信消息一直同步不到网页）
    const stillValid = await findSession(bot.agentId, bot.accountId, state.openid).catch(() => null);
    // 顺手把查到的会话带出去：pollSessionTurns 就不用再读一遍 sessions.json（扫描器每 5 秒轮一遍）
    if (stillValid) return { openid: state.openid, session: stillValid };
    await writeMirrorState(bot.cardSlug, { sessionId: "", lastSyncAt: "" }).catch(() => {});
  }
  const users = await listAgentSessionUsers(bot.agentId, bot.accountId);
  if (!users.length) return null;
  users.sort((a, b) => b.updatedAt - a.updatedAt);
  return { openid: users[0].openid, session: null };
}

/** 观察一张卡的通道会话：增量同步进统一日志 + 喂自动记忆。
 *  返回本轮真正写进日志的条目（App 打开时的增量拉取直接用它们回填本地副本）。
 *
 *  两条纪律（都是「App 没开就不复刻」踩出来的）：
 *  ① **游标在写盘之后才推进**（commitObserveCursor）——中途失败只会下一轮重读，
 *     重读的按来源消息 id 去重丢掉，绝不静默漏；
 *  ② 同一张卡同时只跑一次（服务端定时扫描与网页轮询会撞车，撞车就有重复导入风险）。 */
async function observeCard(slug: string): Promise<{ added: number; entries: ConvEntry[] }> {
  const bot = await getBotByCard(slug);
  if (!bot) return { added: 0, entries: [] };
  const target = await mirrorTargetOf(bot);
  if (!target) return { added: 0, entries: [] };
  const ns = `${nsOfChannel(bot.channel)}:${target.openid}`;
  const { sessionId, turns, sessionIds } = await pollSessionTurns(slug, bot, target.openid, target.session);
  if (!turns.length) return { added: 0, entries: [] };
  // 按来源消息 id 去重：游标重置（会话文件重建/截断）会把整段会话当新消息返回，
  // 不去重的话同一批消息会被反复追加进日志（网页端出现重复气泡）
  const seen = await readConvSrcIds(slug);
  const fresh = turns.filter((t) => !t.id || !seen.has(t.id));
  const written: ConvEntry[] = [];
  for (const t of fresh) {
    // 通道回合在 OpenClaw 会话里被合并成一条 assistant 消息（含换行）——网页端按换行拆回多条气泡，
    // 还原通道端逐条发送的消息边界；【表情:名】全角标签统一转半角（网页端只认 [表情:名]）
    const raw = String(t.content ?? "");
    const normed = raw.replace(/【表情:([^】]+)】/g, "[表情:$1]");
    // 机器输出（API 报错/JSON/堆栈）不按换行拆气泡：与拆条引擎同口径（isMachineOutput），
    // 否则一条多行报错会被拆成一串气泡
    if (t.role === "assistant" && normed.includes("\n") && !isMachineOutput(normed)) {
      const parts = normed.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        const e = await appendConv(slug, { role: "assistant", content: p, surface: surfaceOfChannel(bot.channel), ns, srcId: t.id || undefined }).catch(() => null);
        if (e) written.push(e);
      }
    } else {
      const e = await appendConv(slug, { role: t.role, content: normed, surface: surfaceOfChannel(bot.channel), ns, srcId: t.id || undefined }).catch(() => null);
      if (e) written.push(e);
    }
  }
  // 写盘成功才推进水位（写失败就不推进，下一轮重来；重来的会被上面的 srcId 去重挡掉）
  await commitObserveCursor(slug, fresh, sessionIds).catch(() => {});
  if (!fresh.length) return { added: 0, entries: [] };
  // 配对 user/assistant 喂自动记忆（assistant 与前一条 user 组成一轮；单条不配对等下一批）
  const card = await store.get(slug).catch(() => null);
  let pendingUser = "";
  for (const t of fresh) {
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
  // 通道有新消息 → 刷新 USER.md（当前配置/变更提醒/记忆随每轮注入，及时反映最新设置）
  void syncAgentUserMemory(slug).catch(() => {});
  return { added: fresh.length, entries: written };
}

/** 同卡去重锁：扫描器与网页轮询可能同时观察到同一张卡。
 *  锁键带设备前缀——不同设备命名空间里可以有同名卡，不能互相挡住。 */
const observeInflight = new Map<string, Promise<{ added: number; entries: ConvEntry[] }>>();
function observeCardLocked(slug: string): Promise<{ added: number; entries: ConvEntry[] }> {
  const key = `${devicePrefix()}${slug}`;
  const running = observeInflight.get(key);
  if (running) return running;
  const p = observeCard(slug).finally(() => observeInflight.delete(key));
  observeInflight.set(key, p);
  return p;
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

/**
 * 通讯录（会话列表）：只列出**真的聊过**的卡——像微信一样，没聊过的人不出现在聊天列表里。
 * 每条给出微信式长条需要的字段：头像、名字、最后一句预览、时间、置顶。
 * 排序：置顶优先（按置顶时间倒序），其余按最后一条消息时间倒序。
 */
app.get("/api/conversations", async (_req, res) => {
  try {
    const [metas, state] = await Promise.all([store.list(), readChatListState()]);
    const items: {
      slug: string;
      name: string;
      avatar?: string;
      role: string;
      last: string;
      lastRole: "user" | "assistant" | "";
      lastAt: string;
      count: number;
      pinned: boolean;
      pinnedAt: string;
    }[] = [];
    for (const m of metas) {
      const entries = await readConv(m.slug).catch(() => []);
      if (!entries.length) continue; // 没有聊天记录的卡不进通讯录（用户明确要求）
      const last = entries[entries.length - 1];
      items.push({
        slug: m.slug,
        name: m.name,
        avatar: m.avatar,
        role: m.role,
        // 预览去掉换行与表情标签、剥掉 MEDIA: 路径行（通道历史污染），只留一行文字
        last: String(last?.content ?? "")
          .split(/\r?\n/)
          .filter((ln) => !/^\s*MEDIA:\s*/i.test(ln))
          .join(" ")
          .replace(/\[表情:([^\]]+)\]/g, "[$1]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60),
        lastRole: last?.role === "assistant" ? "assistant" : last?.role === "user" ? "user" : "",
        lastAt: last?.t ?? "",
        count: entries.length,
        pinned: !!state.pinned[m.slug],
        pinnedAt: state.pinned[m.slug] ?? "",
      });
    }
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return b.pinnedAt.localeCompare(a.pinnedAt);
      return String(b.lastAt).localeCompare(String(a.lastAt));
    });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/** 置顶 / 取消置顶某个会话（通讯录与单卡设置页共用） */
app.post("/api/cards/:slug/pin", async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!isValidSlug(slug)) return res.status(400).json({ error: "slug 不合法" });
    const pinned = req.body?.pinned !== false;
    await setPinned(slug, pinned);
    res.json({ ok: true, pinned });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/**
 * 聊天记录查找：在某张卡的会话日志里按关键词搜。
 * 返回命中条目 + 它在整份记录里的位置（前端可据此跳转定位）。
 */
app.get("/api/cards/:slug/conversation/search", async (req, res) => {
  try {
    const slug = req.params.slug;
    const q = String(req.query.q ?? "").trim();
    const wantImage = req.query.image === "1"; // 只看带图/表情的消息
    const date = String(req.query.date ?? "").trim(); // YYYY-MM-DD，只看某一天
    if (!q && !wantImage && !date) return res.json({ hits: [], total: 0 });
    const bot = await getBotByCard(slug);
    const all = await readConv(slug);
    const entries = bot ? all : all.filter((e) => e.surface === "web");
    const needle = q.toLowerCase();
    const hasMedia = (c: string) =>
      c.includes("[表情:") || c.includes("/emojis/") || c.includes("/img/") || /MEDIA:/i.test(c);
    const hits = entries
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => (q ? e.content.toLowerCase().includes(needle) : true))
      .filter(({ e }) => (wantImage ? hasMedia(e.content) : true))
      .filter(({ e }) => (date ? String(e.t ?? "").slice(0, 10) === date : true))
      .slice(-200) // 命中太多时只回最近 200 条，避免公网传输过大
      .map(({ e, idx }) => ({
        id: e.id,
        role: e.role,
        content: e.content.slice(0, 300),
        t: e.t,
        surface: e.surface,
        index: idx,
      }));
    res.json({ hits: hits.reverse(), total: hits.length }); // 最近的排前面
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 删除指定消息（网页长按多选删除用），并做记忆修复：
// ① 对话日志里同内容的未总结轮次一并移除（不再被总结）；
// ② 删掉的轮数 ≥ N/2（或一次删掉大量已总结消息）→ 最新一条记忆按「解散」处理，由后续总结自然重算
/**
 * 把被删掉的消息按「user + 紧随的 assistant」配对成轮次，用于和记忆里的 roundKeys 对齐。
 * 对话日志一轮 = {u, a}，所以这里要还原成同样的形状才能算出一致的指纹。
 */
function pairRounds(msgs: { role: string; content: string }[]): { u: string; a: string }[] {
  const sorted = [...msgs]; // 传入顺序已是会话顺序（deleteConvByIds 按原文件序返回）
  const out: { u: string; a: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].role !== "user") continue;
    const next = sorted[i + 1];
    if (next && next.role === "assistant") {
      out.push({ u: String(sorted[i].content ?? ""), a: String(next.content ?? "") });
      i++; // 这条 assistant 已配对
    } else {
      out.push({ u: String(sorted[i].content ?? ""), a: "" });
    }
  }
  return out;
}

app.post("/api/cards/:slug/conversation/delete", async (req, res) => {
  try {
    const slug = req.params.slug;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: "ids 不能为空" });
    const removed = await deleteConvByIds(slug, ids);
    if (!removed.length) return res.json({ ok: true, removed: 0, rounds: 0, dissolved: false });
    // 前端多选删除是「从最早选中项删到底」，所以可以安全地把通道会话链也从尾部截掉同样的轮数
    // （通道链只能尾部截断，中间删会断链——这也是前端强制连带删除后续消息的原因）
    let channelTrimmed = 0;
    let channelNote = "";
    if (req.body?.trimChannel) {
      const bot = await getBotByCard(slug);
      if (bot) {
        const wantRounds = removed.filter((e) => e.role === "assistant").length || 1;
        const n = await trimAgentSessionTail(bot.agentId, wantRounds).catch(() => 0);
        if (n < 0) channelNote = "通道上下文结构异常，未改动（可用「清空此卡记忆」重开会话）";
        else channelTrimmed = n;
      }
    }
    const rounds = await repairChatlogAfterDelete(slug, removed);
    // 记忆不给被删内容留底：凡「总结自被删轮次」的记忆一并删掉，之后按剩余原文重新总结。
    // 被删消息按 user/assistant 配对成轮次，与记忆里的 roundKeys 对齐。
    const delRounds = pairRounds(removed);
    const memGone = delRounds.length ? await deleteMemoriesByRounds(slug, delRounds).catch(() => 0) : 0;
    const card = await store.get(slug).catch(() => null);
    const N = Math.max(1, Math.min(20, card?.memoryConfig?.auto_rounds ?? 5));
    let dissolved = false;
    // 老记忆没有 roundKeys（无法溯源）→ 沿用原有兜底：删得多就把最新一条解散重算
    if (!memGone && (rounds >= Math.max(1, Math.floor(N / 2)) || removed.length >= Math.max(2, N))) {
      const m = await dissolveNewestMemory(slug);
      dissolved = !!m;
    }
    if (memGone || dissolved) {
      void exportMemoryToMarkdown(slug).catch(() => {});
      void syncAgentUserMemory(slug).catch(() => {});
    }
    // removedIds 同 undo：前端据此局部移除气泡，不整页重载
    res.json({
      ok: true,
      removed: removed.length,
      removedIds: removed.map((e) => e.id),
      rounds,
      dissolved,
      memGone,
      channelTrimmed,
      channelNote,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

/**
 * 撤掉最近若干轮对话（网页记录 + 通道上下文一起摘）。
 * 用途：破甲被模型拒绝时，把那轮从上下文里彻底摘掉，避免「上次拒绝过」持续污染后续回复。
 * 通道侧只从会话链尾部截断（中间不能删，会断链），所以只支持「最新 N 轮」。
 */
app.post("/api/cards/:slug/conversation/undo", async (req, res) => {
  try {
    const slug = req.params.slug;
    const rounds = Math.max(1, Math.min(20, Number(req.body?.rounds) || 1));
    // ① 网页记录：从尾部取出对应的消息（一轮 = 最后一条 assistant + 它前面的 user）
    const all = await readConv(slug, 0);
    const ids: string[] = [];
    let got = 0;
    for (let i = all.length - 1; i >= 0 && got < rounds; i--) {
      ids.push(all[i].id);
      // 遇到 user 且已经收过 assistant，算凑满一轮
      if (all[i].role === "user") got++;
    }
    const removed = ids.length ? await deleteConvByIds(slug, ids) : [];
    // ② 通道上下文：从 agent 会话链尾部截断同样的轮数
    const bot = await getBotByCard(slug);
    let channelTrimmed = 0;
    let channelNote = "";
    if (bot) {
      const n = await trimAgentSessionTail(bot.agentId, rounds).catch(() => 0);
      if (n < 0) {
        // 结构异常（有分叉）→ 不硬删，提示用户可以整会话清空
        channelNote = "通道上下文结构异常，未改动（可用「清空此卡记忆」重开会话）";
      } else {
        channelTrimmed = n;
      }
    }
    // ③ 记忆同步：总结自被撤轮次的记忆一并删除（不给被删内容留底）
    let dissolved = false;
    let memGone = 0;
    if (removed.length) {
      const r = await repairChatlogAfterDelete(slug, removed);
      const delRounds = pairRounds(removed);
      memGone = delRounds.length ? await deleteMemoriesByRounds(slug, delRounds).catch(() => 0) : 0;
      const card = await store.get(slug).catch(() => null);
      const N = Math.max(1, Math.min(20, card?.memoryConfig?.auto_rounds ?? 5));
      // 老记忆无 roundKeys 时的兜底（同多选删除口径）
      if (!memGone && (r >= Math.max(1, Math.floor(N / 2)) || removed.length >= Math.max(2, N))) {
        const m = await dissolveNewestMemory(slug);
        dissolved = !!m;
      }
      if (memGone || dissolved) {
        void exportMemoryToMarkdown(slug).catch(() => {});
        void syncAgentUserMemory(slug).catch(() => {});
      }
    }
    // removedIds：前端据此只摘掉这几个气泡（不再整页重载历史，避免"消息全消失又出现"的闪动）
    res.json({
      ok: true,
      removed: removed.length,
      removedIds: removed.map((e) => e.id),
      rounds: got,
      channelTrimmed,
      channelNote,
      dissolved,
      memGone,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- App 打开时的增量拉取：把服务器的记录灌进 App 本地（永久副本） ----------
// 场景：用户在 QQ/微信里跟机器人聊天，App 根本没开。服务器那头 sweepMirrors 一直在补观察，
// 记录已经攒在服务端；App 一打开就来这里拉「游标之后的所有新消息」（**所有卡**，不只当前
// 打开的那张），写进浏览器 IndexedDB。服务器只留 RETENTION_DAYS 天，用户自己的完整聊天
// 历史留在用户自己设备上 —— 与「本地真源 + 服务器短保留」同一思路。
const PULL_PAGE = 800; // 单次最多返回多少条（历史很长时前端按 more 连着拉，避免一次几 MB）
app.post("/api/sync/pull", async (req, res) => {
  try {
    const since = String(req.body?.since ?? "");
    const sinceTs = since ? Date.parse(since) || 0 : 0;
    // ① 先补观察：把 App 关着期间通道里发生的对话从 OpenClaw 会话补进日志
    //    （不依赖用户是否停在某张卡上——这正是「App 没开就不复刻」的修法）
    for (const bot of await listBots().catch(() => [])) {
      if (!bot.channel) continue;
      await observeCardLocked(bot.cardSlug).catch(() => {});
    }
    // ② 汇总所有卡（不只绑了通道的）里游标之后的条目，按时间升序分页返回。
    //    按 conversations/*.jsonl 枚举而不是按卡片列表：卡被删/改名时日志还在，
    //    按卡枚举会静默漏掉那部分记录（自测里就是「卡不存在 → 一条都拉不到」）。
    const entries: (ConvEntry & { slug: string })[] = [];
    const convDir = path.join(dataDir(), "conversations");
    for (const f of await fs.readdir(convDir).catch(() => [] as string[])) {
      if (!f.endsWith(".jsonl")) continue;
      const slug = f.slice(0, -".jsonl".length);
      for (const e of await readConv(slug).catch(() => [])) {
        if (sinceTs && (Date.parse(e.t) || 0) < sinceTs) continue;
        entries.push({ ...e, slug });
      }
    }
    entries.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const page = entries.slice(0, PULL_PAGE);
    res.json({
      entries: page,
      cursor: page.length ? String(page[page.length - 1].t) : since,
      count: page.length,
      more: entries.length > page.length,
      retentionDays: RETENTION_DAYS,
      // 保留期起点：本地副本靠它区分「这条服务器已按策略清掉」（保留展示）与
      // 「这条还在窗口内却不在服务器上 = 被删过」（不复活），见前端 ocMergeConvEntries
      horizon: new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString(),
    });
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
    const r = await observeCardLocked(req.params.slug);
    res.json({ ok: true, added: r.added, entries: r.entries });
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

// 从其他分组导入表情（路径复用：新条目指向原文件，不复制图片）
app.post("/api/emojis/import", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const group = String(req.body?.group ?? "");
    if (!ids.length) return res.status(400).json({ error: "ids 不能为空" });
    if (!group) return res.status(400).json({ error: "group 不能为空" });
    res.json(await importEmojisToGroup(ids, group));
  } catch (e) {
    res.status(400).json({ error: toUserError(e) });
  }
});

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
/**
 * 表情包 zip 批量导入。
 * zip 结构见 src/core/emojiPack.ts（配 `scripts/make-emoji-pack.bat` 生成的包最省事）。
 * 先 `?dryRun=1` 出一份预览（不落库），前端确认后再正式导入 —— 免得一次吞 100 张才发现名字全错。
 * 重名自动加序号（大笑 → 大笑2），绝不静默丢图；库满 300 就停下并报告还剩多少没进。
 */
app.post(
  "/api/emojis/import-zip",
  express.raw({
    type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    limit: "60mb",
  }),
  async (req, res) => {
    try {
      const buf = req.body as Buffer;
      if (!buf || !buf.length) return res.status(400).json({ error: "没有收到文件" });
      const dryRun = req.query?.dryRun === "1";
      const parsed = parseEmojiPack(buf);

      const existing = await listEmojis();
      const groups = await listGroups();
      const groupByName = new Map(groups.map((g) => [g.name, g]));
      const takenNames = new Set(existing.map((e) => e.name));
      let room = Math.max(0, MAX_EMOJIS - existing.length);

      const plan: { name: string; scene: string; groupId: string; groupName: string; ext: string; data: Buffer; renamedFrom?: string }[] = [];
      const problems = [...parsed.problems];
      const groupsToCreate = new Set<string>();

      for (const it of parsed.items) {
        if (room <= 0) {
          problems.push({ what: it.path, reason: `表情库已满（上限 ${MAX_EMOJIS}），这个和后面的一律没导入` });
          continue;
        }
        // 重名自动加序号：库里的、以及本次已排进去的都要避让
        let name = it.name;
        if (takenNames.has(name)) {
          const from = name;
          let k = 2;
          while (takenNames.has(`${name}${k}`)) k++;
          name = `${name}${k}`.slice(0, 40);
          problems.push({ what: it.path, reason: `名字「${from}」库里已有，改叫「${name}」` });
        }
        takenNames.add(name);
        // 分组：zip 里的子文件夹名 → 分组（没有就记下来待建）
        const gName = it.group || "默认";
        let g = groupByName.get(gName);
        if (!g) {
          groupsToCreate.add(gName);
          g = { id: `pending:${gName}`, name: gName, builtin: false };
          groupByName.set(gName, g);
        }
        plan.push({ name, scene: it.scene, groupId: g.id, groupName: gName, ext: it.ext, data: it.data, renamedFrom: name !== it.name ? it.name : undefined });
        room--;
      }

      const summary = {
        ok: true,
        dryRun,
        count: plan.length,
        items: plan.map((p) => ({ name: p.name, scene: p.scene, group: p.groupName, renamedFrom: p.renamedFrom })),
        groupsToCreate: [...groupsToCreate],
        problems: problems.slice(0, 30),
        problemCount: problems.length,
        notes: parsed.notes,
        remaining: room,
      };
      if (dryRun) return res.json(summary);

      // 真正写库：先建分组，再逐个加（跳过逐个的全量同步，最后统一同步一次）
      const createdGroups: string[] = [];
      const groupIdByPending = new Map<string, string>();
      for (const gName of groupsToCreate) {
        const g = await addGroup(gName);
        groupIdByPending.set(`pending:${gName}`, g.id);
        createdGroups.push(gName);
      }
      const added: { name: string; group: string }[] = [];
      for (const p of plan) {
        const groupId = groupIdByPending.get(p.groupId) ?? p.groupId;
        try {
          const item = await addEmoji({
            name: p.name,
            explanation: p.scene,
            imageBase64: p.data.toString("base64"),
            ext: p.ext,
            group: groupId,
            skipChannelSync: true,
          });
          added.push({ name: item.name, group: p.groupName });
        } catch (e) {
          problems.push({ what: p.name, reason: toUserError(e) });
        }
      }
      // 一次性同步到通道表情目录（QQ/微信发图用的那份）
      void syncEmojisToChannelMedia().catch(() => {});
      logInfo("表情", `导入 zip：成功 ${added.length} 个，跳过 ${problems.length} 项` + (createdGroups.length ? `，新建分组 ${createdGroups.join("/")}` : ""));
      res.json({
        ...summary,
        added,
        skipped: plan.length - added.length,
        groupsCreated: createdGroups,
        problems: problems.slice(0, 30),
        problemCount: problems.length,
      });
    } catch (e) {
      res.status(400).json({ error: toUserError(e) });
    }
  }
);

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
      aspect: cfg.aspect,
      compression: cfg.compression,
      // NovelAI 走固定网关：站点地址由后端下发（前端只展示、不可改），用户只填 key + 选模型
      novelai: { key: maskKey(cfg.novelai.key), model: cfg.novelai.model, base: NAI_GATEWAY_BASE },
      openai: { baseUrl: cfg.openai.baseUrl, key: maskKey(cfg.openai.key), model: cfg.openai.model },
      artists: cfg.artists,
      activeArtist: cfg.activeArtist,
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 查看生图密钥原文（前端点「眼睛」时调；与文本 API 的 reveal-key 同一做法）
app.get("/api/image/reveal-key", async (_req, res) => {
  try {
    const cfg = await getImageConfig();
    res.json({ key: cfg.novelai.key ?? "" });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/image/config", async (req, res) => {
  try {
    const { provider, novelai, openai, artists, activeArtist, compression, aspect } = req.body ?? {};
    const cur = await getImageConfig();
    // ① 密钥守卫：只认本站签发的密钥，上游/官方密钥（STA1N-…/pst-…）一律拒绝，
    //    避免有人填上游密钥绕过我们自己的站点
    const incomingKey = String(novelai?.key ?? "").trim();
    if (incomingKey) {
      const bad = rejectForeignKey(incomingKey);
      if (bad) return res.status(400).json({ error: bad });
      // ② 模型守卫：模型必须来自本站 /v1/models（挡住手填上游模型名）
      const mv = await validateGatewayModel(incomingKey, String(novelai?.model ?? ""));
      if (!mv.ok) return res.status(400).json({ error: mv.info });
    } else if (String(novelai?.model ?? "").trim() && cur.novelai.key) {
      // 没改密钥但要改模型：用已保存的密钥校验
      const mv = await validateGatewayModel(cur.novelai.key, String(novelai.model));
      if (!mv.ok) return res.status(400).json({ error: mv.info });
    }
    // 画师串列表：name/content 去空白过滤；内置默认串（2.5D写实/超写实二次元）不可改不可删——
    // 前端传来的列表里剥掉内置同名条目，落盘的永远只是用户自建串（读回时 getImageConfig 会合并内置）
    const incomingArtists = Array.isArray(artists)
      ? (artists as { name?: string; content?: string }[])
          .map((a) => ({ name: String(a?.name ?? "").trim(), content: String(a?.content ?? "").trim() }))
          .filter((a) => a.name && a.content && !isBuiltinArtist(a.name))
      : cur.artists.filter((a) => !a.builtin);
    const nextArtists = incomingArtists;
    const next = {
      provider: provider === "openai" ? "openai" : provider === "novelai" ? "novelai" : cur.provider,
      aspect:
        aspect === "square" || aspect === "portrait" || aspect === "landscape" || aspect === "auto"
          ? (aspect as "auto" | "square" | "portrait" | "landscape")
          : cur.aspect,
      novelai: {
        key: novelai?.key ? String(novelai.key) : cur.novelai.key,
        // 站点地址不接受前端传值（固定在 imageConfig 常量里），只允许换模型
        model: novelai?.model !== undefined && String(novelai.model).trim() ? String(novelai.model).trim() : cur.novelai.model,
      },
      openai: {
        baseUrl: openai?.baseUrl !== undefined ? String(openai.baseUrl) : cur.openai.baseUrl,
        key: openai?.key ? String(openai.key) : cur.openai.key,
        model: openai?.model !== undefined ? String(openai.model) : cur.openai.model,
      },
      artists: nextArtists,
      // 只有前端真的传了 activeArtist 才改；没传（如只切提供商的局部保存）沿用原值——
      // 校验范围 = 内置默认串 + 用户自建串（内置不在 nextArtists 里，选了内置也必须能存）
      activeArtist:
        activeArtist === undefined
          ? (isBuiltinArtist(cur.activeArtist) || nextArtists.some((a) => a.name === cur.activeArtist))
            ? cur.activeArtist
            : ""
          : typeof activeArtist === "string" && (isBuiltinArtist(activeArtist) || nextArtists.some((a) => a.name === activeArtist))
            ? activeArtist
            : "",
      // 压缩开关：只认布尔；没传就沿用原值（前端局部保存不会误关）
      compression: { enabled: compression?.enabled === undefined ? cur.compression.enabled : compression.enabled === true },
    };
    await saveImageConfig(next);
    // 提供商切换后通道侧 SKILL.md 里的生图规则要跟着换（NAI 标签版 ↔ OpenAI 自然语言版）。
    // 网页侧每次请求都会重新 resolve，不用管；通道侧是编译快照，必须重编开了生图的卡。
    // 只在提供商真变了时才做（画师串/尺寸改动不影响规则文本）。
    let recompiled = 0;
    if (next.provider !== cur.provider) {
      const bots = await listBots().catch(() => []);
      for (const b of bots) {
        const card = await store.get(b.cardSlug).catch(() => null);
        if (!card) continue;
        const tools = card.tools?.enabled ?? [];
        if (!tools.includes("image_gen")) continue;
        await syncCardToChannel(card).catch(() => {});
        recompiled++;
      }
    }
    res.json({
      ok: true,
      hint:
        next.provider !== cur.provider
          ? `已保存，生图规则已切到${next.provider === "openai" ? " OpenAI 自然语言" : " NovelAI 标签"}版${recompiled ? `（已重编译 ${recompiled} 张通道卡）` : ""}`
          : "已保存",
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/image/test", async (req, res) => {
  try {
    const { provider, novelai, openai } = req.body ?? {};
    // 密钥用「空串也算没传」判断，不能用 ??：前端在密钥已保存时提交的是空串
    // （输入框显示点号占位，不代表用户改了密钥），用 ?? 会导致空串被当成有效值、直接报"未填密钥"。
    const cfg = await getImageConfig();
    if (provider === "novelai") {
      const key = String(novelai?.key ?? "").trim() || cfg.novelai.key;
      if (!key) return res.json({ ok: false, info: "未填生图密钥" });
      res.json(await testNovelaiKey(String(key)));
      return;
    }
    if (provider === "openai") {
      const baseUrl = String(openai?.baseUrl ?? "").trim() || cfg.openai.baseUrl;
      const key = String(openai?.key ?? "").trim() || cfg.openai.key;
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

// 拉取 NovelAI 网关可用模型（站点固定，模型让用户选；网关的 /v1/models 不需要 key 也能读）
app.post("/api/image/nai-models", async (req, res) => {
  try {
    const key = req.body?.key ?? (await getImageConfig()).novelai.key;
    const r = await listNovelaiGatewayModels(key ? String(key) : "");
    if (!r.ok) return res.json({ error: r.info || "拉取模型失败", models: [] });
    res.json({ models: r.models, base: NAI_GATEWAY_BASE });
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
        model: novelai?.model !== undefined && String(novelai.model).trim() ? String(novelai.model).trim() : cfg.novelai.model,
      },
      openai: {
        ...cfg.openai,
        baseUrl: openai?.baseUrl !== undefined ? String(openai.baseUrl) : cfg.openai.baseUrl,
        key: openai?.key ? String(openai.key) : cfg.openai.key,
        model: openai?.model !== undefined ? String(openai.model) : cfg.openai.model,
      },
    };
    const saveDir = path.join(dataDir(), "images", "_test");
    const useProvider = override.provider;
    // 没传提示词就用内置的试生提示词：NAI 吃 Danbooru 标签、OpenAI 兼容吃自然语言，
    // 所以两家各一套（用户在配置页点「测试」不用自己写词）
    const { TEST_PROMPT_NAI, TEST_PROMPT_OPENAI } = await import("./core/imageGen.js");
    const finalPrompt =
      String(prompt ?? "").trim() || (useProvider === "openai" ? TEST_PROMPT_OPENAI : TEST_PROMPT_NAI);
    const r = await generateImage(
      {
        prompt: finalPrompt,
        negative: negative ? String(negative) : undefined,
        // 传了 aspect 用它；没传则由 generateImage 落到全局设置（cfg.aspect，默认 auto）
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

// 图片库：列出 data/images 下全部图片（按时间倒序），供管理/删除（仅剩试生图等历史数据；聊天生图已不再落盘）
app.get("/api/image/list", async (_req, res) => {
  try {
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

/** 图片自动清理已移除（2026-09-15）：聊天生图不再落盘（NAI=上游 URL 直显 / OpenAI=内存暂存给浏览器），
 *  服务器没有可清理的对象；用户图片由浏览器 IndexedDB 与本地文件夹自行管理。 */

// ---------- 图片内存图库（OpenAI 网页生图字节中转）+ 上游图链代理 ----------
// 注意注册顺序：这两个必须放在 /api/image/list、/api/image/delete 之后，
// 否则 /api/image/:id 会把 "list"/"delete" 当成 id 截胡。
// 代理拉取上游图链（NAI 图保存到本地时用：绕浏览器 CORS；fmt=webp 时顺手压缩）
app.get("/api/image/fetch", async (req, res) => {
  try {
    const url = String(req.query.url ?? "");
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "缺少合法的图片地址" });
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return res.status(502).json({ error: `上游图片拉取失败 HTTP ${r.status}` });
    const src = Buffer.from(await r.arrayBuffer());
    let buf: Buffer = src;
    let mime = r.headers.get("content-type") ?? "image/png";
    if (String(req.query.fmt ?? "") === "webp") {
      const { recompress } = await import("./core/imageGen.js");
      const c = await recompress(src, "webp");
      if (c) {
        buf = c.buf;
        mime = c.mime;
      }
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// ---------- 存储占用统计（服务端数据：聊天记录 / 角色卡 / 记忆 / 历史图片） ----------
// 供「本地存储」页分类占用：每张卡一份，前端与浏览器侧（图片/语音 IndexedDB）合并展示。
async function pathBytes(p: string): Promise<number> {
  const st = await fs.lstat(p).catch(() => null);
  if (!st) return 0;
  if (st.isSymbolicLink()) return 0; // 软链不计（避免重复统计）
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const e of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) {
    total += await pathBytes(path.join(p, e.name));
  }
  return total;
}

app.get("/api/storage/breakdown", async (_req, res) => {
  try {
    const root = dataDir();
    const cards = await store.list().catch(() => []);
    const rows: { slug: string; name: string; chat: number; mem: number; card: number; img: number }[] = [];
    for (const c of cards) {
      const slug = c.slug;
      const chat =
        (await pathBytes(path.join(root, "conversations", `${slug}.jsonl`))) +
        (await pathBytes(path.join(root, "memory", `${slug}.chatlog.jsonl`)));
      const mem =
        (await pathBytes(path.join(root, "memory", `${slug}.mem`))) +
        (await pathBytes(path.join(root, "memory", `${slug}.greeted.json`))) +
        (await pathBytes(path.join(root, "memory", `${slug}.mirror.json`))) +
        (await pathBytes(path.join(root, "memory-export", `${slug}.md`))) +
        (await pathBytes(path.join(root, "history-export", `${slug}.md`)));
      const card =
        (await pathBytes(path.join(root, "cards", slug))) +
        (await pathBytes(path.join(coversDir(), `${slug}.png`))) +
        (await pathBytes(path.join(coversDir(), slug)));
      const img = await pathBytes(path.join(root, "images", slug));
      rows.push({ slug, name: c.name ?? slug, chat, mem, card, img });
    }
    const totals = rows.reduce(
      (a, r) => ({ chat: a.chat + r.chat, mem: a.mem + r.mem, card: a.card + r.card, img: a.img + r.img }),
      { chat: 0, mem: 0, card: 0, img: 0 }
    );
    res.json({ cards: rows, totals });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 内存图库取图（OpenAI 网页生图：前端拉一次存进 IndexedDB，此后不再依赖服务器）
app.get("/api/image/:id", async (req, res) => {
  const img = getMemImage(String(req.params.id ?? ""));
  if (!img) return res.status(404).json({ error: "图片已过期或不存在（服务器只暂存 2 小时，请重新生成）" });
  res.setHeader("Content-Type", img.mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(img.buf);
});

// ---------- 设备管理（管理员）：列出注册设备 / 停用恢复 ----------
app.get("/api/users", async (_req, res) => {
  res.json({ devices: listDevices() });
});
app.post("/api/users/disable", async (req, res) => {
  const { id, disabled } = req.body ?? {};
  const ok = setDeviceDisabled(String(id ?? ""), disabled === true);
  if (!ok) return res.status(400).json({ error: "设备不存在或 id 不合法" });
  res.json({ ok: true });
});

// ---------- 语音合成（TTS）：上游聚合（OpenAI 兼容，可售卖）+ 本地兜底（Edge/SAPI） ----------
/**
 * 本地语音兜底（Edge 在线免费 / Windows SAPI 离线）是否可用。
 * 托管形态（服务器）下它只给运营者：SAPI 是 Windows-only 在 Linux 上直接跑不起来，
 * Edge 走的是运营者的出口与免费额度；用户版一律只走「自己添加的语音上游」。
 * 单用户模式（用户自己拉代码在本机跑）等于管理员，照旧全部可用。
 */
function localTtsAllowed(res: express.Response): boolean {
  return !HOSTED_MODE || !!res.locals.ocAdmin;
}

app.get("/api/tts/config", async (req, res) => {
  try {
    const cfg = await getTtsConfig();
    const allowLocal = localTtsAllowed(res);
    // 设备侧把 local 从可选项里摘掉；默认值若指向 local 则顺延到第一个上游（没有就空）
    const def = !allowLocal && cfg.defaultProvider === "local" ? (cfg.providers[0]?.id ?? "") : cfg.defaultProvider;
    res.json({
      defaultProvider: def,
      local: allowLocal
        ? { engine: cfg.local.engine, voice: cfg.local.voice, rate: cfg.local.rate, pitch: cfg.local.pitch }
        : null,
      allowLocal,
      providers: cfg.providers.map((p) => ({ ...p, key: maskTtsKey(p.key) })),
      commonVoices: allowLocal ? COMMON_EDGE_VOICES : [],
    });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/tts/config", async (req, res) => {
  try {
    const { defaultProvider, local } = req.body ?? {};
    const cur = await getTtsConfig();
    const allowLocal = localTtsAllowed(res);
    const wanted = defaultProvider === "local" && !allowLocal ? undefined : defaultProvider;
    const next = {
      ...cur,
      defaultProvider: wanted && (wanted === "local" || cur.providers.some((p) => p.id === wanted))
        ? wanted
        : cur.defaultProvider,
      // 设备侧不改本地设置（表单里也看不到这一块）
      local: allowLocal
        ? {
            engine: ["edge", "sapi"].includes(local?.engine) ? local.engine : cur.local.engine,
            voice: local?.voice ?? cur.local.voice,
            rate: local?.rate ?? cur.local.rate,
            pitch: local?.pitch ?? cur.local.pitch,
          }
        : cur.local,
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
      // 删掉的是当前生效的那个：管理员回落到本地兜底，用户侧回落到剩下的第一个（没有就留空）
      defaultProvider: cur.defaultProvider === id
        ? (localTtsAllowed(res) ? "local" : providers[0]?.id ?? "")
        : cur.defaultProvider,
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
    } else if (k === "mimo") {
      models = ["mimo-v2-tts"];
      voices = TTS_PROVIDER_PRESETS.mimo.voices?.map((v) => v.id) ?? [];
    } else if (k === "elevenlabs") {
      models = ["eleven_multilingual_v2", "eleven_multilingual_v1", "eleven_turbo_v2_5", "eleven_flash_v2_5"];
    } else if (k === "fishaudio") {
      models = ["fishaudio/s2.1-pro", "fishaudio/s2.1-pro-flash", "fishaudio/fish-speech-1.5"];
    }
    res.json({ models, voices });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.get("/api/tts/voices", async (req, res) => {
  try {
    // Edge 语音列表只服务于本地兜底：用户侧没必要拉（列表接口还会走微软的在线接口）
    if (!localTtsAllowed(res)) return res.json({ voices: [] });
    res.json({ voices: await listEdgeVoices() });
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

// 各家的官方预置（模型/音色列表），供前端添加/编辑提供商时下拉点选（仿 rikkahub）
app.get("/api/tts/presets", async (_req, res) => {
  res.json({ presets: TTS_PROVIDER_PRESETS });
});

// target: "local" 或 provider id
app.post("/api/tts/test", async (req, res) => {
  try {
    const { target } = req.body ?? {};
    res.json(await testTts(String(target ?? ""), { allowLocal: localTtsAllowed(res) }));
  } catch (e) {
    res.status(500).json({ error: toUserError(e) });
  }
});

app.post("/api/tts/synthesize", async (req, res) => {
  const started = Date.now();
  try {
    const { text, providerId, voice, speed } = req.body ?? {};
    const buf = await synthesizeTts(String(text ?? ""), { providerId, voice, speed, allowLocal: localTtsAllowed(res) });
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

// ---------- LLM 用量与缓存统计 ----------
app.get("/api/llm/usage", async (_req, res) => {
  try {
    res.json(await summarizeLlmUsage());
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
// 检索隔离（2026-09-08）：不再全局共享检索池——每个绑定卡的 agent 只检索自己卡的
// memory-export/history-export 两个 md（applyAgentMemoryScope 同时清空 defaults.extraPaths，
// 因为 OpenClaw 的 agent 级与 defaults 级是合并关系，不清理就还是会跨卡互搜）。
async function ensureMemorySearchExtraPaths(): Promise<boolean> {
  const n = await applyAllAgentMemoryScopes().catch(() => 0);
  return n > 0;
}

/**
 * USER.md 里记忆段的起止标记（便于重置时精确剥离，不破坏 OpenClaw 自己的用户档案）
 */
const USER_MEMORY_START = "<!-- openclaw-shell:user-memory-start -->";
const USER_MEMORY_END = "<!-- openclaw-shell:user-memory-end -->";

/**
 * 通道读本地记忆（免向量、免搜索）：把该卡的记忆 + 本地网页聊天近 RECENT_CHAT_INJECT_ROUNDS 轮
 * 合并进绑定 agent 工作区根目录的 USER.md。
 * USER.md 是 OpenClaw 每轮必注入的"用户档案"文件（embedded 与网关都注入，已实测），
 * 所以记忆与近期聊天每次对话都自动带上——等价于"记忆代替聊天记录插入"，不依赖 memory_search/向量。
 * 保留 USER.md 原有内容（OpenClaw 自己的用户档案），只追加一段带标记的记忆区。
 */
async function syncAgentUserMemory(slug: string): Promise<void> {
  const bot = await getBotByCard(slug);
  if (!bot) return;
  const mdPath = path.join(dataDir(), "memory-export", `${slug}.md`);
  const content = await fs.readFile(mdPath, "utf8").catch(() => "");
  // 本地网页聊天近 N 轮（爱语式近记忆物化：换端也能接上最近聊过的话题）
  const recent = await readRecentLocalChat(slug);
  const chatSection = recent.length
    ? `\n\n### 网页端近期聊天（最近 ${Math.ceil(recent.length / 2)} 轮，用户可能在任意端继续话题）\n` +
      recent.map((r) => `- ${r.role === "user" ? "用户" : "你"}：${r.content}`).join("\n")
    : "\n\n### 网页端近期聊天\n- （暂无网页端聊天记录）";
  // 记忆为空也注入占位说明，保证段结构始终存在、模型知道有记忆系统
  const userMd = path.join(agentWorkspaceDir(slug), "USER.md");
  // 剥离旧的记忆段（若存在），保留原档案
  const existing = await fs.readFile(userMd, "utf8").catch(() => "");
  const base = existing.replace(new RegExp(`${USER_MEMORY_START}[\\s\\S]*?${USER_MEMORY_END}\\s*`, "g"), "").trimEnd();
  // 当前扮演配置 + 变更提醒（每轮注入，对抗上下文惯性）。
  // 【位置】放在段尾（长期记忆与近期聊天之后）：旧聊天记录里全是旧风格的句式，
  // 配置提醒必须排在它们后面才压得住近因效应，否则换风格后模型照旧风格输出。
  const cfgSection = buildConfigSectionForUserMd(await readConfigState(slug).catch(() => ({})));
  const memSection = (content.trim() || chatSection || cfgSection)
    ? `\n\n${USER_MEMORY_START}\n${content.trim() || "\n### 长期记忆\n- （暂无自动总结的记忆，靠对话自然积累）"}\n${chatSection.trim()}\n${cfgSection.trim()}\n${USER_MEMORY_END}`
    : "";
  await fs.writeFile(userMd, base + memSection + "\n", "utf8");
}

/**
 * 通道会话观察器：每 5 秒把绑定卡的通道新对话同步进统一日志与记忆（网页可见）。
 *
 * **必须连各设备命名空间一起扫**（2026-09-17 修）：原来只扫运营者的全局卡，用户那边的
 * QQ/微信消息只有「用户正打开网页停在那张卡上」时才由前端轮询补进来 —— App 关着期间
 * 发生的对话就永远进不了记录。现在服务端按设备作用域轮流补观察，用户下次打开 App
 * 时记录已经攒好了（`/api/sync/pull` 再把它拉进 App 本地）。
 */
let mirrorTimer: ReturnType<typeof setInterval> | null = null;
let mirrorSweeping = false;
async function sweepMirrors(): Promise<void> {
  if (mirrorSweeping) return; // 上一轮还没跑完（设备多/上游慢）就跳过这一拍，别堆积
  mirrorSweeping = true;
  try {
    // ① 运营者自己的全局卡
    for (const bot of await listBots().catch(() => [])) {
      if (!bot.channel) continue;
      await observeCardLocked(bot.cardSlug).catch(() => {});
    }
    // ② 每个已注册设备的卡（进各自命名空间）。超过保留期没露过面的设备跳过：
    //    它的记录按保留策略本来就要清掉，不必再花 IO 补。
    const aliveAfter = Date.now() - RETENTION_DAYS * 86400_000;
    for (const d of listDevices()) {
      const id = String(d?.id ?? "");
      if (!DEVICE_ID_RE.test(id) || d.disabled) continue;
      if (d.lastSeen && (Date.parse(d.lastSeen) || 0) < aliveAfter) continue;
      await runAsUser({ deviceId: id, root: userRoot(id) }, async () => {
        for (const bot of await listBots().catch(() => [])) {
          if (!bot.channel) continue;
          await observeCardLocked(bot.cardSlug).catch(() => {});
        }
      }).catch(() => {});
    }
  } finally {
    mirrorSweeping = false;
  }
}
function startMirrorObserver(): void {
  if (mirrorTimer) return;
  mirrorTimer = setInterval(() => void sweepMirrors(), 5000);
  if (mirrorTimer.unref) mirrorTimer.unref();
}

// 本地聊天落盘后防抖刷新通道侧（导出 history md + 重写 USER.md 记忆/近3轮聊天）
const channelMemTimers = new Map<string, NodeJS.Timeout>();
function scheduleChannelMemoryRefresh(slug: string): void {
  const old = channelMemTimers.get(slug);
  if (old) clearTimeout(old);
  channelMemTimers.set(slug, setTimeout(() => {
    channelMemTimers.delete(slug);
    void (async () => {
      await exportHistoryToMarkdown(slug).catch(() => {});
      await syncAgentUserMemory(slug).catch(() => {});
    })();
  }, 6000));
}

// 确保 OpenClaw 索引 memory-export（通道 agent 可搜索本地记忆）。必须在 listen 前完成：
// start-stack 先起 server 再起 gateway，这里 await 落盘后网关读到的一定是新配置。
await ensureMemorySearchExtraPaths().then((changed) => {
  if (changed) logInfo("记忆", "已写入 OpenClaw memorySearch.extraPaths 索引路径");
});

app.listen(PORT, HOST, () => {
  logInfo("启动", `服务已启动 http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
  // 用户数据保留策略（15 天，只作用于设备命名空间）：启动跑一次 + 每 6 小时一次。
  // 每次都留一行巡检日志（P1-⑨）：之前从未留痕，无法确认 15 天清理真的在跑。
  const retentionSweep = () =>
    runRetention()
      .then((rows) => {
        const removed = rows.reduce((a, r) => a + r.conversationsRemoved + r.chatlogRemoved + r.memoryRemoved, 0);
        const rewritten = rows.reduce((a, r) => a + r.imagesRewritten, 0);
        logInfo("保留", `保留策略巡检：设备 ${rows.length} 台 · 清理过期记录 ${removed} 条 · 图链改写 ${rewritten} 处（${RETENTION_DAYS} 天）`);
      })
      .catch((e) => logWarn("保留", `保留策略巡检失败`, e));
  void retentionSweep();
  setInterval(retentionSweep, 6 * 3600 * 1000);
  // 媒体与临时文件巡检（P1，2026-09-18）：retention 只管聊天记录/记忆，这里管"没人清就无限涨"的
  // 媒体——通道生图 gen-* 残留 / 测试生图 / 表情通道孤儿副本 / 过期导出 md / 孤儿用户目录（先备份再删）。
  void runMediaSweep().catch((e) => logWarn("清理", `媒体巡检失败`, e));
  setInterval(() => void runMediaSweep().catch((e) => logWarn("清理", `媒体巡检失败`, e)), 6 * 3600 * 1000);
  // 记忆导出：启动时同步全部卡的记忆到 md（供 OpenClaw memorySearch.extraPaths 索引）
  void exportAllMemoriesToMarkdown().then((slugs) => {
    if (slugs.length) logInfo("记忆", `已导出 ${slugs.length} 张卡的记忆`);
    // 免向量方案：绑定卡的记忆 + 本地聊天近3轮同步进 agent 工作区 USER.md（通道 agent 每轮自动带上）
    void (async () => {
      for (const b of await listBots().catch(() => [])) {
        await syncAgentUserMemory(b.cardSlug).catch(() => {});
      }
    })();
  });
  // 本地聊天原文导出（最近 100 轮，通道 agent 可检索网页聊天记录）
  void exportAllHistoriesToMarkdown().then((slugs) => {
    if (slugs.length) logInfo("记忆", `已导出 ${slugs.length} 张卡的本地聊天记录（通道可检索）`);
  });
  // 表情库 → 通道媒体目录同步（全局目录=管理员自己的表情池；QQ/微信插件出口按 agentId 查图，设备 agent 查各自隔离子目录）
  void syncEmojisToChannelMedia().then((files) => {
    if (files.length) logInfo("表情", `已同步 ${files.length} 个表情到通道媒体目录`);
  });
  // v15 表情隔离：各设备空间回填各自的 u<前8位>/ 子目录（旧表情无需用户重新添加即可被通道查到）
  void (async () => {
    let backfilled = 0;
    for (const d of listDevices()) {
      const devId = String(d?.id ?? "");
      if (!DEVICE_ID_RE.test(devId) || d.disabled) continue;
      await runAsUser({ deviceId: devId, root: userRoot(devId) }, async () => {
        backfilled += (await syncEmojisToChannelMedia().catch(() => [])).length;
      }).catch(() => {});
    }
    if (backfilled) logInfo("表情", `已回填 ${backfilled} 个设备表情到各自隔离目录`);
  })();
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
      // lastMsgOf：该卡最后一条消息的时间 → 主动消息的 prompt 里注入"冷场了多久"
      const fired = await runLifeTick(
        cards,
        lifeTrigger,
        lifeKnownUsersOf,
        lifeAgentOf,
        async (slug) => {
          const tail = await readConv(slug, 1).catch(() => []);
          return tail.at(-1)?.t ?? "";
        }
      );
      if (fired.length) logInfo("AI生命", `本轮主动消息 ${fired.length} 条`);
    } catch (e) {
      logWarn("AI生命", `调度异常：${String(e).slice(0, 300)}`);
    }
  }, 60 * 1000);
  logInfo("AI生命", "调度器已启动（每分钟检查一次主动消息）");
}
