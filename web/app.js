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

// 关系类型：卡里存的是英文枚举，界面上一律显示中文（原来卡库直接把 friend/family 打给用户看）
const ROLE_LABEL = {
  self: "自己",
  friend: "朋友",
  family: "家人",
  partner: "恋人",
  colleague: "同事",
  "public-figure": "偶像·角色",
};
function roleLabel(role) {
  return ROLE_LABEL[role] ?? role ?? "";
}

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

// ================= 功能开关 =================
// 有争议或暂时难做好的能力先整体关掉：界面不显示、逻辑不启用（代码保留，将来想开只改这里）。
// 后端也有一份同名开关（src/core/features.ts），两边都关才算真的没启用。
const FEATURES = {
  skills: false,     // 技能库（内置 + 自定义）
  mcp: false,        // MCP 工具服务器
  workspace: false,  // 工作区文件面板 / 沙箱读写 / 代码执行
};

const DEFAULTS_KEY = "ocs_cap_defaults";
function capDefaults() {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}"); } catch { return {}; }
}
function saveCapDefaults(d) { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); }

// 工作模式总开关：开启后首页变为「工作台」（选卡当助手 + 聊天 + 工作区文件面板）
const WORKBENCH_KEY = "ocs_workbench_on";
function workbenchOn() { return localStorage.getItem(WORKBENCH_KEY) === "1"; }
function setWorkbenchOn(v) { localStorage.setItem(WORKBENCH_KEY, v ? "1" : "0"); }

// ================= 图标（内联 SVG，线性风格） =================
const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20z"/><path d="M9 21.5v-7h6v7"/>',
  layers: '<path d="M12 2.5 2.5 7.5 12 12.5l9.5-5z"/><path d="M2.5 16.5 12 21.5l9.5-5"/><path d="M2.5 12 12 17l9.5-5"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
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
  export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m12 3 5 5h-4v7h-2V8H7z"/>',
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
  store: '<path d="M3 9.5 4.5 4h15L21 9.5"/><path d="M4 9.5V20h16V9.5"/><path d="M9 20v-6h6v6"/><path d="M2.5 9.5h19"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
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
      <input id="profile-name" maxlength="40" value="${escapeHtml(userProfile.name)}" placeholder="AI 该怎么称呼你">
      <label>我的简介<span class="hint">（可留空；填了 AI 聊天时会知道你是谁）</span></label>
      <textarea id="profile-bio" class="cf-autogrow" rows="4" maxlength="800" placeholder="如：程序员，31 岁，喜欢机械和折腾自建服务；怕吵，说话直接一点没关系">${escapeHtml(userProfile.bio ?? "")}</textarea>
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
    if (f.size > 15_000_000) return toast("图片太大了（最大 15MB）", false);
    const b64 = await fileToBase64(f);
    // 1:1 裁切 + 压缩（程序内压缩，不再要求用户手动压小）
    openImageCropper({
      dataUrl: `data:${f.type || "image/png"};base64,${b64}`,
      targetSize: 256,
      format: "image/jpeg",
      quality: 0.85,
      title: "裁切头像",
      onDone: (dataUrl) => {
        newAvatar = dataUrl;
        $("#profile-avatar-box").innerHTML = `<img src="${dataUrl}" alt="">`;
      },
    });
  });
  $("#profile-avatar-remove").addEventListener("click", () => {
    newAvatar = "";
    $("#profile-avatar-box").textContent = ($("#profile-name").value || "本").slice(0, 1);
  });
  $("#profile-name").addEventListener("input", (e) => {
    if (!newAvatar) $("#profile-avatar-box").textContent = (e.target.value || "本").slice(0, 1);
  });
  autoGrow($("#profile-bio"));
  $("#profile-save").addEventListener("click", async () => {
    const name = $("#profile-name").value.trim();
    if (!name) return toast("昵称不能为空", false);
    try {
      const bio = $("#profile-bio").value.trim();
      const r = await api.send("/api/profile", { method: "POST", body: JSON.stringify({ name, avatar: newAvatar, bio }) });
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

/**
 * 切页前收尾：清掉上一页留下的轮询定时器和浮层。
 * 不清的话扫码轮询会一直跑（300ms 一次、每次都让后端重渲二维码），弹窗也会浮在新页面上。
 */
function cleanupBeforeRoute() {
  // 整段包 try：本函数在文件靠前处定义，而它清理的那些 let/const 声明在后面，
  // 首次 router() 时它们还在 TDZ 里，直接访问会抛 ReferenceError 把整个页面搞白屏。
  try {
    if (botLoginTimer) { clearInterval(botLoginTimer); botLoginTimer = null; }
    if (botLoginBotId) {
      void api.send(`/api/bots/${botLoginBotId}/login/cancel`, { method: "POST" }).catch(() => {});
      botLoginBotId = "";
    }
  } catch { /* 还没初始化，无需清理 */ }
  try {
    for (const k of Object.keys(loginTimers)) {
      if (loginTimers[k]) {
        clearInterval(loginTimers[k]);
        loginTimers[k] = null;
        // k 形如 /api/channels/qq/login，顺手让后端把挂着的登录进程杀掉
        void api.send(k + "/cancel", { method: "POST" }).catch(() => {});
      }
    }
  } catch { /* 同上 */ }
  try {
    if (lcEnterTimer) { clearTimeout(lcEnterTimer); lcEnterTimer = null; }
  } catch { /* 同上 */ }
  document.getElementById("bot-overlay")?.remove();
  document.getElementById("adv-overlay")?.remove();
  try {
    stopSpeak(); // 停掉正在朗读的语音并回收 Blob URL
  } catch { /* 同上 */ }
}

function router() {
  const hash = (location.hash || "").replace(/^#\/?/, "") || "home";
  const route = routes[hash] || routes.home;
  cleanupBeforeRoute();
  $("#view").innerHTML = route.render();
  closeDrawer();
  $("#view").scrollTop = 0;
  // 本地聊天是整页布局（自己内部滚动），容器要去掉内边距与外层滚动，避免双滚动条
  $("#view").classList.toggle("lc-host", hash === "home" && workbenchOn());
  document.querySelectorAll(".drawer-nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.route === hash)
  );
  route.init();
}
window.addEventListener("hashchange", router);

// ============================================================
//  卡片表单（做卡 / 编辑共用）
// ============================================================
const WB_POSITIONS = [
  ["before_char", "角色设定前"],
  ["after_char", "角色设定后"],
  ["at_depth", "按深度插入"],
  ["system_top", "系统顶部"],
  ["global_note", "全局备注"],
  ["user_top", "用户消息顶部"],
  ["assistant_top", "助手消息顶部"],
];

// 世界书条目：表面只显示一行（名称 + 启用 + 编辑 + 删除），点「编辑」展开全部字段
// idx：对应原 entries 下标，保存时用它取回表单没暴露的字段（secondary_keys/extensions/selective 等），避免编辑一次就削掉酒馆卡数据
function wbRowHTML(e, expand, idx) {
  const keys = Array.isArray(e?.keys) ? e.keys.join("、") : (e?.keys ?? "");
  const title = e?.comment || e?.name || "未命名条目";
  const pos = String(e?.position || "before_char");
  const keyList = keys.split("、").filter(Boolean);
  const summaryMeta = e?.constant
    ? "常驻"
    : keyList.length
      ? "触发：" + keyList.slice(0, 2).join("、") + (keyList.length > 2 ? "…" : "")
      : "";
  return `<div class="wb-entry${expand ? " open" : ""}"${Number.isInteger(idx) ? ` data-idx="${idx}"` : ""}>
    <div class="wb-summary">
      <span class="wb-title">${escapeHtml(title)}</span>
      ${summaryMeta ? `<span class="wb-summary-meta">${escapeHtml(summaryMeta)}</span>` : ""}
      <span class="wb-spacer-flex"></span>
      <label class="wb-enable" title="启用 / 停用此条目"><input type="checkbox" class="wb-enabled" ${e?.enabled !== false ? "checked" : ""}> 启用</label>
      <button class="wb-edit ghost small-btn" type="button" title="编辑条目">${icon("pen")} 编辑</button>
      <button class="wb-del danger small-btn" type="button" title="删除条目">${icon("trash")}</button>
    </div>
    <div class="wb-detail" ${expand ? "" : "hidden"}>
      <div class="wb-grid">
        <div class="wb-field"><label>条目名称</label><input class="wb-comment" placeholder="如：人物形象 / 世界观 / 人物关系" value="${escapeHtml(title)}"></div>
        <div class="wb-field"><label>触发关键词（逗号分隔，常驻条目可留空）</label><input class="wb-keys" placeholder="关键词1, 关键词2" value="${escapeHtml(keys)}"></div>
      </div>
      <div class="wb-field"><label>条目内容</label><textarea class="wb-content" rows="6" placeholder="角色设定：外貌、性格、语言风格、背景、喜好、雷区……">${escapeHtml(e?.content ?? "")}</textarea></div>
      <div class="wb-grid wb-grid3">
        <div class="wb-field"><label>插入位置</label>
          <select class="wb-pos">${WB_POSITIONS.map(([v, l]) => `<option value="${v}" ${pos === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
        <div class="wb-field"><label>触发概率 %</label><input type="number" class="wb-prob" min="0" max="100" value="${e?.probability ?? 100}"></div>
        <div class="wb-field"><label>深度</label><input type="number" class="wb-depth" min="0" value="${e?.depth ?? 4}"></div>
      </div>
      <div class="wb-adv-row">
        <label title="常驻条目始终生效，不靠关键词触发"><input type="checkbox" class="wb-constant" ${e?.constant ? "checked" : ""}> 常驻（始终生效）</label>
        <label title="多条条目同时触发时的排序">顺序 <input type="number" class="wb-order" min="0" value="${e?.insertion_order ?? 100}" style="width:56px"></label>
      </div>
      <div class="wb-foot">
        <button class="wb-cancel ghost small-btn" type="button">取消</button>
        <button class="wb-save primary small-btn" type="button">${icon("check")} 保存条目</button>
      </div>
    </div>
  </div>`;
}

/** 读取一个条目/正则行里所有输入控件的当前值（用于「取消」回退） */
function snapshotFields(root) {
  return [...root.querySelectorAll("input, textarea, select")].map((el) =>
    el.type === "checkbox" ? el.checked : el.value
  );
}
function restoreFields(root, snap) {
  [...root.querySelectorAll("input, textarea, select")].forEach((el, i) => {
    if (snap[i] === undefined) return;
    if (el.type === "checkbox") el.checked = snap[i];
    else el.value = snap[i];
  });
}

/** 折叠行展开时把原值存起来，「取消」能回退（世界书 + 正则通用） */
const foldSnapshots = new WeakMap();

function openFoldRow(row) {
  const detail = row.querySelector(".wb-detail, .rx-detail");
  if (!detail) return;
  foldSnapshots.set(row, snapshotFields(detail));
  detail.hidden = false;
  row.classList.add("open");
}
function closeFoldRow(row) {
  const detail = row.querySelector(".wb-detail, .rx-detail");
  if (!detail) return;
  detail.hidden = true;
  row.classList.remove("open");
}

// 世界书/正则折叠：编辑展开，保存收起并刷新摘要，取消回退原值
function cardFormEditHandler(e) {
  const row = e.target.closest(".wb-entry, .rx-row");
  if (!row) return;
  if (e.target.closest(".wb-edit, .rx-edit")) {
    if (row.classList.contains("open")) closeFoldRow(row);
    else openFoldRow(row);
    return;
  }
  if (e.target.closest(".wb-save, .rx-save")) {
    refreshFoldSummary(row);
    closeFoldRow(row);
    toast("条目已更新，记得点右上「保存」写入卡片");
    return;
  }
  if (e.target.closest(".wb-cancel, .rx-cancel")) {
    const snap = foldSnapshots.get(row);
    const detail = row.querySelector(".wb-detail, .rx-detail");
    if (snap && detail) restoreFields(detail, snap);
    closeFoldRow(row);
    return;
  }
}

/** 保存条目后刷新折叠行上的摘要文字（名称 / 常驻或触发词） */
function refreshFoldSummary(row) {
  if (row.classList.contains("wb-entry")) {
    const name = row.querySelector(".wb-comment")?.value.trim() || "未命名条目";
    const keys = (row.querySelector(".wb-keys")?.value ?? "").split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const constant = row.querySelector(".wb-constant")?.checked;
    row.querySelector(".wb-title").textContent = name;
    const meta = row.querySelector(".wb-summary-meta");
    const metaText = constant ? "常驻" : keys.length ? "触发：" + keys.slice(0, 2).join("、") + (keys.length > 2 ? "…" : "") : "";
    if (meta) {
      meta.textContent = metaText;
      meta.style.display = metaText ? "" : "none";
    } else if (metaText) {
      row.querySelector(".wb-title").insertAdjacentHTML("afterend", `<span class="wb-summary-meta">${escapeHtml(metaText)}</span>`);
    }
  } else {
    const name = row.querySelector(".rx-name")?.value.trim() || "未命名正则";
    const find = row.querySelector(".rx-find")?.value.trim() || "";
    row.querySelector(".rx-title").textContent = name;
    const meta = row.querySelector(".rx-summary-meta");
    if (meta) meta.textContent = find ? find.slice(0, 24) : "";
  }
}

// 正则替换行（可留空；导入的酒馆卡自带正则也会显示在这里）
function rxRowHTML(s, expand) {
  const name = s?.scriptName || "未命名正则";
  const find = s?.findRegex ?? "";
  return `<div class="rx-row${expand ? " open" : ""}">
    <div class="rx-summary">
      <span class="rx-title">${escapeHtml(name)}</span>
      <span class="rx-summary-meta">${escapeHtml(find.slice(0, 24))}</span>
      <span class="wb-spacer-flex"></span>
      <button class="rx-edit ghost small-btn" type="button" title="编辑正则">${icon("pen")} 编辑</button>
      <button class="rx-del danger small-btn" type="button" title="删除此正则">${icon("trash")}</button>
    </div>
    <div class="rx-detail" ${expand ? "" : "hidden"}>
      <div class="wb-field"><label>名称</label><input class="rx-name" placeholder="如：去星号" value="${escapeHtml(s?.scriptName ?? "")}"></div>
      <div class="wb-field"><label>查找（正则表达式）</label><input class="rx-find" placeholder="/\\*.*?\\*/g" value="${escapeHtml(find)}"></div>
      <div class="wb-field"><label>替换为</label><input class="rx-rep" placeholder="留空 = 删除匹配内容" value="${escapeHtml(s?.replaceString ?? "")}"></div>
      <div class="wb-foot">
        <button class="rx-cancel ghost small-btn" type="button">取消</button>
        <button class="rx-save primary small-btn" type="button">${icon("check")} 保存条目</button>
      </div>
    </div>
  </div>`;
}

function cardFormHTML(mode) {
  // 编辑已有卡：名称/简介在下方展示；做卡页的名称/简介/封面在顶部大图区
  const isCreate = mode === "create";
  const base = isCreate ? "" : `
  <div class="cf-section"><h3>基本信息</h3>
    <div class="cf-grid">
      <div><label>名称</label><input id="cf-name" placeholder="如：许桃"></div>
    </div>
    <label>简介</label>
    <textarea id="cf-bio" class="cf-autogrow" rows="3" placeholder="如：开甜品铺的 26 岁姑娘，嘴上凶巴巴，心里软乎乎的"></textarea>
  </div>`;
  return `
  ${base}
  <div class="cf-section"><h3>开场白</h3>
    <textarea id="cf-first" class="cf-autogrow" rows="3" placeholder="新对话开始时，角色说/做的第一段话。写成一个有画面感的小场景"></textarea>
  </div>
  <div class="cf-section"><h3>世界书</h3>
    <div id="cf-book"></div>
    <button id="cf-book-add" class="ghost small-btn" type="button">＋ 添加条目</button>
  </div>
  <details class="cf-section cf-fold">
    <summary>正则替换<span class="hint">（可选，一般留空）</span></summary>
    <div id="cf-regex"></div>
    <button id="cf-regex-add" class="ghost small-btn" type="button">＋ 添加正则</button>
  </details>`;
}

/** 简介/开场白按内容自动撑高，保证一眼看完不用滚动内框 */
function autoGrow(el) {
  if (!el) return;
  const fit = () => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight + 2, 900) + "px";
  };
  el.addEventListener("input", fit);
  fit();
}

function bindCardForm(card, mode) {
  fillFormFromCard(card, mode);
  $("#cf-book-add").addEventListener("click", () => {
    $("#cf-book").insertAdjacentHTML("beforeend", wbRowHTML({}, true));
    const last = $("#cf-book").lastElementChild?.querySelector(".wb-edit");
    last?.classList.add("open");
  });
  $("#cf-regex-add")?.addEventListener("click", () => $("#cf-regex")?.insertAdjacentHTML("beforeend", rxRowHTML({}, true)));
  document.addEventListener("click", cardFormDelHandler);
  document.addEventListener("click", cardFormEditHandler);
  // 头像只在「做卡」时可传；卡库里的卡不在这改头像
  $("#cf-avatar")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const b64 = await fileToBase64(f);
    $("#cf-avatar-img").src = "data:image/png;base64," + b64;
    $("#cf-avatar-img").style.display = "block";
  });
  autoGrow($("#cf-bio"));
  autoGrow($("#cf-first"));
}

function cardFormDelHandler(e) {
  const del = e.target.closest(".wb-del, .rx-del");
  if (!del) return;
  if (del.classList.contains("wb-del")) {
    const container = del.closest("#cf-book");
    if (container?.id === "cf-book" && container.querySelectorAll(".wb-entry").length <= 1) {
      toast("世界书至少保留一条条目", false);
      return;
    }
    del.closest(".wb-entry")?.remove();
  } else {
    del.closest(".rx-row")?.remove();
  }
}

function fillFormFromCard(card, mode) {
  const st = card.sillytavern_v2 ?? {};
  $("#cf-name").value = card.name ?? "";
  if (mode === "create" && $("#cf-role")) $("#cf-role").value = card.identity?.role ?? "friend";
  // 简介框承载「一句话简介」；导入的酒馆卡如有完整角色档案（description），原样显示、原样保存
  $("#cf-bio").value = st.description || card.identity?.bio || "";
  $("#cf-first").value = st.first_mes ?? "";
  // 头像只在「做卡」页存在；卡库编辑页没有这个控件
  const avatarImg = $("#cf-avatar-img");
  if (avatarImg) {
    if (card.identity?.avatar) {
      avatarImg.src = card.identity.avatar;
      avatarImg.style.display = "block";
    } else {
      avatarImg.style.display = "none";
    }
  }
  const entries = st.character_book?.entries?.length ? st.character_book.entries : [];
  // 全部折叠：表面只有一行摘要，点「编辑」才展开（参考 RP-Hub）；只有全新空条目才自动展开
  $("#cf-book").innerHTML = entries.length
    ? entries.map((en, i) => wbRowHTML(en, false, i)).join("")
    : wbRowHTML({}, true);
  if ($("#cf-regex")) $("#cf-regex").innerHTML = (st.regex_scripts ?? []).map(rxRowHTML).join("");
}

function collectCardForm(card, mode) {
  card.name = $("#cf-name").value.trim() || card.name;
  card.identity = card.identity ?? {};
  card.sillytavern_v2 = card.sillytavern_v2 ?? {};
  const st = card.sillytavern_v2;
  const bioText = $("#cf-bio").value.trim();
  st.description = bioText;                 // 完整档案（酒馆卡可能很长，原样保存）
  card.identity.bio = bioText.length <= 500 ? bioText : ""; // 一句话简介超长则留空（校验限制 500）
  st.first_mes = $("#cf-first").value.trim();
  // 数值取值：允许 0（原来的 Number(x)||默认 会把 0 变成默认值，导致"概率 0%"反而 100% 触发）
  const numOr = (el, def, min, max) => {
    const n = Number(el?.value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const prevEntries = st.character_book?.entries ?? [];
  st.character_book = {
    entries: [...$("#cf-book").querySelectorAll(".wb-entry")]
      .map((r) => {
        const comment = r.querySelector(".wb-comment").value.trim();
        const keys = r.querySelector(".wb-keys").value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        // 增量覆盖：保住表单没暴露的酒馆字段（secondary_keys / selective / extensions / id / use_regex 等）
        const idx = Number(r.dataset.idx);
        const base = Number.isInteger(idx) && prevEntries[idx] ? prevEntries[idx] : {};
        return {
          ...base,
          name: comment || undefined,
          comment: comment || undefined,
          keys,
          content: r.querySelector(".wb-content").value,
          constant: r.querySelector(".wb-constant").checked,
          enabled: r.querySelector(".wb-enabled").checked,
          insertion_order: numOr(r.querySelector(".wb-order"), 100, 0, 9999),
          priority: Number.isFinite(Number(base.priority)) ? Number(base.priority) : 10,
          position: r.querySelector(".wb-pos")?.value || "before_char",
          probability: numOr(r.querySelector(".wb-prob"), 100, 0, 100),
          depth: numOr(r.querySelector(".wb-depth"), 4, 0, 999),
        };
      })
      // 名称/关键词/内容全空才算废弃条目（原来只看 content，会静默吞掉填了一半的条目）
      .filter((e) => e.content.trim() || (e.comment ?? "").trim() || e.keys.length),
  };
  st.regex_scripts = [...$("#cf-regex").querySelectorAll(".rx-row")]
    .map((r) => ({
      scriptName: r.querySelector(".rx-name").value.trim(),
      findRegex: r.querySelector(".rx-find").value,
      replaceString: r.querySelector(".rx-rep").value,
      enabled: true,
    }))
    .filter((s) => s.findRegex);
  if (card.identity.avatar === undefined) card.identity.avatar = "";
  // 模型与记忆一律走「高级配置」弹窗，这里不碰（避免把弹窗刚设的值清掉）
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

/** 今天的日期 + 一句应景的诗词（按月份选，副标题用） */
function todayLine() {
  const d = new Date();
  const weeks = ["日", "一", "二", "三", "四", "五", "六"];
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${weeks[d.getDay()]}`;
  const poems = {
    1: "爆竹声中一岁除，春风送暖入屠苏。",
    2: "碧玉妆成一树高，万条垂下绿丝绦。",
    3: "等闲识得东风面，万紫千红总是春。",
    4: "人间四月芳菲尽，山寺桃花始盛开。",
    5: "小荷才露尖尖角，早有蜻蜓立上头。",
    6: "接天莲叶无穷碧，映日荷花别样红。",
    7: "绿树阴浓夏日长，楼台倒影入池塘。",
    8: "云天收夏色，木叶动秋声。",
    9: "自古逢秋悲寂寥，我言秋日胜春朝。",
    10: "停车坐爱枫林晚，霜叶红于二月花。",
    11: "落红不是无情物，化作春泥更护花。",
    12: "墙角数枝梅，凌寒独自开。",
  };
  return `${dateStr} · ${poems[d.getMonth() + 1] ?? ""}`;
}

function renderHome() {
  return workbenchOn() ? renderWorkbench() : `
  <div class="view home-view">
    <div class="home-hero">
      <div class="home-hero-main">
        <div class="home-hero-hi">${greeting()}，<span id="home-uname">${escapeHtml(userProfile.name)}</span></div>
        <div class="home-hero-sub" id="home-hero-sub">—</div>
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
  if (workbenchOn()) { initWorkbench(); return; }
  refreshHome();
}

async function refreshHome() {
  if (workbenchOn()) return; // 工作台形态不刷新欢迎页
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
    const [ann, cards] = await Promise.all([
      api.get("/api/announcement").catch(() => ({ text: "" })),
      api.get("/api/cards").catch(() => ({ cards: [] })),
    ]);
    const noticeBody = $("#home-notice-body");
    if (noticeBody) {
      noticeBody.classList.toggle("muted", !ann.text);
      noticeBody.textContent = ann.text || "暂无公告";
    }
    // 副标题 = 今天的日期 + 一句应景诗词（不再显示"当前人设"：共享 workspace 无法准确判断谁在生效）
    const sub = $("#home-hero-sub");
    if (sub) {
      sub.textContent = `${todayLine()}`;
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
//  工作台（工作模式首页）：选卡当助手 + 聊天 + 工作区文件面板
//  半独立式：普通用户默认纯聊天；开启工作模式后首页切换到这里
//  助手直接用卡库的角色卡（模型/世界书跟卡走），无需另配
// ============================================================
let wbSlug = "";
let wbCards = [];
let wbCardObj = null;
let wbChatHistory = [];
let wbPending = null;
let wbLastOpts = null;
let wbDir = "";

function renderWorkbench() {
  return `
  <div class="lc-root">
    <!-- 顶栏：头像 + 角色名 + 切卡 / 清空 / 退出 -->
    <div class="lc-top">
      <div class="lc-who" id="lc-who">
        <div class="lc-avatar" id="lc-avatar"></div>
        <div class="lc-who-text">
          <div class="lc-name" id="lc-name">选择角色卡</div>
          <div class="lc-sub" id="lc-sub">本地聊天</div>
        </div>
      </div>
      <div class="lc-top-actions">
        <select id="wb-card" class="lc-card-sel"><option value="">— 选择卡片 —</option></select>
        <button id="wb-chat-clear" class="ghost small-btn" title="清空对话">${icon("trash")}</button>
        <button id="wb-exit" class="ghost small-btn">退出本地聊天</button>
      </div>
    </div>

    <!-- 消息区 -->
    <div id="chat-log" class="lc-log"></div>

    <!-- 底部输入浮岛：工具行（联网搜索/思考深度/模型） + 输入行 -->
    <div class="lc-dock">
      <div class="lc-island">
        <div class="lc-tools">
          <button type="button" id="wb-websearch" class="lc-icon-btn" title="联网搜索" aria-pressed="false">${icon("search")}</button>
          <label class="lc-chip lc-chip-sel" title="思考深度">
            ${icon("zap")}
            <select id="wb-thinking">
              <option value="off">不思考</option><option value="auto" selected>自动</option>
              <option value="low">浅</option><option value="medium">中</option>
              <option value="high">深</option><option value="extreme">极深</option>
            </select>
          </label>
          <span class="lc-tools-gap"></span>
          <label class="lc-chip lc-chip-sel" title="模型商">
            <select id="lc-provider"><option value="">跟随卡片</option></select>
          </label>
          <label class="lc-chip lc-chip-sel lc-model-chip" title="模型">
            <select id="lc-model"><option value="">—</option></select>
          </label>
        </div>
        <div class="lc-input-row">
          <textarea id="wb-input" rows="1" placeholder="回车换行，双击回车发送…"></textarea>
          <button id="wb-send" class="lc-send" title="发送">${icon("send")}</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function initWorkbench() {
  const cards = await api.get("/api/cards").catch(() => ({ cards: [] }));
  wbCards = cards.cards ?? [];
  const sel = $("#wb-card");
  sel.innerHTML = `<option value="">— 选择卡片 —</option>` + wbCards.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join("");
  sel.addEventListener("change", () => wbPickCard(sel.value));
  $("#wb-send").addEventListener("click", wbSend);
  // 单击回车换行、双击回车发送（对齐 RP-Hub；中文输入法组字中不拦截）
  const input = $("#wb-input");
  input.addEventListener("keydown", wbInputEnter);
  input.addEventListener("input", () => wbAutoGrow(input));
  $("#wb-chat-clear").addEventListener("click", () => {
    if (wbChatHistory.length && !confirm("清空当前对话？")) return;
    wbChatHistory = []; wbPending = null; $("#chat-log").innerHTML = "";
  });
  // 退出走 SPA 内部切换，不整页重载（重载会重新拉 200KB 脚本，明显卡顿）
  $("#wb-exit").addEventListener("click", () => { setWorkbenchOn(false); router(); });
  // 聊天选项记住上次的选择
  const wbOpts = wbChatOpts();
  // 联网搜索：纯图标按钮，高亮即开启
  const ws = $("#wb-websearch");
  ws.classList.toggle("on", wbOpts.websearch === true);
  ws.setAttribute("aria-pressed", wbOpts.websearch === true ? "true" : "false");
  ws.addEventListener("click", () => {
    const on = !ws.classList.contains("on");
    ws.classList.toggle("on", on);
    ws.setAttribute("aria-pressed", on ? "true" : "false");
    saveWbChatOpts();
  });
  $("#wb-thinking").value = wbOpts.thinking ?? "auto";
  $("#wb-thinking").addEventListener("change", saveWbChatOpts);
  // 模型两级联动：先选模型商，再选它的模型
  $("#lc-provider").addEventListener("change", () => { fillLcModelOptions(""); saveWbChatOpts(); });
  $("#lc-model").addEventListener("change", saveWbChatOpts);
  await loadLcProviders(wbOpts.provider ?? "", wbOpts.model ?? "");
  // 工作区文件面板（FEATURES.workspace 关闭时不渲染，跳过绑定）
  if (FEATURES.workspace) {
    $("#wb-refresh").addEventListener("click", wbLoadFiles);
    $("#wb-new-file").addEventListener("click", wbNewFile);
    $("#wb-new-dir").addEventListener("click", wbNewDir);
    $("#wb-upload").addEventListener("click", () => $("#wb-upload-input").click());
    $("#wb-upload-input").addEventListener("change", wbUpload);
    $("#wb-list").addEventListener("click", wbFilesClick);
    $("#wb-crumb").addEventListener("click", wbFilesClick);
    wbLoadFiles(); // 工作区共享，不等选卡
  }
  const last = localStorage.getItem("ocs_workbench_slug");
  if (last) { sel.value = last; await wbPickCard(last); }
}

async function wbPickCard(slug) {
  wbSlug = slug;
  wbCardObj = null;
  wbChatHistory = [];
  wbPending = null;
  wbDir = "";
  $("#chat-log").innerHTML = "";
  localStorage.setItem("ocs_workbench_slug", slug);
  const nameEl = $("#lc-name");
  const subEl = $("#lc-sub");
  const avEl = $("#lc-avatar");
  if (slug) {
    wbCardObj = await api.get(`/api/cards/${slug}`).catch(() => null);
    const c = wbCardObj;
    if (nameEl) nameEl.textContent = c?.name ?? slug;
    if (avEl) {
      avEl.innerHTML = c?.identity?.avatar
        ? `<img src="${c.identity.avatar}" alt="">`
        : `<span>${escapeHtml((c?.name ?? "?").slice(0, 1))}</span>`;
    }
    const m = c?.model;
    if (subEl) subEl.textContent = m?.provider || m?.model ? `${m.provider ?? ""}${m.model ? " / " + m.model : ""}` : "跟随默认提供商";
    // 有开场白且还没聊过 → 先把开场白显示出来（不入历史，避免影响上下文）
    const first = c?.sillytavern_v2?.first_mes?.trim();
    if (first && !wbChatHistory.length) addChatBubble("bot", first);
  } else {
    if (nameEl) nameEl.textContent = "选择角色卡";
    if (subEl) subEl.textContent = "本地聊天";
    if (avEl) avEl.innerHTML = "";
  }
  if (FEATURES.workspace) wbLoadFiles();
}

// 本地聊天可用的模型商（已过滤停用项）
let lcProviders = [];

/** 模型商下拉：只列启用中的；选「跟随卡片」则用卡自己的模型设置 */
async function loadLcProviders(curProvider, curModel) {
  const sel = $("#lc-provider");
  if (!sel) return;
  try {
    const prov = await api.get("/api/providers");
    lcProviders = (prov.chat ?? []).filter((p) => p.enabled !== false);
  } catch { lcProviders = []; }
  const has = lcProviders.some((p) => p.name === curProvider);
  sel.innerHTML = [`<option value="">跟随卡片</option>`]
    .concat(lcProviders.map((p) => `<option value="${escapeHtml(p.name)}" ${has && p.name === curProvider ? "selected" : ""}>${escapeHtml(p.name)}</option>`))
    .join("");
  fillLcModelOptions(has ? curModel : "");
}

/** 按当前模型商填充模型下拉 */
function fillLcModelOptions(curModel) {
  const sel = $("#lc-model");
  if (!sel) return;
  const p = lcProviders.find((x) => x.name === $("#lc-provider")?.value);
  if (!p) { sel.innerHTML = `<option value="">—</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  const models = p.models ?? [];
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m)}" ${m === curModel ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")
    : `<option value="">—</option>`;
}

/** 输入框随内容长高（上限 160px） */
function wbAutoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

// 双击回车发送：420ms 内连按两次算发送，单击只换行
let lcEnterPending = false;
let lcEnterTimer = null;
function wbInputEnter(e) {
  if (e.key !== "Enter") return;
  if (e.isComposing || e.keyCode === 229) return; // 中文输入法组字中，别当发送
  if (e.shiftKey) return;                          // Shift+Enter 只换行
  if (lcEnterPending) {
    lcEnterPending = false;
    if (lcEnterTimer) { clearTimeout(lcEnterTimer); lcEnterTimer = null; }
    e.preventDefault();
    const el = $("#wb-input");
    el.value = el.value.replace(/(?:\r?\n)+$/, "").replace(/[ \t]+$/, ""); // 去掉第一次回车留下的空行
    if (el.value.trim()) wbSend();
    return;
  }
  lcEnterPending = true;
  if (lcEnterTimer) clearTimeout(lcEnterTimer);
  lcEnterTimer = setTimeout(() => { lcEnterPending = false; lcEnterTimer = null; }, 420);
  setTimeout(() => wbAutoGrow($("#wb-input")), 0);
}

// 工作台聊天选项（联网搜索 + 思考深度 + 模型），记在本地
const WB_OPTS_KEY = "ocs_wb_chat_opts";
function wbChatOpts() {
  try { return JSON.parse(localStorage.getItem(WB_OPTS_KEY) || "{}"); } catch { return {}; }
}
function saveWbChatOpts() {
  localStorage.setItem(WB_OPTS_KEY, JSON.stringify({
    websearch: $("#wb-websearch")?.classList.contains("on") === true,
    thinking: $("#wb-thinking")?.value ?? "auto",
    provider: $("#lc-provider")?.value ?? "",
    model: $("#lc-model")?.value ?? "",
  }));
}

/** 本次聊天的模型覆盖："提供商::模型"；选「跟随卡片」返回空串 */
function lcModelOverride() {
  const p = $("#lc-provider")?.value ?? "";
  const m = $("#lc-model")?.value ?? "";
  return p && m ? `${p}::${m}` : "";
}

async function wbSend() {
  const input = $("#wb-input");
  const message = input.value.trim();
  if (!message) return;
  if (!wbSlug) { addChatBubble("bot", "请先在顶部选一张卡片当助手。"); return; }
  addChatBubble("user", message);
  input.value = "";
  wbChatHistory.push({ role: "user", content: message });
  const btn = $("#wb-send");
  btn.disabled = true;
  wbAutoGrow(input); // 清空后收回高度
  // 能力跟随这张卡的「高级配置」；联网搜索由输入框旁的按钮临时叠加
  const cardTools = Array.isArray(wbCardObj?.tools?.enabled) ? [...wbCardObj.tools.enabled] : [];
  const tools = FEATURES.workspace ? cardTools : cardTools.filter((t) => !WORKSPACE_TOOL_IDS.includes(t));
  if ($("#wb-websearch")?.classList.contains("on") && !tools.includes("web_search")) tools.push("web_search");
  wbLastOpts = {
    tools,
    useMCP: false,
    skills: [],
    thinking: $("#wb-thinking")?.value ?? wbCardObj?.chat?.thinking ?? "auto",
    model: lcModelOverride(),
  };
  try {
    const r = await api.send("/api/chat", {
      method: "POST",
      body: JSON.stringify({ slug: wbSlug, message, history: wbChatHistory.slice(0, -1), ...wbLastOpts }),
    });
    await wbFinishTurn(r);
  } catch (e) {
    wbChatHistory.pop();
    addChatBubble("bot", "⚠ " + e.message);
  }
  btn.disabled = false;
}

async function wbFinishTurn(r) {
  if (r.type === "reply") {
    // 走真人化渲染：应用卡里的正则替换，开了「拆条发送」时按空行拆成多条气泡逐条冒出
    await addBotReplyHumanLike(r.reply);
    wbChatHistory.push({ role: "assistant", content: r.reply });
    if (wbCardObj?.abilities?.tts) speakText(r.reply); // 卡的高级配置开了 TTS → 自动朗读
  } else if (r.type === "pending") {
    const bubble = addChatBubble("bot", "需要确认：助手想调用\n" + r.pending.map((p) => "· " + p.name).join("\n"));
    const row = document.createElement("div");
    row.className = "approve-row";
    const ok = document.createElement("button");
    ok.className = "small-btn primary"; ok.textContent = "执行";
    const no = document.createElement("button");
    no.className = "small-btn danger"; no.textContent = "拒绝";
    wbPending = { slug: wbSlug, messages: r.messages, tools: wbLastOpts?.tools ?? [], useMCP: false, model: wbLastOpts?.model ?? "", approve: false };
    ok.addEventListener("click", async () => { row.remove(); wbPending.approve = true; await wbApprove(); });
    no.addEventListener("click", async () => { row.remove(); wbPending.approve = false; await wbApprove(); });
    row.append(ok, no);
    bubble.parentNode.appendChild(row);
  }
}

async function wbApprove() {
  const btn = $("#wb-send");
  btn.disabled = true;
  try {
    const r = await api.send("/api/chat/approve", { method: "POST", body: JSON.stringify(wbPending) });
    wbPending = null;
    await wbFinishTurn(r);
  } catch (e) { addChatBubble("bot", "⚠ " + e.message); }
  btn.disabled = false;
}

function wbPath(name) { return wbDir ? wbDir + "/" + name : name; }

// 工作区是所有卡共享的，不依赖当前选了哪张卡
async function wbLoadFiles() {
  const list = $("#wb-list");
  try {
    const r = await api.get(`/api/workspace/list?dir=${encodeURIComponent(wbDir)}`);
    wbRenderFiles(r);
  } catch (e) {
    list.innerHTML = '<span class="muted">读取失败：' + escapeHtml(e.message) + "</span>";
  }
}

function wbRenderFiles(r) {
  const crumb = $("#wb-crumb");
  const parts = (r.dir || "").split("/").filter(Boolean);
  let acc = "";
  crumb.innerHTML = '<a class="wb-crumb-item" data-wb-goto="">根目录</a>' + parts.map((p) => {
    acc += (acc ? "/" : "") + p;
    return `<span class="wb-crumb-sep">/</span><a class="wb-crumb-item" data-wb-goto="${escapeHtml(acc)}">${escapeHtml(p)}</a>`;
  }).join("");
  const list = $("#wb-list");
  list.innerHTML = "";
  if (!r.items.length) { list.innerHTML = '<span class="muted">（空目录）</span>'; return; }
  for (const it of r.items) {
    const row = document.createElement("div");
    row.className = "wb-file";
    if (it.dir) {
      row.innerHTML = `<span class="wb-file-ic">📁</span><a class="wb-file-name" data-wb-enter="${escapeHtml(it.name)}">${escapeHtml(it.name)}</a>`;
    } else {
      const size = it.size < 1024 ? it.size + " B" : (it.size / 1024).toFixed(1) + " KB";
      row.innerHTML = `<span class="wb-file-ic">📄</span><a class="wb-file-name" data-wb-dl="${escapeHtml(it.name)}" title="下载">${escapeHtml(it.name)}</a>
        <span class="wb-file-meta">${size}</span>
        <button class="ghost small-btn" data-wb-view="${escapeHtml(it.name)}">预览</button>
        <button class="ghost small-btn" data-wb-del="${escapeHtml(it.name)}">删除</button>`;
    }
    list.appendChild(row);
  }
}

function wbFilesClick(e) {
  const t = e.target.closest("[data-wb-enter],[data-wb-dl],[data-wb-view],[data-wb-del],[data-wb-goto]");
  if (!t) return;
  const tag = Object.keys(t.dataset).find((k) => k.startsWith("wb"));
  if (tag === "wbGoto") { wbDir = t.dataset.wbGoto; wbLoadFiles(); }
  else if (tag === "wbEnter") { wbDir = wbPath(t.dataset.wbEnter); wbLoadFiles(); }
  else if (tag === "wbDl") { window.open(`/api/workspace/download?slug=${encodeURIComponent(wbSlug)}&file=${encodeURIComponent(wbPath(t.dataset.wbDl))}`); }
  else if (tag === "wbView") { wbPreview(wbPath(t.dataset.wbView)); }
  else if (tag === "wbDel") { wbDelete(wbPath(t.dataset.wbDel)); }
}

function wbModal(title, fieldsHtml, onOk) {
  const ov = document.createElement("div");
  ov.className = "wb-modal-overlay";
  ov.innerHTML = `<div class="wb-modal">
    <h3>${title}</h3>
    ${fieldsHtml}
    <div class="row" style="justify-content:flex-end;margin-top:10px">
      <button class="ghost small-btn" data-wb-cancel>取消</button>
      <button class="primary small-btn" data-wb-ok>确定</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest("[data-wb-cancel]")) { ov.remove(); return; }
    if (e.target.closest("[data-wb-ok]")) { ov.remove(); onOk(); }
  });
}

function wbNewFile() {
  wbModal("新建文件", `
    <label>文件名（相对路径，如 notes/日记.md）</label>
    <input id="wb-nf-name" placeholder="文件名">
    <label>内容</label>
    <textarea id="wb-nf-content" rows="6"></textarea>`, async () => {
    const name = $("#wb-nf-name").value.trim();
    if (!name) return toast("文件名不能为空", false);
    await api.send("/api/workspace/write", { method: "POST", body: JSON.stringify({ slug: wbSlug, file: wbPath(name), content: $("#wb-nf-content").value }) });
    toast("✓ 已创建");
    wbLoadFiles();
  });
}

function wbNewDir() {
  wbModal("新建文件夹", `<label>文件夹名</label><input id="wb-nd-name" placeholder="如 src">`, async () => {
    const name = $("#wb-nd-name").value.trim();
    if (!name) return toast("名称不能为空", false);
    await api.send("/api/workspace/mkdir", { method: "POST", body: JSON.stringify({ slug: wbSlug, dir: wbPath(name) }) });
    toast("✓ 已创建");
    wbLoadFiles();
  });
}

function wbUpload(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) return toast("文件超过 1.5MB，暂不支持", false);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api.send("/api/workspace/upload", { method: "POST", body: JSON.stringify({ slug: wbSlug, file: wbPath(file.name), data: String(reader.result) }) });
      toast("✓ 已上传");
      wbLoadFiles();
    } catch (err) { toast("上传失败：" + err.message, false); }
  };
  reader.readAsDataURL(file);
}

function wbDelete(p) {
  if (!confirm(`删除 ${p}？不可恢复。`)) return;
  api.send("/api/workspace/delete", { method: "POST", body: JSON.stringify({ slug: wbSlug, path: p }) })
    .then(() => { toast("✓ 已删除"); wbLoadFiles(); })
    .catch((e) => toast("删除失败：" + e.message, false));
}

async function wbPreview(p) {
  try {
    const r = await fetch(`/api/workspace/download?slug=${encodeURIComponent(wbSlug)}&file=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error("读取失败 " + r.status);
    const text = await r.text();
    wbModal("预览：" + p, `<textarea id="wb-pv-content" rows="12" style="font-family:monospace">${escapeHtml(text.slice(0, 50000))}</textarea>`, async () => {
      await api.send("/api/workspace/write", { method: "POST", body: JSON.stringify({ slug: wbSlug, file: p, content: $("#wb-pv-content").value }) });
      toast("✓ 已保存");
      wbLoadFiles();
    });
  } catch (e) { toast("预览失败：" + e.message, false); }
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
          <button id="btn-local-chat" class="ghost small-btn">${icon("chat")} 本地聊天</button>
          <button id="btn-adv-config" class="ghost small-btn">${icon("settings")} 高级配置</button>
          <button id="btn-save" class="primary small-btn">${icon("save")} 保存</button>
        </div>
      </div>
      <div id="card-form-area" class="card-form-area"></div>
    </div>
  </div>`;
}

function initCards() {
  $("#btn-import-card").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", importCard);
  $("#card-search").addEventListener("input", (e) => {
    cardSearch = e.target.value.trim();
    renderCardsGrid();
  });
  $("#btn-back-grid").addEventListener("click", showCardsGrid);
  $("#btn-adv-config").addEventListener("click", () => openAdvConfig());
  $("#btn-local-chat").addEventListener("click", openLocalChat);
  $("#btn-save").addEventListener("click", saveCard);

  loadCardsGrid();
}

/** 本地聊天：以这张卡为形象进入聊天视图（SPA 内部切换，不整页重载） */
async function openLocalChat() {
  if (!editingCard) return;
  await saveCard();
  localStorage.setItem("ocs_workbench_slug", editingCard.slug);
  setWorkbenchOn(true);
  // 已经在 #/home 时 hashchange 不会触发，直接手动走一次路由
  if ((location.hash || "").replace(/^#\/?/, "") === "home") router();
  else location.hash = "#/home";
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
        <div class="char-card-ops">
          <button class="cc-op" data-op="png" title="导出 PNG 角色卡">${icon("export")}</button>
          <button class="cc-op" data-op="json" title="导出 JSON 角色卡">${icon("clipboard")}</button>
          <button class="cc-op" data-op="chatlog" title="导出聊天记录">${icon("chat")}</button>
          <button class="cc-op cc-del" data-op="del" title="删除这张卡">${icon("trash")}</button>
        </div>
      </div>
      <div class="char-card-info">
        <div class="char-card-name">${escapeHtml(c.name)}</div>
        <div class="meta">${roleLabel(c.role)} · v${c.version}${bot ? ` · <span class="bot-tag">已接${bot.channel === "qqbot" ? "QQ" : "微信"}</span>` : ""}</div>
      </div>`;
    d.addEventListener("click", () => loadCardIntoEditor(c.slug));
    d.querySelector(".char-card-bot").addEventListener("click", (e) => {
      e.stopPropagation();
      openBotDialog(c.slug);
    });
    d.querySelectorAll(".cc-op").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const op = b.dataset.op;
        if (op === "del") return deleteCardBySlug(c.slug, c.name);
        exportCardBySlug(c.slug, op);
      })
    );
    grid.appendChild(d);
  }
}

// ============================================================
//  机器人配置弹窗（每卡一个独立 bot：卡 × 渠道账号 × OpenClaw agent）
// ============================================================
let botLoginTimer = null;
let botDialogSlug = "";

let botLoginBotId = "";   // 正在扫码的机器人，关窗时通知后端把登录进程杀掉

function closeBotDialog() {
  if (botLoginTimer) { clearInterval(botLoginTimer); botLoginTimer = null; }
  // 登录进程会一直挂着等扫码（实测能占 200MB+），关窗就取消
  if (botLoginBotId) {
    void api.send(`/api/bots/${botLoginBotId}/login/cancel`, { method: "POST" }).catch(() => {});
    botLoginBotId = "";
  }
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
    const qqCount = bots.filter((b) => b.channel === "qqbot").length;
    const wxCount = bots.filter((b) => b.channel === "openclaw-weixin").length;
    const maxQq = limits.maxQq ?? 5;
    const maxWx = limits.maxWeixin ?? 1;
    const wxUsed = wxCount >= maxWx;
    // 按选中渠道判断是否满额（渠道切换时同步）
    const updateFullState = () => {
      const full = $("#bot-channel")?.value === "qqbot" ? qqCount >= maxQq : wxCount >= maxWx;
      const btn = $("#bot-create");
      if (btn) { btn.disabled = full; btn.title = full ? "该渠道已达上限" : ""; }
    };
    body.innerHTML = `
      <p class="muted">给这张卡建一个专属机器人：独立人设、独立会话记忆，接到 QQ 或微信。</p>
      <div class="bot-form">
        <label>渠道：
          <select id="bot-channel">
            <option value="qqbot">QQ 机器人${qqCount >= maxQq ? "（已达上限）" : ""}</option>
            <option value="openclaw-weixin" ${wxUsed ? "disabled" : ""}>微信机器人${wxUsed ? "（已有 1 个，最多 1 个）" : ""}</option>
          </select>
        </label>
        <label>账号 ID：<input id="bot-account" placeholder="留空自动生成"></label>
      </div>
      <p class="hint">上限：QQ ${maxQq} 个（当前 ${qqCount} 个）、微信 ${maxWx} 个（当前 ${wxCount} 个）；QQ 需先在 <a href="https://q.qq.com/" target="_blank">q.qq.com</a> 创建机器人；微信需手机有 ClawBot 入口。</p>
      <div class="row" style="justify-content:flex-end">
        <button id="bot-create" class="primary">创建机器人</button>
      </div>`;
    $("#bot-channel").addEventListener("change", updateFullState);
    updateFullState();
    $("#bot-create").addEventListener("click", async () => {
      const btn = $("#bot-create");
      btn.disabled = true; btn.textContent = "创建中…";
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
        // 账号被其他卡占用 → 一键转移（凭证复用不重新扫码）
        if (/占用/.test(e.message)) {
          const chan = $("#bot-channel").value;
          const acc = $("#bot-account").value.trim();
          const conn = await api.get("/api/channels/connections").catch(() => null);
          const occupier = conn?.bots?.find((b) => b.channel === chan && b.accountId === acc);
          if (occupier && confirm(`该账号已被「${occupier.cardSlug}」占用。一键转移：把账号从旧卡顶到当前卡？（凭证复用，不重新扫码）`)) {
            try {
              const r = await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId: occupier.id, toCardSlug: botDialogSlug }) });
              toast(r.ok ? "✓ 已转移" : "转移失败：" + (r.error ?? ""), r.ok);
              if (r.bot) renderBotBody({ ...r.bot, agentExists: true });
              refreshBots();
              return;
            } catch (err) { toast("转移失败：" + err.message, false); }
          } else {
            toast("创建失败：" + e.message, false);
          }
        } else {
          toast("创建失败：" + e.message, false);
        }
        updateFullState(); btn.textContent = "创建机器人";
      }
    });
    return;
  }
  // 已有实例：详情 + 操作
  body.innerHTML = `
    <div class="bot-detail">
      <div class="bot-detail-row"><span>接到哪</span><b>${bot.channelLabel ?? (bot.channel === "qqbot" ? "QQ 机器人" : "微信机器人")}</b></div>
      <div class="bot-detail-row"><span>机器人编号</span><code>${escapeHtml(bot.accountId)}</code></div>
      <div class="bot-detail-row"><span>运行状态</span>${bot.agentExists === true ? '<span class="ok-badge">正常 ✓</span>' : bot.agentExists === false ? '<span class="warn-badge">需要重新创建</span>' : '<span class="muted">检测中…</span>'}</div>
    </div>
    <div class="bot-login-area">
      <div class="row">
        <button id="bot-login" class="primary small-btn">扫码绑定此账号</button>
        <button id="bot-recompile" class="ghost small-btn">重新应用（卡更新后）</button>
        <button id="bot-delete" class="danger small-btn">删除机器人</button>
      </div>
      <p class="hint" id="bot-login-msg"></p>
      <pre id="bot-qr" class="qr-box" style="display:none"></pre>
      <div id="bot-qr-img" class="qr-img" style="display:none"></div>
      <a id="bot-qr-link" class="qr-link" target="_blank" style="display:none">扫不了？点这里在浏览器打开链接</a>
    </div>`;
  $("#bot-login").addEventListener("click", () => startBotLogin(bot.id));
  $("#bot-recompile").addEventListener("click", async () => {
    try {
      const r = await api.send(`/api/bots/${bot.id}/recompile`, { method: "POST" });
      toast(`已同步 ${r.files?.length ?? 0} 项内容给机器人`);
    } catch (e) { toast("重新应用失败：" + e.message, false); }
  });
  $("#bot-delete").addEventListener("click", async () => {
    if (!confirm("删除这个机器人？你在 QQ/微信 平台侧的账号不受影响")) return;
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
  const qrImg = $("#bot-qr-img"), qrLink = $("#bot-qr-link");
  if (!qr || !msg) return;
  try { await api.send(`/api/bots/${botId}/login`, { method: "POST" }); } catch (e) { msg.textContent = "发起失败：" + e.message; return; }
  botLoginBotId = botId; // 记下来，关窗时取消登录进程
  msg.textContent = "二维码生成中…";
  if (botLoginTimer) clearInterval(botLoginTimer);
  // 二维码出现前用 300ms 快轮询抢首帧，拿到码后降到 1.5s 省资源
  let gotQr = false;
  const poll = async () => {
    try {
      const s = await api.get(`/api/bots/${botId}/login`);
      // 优先用后端渲染的高清二维码图片；拿不到 URL 再退回终端 ASCII 码
      if (s.qrDataUrl && qrImg) {
        qrImg.innerHTML = `<img src="${s.qrDataUrl}" alt="扫码二维码">`;
        qrImg.style.display = "block";
        qr.style.display = "none";
        if (qrLink && s.qrUrl) { qrLink.href = s.qrUrl; qrLink.style.display = "block"; }
      } else if (s.output) {
        qr.textContent = s.output;
        qr.style.display = "block";
      }
      if ((s.qrDataUrl || s.output) && !gotQr) {
        gotQr = true;
        msg.textContent = "请用手机扫码";
        clearInterval(botLoginTimer);
        botLoginTimer = setInterval(poll, 1500);
      }
      if (s.done) {
        clearInterval(botLoginTimer); botLoginTimer = null;
        msg.textContent = s.ok ? "扫码成功，账号已绑定（网关重启后路由生效）" : "未成功，检查输出后重试";
        refreshBots();
      }
    } catch { /* 轮询失败忽略 */ }
  };
  poll();
  botLoginTimer = setInterval(poll, 300);
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
    loadPresetStore(),
  ]);
  // 停用的提供商不出现在选择框里
  advChatProviders = (prov.chat ?? []).filter((p) => p.enabled !== false);
  botsData = bots;
  const bot = (botsData.bots ?? []).find((b) => b.cardSlug === editingCard.slug);
  const cur = editingCard.model ?? {};
  // 未指定时，直接落到真实默认值（第一个启用的提供商 + 它的第一个模型），不显示"默认…"之类提示
  const fallbackProv = advChatProviders[0];
  // 卡里选的提供商若已被停用/删除，就落回默认那个（用它的真实名字填充，不写提示语）
  const curProvName = advChatProviders.some((p) => p.name === cur.provider)
    ? cur.provider
    : (fallbackProv?.name ?? "");
  const provOpts = advChatProviders
    .map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === curProvName ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("") || `<option value=""></option>`;
  const curProv = advChatProviders.find((p) => p.name === curProvName);
  const curModel = curProv?.models?.includes(cur.model) ? cur.model : (curProv?.models?.[0] ?? "");
  const modelOpts = (curProv?.models ?? [])
    .map((m) => `<option value="${escapeHtml(m)}" ${m === curModel ? "selected" : ""}>${escapeHtml(m)}</option>`)
    .join("") || `<option value=""></option>`;
  const memCfg = editingCard.memoryConfig ?? {};
  const enabledTools = new Set(editingCard.tools?.enabled ?? []);
  const ab = editingCard.abilities ?? {};
  const cardPresets = editingCard.presets ?? {};
  const tierOpts = [`<option value="">（不使用档位）</option>`]
    .concat(presetStoreData.tiers.map((t) => `<option value="${escapeHtml(t.id)}" ${cardPresets.tier === t.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`))
    .join("");
  const styleOpts = [`<option value="">（不使用风格）</option>`]
    .concat(presetStoreData.styles.map((s) => `<option value="${escapeHtml(s.id)}" ${cardPresets.style === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`))
    .join("");
  // 能力开关：高亮按钮式（不用勾选框，不写说明文字）
  const capBtn = (key, label, on) =>
    `<button type="button" class="cap-toggle${on ? " on" : ""}" data-cap="${key}">${label}</button>`;
  const ov = document.createElement("div");
  ov.id = "adv-overlay";
  ov.className = "bot-overlay";
  ov.innerHTML = `<div class="bot-dialog adv-dialog">
    <div class="bot-dialog-head">
      <h3>${icon("settings")} 高级配置 · ${escapeHtml(editingCard.name)}</h3>
      <button class="ghost small-btn" id="adv-close">${icon("x")}</button>
    </div>

    <div class="adv-sec">
      <h4>${icon("zap")} 模型</h4>
      <div class="adv-grid2">
        <label>提供商<select id="adv-model-provider">${provOpts}</select></label>
        <label>模型<select id="adv-model-id">${modelOpts}</select></label>
      </div>
    </div>

    <div class="adv-sec">
      <h4>${icon("tool")} 能力</h4>
      <div class="cap-toggles">
        ${capBtn("web_search", "联网搜索", enabledTools.has("web_search"))}
        ${capBtn("image_gen", "生图", enabledTools.has("image_gen"))}
        ${capBtn("memory_save", "记忆", enabledTools.has("memory_save"))}
        ${capBtn("tts", "TTS 朗读", ab.tts === true)}
      </div>
    </div>

    <div class="adv-sec">
      <h4>${icon("database")} 记忆</h4>
      <div class="adv-grid2">
        <label>每几轮总结一次<input id="adv-mem-rounds" type="number" min="1" max="50" value="${memCfg.auto_rounds ?? 20}">（最近 30 轮保护，超额攒够 N 轮总结最早 N 轮）</label>
      </div>
    </div>

    <div class="adv-sec">
      <h4>${icon("sliders")} 角色扮演预设</h4>
      <div class="adv-grid2">
        <label>档位<select id="adv-tier">${tierOpts}</select></label>
        <label>风格<select id="adv-style">${styleOpts}</select></label>
      </div>
    </div>

    <div class="adv-sec">
      <h4>${icon("bot")} 接入 QQ / 微信</h4>
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
    $("#adv-model-id").innerHTML = (p?.models ?? [])
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("") || `<option value=""></option>`;
  });
  // 能力：点一下切换高亮
  ov.querySelectorAll(".cap-toggle").forEach((b) =>
    b.addEventListener("click", () => b.classList.toggle("on"))
  );

  $("#adv-save").addEventListener("click", async () => {
    const btn = $("#adv-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const provider = $("#adv-model-provider").value;
      const model = $("#adv-model-id").value;
      editingCard.model = provider ? { provider, ...(model ? { model } : {}) } : {};
      // 能力：高亮的即启用（tts 归 abilities，其余归 tools.enabled）
      const onCaps = [...ov.querySelectorAll(".cap-toggle.on")].map((b) => b.dataset.cap);
      editingCard.tools = editingCard.tools ?? { enabled: [], policy: "auto", deny: [] };
      editingCard.tools.enabled = onCaps.filter((c) => c !== "tts");
      editingCard.abilities = { ...(editingCard.abilities ?? {}), tts: onCaps.includes("tts") };
      editingCard.memoryConfig = {
        auto_rounds: Math.min(50, Math.max(1, Number($("#adv-mem-rounds").value) || 20)),
      };
      editingCard.presets = {
        ...(editingCard.presets ?? {}),
        tier: $("#adv-tier").value || null,
        style: $("#adv-style").value || null,
      };
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

// 工作区未启用时要停掉的工具（卡里可能存着历史配置，后端也会再挡一层）
const WORKSPACE_TOOL_IDS = ["code_exec", "sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep"];

/** 聊天默认行为来自卡「高级配置」的能力开关 */
function cardChatOptions() {
  const c = editingCard ?? {};
  let tools = Array.isArray(c.tools?.enabled) ? [...c.tools.enabled] : [];
  if (!FEATURES.workspace) tools = tools.filter((t) => !WORKSPACE_TOOL_IDS.includes(t));
  const thinking = c.chat?.thinking ?? "auto";
  return { tools, useMCP: false, skills: [], thinking };
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
    loadCardsGrid();
  } catch (e) { toast("保存失败：" + e.message, false); }
}

/** 卡库卡片上的删除（RP-Hub 式，直接在卡上操作） */
async function deleteCardBySlug(slug, name) {
  if (!confirm(`确定删除「${name}」？不可恢复。`)) return;
  try {
    await api.send(`/api/cards/${slug}`, { method: "DELETE" });
    toast("已删除");
    loadCardsGrid();
  } catch (e) { toast("删除失败：" + e.message, false); }
}

/** 卡库卡片上的导出（png / json） */
async function exportCardBySlug(slug, format) {
  try {
    const r = await api.send(`/api/cards/${slug}/export`, { method: "POST", body: JSON.stringify({ format }) });
    downloadDataUrl(r.dataUrl, r.filename);
    toast("已导出 " + r.filename);
  } catch (e) { toast("导出失败：" + e.message, false); }
}

async function importCard() {
  const f = $("#import-file").files[0];
  if (!f) return;
  try {
    const b64 = await fileToBase64(f);
    const r = await api.send("/api/cards/import-card", { method: "POST", body: JSON.stringify({ fileBase64: b64, fileName: f.name }) });
    $("#import-file").value = "";
    // 同名卡默认另存不覆盖，告知用户实际入库的名字
    toast(r.renamedFrom ? `✓ 已导入：${r.card.name} · ${r.hint}` : `✓ 已导入：${r.card.name}`);
    await loadCardsGrid();
    loadCardIntoEditor(r.card.slug);
  } catch (e) { toast("导入失败：" + e.message, false); }
}

// ============================================================
//  视图：做卡（独立页）
// ============================================================
function renderCreate() {
  return `
  <div class="view create-view">
    <div class="page-head"><h2>做卡</h2></div>
    <div class="cf-hero">
      <div class="cf-cover">
        <div class="cf-cover-frame" id="cover-frame">
          <img id="cf-cover-img" alt="角色封面" hidden>
          <div class="cf-cover-empty">角色封面</div>
        </div>
        <div class="cf-cover-actions">
          <label class="btn-like ghost">上传图片<input type="file" id="cf-cover-file" accept=".png,.jpg,.jpeg,.webp" hidden></label>
          <button id="btn-ai-cover" class="ghost small-btn">AI 生成</button>
          <button id="btn-cover-remove" class="ghost small-btn" hidden>移除</button>
        </div>
      </div>
      <div class="cf-hero-info">
        <div><label>名称</label><input id="cf-name" placeholder="角色名称"></div>
        <div><label>简介</label><textarea id="cf-bio" class="cf-autogrow" rows="3" placeholder="一句话介绍角色（选填），如：开甜品铺的 26 岁姑娘，嘴上凶巴巴，心里软乎乎的"></textarea></div>
      </div>
    </div>
    <div class="ai-draft-box">
      <div class="ai-draft-head">AI 生成草稿</div>
      <textarea id="ai-idea" rows="3" placeholder="描述你的角色想法，如：一个傲娇的猫娘咖啡店店员……"></textarea>
      <div class="ai-draft-actions">
        <button id="btn-ai-draft" class="primary">生成草稿</button>
      </div>
      <div id="ai-msg" class="status"></div>
    </div>
    <div id="card-form-area" class="card-form-area">${cardFormHTML("create")}</div>
    <div class="create-actions">
      <button id="btn-create-save" class="primary big">保存卡片</button>
      <button id="btn-create-export" class="big">导出</button>
    </div>
  </div>`;
}

function initCreate() {
  editingCard = blankCard("", "");
  bindCardForm(editingCard, "create");
  $("#btn-create-save").addEventListener("click", saveNewCard);
  $("#btn-create-export").addEventListener("click", exportCreateCard);
  $("#btn-ai-draft").addEventListener("click", aiDraft);
  $("#btn-ai-cover").addEventListener("click", () => generateCover());
  $("#btn-cover-remove").addEventListener("click", () => removeCover());
  $("#cf-cover-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 15_000_000) return toast("图片太大了（最大 15MB）", false);
    const b64 = await fileToBase64(f);
    // 1:1 裁切 + 压缩输出 PNG（封面导出角色卡时需要真 PNG）
    openImageCropper({
      dataUrl: `data:${f.type || "image/png"};base64,${b64}`,
      targetSize: 512,
      format: "image/png",
      quality: 0.9,
      title: "裁切角色封面",
      onDone: (dataUrl) => showCover(dataUrl),
    });
  });
  // 生图没配置时，AI 生成按钮给出提示
  checkImageReady().then((ok) => {
    const b = $("#btn-ai-cover");
    if (b && !ok) b.title = "未配置生图：到「生图配置」页填好 Key 后可用";
  });
}

// ---------- 封面（大图展示；上传与 AI 生成共用） ----------
function showCover(dataUrl) {
  editingCard.identity = editingCard.identity ?? {};
  editingCard.identity.avatar = dataUrl;
  const img = $("#cf-cover-img");
  const empty = $(".cf-cover-empty");
  if (img) { img.src = dataUrl; img.hidden = false; }
  if (empty) empty.style.display = "none";
  const rm = $("#btn-cover-remove");
  if (rm) rm.hidden = false;
}

function removeCover(silent) {
  if (editingCard?.identity) editingCard.identity.avatar = "";
  const img = $("#cf-cover-img");
  if (img) { img.hidden = true; img.removeAttribute("src"); }
  const empty = $(".cf-cover-empty");
  if (empty) empty.style.display = "";
  const rm = $("#btn-cover-remove");
  if (rm) rm.hidden = true;
  if (!silent) toast("封面已移除");
}

// ---------- AI 辅助做卡 ----------
async function aiDraft() {
  const idea = $("#ai-idea").value.trim();
  if (!idea) return toast("先写下你的想法", false);
  const btn = $("#btn-ai-draft");
  const msg = $("#ai-msg");
  btn.disabled = true;
  btn.textContent = "生成中…（约 1 分钟）";
  msg.textContent = "";
  try {
    const r = await api.send("/api/cards/ai-draft", {
      method: "POST",
      body: JSON.stringify({ idea }),
    });
    applyDraftToForm(r.draft);
    editingCard._coverPrompt = r.coverPrompt || "";
    try {
      const imgCfg = await api.get("/api/image/config");
      editingCard._coverProvider = imgCfg.provider || "";
    } catch { editingCard._coverProvider = ""; }
    msg.textContent = "✓ 草稿已生成，下面内容都可以改";
    await autoCover(r.draft);
  } catch (e) {
    msg.textContent = "生成失败：" + e.message;
  }
  btn.disabled = false;
  btn.textContent = "生成草稿";
}

function applyDraftToForm(draft) {
  editingCard = draft;
  $("#cf-name").value = draft.name ?? "";
  $("#cf-bio").value = draft.sillytavern_v2?.description || draft.identity?.bio || "";
  $("#cf-first").value = draft.sillytavern_v2?.first_mes || "";
  const entries = draft.sillytavern_v2?.character_book?.entries || [];
  $("#cf-book").innerHTML = entries.length
    ? entries.map((en, i) => wbRowHTML(en, i === 0 && !en.content, i)).join("")
    : wbRowHTML({}, true);
  $("#cf-regex").innerHTML = (draft.sillytavern_v2?.regex_scripts || []).map(rxRowHTML).join("");
  removeCover(true);
}

async function checkImageReady() {
  try {
    const r = await api.get("/api/image/config");
    const cfg = r.config ?? r;
    const prov = cfg.provider;
    return Boolean(
      (prov === "novelai" && cfg.novelai?.key) ||
      (prov === "openai" && cfg.openai?.baseUrl && cfg.openai?.key) ||
      (prov === "local" && cfg.local?.baseUrl)
    );
  } catch { return false; }
}

// 自动判断能不能生图：能就生成封面，不能就留空由用户自己填
async function autoCover(draft) {
  const ready = await checkImageReady();
  if (!ready) {
    const msg = $("#ai-msg");
    msg.textContent += "；未配置生图，封面留空——可直接「上传图片」放自己的图";
    return;
  }
  $("#ai-msg").textContent += "；生图可用，正在生成封面…";
  await generateCover(draft);
}

async function generateCover(draft) {
  const d = draft ?? editingCard;
  if (!d) return toast("先填写名称或生成草稿", false);
  // 封面提示词由做卡 API（AI 生成草稿时）按当时的生图提供商生成，前端不拼模板
  const prompt = (d._coverPrompt || d.coverPrompt || "").trim();
  const btn = $("#btn-ai-cover");
  const msg = $("#ai-msg");
  if (!prompt) {
    if (msg) msg.textContent = "还没有封面提示词：先点「生成草稿」让 AI 生成（提示词风格会自动跟随当前生图提供商）";
    return;
  }
  try {
    const imgCfg = await api.get("/api/image/config");
    const curProv = imgCfg.provider || "";
    if (d._coverProvider && curProv && d._coverProvider !== curProv) {
      if (msg) msg.textContent = "生图提供商已切换（" + d._coverProvider + " → " + curProv + "）：请重新点「生成草稿」以生成匹配风格的封面提示词";
      return;
    }
  } catch {}
  if (btn) {
    btn.disabled = true;
    btn.textContent = "生成中…（约 20 秒）";
  }
  try {
    const coverSlug =
      d.slug ||
      (d.name && /^[a-z0-9][a-z0-9-]*$/.test(d.name.toLowerCase())
        ? d.name.toLowerCase()
        : "cover-" + Date.now().toString(36));
    const r = await api.send("/api/cards/cover", { method: "POST", body: JSON.stringify({ prompt, slug: coverSlug }) });
    if (r.ok && r.url) {
      showCover(r.url);
      if (msg) msg.textContent = "✓ 封面已生成（不满意可再点「AI 生成」或上传自己的图）";
    } else {
      if (msg) msg.textContent = r.info || r.error || "封面生成失败";
    }
  } catch (e) {
    if (msg) msg.textContent = "封面生成失败：" + e.message;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = "AI 生成";
  }
}

async function saveNewCard() {
  collectCardForm(editingCard, "create");
  if (!editingCard.name) return toast("请填写名称", false);
  if (!editingCard.slug) {
    editingCard.slug = /^[a-z0-9][a-z0-9-]*$/.test(editingCard.name.toLowerCase())
      ? editingCard.name.toLowerCase()
      : "card-" + Date.now().toString(36);
  }
  editingCard.identity.relation = editingCard.name;
  try {
    const r = await api.send("/api/cards/import", { method: "POST", body: JSON.stringify({ card: editingCard }) });
    toast(`✓ 已保存到卡库：${r.card.name}`);
    location.hash = "#/cards";
    setTimeout(() => loadCardIntoEditor(r.card.slug), 80);
  } catch (e) { toast("保存失败：" + e.message, false); }
}

// 导出：有封面 → PNG 角色卡（嵌图），没封面 → JSON（更轻）
async function exportCreateCard() {
  collectCardForm(editingCard, "create");
  if (!editingCard.name) return toast("请填写名称", false);
  const format = editingCard.identity?.avatar ? "png" : "json";
  try {
    const r = await api.send("/api/cards/export-card", { method: "POST", body: JSON.stringify({ card: editingCard, format }) });
    downloadDataUrl(r.dataUrl, r.filename);
    toast(format === "png" ? "✓ 已导出 PNG 角色卡" : "✓ 已导出 JSON 角色卡（没封面时导出 JSON 更轻）");
  } catch (e) { toast("导出失败：" + e.message, false); }
}

// ============================================================
//  图片裁切（1:1 方格，可调大小/位置）+ 压缩输出
// ============================================================
function openImageCropper({ dataUrl, targetSize = 256, format = "image/jpeg", quality = 0.85, title = "裁切图片", onDone }) {
  const old = $("#crop-overlay");
  if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "crop-overlay";
  ov.className = "crop-overlay";
  ov.innerHTML = `
  <div class="crop-dialog">
    <div class="crop-head"><span>${escapeHtml(title)}（1:1）</span><button class="ghost small-btn" id="crop-close" title="关闭">${icon("x")}</button></div>
    <div class="crop-stage"><canvas id="crop-canvas"></canvas></div>
    <div class="crop-controls">
      <label>裁切框大小 <input type="range" id="crop-size" min="30" max="100" value="100"></label>
    </div>
    <p class="hint">拖动方框调整位置，用滑块调整裁切框大小</p>
    <div class="crop-foot">
      <button class="ghost" id="crop-cancel">取消</button>
      <button class="primary" id="crop-ok">确认</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $("#crop-close").addEventListener("click", close);
  $("#crop-cancel").addEventListener("click", close);

  const canvas = $("#crop-canvas");
  const ctx = canvas.getContext("2d");
  const img = new Image();
  let closed = false;
  function close() { if (closed) return; closed = true; ov.remove(); }

  img.onload = () => {
    const STAGE = 320;
    canvas.width = STAGE; canvas.height = STAGE;
    const scale = Math.max(STAGE / img.naturalWidth, STAGE / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const ox = (STAGE - dw) / 2;
    const oy = (STAGE - dh) / 2;
    const box = { x: 0, y: 0, s: STAGE };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    const draw = () => {
      ctx.clearRect(0, 0, STAGE, STAGE);
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, STAGE, STAGE);
      ctx.drawImage(img, ox, oy, dw, dh);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, STAGE, box.y);
      ctx.fillRect(0, box.y + box.s, STAGE, STAGE - box.y - box.s);
      ctx.fillRect(0, box.y, box.x, box.s);
      ctx.fillRect(box.x + box.s, box.y, STAGE - box.x - box.s, box.s);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.s, box.s);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i <= 2; i++) {
        ctx.moveTo(box.x + (box.s * i) / 3, box.y); ctx.lineTo(box.x + (box.s * i) / 3, box.y + box.s);
        ctx.moveTo(box.x, box.y + (box.s * i) / 3); ctx.lineTo(box.x + box.s, box.y + (box.s * i) / 3);
      }
      ctx.stroke();
    };

    let drag = null;
    const toStage = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * STAGE, y: ((e.clientY - r.top) / r.height) * STAGE };
    };
    const onDown = (e) => {
      const p = toStage(e);
      if (p.x >= box.x && p.x <= box.x + box.s && p.y >= box.y && p.y <= box.y + box.s) {
        drag = { sx: p.x - box.x, sy: p.y - box.y };
        canvas.style.cursor = "grabbing";
      }
    };
    const onMove = (e) => {
      if (!drag) return;
      const p = toStage(e);
      box.x = clamp(p.x - drag.sx, 0, STAGE - box.s);
      box.y = clamp(p.y - drag.sy, 0, STAGE - box.s);
      draw();
    };
    const onUp = () => { drag = null; canvas.style.cursor = "grab"; };
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); onDown(e.touches[0]); }, { passive: false });
    canvas.addEventListener("touchmove", (e) => { e.preventDefault(); onMove(e.touches[0]); }, { passive: false });
    canvas.addEventListener("touchend", onUp);

    $("#crop-size").addEventListener("input", (e) => {
      const s = STAGE * (Number(e.target.value) / 100);
      const cx = box.x + box.s / 2;
      const cy = box.y + box.s / 2;
      box.s = s;
      box.x = clamp(cx - s / 2, 0, STAGE - s);
      box.y = clamp(cy - s / 2, 0, STAGE - s);
      draw();
    });

    $("#crop-ok").addEventListener("click", () => {
      const sx = (box.x - ox) / scale;
      const sy = (box.y - oy) / scale;
      const sw = box.s / scale;
      const out = document.createElement("canvas");
      out.width = targetSize; out.height = targetSize;
      out.getContext("2d").drawImage(img, sx, sy, sw, sw, 0, 0, targetSize, targetSize);
      const result = out.toDataURL(format, quality);
      close();
      onDone(result);
    });

    draw();
  };
  img.onerror = () => { toast("图片加载失败", false); close(); };
  img.src = dataUrl;
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
        <label>提供商（互斥，开启一个另一个关闭）</label>
        <div class="cap-toggles img-provider-row">
          <button type="button" class="cap-toggle" data-provider="novelai">NovelAI</button>
          <button type="button" class="cap-toggle" data-provider="openai">OpenAI</button>
        </div>
        <div id="ig-pane-novelai" class="ig-pane">
          <p class="hint">NovelAI 官方接口在国内直连不通（会报网络错误），需要能访问它的网络环境才能用。国内建议用 OpenAI 兼容那栏。</p>
          <label>API Key（留空 = 保留原值）</label>
          <input id="ig-nai-key" type="password" placeholder="NovelAI 官方 key（pst-… 开头）">
          <div class="artists-box" style="margin-top:10px">
            <label>画师串（生成时自动拼到提示词末尾。可以存多条，点右边「启用」切换；再点一下取消，取消后就不拼画师串）</label>
            <div id="ig-artists-list"></div>
            <button id="ig-artist-add" class="ghost small-btn" style="margin-top:6px">${icon("plus")} 添加画师串</button>
            <div id="ig-artist-edit" style="display:none;margin-top:6px;border:1px dashed var(--border);border-radius:8px;padding:8px">
              <input id="ig-artist-name" placeholder="画师串名称（如：默认画风）">
              <textarea id="ig-artist-content" rows="2" style="margin-top:6px" placeholder="画师串内容，如 masterpiece, best quality, [artist:ciloranko], ..."></textarea>
              <div class="row" style="margin-top:6px">
                <button id="ig-artist-save" class="small-btn primary">保存</button>
                <button id="ig-artist-cancel" class="small-btn ghost">取消</button>
              </div>
            </div>
          </div>
        </div>
        <div id="ig-pane-openai" class="ig-pane" style="display:none">
          <label>Base URL（以 /v1 结尾）</label>
          <input id="ig-oai-url" placeholder="https://api.example.com/v1">
          <label style="margin-top:8px">API Key（留空 = 保留原值）</label>
          <input id="ig-oai-key" type="password" placeholder="sk-...">
          <label style="margin-top:8px">生图模型（中转站一般不单独放生图模型，从 /models 拉取后选择）</label>
          <div class="row">
            <select id="ig-oai-model" style="flex:1;min-width:160px"><option value="">（先拉取模型列表）</option></select>
            <button id="ig-oai-models" class="ghost small-btn">拉取模型</button>
          </div>
          <div id="ig-oai-models-status" class="status"></div>
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
            <option value="square">方图 1024×1024</option>
            <option value="portrait">竖图 832×1216</option>
            <option value="landscape">横图 1216×832</option>
          </select>
          <button id="ig-test-go" class="primary">生成</button>
        </div>
        <div id="ig-test-status" class="status"></div>
        <div id="ig-test-img"></div>
      </div>
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
  return document.querySelector(".cap-toggle[data-provider].on")?.dataset?.provider ?? "novelai";
}
let imgState = { artists: [], activeArtist: "" };
let artistEditing = null; // 正在编辑的画师串下标（null = 新增）

function showIgPane(provider) {
  for (const p of ["novelai", "openai"]) {
    const pane = $("#ig-pane-" + p);
    if (pane) pane.style.display = p === provider ? "block" : "none";
  }
}
function setIgProvider(provider) {
  document.querySelectorAll(".cap-toggle[data-provider]").forEach((b) => {
    b.classList.toggle("on", b.dataset.provider === provider);
  });
  showIgPane(provider);
}
function collectImgForm() {
  const v = (id) => { const el = $(id); return el ? el.value.trim() : ""; };
  return {
    provider: igRadio(),
    novelai: { key: v("#ig-nai-key") },
    openai: { baseUrl: v("#ig-oai-url"), key: v("#ig-oai-key"), model: v("#ig-oai-model") },
    artists: imgState.artists,
    activeArtist: imgState.activeArtist,
  };
}
function fillImgForm(cfg) {
  setIgProvider(cfg.provider);
  if ($("#ig-nai-key")) $("#ig-nai-key").value = "";
  if ($("#ig-oai-url")) $("#ig-oai-url").value = cfg.openai?.baseUrl ?? "";
  if ($("#ig-oai-key")) $("#ig-oai-key").value = "";
  if ($("#ig-oai-model")) {
    const sel = $("#ig-oai-model");
    sel.dataset.cur = cfg.openai?.model ?? "";
    // 若已保存模型不在下拉里，补一个选项保证显示
    if (cfg.openai?.model) {
      const opts = Array.from(sel.options).map((o) => o.value);
      if (!opts.includes(cfg.openai.model)) {
        sel.innerHTML = `<option value="${escapeHtml(cfg.openai.model)}">${escapeHtml(cfg.openai.model)}</option>`;
      }
      sel.value = cfg.openai.model;
    }
  }
  imgState.artists = (cfg.artists ?? []).map((a) => ({ name: a.name, content: a.content }));
  imgState.activeArtist = cfg.activeArtist ?? "";
  renderArtistsList();
  // 已设置密钥的输入框用点提示（留空保存 = 保留原值），避免用户以为密钥丢了
  if ($("#ig-nai-key")) $("#ig-nai-key").placeholder = cfg.novelai?.key ? "•••••• 已设置（留空保留）" : "sk-...";
  if ($("#ig-oai-key")) $("#ig-oai-key").placeholder = cfg.openai?.key ? "•••••• 已设置（留空保留）" : "sk-...";
}
function renderArtistsList() {
  const box = $("#ig-artists-list");
  if (!box) return;
  if (!imgState.artists.length) {
    box.innerHTML = `<div class="muted">还没有画师串。添加一个后，生成图片时会自动拼到提示词末尾。</div>`;
    return;
  }
  box.innerHTML = imgState.artists
    .map((a, i) => {
      const on = a.name === imgState.activeArtist;
      return `
    <div class="artist-item">
      <div class="artist-main">
        <div class="artist-name">${escapeHtml(a.name)}${on ? ' <span class="mem-badge">生效中</span>' : ""}</div>
        <div class="artist-content">${escapeHtml(a.content.slice(0, 90))}${a.content.length > 90 ? "…" : ""}</div>
      </div>
      <button class="${on ? "primary" : "ghost"} small-btn" data-toggle="${i}" title="${on ? "点一下停用" : "点一下启用"}">${on ? "已启用" : "启用"}</button>
      <button class="ghost small-btn" data-edit="${i}">编辑</button>
      <button class="danger small-btn" data-del="${i}">删除</button>
    </div>`;
    })
    .join("");
  // 启用/停用：点已生效的那条就取消（都不启用时生成不拼画师串）；换别的等于切换
  box.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = imgState.artists[Number(b.dataset.toggle)];
      if (!a) return;
      imgState.activeArtist = imgState.activeArtist === a.name ? "" : a.name;
      renderArtistsList();
      saveImgConfig();
    })
  );
  box.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openArtistEdit(Number(b.dataset.edit)))
  );
  box.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteArtist(Number(b.dataset.del)))
  );
}
function openArtistEdit(i) {
  artistEditing = i;
  const a = i === null ? null : imgState.artists[i];
  $("#ig-artist-name").value = a?.name ?? "";
  $("#ig-artist-content").value = a?.content ?? "";
  $("#ig-artist-edit").style.display = "block";
  $("#ig-artist-name").focus();
}
function closeArtistEdit() {
  artistEditing = null;
  $("#ig-artist-edit").style.display = "none";
}
function deleteArtist(i) {
  const a = imgState.artists[i];
  if (!a || !confirm(`删除画师串「${a.name}」？`)) return;
  imgState.artists.splice(i, 1);
  if (imgState.activeArtist === a.name) imgState.activeArtist = "";
  renderArtistsList();
  saveImgConfig();
}
async function saveImgConfig() {
  const f = collectImgForm();
  const r = await api.send("/api/image/config", { method: "POST", body: JSON.stringify(f) });
  if (r.ok) setStatus("#ig-status", "✓ 已保存", true);
  else setStatus("#ig-status", "保存失败：" + (r.error ?? "未知错误"), false);
}
async function initImgGenPage() {
  imgState = { artists: [], activeArtist: "" };
  artistEditing = null;
  document.querySelectorAll(".cap-toggle[data-provider]").forEach((b) =>
    b.addEventListener("click", () => setIgProvider(b.dataset.provider))
  );
  $("#ig-oai-models").addEventListener("click", async () => {
    const baseUrl = $("#ig-oai-url")?.value?.trim();
    const key = $("#ig-oai-key")?.value?.trim();
    setStatus("#ig-oai-models-status", "拉取中…");
    try {
      const r = await api.send("/api/image/openai-models", {
        method: "POST",
        body: JSON.stringify({ baseUrl: baseUrl || undefined, key: key || undefined }),
      });
      if (r.models) {
        const sel = $("#ig-oai-model");
        const cur = sel.value || sel.dataset.cur || "";
        sel.innerHTML = `<option value="">（选择生图模型）</option>` +
          r.models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
        if (cur && r.models.includes(cur)) sel.value = cur;
        setStatus("#ig-oai-models-status", `✓ 拉取到 ${r.models.length} 个模型${cur ? "，已保留原选择" : ""}`, true);
      } else {
        setStatus("#ig-oai-models-status", "拉取失败：" + (r.error ?? "未知错误"), false);
      }
    } catch (e) {
      setStatus("#ig-oai-models-status", "拉取失败：" + e.message, false);
    }
  });
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
  $("#ig-artist-add").addEventListener("click", () => openArtistEdit(null));
  $("#ig-artist-cancel").addEventListener("click", closeArtistEdit);
  $("#ig-artist-save").addEventListener("click", () => {
    const name = $("#ig-artist-name").value.trim();
    const content = $("#ig-artist-content").value.trim();
    if (!name || !content) return toast("名称和内容都要填", false);
    if (imgState.artists.some((a) => a.name === name && (artistEditing === null || imgState.artists[artistEditing].name !== name))) {
      return toast("同名画师串已存在", false);
    }
    if (artistEditing === null) {
      imgState.artists.push({ name, content });
      if (!imgState.activeArtist) imgState.activeArtist = name;
    } else {
      const old = imgState.artists[artistEditing];
      if (imgState.activeArtist === old.name) imgState.activeArtist = name;
      imgState.artists[artistEditing] = { name, content };
    }
    closeArtistEdit();
    renderArtistsList();
    saveImgConfig();
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
        setStatus("#ig-test-status", `✓ 生成完成（${r.width}×${r.height}）`, true);
        $("#ig-test-img").innerHTML = `<img src="${r.url}" alt="测试图" onclick="showLightbox('${r.url}')">`;
      }
    } catch (e) {
      setStatus("#ig-test-status", "生成失败：" + e.message, false);
    } finally {
      btn.disabled = false;
    }
  });
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
    // 默认 = 第一个「启用中」的提供商（第一个被停用时，默认自动落到下一个可用的）
    const defaultName = list.find((p) => p.enabled !== false)?.name;
    list.forEach((p) => {
      const off = p.enabled === false;
      const isDefault = !off && p.name === defaultName;
      const d = document.createElement("div");
      d.className = "prov-item" + (isDefault ? " default" : "") + (off ? " disabled" : "");
      d.innerHTML = `
        <div class="prov-head">
          <b>${escapeHtml(p.name)}</b>
          ${isDefault ? '<span class="chip ok">默认</span>' : ""}
          ${off ? '<span class="chip">已停用</span>' : ""}
          <span class="prov-btns">
            ${!off && !isDefault ? `<button class="ghost small-btn" data-act="default" data-name="${escapeHtml(p.name)}">设为默认</button>` : ""}
            <button class="ghost small-btn" data-act="toggle" data-name="${escapeHtml(p.name)}" data-on="${off ? "1" : "0"}">${off ? "启用" : "停用"}</button>
            <button class="ghost small-btn" data-act="edit" data-name="${escapeHtml(p.name)}">编辑</button>
            <button class="danger small-btn" data-act="del" data-name="${escapeHtml(p.name)}">删除</button>
          </span>
        </div>
        <div class="meta">${escapeHtml(p.baseUrl)} · key ${p.apiKey ? "••••••" : "未填"}</div>
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
        } else if (b.dataset.act === "toggle") {
          const turnOn = b.dataset.on === "1";
          await api.send("/api/providers/toggle", { method: "POST", body: JSON.stringify({ type: provState.type, name, enabled: turnOn }) });
          loadProvList();
          toast(turnOn ? `✓ 已启用 ${name}` : `已停用 ${name}（配置保留）`);
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
      <div class="meta">${escapeHtml(p.baseUrl)} · key ${p.key ? "••••••" : "未填"} · ${escapeHtml(TTS_KIND_LABEL[p.kind] || p.kind || "openai")}</div>
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
  // 已配置过密钥：点表示已添加（留空保存 = 保留原值），避免用户以为密钥丢了
  $("#tts-pv-key").placeholder = p?.key ? "•••••• 已设置（留空保留）" : "sk-...";
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
      body: JSON.stringify({ id: ttsState.editingId, kind: body.kind, baseUrl: body.baseUrl, key: body.key || undefined }),
    });
    ttsState.models = fr.models || [];
    ttsState.voices = fr.voices || [];
    renderTtsChips("#tts-pv-models", ttsState.models, "#tts-pv-model", body.model);
    renderTtsChips("#tts-pv-voices", ttsState.voices, "#tts-pv-voice", body.voice);
    $("#tts-pv-fetch").style.display = "block";
    $("#tts-pv-done").style.display = "inline-block";
    $("#tts-pv-msg").textContent = ttsState.models.length
      ? `✓ 已保存；拉取到 ${ttsState.models.length} 个模型${ttsState.voices.length ? `、${ttsState.voices.length} 个音色` : ""}。点击模型/音色填入后点「完成」`
      : "✓ 已保存；该接口没返回模型，请在「默认模型/默认音色」手动填写后点「完成」";
    loadTtsConfig();
  } catch (e) {
    $("#tts-pv-msg").textContent = "拉取失败：" + e.message + "——可手动填写「默认模型/默认音色」后点「完成」保存";
    $("#tts-pv-done").style.display = "inline-block";
  }
}

function renderTtsChips(boxId, items, inputId, chosen) {
  const box = $(boxId[0] === "#" ? boxId : "#" + boxId);
  if (!box) return;
  if (!items || !items.length) { box.innerHTML = '<div class="hint">（无，手动填写上方输入框）</div>'; return; }
  box.innerHTML = "";
  items.forEach((m) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "model-chip" + (m === chosen ? " on" : "");
    chip.textContent = m;
    chip.addEventListener("click", () => {
      const inp = $(inputId[0] === "#" ? inputId : "#" + inputId);
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
      // 已配置过密钥：用点表示已添加（留空保存 = 保留原值），避免用户以为密钥丢了
      $("#pv-key").placeholder = p.apiKey ? "•••••• 已设置（留空保留）" : "sk-...";
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
    <div class="page-head"><h2>记忆</h2><p class="hint">每张卡独立的长期记忆；可手动添加、单条编辑/删除。自动总结：最近 30 轮对话保护不总结，之后每攒够 N 轮就总结最早 N 轮，每段只总结一次</p></div>
    <div id="mem-cards-head" class="mem-cards-head">选择角色卡</div>
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
    // 正在本地聊天 → 只显示当前这张卡的记忆并直接展开；退出本地聊天后恢复全部
    const chatting = workbenchOn() ? localStorage.getItem("ocs_workbench_slug") : "";
    const focus = chatting && cards.some((c) => c.slug === chatting) ? chatting : "";
    const list = focus ? cards.filter((c) => c.slug === focus) : cards;
    const head = $("#mem-cards-head");
    if (head) head.textContent = focus ? "当前聊天的角色" : "选择角色卡";
    for (const c of list) {
      const d = document.createElement("div");
      d.className = "mini-card";
      d.innerHTML = `<div class="mini-name">${escapeHtml(c.name)}</div><div class="meta">${roleLabel(c.role)}</div>`;
      d.addEventListener("click", () => openMemDetail(c.slug));
      box.appendChild(d);
    }
    if (focus) openMemDetail(focus);
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
const CHAT_EMOJI_RE = /\[表情:([^\]]+)\]/g;

/** 当前聊天用的卡片：卡片编辑器里是 editingCard，工作台里是 wbCardObj */
function curCard() { return editingCard || wbCardObj; }

/**
 * 应用卡片里的正则替换（酒馆 regex_scripts）到 AI 回复上。
 * 之前这些脚本只存不用，用户填了完全不生效。
 * findRegex 支持酒馆的 /pattern/flags 写法；替换串里的 $1 等分组照常可用。
 */
function applyRegexScripts(text) {
  const scripts = curCard()?.sillytavern_v2?.regex_scripts ?? [];
  let out = String(text);
  for (const s of scripts) {
    if (!s || s.enabled === false || s.disabled === true) continue;
    const raw = String(s.findRegex ?? "").trim();
    if (!raw) continue;
    try {
      // /pattern/flags 或裸 pattern
      const m = raw.match(/^\/(.*)\/([gimsuy]*)$/);
      const re = m ? new RegExp(m[1], m[2] || "g") : new RegExp(raw, "g");
      out = out.replace(re, String(s.replaceString ?? ""));
    } catch {
      // 正则写错就跳过这一条，不影响其他脚本和消息显示
    }
  }
  return out;
}

// 全局共享表情库缓存（所有角色卡共用一套，聊天渲染 [表情:名字] 时按名字查）
let emojiLib = [];
async function loadEmojiLib() {
  try {
    const r = await api.get("/api/emojis");
    emojiLib = r.emojis ?? [];
  } catch { emojiLib = []; }
  return emojiLib;
}

/** 把回复文本渲染进气泡：[表情:名字] → 共享表情库图片；/img/... → 可点击放大的生图；其余纯文本 */
function appendChatContent(div, text) {
  const emojiParts = String(text).split(CHAT_EMOJI_RE);
  for (let i = 0; i < emojiParts.length; i++) {
    const seg = emojiParts[i];
    if (!seg) continue;
    if (i % 2 === 1) {
      // 表情名（split 捕获组在奇数位）；库里没有这个名字就按原文显示
      const em = emojiLib.find((e) => e.name === seg);
      if (em) {
        const img = document.createElement("img");
        img.src = em.url || `/emojis/_shared/${em.file}`;
        img.alt = em.name;
        img.title = em.name;
        img.className = "chat-emoji";
        div.appendChild(img);
      } else {
        div.appendChild(document.createTextNode("[表情:" + seg + "]"));
      }
      continue;
    }
    // 文本段里还可能混着生图路径
    const imgParts = seg.split(CHAT_IMG_RE);
    for (let j = 0; j < imgParts.length; j++) {
      const p = imgParts[j];
      if (!p) continue;
      if (j % 2 === 1) {
        const img = document.createElement("img");
        img.src = p;
        img.className = "chat-img";
        img.alt = "AI 生成的图片";
        img.loading = "lazy";
        img.addEventListener("click", () => showLightbox(p));
        div.appendChild(img);
      } else {
        div.appendChild(document.createTextNode(p));
      }
    }
  }
}

function addChatBubble(role, text) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "bot");
  appendChatContent(div, String(text));
  if (role === "bot") {
    const btn = document.createElement("button");
    btn.className = "tts-speak-btn";
    btn.innerHTML = icon("volume");
    btn.title = "朗读这条回复（播放中再点停止）";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      speakText(text, btn); // 传按钮 → 支持"再点一次停止"
    });
    div.appendChild(btn);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
let ttsAudio = null;
let ttsOwner = null;   // 正在朗读的那个按钮，用于高亮与"再点一次停止"
let ttsLoading = false;
let ttsUrl = null;     // 当前音频的 Blob URL（不落盘，播完要回收）

/** 停掉当前朗读并清理状态 */
function stopSpeak() {
  if (ttsAudio) { try { ttsAudio.pause(); } catch { /* 忽略 */ } ttsAudio = null; }
  // 语音不落盘，靠内存 Blob URL 播放；不回收会一直占内存
  if (ttsUrl) { try { URL.revokeObjectURL(ttsUrl); } catch { /* 忽略 */ } ttsUrl = null; }
  if (ttsOwner) { ttsOwner.classList.remove("playing"); ttsOwner = null; }
}

/**
 * 朗读一段文本。btn 传入时支持切换语义：
 * 正在朗读同一条 → 停止；朗读别条或没在朗读 → 从头开始播这条。
 */
async function speakText(text, btn) {
  // 正在放这一条（或正在为它取音频）→ 这次点击就是"停止"
  if (btn && ttsOwner === btn) { stopSpeak(); ttsLoading = false; return; }
  stopSpeak();
  if (ttsLoading) return;
  ttsLoading = true;
  if (btn) { ttsOwner = btn; btn.classList.add("playing"); }
  try {
    // 后端直接回音频流（不落盘），这里收成 Blob 再放
    const resp = await fetchApi("/api/tts/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text).slice(0, 500) }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || resp.statusText);
    }
    const blob = await resp.blob();
    // 取音频期间用户可能已点了停止
    if (btn && ttsOwner !== btn) return;
    ttsUrl = URL.createObjectURL(blob);
    ttsAudio = new Audio(ttsUrl);
    ttsAudio.addEventListener("ended", stopSpeak);
    ttsAudio.addEventListener("error", stopSpeak);
    await ttsAudio.play().catch(() => stopSpeak());
  } catch (e) {
    stopSpeak();
    toast("朗读失败：" + e.message, false);
  } finally {
    ttsLoading = false;
  }
}
/**
 * 像真人一样分条显示回复：按空行切段，逐条冒出来，每条之间按卡里的 chat.delay 停顿。
 * 与通道端一致（OpenClaw 用 humanDelay 在 block 之间停顿）。
 */
async function addBotReplyHumanLike(rawText) {
  const card = curCard();
  const text = applyRegexScripts(rawText); // 卡里的正则替换（酒馆 regex_scripts）
  const multi = card?.voice?.message_style?.multi_send === true;
  const parts = multi
    ? String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    : [String(text)];
  if (parts.length <= 1) {
    addChatBubble("bot", text);
    return;
  }
  const base = Math.max(200, Number(card?.chat?.delay?.base_ms) || 1500);
  const variance = Math.min(1, Math.max(0, Number(card?.chat?.delay?.variance ?? 0.4)));
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // 每条之间等一会儿，长句多等一点（模拟打字）
      const jitter = 1 + (Math.random() * 2 - 1) * variance;
      const wait = Math.min(4000, base * jitter * Math.min(2, 0.4 + parts[i].length / 30));
      await new Promise((r) => setTimeout(r, wait));
    }
    addChatBubble("bot", parts[i]);
  }
}


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
        <div id="wx-qr-img" class="qr-img" style="display:none"></div>
        <a id="wx-qr-link" class="qr-link" target="_blank" style="display:none">扫不了？点这里在浏览器打开链接</a>
        <div id="wx-login-msg" class="status"></div>
        <pre id="wx-out" class="small-out"></pre>
        <h3>配对授权</h3>
        <div class="row"><input id="pairing-code" placeholder="配对码"><button id="btn-pair-approve" class="primary small-btn">批准</button></div>
        <pre id="pairing-list" class="small-out"></pre>
      </div>
      <div class="card-box">
        <h3>QQ <span id="qq-status" class="chip">检测中…</span></h3>
        <p class="hint">官方开放平台机器人（单聊/群聊@/频道）。</p>
        <div class="row"><button id="btn-qq-login" class="primary">开始扫码绑定</button><button id="btn-qq-refresh" class="ghost">刷新</button></div>
        <pre id="qq-qr" class="qr-box" style="display:none"></pre>
        <div id="qq-qr-img" class="qr-img" style="display:none"></div>
        <a id="qq-qr-link" class="qr-link" target="_blank" style="display:none">扫不了？点这里在浏览器打开链接</a>
        <div id="qq-login-msg" class="status"></div>
        <div class="guide"><ol>
          <li>先在 <a href="https://q.qq.com/" target="_blank">QQ 开放平台</a> 创建机器人</li>
          <li>点「开始扫码绑定」，用<b>手机 QQ</b> 扫上方二维码（扫的是 QQ 开放平台的登录授权码，把这台机器和你的开发者账号绑起来）</li>
          <li>成功后在 QQ 里找到机器人发消息测试</li>
        </ol></div>
        <pre id="qq-out" class="small-out"></pre>
      </div>
    </div>
    <div class="card-box" style="margin-top:14px">
      <h3>🤖 机器人连接（多卡并存）</h3>
      <p class="hint">每张卡一个独立机器人：已认证的账号凭证保存在本机，换卡/接卡不用重新扫码。</p>
      <div id="conn-list"><div class="muted">加载中…</div></div>
    </div>
  </div>`;
}

const loginTimers = {};
async function startLogin(channelPath, qrSel, msgSel, refreshCb) {
  const imgSel = qrSel + "-img", linkSel = qrSel + "-link";
  try {
    await api.send(channelPath, { method: "POST" });
    $(msgSel).textContent = "二维码生成中…";
    if (loginTimers[channelPath]) clearInterval(loginTimers[channelPath]);
    loginTimers[channelPath] = setInterval(async () => {
      try {
        const s = await api.get(channelPath);
        // 优先高清图片二维码，退回终端 ASCII
        if (s.qrDataUrl && $(imgSel)) {
          $(imgSel).innerHTML = `<img src="${s.qrDataUrl}" alt="扫码二维码">`;
          $(imgSel).style.display = "block";
          $(qrSel).style.display = "none";
          if ($(linkSel) && s.qrUrl) { $(linkSel).href = s.qrUrl; $(linkSel).style.display = "block"; }
        } else if (s.output) {
          $(qrSel).textContent = s.output; $(qrSel).style.display = "block";
        }
        if (!s.running && s.done) {
          clearInterval(loginTimers[channelPath]);
          loginTimers[channelPath] = null;
          $(msgSel).textContent = s.ok ? "扫码成功，已绑定！" : "未成功，检查平台侧后重试";
          refreshCb && refreshCb();
        }
      } catch { /* 忽略 */ }
    }, 800);
  } catch (e) { $(msgSel).textContent = "启动失败：" + e.message; }
}

function initChannels() {
  $("#btn-wx-login").addEventListener("click", () => startLogin("/api/channels/wechat/login", "#wx-qr", "#wx-login-msg", () => { refreshWechat(); refreshPairing(); }));
  $("#btn-wx-refresh").addEventListener("click", () => { refreshWechat(true); refreshConnections(); });
  $("#btn-pair-approve").addEventListener("click", approvePairing);
  $("#btn-qq-login").addEventListener("click", () => startLogin("/api/channels/qq/login", "#qq-qr", "#qq-login-msg", refreshQQ));
  $("#btn-qq-refresh").addEventListener("click", () => { refreshQQ(true); refreshConnections(); });
  refreshWechat(); refreshPairing(); refreshQQ(); refreshConnections();
}
async function refreshConnections() {
  const box = $("#conn-list");
  if (!box) return;
  try {
    const [conn, cards] = await Promise.all([
      api.get("/api/channels/connections"),
      api.get("/api/cards").catch(() => ({ cards: [] })),
    ]);
    const bots = conn.bots ?? [];
    const accounts = conn.accounts ?? [];
    const cardOpts = (cards.cards ?? []).map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join("");
    // 已绑定实例
    let html = "";
    const maxQq = conn.limits?.maxQq ?? 5;
    const maxWx = conn.limits?.maxWeixin ?? 1;
    const qqCnt = bots.filter((b) => b.channel === "qqbot").length;
    const wxCnt = bots.filter((b) => b.channel === "openclaw-weixin").length;
    if (bots.length) {
      html += `<div class="conn-sub">已绑定（QQ ${qqCnt}/${maxQq} · 微信 ${wxCnt}/${maxWx}）</div>`;
      for (const b of bots) {
        // 下拉表面直接显示"正在连接的那张卡"，展开才是换卡列表
        const cardName = b.cardName || b.cardSlug;
        const opts = (cards.cards ?? [])
          .map((c) => `<option value="${escapeHtml(c.slug)}" ${c.slug === b.cardSlug ? "selected" : ""}>${escapeHtml(c.name)}${c.slug === b.cardSlug ? "（当前）" : ""}</option>`)
          .join("");
        html += `<div class="conn-row">
          <span class="chip">${b.channel === "qqbot" ? "QQ" : "微信"} · ${escapeHtml(b.accountId)}</span>
          <span class="conn-arrow">→</span>
          <select class="conn-target" data-bot="${b.id}" data-cur="${escapeHtml(b.cardSlug)}" title="当前连接：${escapeHtml(cardName)}（可换卡）" style="max-width:190px">${opts}</select>
          <button class="danger small-btn" data-conn-del="${b.id}">解绑</button>
        </div>`;
      }
    } else {
      html += `<div class="muted">还没有绑定任何机器人实例。在「人设卡库」点开卡 → 右上角 ⚙ 高级配置 → 机器人接入创建。</div>`;
    }
    // 可复用账号（未绑定）：通道页扫码建的账号会落到这里，提示用户去绑卡
    const freeAccounts = accounts.filter((a) => !a.boundBotId);
    if (freeAccounts.length) {
      html += `<div class="conn-sub">未绑卡的账号（凭证已认证，选一张卡即可用，免扫码）</div>`;
      for (const a of freeAccounts) {
        html += `<div class="conn-row">
          <span class="chip">${a.channel === "qqbot" ? "QQ" : "微信"} · ${escapeHtml(a.accountId)}</span>
          <span class="warn-badge">未绑卡</span>
          <span class="conn-arrow">→</span>
          <select class="conn-cardpick" data-acc="${a.channel}|${a.accountId}" style="max-width:190px"><option value="">选一张卡绑定…</option>${cardOpts}</select>
        </div>`;
      }
    }
    html += `<p class="hint" style="margin-top:8px">上限：QQ ${maxQq} 个机器人（平台，每号 5 个 AppID）、微信 ${maxWx} 个（一个微信号一个）。换卡/绑卡都复用已有凭证，无需重新扫码。</p>`;
    box.innerHTML = html;
    // 事件
    box.querySelectorAll("[data-conn-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("解绑这个机器人实例？（账号凭证保留，可复用）")) return;
        const r = await api.send(`/api/bots/${b.dataset.connDel}`, { method: "DELETE" });
        toast(r.ok ? "已解绑" : "解绑失败：" + (r.error ?? ""), r.ok);
        refreshConnections();
      })
    );
    box.querySelectorAll(".conn-target").forEach((sel) =>
      sel.addEventListener("change", async () => {
        // 下拉默认选中当前卡，选回自己不算换卡
        if (!sel.value || sel.value === sel.dataset.cur) return;
        const targetName = sel.options[sel.selectedIndex]?.textContent ?? sel.value;
        if (!confirm(`把该账号换到「${targetName}」？原来的卡会被顶掉，账号凭证复用不重新扫码。`)) {
          sel.value = sel.dataset.cur; // 取消就还原选中项
          return;
        }
        try {
          const r = await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId: sel.dataset.bot, toCardSlug: sel.value }) });
          toast(r.ok ? "✓ 已换卡" : "换卡失败：" + (r.error ?? ""), r.ok);
        } catch (e) { toast("换卡失败：" + e.message, false); }
        refreshConnections();
      })
    );
    box.querySelectorAll(".conn-cardpick").forEach((sel) =>
      sel.addEventListener("change", async () => {
        if (!sel.value) return;
        const [channel, accountId] = sel.dataset.acc.split("|");
        try {
          const r = await api.send("/api/bots", { method: "POST", body: JSON.stringify({ cardSlug: sel.value, channel, accountId }) });
          if (r.conflict) {
            toast(`账号已被「${r.occupiedBy?.cardName ?? r.occupiedBy?.cardSlug}」占用，先去那边换卡或解绑`, false);
          } else {
            toast("✓ 已绑定（账号凭证复用，网关重启后生效）");
          }
        } catch (e) {
          const msg = e.message || "";
          if (msg.includes("占用")) toast("账号已被占用，可先在旧卡上「换卡」", false);
          else toast("绑定失败：" + msg, false);
        }
        refreshConnections();
      })
    );
  } catch (e) {
    box.innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}
async function refreshWechat(force = false) {
  try {
    const s = await api.get("/api/channels/wechat/status" + (force ? "?refresh=1" : ""));
    const el = $("#wx-status");
    const accs = s.accounts ?? [];
    el.textContent = s.connected ? (accs.length ? `已连接 ✓（${accs.length} 个账号）` : "已连接 ✓") : "未连接";
    el.className = "chip " + (s.connected ? "ok" : "");
    // 和 QQ 一样把账号列出来：让用户知道扫的码落到哪个号，以及是否还没绑卡
    const out = $("#wx-out");
    if (out) out.textContent = accs.length ? "已绑定账号：" + accs.join("、") + "\n（在下方「机器人连接」给账号选一张卡即可聊天）" : "还没有绑定账号，点上方按钮扫码";
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
async function refreshQQ(force = false) {
  try {
    const s = await api.get("/api/channels/qq/status" + (force ? "?refresh=1" : ""));
    const el = $("#qq-status");
    el.textContent = s.connected ? "已连接 ✓" : "未连接";
    el.className = "chip " + (s.connected ? "ok" : "");
    // 已绑定的账号列出来，让用户知道扫的码到底落到哪个号上了
    $("#qq-out").textContent = !s.pluginInstalled
      ? "还没装 QQ 官方插件，装好后再来扫码"
      : s.accounts?.length
        ? "已绑定账号：" + s.accounts.join("、")
        : "还没有绑定账号，点上方按钮扫码";
  } catch { $("#qq-status").textContent = "检测失败"; }
}

// ---- 能力中心 ----
// ============================================================
//  视图：工作台设置（原「能力中心」）
//  工作模式为半独立式：默认纯聊天；开启后首页变为工作台
//  四块：开关 / 默认能力 / MCP 表单化配置 / 工作区概览
// ============================================================
function renderWorkbenchSettings() {
  return `
  <div class="view">
    <div class="page-head"><h2>工作台设置</h2><p class="hint">工作模式是半独立式：平时就是聊天；开启后首页变为工作台，直接选角色卡当助手干活</p></div>

    <div class="card-box">
      <h3>工作模式开关</h3>
      <div class="form">
        <label class="adv-switch"><input type="checkbox" id="wb-switch">
          <span><b>开启工作模式</b><small>首页变为工作台：选卡当助手 + 聊天 + 工作区文件面板（助手直接用卡的世界书与模型，无需另配）</small></span></label>
        <div class="row"><button id="wb-go" class="primary">去工作台 →</button></div>
        <div id="wb-switch-msg" class="status"></div>
      </div>
    </div>

    <div class="two-col">
      <div class="card-box">
        <h3>默认能力</h3>
        <p class="hint">工作台的助手与「聊天测试」的工作模式共用这套默认开关</p>
        <div class="form">
          <label>工具</label>
          <div class="cap-checks">
            ${FEATURES.workspace ? `
            <label><input type="checkbox" id="cap-code"> 写代码*</label>
            <label><input type="checkbox" id="cap-file"> 文件</label>` : ""}
            <label><input type="checkbox" id="cap-search"> 搜索</label>
            <label><input type="checkbox" id="cap-weather"> 天气</label>
            <label><input type="checkbox" id="cap-memory"> 记忆</label>
          </div>
          ${FEATURES.skills ? `
          <label>技能</label>
          <div class="cap-checks">
            <label><input type="checkbox" id="cap-skill-code"> 代码</label>
            <label><input type="checkbox" id="cap-skill-trans"> 翻译</label>
            <label><input type="checkbox" id="cap-skill-write"> 写作</label>
            <label><input type="checkbox" id="cap-skill-companion"> 陪伴</label>
          </div>` : ""}
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
      ${FEATURES.workspace ? `
      <div class="card-box">
        <h3>工作区</h3>
        <p class="hint">所有卡片共用一个工作区 <code>data/workspace-files</code>：换卡只换对话，文件不变。</p>
        <div id="ws-overview" class="small-out">读取中…</div>
      </div>` : ""}
    </div>
  </div>`;
}

let mcpServers = [];
let mcpEditing = -1; // >=0 编辑中；-1 新增
let mcpTestTools = [];

function initWorkbenchSettings() {
  // ---- 工作模式开关 ----
  $("#wb-switch").checked = workbenchOn();
  $("#wb-switch").addEventListener("change", () => {
    setWorkbenchOn($("#wb-switch").checked);
    $("#wb-go").style.display = $("#wb-switch").checked ? "" : "none";
    $("#wb-switch-msg").textContent = $("#wb-switch").checked
      ? "已开启：首页将变为工作台"
      : "已关闭：首页恢复普通样式";
  });
  $("#wb-go").addEventListener("click", () => {
    if ((location.hash || "").replace(/^#\/?/, "") === "home") router();
    else location.hash = "#/home";
  });
  $("#wb-go").style.display = workbenchOn() ? "" : "none";

  // ---- 默认能力（未启用的功能对应的勾选框不会渲染，取值用可选链兜底） ----
  const def = capDefaults();
  const tools = def.tools ?? [];
  if ($("#cap-code")) $("#cap-code").checked = tools.includes("code_exec");
  if ($("#cap-file")) $("#cap-file").checked = tools.includes("sandbox_list");
  $("#cap-search").checked = tools.includes("web_search");
  $("#cap-weather").checked = tools.includes("weather");
  $("#cap-memory").checked = tools.includes("memory_save");
  const skills = def.skills ?? [];
  if ($("#cap-skill-code")) {
    $("#cap-skill-code").checked = skills.includes("code_expert");
    $("#cap-skill-trans").checked = skills.includes("translator");
    $("#cap-skill-write").checked = skills.includes("writing");
    $("#cap-skill-companion").checked = skills.includes("companion");
  }
  $("#cap-thinking").value = def.thinking ?? "auto";
  $("#btn-cap-save").addEventListener("click", () => {
    const t = [];
    if ($("#cap-code")?.checked) t.push("code_exec");
    if ($("#cap-file")?.checked) t.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
    if ($("#cap-search").checked) t.push("web_search");
    if ($("#cap-weather").checked) t.push("weather");
    if ($("#cap-memory").checked) t.push("memory_save");
    const s = [];
    if ($("#cap-skill-code")?.checked) s.push("code_expert");
    if ($("#cap-skill-trans")?.checked) s.push("translator");
    if ($("#cap-skill-write")?.checked) s.push("writing");
    if ($("#cap-skill-companion")?.checked) s.push("companion");
    saveCapDefaults({ tools: t, skills: s, thinking: $("#cap-thinking").value });
    $("#cap-msg").textContent = "✓ 已保存";
  });

  if (FEATURES.workspace) wsLoadOverview();
}

function mcpHeadersText(s) {
  return s?.headers ? Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
}
function mcpParseHeaders(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m && m[1].trim()) out[m[1].trim()] = m[2].trim();
  }
  return Object.keys(out).length ? out : undefined;
}

async function mcpLoad() {
  try {
    const cfg = await api.get("/api/mcp/config");
    mcpServers = cfg.servers ?? [];
  } catch { mcpServers = []; }
  mcpRenderList();
}

async function mcpSave() {
  try {
    const r = await api.send("/api/mcp/config", { method: "POST", body: JSON.stringify({ servers: mcpServers }) });
    const cfg = await api.get("/api/mcp/config").catch(() => null);
    if (cfg) mcpServers = cfg.servers ?? [];
    toast(`✓ MCP 已保存（${r.servers} 个服务器）`);
  } catch (e) { toast("MCP 保存失败：" + e.message, false); }
}

function mcpRenderList() {
  const el = $("#mcp-list");
  if (!el) return;
  el.innerHTML = "";
  if (!mcpServers.length) { el.innerHTML = '<div class="muted">还没有配置 MCP 服务器</div>'; return; }
  mcpServers.forEach((s, i) => {
    const total = (s.tools ?? []).length;
    const nTools = (s.tools ?? []).filter((t) => t.enabled).length;
    const sum = s.type === "stdio" ? (s.command ?? "") + " " + (s.args ?? []).join(" ") : (s.url ?? "");
    const div = document.createElement("div");
    div.className = "mcp-item";
    div.innerHTML = `
      <label class="mcp-enable"><input type="checkbox" data-mcp-enable="${i}" ${s.enabled ? "checked" : ""}>${escapeHtml(s.name)}</label>
      <span class="mcp-type">${s.type === "stdio" ? "stdio" : s.type === "sse" ? "SSE" : "StreamableHTTP"}</span>
      <span class="mcp-sum" title="${escapeHtml(sum)}">${escapeHtml(sum || "—")}</span>
      <span class="mcp-tools">${total ? nTools + "/" + total + " 工具" : "—"}</span>
      <button class="ghost small-btn" data-mcp-edit="${i}">编辑</button>
      <button class="ghost small-btn" data-mcp-del="${i}">删除</button>`;
    el.appendChild(div);
  });
  el.querySelectorAll("[data-mcp-enable]").forEach((c) => c.addEventListener("change", async () => {
    const i = Number(c.dataset.mcpEnable);
    mcpServers[i].enabled = c.checked;
    await mcpSave();
    mcpRenderList();
  }));
  el.querySelectorAll("[data-mcp-edit]").forEach((b) => b.addEventListener("click", () => mcpEdit(Number(b.dataset.mcpEdit))));
  el.querySelectorAll("[data-mcp-del]").forEach((b) => b.addEventListener("click", async () => {
    const i = Number(b.dataset.mcpDel);
    if (!confirm(`删除 MCP 服务器「${mcpServers[i].name}」？`)) return;
    mcpServers.splice(i, 1);
    await mcpSave();
    mcpRenderList();
  }));
}

function mcpEdit(idx) {
  mcpEditing = idx;
  const s = idx >= 0 ? mcpServers[idx] : { name: "", enabled: true, type: "stdio" };
  mcpTestTools = [];
  const wrap = $("#mcp-form-wrap");
  wrap.style.display = "block";
  wrap.innerHTML = `
    <div class="mcp-form">
      <h4>${idx >= 0 ? "编辑服务器" : "添加服务器"}</h4>
      <div class="form">
        <label>名称</label><input id="mcp-f-name" value="${escapeHtml(s.name ?? "")}" placeholder="如 文件系统">
        <label>类型</label>
        <select id="mcp-f-type">
          <option value="stdio" ${(s.type ?? "stdio") === "stdio" ? "selected" : ""}>本地程序（stdio）</option>
          <option value="sse" ${s.type === "sse" ? "selected" : ""}>远程 SSE</option>
          <option value="streamable-http" ${s.type === "streamable-http" ? "selected" : ""}>远程 StreamableHTTP</option>
        </select>
        <div id="mcp-f-stdio">
          <label>启动命令</label><input id="mcp-f-command" value="${escapeHtml(s.command ?? "")}" placeholder="如 npx">
          <label>参数（空格分隔）</label><input id="mcp-f-args" value="${escapeHtml((s.args ?? []).join(" "))}" placeholder="如 -y @modelcontextprotocol/server-filesystem ./workspace">
        </div>
        <div id="mcp-f-http" style="display:none">
          <label>连接 URL</label><input id="mcp-f-url" value="${escapeHtml(s.url ?? "")}" placeholder="如 https://mcp.example.com/sse">
        </div>
        <label>请求头（每行 Key: Value，可选）</label>
        <textarea id="mcp-f-headers" rows="2" placeholder="Authorization: Bearer xxx">${escapeHtml(mcpHeadersText(s))}</textarea>
        <div class="row" style="margin-top:8px">
          <button id="mcp-f-test" class="ghost small-btn">测试连接</button>
          <button id="mcp-f-save" class="primary small-btn">保存</button>
          <button id="mcp-f-cancel" class="ghost small-btn">取消</button>
        </div>
        <div id="mcp-f-result" class="status"></div>
        <div id="mcp-f-tools"></div>
      </div>
    </div>`;
  const syncType = () => {
    const t = $("#mcp-f-type").value;
    $("#mcp-f-stdio").style.display = t === "stdio" ? "" : "none";
    $("#mcp-f-http").style.display = t === "stdio" ? "none" : "";
  };
  $("#mcp-f-type").addEventListener("change", syncType);
  syncType();
  $("#mcp-f-cancel").addEventListener("click", () => { wrap.style.display = "none"; mcpEditing = -1; });
  $("#mcp-f-test").addEventListener("click", mcpTestForm);
  $("#mcp-f-save").addEventListener("click", mcpSaveForm);
}

function mcpCollectForm() {
  const type = $("#mcp-f-type").value;
  return {
    name: $("#mcp-f-name").value.trim() || "未命名服务器",
    enabled: mcpEditing >= 0 ? mcpServers[mcpEditing].enabled : true,
    type,
    command: type === "stdio" ? ($("#mcp-f-command").value.trim() || undefined) : undefined,
    args: type === "stdio" && $("#mcp-f-args").value.trim()
      ? $("#mcp-f-args").value.trim().split(/\s+/).map((x) => x.trim()).filter(Boolean)
      : undefined,
    url: type !== "stdio" ? ($("#mcp-f-url").value.trim() || undefined) : undefined,
    headers: mcpParseHeaders($("#mcp-f-headers").value),
  };
}

async function mcpTestForm() {
  const res = $("#mcp-f-result");
  const btn = $("#mcp-f-test");
  btn.disabled = true;
  res.textContent = "连接中…";
  try {
    const r = await api.send("/api/mcp/test", { method: "POST", body: JSON.stringify({ server: mcpCollectForm() }) });
    if (!r.ok) { res.textContent = "✗ " + (r.error ?? "连接失败"); return; }
    mcpTestTools = r.tools;
    res.textContent = `✓ 连接成功，共 ${r.tools.length} 个工具，勾选要启用的（保存时生效）：`;
    const box = $("#mcp-f-tools");
    box.innerHTML = r.tools.length
      ? r.tools.map((t) => `<label class="mcp-tool"><input type="checkbox" data-mcp-tool="${escapeHtml(t.name)}" checked> ${escapeHtml(t.name)}${t.description ? `<small>${escapeHtml(String(t.description).slice(0, 80))}</small>` : ""}</label>`).join("")
      : '<span class="muted">（该服务器没有暴露工具）</span>';
  } catch (e) { res.textContent = "✗ " + e.message; }
  btn.disabled = false;
}

async function mcpSaveForm() {
  const s = mcpCollectForm();
  if (s.type === "stdio" && !s.command) return toast("启动命令不能为空", false);
  if (s.type !== "stdio" && !s.url) return toast("连接 URL 不能为空", false);
  const toolChecks = [...document.querySelectorAll("[data-mcp-tool]")];
  if (toolChecks.length) s.tools = toolChecks.map((c) => ({ name: c.dataset.mcpTool, enabled: c.checked }));
  if (mcpEditing >= 0) mcpServers[mcpEditing] = { ...mcpServers[mcpEditing], ...s };
  else mcpServers.push(s);
  await mcpSave();
  mcpRenderList();
  $("#mcp-form-wrap").style.display = "none";
  mcpEditing = -1;
  mcpTestTools = [];
}

async function wsLoadOverview() {
  const el = $("#ws-overview");
  try {
    const r = await api.get("/api/workspace/overview");
    const size = r.size < 1024 * 1024 ? (r.size / 1024).toFixed(1) + " KB" : (r.size / 1024 / 1024).toFixed(1) + " MB";
    el.innerHTML = `<div class="ws-row"><code>${escapeHtml(r.path ?? "data/workspace-files")}</code></div>
      <div class="ws-row"><span>共享工作区</span><span class="ws-meta">${r.files} 个文件 · ${size}</span></div>`;
  } catch (e) { el.innerHTML = '<span class="muted">读取失败：' + escapeHtml(e.message) + "</span>"; }
}

// ============================================================
//  视图：预设库（侧边栏「预设」）—— 档位/风格管理，卡片高级配置里引用
// ============================================================
let presetStoreData = { tiers: [], styles: [] };

async function loadPresetStore() {
  presetStoreData = await api.get("/api/presets").catch(() => ({ tiers: [], styles: [] }));
  return presetStoreData;
}

function renderPresetEditor(kind, list) {
  const title = kind === "tier" ? "档位（扮演模式与内容尺度）" : "风格（叙述风格）";
  const hint =
    kind === "tier"
      ? "档位决定扮演模式：不破甲=标准沉浸（剧情内克制处理敏感内容）；破甲=深度沉浸（允许成人向虚构剧情）。由卡片选择是否启用。"
      : "风格决定输出形式：纯对话（QQ聊天式）/ 轻描写 / 重描写（心理＋动作＋环境）。";
  return `
  <div class="card-box">
    <h3>${icon("sliders")} ${title}</h3>
    <p class="hint">${hint}</p>
    <div class="preset-list" id="preset-${kind}-list">
      ${list
        .map(
          (p) => `
      <div class="preset-item" data-kind="${kind}" data-id="${escapeHtml(p.id)}">
        <div class="preset-item-head">
          <b>${escapeHtml(p.name)}</b>
          <span class="preset-badge ${p.builtin ? "builtin" : "custom"}">${p.builtin ? "内置" : "自定义"}</span>
          <div class="row" style="margin-left:auto">
            <button class="ghost small-btn preset-edit" title="编辑">${icon("pen")}</button>
            <button class="ghost small-btn preset-del" title="删除" ${p.builtin ? "disabled" : ""}>${icon("trash")}</button>
          </div>
        </div>
        <pre class="preset-preview">${escapeHtml(p.content.slice(0, 220))}${p.content.length > 220 ? "…" : ""}</pre>
      </div>`
        )
        .join("")}
    </div>
    <div class="row" style="margin-top:10px">
      <button class="ghost small-btn preset-add" data-kind="${kind}">${icon("plus")} 新增自定义${kind === "tier" ? "档位" : "风格"}</button>
      <button class="ghost small-btn preset-reset-all" data-kind="${kind}" style="margin-left:8px">恢复内置</button>
    </div>
  </div>`;
}

function renderPresets() {
  const { tiers, styles } = presetStoreData;
  return `
  <div class="view">
    <div class="page-head">
      <h2>${icon("sliders")} 角色扮演预设</h2>
      <p class="hint">预设 = 档位 × 风格。在每张卡的「高级配置」里选择启用（破甲用不用由你自己定）。网页试聊与 QQ/微信 机器人共用这套预设。</p>
    </div>
    ${renderPresetEditor("tier", tiers)}
    <div style="height:12px"></div>
    ${renderPresetEditor("style", styles)}
    <div class="card-box" style="margin-top:12px">
      <h3>${icon("info")} 说明</h3>
      <ul class="guide">
        <li>卡片高级配置（编辑卡 → 右上角 ⚙ 高级配置）里可选「档位」与「风格」，选了才生效，默认不启用。</li>
        <li>档位不破甲/破甲可分别与三种风格自由组合（如 破甲×纯对话、不破甲×重描写）。</li>
        <li>能力触发：卡开了「生图」能力后，AI 会在场景需要时主动生图发图（配置见 生图配置 页）。</li>
        <li>改完预设文本后，网页试聊立即生效；QQ/微信 机器人需在卡片 🤖 机器人里点「重编译」。</li>
      </ul>
    </div>
  </div>`;
}

async function initPresets() {
  await loadPresetStore();
  $("#view").innerHTML = renderPresets();
  bindPresets();
}

function refreshPresetView() {
  loadPresetStore().then(() => {
    $("#view").innerHTML = renderPresets();
    bindPresets();
  });
}

function bindPresets() {
  const openEditor = (kind, item, isNew) => {
    const name = isNew ? "" : item.name;
    const content = isNew ? "" : item.content;
    const overlay = document.createElement("div");
    overlay.className = "bot-overlay";
    overlay.id = "preset-editor-overlay";
    overlay.innerHTML = `<div class="bot-dialog adv-dialog" style="max-width:640px">
      <div class="bot-dialog-head">
        <h3>${isNew ? "新增" : "编辑"}${kind === "tier" ? "档位" : "风格"}${isNew ? "" : " · " + escapeHtml(item.name)}</h3>
        <button class="ghost small-btn" id="pe-close">${icon("x")}</button>
      </div>
      <div class="bot-form">
        <label>名称<input id="pe-name" value="${escapeHtml(name)}" placeholder="${kind === "tier" ? "如：我的档位" : "如：日记体"}"></label>
        <label>内容（注入 system prompt 的文本，支持多行）<textarea id="pe-content" rows="14" placeholder="# 角色扮演模式（自定义）&#10;&#10;……">${escapeHtml(content)}</textarea></label>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:6px">
        <button id="pe-save" class="primary">保存</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#pe-close").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#pe-save").addEventListener("click", async () => {
      const name = overlay.querySelector("#pe-name").value.trim();
      const content = overlay.querySelector("#pe-content").value;
      try {
        if (isNew) {
          presetStoreData = await api.send("/api/presets", { method: "POST", body: JSON.stringify({ kind, name, content }) });
        } else {
          presetStoreData = await api.send(`/api/presets/${kind}/${item.id}`, { method: "PUT", body: JSON.stringify({ name, content }) });
        }
        overlay.remove();
        refreshPresetView();
        toast("✓ 预设已保存");
      } catch (e) {
        toast("保存失败：" + e.message, false);
      }
    });
  };

  const bindList = (kind) => {
    $(`#preset-${kind}-list`)?.addEventListener("click", (e) => {
      const edit = e.target.closest(".preset-edit");
      const del = e.target.closest(".preset-del");
      const itemEl = e.target.closest(".preset-item");
      if (!itemEl) return;
      const id = itemEl.dataset.id;
      const item = presetStoreData[kind === "tier" ? "tiers" : "styles"].find((p) => p.id === id);
      if (!item) return;
      if (edit) openEditor(kind, item, false);
      if (del) {
        api.send(`/api/presets/${kind}/${id}`, { method: "DELETE" })
          .then((data) => { presetStoreData = data; refreshPresetView(); toast("已删除"); })
          .catch((err) => toast("删除失败：" + err.message, false));
      }
    });
  };
  bindList("tier");
  bindList("style");
  document.querySelectorAll(".preset-add").forEach((btn) => {
    btn.addEventListener("click", () => openEditor(btn.dataset.kind, null, true));
  });
  document.querySelectorAll(".preset-reset-all").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("恢复内置档位/风格？自定义条目保留，内置条目的文本会重置为代码默认。")) return;
      try {
        presetStoreData = await api.send("/api/presets/reset", { method: "POST" });
        refreshPresetView();
        toast("✓ 已恢复内置");
      } catch (e) {
        toast("恢复失败：" + e.message, false);
      }
    });
  });
}

// ---- 设置（原「数据」页的备份与记忆已并入这里） ----
/** 拉运行日志到设置页的面板里（按级别/来源/关键词筛） */
async function loadLogs() {
  const box = $("#log-list");
  if (!box) return;
  try {
    const level = $("#log-level")?.value ?? "all";
    const tag = $("#log-tag")?.value ?? "all";
    const q = ($("#log-q")?.value ?? "").trim();
    const r = await api.get(
      `/api/logs?level=${encodeURIComponent(level)}&tag=${encodeURIComponent(tag)}&q=${encodeURIComponent(q)}`
    );
    // 来源下拉按实际出现过的标签填充（保留当前选择）
    const tagSel = $("#log-tag");
    if (tagSel) {
      const cur = tagSel.value;
      const opts = ['<option value="all">全部来源</option>']
        .concat((r.tags ?? []).map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`))
        .join("");
      if (tagSel.innerHTML !== opts) {
        tagSel.innerHTML = opts;
        tagSel.value = (r.tags ?? []).includes(cur) ? cur : "all";
      }
    }
    if (!r.entries?.length) {
      box.innerHTML = '<div class="muted">暂无日志（有报错会自动记在这里）</div>';
      return;
    }
    box.innerHTML = r.entries
      .map((e) => {
        const t = new Date(e.ts);
        const time = isNaN(t) ? "" : `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
        const lv = e.level === "error" ? "err" : e.level === "warn" ? "warn" : "info";
        const detail = e.detail && e.detail !== e.msg
          ? `<details class="log-detail"><summary>详情</summary><pre>${escapeHtml(e.detail)}</pre></details>`
          : "";
        return `<div class="log-row log-${lv}">
          <span class="log-time">${time}</span>
          <span class="log-tag">${escapeHtml(e.tag)}</span>
          <span class="log-msg">${escapeHtml(e.msg)}</span>
          ${detail}
        </div>`;
      })
      .join("");
  } catch (e) {
    box.innerHTML = `<div class="muted">读取日志失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderSettings() {
  return `
  <div class="view">
    <div class="page-head"><h2>设置</h2><p class="hint">技能、MCP 工具服务器、公告与数据备份</p></div>

    ${FEATURES.skills ? `
    <div class="card-box">
      <h3>${icon("tool")} 技能库</h3>
      <p class="hint">技能 = 给 AI 追加的一段能力说明（如「代码专家」）。内置四个不可改，你可以自己加；聊天时在能力开关里勾选生效。</p>
      <div id="skill-list" class="skill-list"></div>
      <div class="row" style="margin-top:8px"><button id="skill-add" class="ghost small-btn">+ 添加技能</button></div>
      <div id="skill-form-wrap" style="display:none"></div>
    </div>` : ""}

    ${FEATURES.mcp ? `
    <div class="card-box">
      <h3>${icon("zap")} MCP 服务器</h3>
      <p class="hint">连接外部工具服务器：本地程序（stdio）或远程 URL（SSE / StreamableHTTP）。工具调用默认需你确认后执行。</p>
      <div id="mcp-list" class="mcp-list"></div>
      <div class="row" style="margin-top:8px"><button id="mcp-add" class="ghost small-btn">+ 添加服务器</button></div>
      <div id="mcp-form-wrap" style="display:none"></div>
      <details class="mcp-json">
        <summary>JSON 导入 / 导出（高级）</summary>
        <textarea id="mcp-config" rows="6" spellcheck="false"></textarea>
        <div class="row" style="margin-top:8px">
          <button id="btn-mcp-import" class="ghost small-btn">从 JSON 导入</button>
          <button id="btn-mcp-export" class="ghost small-btn">导出为 JSON</button>
        </div>
        <div id="mcp-msg" class="status"></div>
      </details>
    </div>` : ""}

    <div class="card-box">
      <h3>${icon("clipboard")} 运行日志</h3>
      <p class="hint">出问题先看这里：聊天、通道、生图、语音、记忆的报错都会记下来。只留最近 500 条。</p>
      <div class="row log-toolbar">
        <select id="log-level" style="width:auto">
          <option value="all">全部级别</option>
          <option value="error">只看报错</option>
          <option value="warn">只看警告</option>
          <option value="info">只看普通</option>
        </select>
        <select id="log-tag" style="width:auto"><option value="all">全部来源</option></select>
        <input id="log-q" placeholder="搜关键词…" style="flex:1;min-width:120px">
        <button id="log-refresh" class="ghost small-btn">刷新</button>
        <button id="log-clear" class="danger small-btn">清空</button>
      </div>
      <div id="log-list" class="small-out tall">加载中…</div>
    </div>

    <div class="card-box">
      <h3>${icon("store")} 插件 <span class="plug-badge">暂未开放</span></h3>
      <p class="hint">插件功能暂未开放（正在评估可用性）。已安装的插件会继续生效，但市场浏览、安装、卸载等操作暂不提供；开放后会回到这里。</p>
      <div id="plug-installed-ro" class="small-out tall">加载中…</div>
    </div>

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
      <div class="card-box">
        <h3>${icon("package")} 数据备份</h3>
        <p class="hint">全部卡片 + 记忆 + 各项配置 → 一个 JSON 文件</p>
        <button id="btn-backup" class="primary">下载备份</button>
        <h3 style="margin-top:14px">全部记忆</h3>
        <div id="memory-list" class="small-out tall"></div>
      </div>
    </div>
  </div>`;
}
function initSettings() {
  // ---- 公告 ----
  api.get("/api/announcement").then((a) => { $("#notice-text").value = a.text ?? ""; }).catch(() => {});
  $("#notice-save").addEventListener("click", async () => {
    try {
      await api.send("/api/announcement", { method: "POST", body: JSON.stringify({ text: $("#notice-text").value }) });
      $("#notice-msg").textContent = "✓ 已保存";
      toast("✓ 公告已更新");
    } catch (e) { $("#notice-msg").textContent = "保存失败：" + e.message; }
  });

  // ---- 数据备份 + 记忆总览（原「数据」页并进来） ----
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

  // 服务状态点仍然要亮（原来挂在服务信息块里）
  api.get("/api/health").then((h) => {
    $("#drawer-meta").textContent = `SoulBox`;
    $("#svc-dot").classList.add("on");
  }).catch(() => { $("#svc-dot").classList.add("bad"); });

  // ---- 运行日志 ----
  $("#log-refresh").addEventListener("click", loadLogs);
  $("#log-level").addEventListener("change", loadLogs);
  $("#log-tag").addEventListener("change", loadLogs);
  let logQTimer = null;
  $("#log-q").addEventListener("input", () => {
    clearTimeout(logQTimer);
    logQTimer = setTimeout(loadLogs, 300);
  });
  $("#log-clear").addEventListener("click", async () => {
    if (!confirm("清空运行日志？")) return;
    try {
      await api.send("/api/logs/clear", { method: "POST" });
      toast("✓ 日志已清空");
      loadLogs();
    } catch (e) { toast("清空失败：" + e.message, false); }
  });
  loadLogs();

  // ---- 插件（暂未开放）：只读展示已安装列表 ----
  api.get("/api/plugins/installed").then((d) => {
    const el = $("#plug-installed-ro");
    if (!el) return;
    const list = (d.plugins ?? []).filter((p) => p.id && p.enabled !== false);
    el.textContent = list.length
      ? list.map((p) => `· ${p.name || p.id} v${p.version || ""}${p.enabled === false ? "（已停用）" : ""}${p.source ? "（" + p.source + "）" : ""}`).join("\n")
      : "（未安装任何插件）";
  }).catch(() => {
    const el = $("#plug-installed-ro");
    if (el) el.textContent = "（读取失败）";
  });

  // ---- 技能库（FEATURES.skills 关闭时整块不渲染，跳过绑定） ----
  if (FEATURES.skills) {
    $("#skill-add").addEventListener("click", () => skillEdit(-1));
    skillLoad();
  }

  // ---- MCP（同上） ----
  if (FEATURES.mcp) {
    $("#mcp-add").addEventListener("click", () => mcpEdit(-1));
    $("#btn-mcp-export").addEventListener("click", () => {
      $("#mcp-config").value = JSON.stringify(mcpServers, null, 2);
    });
    $("#btn-mcp-import").addEventListener("click", async () => {
      try {
        const arr = JSON.parse($("#mcp-config").value);
        if (!Array.isArray(arr)) throw new Error("需要 JSON 数组");
        mcpServers = arr;
        await mcpSave();
        mcpRenderList();
        $("#mcp-msg").textContent = "✓ 已导入并重连";
      } catch (e) { $("#mcp-msg").textContent = "导入失败：" + e.message; }
    });
    mcpLoad();
  }
}

// ============================================================
//  技能库（内置只读 + 用户自定义增删改）
// ============================================================
let skillsAll = [];      // 内置 + 自定义（后端合并返回）
let skillEditing = -1;   // 自定义技能在 userSkills 里的下标；-1 = 新增

function userSkills() { return skillsAll.filter((s) => !s.builtin); }

async function skillLoad() {
  try {
    const r = await api.get("/api/skills");
    skillsAll = r.skills ?? [];
  } catch { skillsAll = []; }
  skillRenderList();
}

async function skillSave() {
  try {
    const r = await api.send("/api/skills", { method: "POST", body: JSON.stringify({ skills: userSkills() }) });
    const fresh = await api.get("/api/skills").catch(() => null);
    if (fresh) skillsAll = fresh.skills ?? [];
    toast(`✓ 技能已保存（自定义 ${r.count} 个）`);
  } catch (e) { toast("保存失败：" + e.message, false); }
}

function skillRenderList() {
  const el = $("#skill-list");
  if (!el) return;
  el.innerHTML = "";
  for (const s of skillsAll) {
    const div = document.createElement("div");
    div.className = "skill-item";
    const idx = s.builtin ? -1 : userSkills().findIndex((u) => u.id === s.id);
    div.innerHTML = `
      <span class="skill-name">${escapeHtml(s.name)}</span>
      ${s.builtin
        ? '<span class="skill-tag">内置</span>'
        : `<label class="skill-enable"><input type="checkbox" data-skill-enable="${idx}" ${s.enabled ? "checked" : ""}>启用</label>`}
      <span class="skill-prompt" title="${escapeHtml(s.prompt)}">${escapeHtml(s.prompt.slice(0, 60))}${s.prompt.length > 60 ? "…" : ""}</span>
      ${s.builtin ? "" : `<button class="ghost small-btn" data-skill-edit="${idx}">编辑</button>
      <button class="ghost small-btn" data-skill-del="${idx}">删除</button>`}`;
    el.appendChild(div);
  }
  el.querySelectorAll("[data-skill-enable]").forEach((c) => c.addEventListener("change", async () => {
    const list = userSkills();
    list[Number(c.dataset.skillEnable)].enabled = c.checked;
    skillsAll = [...skillsAll.filter((s) => s.builtin), ...list];
    await skillSave();
    skillRenderList();
  }));
  el.querySelectorAll("[data-skill-edit]").forEach((b) => b.addEventListener("click", () => skillEdit(Number(b.dataset.skillEdit))));
  el.querySelectorAll("[data-skill-del]").forEach((b) => b.addEventListener("click", async () => {
    const list = userSkills();
    const i = Number(b.dataset.skillDel);
    if (!confirm(`删除技能「${list[i].name}」？`)) return;
    list.splice(i, 1);
    skillsAll = [...skillsAll.filter((s) => s.builtin), ...list];
    await skillSave();
    skillRenderList();
  }));
}

function skillEdit(idx) {
  skillEditing = idx;
  const s = idx >= 0 ? userSkills()[idx] : { name: "", prompt: "" };
  const wrap = $("#skill-form-wrap");
  wrap.style.display = "block";
  wrap.innerHTML = `
    <div class="mcp-form">
      <h4>${idx >= 0 ? "编辑技能" : "添加技能"}</h4>
      <div class="form">
        <label>名称</label><input id="skill-f-name" value="${escapeHtml(s.name ?? "")}" placeholder="如 法律顾问">
        <label>提示词（告诉 AI 这个技能该怎么做事）</label>
        <textarea id="skill-f-prompt" rows="4" placeholder="【技能：法律顾问】遇到法律问题时：先说明不构成正式法律意见，再解释相关条款…">${escapeHtml(s.prompt ?? "")}</textarea>
        <div class="row" style="margin-top:8px">
          <button id="skill-f-save" class="primary small-btn">保存</button>
          <button id="skill-f-cancel" class="ghost small-btn">取消</button>
        </div>
      </div>
    </div>`;
  $("#skill-f-cancel").addEventListener("click", () => { wrap.style.display = "none"; skillEditing = -1; });
  $("#skill-f-save").addEventListener("click", async () => {
    const name = $("#skill-f-name").value.trim();
    const prompt = $("#skill-f-prompt").value.trim();
    if (!prompt) return toast("提示词不能为空", false);
    const list = userSkills();
    if (skillEditing >= 0) list[skillEditing] = { ...list[skillEditing], name, prompt };
    else list.push({ name, prompt, enabled: true });
    skillsAll = [...skillsAll.filter((x) => x.builtin), ...list];
    await skillSave();
    skillRenderList();
    wrap.style.display = "none";
    skillEditing = -1;
  });
}

// ============================================================
//  视图：表情包库（全局共享，所有角色卡共用）
// ============================================================
function renderEmojis() {
  return `
  <div class="view">
    <div class="page-head">
      <h2>表情包库</h2>
      <p class="hint">全部角色卡共用这一套表情。AI 想发表情时会写 [表情:名字]，聊天里渲染成图片；名字和解释会告诉 AI，所以解释要写清楚什么场合用</p>
    </div>
    <div class="card-box">
      <h3>添加表情</h3>
      <div class="form">
        <div class="cf-grid2">
          <div><label>表情名（AI 用它引用，唯一）</label><input id="em-name" placeholder="如：得意、无语、抱抱"></div>
          <div><label>什么场合用（给 AI 看）</label><input id="em-exp" placeholder="如：调皮得意，占了上风的时候"></div>
        </div>
        <label>图片（png / jpg / gif / webp）</label>
        <input type="file" id="em-file" accept=".png,.jpg,.jpeg,.gif,.webp">
        <div class="row">
          <button id="em-add" class="primary">${icon("plus")} 添加到库</button>
          <span id="em-msg" class="status"></span>
        </div>
      </div>
    </div>
    <div class="card-box">
      <h3>库里的表情 <span id="em-count" class="hint"></span></h3>
      <div id="em-list" class="emoji-grid"></div>
    </div>
  </div>`;
}

function initEmojis() {
  $("#em-add").addEventListener("click", addEmojiToLib);
  loadEmojiList();
}

async function loadEmojiList() {
  const box = $("#em-list");
  if (!box) return;
  try {
    const r = await api.get("/api/emojis");
    emojiLib = r.emojis ?? [];
    if ($("#em-count")) $("#em-count").textContent = `${emojiLib.length} / ${r.max ?? 200}`;
    if (!emojiLib.length) {
      box.innerHTML = '<div class="muted">库里还没有表情，上面添加第一个</div>';
      return;
    }
    box.innerHTML = emojiLib
      .map(
        (e) => `<div class="emoji-item" data-id="${escapeHtml(e.id)}">
          <img src="${escapeHtml(e.url)}" alt="${escapeHtml(e.name)}" loading="lazy">
          <div class="emoji-name">${escapeHtml(e.name)}</div>
          <div class="emoji-exp">${escapeHtml(e.explanation || "（未写用法）")}</div>
          <div class="row">
            <button class="ghost small-btn" data-act="edit">编辑</button>
            <button class="danger small-btn" data-act="del">删除</button>
          </div>
        </div>`
      )
      .join("");
    box.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.closest(".emoji-item").dataset.id;
        const item = emojiLib.find((x) => x.id === id);
        if (!item) return;
        if (b.dataset.act === "del") return delEmoji(item);
        editEmoji(item);
      })
    );
  } catch (e) {
    box.innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

async function addEmojiToLib() {
  const name = $("#em-name").value.trim();
  const f = $("#em-file").files[0];
  if (!name) return toast("请填表情名", false);
  if (!f) return toast("请选择图片", false);
  const btn = $("#em-add");
  btn.disabled = true;
  try {
    const b64 = await fileToBase64(f);
    const ext = (f.name.split(".").pop() || "png").toLowerCase();
    await api.send("/api/emojis", {
      method: "POST",
      body: JSON.stringify({ name, explanation: $("#em-exp").value.trim(), imageBase64: b64, ext }),
    });
    $("#em-name").value = "";
    $("#em-exp").value = "";
    $("#em-file").value = "";
    toast("✓ 已添加");
    await loadEmojiList();
  } catch (e) {
    toast("添加失败：" + e.message, false);
  }
  btn.disabled = false;
}

async function editEmoji(item) {
  const name = prompt("表情名（AI 用它引用）", item.name);
  if (name === null) return;
  const explanation = prompt("什么场合用（给 AI 看）", item.explanation || "");
  if (explanation === null) return;
  try {
    await api.send(`/api/emojis/${item.id}`, { method: "POST", body: JSON.stringify({ name, explanation }) });
    toast("✓ 已保存");
    await loadEmojiList();
  } catch (e) {
    toast("保存失败：" + e.message, false);
  }
}

async function delEmoji(item) {
  if (!confirm(`删除表情「${item.name}」？`)) return;
  try {
    await api.send(`/api/emojis/${item.id}`, { method: "DELETE" });
    toast("✓ 已删除");
    await loadEmojiList();
  } catch (e) {
    toast("删除失败：" + e.message, false);
  }
}

// ============================================================
//  路由表 + 启动
// ============================================================
const routes = {
  home: { render: renderHome, init: initHome },
  cards: { render: renderCards, init: initCards },
  presets: { render: renderPresets, init: initPresets },
  create: { render: renderCreate, init: initCreate },
  distill: { render: renderDistill, init: initDistill },
  channels: { render: renderChannels, init: initChannels },
  api: { render: renderApi, init: initApi },
  imagegen: { render: renderImagegen, init: initImagegen },
  tts: { render: renderTtsPage, init: initTtsPage },
  memory: { render: renderMemory, init: initMemory },
  emojis: { render: renderEmojis, init: initEmojis },
  // 插件商店已并入设置页（暂未开放），旧地址 #/plugins 兼容跳转设置
  plugins: { render: renderSettings, init: initSettings },
  workbench: { render: renderWorkbenchSettings, init: initWorkbenchSettings },
  capabilities: { render: renderWorkbenchSettings, init: initWorkbenchSettings }, // 旧地址 #/capabilities 兼容
  data: { render: renderSettings, init: initSettings }, // 旧地址 #/data 兼容（已并入设置）
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
// 同时预载共享表情库：聊天气泡渲染 [表情:名字] 要靠它查图
loadProfile().finally(() => {
  void loadEmojiLib();
  router();
});
