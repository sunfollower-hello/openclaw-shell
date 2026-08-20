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

app.listen(PORT, HOST, () => {
  console.log(`openclaw-shell 已启动: http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
});
