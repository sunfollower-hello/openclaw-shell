// 本地服务：卡片 API + Web 编辑器
// 启动: npm run server  →  http://127.0.0.1:17880
import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CardStore, dataDir, newCardId, nowIso } from "./core/cardStore.js";
import { defaultCard, SCHEMA_VERSION, type PersonaCard } from "./core/schema.js";
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
import { parsePlainText } from "./distiller/parser.js";
import { RELATION_ROLES } from "./core/schema.js";
import { buildChatSystem } from "./core/chatPrompt.js";
import { TOOL_REGISTRY, toolsToOpenAI, type ToolDef, type ToolCtx } from "./tools/registry.js";
import { SKILL_LIBRARY } from "./core/skills.js";
import { getMCPTools, loadMCPConfig, saveMCPConfig, reloadMCP } from "./tools/mcp.js";
import { cardToCCv2, ccv2ToCard } from "./core/cardConvert.js";
import { solidPng, pngWithText, extractCardJson } from "./core/png.js";

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
  res.json({ ok: true, service: "openclaw-shell", schema: SCHEMA_VERSION, port: PORT, dataDir: dataDir() });
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
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(card);
    res.json({ card });
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
    const llm = await getModelLLMConfig();
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
    sandboxDir: path.join(dataDir(), "sandbox", slug),
    memoryPath: path.join(dataDir(), "memory", `${slug}.mem`),
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    const { slug, message, history, tools, skills, thinking, useMCP } = req.body ?? {};
    if (!slug || !message) return res.status(400).json({ error: "slug / message 不能为空" });
    const llm = await getModelLLMConfig();
    if (!llm || !llm.apiKey) return res.status(400).json({ error: "未配置模型 API（API 页）" });
    const card = await store.get(slug);
    const enabledTools = Array.isArray(tools) ? (tools as string[]) : [];
    const { defs: toolDefs, mcpErrors } = await resolveChatTools(enabledTools, useMCP === true);

    const skillPrompts = (Array.isArray(skills) ? (skills as string[]) : [])
      .map((id) => SKILL_LIBRARY.find((s) => s.id === id)?.prompt)
      .filter(Boolean) as string[];

    const memories = await fs
      .readFile(chatCtx(slug).memoryPath, "utf8")
      .then((t) => t.split("\n").filter(Boolean))
      .catch(() => []);
    const memoryBlock = memories.length
      ? `\n\n【长期记忆（关于用户的事实，仅在相关时使用；要新增事实时调用 memory_save 工具）】\n- ${memories.slice(-30).join("\n- ")}`
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
    const system =
      buildChatSystem(card) +
      (toolDefs.length
        ? "\n\n你可以使用工具完成任务（写代码/沙箱文件/搜索/天气/时间/记忆）。用户请求适合用工具完成时，调用工具而不是凭空编造；危险工具会先征得用户同意。"
        : "") +
      skillPrompts.map((p) => "\n" + p).join("") +
      memoryBlock +
      (mcpErrors.length ? `\n\n（MCP 连接提示：${mcpErrors.join("；")}）` : "");

    const messages: unknown[] = [
      { role: "system", content: system },
      ...(Array.isArray(history) ? history.slice(-20) : []),
      { role: "user", content: message },
    ];
    const result = await runToolLoop(llm, messages, toolDefs, chatCtx(slug), card.tools?.policy === "ask", reasoning);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/chat/approve", async (req, res) => {
  try {
    const { slug, messages, approve, tools, useMCP } = req.body ?? {};
    if (!slug || !Array.isArray(messages)) return res.status(400).json({ error: "slug / messages 不能为空" });
    const llm = await getModelLLMConfig();
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
    const memory: Record<string, string> = {};
    const memDir = path.join(dataDir(), "memory");
    for (const f of await fs.readdir(memDir).catch(() => [])) {
      memory[f] = await fs.readFile(path.join(memDir, f), "utf8").catch(() => "");
    }
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

// ---------- 长期记忆查看 / 清空 ----------
app.get("/api/memory", async (_req, res) => {
  try {
    const memDir = path.join(dataDir(), "memory");
    const out: Record<string, string[]> = {};
    for (const f of await fs.readdir(memDir).catch(() => [])) {
      const text = await fs.readFile(path.join(memDir, f), "utf8").catch(() => "");
      out[f.replace(/\.mem$/, "")] = text.split("\n").filter(Boolean);
    }
    res.json({ memory: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/memory/clear", async (_req, res) => {
  try {
    const memDir = path.join(dataDir(), "memory");
    for (const f of await fs.readdir(memDir).catch(() => [])) {
      await fs.rm(path.join(memDir, f), { force: true }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`openclaw-shell 已启动: http://${HOST}:${PORT}`);
  console.log(`卡片目录: ${store["dir"]}`);
});
