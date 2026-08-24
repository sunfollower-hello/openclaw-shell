// openclaw-shell 前端 v3：白色主题 · 抽屉导航 · 表单化卡片 · 多提供商 · 每卡模型/记忆
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ================= 基础 =================
// 某些浏览器（如内嵌 webview）打开 URL 内嵌凭据（user:pass@host）时，页面内 fetch 不会自动携带，
// 首次 401 就用 URL 里的凭据显式重试一次
async function fetchApi(path, options = {}) {
  let r = await fetch(path, options);
  if (r.status === 401 && location.username) {
    const token = btoa(unescape(encodeURIComponent(`${location.username}:${location.password}`)));
    r = await fetch(path, {
      ...options,
      headers: { ...(options.headers ?? {}), Authorization: "Basic " + token },
    });
  }
  return r;
}
const api = {
  async get(path) {
    const r = await fetchApi(path);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  async send(path, options = {}) {
    const r = await fetchApi(path, { headers: { "Content-Type": "application/json" }, ...options });
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

// ================= 图标（内联 SVG，线性风格） =================
const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20z"/><path d="M9 21.5v-7h6v7"/>',
  layers: '<path d="M12 2.5 2.5 7.5 12 12.5l9.5-5z"/><path d="M2.5 16.5 12 21.5l9.5-5"/><path d="M2.5 12 12 17l9.5-5"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  flask: '<path d="M9.5 3h5"/><path d="M10 3v5.2L4.6 18.6A2 2 0 0 0 6.4 21.5h11.2a2 2 0 0 0 1.8-2.9L14 8.2V3"/><path d="M7.5 15h9"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 7.95z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15.5 16 10.5 5 21"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.8 5.2a9.5 9.5 0 0 1 0 13.6"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  bot: '<rect x="4" y="8.5" width="16" height="11.5" rx="2.5"/><path d="M12 8.5V5.5"/><circle cx="12" cy="3.8" r="1.3"/><path d="M9 14.5h.01M15 14.5h.01" stroke-width="2.4"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.35-4.35"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  shield: '<path d="M12 22s8-3.5 8-10V5.5L12 2 4 5.5V12c0 6.5 8 10 8 10z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clipboard: '<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4.5"/><path d="M12 8h.01"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
};
function icon(name, size) {
  return `<svg class="ic${size ? " ic-" + size : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

// ================= 用户资料（昵称/头像，后端 data/user-profile.json） =================
let userProfile = { name: "本地用户", avatar: "" };
function applyProfileToUI() {
  const avatarEl = $("#drawer-avatar");
  const nameEl = $("#drawer-uname");
  if (!avatarEl || !nameEl) return;
  if (userProfile.avatar) {
    avatarEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = userProfile.avatar;
    img.alt = "头像";
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (userProfile.name || "本").slice(0, 1);
  }
  nameEl.textContent = userProfile.name || "本地用户";
}
async function loadProfile() {
  try {
    userProfile = await api.get("/api/profile");
  } catch { /* 默认值 */ }
  applyProfileToUI();
  // 首页横幅可能已在资料加载前渲染，补一次同步
  const hash = (location.hash || "").replace(/^#\/?/, "") || "home";
  if (hash === "home") refreshHome();
}
function openProfileDialog() {
  const old = $("#profile-overlay");
  if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "profile-overlay";
  ov.className = "bot-overlay";
  ov.innerHTML = `<div class="bot-dialog profile-dialog">
    <div class="bot-dialog-head">
      <h3>${icon("user")} 编辑资料</h3>
      <button class="ghost small-btn" id="profile-close">${icon("x")}</button>
    </div>
    <div class="profile-body">
      <div class="profile-avatar-row">
        <div class="profile-avatar" id="profile-avatar-box">${userProfile.avatar ? `<img src="${userProfile.avatar}" alt="">` : (userProfile.name || "本").slice(0, 1)}</div>
        <div>
          <label class="btn-like">${icon("download")} 上传头像（PNG/JPG）
            <input type="file" id="profile-avatar-file" accept=".png,.jpg,.jpeg" hidden>
          </label>
          <button class="ghost small-btn" id="profile-avatar-remove">移除头像</button>
        </div>
      </div>
      <label>昵称</label>
      <input id="profile-name" maxlength="40" value="${escapeHtml(userProfile.name)}" placeholder="给自己起个名字">
      <div class="row" style="justify-content:flex-end;margin-top:8px">
        <button id="profile-save" class="primary">${icon("check")} 保存</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  $("#profile-close").addEventListener("click", () => ov.remove());
  let newAvatar = userProfile.avatar;
  $("#profile-avatar-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 1_000_000) return toast("头像请小于 1MB", false);
    const b64 = await fileToBase64(f);
    newAvatar = `data:${f.type || "image/png"};base64,${b64}`;
    $("#profile-avatar-box").innerHTML = `<img src="${newAvatar}" alt="">`;
  });
  $("#profile-avatar-remove").addEventListener("click", () => {
    newAvatar = "";
    $("#profile-avatar-box").textContent = ($("#profile-name").value || "本").slice(0, 1);
  });
  $("#profile-name").addEventListener("input", (e) => {
    if (!newAvatar) $("#profile-avatar-box").textContent = (e.target.value || "本").slice(0, 1);
  });
  $("#profile-save").addEventListener("click", async () => {
    const name = $("#profile-name").value.trim();
    if (!name) return toast("昵称不能为空", false);
    try {
      const r = await api.send("/api/profile", { method: "POST", body: JSON.stringify({ name, avatar: newAvatar }) });
      userProfile = r.profile;
      applyProfileToUI();
      ov.remove();
      toast("✓ 资料已保存");
      refreshHome();
    } catch (e) { toast("保存失败：" + e.message, false); }
  });
}

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
  document.querySelectorAll(".drawer-nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.route === hash)
  );
  route.init();
}
window.addEventListener("hashchange", router);

// ============================================================
//  卡片表单（做卡 / 编辑共用）
// ============================================================
function wbRowHTML(e) {
  const keys = Array.isArray(e?.keys) ? e.keys.join("、") : (e?.keys ?? "");
  return `<div class="wb-entry">
    <div class="wb-head">
      <input class="wb-comment" placeholder="条目名称（如：人物形象 / 世界观 / 人物关系）" value="${escapeHtml(e?.comment || e?.name || "")}">
      <span class="wb-flags">
        <label title="常驻条目始终生效，不靠关键词触发"><input type="checkbox" class="wb-constant" ${e?.constant ? "checked" : ""}> 常驻</label>
        <label><input type="checkbox" class="wb-enabled" ${e?.enabled !== false ? "checked" : ""}> 启用</label>
        <label title="多条条目同时触发时的排序">顺序 <input type="number" class="wb-order" min="0" value="${e?.insertion_order ?? 100}" style="width:56px"></label>
      </span>
      <button class="wb-del danger small-btn" type="button">${icon("x")}</button>
    </div>
    <input class="wb-keys" placeholder="触发关键词，逗号分隔（常驻条目可留空）" value="${escapeHtml(keys)}">
    <textarea class="wb-content" rows="4" placeholder="条目内容……（角色的血肉都写在这里：外貌、性格、语言风格、背景、喜好、雷区……）">${escapeHtml(e?.content ?? "")}</textarea>
  </div>`;
}

function cardFormHTML(mode) {
  return `
  <div class="cf-section"><h3>${icon("info")} 基本信息</h3>
    <div class="cf-grid">
      <div><label>名称</label><input id="cf-name" placeholder="如：许桃"></div>
      ${mode === "create" ? `<div><label>slug（留空自动）</label><input id="cf-slug" placeholder="xutao"></div>` : ""}
      ${mode === "create" ? `<div><label>关系类型</label>
        <select id="cf-role">
          <option value="friend">朋友</option><option value="family">家人</option>
          <option value="self">自己</option><option value="partner">前任/恋人</option>
          <option value="colleague">同事</option><option value="public-figure">偶像/角色</option>
        </select></div>` : ""}
    </div>
    <label>简介（一句话介绍角色，选填）</label>
    <textarea id="cf-bio" rows="2" placeholder="如：开甜品铺的 26 岁姑娘，嘴上凶巴巴，心里软乎乎的"></textarea>
    <label>头像（PNG，可选）</label>
    <div class="cf-avatar-row">
      <img id="cf-avatar-img" class="cf-avatar" style="display:none" alt="头像">
      <input type="file" id="cf-avatar" accept=".png">
    </div>
  </div>
  <div class="cf-section"><h3>${icon("message")} 开场白</h3>
    <textarea id="cf-first" rows="3" placeholder="新对话开始时，角色说/做的第一段话。写成一个有画面感的小场景，别只写一句问候"></textarea>
  </div>
  <div class="cf-section"><h3>${icon("book")} 世界书 <span class="hint">（角色的血肉都在这里；常驻条目始终生效，带关键词的条目被触发时注入）</span></h3>
    <div id="cf-book"></div>
    <button id="cf-book-add" class="ghost small-btn" type="button">${icon("plus")} 添加条目</button>
  </div>
  <div class="cf-section"><h3>${icon("zap")} 模型 <span class="hint">（此卡专用，留空跟随默认）</span></h3>
    <div class="cf-grid2">
      <div><label>API 提供商</label><select id="cf-provider"><option value="">（跟随默认）</option></select></div>
      <div><label>模型</label><select id="cf-model"><option value="">（跟随默认）</option></select></div>
    </div>
  </div>
  <div class="cf-section"><h3>${icon("database")} 记忆</h3>
    <label>每 <input id="cf-rounds" type="number" min="1" max="50" value="20" style="width:64px;display:inline-block;text-align:center"> 轮对话自动总结一次（1-50）</label>
  </div>`;
}

function bindCardForm(card, mode) {
  fillFormFromCard(card, mode);
  $("#cf-book-add").addEventListener("click", () => $("#cf-book").insertAdjacentHTML("beforeend", wbRowHTML({})));
  document.addEventListener("click", cardFormDelHandler);
  $("#cf-avatar").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const b64 = await fileToBase64(f);
    $("#cf-avatar-img").src = "data:image/png;base64," + b64;
    $("#cf-avatar-img").style.display = "block";
  });
  fillProvidersIntoForm(card);
}

function cardFormDelHandler(e) {
  if (e.target?.classList?.contains("wb-del")) {
    const container = e.target.closest("#cf-book");
    if (container?.id === "cf-book" && container.querySelectorAll(".wb-entry").length <= 1) {
      toast("世界书至少保留一条条目", false);
      return;
    }
    e.target.closest(".wb-entry")?.remove();
  }
}

function fillFormFromCard(card, mode) {
  const st = card.sillytavern_v2 ?? {};
  $("#cf-name").value = card.name ?? "";
  if (mode === "create" && $("#cf-slug")) $("#cf-slug").value = card.slug ?? "";
  if (mode === "create" && $("#cf-role")) $("#cf-role").value = card.identity?.role ?? "friend";
  // 简介框承载「一句话简介」；导入的酒馆卡如有完整角色档案（description），原样显示、原样保存
  $("#cf-bio").value = st.description || card.identity?.bio || "";
  $("#cf-first").value = st.first_mes ?? "";
  if (card.identity?.avatar) {
    $("#cf-avatar-img").src = card.identity.avatar;
    $("#cf-avatar-img").style.display = "block";
  } else {
    $("#cf-avatar-img").style.display = "none";
  }
  const entries = st.character_book?.entries?.length ? st.character_book.entries : [];
  $("#cf-book").innerHTML = entries.length ? entries.map(wbRowHTML).join("") : wbRowHTML({});
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
  card.sillytavern_v2 = card.sillytavern_v2 ?? {};
  const st = card.sillytavern_v2;
  const bioText = $("#cf-bio").value.trim();
  st.description = bioText;                 // 完整档案（酒馆卡可能很长，原样保存）
  card.identity.bio = bioText.length <= 500 ? bioText : ""; // 一句话简介超长则留空（校验限制 500）
  st.first_mes = $("#cf-first").value.trim();
  st.character_book = {
    entries: [...$("#cf-book").querySelectorAll(".wb-entry")]
      .map((r) => {
        const comment = r.querySelector(".wb-comment").value.trim();
        const keys = r.querySelector(".wb-keys").value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        return {
          name: comment || undefined,
          comment: comment || undefined,
          keys,
          content: r.querySelector(".wb-content").value,
          constant: r.querySelector(".wb-constant").checked,
          enabled: r.querySelector(".wb-enabled").checked,
          insertion_order: Number(r.querySelector(".wb-order").value) || 100,
          priority: 10,
        };
      })
      .filter((e) => e.content.trim()),
  };
  // 人格/语气/正则等结构化字段不在此编辑（写在世界书里），原样保留
  if (card.identity.avatar === undefined) card.identity.avatar = "";
  card.model = { provider: $("#cf-provider")?.value || undefined, model: $("#cf-model")?.value || undefined };
  card.memoryConfig = { auto_rounds: Math.min(50, Math.max(1, Number($("#cf-rounds").value) || 20)) };
  return card;
}

// ============================================================
//  视图：首页（欢迎横幅 + 公告 + 快捷入口 + 卡库速览）
// ============================================================
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function renderHome() {
  return `
  <div class="view home-view">
    <div class="home-hero">
      <div class="home-hero-main">
        <div class="home-hero-hi">${greeting()}，<span id="home-uname">${escapeHtml(userProfile.name)}</span></div>
        <div class="home-hero-sub" id="home-hero-sub">正在读取工作台状态…</div>
      </div>
      <div class="home-hero-avatar" id="home-avatar">${userProfile.avatar ? `<img src="${userProfile.avatar}" alt="">` : escapeHtml((userProfile.name || "本").slice(0, 1))}</div>
    </div>

    <div class="card-box home-notice">
      <h3>${icon("clipboard")} 公告</h3>
      <div id="home-notice-body" class="home-notice-body muted">—</div>
    </div>

    <div class="home-quick">
      <a class="quick-item" href="#/create">${icon("pen")}<span>做卡</span></a>
      <a class="quick-item" href="#/cards">${icon("layers")}<span>卡库</span></a>
      <a class="quick-item" href="#/distill">${icon("flask")}<span>蒸馏</span></a>
      <a class="quick-item" href="#/channels">${icon("chat")}<span>通道</span></a>
      <a class="quick-item" href="#/tts">${icon("volume")}<span>语音</span></a>
      <a class="quick-item" href="#/imagegen">${icon("image")}<span>生图</span></a>
    </div>

    <div class="card-box">
      <div class="home-cards-head"><h3>${icon("layers")} 卡库速览</h3><a class="ghost small-btn" href="#/cards">全部 →</a></div>
      <div id="home-card-grid" class="card-grid"></div>
    </div>
  </div>`;
}

function initHome() {
  refreshHome();
}

async function refreshHome() {
  try {
    // 资料可能刚改过，横幅昵称/头像同步一次
    const hiName = $("#home-uname");
    if (hiName) hiName.textContent = userProfile.name;
    const hiAvatar = $("#home-avatar");
    if (hiAvatar) {
      hiAvatar.innerHTML = userProfile.avatar
        ? `<img src="${userProfile.avatar}" alt="">`
        : escapeHtml((userProfile.name || "本").slice(0, 1));
    }
    const [ann, cards, active] = await Promise.all([
      api.get("/api/announcement").catch(() => ({ text: "" })),
      api.get("/api/cards").catch(() => ({ cards: [] })),
      api.get("/api/active-persona").catch(() => null),
    ]);
    const noticeBody = $("#home-notice-body");
    if (noticeBody) {
      noticeBody.classList.toggle("muted", !ann.text);
      noticeBody.textContent = ann.text || "暂无公告";
    }
    const sub = $("#home-hero-sub");
    if (sub) {
      const n = cards.cards?.length ?? 0;
      const persona = active?.active ? `当前人设「${active.active}」` : "还没有编译人设";
      sub.textContent = `${persona} · 卡库 ${n} 张`;
    }
    const grid = $("#home-card-grid");
    if (!grid) return;
    grid.innerHTML = "";
    if (!cards.cards?.length) {
      grid.innerHTML = `<div class="home-empty">${icon("layers")}<p>卡库还是空的</p><a class="btn-like primary" href="#/create">${icon("plus")} 做第一张卡</a></div>`;
      return;
    }
    for (const c of cards.cards.slice(-8).reverse()) {
      const d = document.createElement("div");
      d.className = "mini-card";
      d.innerHTML = `
        <div class="mini-avatar">${c.avatar ? `<img src="${c.avatar}" alt="">` : `<span>${escapeHtml(c.name.slice(0, 1))}</span>`}</div>
        <div class="mini-name">${escapeHtml(c.name)}</div>`;
      d.addEventListener("click", () => {
        location.hash = "#/cards";
        setTimeout(() => loadCardIntoEditor(c.slug), 60);
      });
      grid.appendChild(d);
    }
  } catch { /* 忽略 */ }
}

// ============================================================
//  视图：人设卡库（RP-Hub 式头像卡片网格 + 编辑表单）
// ============================================================
let cardsGridData = [];
let cardSearch = "";
let botsData = { bots: [] };

function renderCards() {
  return `
  <div class="view">
    <div id="cards-grid-view">
      <div class="lib-head">
        <div class="page-head" style="margin-bottom:0"><h2>人设卡库</h2></div>
        <div class="lib-actions">
          <input id="card-search" placeholder="检索角色卡名称…" value="${escapeHtml(cardSearch)}">
          <button id="btn-import-card" class="ghost">${icon("download")} 导入</button>
          <input type="file" id="import-file" accept=".png,.json" style="display:none">
          <a href="#/create" class="btn-like primary">${icon("plus")} 做卡</a>
        </div>
      </div>
      <div id="cards-grid" class="cards-grid"></div>
    </div>
    <div id="card-edit-view" style="display:none">
      <div class="editor-head">
        <button id="btn-back-grid" class="ghost">← 返回卡库</button>
        <h2 id="editor-title"></h2>
        <div class="editor-actions">
          <button id="btn-adv-config" class="ghost small-btn">${icon("settings")} 高级配置</button>
          <button id="btn-export-png" class="ghost small-btn">PNG</button>
          <button id="btn-export-json" class="ghost small-btn">JSON</button>
          <button id="btn-compile" class="small-btn">编译到通道</button>
          <button id="btn-del" class="danger small-btn">${icon("trash")} 删除</button>
          <button id="btn-save" class="primary small-btn">${icon("save")} 保存</button>
        </div>
      </div>
      <div id="card-form-area" class="card-form-area"></div>
      <div class="chat-test">
        <div class="chat-head">
          <h3>${icon("chat")} 聊天测试 <span id="chat-head-hint" class="hint">普通聊天</span></h3>
          <div>
            <button id="btn-work-mode" class="ghost small-btn">${icon("tool")} 工作模式</button>
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
    </div>
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
  $("#card-search").addEventListener("input", (e) => {
    cardSearch = e.target.value.trim();
    renderCardsGrid();
  });
  $("#btn-back-grid").addEventListener("click", showCardsGrid);
  $("#btn-adv-config").addEventListener("click", () => openAdvConfig());
  $("#btn-export-png").addEventListener("click", () => exportCard("png"));
  $("#btn-export-json").addEventListener("click", () => exportCard("json"));
  $("#btn-compile").addEventListener("click", compileCard);
  $("#btn-del").addEventListener("click", deleteCard);
  $("#btn-save").addEventListener("click", saveCard);
  $("#btn-chat-send").addEventListener("click", sendChat);
  $("#btn-chat-clear").addEventListener("click", clearChat);
  $("#btn-work-mode").addEventListener("click", toggleWorkMode);
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  loadCardsGrid();
}

async function loadCardsGrid() {
  try {
    const { cards } = await api.get("/api/cards");
    cardsGridData = cards;
    renderCardsGrid();
  } catch (e) { $("#cards-grid").innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`; }
  // 角标只需知道"有没有绑机器人"，用 skipStatus 快路径（不跑 openclaw CLI）
  api.get("/api/bots?skipStatus=1").then((b) => { botsData = b; renderCardsGrid(); }).catch(() => {});
}

async function refreshBots() {
  botsData = await api.get("/api/bots?skipStatus=1").catch(() => ({ bots: [] }));
  renderCardsGrid();
}

function renderCardsGrid() {
  const grid = $("#cards-grid");
  if (!grid) return;
  const kw = cardSearch.toLowerCase();
  const list = kw
    ? cardsGridData.filter((c) => c.name.toLowerCase().includes(kw) || c.slug.includes(kw))
    : cardsGridData;
  grid.innerHTML = "";
  if (!list.length) {
    grid.innerHTML = `<div class="muted" style="grid-column:1/-1;text-align:center;padding:40px 0">
      ${kw ? "没有匹配的角色卡" : "卡库是空的，点右上「＋ 做卡」创建第一张"}</div>`;
    return;
  }
  for (const c of list) {
    const bot = (botsData.bots ?? []).find((b) => b.cardSlug === c.slug);
    const d = document.createElement("div");
    d.className = "char-card";
    d.innerHTML = `
      <div class="char-card-img">
        ${c.avatar ? `<img src="${c.avatar}" alt="" loading="lazy">` : `<div class="char-card-ph">${escapeHtml(c.name.slice(0, 1))}</div>`}
        <button class="char-card-bot ${bot ? "on" : ""}" title="机器人配置（QQ/微信）">${icon("bot")}</button>
      </div>
      <div class="char-card-info">
        <div class="char-card-name">${escapeHtml(c.name)}</div>
        <div class="meta">${c.role} · v${c.version}${bot ? ` · <span class="bot-tag">已接${bot.channel === "qqbot" ? "QQ" : "微信"}</span>` : ""}</div>
      </div>`;
    d.addEventListener("click", () => loadCardIntoEditor(c.slug));
    d.querySelector(".char-card-bot").addEventListener("click", (e) => {
      e.stopPropagation();
      openBotDialog(c.slug);
    });
    grid.appendChild(d);
  }
}

// ============================================================
//  机器人配置弹窗（每卡一个独立 bot：卡 × 渠道账号 × OpenClaw agent）
// ============================================================
let botLoginTimer = null;
let botDialogSlug = "";

function closeBotDialog() {
  if (botLoginTimer) { clearInterval(botLoginTimer); botLoginTimer = null; }
  const ov = $("#bot-overlay");
  if (ov) ov.remove();
  botDialogSlug = "";
}

async function openBotDialog(slug) {
  closeBotDialog();
  botDialogSlug = slug;
  const card = cardsGridData.find((c) => c.slug === slug);
  if (!card) return;
  const render = (bot) => {
    // 弹窗可能已被关闭，重挂前先清掉旧的
    const old = $("#bot-overlay");
    if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "bot-overlay";
    ov.className = "bot-overlay";
    ov.innerHTML = `<div class="bot-dialog">
      <div class="bot-dialog-head">
        <h3>${icon("bot")} 机器人配置 · ${escapeHtml(card.name)}</h3>
        <button class="ghost small-btn" id="bot-close">${icon("x")}</button>
      </div>
      <div id="bot-dialog-body">${bot === undefined ? '<p class="muted">加载中…</p>' : ""}</div>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) closeBotDialog(); });
    $("#bot-close").addEventListener("click", closeBotDialog);
    if (bot !== undefined) renderBotBody(bot);
  };
  render(undefined);
  botsData = await api.get("/api/bots").catch(() => ({ bots: [] }));
  const bot = (botsData.bots ?? []).find((b) => b.cardSlug === slug);
  render(bot ?? null);
}

function renderBotBody(bot) {
  const body = $("#bot-dialog-body");
  if (!body) return;
  if (!bot) {
    const limits = botsData.limits ?? {};
    const bots = botsData.bots ?? [];
    const wxUsed = bots.some((b) => b.channel === "openclaw-weixin");
    const full = bots.length >= (limits.maxBots ?? 2);
    body.innerHTML = `
      <p class="muted">给这张卡建一个专属机器人：独立人设、独立会话记忆，接到 QQ 或微信。</p>
      <div class="bot-form">
        <label>渠道：
          <select id="bot-channel">
            <option value="qqbot">QQ 机器人${full ? "（已达上限）" : ""}</option>
            <option value="openclaw-weixin" ${wxUsed ? "disabled" : ""}>微信机器人${wxUsed ? "（已有 1 个，最多 1 个）" : ""}</option>
          </select>
        </label>
        <label>账号 ID：<input id="bot-account" placeholder="留空自动生成（如 qq-a1b2）"></label>
      </div>
      <p class="hint">上限 ${limits.maxBots ?? 2} 个机器人（当前 ${bots.length} 个）；QQ 需先在 <a href="https://q.qq.com/" target="_blank">q.qq.com</a> 创建机器人；微信需手机有 ClawBot 入口。</p>
      <div class="row" style="justify-content:flex-end">
        <button id="bot-create" class="primary" ${full ? "disabled" : ""}>创建机器人</button>
      </div>`;
    $("#bot-create").addEventListener("click", async () => {
      const btn = $("#bot-create");
      btn.disabled = true; btn.textContent = "创建中…（编译+建 agent）";
      try {
        const r = await api.send("/api/bots", {
          method: "POST",
          body: JSON.stringify({
            cardSlug: botDialogSlug,
            channel: $("#bot-channel").value,
            accountId: $("#bot-account").value.trim(),
          }),
        });
        toast("机器人已创建，接下来扫码绑定");
        // 后端刚 add 成功，直接采信 agentExists，省掉一次 CLI 查询
        renderBotBody({ ...r.bot, channelLabel: r.bot.channel === "qqbot" ? "QQ 机器人" : "微信机器人", agentExists: r.agentExists ?? null });
        refreshBots();
      } catch (e) {
        toast("创建失败：" + e.message, false);
        btn.disabled = false; btn.textContent = "创建机器人";
      }
    });
    return;
  }
  // 已有实例：详情 + 操作
  body.innerHTML = `
    <div class="bot-detail">
      <div class="bot-detail-row"><span>渠道</span><b>${bot.channelLabel ?? bot.channel}</b></div>
      <div class="bot-detail-row"><span>账号 ID</span><code>${escapeHtml(bot.accountId)}</code></div>
      <div class="bot-detail-row"><span>Agent</span><code>${escapeHtml(bot.agentId)}</code> ${bot.agentExists === true ? '<span class="ok-badge">已创建 ✓</span>' : bot.agentExists === false ? '<span class="warn-badge">agent 缺失</span>' : '<span class="muted">状态未知</span>'}</div>
      <div class="bot-detail-row"><span>Workspace</span><code>data/agent-workspaces/${escapeHtml(bot.cardSlug)}</code></div>
    </div>
    <div class="bot-login-area">
      <div class="row">
        <button id="bot-login" class="primary small-btn">扫码绑定此账号</button>
        <button id="bot-recompile" class="ghost small-btn">重编译（卡更新后）</button>
        <button id="bot-delete" class="danger small-btn">删除机器人</button>
      </div>
      <p class="hint" id="bot-login-msg"></p>
      <pre id="bot-qr" class="qr-box" style="display:none"></pre>
    </div>`;
  $("#bot-login").addEventListener("click", () => startBotLogin(bot.id));
  $("#bot-recompile").addEventListener("click", async () => {
    try {
      const r = await api.send(`/api/bots/${bot.id}/recompile`, { method: "POST" });
      toast(`已重编译 ${r.files?.length ?? 0} 个文件到 agent workspace`);
    } catch (e) { toast("重编译失败：" + e.message, false); }
  });
  $("#bot-delete").addEventListener("click", async () => {
    if (!confirm("删除这个机器人和它的 agent（渠道账号在平台侧的绑定不受影响）？")) return;
    try {
      await api.send(`/api/bots/${bot.id}`, { method: "DELETE" });
      toast("已删除");
      await refreshBots();
      renderBotBody(null);
    } catch (e) { toast("删除失败：" + e.message, false); }
  });
}

async function startBotLogin(botId) {
  const qr = $("#bot-qr"), msg = $("#bot-login-msg");
  if (!qr || !msg) return;
  try { await api.send(`/api/bots/${botId}/login`, { method: "POST" }); } catch (e) { msg.textContent = "发起失败：" + e.message; return; }
  qr.style.display = "block";
  msg.textContent = "二维码生成中…";
  if (botLoginTimer) clearInterval(botLoginTimer);
  botLoginTimer = setInterval(async () => {
    try {
      const s = await api.get(`/api/bots/${botId}/login`);
      if (s.output) { qr.textContent = s.output; qr.style.display = "block"; }
      if (s.done) {
        clearInterval(botLoginTimer); botLoginTimer = null;
        msg.textContent = s.ok ? "✓ 扫码成功，账号已绑定！网关重启后路由生效" : "✗ 未成功，检查输出后重试";
        refreshBots();
      }
    } catch { /* 轮询失败忽略 */ }
  }, 1500);
}

// ============================================================
//  高级配置（编辑卡时右上角入口）：机器人接入 + 模型 + 能力开关
// ============================================================
let advChatProviders = [];

function closeAdvConfig() {
  if (botLoginTimer) { clearInterval(botLoginTimer); botLoginTimer = null; }
  $("#adv-overlay")?.remove();
  botDialogSlug = "";
}

async function openAdvConfig() {
  if (!editingCard) return;
  closeAdvConfig();
  closeBotDialog();
  botDialogSlug = editingCard.slug;
  // 两个都走快路径：providers 读本地配置、bots 带 skipStatus 不跑 openclaw CLI（否则要等 5-15s）
  const [prov, bots] = await Promise.all([
    api.get("/api/providers").catch(() => ({ chat: [] })),
    api.get("/api/bots?skipStatus=1").catch(() => ({ bots: [] })),
  ]);
  advChatProviders = prov.chat ?? [];
  botsData = bots;
  const bot = (botsData.bots ?? []).find((b) => b.cardSlug === editingCard.slug);
  const cur = editingCard.model ?? {};
  const provOpts = [`<option value="">（跟随默认提供商）</option>`]
    .concat(advChatProviders.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === cur.provider ? "selected" : ""}>${escapeHtml(p.name)}${p.isDefault ? "（默认）" : ""}</option>`))
    .join("");
  const curProv = advChatProviders.find((p) => p.name === cur.provider);
  const modelOpts = [`<option value="">（用提供商第一个模型）</option>`]
    .concat((curProv?.models ?? []).map((m) => `<option value="${escapeHtml(m)}" ${m === cur.model ? "selected" : ""}>${escapeHtml(m)}</option>`))
    .join("");
  const enabledTools = new Set(editingCard.tools?.enabled ?? []);
  const ab = editingCard.abilities ?? {};
  const toolSwitch = (id, label, desc) => `
    <label class="adv-switch"><input type="checkbox" data-adv-tool="${id}" ${enabledTools.has(id) ? "checked" : ""}>
      <span><b>${label}</b><small>${desc}</small></span></label>`;
  const ov = document.createElement("div");
  ov.id = "adv-overlay";
  ov.className = "bot-overlay";
  ov.innerHTML = `<div class="bot-dialog adv-dialog">
    <div class="bot-dialog-head">
      <h3>${icon("settings")} 高级配置 · ${escapeHtml(editingCard.name)}</h3>
      <button class="ghost small-btn" id="adv-close">${icon("x")}</button>
    </div>

    <div class="adv-sec">
      <h4>${icon("zap")} 模型（这张卡单独用哪个模型）</h4>
      <div class="bot-form">
        <label>提供商：<select id="adv-model-provider">${provOpts}</select></label>
        <label>模型：<select id="adv-model-id">${modelOpts}</select></label>
      </div>
    </div>

    <div class="adv-sec">
      <h4>${icon("tool")} 能力开关（普通聊天与机器人的默认行为）</h4>
      <div class="adv-abilities">
        ${toolSwitch("web_search", "联网搜索", "可搜索实时信息")}
        ${toolSwitch("image_gen", "生图", "AI 画图（需在生图配置页设置上游）")}
        ${toolSwitch("code_exec", "写代码", "沙箱运行代码")}
        ${toolSwitch("memory_save", "长期记忆", "记住关于你和它的事")}
        ${toolSwitch("weather", "天气", "查天气预报")}
        ${toolSwitch("datetime", "时间", "报日期时间")}
        <label class="adv-switch"><input type="checkbox" id="adv-skill" ${ab.skills !== false ? "checked" : ""}>
          <span><b>技能库</b><small>代码专家/翻译/写作/陪伴</small></span></label>
        <label class="adv-switch"><input type="checkbox" id="adv-tts" ${ab.tts === true ? "checked" : ""}>
          <span><b>TTS 朗读</b><small>自动语音朗读回复（语音合成页配置）</small></span></label>
      </div>
      <p class="hint">网页「普通聊天」按这里的开关走；「工作模式」可临时手动勾选。</p>
    </div>

    <div class="adv-sec">
      <h4>${icon("bot")} 机器人接入（这张卡单独接 QQ / 微信）</h4>
      <div id="bot-dialog-body"></div>
    </div>

    <div class="row" style="justify-content:flex-end;margin-top:6px">
      <button id="adv-save" class="primary">保存配置</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeAdvConfig(); });
  $("#adv-close").addEventListener("click", closeAdvConfig);
  renderBotBody(bot ?? null);
  // 有实例时后台补 agent 存活状态（这一步要跑 openclaw CLI，不能挡面板显示）
  if (bot) {
    api.get("/api/bots").then((full) => {
      if (!$("#adv-overlay")) return; // 面板已关就别改 DOM
      botsData = full;
      const fresh = (full.bots ?? []).find((b) => b.cardSlug === botDialogSlug);
      if (fresh && !botLoginTimer) renderBotBody(fresh); // 正在扫码时不要重绘掉二维码
    }).catch(() => {});
  }

  $("#adv-model-provider").addEventListener("change", (e) => {
    const p = advChatProviders.find((x) => x.name === e.target.value);
    $("#adv-model-id").innerHTML = [`<option value="">（用提供商第一个模型）</option>`]
      .concat((p?.models ?? []).map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`))
      .join("");
  });

  $("#adv-save").addEventListener("click", async () => {
    const btn = $("#adv-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const provider = $("#adv-model-provider").value;
      const model = $("#adv-model-id").value;
      editingCard.model = provider ? { provider, ...(model ? { model } : {}) } : {};
      editingCard.tools = editingCard.tools ?? { enabled: [], policy: "auto", deny: [] };
      editingCard.tools.enabled = [...document.querySelectorAll("[data-adv-tool]")].filter((c) => c.checked).map((c) => c.dataset.advTool);
      editingCard.abilities = { skills: $("#adv-skill").checked, tts: $("#adv-tts").checked };
      const res = await api.send(`/api/cards/${editingCard.slug}`, { method: "PUT", body: JSON.stringify(editingCard) });
      editingCard = res.card ?? editingCard;
      toast("✓ 高级配置已保存 v" + editingCard.version);
      closeAdvConfig();
    } catch (e) {
      toast("保存失败：" + e.message, false);
      btn.disabled = false; btn.textContent = "保存配置";
    }
  });
}

/** 普通聊天的默认行为来自卡「高级配置」 */
function cardChatOptions() {
  const c = editingCard ?? {};
  const tools = Array.isArray(c.tools?.enabled) ? [...c.tools.enabled] : [];
  const skills = c.abilities?.skills === false ? [] : ["code_expert", "translator", "writing", "companion"];
  return { tools, useMCP: false, skills, thinking: "auto" };
}

function showCardsGrid() {
  $("#card-edit-view").style.display = "none";
  $("#cards-grid-view").style.display = "block";
  editingCard = null;
  loadCardsGrid();
}

async function loadCardIntoEditor(slug) {
  try {
    editingCard = await api.get(`/api/cards/${slug}`);
    chatHistory = [];
    $("#chat-log").innerHTML = "";
    $("#cards-grid-view").style.display = "none";
    $("#card-edit-view").style.display = "block";
    $("#editor-title").textContent = `编辑：${editingCard.name}`;
    $("#card-form-area").innerHTML = cardFormHTML("edit");
    bindCardForm(editingCard, "edit");
    $("#view").scrollTop = 0;
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
  showCardsGrid();
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
    <div class="page-head"><h2>做卡</h2><p class="hint">填写卡片内容 → 保存进卡库 → 可导出 PNG/JSON 或直接编译到通道</p></div>
    <div id="card-form-area" class="card-form-area">${cardFormHTML("create")}</div>
    <div class="create-actions">
      <button id="btn-create-save" class="primary big">${icon("save")} 保存卡片</button>
      <button id="btn-create-save-compile" class="big">保存并编译到通道</button>
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
function renderApi() { return renderProvidersPage("chat", "API 与模型", "对话 API 提供商；第一个为默认，卡片未单独指定时使用它。"); }
function renderImagegen() { return renderImgGenPage(); }

// 生图配置专用页（NovelAI / OpenAI 兼容 / 本地 SD WebUI 三套参数，网页聊天与 QQ/微信共用）
function renderImgGenPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>生图配置</h2><p class="hint">网页聊天与 QQ/微信机器人共用这一套生图配置。</p></div>
    <div class="card-box">
      <div class="form">
        <label>提供商</label>
        <div class="img-provider-row">
          <label class="radio"><input type="radio" name="ig-provider" value="novelai"> NovelAI（角色卡最佳）</label>
          <label class="radio"><input type="radio" name="ig-provider" value="openai"> OpenAI 兼容</label>
          <label class="radio"><input type="radio" name="ig-provider" value="local"> 本地 SD WebUI</label>
        </div>
        <div id="ig-pane-novelai" class="ig-pane">
          <label>API Key（留空 = 保留原值）</label>
          <input id="ig-nai-key" type="password" placeholder="sk-...">
          <div class="cf-grid2">
            <div><label>模型</label><input id="ig-nai-model" placeholder="nai-diffusion-4-5-full"></div>
            <div><label>采样器</label><select id="ig-nai-sampler">
              <option value="k_dpmpp_2m_sde">k_dpmpp_2m_sde（默认）</option>
              <option value="k_euler_ancestral">k_euler_ancestral</option>
              <option value="k_euler">k_euler</option>
              <option value="k_dpmpp_2m">k_dpmpp_2m</option>
              <option value="k_dpmpp_3m_sde">k_dpmpp_3m_sde</option>
              <option value="k_dpmpp_sde">k_dpmpp_sde</option>
              <option value="k_dpm_2">k_dpm_2</option>
              <option value="k_dpm_fast">k_dpm_fast</option>
            </select></div>
            <div><label>步数 Steps</label><input id="ig-nai-steps" type="number" min="1" max="50" step="1"></div>
            <div><label>尺度 Scale（CFG）</label><input id="ig-nai-scale" type="number" min="1" max="15" step="0.5"></div>
            <div><label>种子（0 = 随机）</label><input id="ig-nai-seed" type="number" step="1"></div>
            <div><label>负面预设</label><select id="ig-nai-ucpreset">
              <option value="heavy">Heavy（强负面）</option>
              <option value="light">Light（轻负面）</option>
              <option value="none">None（不加预设）</option>
            </select></div>
          </div>
          <label class="check"><input id="ig-nai-translate" type="checkbox"> 中文提示词自动翻译扩写为英文</label>
          <label>负面提示词（追加在预设之后）</label>
          <textarea id="ig-nai-negative" rows="2"></textarea>
        </div>
        <div id="ig-pane-openai" class="ig-pane" style="display:none">
          <div class="cf-grid2">
            <div><label>Base URL（以 /v1 结尾）</label><input id="ig-oai-url" placeholder="https://api.example.com/v1"></div>
            <div><label>模型</label><input id="ig-oai-model" placeholder="agnes-image-2.0-flash"></div>
          </div>
          <label>API Key（留空 = 保留原值）</label>
          <input id="ig-oai-key" type="password" placeholder="sk-...">
          <div class="cf-grid2">
            <div><label>默认尺寸</label><select id="ig-oai-size">
              <option value="1024x1024">1:1 方形</option>
              <option value="832x1216">2:3 竖版</option>
              <option value="1216x832">3:2 横版</option>
              <option value="768x1344">9:16 长竖版</option>
              <option value="1344x768">16:9 长横版</option>
            </select></div>
            <div></div>
          </div>
          <label class="check"><input id="ig-oai-translate" type="checkbox"> 中文提示词自动翻译扩写为英文</label>
        </div>
        <div id="ig-pane-local" class="ig-pane" style="display:none">
          <div class="cf-grid2">
            <div><label>Base URL（A1111/Forge，如 http://127.0.0.1:7860）</label><input id="ig-local-url" placeholder="http://127.0.0.1:7860"></div>
            <div><label>模型（可留空用默认）</label><input id="ig-local-model" placeholder=""></div>
            <div><label>步数</label><input id="ig-local-steps" type="number" min="1" max="60"></div>
            <div><label>CFG</label><input id="ig-local-cfg" type="number" min="1" max="30" step="0.5"></div>
            <div><label>采样器</label><input id="ig-local-sampler" placeholder="Euler a"></div>
          </div>
          <label>负面提示词</label>
          <textarea id="ig-local-negative" rows="2"></textarea>
        </div>
        <div class="row" style="margin-top:12px">
          <button id="ig-save" class="primary">${icon("save")} 保存配置</button>
          <button id="ig-test" class="ghost">测试 Key / 服务</button>
        </div>
        <div id="ig-status" class="status"></div>
      </div>
    </div>
    <div class="card-box">
      <h3>试生一张</h3>
      <div class="form">
        <label>提示词</label>
        <textarea id="ig-test-prompt" rows="2" placeholder="如：一个穿和服的少女，樱花树下，黄昏光线，精致细节"></textarea>
        <div class="row">
          <select id="ig-test-aspect">
            <option value="square">1:1 方形</option>
            <option value="portrait">2:3 竖版</option>
            <option value="landscape">3:2 横版</option>
            <option value="tall">9:16 长竖版</option>
            <option value="wide">16:9 长横版</option>
          </select>
          <button id="ig-test-go" class="primary">生成</button>
        </div>
        <div id="ig-test-status" class="status"></div>
        <div id="ig-test-img"></div>
      </div>
    </div>
    <div class="card-box">
      <h3>已生成图片</h3>
      <div class="form" style="margin-bottom:8px">
        <div class="row">
          <label style="white-space:nowrap">自动清理：保留最近</label>
          <input id="ig-retention" type="number" min="0" max="365" step="1" style="width:90px">
          <label style="white-space:nowrap">天的正式生图（0 = 不自动清理；试生图始终超 1 天即删）</label>
          <button id="ig-retention-save" class="ghost small-btn">保存</button>
        </div>
        <div id="ig-retention-status" class="status"></div>
      </div>
      <div id="ig-gallery" class="ig-gallery"><div class="muted">加载中…</div></div>
    </div>
  </div>`;
}

function renderProvidersPage(type, title, desc) {
  return `
  <div class="view">
    <div class="page-head"><h2>${title}</h2><p class="hint">${desc}</p></div>
    <div id="prov-list"></div>
    <button id="prov-add" class="primary">${icon("plus")} 添加提供商</button>
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
function initImagegen() { initImgGenPage(); }

// ---------- 生图配置页交互 ----------
function igRadio() {
  return document.querySelector('input[name="ig-provider"]:checked')?.value ?? "novelai";
}
function showIgPane(provider) {
  for (const p of ["novelai", "openai", "local"]) {
    const pane = $("#ig-pane-" + p);
    if (pane) pane.style.display = p === provider ? "block" : "none";
  }
}
function collectImgForm() {
  const v = (id) => { const el = $(id); return el ? el.value.trim() : ""; };
  return {
    provider: igRadio(),
    retentionDays: Number($("#ig-retention")?.value) || 0,
    novelai: {
      key: v("#ig-nai-key"),
      model: v("#ig-nai-model"),
      steps: Number(v("#ig-nai-steps")) || undefined,
      scale: Number(v("#ig-nai-scale")) || undefined,
      negative: v("#ig-nai-negative"),
      sampler: v("#ig-nai-sampler"),
      seed: Number(v("#ig-nai-seed")) || 0,
      ucPreset: v("#ig-nai-ucpreset") || "heavy",
      translate: !!$("#ig-nai-translate")?.checked,
    },
    openai: {
      baseUrl: v("#ig-oai-url"),
      key: v("#ig-oai-key"),
      model: v("#ig-oai-model"),
      size: v("#ig-oai-size"),
      translate: !!$("#ig-oai-translate")?.checked,
    },
    local: {
      baseUrl: v("#ig-local-url"),
      model: v("#ig-local-model"),
      steps: Number(v("#ig-local-steps")) || undefined,
      cfg: Number(v("#ig-local-cfg")) || undefined,
      sampler: v("#ig-local-sampler"),
      negative: v("#ig-local-negative"),
    },
  };
}
function fillImgForm(cfg) {
  document.querySelectorAll('input[name="ig-provider"]').forEach((r) => { r.checked = r.value === cfg.provider; });
  showIgPane(cfg.provider);
  const n = cfg.novelai || {}, o = cfg.openai || {}, l = cfg.local || {};
  if ($("#ig-retention")) $("#ig-retention").value = cfg.retentionDays ?? 30;
  if ($("#ig-nai-key")) $("#ig-nai-key").value = "";
  if ($("#ig-nai-model")) $("#ig-nai-model").value = n.model ?? "";
  if ($("#ig-nai-steps")) $("#ig-nai-steps").value = n.steps ?? 28;
  if ($("#ig-nai-scale")) $("#ig-nai-scale").value = n.scale ?? 6;
  if ($("#ig-nai-negative")) $("#ig-nai-negative").value = n.negative ?? "";
  if ($("#ig-nai-sampler")) $("#ig-nai-sampler").value = n.sampler ?? "k_dpmpp_2m_sde";
  if ($("#ig-nai-seed")) $("#ig-nai-seed").value = n.seed ?? 0;
  if ($("#ig-nai-ucpreset")) $("#ig-nai-ucpreset").value = n.ucPreset ?? "heavy";
  if ($("#ig-nai-translate")) $("#ig-nai-translate").checked = !!n.translate;
  if ($("#ig-oai-url")) $("#ig-oai-url").value = o.baseUrl ?? "";
  if ($("#ig-oai-key")) $("#ig-oai-key").value = "";
  if ($("#ig-oai-model")) $("#ig-oai-model").value = o.model ?? "";
  if ($("#ig-oai-size")) $("#ig-oai-size").value = o.size ?? "1024x1024";
  if ($("#ig-oai-translate")) $("#ig-oai-translate").checked = !!o.translate;
  if ($("#ig-local-url")) $("#ig-local-url").value = l.baseUrl ?? "";
  if ($("#ig-local-model")) $("#ig-local-model").value = l.model ?? "";
  if ($("#ig-local-steps")) $("#ig-local-steps").value = l.steps ?? 24;
  if ($("#ig-local-cfg")) $("#ig-local-cfg").value = l.cfg ?? 7;
  if ($("#ig-local-sampler")) $("#ig-local-sampler").value = l.sampler ?? "Euler a";
  if ($("#ig-local-negative")) $("#ig-local-negative").value = l.negative ?? "";
  const keyHint = n.key || o.key ? "（已有 Key，留空保留）" : "";
  if ($("#ig-nai-key")) $("#ig-nai-key").placeholder = "sk-..." + keyHint;
  if ($("#ig-oai-key")) $("#ig-oai-key").placeholder = "sk-..." + keyHint;
}
async function initImgGenPage() {
  document.querySelectorAll('input[name="ig-provider"]').forEach((r) =>
    r.addEventListener("change", () => showIgPane(igRadio()))
  );
  $("#ig-save").addEventListener("click", async () => {
    const f = collectImgForm();
    const r = await api.send("/api/image/config", { method: "POST", body: JSON.stringify(f) });
    if (r.ok) {
      toast(r.hint || "已保存");
      setStatus("#ig-status", "✓ 已保存", true);
    } else setStatus("#ig-status", "保存失败：" + (r.error ?? "未知错误"), false);
  });
  $("#ig-test").addEventListener("click", async () => {
    const f = collectImgForm();
    setStatus("#ig-status", "测试中…");
    const r = await api.send("/api/image/test", { method: "POST", body: JSON.stringify(f) });
    setStatus("#ig-status", r.info ?? "无返回", r.ok);
  });
  $("#ig-retention-save").addEventListener("click", async () => {
    const days = Number($("#ig-retention")?.value) || 0;
    const r = await api.send("/api/image/config", {
      method: "POST",
      body: JSON.stringify({ retentionDays: days }),
    });
    if (r.ok) {
      setStatus("#ig-retention-status", `✓ 已保存：正式生图保留 ${days} 天${days === 0 ? "（不自动清理）" : ""}`, true);
      loadImgGallery();
    } else setStatus("#ig-retention-status", "保存失败：" + (r.error ?? "未知错误"), false);
  });
  $("#ig-test-go").addEventListener("click", async () => {
    const prompt = $("#ig-test-prompt")?.value?.trim();
    if (!prompt) return toast("先填提示词", false);
    const f = collectImgForm();
    setStatus("#ig-test-status", "生成中（约 30-120 秒，请耐心等待）…");
    $("#ig-test-img").innerHTML = "";
    const btn = $("#ig-test-go");
    btn.disabled = true;
    try {
      const r = await api.send("/api/image/generate", {
        method: "POST",
        body: JSON.stringify({ prompt, aspect: $("#ig-test-aspect")?.value ?? "square", ...f }),
      });
      if (!r.ok || r.ok === false) {
        setStatus("#ig-test-status", "生成失败：" + (r.error ?? "未知错误"), false);
      } else {
        setStatus("#ig-test-status", `✓ 生成完成${r.promptUsed && r.promptUsed !== prompt ? "（提示词已翻译）" : ""}（${r.width}×${r.height}）`, true);
        $("#ig-test-img").innerHTML = `<img src="${r.url}" alt="测试图" onclick="showLightbox('${r.url}')">`;
        loadImgGallery();
      }
    } catch (e) {
      setStatus("#ig-test-status", "生成失败：" + e.message, false);
    } finally {
      btn.disabled = false;
    }
  });
  loadImgGallery();
  try {
    const cfg = await api.get("/api/image/config");
    fillImgForm(cfg);
  } catch (e) {
    setStatus("#ig-status", "读取配置失败：" + e.message, false);
  }
}
function setStatus(sel, text, ok) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.style.color = ok === undefined ? "" : ok ? "var(--ok,#2e7d32)" : "var(--err,#c62828)";
}
async function loadImgGallery() {
  const box = $("#ig-gallery");
  if (!box) return;
  try {
    const r = await api.get("/api/image/list");
    const imgs = r.images ?? [];
    if (!imgs.length) {
      box.innerHTML = `<div class="muted">还没有生成过图片</div>`;
      return;
    }
    box.innerHTML = imgs.map((it) => `
      <div class="ig-item">
        <img src="${it.url}" alt="${escapeHtml(it.file)}" loading="lazy" onclick="showLightbox('${it.url}')">
        <div class="ig-item-meta">${escapeHtml(it.dir)}/${escapeHtml(it.file)}<br>${(it.size / 1024).toFixed(0)} KB</div>
        <button class="danger small-btn" data-del="${it.url}">删除</button>
      </div>`).join("");
    box.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("删除这张图片？")) return;
        const r = await api.send("/api/image/delete", { method: "POST", body: JSON.stringify({ url: b.dataset.del }) });
        if (r.ok) { toast("已删除"); loadImgGallery(); } else toast("删除失败：" + (r.error ?? ""), false);
      })
    );
  } catch (e) {
    box.innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}
// 图片放大查看（遮罩层，点击任意处关闭）
function showLightbox(src) {
  const ov = document.createElement("div");
  ov.className = "lightbox";
  const img = document.createElement("img");
  img.src = src;
  ov.appendChild(img);
  ov.addEventListener("click", () => ov.remove());
  document.body.appendChild(ov);
}

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

// ============================================================
//  视图：语音合成 TTS（独立页：默认通道/本地兜底 + 提供商管理，同 API 页添加模式）
// ============================================================
const TTS_PRESETS = [
  { kind: "openai", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", voice: "FunAudioLLM/CosyVoice2-0.5B:alex", speed: 1, label: "OpenAI 兼容" },
  { kind: "openai", name: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", voice: "alloy", speed: 1, label: "OpenAI 兼容" },
  { kind: "minimax", name: "MiniMax 海螺", baseUrl: "https://api.minimaxi.com/v1", voice: "male-qn-qingse", speed: 1, label: "MiniMax 海螺（t2a_v2）" },
  { kind: "volc", name: "火山豆包", baseUrl: "https://openspeech.bytedance.com/api/v3/tts/unidirectional", voice: "zh_female_qingxin_mars_bigtts", speed: 1, label: "火山豆包（openspeech V3）" },
  { kind: "openai", name: "", baseUrl: "", voice: "", speed: 1, label: "自定义 OpenAI 兼容" },
];
const TTS_KIND_LABEL = { openai: "OpenAI 兼容", minimax: "MiniMax 海螺（t2a_v2）", volc: "火山豆包（openspeech V3）" };

function renderTtsPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>语音合成</h2><p class="hint">配置 TTS 上游与本地兜底；聊天气泡右上角的喇叭可朗读回复。</p></div>

    <div class="card-box">
      <h3>默认通道与本地兜底</h3>
      <div class="form">
        <div class="cf-grid">
          <div>
            <label>默认合成通道</label>
            <select id="tts-default"></select>
          </div>
          <div>
            <label>本地引擎</label>
            <select id="tts-local-engine">
              <option value="edge">Edge 神经语音（在线免费）</option>
              <option value="sapi">Windows SAPI（离线）</option>
            </select>
          </div>
          <div>
            <label>本地语音</label>
            <select id="tts-local-voice"></select>
          </div>
          <div>
            <label>语速</label>
            <input id="tts-local-rate" placeholder="+0%">
          </div>
          <div>
            <label>音调</label>
            <input id="tts-local-pitch" placeholder="+0Hz">
          </div>
        </div>
        <div class="row">
          <button id="tts-save-local" class="primary">保存设置</button>
          <button id="tts-test-local" class="ghost">测试本地</button>
          <span id="tts-test-msg" class="status"></span>
        </div>
      </div>
    </div>

    <div class="card-box">
      <h3>TTS 提供商 <span class="hint">选择服务商 → 填 Key → 自动拉取模型与音色</span></h3>
      <div id="tts-prov-list"></div>
      <button id="tts-prov-add" class="primary" style="margin-top:10px">${icon("plus")} 添加提供商</button>
      <div id="tts-prov-form" class="card-box" style="display:none;margin-top:12px">
        <h3 id="tts-pv-title">添加提供商</h3>
        <div class="form">
          <div class="cf-grid2">
            <div><label>选择 TTS 服务商</label>
              <select id="tts-pv-preset">
                <option value="">— 选择 —</option>
                ${TTS_PRESETS.map((p, i) => `<option value="${i}">${p.name || p.label}</option>`).join("")}
              </select>
            </div>
            <div><label>协议</label><input id="tts-pv-kind" readonly placeholder="选择服务商后自动填入"></div>
          </div>
          <div class="cf-grid2">
            <div><label>名称</label><input id="tts-pv-name" placeholder="如 硅基流动"></div>
            <div><label>Base URL</label><input id="tts-pv-url" placeholder="OpenAI 兼容以 /v1 结尾；豆包填完整接口地址"></div>
          </div>
          <div class="cf-grid2">
            <div><label>API Key（编辑留空=保留）</label><input id="tts-pv-key" type="password"></div>
            <div><label>App ID（仅火山豆包旧版鉴权）</label><input id="tts-pv-appid" placeholder="豆包新版单 Key 鉴权留空"></div>
          </div>
          <div class="cf-grid2">
            <div><label>默认模型</label><input id="tts-pv-model" placeholder="保存并拉取后点选填入"></div>
            <div><label>默认音色</label><input id="tts-pv-voice" placeholder="如 FunAudioLLM/CosyVoice2-0.5B:alex"></div>
          </div>
          <div class="cf-grid">
            <div><label>语速 (0.25~4)</label><input id="tts-pv-speed" type="number" step="0.1" value="1"></div>
            <div></div><div></div>
          </div>
          <label class="row"><input id="tts-pv-enabled" type="checkbox" checked> 启用此提供商（未启用时默认通道自动兜底本地）</label>
          <div class="row">
            <button id="tts-pv-save-fetch" class="primary">保存并拉取模型</button>
            <button id="tts-pv-done" class="ghost" style="display:none">完成</button>
            <button id="tts-pv-cancel" class="ghost">取消</button>
          </div>
          <div id="tts-pv-msg" class="status"></div>
          <div id="tts-pv-fetch" style="display:none">
            <label>拉取到的模型（点击填入「默认模型」）</label>
            <div id="tts-pv-models" class="model-chips"></div>
            <label>音色（如有，点击填入「默认音色」）</label>
            <div id="tts-pv-voices" class="model-chips"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card-box">
      <h3>用量统计</h3>
      <div id="tts-usage" class="hint">加载中…</div>
    </div>
  </div>`;
}

let ttsState = { providers: [], commonVoices: [], editingId: null, models: [], voices: [], editKind: "openai" };

async function initTtsPage() {
  ttsState = { providers: [], commonVoices: [], editingId: null, models: [], voices: [], editKind: "openai" };
  $("#tts-save-local").addEventListener("click", saveTtsLocal);
  $("#tts-test-local").addEventListener("click", () => testTtsTarget("local"));
  $("#tts-prov-add").addEventListener("click", () => showTtsProvForm(null));
  $("#tts-pv-cancel").addEventListener("click", () => ($("#tts-prov-form").style.display = "none"));
  $("#tts-pv-preset").addEventListener("change", ttsApplyPreset);
  $("#tts-pv-save-fetch").addEventListener("click", ttsProvSaveAndFetch);
  $("#tts-pv-done").addEventListener("click", saveTtsProvider);
  $("#tts-default").addEventListener("change", async (e) => {
    await saveTtsConfigOnly({ defaultProvider: e.target.value });
    toast("✓ 默认通道已切换");
  });
  await loadTtsConfig();
}

async function loadTtsConfig() {
  try {
    const cfg = await api.get("/api/tts/config");
    ttsState.providers = cfg.providers || [];
    ttsState.commonVoices = cfg.commonVoices || [];
    const sel = $("#tts-default");
    sel.innerHTML =
      '<option value="local">本地兜底</option>' +
      (cfg.providers || []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.enabled ? "" : "（未启用）"}</option>`).join("");
    sel.value = cfg.defaultProvider || "local";
    $("#tts-local-engine").value = cfg.local?.engine || "edge";
    const vSel = $("#tts-local-voice");
    vSel.innerHTML = (cfg.commonVoices || []).map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`).join("");
    vSel.value = cfg.local?.voice || "";
    $("#tts-local-rate").value = cfg.local?.rate || "+0%";
    $("#tts-local-pitch").value = cfg.local?.pitch || "+0Hz";
    renderTtsProviders();
    await loadTtsUsage();
  } catch (e) {
    $("#tts-prov-list").innerHTML = `<div class="card-box muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderTtsProviders() {
  const box = $("#tts-prov-list");
  if (!box) return;
  if (!ttsState.providers.length) {
    box.innerHTML = '<div class="card-box muted">还没有 TTS 提供商，点下方按钮添加（如 硅基流动）</div>';
    return;
  }
  box.innerHTML = "";
  ttsState.providers.forEach((p) => {
    const d = document.createElement("div");
    d.className = "prov-item";
    d.innerHTML = `
      <div class="prov-head">
        <b>${escapeHtml(p.name)}</b>
        ${p.enabled ? '<span class="chip ok">启用</span>' : '<span class="chip">停用</span>'}
        <span class="prov-btns">
          <button class="ghost small-btn" data-act="test">测试</button>
          <button class="ghost small-btn" data-act="edit">编辑</button>
          <button class="danger small-btn" data-act="del">删除</button>
        </span>
      </div>
      <div class="meta">${escapeHtml(p.baseUrl)} · key ${escapeHtml(p.key || "未填")} · ${escapeHtml(TTS_KIND_LABEL[p.kind] || p.kind || "openai")}</div>
      <div class="meta">模型 ${escapeHtml(p.model || "—")} · 音色 ${escapeHtml(p.voice || "—")} · 语速 ${p.speed ?? 1}</div>`;
    box.appendChild(d);
    d.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (b.dataset.act === "test") testTtsTarget(p.id);
        else if (b.dataset.act === "edit") showTtsProvForm(p);
        else if (b.dataset.act === "del") {
          if (!confirm(`删除提供商 ${p.name}？`)) return;
          await api.send(`/api/tts/providers/${p.id}`, { method: "DELETE" });
          toast("✓ 已删除");
          loadTtsConfig();
        }
      })
    );
  });
}

async function testTtsTarget(target) {
  const msg = $("#tts-test-msg");
  if (msg) { msg.textContent = "测试中…"; msg.className = "status"; }
  const r = await api.send("/api/tts/test", { method: "POST", body: JSON.stringify({ target }) });
  if (msg) { msg.textContent = (r.ok ? "✓ " : "✗ ") + r.info; msg.className = "status " + (r.ok ? "ok" : "err"); }
}

async function saveTtsLocal() {
  try {
    await saveTtsConfigOnly({
      defaultProvider: $("#tts-default").value,
      local: {
        engine: $("#tts-local-engine").value,
        voice: $("#tts-local-voice").value,
        rate: $("#tts-local-rate").value,
        pitch: $("#tts-local-pitch").value,
      },
    });
    toast("✓ TTS 设置已保存");
  } catch (e) { toast("保存失败：" + e.message, false); }
}

async function saveTtsConfigOnly(body) {
  return api.send("/api/tts/config", { method: "POST", body: JSON.stringify(body) });
}

function showTtsProvForm(p) {
  ttsState.editingId = p?.id ?? null;
  ttsState.editKind = p?.kind || "openai";
  ttsState.models = [];
  ttsState.voices = [];
  $("#tts-pv-title").textContent = p ? `编辑提供商：${p.name}` : "添加提供商";
  $("#tts-pv-name").value = p?.name ?? "";
  $("#tts-pv-url").value = p?.baseUrl ?? "";
  $("#tts-pv-appid").value = p?.appId ?? "";
  $("#tts-pv-model").value = p?.model ?? "";
  $("#tts-pv-voice").value = p?.voice ?? "";
  $("#tts-pv-key").value = "";
  $("#tts-pv-speed").value = p?.speed ?? 1;
  $("#tts-pv-enabled").checked = p ? p.enabled : true;
  // 服务商预设回显：编辑时 kind+baseUrl 都匹配才选中，否则归「自定义」；新添加默认「— 选择 —」让用户先选
  if (p) {
    const idx = TTS_PRESETS.findIndex((x) => x.kind === p.kind && x.baseUrl && x.baseUrl === p.baseUrl);
    $("#tts-pv-preset").value = idx >= 0 ? String(idx) : String(TTS_PRESETS.length - 1);
  } else {
    $("#tts-pv-preset").value = "";
  }
  $("#tts-pv-kind").value = TTS_KIND_LABEL[ttsState.editKind] || "OpenAI 兼容";
  $("#tts-pv-fetch").style.display = "none";
  $("#tts-pv-done").style.display = "none";
  $("#tts-pv-msg").textContent = "";
  $("#tts-prov-form").style.display = "block";
}

/** 表单当前的 kind（预设选中且预设带 baseUrl 时以预设为准，否则用编辑时记录的 kind） */
function ttsFormKind() {
  const preset = TTS_PRESETS[Number($("#tts-pv-preset").value)];
  if (preset && preset.baseUrl) return preset.kind;
  return ttsState.editKind || "openai";
}

function ttsFormBody() {
  return {
    id: ttsState.editingId || undefined,
    name: $("#tts-pv-name").value.trim(),
    kind: ttsFormKind(),
    baseUrl: $("#tts-pv-url").value.trim(),
    appId: $("#tts-pv-appid").value.trim(),
    model: $("#tts-pv-model").value.trim(),
    voice: $("#tts-pv-voice").value.trim(),
    key: $("#tts-pv-key").value.trim(),
    speed: Number($("#tts-pv-speed").value) || 1,
    enabled: $("#tts-pv-enabled").checked,
  };
}

function ttsApplyPreset() {
  const v = $("#tts-pv-preset").value;
  if (!v) return; // 「— 选择 —」占位不填充
  const p = TTS_PRESETS[Number(v)];
  if (!p) return;
  ttsState.editKind = p.kind;
  $("#tts-pv-name").value = p.name;
  $("#tts-pv-url").value = p.baseUrl;
  $("#tts-pv-kind").value = p.label;
  $("#tts-pv-voice").value = p.voice;
  $("#tts-pv-speed").value = p.speed;
  $("#tts-pv-key").value = "";
  $("#tts-pv-model").value = "";
  $("#tts-pv-appid").value = "";
  ttsState.models = [];
  ttsState.voices = [];
  $("#tts-pv-fetch").style.display = "none";
  $("#tts-pv-done").style.display = "none";
  $("#tts-pv-msg").textContent = "";
}

async function ttsProvSaveAndFetch() {
  const body = ttsFormBody();
  if (!body.name || !body.baseUrl) { toast("名称 / Base URL 必填", false); return; }
  $("#tts-pv-msg").textContent = "保存中，随后拉取模型…";
  try {
    const r = await api.send("/api/tts/providers", { method: "POST", body: JSON.stringify(body) });
    if (r.id) ttsState.editingId = r.id;
    const fr = await api.send("/api/tts/fetch-models", {
      method: "POST",
      body: JSON.stringify({ kind: body.kind, baseUrl: body.baseUrl, key: body.key || undefined }),
    });
    ttsState.models = fr.models || [];
    ttsState.voices = fr.voices || [];
    renderTtsChips("tts-pv-models", ttsState.models, "tts-pv-model", body.model);
    renderTtsChips("tts-pv-voices", ttsState.voices, "tts-pv-voice", body.voice);
    $("#tts-pv-fetch").style.display = "block";
    $("#tts-pv-done").style.display = "inline-block";
    $("#tts-pv-msg").textContent = `✓ 已保存；拉取到 ${ttsState.models.length} 个模型${ttsState.voices.length ? `、${ttsState.voices.length} 个音色` : ""}。点击模型/音色填入后点「完成」`;
    loadTtsConfig();
  } catch (e) {
    $("#tts-pv-msg").textContent = "失败：" + e.message;
  }
}

function renderTtsChips(boxId, items, inputId, chosen) {
  const box = $(boxId);
  if (!box) return;
  if (!items || !items.length) { box.innerHTML = '<div class="hint">（无，手动填写上方输入框）</div>'; return; }
  box.innerHTML = "";
  items.forEach((m) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "model-chip" + (m === chosen ? " on" : "");
    chip.textContent = m;
    chip.addEventListener("click", () => {
      const inp = $(inputId);
      if (inp) inp.value = m;
      box.querySelectorAll(".model-chip").forEach((c) => c.classList.remove("on"));
      chip.classList.add("on");
    });
    box.appendChild(chip);
  });
}

async function saveTtsProvider() {
  const body = ttsFormBody();
  if (!body.name || !body.baseUrl) { toast("名称 / Base URL 必填", false); return; }
  try {
    const r = await api.send("/api/tts/providers", { method: "POST", body: JSON.stringify(body) });
    toast(r.hint || "✓ 已保存");
    $("#tts-prov-form").style.display = "none";
    loadTtsConfig();
  } catch (e) {
    $("#tts-pv-msg").textContent = "保存失败：" + e.message;
  }
}

async function loadTtsUsage() {
  try {
    const u = await api.get("/api/tts/usage");
    const byProv = (u.byProvider || []).map((x) => `${x.id}(${x.calls}次/${x.chars}字符)`).join("、") || "—";
    $("#tts-usage").textContent = `共 ${u.total} 次调用（成功 ${u.ok} / 失败 ${u.fail}），成功合成 ${u.totalChars} 字符，24h 内 ${u.last24h} 次。按上游：${byProv}`;
    $("#tts-usage").className = "status";
  } catch { /* 用量加载失败不影响其余 */ }
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
//  视图：记忆（每卡配置 + 查看 + 单条管理）
// ============================================================
const MEM_CATS = ["信息", "偏好", "关系", "事件", "待定"];
const MEM_SRC_LABEL = { manual: "手动", auto: "自动总结", tool: "工具", legacy: "旧数据" };

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "刚刚";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderMemory() {
  return `
  <div class="view">
    <div class="page-head"><h2>记忆</h2><p class="hint">每张卡独立的长期记忆；可手动添加、单条编辑/删除</p></div>
    <div id="mem-cards" class="card-grid"></div>
    <div id="mem-detail" class="card-box" style="display:none">
      <h3 id="mem-title"></h3>
      <div class="row" style="align-items:center">
        <label>每 <input id="mem-rounds" type="number" min="1" max="50" style="width:64px;text-align:center"> 轮自动总结</label>
        <button id="mem-save-rounds" class="primary small-btn">保存</button>
        <button id="mem-clear" class="danger small-btn">清空此卡记忆</button>
      </div>
      <div class="row" style="align-items:center">
        <select id="mem-add-cat" style="width:auto"></select>
        <input id="mem-add-input" type="text" placeholder="添加一条记忆，例如：用户养了一只叫旺财的狗">
        <button id="mem-add-btn" class="primary small-btn">添加</button>
      </div>
      <input id="mem-search" type="text" placeholder="搜索记忆…" style="width:100%">
      <div id="mem-entries" class="small-out tall" style="max-height:520px;padding:4px 10px"></div>
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
  $("#mem-add-btn").addEventListener("click", addMemEntry);
  $("#mem-add-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addMemEntry(); });
  $("#mem-search").addEventListener("input", loadMemEntries);
  $("#mem-entries").addEventListener("click", onMemRowClick);
}

async function openMemDetail(slug) {
  memCard = await api.get(`/api/cards/${slug}`);
  $("#mem-detail").style.display = "block";
  $("#mem-title").textContent = `${memCard.name} 的记忆`;
  $("#mem-rounds").value = memCard.memoryConfig?.auto_rounds ?? 20;
  const catSel = $("#mem-add-cat");
  catSel.innerHTML = MEM_CATS.map((c) => `<option>${c}</option>`).join("");
  catSel.value = "信息";
  await loadMemEntries();
  $("#mem-detail").scrollIntoView({ behavior: "smooth" });
}

async function loadMemEntries() {
  if (!memCard) return;
  const mem = await api.get("/api/memory").catch(() => ({ memory: {} }));
  const entries = mem.memory?.[memCard.slug] ?? [];
  const q = ($("#mem-search")?.value ?? "").trim();
  const list = q ? entries.filter((e) => (e.fact + " " + e.cat).includes(q)) : entries;
  const el = $("#mem-entries");
  if (!list.length) { el.textContent = q ? "（没有匹配）" : "（还没有记忆）"; return; }
  el.innerHTML = list.slice().reverse().map(renderMemRow).join("");
}

function renderMemRow(e) {
  const src = MEM_SRC_LABEL[e.src] ?? e.src ?? "";
  return `<div class="mem-row" data-id="${escapeHtml(e.id)}">
    <span class="mem-badge cat-${escapeHtml(e.cat)}">${escapeHtml(e.cat)}</span>
    <span class="mem-fact">${escapeHtml(e.fact)}</span>
    <span class="mem-meta">${fmtTime(e.ts)}${src ? " · " + src : ""}</span>
    <span class="mem-ops">
      <button class="small-btn" data-act="edit" data-id="${escapeHtml(e.id)}">编辑</button>
      <button class="small-btn danger" data-act="del" data-id="${escapeHtml(e.id)}">删除</button>
    </span>
  </div>`;
}

function renderMemEditRow(e) {
  return `<div class="mem-row mem-edit" data-id="${escapeHtml(e.id)}">
    <select class="mem-edit-cat">${MEM_CATS.map((c) => `<option ${c === e.cat ? "selected" : ""}>${c}</option>`).join("")}</select>
    <input class="mem-edit-fact" type="text" value="${escapeHtml(e.fact)}">
    <span class="mem-ops">
      <button class="small-btn primary" data-act="save" data-id="${escapeHtml(e.id)}">保存</button>
      <button class="small-btn" data-act="cancel" data-id="${escapeHtml(e.id)}">取消</button>
    </span>
  </div>`;
}

async function onMemRowClick(ev) {
  const btn = ev.target.closest("button[data-act]");
  if (!btn || !memCard) return;
  const id = btn.dataset.id;
  const row = btn.closest(".mem-row");
  if (btn.dataset.act === "del") {
    if (!confirm("删除这条记忆？")) return;
    await api.send(`/api/memory/${memCard.slug}/delete`, { method: "POST", body: JSON.stringify({ id }) });
    loadMemEntries();
    toast("✓ 已删除");
  } else if (btn.dataset.act === "edit") {
    const mem = await api.get("/api/memory");
    const entry = (mem.memory?.[memCard.slug] ?? []).find((e) => e.id === id);
    if (entry) row.outerHTML = renderMemEditRow(entry);
  } else if (btn.dataset.act === "cancel") {
    const mem = await api.get("/api/memory");
    const entry = (mem.memory?.[memCard.slug] ?? []).find((e) => e.id === id);
    if (entry) row.outerHTML = renderMemRow(entry);
  } else if (btn.dataset.act === "save") {
    const editRow = btn.closest(".mem-edit");
    const fact = editRow.querySelector(".mem-edit-fact").value.trim();
    const cat = editRow.querySelector(".mem-edit-cat").value;
    if (!fact) { toast("事实不能为空", false); return; }
    const r = await api.send(`/api/memory/${memCard.slug}/update`, { method: "POST", body: JSON.stringify({ id, fact, cat }) });
    toast("✓ 已保存");
    loadMemEntries();
  }
}

async function addMemEntry() {
  if (!memCard) return;
  const fact = $("#mem-add-input").value.trim();
  if (!fact) { toast("请输入要记住的事实", false); return; }
  const cat = $("#mem-add-cat").value;
  const r = await api.send(`/api/memory/${memCard.slug}`, { method: "POST", body: JSON.stringify({ fact, cat }) });
  if (r.ok === false && r.duplicate) { toast("这条已经记住了", false); return; }
  if (!r.ok) { toast("添加失败", false); return; }
  $("#mem-add-input").value = "";
  await loadMemEntries();
  toast("✓ 已记住");
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
const CHAT_IMG_RE = /(\/img\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|gif))/gi;
function addChatBubble(role, text) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "bot");
  // 生图工具返回的 /img/... 路径渲染成可点击放大的图片
  const parts = String(text).split(CHAT_IMG_RE);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (i % 2 === 1) {
      const img = document.createElement("img");
      img.src = seg;
      img.className = "chat-img";
      img.alt = "AI 生成的图片";
      img.loading = "lazy";
      img.addEventListener("click", () => showLightbox(seg));
      div.appendChild(img);
    } else {
      div.appendChild(document.createTextNode(seg));
    }
  }
  if (role === "bot") {
    const btn = document.createElement("button");
    btn.className = "tts-speak-btn";
    btn.innerHTML = icon("volume");
    btn.title = "朗读这条回复";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      speakText(text);
    });
    div.appendChild(btn);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
let ttsAudio = null;
async function speakText(text) {
  try {
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
    const r = await api.send("/api/tts/synthesize", { method: "POST", body: JSON.stringify({ text: String(text).slice(0, 500) }) });
    ttsAudio = new Audio(r.url);
    ttsAudio.play();
  } catch (e) {
    toast("朗读失败：" + e.message, false);
  }
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
  btn.innerHTML = workMode ? `${icon("chat")} 聊天模式` : `${icon("tool")} 工作模式`;
  btn.classList.toggle("active", workMode);
  $(".chat-opts").style.display = workMode ? "flex" : "none";
  $("#chat-head-hint").textContent = workMode ? "工作模式：手动勾选工具/技能" : "普通聊天";
}
let lastChatOpts = null;
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
  // 工作模式=手动勾选；普通聊天=卡「高级配置」的模型工具技能
  lastChatOpts = workMode ? gatherChatOptions() : cardChatOptions();
  const opts = lastChatOpts;
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
    if (!workMode && editingCard?.abilities?.tts) speakText(r.reply); // 高级配置开了 TTS → 自动朗读
  } else if (r.type === "pending") {
    const bubble = addChatBubble("bot", "需要确认：机器人想调用\n" + r.pending.map((p) => "· " + p.name).join("\n"));
    const row = document.createElement("div");
    row.className = "approve-row";
    const ok = document.createElement("button");
    ok.className = "small-btn primary"; ok.textContent = "执行";
    const no = document.createElement("button");
    no.className = "small-btn danger"; no.textContent = "拒绝";
    pendingData = { slug: editingCard.slug, messages: r.messages, tools: lastChatOpts?.tools ?? gatherChatOptions().tools, useMCP: lastChatOpts?.useMCP ?? $("#tool-mcp").checked, approve: false };
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
    <div class="page-head"><h2>蒸馏工厂</h2><p class="hint">聊天记录 → 脱敏 → 四维蒸馏 → 人设卡</p></div>
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
        <h3>${icon("zap")} 直连 WeFlow（本机 5031）</h3>
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
    <div class="page-head"><h2>通道连接</h2><p class="hint">微信 / QQ 官方扫码绑定</p></div>
    <div class="two-col">
      <div class="card-box">
        <h3>微信 <span id="wx-status" class="chip">检测中…</span></h3>
        <p class="hint">腾讯官方通道，仅单聊；需微信有 ClawBot 入口（灰度）。</p>
        <div class="row"><button id="btn-wx-login" class="primary">开始扫码绑定</button><button id="btn-wx-refresh" class="ghost">刷新</button></div>
        <pre id="wx-qr" class="qr-box" style="display:none"></pre>
        <div id="wx-login-msg" class="status"></div>
        <h3>配对授权</h3>
        <div class="row"><input id="pairing-code" placeholder="配对码"><button id="btn-pair-approve" class="primary small-btn">批准</button></div>
        <pre id="pairing-list" class="small-out"></pre>
      </div>
      <div class="card-box">
        <h3>QQ <span id="qq-status" class="chip">检测中…</span></h3>
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
    <div class="page-head"><h2>能力中心</h2><p class="hint">工作模式的默认开关；聊天测试时可临时覆盖</p></div>
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
        <h3>MCP 服务器</h3>
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
    <div class="page-head"><h2>数据</h2><p class="hint">备份与记忆</p></div>
    <div class="two-col">
      <div class="card-box">
        <h3>备份</h3>
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
      ? Object.entries(r.memory).map(([f, entries]) =>
          `${f}\n  ` + (entries || []).map((e) => `[${e.cat}] ${e.fact}`).join("\n  ")).join("\n\n")
      : "（还没有记忆）";
  }).catch(() => {});
}

function renderSettings() {
  return `
  <div class="view">
    <div class="page-head"><h2>设置</h2><p class="hint">服务信息与说明</p></div>
    <div class="two-col">
      <div class="card-box">
        <h3>${icon("clipboard")} 首页公告</h3>
        <div class="form">
          <label>展示在首页公告卡（支持换行，留空则首页显示「暂无公告」）</label>
          <textarea id="notice-text" rows="5" maxlength="2000"></textarea>
          <div class="row"><button id="notice-save" class="primary">${icon("save")} 保存公告</button></div>
          <div id="notice-msg" class="status"></div>
        </div>
      </div>
      <div class="card-box"><h3>服务信息</h3><div id="svc-info" class="small-out">读取中…</div></div>
    </div>
    <div class="card-box"><h3>说明</h3>
      <ul class="guide">
        <li>本机：<code>http://127.0.0.1:17880</code></li>
        <li>公网：<code>https://soulbox.319274.xyz</code>（旧地址 openclaw.319274.xyz 同样可用）</li>
        <li>开关：桌面「openclaw-shell 开关.bat」（已配开机自启）</li>
        <li>数据全部在本机 <code>data/</code>，不上传</li>
      </ul>
    </div>
  </div>`;
}
function initSettings() {
  api.get("/api/announcement").then((a) => { $("#notice-text").value = a.text ?? ""; }).catch(() => {});
  $("#notice-save").addEventListener("click", async () => {
    try {
      await api.send("/api/announcement", { method: "POST", body: JSON.stringify({ text: $("#notice-text").value }) });
      $("#notice-msg").textContent = "✓ 已保存";
      toast("✓ 公告已更新");
    } catch (e) { $("#notice-msg").textContent = "保存失败：" + e.message; }
  });
  api.get("/api/health").then((h) => {
    $("#svc-info").textContent = `服务：SoulBox（openclaw-shell）\n版本：${h.schema}\n数据目录：${h.dataDir ?? "—"}\n监听：127.0.0.1:${h.port ?? "—"}`;
    $("#drawer-meta").textContent = `SoulBox v${h.schema}`;
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
  tts: { render: renderTtsPage, init: initTtsPage },
  memory: { render: renderMemory, init: initMemory },
  capabilities: { render: renderCapabilities, init: initCapabilities },
  data: { render: renderData, init: initData },
  settings: { render: renderSettings, init: initSettings },
};

$("#btn-menu").addEventListener("click", openDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);
$("#drawer-user-btn").addEventListener("click", openProfileDialog);
document.querySelectorAll(".drawer-nav a").forEach((a) => a.addEventListener("click", closeDrawer));
// 抽屉导航注入线性 SVG 图标（替代 emoji）
document.querySelectorAll(".drawer-nav a").forEach((a) => {
  a.insertAdjacentHTML("afterbegin", icon(a.dataset.icon));
});
// 先拿用户资料再渲染首页（横幅昵称/头像一次到位），失败不阻塞
loadProfile().finally(() => router());
