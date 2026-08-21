// openclaw-shell 前端 v2：抽屉导航 + 首页操作台 + 视图路由
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ================= 基础工具 =================
const api = {
  async get(path) {
    const r = await fetch(path);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  async send(path, options = {}) {
    const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setChip(el, text, ok) {
  if (!el) return;
  el.textContent = text;
  el.className = "chip " + (ok === null ? "" : ok ? "ok" : "bad");
}

// 能力默认值（本地持久化，聊天测试可临时覆盖）
const DEFAULTS_KEY = "ocs_cap_defaults";
function capDefaults() {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}");
  } catch { return {}; }
}
function saveCapDefaults(d) {
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
}

// ================= 全局状态 =================
let currentSlug = null;
let dirty = false;
let chatHistory = [];
let pendingData = null;
let workMode = false;
let lastDistilledCard = null;
let currentCardSt = null;
let health = null;

function setStatus(text, cls = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = text;
  el.className = "status " + cls;
}

// ================= 抽屉 =================
function openDrawer() {
  $("#drawer").classList.add("open");
  $("#drawer-overlay").hidden = false;
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-overlay").hidden = true;
}

// ================= 路由 =================
function router() {
  const hash = (location.hash || "").replace(/^#\/?/, "") || "home";
  const route = routes[hash] || routes.home;
  const view = $("#view");
  view.innerHTML = route.render();
  closeDrawer();
  view.scrollTop = 0;
  document.querySelectorAll(".bottom-nav a, .drawer-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === hash);
  });
  route.init();
}
window.addEventListener("hashchange", router);

// ================= 顶栏状态 =================
async function refreshTopStatus() {
  try {
    health = await api.get("/api/health");
    $("#drawer-meta").textContent = `v${health.schema} · ${health.dataDir ?? ""}`;
    const model = await api.get("/api/config/model").catch(() => null);
    setChip($("#ts-model"), model?.primary ? "模型 ✓" : "模型 ✗", Boolean(model?.primary));
    const wx = await api.get("/api/channels/wechat/status").catch(() => null);
    setChip($("#ts-wx"), wx?.connected ? "微信 ✓" : "微信 ✗", wx?.connected);
    const qq = await api.get("/api/channels/qq/status").catch(() => null);
    const qqOk = qq?.pluginInstalled && qq?.onebotSeen;
    setChip($("#ts-qq"), qqOk ? "QQ ✓" : "QQ ✗", qqOk);
  } catch { /* 服务未启动 */ }
}

// ============================================================
//  视图：首页
// ============================================================
function renderHome() {
  return `
  <div class="view home">
    <div class="home-status">
      <div class="status-card">
        <div class="status-head"><span class="big">⚡</span> 模型</div>
        <div id="hs-model" class="meta">检测中…</div>
        <button class="small-btn" data-go="api">去配置</button>
      </div>
      <div class="status-card">
        <div class="status-head"><span class="big">💬</span> 微信</div>
        <div id="hs-wx" class="meta">检测中…</div>
        <button class="small-btn" data-go="channels">去绑定</button>
      </div>
      <div class="status-card">
        <div class="status-head"><span class="big">🐧</span> QQ</div>
        <div id="hs-qq" class="meta">检测中…</div>
        <button class="small-btn" data-go="channels">去绑定</button>
      </div>
    </div>

    <div class="home-guide card">
      <h3>🚀 快速上手</h3>
      <div class="steps">
        <div class="step" id="step-api"><span class="dot"></span>① 配置 API</div>
        <div class="step" id="step-card"><span class="dot"></span>② 建卡 / 导入</div>
        <div class="step" id="step-channel"><span class="dot"></span>③ 绑定通道</div>
        <div class="step" id="step-chat"><span class="dot"></span>④ 开始聊天</div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" data-go="cards">🎴 去建卡 / 导入</button>
        <button data-go="channels">💬 去绑定通道</button>
        <button id="home-chat-test" disabled>💬 聊天测试</button>
      </div>
    </div>

    <div class="home-active card">
      <h3>⚡ 当前生效人设 <span class="hint">（最后编译到通道的卡片）</span></h3>
      <div id="home-active-box" class="active-box">—</div>
    </div>

    <div class="home-cards card">
      <h3>🎴 人设卡库</h3>
      <div id="home-card-grid" class="card-grid"></div>
    </div>
  </div>`;
}

function initHome() {
  document.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => (location.hash = "#/" + b.dataset.go))
  );
  refreshHomeStatus();
  refreshHomeCards();
}

async function refreshHomeStatus() {
  try {
    const model = await api.get("/api/config/model").catch(() => null);
    const ok1 = Boolean(model?.primary);
    $("#hs-model").textContent = model?.primary || "未配置模型";
    $("#step-api").classList.toggle("done", ok1);
    const wx = await api.get("/api/channels/wechat/status").catch(() => null);
    $("#hs-wx").textContent = wx?.connected ? "已连接 ✓" : "未绑定";
    $("#step-channel").classList.toggle("done", Boolean(wx?.connected));
    const qq = await api.get("/api/channels/qq/status").catch(() => null);
    $("#hs-qq").textContent = qq?.pluginInstalled && qq?.onebotSeen ? "已连接 ✓" : "未绑定";
    $("#step-channel").classList.toggle("done", Boolean(wx?.connected || (qq?.pluginInstalled && qq?.onebotSeen)));
    const active = await api.get("/api/active-persona").catch(() => null);
    $("#home-active-box").innerHTML = active?.active
      ? `<span class="active-name">${escapeHtml(active.active)}</span>
         <button id="home-goto-cards" class="small-btn">去人设卡页</button>`
      : "还没有编译过人设卡，去人设卡页编译一张";
    const go = $("#home-goto-cards");
    if (go) go.addEventListener("click", () => (location.hash = "#/cards"));
    const cards = await api.get("/api/cards").catch(() => ({ cards: [] }));
    $("#step-card").classList.toggle("done", cards.cards?.length > 0);
    $("#step-chat").classList.toggle("done", ok1 && cards.cards?.length > 0);
    const chatBtn = $("#home-chat-test");
    if (chatBtn) {
      chatBtn.disabled = !(ok1 && cards.cards?.length > 0);
      chatBtn.addEventListener("click", () => (location.hash = "#/cards"));
    }
  } catch { /* 忽略 */ }
}

async function refreshHomeCards() {
  const box = $("#home-card-grid");
  if (!box) return;
  try {
    const { cards } = await api.get("/api/cards");
    box.innerHTML = "";
    if (!cards.length) {
      box.innerHTML = '<div class="muted">还没有人设卡，点「去建卡 / 导入」开始</div>';
      return;
    }
    for (const c of cards.slice(-8).reverse()) {
      const d = document.createElement("div");
      d.className = "mini-card";
      d.innerHTML = `<div class="mini-name">${escapeHtml(c.name)}</div>
        <div class="meta">${c.slug} · ${c.role}</div>`;
      d.addEventListener("click", () => {
        currentSlug = c.slug;
        location.hash = "#/cards";
        setTimeout(() => openCard(c.slug), 50);
      });
      box.appendChild(d);
    }
  } catch { /* 忽略 */ }
}

// ============================================================
//  视图：人设卡库
// ============================================================
function renderCards() {
  return `
  <div class="cards-layout">
    <aside class="cards-side">
      <div class="create-box">
        <h2>新建人设卡</h2>
        <input id="new-name" placeholder="名称（如：奶奶）" />
        <input id="new-slug" placeholder="slug（留空自动生成）" />
        <select id="new-role">
          <option value="friend">朋友</option><option value="family">家人</option>
          <option value="self">自己</option><option value="partner">前任/恋人</option>
          <option value="colleague">同事</option><option value="public-figure">偶像/角色</option>
        </select>
        <button id="btn-create">创建</button>
        <div class="row">
          <button id="btn-card-wizard" class="small-btn">🃏 做卡向导</button>
          <button id="btn-import-card" class="small-btn">📥 导入卡</button>
          <input type="file" id="import-file" accept=".png,.json" style="display:none" />
        </div>
      </div>
      <h2>卡库</h2>
      <ul id="card-list" class="card-list"></ul>
    </aside>
    <section class="cards-editor">
      <div id="card-wizard" class="wizard" style="display:none">
        <h3>🃏 做卡向导 <span class="hint">填好后点「应用到卡片」，再点「保存」</span></h3>
        <label>简介（description）</label>
        <textarea id="wz-desc" rows="2" placeholder="如：80 岁的北方奶奶，说话直接但心软"></textarea>
        <label>开场白（first_mes）</label>
        <textarea id="wz-first" rows="2" placeholder="如：哎，你可算回来了，快坐下"></textarea>
        <label>世界书（第一行固定「人物形象」）</label>
        <div id="wz-book"></div>
        <button id="btn-wz-add-entry" class="small-btn">+ 添加世界书条目</button>
        <label>正则替换（可留空）</label>
        <div id="wz-regex"></div>
        <button id="btn-wz-add-regex" class="small-btn">+ 添加正则</button>
        <label>头像（PNG，可选）</label>
        <input type="file" id="wz-avatar" accept=".png" />
        <div class="row">
          <button id="btn-wz-apply" class="primary">应用到卡片</button>
          <button id="btn-wz-close" class="small-btn">关闭</button>
        </div>
      </div>
      <div class="editor-head">
        <h2 id="editor-title">选择左侧卡片开始编辑 <span id="active-persona" class="chip" style="display:none"></span></h2>
        <div class="editor-actions">
          <button id="btn-export-png">导出 PNG</button>
          <button id="btn-export-json">导出 JSON</button>
          <button id="btn-compile">编译到 OpenClaw</button>
          <button id="btn-validate">校验</button>
          <button id="btn-save" class="primary">保存</button>
          <button id="btn-del" class="danger">删除</button>
        </div>
      </div>
      <textarea id="editor-json" spellcheck="false" placeholder="卡片 JSON（persona-card v1 格式）"></textarea>
      <div id="status" class="status"></div>
      <div class="chat-test">
        <div class="chat-head">
          <h3>💬 聊天测试 <span id="chat-head-hint" class="hint">普通聊天：纯人设对话</span></h3>
          <div>
            <button id="btn-work-mode" class="small-btn">🔧 进入工作模式</button>
            <button id="btn-chat-clear" class="small-btn">清空</button>
          </div>
        </div>
        <div class="chat-opts" style="display:none">
          <span class="opt-group">工具：
            <label title="危险工具，会先问你是否执行"><input type="checkbox" id="tool-code" /> 写代码*</label>
            <label><input type="checkbox" id="tool-file" /> 沙箱文件</label>
            <label><input type="checkbox" id="tool-search" /> 搜索</label>
            <label><input type="checkbox" id="tool-weather" /> 天气</label>
            <label><input type="checkbox" id="tool-time" /> 时间</label>
            <label><input type="checkbox" id="tool-memory" /> 记忆</label>
            <label><input type="checkbox" id="tool-mcp" /> MCP</label>
          </span>
          <span class="opt-group">技能：
            <label><input type="checkbox" id="skill-code" /> 代码专家</label>
            <label><input type="checkbox" id="skill-trans" /> 翻译</label>
            <label><input type="checkbox" id="skill-write" /> 写作</label>
            <label><input type="checkbox" id="skill-companion" /> 陪伴</label>
          </span>
          <span class="opt-group">深度：
            <select id="chat-thinking">
              <option value="off">关闭</option><option value="auto" selected>自动（默认）</option>
              <option value="low">低</option><option value="medium">中</option>
              <option value="high">高</option><option value="extreme">极高</option>
            </select>
          </span>
          <span class="opt-group">语音：
            <label><input type="checkbox" id="chat-voice-reply" /> 读回复</label>
            <button id="btn-mic" class="small-btn">🎤</button>
          </span>
        </div>
        <div id="chat-log" class="chat-log"></div>
        <div class="row">
          <input id="chat-input" placeholder="试试：帮我写段代码算 1 加到 100…" />
          <button id="btn-chat-send" class="primary">发送</button>
        </div>
      </div>
    </section>
  </div>`;
}

function initCards() {
  const def = capDefaults();
  $("#tool-code").checked = def.tools?.includes("code_exec") ?? false;
  $("#tool-file").checked = def.tools?.includes("sandbox_list") ?? false;
  $("#tool-search").checked = def.tools?.includes("web_search") ?? false;
  $("#tool-weather").checked = def.tools?.includes("weather") ?? false;
  $("#tool-time").checked = def.tools?.includes("datetime") ?? false;
  $("#tool-memory").checked = def.tools?.includes("memory_save") ?? false;
  $("#skill-code").checked = def.skills?.includes("code_expert") ?? false;
  $("#skill-trans").checked = def.skills?.includes("translator") ?? false;
  $("#skill-write").checked = def.skills?.includes("writing") ?? false;
  $("#skill-companion").checked = def.skills?.includes("companion") ?? false;
  $("#chat-thinking").value = def.thinking ?? "auto";
  $("#chat-voice-reply").checked = def.voiceReply ?? false;

  $("#btn-create").addEventListener("click", createCard);
  $("#btn-save").addEventListener("click", saveCard);
  $("#btn-compile").addEventListener("click", compileCard);
  $("#btn-validate").addEventListener("click", validateCard);
  $("#btn-del").addEventListener("click", deleteCard);
  $("#editor-json").addEventListener("input", () => { dirty = true; });
  $("#btn-export-png").addEventListener("click", () => exportCard("png"));
  $("#btn-export-json").addEventListener("click", () => exportCard("json"));
  $("#btn-import-card").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", importCard);
  $("#btn-card-wizard").addEventListener("click", openWizard);
  $("#btn-wz-close").addEventListener("click", closeWizard);
  $("#btn-wz-apply").addEventListener("click", applyWizard);
  $("#btn-wz-add-entry").addEventListener("click", () => $("#wz-book").appendChild(wizardBookRow({}).row));
  $("#btn-wz-add-regex").addEventListener("click", () => $("#wz-regex").appendChild(wizardRegexRow({}).row));
  $("#btn-chat-send").addEventListener("click", sendChat);
  $("#btn-chat-clear").addEventListener("click", clearChat);
  $("#btn-mic").addEventListener("click", startMic);
  $("#btn-work-mode").addEventListener("click", toggleWorkMode);
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  loadList();
  loadActivePersona();
}

// ---- 卡库 CRUD ----
async function loadList() {
  const { cards } = await api.get("/api/cards");
  const ul = $("#card-list");
  if (!ul) return;
  ul.innerHTML = "";
  for (const c of cards) {
    const li = document.createElement("li");
    li.innerHTML = `<div><div class="name">${escapeHtml(c.name)}</div>
      <div class="meta">${c.slug} · ${c.role} · v${c.version}</div></div>`;
    li.addEventListener("click", () => openCard(c.slug));
    if (c.slug === currentSlug) li.classList.add("active");
    ul.appendChild(li);
  }
  refreshHomeCards();
}

async function openCard(slug) {
  if (dirty && !confirm("当前卡片有未保存修改，确定放弃？")) return;
  const card = await api.get(`/api/cards/${slug}`);
  currentSlug = slug;
  currentCardSt = card.sillytavern_v2 || null;
  $("#editor-title").firstChild.textContent = `编辑：${card.name} (${card.slug}) `;
  $("#editor-json").value = JSON.stringify(card, null, 2);
  dirty = false;
  setStatus(`已加载 v${card.version}，编辑后点保存`);
  loadList();
}

async function createCard() {
  const name = $("#new-name").value.trim();
  if (!name) return setStatus("请输入名称", "err");
  try {
    await api.send("/api/cards", {
      method: "POST",
      body: JSON.stringify({ name, slug: $("#new-slug").value.trim() || undefined, role: $("#new-role").value }),
    });
    $("#new-name").value = "";
    $("#new-slug").value = "";
    setStatus("✓ 已创建，可开始编辑", "ok");
    loadList();
  } catch (e) {
    setStatus("创建失败：" + e.message, "err");
  }
}

async function saveCard() {
  if (!currentSlug) return;
  let card;
  try {
    card = JSON.parse($("#editor-json").value);
  } catch (e) {
    return setStatus("JSON 解析失败：" + e.message, "err");
  }
  try {
    const res = await api.send(`/api/cards/${currentSlug}`, { method: "PUT", body: JSON.stringify(card) });
    dirty = false;
    setStatus("✓ 已保存 v" + res.card.version + (res.warnings?.length ? "\n⚠ " + res.warnings.join("\n⚠ ") : ""), "ok");
    loadList();
  } catch (e) {
    setStatus("保存失败：" + e.message, "err");
  }
}

async function validateCard() {
  if (!currentSlug) return;
  let card;
  try {
    card = JSON.parse($("#editor-json").value);
  } catch (e) {
    return setStatus("JSON 解析失败：" + e.message, "err");
  }
  try {
    const res = await api.send(`/api/cards/${currentSlug}`, { method: "PUT", body: JSON.stringify(card) });
    setStatus("✓ 校验通过" + (res.warnings?.length ? "\n⚠ " + res.warnings.join("\n⚠ ") : ""), "ok");
  } catch (e) {
    setStatus("✗ 校验失败：" + e.message, "err");
  }
}

async function deleteCard() {
  if (!currentSlug) return;
  if (!confirm(`确定删除 ${currentSlug}？不可恢复。`)) return;
  await api.send(`/api/cards/${currentSlug}`, { method: "DELETE" });
  currentSlug = null;
  $("#editor-title").firstChild.textContent = "选择左侧卡片开始编辑 ";
  $("#editor-json").value = "";
  setStatus("已删除");
  loadList();
}

async function compileCard() {
  if (!currentSlug) return;
  try {
    await saveCard();
    const res = await api.send(`/api/cards/${currentSlug}/compile`, { method: "POST" });
    setStatus("✓ 已编译到 workspace，共 " + res.files.length + " 个文件", "ok");
    loadActivePersona();
    refreshHomeStatus();
  } catch (e) {
    setStatus("编译失败：" + e.message, "err");
  }
}

async function loadActivePersona() {
  try {
    const r = await api.get("/api/active-persona");
    const el = $("#active-persona");
    if (r.active) {
      el.textContent = "⚡ 当前生效人设：" + r.active;
      el.style.display = "inline-block";
    } else {
      el.style.display = "none";
    }
  } catch { /* 忽略 */ }
}

// ---- 聊天测试 ----
function addChatBubble(role, text) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "bot");
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text.replace(/[`*#_]/g, ""));
    u.lang = "zh-CN";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* 忽略 */ }
}

function gatherChatOptions() {
  const tools = [];
  if ($("#tool-code").checked) tools.push("code_exec");
  if ($("#tool-file").checked) tools.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
  if ($("#tool-search").checked) tools.push("web_search");
  if ($("#tool-weather").checked) tools.push("weather");
  if ($("#tool-time").checked) tools.push("datetime");
  if ($("#tool-memory").checked) tools.push("memory_save");
  const skills = [];
  if ($("#skill-code").checked) skills.push("code_expert");
  if ($("#skill-trans").checked) skills.push("translator");
  if ($("#skill-write").checked) skills.push("writing");
  if ($("#skill-companion").checked) skills.push("companion");
  return { tools, useMCP: $("#tool-mcp").checked, skills, thinking: $("#chat-thinking").value };
}

function toggleWorkMode() {
  workMode = !workMode;
  const btn = $("#btn-work-mode");
  btn.textContent = workMode ? "💬 返回聊天模式" : "🔧 进入工作模式";
  btn.classList.toggle("active", workMode);
  $(".chat-opts").style.display = workMode ? "flex" : "none";
  $("#chat-head-hint").textContent = workMode ? "工作模式：开放全部功能" : "普通聊天：纯人设对话";
}

async function sendChat() {
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  if (!currentSlug) { addChatBubble("bot", "请先选择一张人设卡。"); return; }
  addChatBubble("user", message);
  input.value = "";
  chatHistory.push({ role: "user", content: message });
  const btn = $("#btn-chat-send");
  btn.disabled = true;
  const opts = workMode ? gatherChatOptions() : { tools: [], useMCP: false, skills: [], thinking: "auto" };
  try {
    const r = await api.send("/api/chat", {
      method: "POST",
      body: JSON.stringify({ slug: currentSlug, message, history: chatHistory.slice(0, -1), ...opts }),
    });
    await finishTurn(r);
  } catch (e) {
    chatHistory.pop();
    addChatBubble("bot", "⚠ " + e.message);
  }
  btn.disabled = false;
}

async function finishTurn(r) {
  if (r.type === "reply") {
    addChatBubble("bot", r.reply);
    chatHistory.push({ role: "assistant", content: r.reply });
    if ($("#chat-voice-reply")?.checked) speak(r.reply);
  } else if (r.type === "pending") {
    const bubble = addChatBubble("bot", "🛡️ 需要你确认：机器人想调用\n" + r.pending.map((p) => "· " + p.name).join("\n"));
    const row = document.createElement("div");
    row.className = "approve-row";
    const btnOk = document.createElement("button");
    btnOk.className = "small-btn primary";
    btnOk.textContent = "✅ 执行";
    const btnNo = document.createElement("button");
    btnNo.className = "small-btn danger";
    btnNo.textContent = "🚫 拒绝";
    pendingData = { slug: currentSlug, messages: r.messages, tools: gatherChatOptions().tools, useMCP: $("#tool-mcp").checked, approve: false };
    btnOk.addEventListener("click", async () => { row.remove(); pendingData.approve = true; await sendApprove(); });
    btnNo.addEventListener("click", async () => { row.remove(); pendingData.approve = false; await sendApprove(); });
    row.append(btnOk, btnNo);
    bubble.parentNode.appendChild(row);
  }
}

async function sendApprove() {
  const btn = $("#btn-chat-send");
  btn.disabled = true;
  try {
    const r = await api.send("/api/chat/approve", { method: "POST", body: JSON.stringify(pendingData) });
    pendingData = null;
    await finishTurn(r);
  } catch (e) {
    addChatBubble("bot", "⚠ " + e.message);
  }
  btn.disabled = false;
}

function clearChat() {
  chatHistory = [];
  pendingData = null;
  $("#chat-log").innerHTML = "";
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("当前浏览器不支持语音输入，请用 Chrome 或 Edge"); return; }
  const rec = new SR();
  rec.lang = "zh-CN";
  rec.onresult = (e) => { $("#chat-input").value = e.results[0][0].transcript; };
  rec.onerror = () => {};
  rec.start();
}

// ---- 做卡向导 ----
function wizardBookRow(entry, fixed) {
  const row = document.createElement("div");
  row.className = "wz-row";
  const key = document.createElement("input");
  key.placeholder = "关键词";
  key.value = entry?.keys?.[0] ?? "";
  key.disabled = !!fixed;
  const content = document.createElement("textarea");
  content.rows = 1;
  content.placeholder = "内容（触发时注入）";
  content.value = entry?.content ?? "";
  const del = document.createElement("button");
  del.className = "small-btn danger";
  del.textContent = "✕";
  del.addEventListener("click", () => row.remove());
  row.append(key, content, del);
  return { row, key, content };
}

function wizardRegexRow(script) {
  const row = document.createElement("div");
  row.className = "wz-row";
  const name = document.createElement("input");
  name.placeholder = "名称"; name.value = script?.scriptName ?? "";
  const re = document.createElement("input");
  re.placeholder = "匹配（正则）"; re.value = script?.findRegex ?? "";
  const rep = document.createElement("input");
  rep.placeholder = "替换为"; rep.value = script?.replaceString ?? "";
  const del = document.createElement("button");
  del.className = "small-btn danger";
  del.textContent = "✕";
  del.addEventListener("click", () => row.remove());
  row.append(name, re, rep, del);
  return { row, name, re, rep };
}

function openWizard() {
  const st = currentCardSt || { description: "", first_mes: "", regex_scripts: [], character_book: { entries: [{ keys: ["人物形象"], content: "（请填写外貌、穿着、气质等形象描述）", constant: true }] } };
  $("#wz-desc").value = st.description ?? "";
  $("#wz-first").value = st.first_mes ?? "";
  const book = $("#wz-book");
  book.innerHTML = "";
  const entries = st.character_book?.entries?.length ? st.character_book.entries : [{ keys: ["人物形象"], content: "" }];
  entries.forEach((e, i) => book.appendChild(wizardBookRow(e, i === 0).row));
  const rx = $("#wz-regex");
  rx.innerHTML = "";
  (st.regex_scripts ?? []).forEach((s) => rx.appendChild(wizardRegexRow(s).row));
  $("#card-wizard").style.display = "block";
}

function closeWizard() { $("#card-wizard").style.display = "none"; }

function applyWizard() {
  if (!currentSlug) { setStatus("请先选择一张卡片", "err"); return; }
  let card;
  try {
    card = JSON.parse($("#editor-json").value);
  } catch (e) {
    return setStatus("当前 JSON 解析失败：" + e.message, "err");
  }
  card.sillytavern_v2 = card.sillytavern_v2 || {};
  card.sillytavern_v2.description = $("#wz-desc").value.trim() || card.identity?.bio || "";
  card.sillytavern_v2.first_mes = $("#wz-first").value.trim();
  card.sillytavern_v2.character_book = { entries: [...$("#wz-book").querySelectorAll(".wz-row")].map((r) => {
    const [k, c] = r.querySelectorAll("input, textarea");
    return { keys: [k.value.trim()].filter(Boolean), content: c.value, enabled: true };
  }).filter((e) => e.keys.length && e.content) };
  card.sillytavern_v2.regex_scripts = [...$("#wz-regex").querySelectorAll(".wz-row")].map((r) => {
    const [n, re, rep] = r.querySelectorAll("input");
    return { scriptName: n.value, findRegex: re.value, replaceString: rep.value, enabled: true };
  }).filter((s) => s.findRegex);
  const finish = () => {
    $("#editor-json").value = JSON.stringify(card, null, 2);
    dirty = true;
    setStatus("✓ 已应用到卡片，点「保存」生效", "ok");
  };
  const avatarFile = $("#wz-avatar").files[0];
  if (avatarFile) {
    fileToBase64(avatarFile).then((b64) => {
      card.identity = card.identity || {};
      card.identity.avatar = "data:image/png;base64," + b64;
      finish();
    });
  } else finish();
}

// ---- 导出 / 导入 ----
async function exportCard(format) {
  if (!currentSlug) { setStatus("请先选择一张卡片", "err"); return; }
  try {
    const r = await api.send(`/api/cards/${currentSlug}/export`, { method: "POST", body: JSON.stringify({ format }) });
    downloadDataUrl(r.dataUrl, r.filename);
    setStatus(`✓ 已导出 ${r.filename}（CCv2 角色卡）`, "ok");
  } catch (e) {
    setStatus("导出失败：" + e.message, "err");
  }
}

async function importCard() {
  const f = $("#import-file").files[0];
  if (!f) return;
  try {
    const b64 = await fileToBase64(f);
    const r = await api.send("/api/cards/import-card", { method: "POST", body: JSON.stringify({ fileBase64: b64, fileName: f.name }) });
    $("#import-file").value = "";
    setStatus(`✓ 已导入：${r.card.name}`, "ok");
    await loadList();
    await openCard(r.card.slug);
  } catch (e) {
    setStatus("导入失败：" + e.message, "err");
  }
}

// ============================================================
//  视图：蒸馏工厂
// ============================================================
function renderDistill() {
  return `
  <div class="view">
    <div class="api-layout">
      <div class="channel-card">
        <h2>🧪 聊天记录蒸馏（数字分身）</h2>
        <p class="hint">导入微信聊天记录 → 自动脱敏 → 四维蒸馏（互动/人格/记忆）→ 生成人设卡。调用「API 与模型」页配置的模型。</p>
        <div class="form">
          <label>聊天记录文件（WeFlow 导出的 JSON）</label>
          <input id="distill-file" type="file" accept=".json" />
          <div class="note" style="margin-top:0">📥 没有记录？下载 <a href="https://github.com/hicccc77/WeFlow" target="_blank">WeFlow</a> 导出 JSON，或直接粘贴下面文本。</div>
          <label>或直接粘贴聊天文本（每行：<code>昵称: 内容</code>）</label>
          <textarea id="distill-paste" rows="4" placeholder="奶奶: 多喝水，别又熬夜&#10;我: 知道了奶奶"></textarea>
          <label>卡片名称</label>
          <input id="distill-name" placeholder="如：奶奶" />
          <label>关系类型</label>
          <select id="distill-role">
            <option value="friend">朋友</option><option value="family">家人</option>
            <option value="self">自己</option><option value="partner">前任/恋人</option>
            <option value="colleague">同事</option><option value="public-figure">偶像/角色</option>
          </select>
          <label>目标人物昵称（留空自动取最活跃的对方）</label>
          <input id="distill-target" placeholder="如：奶奶" />
          <label>我方昵称（逗号分隔）</label>
          <input id="distill-self" placeholder="如：我,本人" />
          <label>屏蔽词（逗号分隔，命中整条剔除）</label>
          <input id="distill-blocked" placeholder="如：工资,某敏感词" />
          <div class="row">
            <button id="btn-distill-run" class="primary">开始蒸馏</button>
          </div>
          <div id="distill-msg" class="status"></div>
        </div>
        <hr style="border-color:var(--border)" />
        <h3>🔌 直连 WeFlow（本机 5031）</h3>
        <p class="hint">WeFlow 运行时免导出直接拉取：填 access_token → 探测 → 填 talker → 导入并蒸馏。</p>
        <div class="row">
          <input id="wf-token" placeholder="WeFlow access_token" />
          <button id="btn-wf-probe" class="small-btn">探测</button>
        </div>
        <div class="row">
          <input id="wf-talker" placeholder="talker（如 xxx@chatroom）" />
          <input id="wf-limit" type="number" value="500" style="max-width:80px" />
          <button id="btn-wf-distill" class="primary">导入并蒸馏</button>
        </div>
        <pre id="wf-out" class="small-out"></pre>
      </div>
      <div class="channel-card">
        <h2>蒸馏结果</h2>
        <div class="editor-actions" style="margin-bottom:8px">
          <button id="btn-distill-save" class="primary">保存到卡库</button>
          <button id="btn-distill-export-png">导出 PNG</button>
          <button id="btn-distill-export-json">导出 JSON</button>
        </div>
        <pre id="distill-result" class="small-out tall">（结果会显示在这里）</pre>
      </div>
    </div>
  </div>`;
}

function initDistill() {
  $("#btn-distill-run").addEventListener("click", runDistill);
  $("#btn-distill-save").addEventListener("click", saveDistilled);
  $("#btn-distill-export-png").addEventListener("click", () => exportDistillCard("png"));
  $("#btn-distill-export-json").addEventListener("click", () => exportDistillCard("json"));
  $("#btn-wf-probe").addEventListener("click", probeWeFlow);
  $("#btn-wf-distill").addEventListener("click", distillFromWeFlow);
  loadDistillModel();
}

async function loadDistillModel() {
  try {
    const cfg = await api.get("/api/config/model");
    const el = $("#distill-model");
    if (el) el.textContent = cfg.primary || "（未设置，先到 API 页配置）";
  } catch { /* 忽略 */ }
}

async function runDistill() {
  const file = $("#distill-file").files[0];
  const paste = $("#distill-paste").value.trim();
  if (!file && !paste) { $("#distill-msg").textContent = "请选择文件或粘贴文本"; return; }
  const name = $("#distill-name").value.trim();
  if (!name) { $("#distill-msg").textContent = "请填写卡片名称"; return; }
  const text = file ? await file.text() : paste;
  $("#distill-msg").textContent = "蒸馏中…（调用模型 3 次，需要一点时间）";
  $("#btn-distill-run").disabled = true;
  try {
    const r = await api.send("/api/distill", {
      method: "POST",
      body: JSON.stringify({
        fileContent: text,
        fileName: file?.name || "paste.txt",
        name,
        role: $("#distill-role").value,
        target: $("#distill-target").value.trim() || undefined,
        selfNames: $("#distill-self").value.split(",").map((s) => s.trim()).filter(Boolean),
        blockedWords: $("#distill-blocked").value.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    lastDistilledCard = r.card;
    const lines = [
      `✓ 蒸馏完成：${r.card.name} (${r.card.slug})`,
      `目标人物：${r.card.identity.relation ?? "—"}`,
      `消息：共 ${r.stats.totalMessages} 条 → 目标 ${r.stats.usedMessages} 条`,
      `脱敏替换：${r.stats.redact.replaced} 处`,
      "",
    ];
    for (const [dim, s] of Object.entries(r.stats.dimensions)) lines.push(`${dim}: ${s.items} 条（${s.via}）`);
    lines.push("", "人格（traits）:", ...(r.card.personality.traits ?? []).map((t) => "  - " + t));
    lines.push("", "⚠ 发布前请在卡里把 source.consent.granted 改为 true");
    $("#distill-result").textContent = lines.join("\n");
    $("#distill-msg").textContent = "完成。可保存到卡库或直接导出 PNG。";
    $("#distill-msg").className = "status ok";
  } catch (e) {
    $("#distill-msg").textContent = "蒸馏失败：" + e.message;
    $("#distill-msg").className = "status err";
  }
  $("#btn-distill-run").disabled = false;
}

async function saveDistilled() {
  if (!lastDistilledCard) { $("#distill-msg").textContent = "还没有蒸馏结果"; return; }
  try {
    await api.send("/api/cards/import", { method: "POST", body: JSON.stringify({ card: lastDistilledCard }) });
    $("#distill-msg").textContent = "✓ 已保存到卡库，去「人设卡库」编辑";
    $("#distill-msg").className = "status ok";
    lastDistilledCard = null;
  } catch (e) {
    $("#distill-msg").textContent = "保存失败：" + e.message;
    $("#distill-msg").className = "status err";
  }
}

async function exportDistillCard(format) {
  if (!lastDistilledCard) { $("#distill-msg").textContent = "还没有蒸馏结果"; return; }
  try {
    const r = await api.send("/api/cards/export-card", { method: "POST", body: JSON.stringify({ card: lastDistilledCard, format }) });
    downloadDataUrl(r.dataUrl, r.filename);
    $("#distill-msg").textContent = "✓ 已导出 " + r.filename;
    $("#distill-msg").className = "status ok";
  } catch (e) {
    $("#distill-msg").textContent = "导出失败：" + e.message;
    $("#distill-msg").className = "status err";
  }
}

async function probeWeFlow() {
  const token = $("#wf-token").value.trim();
  if (!token) { $("#wf-out").textContent = "请先填 access_token"; return; }
  $("#wf-out").textContent = "探测中…";
  try {
    const r = await api.send("/api/weflow/probe", { method: "POST", body: JSON.stringify({ token }) });
    $("#wf-out").textContent = r.results.map((x) => `${x.path} → HTTP ${x.status}${x.hint ? " " + x.hint : ""}`).join("\n");
  } catch (e) {
    $("#wf-out").textContent = "探测失败：" + e.message;
  }
}

async function distillFromWeFlow() {
  const token = $("#wf-token").value.trim();
  const talker = $("#wf-talker").value.trim();
  const name = $("#distill-name").value.trim();
  if (!token || !talker || !name) { $("#wf-out").textContent = "请填 token / talker / 卡片名称"; return; }
  $("#wf-out").textContent = "从 WeFlow 拉取并蒸馏中…";
  $("#btn-wf-distill").disabled = true;
  try {
    const r = await api.send("/api/distill/weflow", {
      method: "POST",
      body: JSON.stringify({
        token, talker, limit: Number($("#wf-limit").value) || 500,
        name, role: $("#distill-role").value,
        target: $("#distill-target").value.trim() || undefined,
        selfNames: $("#distill-self").value.split(",").map((s) => s.trim()).filter(Boolean),
        blockedWords: $("#distill-blocked").value.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    lastDistilledCard = r.card;
    $("#wf-out").textContent = `✓ 蒸馏完成：${r.card.name}（${r.card.slug}）\n消息 ${r.stats.totalMessages} 条 → 目标 ${r.stats.usedMessages} 条`;
    $("#distill-msg").textContent = "完成（WeFlow 导入），可保存或导出";
    $("#distill-msg").className = "status ok";
  } catch (e) {
    $("#wf-out").textContent = "失败：" + e.message;
  }
  $("#btn-wf-distill").disabled = false;
}

// ============================================================
//  视图：通道连接
// ============================================================
function renderChannels() {
  return `
  <div class="view">
    <div class="channel-grid">
      <div class="channel-card">
        <h2>💬 微信 <span id="wx-status" class="chip">检测中…</span></h2>
        <p class="hint">腾讯官方通道（openclaw-weixin），当前仅支持单聊；需微信有 ClawBot 入口（灰度）。</p>
        <div class="channel-actions">
          <button id="btn-wx-login">开始扫码绑定</button>
          <button id="btn-wx-refresh">刷新状态</button>
        </div>
        <pre id="wx-qr" class="qr-box" style="display:none"></pre>
        <div id="wx-login-msg" class="status"></div>
        <hr />
        <h3>新好友配对授权</h3>
        <div class="row">
          <input id="pairing-code" placeholder="配对码" />
          <button id="btn-pair-approve">批准</button>
        </div>
        <pre id="pairing-list" class="small-out"></pre>
        <div class="note">⚠️ 微信里没有 ClawBot 入口 = 账号在灰度外，扫码会失败，这是微信侧限制。</div>
      </div>
      <div class="channel-card">
        <h2>🐧 QQ <span id="qq-status" class="chip">检测中…</span></h2>
        <p class="hint">官方 QQ 开放平台机器人（腾讯官方插件）。支持单聊 / 群聊@ / 频道 / 富媒体。</p>
        <div class="channel-actions">
          <button id="btn-qq-login">开始扫码绑定</button>
          <button id="btn-qq-refresh">刷新状态</button>
        </div>
        <pre id="qq-qr" class="qr-box" style="display:none"></pre>
        <div id="qq-login-msg" class="status"></div>
        <div class="guide">
          <ol>
            <li><b>创建机器人</b>：<a href="https://q.qq.com/" target="_blank">QQ 开放平台</a> 扫码登录 → 点「创建机器人」</li>
            <li><b>扫码绑定</b>：点上方「开始扫码绑定」，手机 QQ 扫网页二维码</li>
            <li><b>开始对话</b>：QQ 消息列表找到机器人发消息（未配置完成前回「已去火星」）</li>
          </ol>
        </div>
        <pre id="qq-out" class="small-out"></pre>
        <div class="note">官方机器人是「消息列表里的机器人」；想用自己的 QQ 号（NapCat 方案）暂未就绪。</div>
      </div>
    </div>
  </div>`;
}

function initChannels() {
  $("#btn-wx-login").addEventListener("click", () => startLogin("/api/channels/wechat/login", "#wx-qr", "#wx-login-msg", () => { refreshWechat(); refreshPairing(); }));
  $("#btn-wx-refresh").addEventListener("click", refreshWechat);
  $("#btn-pair-approve").addEventListener("click", approvePairing);
  $("#btn-qq-login").addEventListener("click", () => startLogin("/api/channels/qq/login", "#qq-qr", "#qq-login-msg", refreshQQ));
  $("#btn-qq-refresh").addEventListener("click", refreshQQ);
  refreshWechat();
  refreshPairing();
  refreshQQ();
}

const loginTimers = {};
async function startLogin(channelPath, qrSel, msgSel, refreshCb) {
  try {
    await api.send(channelPath, { method: "POST" });
    $(qrSel).style.display = "block";
    $(msgSel).textContent = "二维码生成中…";
    if (loginTimers[channelPath]) clearInterval(loginTimers[channelPath]);
    loginTimers[channelPath] = setInterval(async () => {
      try {
        const s = await api.get(channelPath);
        if (s.output) {
          $(qrSel).textContent = s.output;
          $(qrSel).style.display = "block";
        }
        if (!s.running && s.done) {
          clearInterval(loginTimers[channelPath]);
          loginTimers[channelPath] = null;
          $(msgSel).textContent = s.ok ? "✓ 扫码成功，已绑定！" : "✗ 登录结束（未成功），检查平台侧配置后重试";
          refreshCb && refreshCb();
        }
      } catch { /* 忽略 */ }
    }, 2000);
  } catch (e) {
    $(msgSel).textContent = "启动失败：" + e.message;
  }
}

async function refreshWechat() {
  try {
    const s = await api.get("/api/channels/wechat/status");
    setChip($("#wx-status"), s.connected ? "已连接 ✓" : "未连接", s.connected);
    if (!s.connected && s.raw) $("#pairing-list").textContent = s.raw.slice(-800);
    refreshTopStatus();
  } catch { setChip($("#wx-status"), "检测失败", false); }
}

async function refreshPairing() {
  try {
    const r = await api.get("/api/channels/wechat/pairing");
    $("#pairing-list").textContent = r.raw || "（暂无待处理配对）";
  } catch (e) {
    $("#pairing-list").textContent = "读取失败：" + e.message;
  }
}

async function approvePairing() {
  const code = $("#pairing-code").value.trim();
  if (!code) return;
  try {
    const r = await api.send("/api/channels/wechat/pairing/approve", { method: "POST", body: JSON.stringify({ code }) });
    $("#pairing-list").textContent = r.output || (r.ok ? "✓ 已批准" : "批准失败");
    $("#pairing-code").value = "";
    refreshPairing();
  } catch (e) {
    $("#pairing-list").textContent = "批准失败：" + e.message;
  }
}

async function refreshQQ() {
  try {
    const s = await api.get("/api/channels/qq/status");
    const parts = [s.pluginInstalled ? "插件✓" : "插件✗", s.napcatRunning ? "NapCat✓" : "NapCat✗", s.onebotSeen ? "连接✓" : "连接✗"];
    setChip("#qq-status", parts.join(" "), s.pluginInstalled && s.onebotSeen);
    if (!s.pluginInstalled) $("#qq-out").textContent = "官方 QQ Bot 插件未安装，先装插件再绑定。";
    refreshTopStatus();
  } catch { setChip("#qq-status", "检测失败", false); }
}

// ============================================================
//  视图：API 与模型
// ============================================================
function renderApi() {
  return `
  <div class="view">
    <div class="api-layout">
      <div class="channel-card">
        <h2>⚡ 当前模型配置</h2>
        <p class="hint">默认模型 <code id="cur-primary">—</code>（保存后需重启网关生效，可用桌面开关）</p>
        <div id="provider-list" class="provider-list"></div>
      </div>
      <div class="channel-card">
        <h2>添加 / 修改提供商</h2>
        <div class="form">
          <label>名称（如 agnes / myrelay）</label>
          <input id="cfg-name" placeholder="agnes" />
          <label>Base URL（OpenAI 兼容，以 /v1 结尾）</label>
          <input id="cfg-baseurl" placeholder="https://apihub.agnes-ai.cn/v1" />
          <label>API Key（留空保留原值）</label>
          <input id="cfg-key" type="password" placeholder="sk-..." />
          <label>模型 ID</label>
          <input id="cfg-model" placeholder="agnes-2.0-flash" />
          <label class="checkbox"><input id="cfg-default" type="checkbox" checked /> 设为默认模型</label>
          <div class="row">
            <button id="btn-model-test">测试连接</button>
            <button id="btn-model-save" class="primary">保存</button>
          </div>
          <div id="model-msg" class="status"></div>
        </div>
      </div>
    </div>
  </div>`;
}

function initApi() {
  $("#btn-model-test").addEventListener("click", testModel);
  $("#btn-model-save").addEventListener("click", saveModel);
  loadModelConfig();
}

async function loadModelConfig() {
  try {
    const cfg = await api.get("/api/config/model");
    $("#cur-primary").textContent = cfg.primary || "（未设置）";
    const box = $("#provider-list");
    box.innerHTML = "";
    if (!cfg.providers.length) {
      box.innerHTML = '<div class="muted">还没有配置提供商</div>';
      return;
    }
    for (const p of cfg.providers) {
      const d = document.createElement("div");
      d.className = "provider-item" + (cfg.primary.startsWith(p.name + "/") ? " active" : "");
      d.innerHTML = `<div><b>${escapeHtml(p.name)}</b> ${cfg.primary.startsWith(p.name + "/") ? "· 默认" : ""}</div>
        <div class="meta">${escapeHtml(p.baseUrl)} · ${escapeHtml(p.models.join(", "))}</div>
        <div class="meta">key: ${escapeHtml(p.apiKey)}</div>`;
      box.appendChild(d);
    }
  } catch (e) {
    $("#provider-list").innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

async function testModel() {
  const baseUrl = $("#cfg-baseurl").value.trim();
  const apiKey = $("#cfg-key").value.trim();
  const modelId = $("#cfg-model").value.trim();
  if (!baseUrl || !apiKey || !modelId) { $("#model-msg").textContent = "请先填 Base URL / Key / 模型 ID"; return; }
  $("#model-msg").textContent = "测试中…";
  try {
    const r = await api.send("/api/config/model/test", { method: "POST", body: JSON.stringify({ baseUrl, apiKey, modelId }) });
    $("#model-msg").textContent = r.ok ? "✓ 连接成功" : `✗ 失败（HTTP ${r.status ?? "-"}）：${r.error ?? ""}`;
    $("#model-msg").className = "status " + (r.ok ? "ok" : "err");
  } catch (e) {
    $("#model-msg").textContent = "测试出错：" + e.message;
  }
}

async function saveModel() {
  try {
    const r = await api.send("/api/config/model", {
      method: "POST",
      body: JSON.stringify({
        name: $("#cfg-name").value.trim(),
        baseUrl: $("#cfg-baseurl").value.trim(),
        apiKey: $("#cfg-key").value.trim() || undefined,
        modelId: $("#cfg-model").value.trim(),
        setDefault: $("#cfg-default").checked,
      }),
    });
    $("#model-msg").textContent = "✓ " + (r.hint || "已保存");
    $("#model-msg").className = "status ok";
    $("#cfg-key").value = "";
    loadModelConfig();
    refreshTopStatus();
  } catch (e) {
    $("#model-msg").textContent = "保存失败：" + e.message;
    $("#model-msg").className = "status err";
  }
}

// ============================================================
//  视图：能力中心（工具/技能/深度/语音 默认 + MCP）
// ============================================================
function renderCapabilities() {
  return `
  <div class="view">
    <div class="api-layout">
      <div class="channel-card">
        <h2>🛠 默认能力</h2>
        <p class="hint">设置聊天测试工作模式的默认开关；测试时可临时改，这里存的是默认值。</p>
        <div class="form">
          <label>工具（默认）</label>
          <div class="cap-checks">
            <label><input type="checkbox" id="cap-code" /> 写代码*</label>
            <label><input type="checkbox" id="cap-file" /> 沙箱文件</label>
            <label><input type="checkbox" id="cap-search" /> 搜索</label>
            <label><input type="checkbox" id="cap-weather" /> 天气</label>
            <label><input type="checkbox" id="cap-time" /> 时间</label>
            <label><input type="checkbox" id="cap-memory" /> 记忆</label>
          </div>
          <label>技能（默认）</label>
          <div class="cap-checks">
            <label><input type="checkbox" id="cap-skill-code" /> 代码专家</label>
            <label><input type="checkbox" id="cap-skill-trans" /> 翻译</label>
            <label><input type="checkbox" id="cap-skill-write" /> 写作</label>
            <label><input type="checkbox" id="cap-skill-companion" /> 陪伴</label>
          </div>
          <label>思考深度（默认）</label>
          <select id="cap-thinking">
            <option value="off">关闭</option><option value="auto" selected>自动（默认）</option>
            <option value="low">低</option><option value="medium">中</option>
            <option value="high">高</option><option value="extreme">极高</option>
          </select>
          <label class="checkbox"><input type="checkbox" id="cap-voice" /> 读回复（语音）</label>
          <div class="row">
            <button id="btn-cap-save" class="primary">保存默认</button>
          </div>
          <div id="cap-msg" class="status"></div>
        </div>
      </div>
      <div class="channel-card">
        <h2>🔌 MCP 服务器</h2>
        <p class="hint">JSON 数组，每项 <code>{"name":"服务名","command":"命令","args":[]}</code>。保存后工作模式勾选「MCP」即可用（工具默认需审批）。</p>
        <textarea id="mcp-config" rows="6" spellcheck="false"></textarea>
        <div class="row" style="margin-top:8px">
          <button id="btn-mcp-save" class="primary">保存并重连</button>
        </div>
        <div id="mcp-msg" class="status"></div>
      </div>
    </div>
  </div>`;
}

function initCapabilities() {
  const def = capDefaults();
  const tools = def.tools ?? [];
  $("#cap-code").checked = tools.includes("code_exec");
  $("#cap-file").checked = tools.includes("sandbox_list");
  $("#cap-search").checked = tools.includes("web_search");
  $("#cap-weather").checked = tools.includes("weather");
  $("#cap-time").checked = tools.includes("datetime");
  $("#cap-memory").checked = tools.includes("memory_save");
  const skills = def.skills ?? [];
  $("#cap-skill-code").checked = skills.includes("code_expert");
  $("#cap-skill-trans").checked = skills.includes("translator");
  $("#cap-skill-write").checked = skills.includes("writing");
  $("#cap-skill-companion").checked = skills.includes("companion");
  $("#cap-thinking").value = def.thinking ?? "auto";
  $("#cap-voice").checked = !!def.voiceReply;
  $("#btn-cap-save").addEventListener("click", () => {
    const toolsArr = [];
    if ($("#cap-code").checked) toolsArr.push("code_exec");
    if ($("#cap-file").checked) toolsArr.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
    if ($("#cap-search").checked) toolsArr.push("web_search");
    if ($("#cap-weather").checked) toolsArr.push("weather");
    if ($("#cap-time").checked) toolsArr.push("datetime");
    if ($("#cap-memory").checked) toolsArr.push("memory_save");
    const skillsArr = [];
    if ($("#cap-skill-code").checked) skillsArr.push("code_expert");
    if ($("#cap-skill-trans").checked) skillsArr.push("translator");
    if ($("#cap-skill-write").checked) skillsArr.push("writing");
    if ($("#cap-skill-companion").checked) skillsArr.push("companion");
    saveCapDefaults({ tools: toolsArr, skills: skillsArr, thinking: $("#cap-thinking").value, voiceReply: $("#cap-voice").checked });
    $("#cap-msg").textContent = "✓ 已保存默认能力";
    $("#cap-msg").className = "status ok";
  });
  $("#btn-mcp-save").addEventListener("click", saveMCP);
  loadMCPConfig();
}

async function loadMCPConfig() {
  try {
    const cfg = await api.get("/api/mcp/config");
    $("#mcp-config").value = JSON.stringify(cfg.servers, null, 2);
  } catch (e) {
    $("#mcp-msg").textContent = "读取失败：" + e.message;
  }
}

async function saveMCP() {
  try {
    const servers = JSON.parse($("#mcp-config").value);
    const r = await api.send("/api/mcp/config", { method: "POST", body: JSON.stringify({ servers }) });
    $("#mcp-msg").textContent = "✓ 已保存并重连，" + r.servers + " 个服务器";
    $("#mcp-msg").className = "status ok";
  } catch (e) {
    $("#mcp-msg").textContent = "保存失败：" + e.message;
    $("#mcp-msg").className = "status err";
  }
}

// ============================================================
//  视图：数据
// ============================================================
function renderData() {
  return `
  <div class="view">
    <div class="api-layout">
      <div class="channel-card">
        <h2>📦 备份</h2>
        <p class="hint">把全部人设卡、长期记忆、MCP 配置打包成一个 JSON 下载，可随时导入恢复。</p>
        <div class="row">
          <button id="btn-backup" class="primary">📦 下载备份</button>
        </div>
        <div id="backup-msg" class="status"></div>
      </div>
      <div class="channel-card">
        <h2>🧠 长期记忆</h2>
        <p class="hint">各人设卡记住的用户事实（data/memory）。</p>
        <div id="memory-list" class="small-out tall"></div>
        <div class="row" style="margin-top:8px">
          <button id="btn-memory-clear" class="danger small-btn">清空全部记忆</button>
        </div>
      </div>
    </div>
  </div>`;
}

function initData() {
  $("#btn-backup").addEventListener("click", async () => {
    try {
      const r = await api.get("/api/backup");
      downloadDataUrl(r.dataUrl, r.filename);
      $("#backup-msg").textContent = "✓ 备份已下载：" + r.filename;
      $("#backup-msg").className = "status ok";
    } catch (e) {
      $("#backup-msg").textContent = "备份失败：" + e.message;
      $("#backup-msg").className = "status err";
    }
  });
  $("#btn-memory-clear").addEventListener("click", async () => {
    if (!confirm("确定清空全部长期记忆？")) return;
    try {
      await api.send("/api/memory/clear", { method: "POST" });
      loadMemory();
    } catch (e) {
      $("#memory-list").textContent = "清空失败：" + e.message;
    }
  });
  loadMemory();
}

async function loadMemory() {
  try {
    const r = await api.get("/api/memory");
    const el = $("#memory-list");
    if (!r.memory || !Object.keys(r.memory).length) {
      el.textContent = "（还没有记忆）";
      return;
    }
    el.textContent = Object.entries(r.memory)
      .map(([f, lines]) => `📄 ${f}\n  ` + (lines || []).join("\n  "))
      .join("\n\n");
  } catch (e) {
    $("#memory-list").textContent = "读取失败：" + e.message;
  }
}

// ============================================================
//  视图：设置
// ============================================================
function renderSettings() {
  return `
  <div class="view">
    <div class="api-layout">
      <div class="channel-card">
        <h2>⚙ 服务信息</h2>
        <div id="svc-info" class="small-out">读取中…</div>
      </div>
      <div class="channel-card">
        <h2>ℹ️ 说明</h2>
        <ul class="guide">
          <li>管理台地址：<code>http://127.0.0.1:17880</code>；公网：<code>https://openclaw.319274.xyz</code></li>
          <li>开机自启 / 桌面开关：<code>桌面/openclaw-shell 开关.bat</code></li>
          <li>数据全部保存在本机 <code>data/</code>，不上传</li>
          <li>模型与通道的绑定验证：扫码需要手机操作，见「通道连接」页</li>
        </ul>
      </div>
    </div>
  </div>`;
}

function initSettings() {
  (async () => {
    try {
      const h = await api.get("/api/health");
      $("#svc-info").textContent =
        `服务：openclaw-shell\n版本：${h.schema}\n数据目录：${h.dataDir ?? "—"}\n监听：${h.port ? "127.0.0.1:" + h.port : "—"}`;
    } catch (e) {
      $("#svc-info").textContent = "无法连接服务：" + e.message;
    }
  })();
}

// ============================================================
//  路由表 + 启动
// ============================================================
const routes = {
  home: { render: renderHome, init: initHome },
  cards: { render: renderCards, init: initCards },
  distill: { render: renderDistill, init: initDistill },
  channels: { render: renderChannels, init: initChannels },
  api: { render: renderApi, init: initApi },
  capabilities: { render: renderCapabilities, init: initCapabilities },
  data: { render: renderData, init: initData },
  settings: { render: renderSettings, init: initSettings },
};

$("#btn-menu").addEventListener("click", openDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);
document.querySelectorAll(".drawer-nav a, .bottom-nav a").forEach((a) =>
  a.addEventListener("click", closeDrawer)
);

router();
refreshTopStatus();
