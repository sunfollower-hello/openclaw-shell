// openclaw-shell 前端 v3：白色主题 · 抽屉导航 · 表单化卡片 · 多提供商 · 每卡模型/记忆
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ================= 基础 =================
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
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function toast(msg, ok = true) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = "toast show " + (ok ? "ok" : "err");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

const DEFAULTS_KEY = "ocs_cap_defaults";
function capDefaults() {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}"); } catch { return {}; }
}
function saveCapDefaults(d) { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); }

// ================= 全局状态 =================
let editingCard = null;
let chatHistory = [];
let pendingData = null;
let workMode = false;
let lastDistilledCard = null;
let providersCache = null;

function blankCard(name, slug, role) {
  return {
    schema: "persona-card/1",
    name,
    slug,
    identity: { role: role || "friend", relation: name, bio: "", tags: [], avatar: "" },
    voice: { tone_rules: [], catchphrases: [], message_style: { length: "medium", multi_send: false, emoji: "克制" }, quotes: [] },
    personality: { traits: [], values: [], emotion_patterns: [], boundaries: [] },
    memory: { facts: [], timeline: [], relationships: [] },
    knowledge: { known: [], unknown: [], no_evidence_policy: "降低确定性或追问，不编造" },
    chat: { quote_style: "reuse", thinking: "auto", trigger: { dm: "any", group: "@" } },
    model: { provider: "", model: "" },
    memoryConfig: { auto_rounds: 20 },
    sillytavern_v2: {
      chara_card_v2: "0.0.1",
      description: "", personality: "", scenario: "",
      first_mes: "", mes_example: "",
      regex_scripts: [],
      character_book: { entries: [{ keys: ["人物形象"], content: "", name: "人物形象", constant: true, enabled: true }] },
    },
  };
}

// ================= 抽屉 / 路由 =================
function openDrawer() { $("#drawer").classList.add("open"); $("#drawer-overlay").hidden = false; }
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer-overlay").hidden = true; }

function router() {
  const hash = (location.hash || "").replace(/^#\/?/, "") || "home";
  const route = routes[hash] || routes.home;
  $("#view").innerHTML = route.render();
  closeDrawer();
  $("#view").scrollTop = 0;
  document.querySelectorAll(".bottom-nav a, .drawer-nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.route === hash)
  );
  route.init();
}
window.addEventListener("hashchange", router);

// ============================================================
//  卡片表单（做卡 / 编辑共用）
// ============================================================
function wbRowHTML(e, locked) {
  return `<div class="wb-row">
    <input class="wb-key" placeholder="关键词" value="${escapeHtml(e?.keys?.[0] ?? "")}" ${locked ? "disabled" : ""}>
    <textarea class="wb-content" rows="1" placeholder="内容（触发时注入）">${escapeHtml(e?.content ?? "")}</textarea>
    <button class="wb-del danger small-btn" type="button">✕</button>
  </div>`;
}
function rxRowHTML(s) {
  return `<div class="wb-row rx">
    <input class="rx-name" placeholder="名称" value="${escapeHtml(s?.scriptName ?? "")}">
    <input class="rx-find" placeholder="匹配（正则）" value="${escapeHtml(s?.findRegex ?? "")}">
    <input class="rx-rep" placeholder="替换为" value="${escapeHtml(s?.replaceString ?? "")}">
    <button class="wb-del danger small-btn" type="button">✕</button>
  </div>`;
}

function cardFormHTML(mode) {
  return `
  <div class="cf-section"><h3>📋 基本信息</h3>
    <div class="cf-grid">
      <div><label>名称</label><input id="cf-name" placeholder="如：奶奶"></div>
      ${mode === "create" ? `<div><label>slug（留空自动）</label><input id="cf-slug" placeholder="nainai"></div>` : ""}
      ${mode === "create" ? `<div><label>关系类型</label>
        <select id="cf-role">
          <option value="friend">朋友</option><option value="family">家人</option>
          <option value="self">自己</option><option value="partner">前任/恋人</option>
          <option value="colleague">同事</option><option value="public-figure">偶像/角色</option>
        </select></div>` : ""}
    </div>
    <label>简介（一句话介绍角色）</label>
    <textarea id="cf-bio" rows="2" placeholder="如：80 岁的北方奶奶，说话直接但心软"></textarea>
    <label>头像（PNG，可选）</label>
    <div class="cf-avatar-row">
      <img id="cf-avatar-img" class="cf-avatar" style="display:none" alt="头像">
      <input type="file" id="cf-avatar" accept=".png">
    </div>
  </div>
  <div class="cf-section"><h3>👋 开场白</h3>
    <textarea id="cf-first" rows="2" placeholder="对话开始时的第一句话，如：哎，你可算回来了，快坐下"></textarea>
  </div>
  <div class="cf-section"><h3>📚 世界书 <span class="hint">（关键词触发背景设定，第一条固定「人物形象」）</span></h3>
    <div id="cf-book"></div>
    <button id="cf-book-add" class="ghost small-btn" type="button">＋ 添加条目</button>
  </div>
  <div class="cf-section"><h3>🔀 正则替换 <span class="hint">（可留空）</span></h3>
    <div id="cf-regex"></div>
    <button id="cf-regex-add" class="ghost small-btn" type="button">＋ 添加正则</button>
  </div>
  <div class="cf-section"><h3>🎭 人格与语气</h3>
    <div class="cf-grid2">
      <div><label>性格特质（一行一条）</label><textarea id="cf-traits" rows="3"></textarea></div>
      <div><label>口头禅（一行一条）</label><textarea id="cf-catch" rows="3"></textarea></div>
      <div><label>说话方式（一行一条）</label><textarea id="cf-tone" rows="3"></textarea></div>
      <div><label>边界禁区（一行一条）</label><textarea id="cf-bound" rows="3"></textarea></div>
    </div>
  </div>
  <div class="cf-section"><h3>⚡ 模型（此卡专用，留空跟随默认 API）</h3>
    <div class="cf-grid2">
      <div><label>API 提供商</label><select id="cf-provider"><option value="">（跟随默认）</option></select></div>
      <div><label>模型</label><select id="cf-model"><option value="">（跟随默认）</option></select></div>
    </div>
  </div>
  <div class="cf-section"><h3>🧠 记忆</h3>
    <label>每 <input id="cf-rounds" type="number" min="1" max="50" value="20" style="width:64px;display:inline-block;text-align:center"> 轮对话自动总结一次（1-50，默认 20；内容在「记忆」页管理）</label>
  </div>
  <div class="cf-section"><h3>🔧 高级（JSON）<button id="cf-json-toggle" class="ghost small-btn" type="button">展开</button></h3>
    <textarea id="cf-json" rows="10" style="display:none" spellcheck="false"></textarea>
    <div class="row" style="margin-top:6px"><button id="cf-json-load" class="ghost small-btn" type="button">从 JSON 载入表单</button></div>
  </div>`;
}

function bindCardForm(card, mode) {
  fillFormFromCard(card, mode);
  $("#cf-book-add").addEventListener("click", () => $("#cf-book").insertAdjacentHTML("beforeend", wbRowHTML({})));
  $("#cf-regex-add").addEventListener("click", () => $("#cf-regex").insertAdjacentHTML("beforeend", rxRowHTML({})));
  document.addEventListener("click", cardFormDelHandler);
  $("#cf-avatar").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const b64 = await fileToBase64(f);
    $("#cf-avatar-img").src = "data:image/png;base64," + b64;
    $("#cf-avatar-img").style.display = "block";
  });
  $("#cf-json-toggle").addEventListener("click", () => {
    const t = $("#cf-json");
    const show = t.style.display === "none";
    t.style.display = show ? "block" : "none";
    $("#cf-json-toggle").textContent = show ? "收起" : "展开";
    if (show) t.value = JSON.stringify(collectCardForm(structuredClone(card), mode), null, 2);
  });
  $("#cf-json-load").addEventListener("click", () => {
    try {
      const obj = JSON.parse($("#cf-json").value);
      Object.keys(obj).forEach((k) => (card[k] = obj[k]));
      fillFormFromCard(card, mode);
      toast("已从 JSON 载入表单");
    } catch (e) { toast("JSON 解析失败：" + e.message, false); }
  });
  fillProvidersIntoForm(card);
}

function cardFormDelHandler(e) {
  if (e.target?.classList?.contains("wb-del")) {
    const container = e.target.closest("#cf-book, #cf-regex");
    if (container?.id === "cf-book" && container.querySelectorAll(".wb-row").length <= 1) {
      toast("世界书至少保留一条（人物形象）", false);
      return;
    }
    e.target.closest(".wb-row")?.remove();
  }
}

function fillFormFromCard(card, mode) {
  const st = card.sillytavern_v2 ?? {};
  $("#cf-name").value = card.name ?? "";
  if (mode === "create" && $("#cf-slug")) $("#cf-slug").value = card.slug ?? "";
  if (mode === "create" && $("#cf-role")) $("#cf-role").value = card.identity?.role ?? "friend";
  $("#cf-bio").value = st.description || card.identity?.bio || "";
  $("#cf-first").value = st.first_mes ?? "";
  if (card.identity?.avatar) {
    $("#cf-avatar-img").src = card.identity.avatar;
    $("#cf-avatar-img").style.display = "block";
  } else {
    $("#cf-avatar-img").style.display = "none";
  }
  const entries = st.character_book?.entries?.length
    ? st.character_book.entries
    : [{ keys: ["人物形象"], content: "" }];
  $("#cf-book").innerHTML = entries.map((en, i) => wbRowHTML(en, i === 0)).join("");
  $("#cf-regex").innerHTML = (st.regex_scripts ?? []).map(rxRowHTML).join("");
  $("#cf-traits").value = (card.personality?.traits ?? []).join("\n");
  $("#cf-catch").value = (card.voice?.catchphrases ?? []).join("\n");
  $("#cf-tone").value = (card.voice?.tone_rules ?? []).join("\n");
  $("#cf-bound").value = (card.personality?.boundaries ?? []).join("\n");
  $("#cf-rounds").value = card.memoryConfig?.auto_rounds ?? 20;
}

async function fillProvidersIntoForm(card) {
  try {
    providersCache = await api.get("/api/providers");
    const sel = $("#cf-provider");
    sel.innerHTML = '<option value="">（跟随默认）</option>' +
      providersCache.chat.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}${p.isDefault ? "（默认）" : ""}</option>`).join("");
    const fillModels = () => {
      const p = providersCache.chat.find((x) => x.name === sel.value);
      const ms = $("#cf-model");
      ms.innerHTML = '<option value="">（跟随默认）</option>' +
        (p ? p.models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("") : "");
      ms.value = card?.model?.model && p?.models.includes(card.model.model) ? card.model.model : "";
    };
    sel.value = card?.model?.provider || "";
    fillModels();
    sel.addEventListener("change", fillModels);
  } catch { /* providers 未配置 */ }
}

function collectCardForm(card, mode) {
  card.name = $("#cf-name").value.trim() || card.name;
  if (mode === "create" && $("#cf-slug")) card.slug = $("#cf-slug").value.trim();
  card.identity = card.identity ?? {};
  card.identity.bio = $("#cf-bio").value.trim();
  if (card.identity.avatar === undefined) card.identity.avatar = "";
  card.sillytavern_v2 = card.sillytavern_v2 ?? {};
  const st = card.sillytavern_v2;
  st.description = $("#cf-bio").value.trim();
  st.first_mes = $("#cf-first").value.trim();
  st.character_book = {
    entries: [...$("#cf-book").querySelectorAll(".wb-row")]
      .map((r) => {
        const key = r.querySelector(".wb-key").value.trim();
        const content = r.querySelector(".wb-content").value;
        return { keys: [key || "人物形象"], content, name: key || "人物形象", constant: key === "人物形象", enabled: true };
      })
      .filter((e) => e.keys[0] && e.content),
  };
  st.regex_scripts = [...$("#cf-regex").querySelectorAll(".wb-row")]
    .map((r) => ({
      scriptName: r.querySelector(".rx-name").value.trim(),
      findRegex: r.querySelector(".rx-find").value,
      replaceString: r.querySelector(".rx-rep").value,
      enabled: true,
    }))
    .filter((s) => s.findRegex);
  card.personality = card.personality ?? {};
  card.personality.traits = $("#cf-traits").value.split("\n").map((s) => s.trim()).filter(Boolean);
  card.personality.boundaries = $("#cf-bound").value.split("\n").map((s) => s.trim()).filter(Boolean);
  card.voice = card.voice ?? {};
  card.voice.catchphrases = $("#cf-catch").value.split("\n").map((s) => s.trim()).filter(Boolean);
  card.voice.tone_rules = $("#cf-tone").value.split("\n").map((s) => s.trim()).filter(Boolean);
  card.model = { provider: $("#cf-provider")?.value || undefined, model: $("#cf-model")?.value || undefined };
  card.memoryConfig = { auto_rounds: Math.min(50, Math.max(1, Number($("#cf-rounds").value) || 20)) };
  return card;
}

// ============================================================
//  视图：首页
// ============================================================
function renderHome() {
  return `
  <div class="view">
    <div class="home-status">
      <div class="status-card"><div class="status-head"><span class="big">⚡</span> 模型</div>
        <div id="hs-model" class="meta">检测中…</div><button class="ghost small-btn" data-go="api">去配置</button></div>
      <div class="status-card"><div class="status-head"><span class="big">💬</span> 微信</div>
        <div id="hs-wx" class="meta">检测中…</div><button class="ghost small-btn" data-go="channels">去绑定</button></div>
      <div class="status-card"><div class="status-head"><span class="big">🐧</span> QQ</div>
        <div id="hs-qq" class="meta">检测中…</div><button class="ghost small-btn" data-go="channels">去绑定</button></div>
    </div>
    <div class="card-box">
      <h3>🚀 快速上手</h3>
      <div class="steps">
        <div class="step" id="step-api"><span class="dot"></span>① 配置 API</div>
        <div class="step" id="step-card"><span class="dot"></span>② 建卡 / 导入</div>
        <div class="step" id="step-channel"><span class="dot"></span>③ 绑定通道</div>
        <div class="step" id="step-chat"><span class="dot"></span>④ 开始聊天</div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" data-go="create">✏️ 去做卡</button>
        <button data-go="cards">🎴 卡库</button>
        <button data-go="channels">💬 绑定通道</button>
      </div>
    </div>
    <div class="card-box">
      <h3>⚡ 当前生效人设</h3>
      <div id="home-active-box" class="active-box">—</div>
    </div>
    <div class="card-box">
      <h3>🎴 人设卡库</h3>
      <div id="home-card-grid" class="card-grid"></div>
    </div>
  </div>`;
}

function initHome() {
  document.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => (location.hash = "#/" + b.dataset.go))
  );
  refreshHome();
}

async function refreshHome() {
  try {
    const prov = await api.get("/api/providers").catch(() => null);
    const ok1 = Boolean(prov?.chat?.length);
    $("#hs-model").textContent = prov?.chat?.[0]
      ? `${prov.chat[0].name} · ${prov.chat[0].models?.[0] ?? "未拉取模型"}`
      : "未配置";
    $("#step-api").classList.toggle("done", ok1);
    const wx = await api.get("/api/channels/wechat/status").catch(() => null);
    $("#hs-wx").textContent = wx?.connected ? "已连接 ✓" : "未绑定";
    const qq = await api.get("/api/channels/qq/status").catch(() => null);
    $("#hs-qq").textContent = qq?.pluginInstalled && qq?.onebotSeen ? "已连接 ✓" : "未绑定";
    $("#step-channel").classList.toggle("done", Boolean(wx?.connected || (qq?.pluginInstalled && qq?.onebotSeen)));
    const cards = await api.get("/api/cards").catch(() => ({ cards: [] }));
    $("#step-card").classList.toggle("done", cards.cards?.length > 0);
    $("#step-chat").classList.toggle("done", ok1 && cards.cards?.length > 0);
    const active = await api.get("/api/active-persona").catch(() => null);
    const box = $("#home-active-box");
    box.innerHTML = active?.active
      ? `<span class="active-name">${escapeHtml(active.active)}</span><button class="ghost small-btn" data-go="cards">去卡库</button>`
      : `还没有编译过人设卡 <button class="ghost small-btn" data-go="cards">去卡库</button>`;
    box.querySelector("[data-go]")?.addEventListener("click", (e) => (location.hash = "#/" + e.target.dataset.go));
    const grid = $("#home-card-grid");
    grid.innerHTML = "";
    if (!cards.cards?.length) {
      grid.innerHTML = '<div class="muted">还没有人设卡</div>';
      return;
    }
    for (const c of cards.cards.slice(-8).reverse()) {
      const d = document.createElement("div");
      d.className = "mini-card";
      d.innerHTML = `<div class="mini-name">${escapeHtml(c.name)}</div><div class="meta">${c.slug} · ${c.role}</div>`;
      d.addEventListener("click", () => {
        location.hash = "#/cards";
        setTimeout(() => loadCardIntoEditor(c.slug), 60);
      });
      grid.appendChild(d);
    }
  } catch { /* 忽略 */ }
}

// ============================================================
//  视图：人设卡库（表单化编辑 + 聊天测试）
// ============================================================
function renderCards() {
  return `
  <div class="cards-layout">
    <aside class="cards-side">
      <div class="side-actions">
        <button id="btn-import-card" class="ghost small-btn">📥 导入 PNG/JSON</button>
        <input type="file" id="import-file" accept=".png,.json" style="display:none">
        <a href="#/create" class="btn-like primary small-btn">✏️ 做张新卡</a>
      </div>
      <h2>卡库</h2>
      <ul id="card-list" class="card-list"></ul>
    </aside>
    <section class="cards-editor">
      <div class="editor-head">
        <h2 id="editor-title">选择左侧卡片</h2>
        <div class="editor-actions">
          <button id="btn-export-png" class="ghost">导出 PNG</button>
          <button id="btn-export-json" class="ghost">导出 JSON</button>
          <button id="btn-compile">编译到通道</button>
          <button id="btn-del" class="danger">删除</button>
          <button id="btn-save" class="primary">保存</button>
        </div>
      </div>
      <div id="card-form-area" class="card-form-area"><div class="muted" style="padding:30px;text-align:center">从左侧选择一张卡片开始编辑</div></div>
      <div class="chat-test">
        <div class="chat-head">
          <h3>💬 聊天测试 <span id="chat-head-hint" class="hint">普通聊天（用此卡模型）</span></h3>
          <div>
            <button id="btn-work-mode" class="ghost small-btn">🔧 工作模式</button>
            <button id="btn-chat-clear" class="ghost small-btn">清空</button>
          </div>
        </div>
        <div class="chat-opts" style="display:none">
          <span class="opt-group">工具：
            <label><input type="checkbox" id="tool-code"> 写代码*</label>
            <label><input type="checkbox" id="tool-file"> 文件</label>
            <label><input type="checkbox" id="tool-search"> 搜索</label>
            <label><input type="checkbox" id="tool-weather"> 天气</label>
            <label><input type="checkbox" id="tool-memory"> 记忆</label>
            <label><input type="checkbox" id="tool-mcp"> MCP</label>
          </span>
          <span class="opt-group">技能：
            <label><input type="checkbox" id="skill-code"> 代码</label>
            <label><input type="checkbox" id="skill-trans"> 翻译</label>
            <label><input type="checkbox" id="skill-write"> 写作</label>
            <label><input type="checkbox" id="skill-companion"> 陪伴</label>
          </span>
          <span class="opt-group">深度：
            <select id="chat-thinking">
              <option value="off">关闭</option><option value="auto" selected>自动</option>
              <option value="low">低</option><option value="medium">中</option>
              <option value="high">高</option><option value="extreme">极高</option>
            </select>
          </span>
        </div>
        <div id="chat-log" class="chat-log"></div>
        <div class="row">
          <input id="chat-input" placeholder="对这个人设说点什么…">
          <button id="btn-chat-send" class="primary">发送</button>
        </div>
      </div>
    </section>
  </div>`;
}

function initCards() {
  const def = capDefaults();
  const tools = def.tools ?? [];
  $("#tool-code").checked = tools.includes("code_exec");
  $("#tool-file").checked = tools.includes("sandbox_list");
  $("#tool-search").checked = tools.includes("web_search");
  $("#tool-weather").checked = tools.includes("weather");
  $("#tool-memory").checked = tools.includes("memory_save");
  const skills = def.skills ?? [];
  $("#skill-code").checked = skills.includes("code_expert");
  $("#skill-trans").checked = skills.includes("translator");
  $("#skill-write").checked = skills.includes("writing");
  $("#skill-companion").checked = skills.includes("companion");
  $("#chat-thinking").value = def.thinking ?? "auto";

  $("#btn-import-card").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", importCard);
  $("#btn-export-png").addEventListener("click", () => exportCard("png"));
  $("#btn-export-json").addEventListener("click", () => exportCard("json"));
  $("#btn-compile").addEventListener("click", compileCard);
  $("#btn-del").addEventListener("click", deleteCard);
  $("#btn-save").addEventListener("click", saveCard);
  $("#btn-chat-send").addEventListener("click", sendChat);
  $("#btn-chat-clear").addEventListener("click", clearChat);
  $("#btn-work-mode").addEventListener("click", toggleWorkMode);
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  loadCardList();
}

async function loadCardList() {
  const { cards } = await api.get("/api/cards");
  const ul = $("#card-list");
  if (!ul) return;
  ul.innerHTML = "";
  for (const c of cards) {
    const li = document.createElement("li");
    li.innerHTML = `<div><div class="name">${escapeHtml(c.name)}</div><div class="meta">${c.slug} · ${c.role}</div></div>`;
    li.addEventListener("click", () => loadCardIntoEditor(c.slug));
    if (editingCard?.slug === c.slug) li.classList.add("active");
    ul.appendChild(li);
  }
}

async function loadCardIntoEditor(slug) {
  try {
    editingCard = await api.get(`/api/cards/${slug}`);
    chatHistory = [];
    $("#chat-log").innerHTML = "";
    $("#editor-title").textContent = `编辑：${editingCard.name}`;
    $("#card-form-area").innerHTML = cardFormHTML("edit");
    bindCardForm(editingCard, "edit");
    loadCardList();
  } catch (e) { toast("加载失败：" + e.message, false); }
}

async function saveCard() {
  if (!editingCard) return toast("先选择一张卡片", false);
  collectCardForm(editingCard, "edit");
  const avatarSrc = $("#cf-avatar-img")?.src;
  if (avatarSrc?.startsWith("data:image/png")) editingCard.identity.avatar = avatarSrc;
  try {
    const res = await api.send(`/api/cards/${editingCard.slug}`, { method: "PUT", body: JSON.stringify(editingCard) });
    toast("✓ 已保存 v" + res.card.version);
    loadCardList();
  } catch (e) { toast("保存失败：" + e.message, false); }
}

async function compileCard() {
  if (!editingCard) return toast("先选择一张卡片", false);
  await saveCard();
  try {
    const res = await api.send(`/api/cards/${editingCard.slug}/compile`, { method: "POST" });
    toast(`✓ 已编译 ${res.files.length} 个文件到通道`);
  } catch (e) { toast("编译失败：" + e.message, false); }
}

async function deleteCard() {
  if (!editingCard) return;
  if (!confirm(`确定删除 ${editingCard.name}？不可恢复。`)) return;
  await api.send(`/api/cards/${editingCard.slug}`, { method: "DELETE" });
  editingCard = null;
  $("#editor-title").textContent = "选择左侧卡片";
  $("#card-form-area").innerHTML = '<div class="muted" style="padding:30px;text-align:center">从左侧选择一张卡片开始编辑</div>';
  loadCardList();
}

async function exportCard(format) {
  if (!editingCard) return toast("先选择一张卡片", false);
  await saveCard();
  try {
    const r = await api.send(`/api/cards/${editingCard.slug}/export`, { method: "POST", body: JSON.stringify({ format }) });
    downloadDataUrl(r.dataUrl, r.filename);
    toast("✓ 已导出 " + r.filename);
  } catch (e) { toast("导出失败：" + e.message, false); }
}

async function importCard() {
  const f = $("#import-file").files[0];
  if (!f) return;
  try {
    const b64 = await fileToBase64(f);
    const r = await api.send("/api/cards/import-card", { method: "POST", body: JSON.stringify({ fileBase64: b64, fileName: f.name }) });
    $("#import-file").value = "";
    toast(`✓ 已导入：${r.card.name}`);
    await loadCardList();
    loadCardIntoEditor(r.card.slug);
  } catch (e) { toast("导入失败：" + e.message, false); }
}

// ============================================================
//  视图：做卡（独立页）
// ============================================================
function renderCreate() {
  return `
  <div class="view create-view">
    <div class="page-head"><h2>✏️ 做卡</h2><p class="hint">填写卡片内容 → 保存进卡库 → 可导出 PNG/JSON 或直接编译到通道</p></div>
    <div id="card-form-area" class="card-form-area">${cardFormHTML("create")}</div>
    <div class="create-actions">
      <button id="btn-create-save" class="primary big">💾 保存卡片</button>
      <button id="btn-create-save-compile" class="big">💾 保存并编译到通道</button>
    </div>
  </div>`;
}

function initCreate() {
  editingCard = blankCard("", "");
  bindCardForm(editingCard, "create");
  $("#btn-create-save").addEventListener("click", () => saveNewCard(false));
  $("#btn-create-save-compile").addEventListener("click", () => saveNewCard(true));
}

async function saveNewCard(compile) {
  collectCardForm(editingCard, "create");
  if (!editingCard.name) return toast("请填写名称", false);
  if (!editingCard.slug) {
    editingCard.slug = /^[a-z0-9][a-z0-9-]*$/.test(editingCard.name.toLowerCase())
      ? editingCard.name.toLowerCase()
      : "card-" + Date.now().toString(36);
  }
  const avatarSrc = $("#cf-avatar-img")?.src;
  if (avatarSrc?.startsWith("data:image/png")) editingCard.identity.avatar = avatarSrc;
  editingCard.identity.relation = editingCard.name;
  try {
    const r = await api.send("/api/cards/import", { method: "POST", body: JSON.stringify({ card: editingCard }) });
    toast(`✓ 已保存：${r.card.name}`);
    if (compile) {
      await api.send(`/api/cards/${r.card.slug}/compile`, { method: "POST" });
      toast("✓ 已编译到通道");
    }
    location.hash = "#/cards";
    setTimeout(() => loadCardIntoEditor(r.card.slug), 80);
  } catch (e) { toast("保存失败：" + e.message, false); }
}

// ============================================================
//  视图：API 与模型 / 生图配置（多提供商，模型自动拉取）
// ============================================================
function renderApi() { return renderProvidersPage("chat", "⚡ API 与模型", "对话 API 提供商；第一个为默认，卡片未单独指定时使用它。"); }
function renderImagegen() { return renderProvidersPage("image", "🎨 生图配置", "生图 API 提供商（模型自动拉取）。"); }

function renderProvidersPage(type, title, desc) {
  return `
  <div class="view">
    <div class="page-head"><h2>${title}</h2><p class="hint">${desc}</p></div>
    <div id="prov-list"></div>
    <button id="prov-add" class="primary">＋ 添加提供商</button>
    <div id="prov-form" class="card-box" style="display:none;margin-top:12px">
      <h3 id="pv-title">添加提供商</h3>
      <div class="form">
        <div class="cf-grid2">
          <div><label>名称（字母/数字）</label><input id="pv-name" placeholder="如 agnes / myrelay"></div>
          <div><label>Base URL（以 /v1 结尾）</label><input id="pv-url" placeholder="https://api.example.com/v1"></div>
        </div>
        <label>API Key（编辑时留空 = 保留原值）</label>
        <input id="pv-key" type="password" placeholder="sk-...">
        <div class="row">
          <button id="pv-save-fetch" class="primary">保存并拉取模型</button>
          <button id="pv-cancel" class="ghost">取消</button>
        </div>
        <div id="pv-fetch-msg" class="status"></div>
        <div id="pv-models-wrap" style="display:none">
          <label>点击模型加入/移除（★ 第一个为默认模型）</label>
          <div id="pv-models" class="model-chips"></div>
          <div class="row" style="margin-top:8px"><button id="pv-done" class="primary">完成</button></div>
        </div>
      </div>
    </div>
  </div>`;
}

let provState = { type: "chat", editing: null, allModels: [], selected: [] };

function initApi() { initProvidersPage("chat"); }
function initImagegen() { initProvidersPage("image"); }

function initProvidersPage(type) {
  provState = { type, editing: null, allModels: [], selected: [] };
  $("#prov-add").addEventListener("click", () => showProvForm(null));
  $("#pv-cancel").addEventListener("click", () => ($("#prov-form").style.display = "none"));
  $("#pv-save-fetch").addEventListener("click", provSaveAndFetch);
  $("#pv-done").addEventListener("click", provDone);
  loadProvList();
}

async function loadProvList() {
  const box = $("#prov-list");
  if (!box) return;
  try {
    const data = await api.get("/api/providers");
    const list = provState.type === "chat" ? data.chat : data.image;
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="card-box muted">还没有提供商，点下方按钮添加</div>';
      return;
    }
    list.forEach((p, i) => {
      const d = document.createElement("div");
      d.className = "prov-item" + (i === 0 ? " default" : "");
      d.innerHTML = `
        <div class="prov-head">
          <b>${escapeHtml(p.name)}</b>
          ${i === 0 ? '<span class="chip ok">默认</span>' : ""}
          <span class="prov-btns">
            ${i !== 0 ? `<button class="ghost small-btn" data-act="default" data-name="${escapeHtml(p.name)}">设为默认</button>` : ""}
            <button class="ghost small-btn" data-act="edit" data-name="${escapeHtml(p.name)}">编辑</button>
            <button class="danger small-btn" data-act="del" data-name="${escapeHtml(p.name)}">删除</button>
          </span>
        </div>
        <div class="meta">${escapeHtml(p.baseUrl)} · key ${escapeHtml(p.apiKey || "未填")}</div>
        <div class="meta">模型（${p.models.length}）：${escapeHtml(p.models.slice(0, 6).join("、"))}${p.models.length > 6 ? "…" : ""}</div>`;
      box.appendChild(d);
    });
    box.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", async () => {
        const name = b.dataset.name;
        if (b.dataset.act === "edit") showProvForm(name);
        else if (b.dataset.act === "del") {
          if (!confirm(`删除提供商 ${name}？`)) return;
          await api.send("/api/providers/delete", { method: "POST", body: JSON.stringify({ type: provState.type, name }) });
          loadProvList();
        } else if (b.dataset.act === "default") {
          await api.send("/api/providers/set-default", { method: "POST", body: JSON.stringify({ type: provState.type, name }) });
          loadProvList();
          toast("✓ 已设为默认");
        }
      })
    );
  } catch (e) { box.innerHTML = `<div class="card-box muted">读取失败：${escapeHtml(e.message)}</div>`; }
}

async function showProvForm(name) {
  provState.editing = name;
  provState.allModels = [];
  provState.selected = [];
  const form = $("#prov-form");
  form.style.display = "block";
  $("#pv-title").textContent = name ? `编辑 ${name}` : "添加提供商";
  $("#pv-name").value = name ?? "";
  $("#pv-name").disabled = Boolean(name);
  $("#pv-url").value = "";
  $("#pv-key").value = "";
  $("#pv-models-wrap").style.display = "none";
  $("#pv-fetch-msg").textContent = name ? "（Base URL 留空 = 保留原值）" : "";
  if (name) {
    const data = await api.get("/api/providers");
    const p = (provState.type === "chat" ? data.chat : data.image).find((x) => x.name === name);
    if (p) {
      $("#pv-url").value = p.baseUrl;
      provState.selected = [...p.models];
      if (p.models.length) {
        provState.allModels = [...p.models];
        renderModelChips();
        $("#pv-models-wrap").style.display = "block";
      }
    }
  }
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function provSaveAndFetch() {
  const name = $("#pv-name").value.trim();
  const baseUrl = $("#pv-url").value.trim();
  if (!name) return toast("请填名称", false);
  if (!baseUrl && !provState.editing) return toast("请填 Base URL", false);
  $("#pv-fetch-msg").textContent = "保存中，随后拉取模型…";
  try {
    await api.send("/api/providers/save", {
      method: "POST",
      body: JSON.stringify({ type: provState.type, name, baseUrl, apiKey: $("#pv-key").value.trim() || undefined }),
    });
    const r = await api.send("/api/providers/fetch-models", {
      method: "POST",
      body: JSON.stringify({ type: provState.type, name }),
    });
    provState.allModels = r.models;
    if (!provState.selected.length) provState.selected = r.models.slice(0, 1);
    renderModelChips();
    $("#pv-models-wrap").style.display = "block";
    $("#pv-fetch-msg").textContent = `✓ 拉取到 ${r.models.length} 个模型`;
    loadProvList();
  } catch (e) {
    $("#pv-fetch-msg").textContent = "失败：" + e.message;
  }
}

function renderModelChips() {
  const box = $("#pv-models");
  box.innerHTML = "";
  provState.allModels.forEach((m) => {
    const idx = provState.selected.indexOf(m);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "model-chip" + (idx >= 0 ? " on" : "");
    chip.textContent = (idx === 0 ? "★ " : "") + m;
    chip.addEventListener("click", () => {
      const i = provState.selected.indexOf(m);
      if (i >= 0) provState.selected.splice(i, 1);
      else provState.selected.push(m);
      renderModelChips();
    });
    box.appendChild(chip);
  });
}

async function provDone() {
  const name = $("#pv-name").value.trim();
  const baseUrl = $("#pv-url").value.trim();
  try {
    await api.send("/api/providers/save", {
      method: "POST",
      body: JSON.stringify({ type: provState.type, name, baseUrl, apiKey: $("#pv-key").value.trim() || undefined, models: provState.selected }),
    });
    $("#prov-form").style.display = "none";
    toast("✓ 已保存");
    loadProvList();
  } catch (e) { toast("保存失败：" + e.message, false); }
}

// ============================================================
//  视图：记忆（每卡配置 + 查看）
// ============================================================
function renderMemory() {
  return `
  <div class="view">
    <div class="page-head"><h2>🧠 记忆</h2><p class="hint">每张卡独立的长期记忆；设定每几轮对话自动总结（默认 20，1-50）</p></div>
    <div id="mem-cards" class="card-grid"></div>
    <div id="mem-detail" class="card-box" style="display:none">
      <h3 id="mem-title"></h3>
      <div class="row" style="align-items:center">
        <label>每 <input id="mem-rounds" type="number" min="1" max="50" style="width:64px;text-align:center"> 轮自动总结</label>
        <button id="mem-save-rounds" class="primary small-btn">保存</button>
        <button id="mem-clear" class="danger small-btn">清空此卡记忆</button>
      </div>
      <h3>已记住的事实</h3>
      <div id="mem-entries" class="small-out tall"></div>
    </div>
  </div>`;
}

let memCard = null;
function initMemory() {
  (async () => {
    const { cards } = await api.get("/api/cards");
    const box = $("#mem-cards");
    box.innerHTML = "";
    if (!cards.length) { box.innerHTML = '<div class="muted">还没有卡片</div>'; return; }
    for (const c of cards) {
      const d = document.createElement("div");
      d.className = "mini-card";
      d.innerHTML = `<div class="mini-name">${escapeHtml(c.name)}</div><div class="meta">${c.slug}</div>`;
      d.addEventListener("click", () => openMemDetail(c.slug));
      box.appendChild(d);
    }
  })();
  $("#mem-save-rounds").addEventListener("click", saveMemRounds);
  $("#mem-clear").addEventListener("click", clearMem);
}

async function openMemDetail(slug) {
  memCard = await api.get(`/api/cards/${slug}`);
  $("#mem-detail").style.display = "block";
  $("#mem-title").textContent = `🧠 ${memCard.name} 的记忆`;
  $("#mem-rounds").value = memCard.memoryConfig?.auto_rounds ?? 20;
  const mem = await api.get("/api/memory").catch(() => ({ memory: {} }));
  const entries = mem.memory?.[slug] ?? [];
  $("#mem-entries").textContent = entries.length ? entries.map((e) => "· " + e).join("\n") : "（还没有记忆）";
  $("#mem-detail").scrollIntoView({ behavior: "smooth" });
}

async function saveMemRounds() {
  if (!memCard) return;
  const rounds = Math.min(50, Math.max(1, Number($("#mem-rounds").value) || 20));
  memCard.memoryConfig = { auto_rounds: rounds };
  try {
    await api.send(`/api/cards/${memCard.slug}`, { method: "PUT", body: JSON.stringify(memCard) });
    toast(`✓ 每 ${rounds} 轮自动总结`);
  } catch (e) { toast("保存失败：" + e.message, false); }
}

async function clearMem() {
  if (!memCard || !confirm(`清空 ${memCard.name} 的全部记忆？`)) return;
  await api.send("/api/memory/clear", { method: "POST", body: JSON.stringify({ slug: memCard.slug }) });
  openMemDetail(memCard.slug);
  toast("✓ 已清空");
}

// ============================================================
//  聊天（模型由服务端按卡解析）
// ============================================================
function addChatBubble(role, text) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "bot");
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
function gatherChatOptions() {
  const tools = [];
  if ($("#tool-code")?.checked) tools.push("code_exec");
  if ($("#tool-file")?.checked) tools.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
  if ($("#tool-search")?.checked) tools.push("web_search");
  if ($("#tool-weather")?.checked) tools.push("weather");
  if ($("#tool-memory")?.checked) tools.push("memory_save");
  const skills = [];
  if ($("#skill-code")?.checked) skills.push("code_expert");
  if ($("#skill-trans")?.checked) skills.push("translator");
  if ($("#skill-write")?.checked) skills.push("writing");
  if ($("#skill-companion")?.checked) skills.push("companion");
  return { tools, useMCP: $("#tool-mcp")?.checked, skills, thinking: $("#chat-thinking")?.value ?? "auto" };
}
function toggleWorkMode() {
  workMode = !workMode;
  const btn = $("#btn-work-mode");
  btn.textContent = workMode ? "💬 聊天模式" : "🔧 工作模式";
  btn.classList.toggle("active", workMode);
  $(".chat-opts").style.display = workMode ? "flex" : "none";
  $("#chat-head-hint").textContent = workMode ? "工作模式：开放工具/技能" : "普通聊天（用此卡模型）";
}
async function sendChat() {
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  if (!editingCard) { addChatBubble("bot", "请先选择一张人设卡。"); return; }
  addChatBubble("user", message);
  input.value = "";
  chatHistory.push({ role: "user", content: message });
  const btn = $("#btn-chat-send");
  btn.disabled = true;
  const opts = workMode ? gatherChatOptions() : { tools: [], useMCP: false, skills: [], thinking: "auto" };
  try {
    const r = await api.send("/api/chat", {
      method: "POST",
      body: JSON.stringify({ slug: editingCard.slug, message, history: chatHistory.slice(0, -1), ...opts }),
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
  } else if (r.type === "pending") {
    const bubble = addChatBubble("bot", "🛡️ 需要你确认：机器人想调用\n" + r.pending.map((p) => "· " + p.name).join("\n"));
    const row = document.createElement("div");
    row.className = "approve-row";
    const ok = document.createElement("button");
    ok.className = "small-btn primary"; ok.textContent = "✅ 执行";
    const no = document.createElement("button");
    no.className = "small-btn danger"; no.textContent = "🚫 拒绝";
    pendingData = { slug: editingCard.slug, messages: r.messages, tools: gatherChatOptions().tools, useMCP: $("#tool-mcp").checked, approve: false };
    ok.addEventListener("click", async () => { row.remove(); pendingData.approve = true; await sendApprove(); });
    no.addEventListener("click", async () => { row.remove(); pendingData.approve = false; await sendApprove(); });
    row.append(ok, no);
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
  } catch (e) { addChatBubble("bot", "⚠ " + e.message); }
  btn.disabled = false;
}
function clearChat() { chatHistory = []; pendingData = null; $("#chat-log").innerHTML = ""; }

// ============================================================
//  视图：蒸馏 / 通道 / 能力 / 数据 / 设置
// ============================================================
function renderDistill() {
  return `
  <div class="view">
    <div class="page-head"><h2>🧪 蒸馏工厂</h2><p class="hint">聊天记录 → 脱敏 → 四维蒸馏 → 人设卡</p></div>
    <div class="two-col">
      <div class="card-box">
        <div class="form">
          <label>聊天记录文件（WeFlow JSON）</label>
          <input id="distill-file" type="file" accept=".json">
          <label>或粘贴文本（每行：昵称: 内容）</label>
          <textarea id="distill-paste" rows="3" placeholder="奶奶: 多喝水&#10;我: 知道了"></textarea>
          <div class="cf-grid2">
            <div><label>卡片名称</label><input id="distill-name" placeholder="如：奶奶"></div>
            <div><label>关系</label>
              <select id="distill-role">
                <option value="friend">朋友</option><option value="family">家人</option>
                <option value="self">自己</option><option value="partner">前任/恋人</option>
                <option value="colleague">同事</option><option value="public-figure">偶像/角色</option>
              </select></div>
          </div>
          <div class="cf-grid2">
            <div><label>目标人物（留空自动）</label><input id="distill-target" placeholder="如：奶奶"></div>
            <div><label>我方昵称（逗号分隔）</label><input id="distill-self" placeholder="我,本人"></div>
          </div>
          <label>屏蔽词（逗号分隔）</label>
          <input id="distill-blocked" placeholder="工资,敏感词">
          <div class="row"><button id="btn-distill-run" class="primary">开始蒸馏</button></div>
          <div id="distill-msg" class="status"></div>
        </div>
        <h3>🔌 直连 WeFlow（本机 5031）</h3>
        <div class="row"><input id="wf-token" placeholder="access_token"><button id="btn-wf-probe" class="ghost small-btn">探测</button></div>
        <div class="row"><input id="wf-talker" placeholder="talker"><input id="wf-limit" type="number" value="500" style="max-width:80px"><button id="btn-wf-distill" class="primary small-btn">导入蒸馏</button></div>
        <pre id="wf-out" class="small-out"></pre>
      </div>
      <div class="card-box">
        <h3>蒸馏结果</h3>
        <div class="row">
          <button id="btn-distill-save" class="primary small-btn">保存到卡库</button>
          <button id="btn-distill-export-png" class="ghost small-btn">导出 PNG</button>
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
  $("#btn-wf-probe").addEventListener("click", probeWeFlow);
  $("#btn-wf-distill").addEventListener("click", distillFromWeFlow);
}

async function runDistill() {
  const file = $("#distill-file").files[0];
  const paste = $("#distill-paste").value.trim();
  if (!file && !paste) return toast("请选择文件或粘贴文本", false);
  const name = $("#distill-name").value.trim();
  if (!name) return toast("请填写卡片名称", false);
  $("#distill-msg").textContent = "蒸馏中…（调用模型 3 次）";
  $("#btn-distill-run").disabled = true;
  try {
    const r = await api.send("/api/distill", {
      method: "POST",
      body: JSON.stringify({
        fileContent: file ? await file.text() : paste,
        fileName: file?.name || "paste.txt",
        name, role: $("#distill-role").value,
        target: $("#distill-target").value.trim() || undefined,
        selfNames: $("#distill-self").value.split(",").map((s) => s.trim()).filter(Boolean),
        blockedWords: $("#distill-blocked").value.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    lastDistilledCard = r.card;
    $("#distill-result").textContent =
      `✓ ${r.card.name}（${r.card.slug}）\n消息 ${r.stats.totalMessages} → 目标 ${r.stats.usedMessages}，脱敏 ${r.stats.redact.replaced} 处\n\n` +
      r.card.personality.traits.map((t) => "· " + t).join("\n");
    $("#distill-msg").textContent = "完成，可保存或导出";
  } catch (e) { $("#distill-msg").textContent = "失败：" + e.message; }
  $("#btn-distill-run").disabled = false;
}

async function saveDistilled() {
  if (!lastDistilledCard) return toast("还没有蒸馏结果", false);
  try {
    const r = await api.send("/api/cards/import", { method: "POST", body: JSON.stringify({ card: lastDistilledCard }) });
    toast(`✓ 已保存：${r.card.name}`);
    lastDistilledCard = null;
  } catch (e) { toast("保存失败：" + e.message, false); }
}

async function exportDistillCard(format) {
  if (!lastDistilledCard) return toast("还没有蒸馏结果", false);
  try {
    const r = await api.send("/api/cards/export-card", { method: "POST", body: JSON.stringify({ card: lastDistilledCard, format }) });
    downloadDataUrl(r.dataUrl, r.filename);
    toast("✓ 已导出 " + r.filename);
  } catch (e) { toast("导出失败：" + e.message, false); }
}

async function probeWeFlow() {
  const token = $("#wf-token").value.trim();
  if (!token) return toast("请填 access_token", false);
  $("#wf-out").textContent = "探测中…";
  try {
    const r = await api.send("/api/weflow/probe", { method: "POST", body: JSON.stringify({ token }) });
    $("#wf-out").textContent = r.results.map((x) => `${x.path} → HTTP ${x.status}`).join("\n");
  } catch (e) { $("#wf-out").textContent = "失败：" + e.message; }
}

async function distillFromWeFlow() {
  const token = $("#wf-token").value.trim();
  const talker = $("#wf-talker").value.trim();
  const name = $("#distill-name").value.trim();
  if (!token || !talker || !name) return toast("请填 token / talker / 名称", false);
  $("#wf-out").textContent = "拉取并蒸馏中…";
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
    $("#wf-out").textContent = `✓ ${r.card.name}：${r.stats.totalMessages} → ${r.stats.usedMessages} 条`;
    toast("蒸馏完成，可保存/导出");
  } catch (e) { $("#wf-out").textContent = "失败：" + e.message; }
}

// ---- 通道 ----
function renderChannels() {
  return `
  <div class="view">
    <div class="page-head"><h2>💬 通道连接</h2><p class="hint">微信 / QQ 官方扫码绑定</p></div>
    <div class="two-col">
      <div class="card-box">
        <h3>💬 微信 <span id="wx-status" class="chip">检测中…</span></h3>
        <p class="hint">腾讯官方通道，仅单聊；需微信有 ClawBot 入口（灰度）。</p>
        <div class="row"><button id="btn-wx-login" class="primary">开始扫码绑定</button><button id="btn-wx-refresh" class="ghost">刷新</button></div>
        <pre id="wx-qr" class="qr-box" style="display:none"></pre>
        <div id="wx-login-msg" class="status"></div>
        <h3>配对授权</h3>
        <div class="row"><input id="pairing-code" placeholder="配对码"><button id="btn-pair-approve" class="primary small-btn">批准</button></div>
        <pre id="pairing-list" class="small-out"></pre>
      </div>
      <div class="card-box">
        <h3>🐧 QQ <span id="qq-status" class="chip">检测中…</span></h3>
        <p class="hint">官方开放平台机器人（单聊/群聊@/频道）。</p>
        <div class="row"><button id="btn-qq-login" class="primary">开始扫码绑定</button><button id="btn-qq-refresh" class="ghost">刷新</button></div>
        <pre id="qq-qr" class="qr-box" style="display:none"></pre>
        <div id="qq-login-msg" class="status"></div>
        <div class="guide"><ol>
          <li><a href="https://q.qq.com/" target="_blank">QQ 开放平台</a> 扫码登录 → 创建机器人</li>
          <li>点上方「开始扫码绑定」，手机 QQ 扫网页二维码</li>
          <li>QQ 消息列表找到机器人发消息测试</li>
        </ol></div>
        <pre id="qq-out" class="small-out"></pre>
      </div>
    </div>
  </div>`;
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
        if (s.output) { $(qrSel).textContent = s.output; $(qrSel).style.display = "block"; }
        if (!s.running && s.done) {
          clearInterval(loginTimers[channelPath]);
          loginTimers[channelPath] = null;
          $(msgSel).textContent = s.ok ? "✓ 扫码成功，已绑定！" : "✗ 未成功，检查平台侧后重试";
          refreshCb && refreshCb();
        }
      } catch { /* 忽略 */ }
    }, 2000);
  } catch (e) { $(msgSel).textContent = "启动失败：" + e.message; }
}

function initChannels() {
  $("#btn-wx-login").addEventListener("click", () => startLogin("/api/channels/wechat/login", "#wx-qr", "#wx-login-msg", () => { refreshWechat(); refreshPairing(); }));
  $("#btn-wx-refresh").addEventListener("click", refreshWechat);
  $("#btn-pair-approve").addEventListener("click", approvePairing);
  $("#btn-qq-login").addEventListener("click", () => startLogin("/api/channels/qq/login", "#qq-qr", "#qq-login-msg", refreshQQ));
  $("#btn-qq-refresh").addEventListener("click", refreshQQ);
  refreshWechat(); refreshPairing(); refreshQQ();
}
async function refreshWechat() {
  try {
    const s = await api.get("/api/channels/wechat/status");
    const el = $("#wx-status");
    el.textContent = s.connected ? "已连接 ✓" : "未连接";
    el.className = "chip " + (s.connected ? "ok" : "");
  } catch { $("#wx-status").textContent = "检测失败"; }
}
async function refreshPairing() {
  try {
    const r = await api.get("/api/channels/wechat/pairing");
    $("#pairing-list").textContent = r.raw || "（暂无待处理配对）";
  } catch (e) { $("#pairing-list").textContent = "读取失败：" + e.message; }
}
async function approvePairing() {
  const code = $("#pairing-code").value.trim();
  if (!code) return;
  try {
    const r = await api.send("/api/channels/wechat/pairing/approve", { method: "POST", body: JSON.stringify({ code }) });
    $("#pairing-list").textContent = r.output || (r.ok ? "✓ 已批准" : "批准失败");
    $("#pairing-code").value = "";
  } catch (e) { $("#pairing-list").textContent = "失败：" + e.message; }
}
async function refreshQQ() {
  try {
    const s = await api.get("/api/channels/qq/status");
    const ok = s.pluginInstalled && s.onebotSeen;
    const el = $("#qq-status");
    el.textContent = ok ? "已连接 ✓" : "未连接";
    el.className = "chip " + (ok ? "ok" : "");
    $("#qq-out").textContent = s.pluginInstalled ? "" : "官方 QQ Bot 插件未安装";
  } catch { $("#qq-status").textContent = "检测失败"; }
}

// ---- 能力中心 ----
function renderCapabilities() {
  return `
  <div class="view">
    <div class="page-head"><h2>🛠 能力中心</h2><p class="hint">工作模式的默认开关；聊天测试时可临时覆盖</p></div>
    <div class="two-col">
      <div class="card-box">
        <h3>默认能力</h3>
        <div class="form">
          <label>工具</label>
          <div class="cap-checks">
            <label><input type="checkbox" id="cap-code"> 写代码*</label>
            <label><input type="checkbox" id="cap-file"> 文件</label>
            <label><input type="checkbox" id="cap-search"> 搜索</label>
            <label><input type="checkbox" id="cap-weather"> 天气</label>
            <label><input type="checkbox" id="cap-memory"> 记忆</label>
          </div>
          <label>技能</label>
          <div class="cap-checks">
            <label><input type="checkbox" id="cap-skill-code"> 代码</label>
            <label><input type="checkbox" id="cap-skill-trans"> 翻译</label>
            <label><input type="checkbox" id="cap-skill-write"> 写作</label>
            <label><input type="checkbox" id="cap-skill-companion"> 陪伴</label>
          </div>
          <label>思考深度</label>
          <select id="cap-thinking">
            <option value="off">关闭</option><option value="auto" selected>自动</option>
            <option value="low">低</option><option value="medium">中</option>
            <option value="high">高</option><option value="extreme">极高</option>
          </select>
          <div class="row"><button id="btn-cap-save" class="primary">保存默认</button></div>
          <div id="cap-msg" class="status"></div>
        </div>
      </div>
      <div class="card-box">
        <h3>🔌 MCP 服务器</h3>
        <p class="hint">JSON 数组：{"name","command","args"}；工具默认需审批</p>
        <textarea id="mcp-config" rows="6" spellcheck="false"></textarea>
        <div class="row" style="margin-top:8px"><button id="btn-mcp-save" class="primary">保存并重连</button></div>
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
  $("#cap-memory").checked = tools.includes("memory_save");
  const skills = def.skills ?? [];
  $("#cap-skill-code").checked = skills.includes("code_expert");
  $("#cap-skill-trans").checked = skills.includes("translator");
  $("#cap-skill-write").checked = skills.includes("writing");
  $("#cap-skill-companion").checked = skills.includes("companion");
  $("#cap-thinking").value = def.thinking ?? "auto";
  $("#btn-cap-save").addEventListener("click", () => {
    const t = [];
    if ($("#cap-code").checked) t.push("code_exec");
    if ($("#cap-file").checked) t.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
    if ($("#cap-search").checked) t.push("web_search");
    if ($("#cap-weather").checked) t.push("weather");
    if ($("#cap-memory").checked) t.push("memory_save");
    const s = [];
    if ($("#cap-skill-code").checked) s.push("code_expert");
    if ($("#cap-skill-trans").checked) s.push("translator");
    if ($("#cap-skill-write").checked) s.push("writing");
    if ($("#cap-skill-companion").checked) s.push("companion");
    saveCapDefaults({ tools: t, skills: s, thinking: $("#cap-thinking").value });
    $("#cap-msg").textContent = "✓ 已保存";
  });
  $("#btn-mcp-save").addEventListener("click", async () => {
    try {
      const servers = JSON.parse($("#mcp-config").value);
      const r = await api.send("/api/mcp/config", { method: "POST", body: JSON.stringify({ servers }) });
      $("#mcp-msg").textContent = "✓ 已保存并重连，" + r.servers + " 个服务器";
    } catch (e) { $("#mcp-msg").textContent = "失败：" + e.message; }
  });
  api.get("/api/mcp/config").then((cfg) => { $("#mcp-config").value = JSON.stringify(cfg.servers, null, 2); }).catch(() => {});
}

// ---- 数据 / 设置 ----
function renderData() {
  return `
  <div class="view">
    <div class="page-head"><h2>📦 数据</h2><p class="hint">备份与记忆</p></div>
    <div class="two-col">
      <div class="card-box">
        <h3>📦 备份</h3>
        <p class="hint">全部卡片 + 记忆 + MCP 配置 → 一个 JSON</p>
        <button id="btn-backup" class="primary">下载备份</button>
      </div>
      <div class="card-box">
        <h3>全部记忆</h3>
        <div id="memory-list" class="small-out tall"></div>
      </div>
    </div>
  </div>`;
}
function initData() {
  $("#btn-backup").addEventListener("click", async () => {
    try {
      const r = await api.get("/api/backup");
      downloadDataUrl(r.dataUrl, r.filename);
      toast("✓ 备份已下载");
    } catch (e) { toast("备份失败：" + e.message, false); }
  });
  api.get("/api/memory").then((r) => {
    const el = $("#memory-list");
    el.textContent = Object.keys(r.memory ?? {}).length
      ? Object.entries(r.memory).map(([f, l]) => `📄 ${f}\n  ` + (l || []).join("\n  ")).join("\n\n")
      : "（还没有记忆）";
  }).catch(() => {});
}

function renderSettings() {
  return `
  <div class="view">
    <div class="page-head"><h2>⚙️ 设置</h2><p class="hint">服务信息与说明</p></div>
    <div class="two-col">
      <div class="card-box"><h3>服务信息</h3><div id="svc-info" class="small-out">读取中…</div></div>
      <div class="card-box"><h3>说明</h3>
        <ul class="guide">
          <li>本机：<code>http://127.0.0.1:17880</code></li>
          <li>公网：<code>https://openclaw.319274.xyz</code></li>
          <li>开关：桌面「openclaw-shell 开关.bat」（已配开机自启）</li>
          <li>数据全部在本机 <code>data/</code>，不上传</li>
        </ul>
      </div>
    </div>
  </div>`;
}
function initSettings() {
  api.get("/api/health").then((h) => {
    $("#svc-info").textContent = `服务：openclaw-shell\n版本：${h.schema}\n数据目录：${h.dataDir ?? "—"}\n监听：127.0.0.1:${h.port ?? "—"}`;
    $("#drawer-meta").textContent = `v${h.schema}`;
    $("#svc-dot").classList.add("on");
  }).catch(() => {
    $("#svc-info").textContent = "无法连接服务";
    $("#svc-dot").classList.add("bad");
  });
}

// ============================================================
//  路由表 + 启动
// ============================================================
const routes = {
  home: { render: renderHome, init: initHome },
  cards: { render: renderCards, init: initCards },
  create: { render: renderCreate, init: initCreate },
  distill: { render: renderDistill, init: initDistill },
  channels: { render: renderChannels, init: initChannels },
  api: { render: renderApi, init: initApi },
  imagegen: { render: renderImagegen, init: initImagegen },
  memory: { render: renderMemory, init: initMemory },
  capabilities: { render: renderCapabilities, init: initCapabilities },
  data: { render: renderData, init: initData },
  settings: { render: renderSettings, init: initSettings },
};

$("#btn-menu").addEventListener("click", openDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);
document.querySelectorAll(".drawer-nav a, .bottom-nav a").forEach((a) => a.addEventListener("click", closeDrawer));

router();
