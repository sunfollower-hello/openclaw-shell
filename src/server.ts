// 本地服务：卡片 API + Web 编辑器
// 启动: npm run server  →  http://127.0.0.1:17880
import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CardStore, dataDir, newCardId, nowIso } from "./core/cardStore.js";
import { defaultCard, SCHEMA_VERSION } from "./core/schema.js";
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
import { runDistill, saveDistilledCard } from "./distiller/pipeline.js";
import { RELATION_ROLES } from "./core/schema.js";

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
app.use(express.static(path.join(projectRoot, "web")));

// ---------- API ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "openclaw-shell", schema: SCHEMA_VERSION });
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
    const llm = await getModelLLMConfig();
    if (!llm || !llm.apiKey) {
      return res.status(400).json({ error: "未配置模型 API。请先到「API」页添加提供商并设为默认" });
    }
    const result = await runDistill({
      rawJson: JSON.parse(fileContent),
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
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(card);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`openclaw-shell 已启动: http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
});
