// openclaw-shell 前端 v3：白色主题 · 抽屉导航 · 表单化卡片 · 多提供商 · 每卡模型/记忆
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ================= 设备身份（分发形态：无注册无登录） =================
// 首次启动生成 32 位随机 hex 存 localStorage + cookie（cookie 让 <img> 等子资源也能带上身份）。
// 服务器按这个 ID 分数据命名空间；删 App/清数据 = 新 ID = 全新空白。
const OC_DEVICE = (() => {
  let id = localStorage.getItem("oc_device");
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    id = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("oc_device", id);
  }
  document.cookie =
    "oc_device=" + id + "; path=/; max-age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
  return id;
})();

// ================= 运行形态与身份（托管多租户 / 单用户自部署） =================
// 服务端 /api/admin/me 返回 { admin, hosted }：
//   hosted=false        → 单用户自部署（用户自己拉代码在本机跑），什么功能都全开
//   hosted=true & admin → 运营者（管理员设备 / 密码登录 / 运营者的 Basic）
//   hosted=true & !admin→ 分发用户：管理向功能（运行日志、本地语音兜底、通道/蒸馏/插件）不展示，
//                          后端对这些端点也直接 403（两边都关才算真关，见 FEATURES 的同一原则）
// 结果缓存进 localStorage：首屏要同步知道该显示什么，不能为它多等一次网络往返；
// 后台再刷新一次校正（换了身份/清过 cookie 的情况）。
let ocMode = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("ocs_mode") || "null");
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
})();
/** 分发用户（托管形态下的普通设备）——管理向功能对它隐藏 */
function ocIsDevice() {
  return !!ocMode && ocMode.hosted === true && ocMode.admin !== true;
}
/** 抽屉里对分发用户隐藏的条目（后端同名端点也 403，两边一致）
 *  ⚠️ **通道连接不在里面**：QQ/微信 是用户的核心体验，普通用户照旧能扫码绑自己的机器人
 *  （隔离靠后端的"账号归属"：用户只看得到、也只能动自己名下的账号）。
 *  预设页也不在这里 —— 只有内置档位组「默认」不给用户打开，见 presetGroupLocked()。 */
const OC_DEVICE_HIDDEN_ROUTES = ["plugins", "logs"];

/**
 * 这个预设组对当前身份是不是"锁住的"：
 * 内置档位组（对外叫「默认」，id 固定 break）是运营者管的破甲预设 ——
 * 普通用户只能看到它的名字，点不进去也改不了；管理员照旧能打开查看和编辑。
 */
function presetGroupLocked(kind, groupId) {
  return ocIsDevice() && kind === "tier" && groupId === "break";
}

// ================= 基础 =================
// 某些浏览器（如内嵌 webview）打开 URL 内嵌凭据（user:pass@host）时，页面内 fetch 不会自动携带，
// 首次 401 就用 URL 里的凭据显式重试一次
async function fetchApi(path, options = {}) {
  const headers = { "X-Device-Id": OC_DEVICE, ...(options.headers ?? {}) };
  let r = await fetch(path, { ...options, headers });
  if (r.status === 401 && location.username) {
    const token = btoa(unescape(encodeURIComponent(`${location.username}:${location.password}`)));
    r = await fetch(path, {
      ...options,
      headers: { ...headers, Authorization: "Basic " + token },
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

// ================= 接口缓存（stale-while-revalidate） =================
// 公网走 Cloudflare 隧道时每次往返 0.5-1.7s，而原来每切一次页面都重新请求全部数据，
// 于是每次点击都要吃这个延迟（表现为「卡库每次重新生成」「切页全部重载」）。
// 这里给低频变化的数据加一层内存缓存：命中就同步返回旧数据先渲染，同时后台静默刷新，
// 新数据到了再回调重绘。数据变更处调 cacheInvalidate() 保证不会看到旧内容。
const apiCache = new Map();   // path -> { data, ts, inflight }
const CACHE_TTL = 60_000;     // 超过这个时间的缓存仍可先用（陈旧），但一定会后台刷新

/** 同步取缓存数据（没有则 undefined），用于「先画后刷」的首帧渲染 */
function cachePeek(path) {
  return apiCache.get(path)?.data;
}

/**
 * 带缓存的 GET。
 * @param path 接口路径
 * @param onFresh 后台刷新拿到新数据时的回调（用于重绘）。有缓存时本函数立即返回缓存数据。
 */
async function cachedGet(path, onFresh) {
  const hit = apiCache.get(path);
  const fresh = hit && Date.now() - hit.ts < CACHE_TTL;
  // 后台刷新（同一路径并发只发一次请求）
  const revalidate = () => {
    if (hit?.inflight) return hit.inflight;
    const p = api.get(path)
      .then((data) => {
        apiCache.set(path, { data, ts: Date.now(), inflight: null });
        return data;
      })
      .catch((e) => {
        const cur = apiCache.get(path);
        if (cur) cur.inflight = null;
        throw e;
      });
    apiCache.set(path, { ...(hit ?? { data: undefined, ts: 0 }), inflight: p });
    return p;
  };
  if (hit && hit.data !== undefined) {
    // 新鲜期内（CACHE_TTL）直接用缓存，连后台请求都不发——公网上每个请求 0.5-1.7s，
    // 频繁切页反复重验会造成无谓流量与内容闪动。超过新鲜期才后台静默刷新。
    if (fresh) return hit.data;
    if (!hit.inflight) {
      revalidate()
        .then((data) => { if (onFresh && JSON.stringify(data) !== JSON.stringify(hit.data)) onFresh(data); })
        .catch(() => {});
    }
    return hit.data;
  }
  // 没缓存：只能等（首次进入）
  return revalidate();
}

/** 变更后失效缓存：传前缀，匹配的全清（如 "/api/cards" 会清掉带 query 的同族） */
function cacheInvalidate(...prefixes) {
  for (const p of prefixes) {
    for (const key of [...apiCache.keys()]) {
      if (key === p || key.startsWith(p)) apiCache.delete(key);
    }
  }
  // 卡片数据变了：聊天页快照里的卡对象（模型/能力/表情分组等）也过期了。
  // 只丢卡对象、保留聊天 DOM——改配置不该让已渲染的聊天记录重新加载一遍。
  if (prefixes.some((p) => String(p).startsWith("/api/cards"))) {
    try { lcSnap.cardObj = null; } catch { /* 首次 router 时 lcSnap 还在 TDZ */ }
  }
}

/** 失败自动重试一次（公网抖动时避免直接静默失败），仍失败则抛出让调用方显示错误 */
async function apiGetRetry(path, retries = 1) {
  try {
    return await api.get(path);
  } catch (e) {
    if (retries <= 0) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return apiGetRetry(path, retries - 1);
  }
}

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
// ---------- 原生壳桥（Android 套壳注入 window.SoulBoxNative；浏览器里不存在） ----------
// 套壳只加载服务器上的这份网页、不含业务代码，所以这里的写法必须"有桥就用、没桥走老路"：
// 同一份文件在浏览器 / 微信 / 套壳里行为都不冲突，壳也就永远不用跟着网页改动重打。
const ocNative = (typeof window !== "undefined" && window.SoulBoxNative) || null;
const ocHasNative = (m) => !!(ocNative && typeof ocNative[m] === "function");
/** 原生保存：每个文件弹一次系统「保存到」对话框（可存到任意文件夹） */
function ocNativeSave(name, mime, base64) {
  try {
    ocNative.saveFile(String(name || "soulbox"), String(mime || "application/octet-stream"), String(base64 || ""));
    return true;
  } catch (e) {
    console.warn("原生保存失败：", e);
    return false;
  }
}
/** Blob → base64（喂原生桥；原生侧 Base64 解码后写文件） */
function ocBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
/** data: URL → { mime, base64 }。两种形态都支持：base64 的（图片/音频）与 URI 编码的
 *  （备份 JSON 走的是 `data:application/json;charset=utf-8,%7B…`）——后者要按 UTF-8 转字节，
 *  不然中文卡片名进文件就成乱码。 */
function ocDataUrlToBase64(dataUrl) {
  const s = String(dataUrl || "");
  const comma = s.indexOf(",");
  if (!s.startsWith("data:") || comma < 0) return null;
  const head = s.slice(5, comma);
  const mime = (head.split(";")[0] || "application/octet-stream").trim() || "application/octet-stream";
  const body = s.slice(comma + 1);
  if (head.includes("base64")) return { mime, base64: body };
  try {
    const bytes = new TextEncoder().encode(decodeURIComponent(body));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { mime, base64: btoa(bin) };
  } catch (e) {
    console.warn("解析 dataUrl 失败：", e);
    return null;
  }
}
function downloadDataUrl(dataUrl, filename) {
  // 套壳里 <a download> 不会触发下载（WebView 不支持 data:/blob: 下载）→ 交给原生保存对话框
  if (ocHasNative("saveFile")) {
    const conv = ocDataUrlToBase64(dataUrl);
    if (conv && ocNativeSave(filename, conv.mime, conv.base64)) return;
  }
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
  workspace: false,  // 工作区文件面板 / 沙箱读写 / 代码执行
};

// 回复拆条条数区间（每卡高级配置里选，最少 1 条、最多 7 条）
const SPLIT_RANGE = { min: 1, max: 7 };

const DEFAULTS_KEY = "ocs_cap_defaults";
function capDefaults() {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}"); } catch { return {}; }
}
function saveCapDefaults(d) { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); }

// 工作模式总开关：开启后首页变为「工作台」（选卡当助手 + 聊天 + 工作区文件面板）
// 「工作模式」概念已移除：本地聊天是独立路由 #/chat（从通讯录进入），
// 不再占用首页，也不再有全局开关。ocs_workbench_slug 仍用于记住正在聊的卡。

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
  emoji: '<circle cx="12" cy="12" r="9"/><path d="M8.5 13.5a4.5 4.5 0 0 0 7 0"/><line x1="9" y1="9.5" x2="9.01" y2="9.5"/><line x1="15" y1="9.5" x2="15.01" y2="9.5"/>',
  store: '<path d="M3 9.5 4.5 4h15L21 9.5"/><path d="M4 9.5V20h16V9.5"/><path d="M9 20v-6h6v6"/><path d="M2.5 9.5h19"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
};
function icon(name, size) {
  return `<svg class="ic${size ? " ic-" + size : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

/** 名字过长时省略中间（头尾保留，如「迟萤秋的一个很长很长…很长的名字」） */
function middleEllipsis(str, max = 16) {
  const s = String(str ?? "");
  if (s.length <= max) return s;
  const head = Math.ceil(max / 2) - 1;
  return s.slice(0, head) + "…" + s.slice(-(max - head - 1));
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
    memoryConfig: { auto_rounds: 10 },
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
  // 离开本地聊天页：把聊天区 DOM + 上下文存成快照，回来时秒开（不重新加载聊天记录）。
  // 注意这里**绝不** abort 正在跑的 /api/chat：用户可以在等回复期间去看配置，
  // 请求继续在后台跑，回复到了由 wbDoSend 直接写进快照（见那里的 lcSnap 同步）。
  try {
    if (document.querySelector(".lc-root")) saveLcSnapshot();
    if (wbMirrorTimer) { clearInterval(wbMirrorTimer); wbMirrorTimer = null; }
  } catch { /* 同上 */ }
  document.getElementById("bot-overlay")?.remove();
  document.getElementById("adv-overlay")?.remove();
  try {
    stopSpeak(); // 停掉正在朗读的语音并回收 Blob URL
  } catch { /* 同上 */ }
}

function router() {
  // 路由 key 只取路径段：#/chatinfo?slug=xxx 这类带查询串的地址要剥掉 ? 后面的部分，
  // 否则整串当 key 匹配不到任何路由，会静默回落到首页。
  const hash = (location.hash || "").replace(/^#\/?/, "").split("?")[0] || "home";
  // 分发用户直接粘运营向地址（#/channels 等）进来：改回首页由下一轮 hashchange 渲染，
  // 不在这里直接当首页渲染——否则地址栏还停在 #/channels，看着像没生效
  if (ocIsDevice() && OC_DEVICE_HIDDEN_ROUTES.includes(hash)) {
    location.replace("#/home");
    return;
  }
  const route = routes[hash] || routes.home;
  cleanupBeforeRoute();
  $("#view").innerHTML = route.render();
  closeDrawer();
  $("#view").scrollTop = 0;
  // 本地聊天是独立页面（#/chat，从通讯录进入），整页布局（自己内部滚动）：
  // 容器要去掉内边距与外层滚动，避免双滚动条
  const lcFull = hash === "chat";
  $("#view").classList.toggle("lc-host", lcFull);
  // 本地聊天时整页接管：隐藏 SoulBox 顶栏，由卡头像+名字担任页头（RP-Hub 式）
  document.body.classList.toggle("lc-fullscreen", lcFull);
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

// 重描写专属条目标记：关键词写 <重描写> 的条目只在「重描写」风格下生效（编译器按档位裁剪）
const RICH_ONLY_KEY = "<重描写>";
function isRichOnlyKeys(keys) {
  return (Array.isArray(keys) ? keys : String(keys ?? "").split(/[,，、]/)).some((k) => String(k).trim() === RICH_ONLY_KEY);
}

// 世界书条目模板：选一个类型就自动填好名称/关键词/常驻，并在内容框给出「怎么写」的示例提示
const WB_TEMPLATES = {
  archive: {
    label: "人物档案（基本信息/外貌/经历/关系）",
    name: "人物档案", keys: "", constant: true,
    ph: "写满约 1000 字的静态事实，少写对话：\n[姓名][年龄][身高][体重][生日][身份][居住地]\n外貌：发瞳肤五官身材服饰，以及和外表相关的习惯。\n经历：发生了什么、在她身上留下了什么。\n与 {{user}}：怎么认识、称呼分级、她记得你什么、她怕你做什么。",
  },
  dialogue: {
    label: "对话与性格（情景+台词+缘由）",
    name: "对话与性格", keys: "", constant: true,
    ph: "写满约 2000 字。把性格、说话缘由、情景转变、大量台词写在一起：\n每种说话方式都要解释为什么会这样说，并写触发条件、转折、至少两句台词。\n也可把 keys 改成吃醋/冷落/示弱等，拆成多条。",
  },
  scene: {
    label: "情景对话（按关键词拆条）",
    name: "情景对话", keys: "吃醋, 冷落, 示弱", constant: false,
    ph: "一条只写一个侧面。触发条件 → 为什么会这样反应 → 刚触发的台词 + 持续/被安抚后的台词。\n关键词用来区分不同情景，聊天里出现这些词时更容易对上。",
  },
  rich: {
    label: "动作心理描写（重描写专属）",
    name: "动作心理描写", keys: RICH_ONLY_KEY, constant: false,
    ph: "写满约 1200 字。不要再抄对话台词。\n按情景写：说话时会出现什么动作、什么心理；嘴上说的和心里想的哪里不一致。\n不要写括号，系统会按风格自动加。",
  },
  world: {
    label: "世界观（特殊设定才需要）",
    name: "世界观", keys: "", constant: true,
    ph: "只有异世界/末世/特定作品才需要。现代日常不用填。",
  },
  blank: { label: "空白条目", name: "", keys: "", constant: false, ph: "" },
};

const WB_DEFAULT_PH = "角色设定：外貌、性格、语言风格、背景、喜好、雷区……";

// 旧版卡库世界书行模板已删：与通讯录世界书页共用 cwRowHTML（见文件后部，withActions=false）

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
/**
 * 卡库编辑器的世界书/正则行交互（与通讯录世界书/正则页同一套行模板 cwRowHTML/crRowHTML）。
 * 区别：卡库是整卡保存——行上没有「保存/取消」，改动都暂存在 DOM，点右上「保存」时
 * collectCardForm 统一读取。所以这里只处理：展开编辑、启用/停用 chip、常驻按键高亮。
 * 只在 #cf-book / #cf-regex 容器内生效（通讯录那两个页面有自己的容器级处理，别互相干扰）。
 */
function cardFormEditHandler(e) {
  const container = e.target.closest('#cf-book, #cf-regex');
  if (!container) return;
  const row = e.target.closest('.cw-item');
  if (!row) return;
  // 常驻按键：点击切换高亮（高亮 = 开启，保存时按高亮读取）
  if (e.target.closest('.cw-constant')) {
    e.target.closest('.cw-constant').classList.toggle('on');
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'edit') {
    const d = row.querySelector('.cw-detail');
    if (d) d.hidden = !d.hidden;
  } else if (act === 'state') {
    const chip = e.target.closest('.cw-state');
    chip.classList.toggle('on');
    const on = chip.classList.contains('on');
    chip.textContent = on ? '启用中' : '已停用';
    row.classList.toggle('disabled', !on);
  }
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
    <textarea id="cf-first" class="cf-autogrow" rows="2" placeholder="只写一句话，不要环境描写：把事由全用说话带出来，结尾留话头。如：哥哥你终于回消息了，我便当都热第三遍了，到底还要不要吃？"></textarea>
  </div>
  <div class="cf-section"><h3>世界书</h3>
    <div id="cf-book"></div>
    <div class="wb-add-row">
      <button id="cf-book-add" class="ghost small-btn" type="button">＋ 添加条目</button>
    </div>
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
  // 添加条目一律空白（不再选模板）；添加正则同理
  $("#cf-book-add").addEventListener("click", () => {
    $("#cf-book").insertAdjacentHTML("beforeend", cwRowHTML(blankEntry(), undefined, false));
    const last = $("#cf-book").lastElementChild;
    if (last) { last.querySelector(".cw-detail").hidden = false; last.querySelector(".cw-f-name").focus(); }
    last?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#cf-regex-add")?.addEventListener("click", () => {
    $("#cf-regex")?.insertAdjacentHTML("beforeend", crRowHTML({}, undefined, false));
    const last = $("#cf-regex").lastElementChild;
    if (last) { last.querySelector(".cw-detail").hidden = false; last.querySelector(".cr-f-name").focus(); }
  });
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
  const container = e.target.closest('#cf-book, #cf-regex');
  if (!container) return;
  if (!e.target.closest('[data-act="del"]')) return;
  const row = e.target.closest('.cw-item');
  if (!row) return;
  if (container.id === 'cf-book' && container.querySelectorAll('.cw-item').length <= 1) {
    toast('世界书至少保留一条条目', false);
    return;
  }
  if (!confirm('删除这条' + (container.id === 'cf-book' ? '条目' : '正则') + '？')) return;
  row.remove();
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
  // 新版行模板（与通讯录世界书/正则页共用）：表面只有一行（状态+名称+编辑/删除），点编辑键展开
  $("#cf-book").innerHTML = entries.length
    ? entries.map((en, i) => cwRowHTML(en, i, false)).join("")
    : cwRowHTML({}, undefined, false);
  if (!entries.length) {
    const first = $("#cf-book")?.querySelector(".cw-detail");
    if (first) first.hidden = false; // 空书自动展开那条空白条目
  }
  if ($("#cf-regex")) $("#cf-regex").innerHTML = (st.regex_scripts ?? []).map((sc, i) => crRowHTML(sc, i, false)).join("");
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
    entries: [...$("#cf-book").querySelectorAll(".cw-item")]
      .map((r) => {
        const comment = r.querySelector(".cw-f-name").value.trim();
        const keys = r.querySelector(".cw-f-keys").value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        // 增量覆盖：保住表单没暴露的酒馆字段（secondary_keys / selective / extensions / id / use_regex 等）
        const idx = Number(r.dataset.idx);
        const base = Number.isInteger(idx) && prevEntries[idx] ? prevEntries[idx] : {};
        return {
          ...base,
          name: comment || undefined,
          comment: comment || undefined,
          keys,
          content: r.querySelector(".cw-f-content").value,
          constant: r.querySelector(".cw-constant").classList.contains("on"),
          enabled: r.querySelector(".cw-state").classList.contains("on"),
          insertion_order: numOr(r.querySelector(".cw-f-order"), 100, 0, 9999),
          priority: Number.isFinite(Number(base.priority)) ? Number(base.priority) : 10,
          // 插入位置/概率/深度新版行不再暴露：原样保留已有卡的值，新条目走 schema 默认
          position: base.position || "before_char",
          probability: Number.isFinite(Number(base.probability)) ? Number(base.probability) : 100,
          depth: Number.isFinite(Number(base.depth)) ? Number(base.depth) : 4,
        };
      })
      // 名称/关键词/内容全空才算废弃条目（原来只看 content，会静默吞掉填了一半的条目）
      .filter((e) => e.content.trim() || (e.comment ?? "").trim() || e.keys.length),
  };
  st.regex_scripts = [...$("#cf-regex").querySelectorAll(".cw-item")]
    .map((r) => ({
      scriptName: r.querySelector(".cr-f-name").value.trim(),
      findRegex: r.querySelector(".cr-f-find").value,
      replaceString: r.querySelector(".cr-f-rep").value,
      enabled: r.querySelector(".cw-state").classList.contains("on"),
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

/** 今天的日期（首页副标题用） */
function todayLine() {
  const d = new Date();
  const weeks = ["日", "一", "二", "三", "四", "五", "六"];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${weeks[d.getDay()]}`;
}

function renderHome() {
  return `
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
    const [ann, cards] = await Promise.all([
      cachedGet("/api/announcement", () => refreshHome()).catch(() => ({ text: "" })),
      cachedGet("/api/cards", () => refreshHome()).catch(() => ({ cards: [] })),
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
      d.className = "home-card-item";
      d.innerHTML = `
        <div class="home-card-avatar">${c.avatar ? `<img src="${c.avatar}" alt="">` : `<span>${escapeHtml(c.name.slice(0, 1))}</span>`}</div>
        <div class="home-card-name">${escapeHtml(c.name)}</div>`;
      d.addEventListener("click", () => {
        location.hash = "#/cards";
        setTimeout(() => loadCardIntoEditor(c.slug), 60);
      });
      grid.appendChild(d);
    }
  } catch { /* 忽略 */ }
}

// ============================================================
//  本地聊天页（独立路由 #/chat，从通讯录点进来）
//  微信式：左上角返回箭头回通讯录；页内无侧边栏；配置走右上角三个点
//  模型/世界书跟卡走（模型选择可手动覆盖且按卡记忆）
// ============================================================
let wbSlug = "";
let wbCards = [];
let wbCardObj = null;
let wbChatHistory = [];
let wbPending = null;
let wbLastOpts = null;
let wbDir = "";
let wbMirror = null;        // 跨端会话状态（绑定=联通；null=本地聊天）
let wbMirrorTimer = null;   // 通道消息轮询定时器
let wbRenderedIds = new Set(); // 已渲染的会话条目 id（增量渲染防重复）

// ---------- 时间戳分隔（微信式：相邻消息隔久了才显示时间） ----------
// 基准 = 上一条已渲染"真实消息"的时间（ISO）；占位/错误提示等非时间线气泡不更新它。
// 判定口径参考爱语逆向（相邻消息差 >N 分钟插时间分隔），阈值取微信口径 5 分钟。
const WB_TIME_SEP_GAP_MS = 5 * 60 * 1000;
let wbLastMsgTime = null;

/** 时间分隔条文本（微信口径）：今天 HH:mm / 昨天 HH:mm / 星期X HH:mm / M月d日 HH:mm */
function fmtChatSepTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const startOfDay = (x) => { const z = new Date(x); z.setHours(0, 0, 0, 0); return z.getTime(); };
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff <= 0) return hm;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `星期${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 相邻消息间隔超过阈值 → 返回一条居中时间分隔 div；否则 null（不显示） */
function wbTimeSepDiv(prevIso, curIso) {
  const cur = new Date(curIso);
  if (isNaN(cur.getTime())) return null;
  if (prevIso) {
    const prev = new Date(prevIso);
    if (!isNaN(prev.getTime()) && cur.getTime() - prev.getTime() < WB_TIME_SEP_GAP_MS && cur.getTime() >= prev.getTime()) {
      return null; // 间隔不足且顺序正常 → 不显示
    }
  }
  const div = document.createElement("div");
  div.className = "lc-time-sep";
  div.textContent = fmtChatSepTime(curIso);
  return div;
}

// ---------- 聊天记录懒渲染（微信式：进聊天只画最近一屏，往上翻再补旧的） ----------
// 为什么：几轮聊天就几百条气泡，全量渲染既慢又费内存（表情/生图尤其重）。
// 策略：默认只渲染最近 15 轮；用户上翻、翻到顶部第 3 轮刚露头时就再补 5 轮，以此类推。
const WB_RENDER_ROUNDS = 15; // 首屏渲染最近多少轮
const WB_RENDER_BATCH = 10;  // 上翻触发时一次补多少轮
const WB_PREPEND_THRESHOLD = 6000; // 视口顶离文档顶不足这个高度就一直补（保证一次滚到顶能补完）
let wbAllEntries = [];       // 本次加载的完整会话（含未渲染的旧消息）
let wbRenderedFrom = 0;      // 已渲染区间的起点（wbAllEntries 下标），>0 说明上面还有没画的
let wbPrepending = false;    // 上翻补渲染进行中（防重入）
let wbHistoryLoading = false; // 初始渲染进行中（期间禁止补渲染：每条气泡滚到底都会触发
                              // scroll 事件，早期 scrollTop<700 会误触发，跟初始渲染交叉成半空位置）

/** 轮 = 一条 user 消息开头的问+答。返回「从后往前数第 rounds 轮」的起始下标（不够则 0） */
function wbRoundsStartIndex(entries, rounds) {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === "user") {
      count++;
      if (count >= rounds) return i;
    }
  }
  return 0;
}

/**
 * 渲染一条会话记录到指定容器（logEl 不传 = 当前的 #chat-log）。
 * wbReloadHistory 与上翻补渲染共用，保证两处渲染口径一致。
 */
function wbRenderEntryInto(e, logEl) {
  if (e.surface === "web") {
    // 拆条消息按 parts 逐条渲染（刷新后不再合并成一大块）；老数据无 parts 时按换行兜底拆
    // 最后一个参数 e.t：历史消息用日志时间参与时间戳分隔判定
    if (e.role === "assistant" && Array.isArray(e.parts) && e.parts.length) {
      for (const p of e.parts) {
        if (!String(p ?? "").trim()) continue;
        addChatBubble("bot", p, e.id, logEl, e.t);
      }
    } else if (e.role === "assistant" && String(e.content).includes("\n")) {
      for (const line of String(e.content).split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
        addChatBubble("bot", line, e.id, logEl, e.t);
      }
    } else {
      addChatBubble(e.role === "assistant" ? "bot" : "user", e.content, e.id, logEl, e.t);
    }
  } else if (wbMirror) {
    if (wbRenderedIds.has(e.id)) return;
    wbRenderedIds.add(e.id);
    addChatBubble(e.role === "assistant" ? "bot" : "user", e.content, e.id, logEl, e.t);
  }
}

/**
 * 上翻补渲染的统一入口：只要滚动位置还在顶部阈值区内，就连续补渲染，
 * 直到离开阈值区（scrollTop 被校正变大）或没有更早的了。
 * 为什么不一次只补一批就停：用户猛地拖到顶只触发一两次 scroll 事件，
 * 只补一批会出现「顶部还是不全，得再滚一下才继续出来」——就是"聊天记录不全"的感受。
 */
function wbMaybePrependOlder() {
  if (wbHistoryLoading || wbPrepending) return;
  const log = $("#chat-log");
  if (!log || wbRenderedFrom <= 0) return;
  if (log.scrollTop > WB_PREPEND_THRESHOLD) return; // 离顶部还远，不用补
  void wbPrependOlderBatch().then(() => {
    // 补完一批后仍够得着顶部 → 继续补（每批都会把 scrollTop 校正回原视口）
    wbMaybePrependOlder();
  });
}

/**
 * 上翻补渲染：把更早的 WB_RENDER_BATCH 轮插到聊天区顶部。
 * 关键是保滚动位置：先记 scrollHeight/scrollTop，插入后把 scrollTop 加上新增高度，
 * 用户看到的就是"旧消息长出来了，眼前的消息纹丝没动"。
 */
function wbPrependOlderBatch() {
  if (wbPrepending || wbRenderedFrom <= 0) return Promise.resolve();
  wbPrepending = true;
  try {
    const log = $("#chat-log");
    if (!log) return Promise.resolve();
    const from = wbRoundsStartIndex(wbAllEntries.slice(0, wbRenderedFrom), WB_RENDER_BATCH);
    const older = wbAllEntries.slice(from, wbRenderedFrom);
    if (!older.length) { wbRenderedFrom = 0; return Promise.resolve(); }
    wbRenderedFrom = from;
    const frag = document.createDocumentFragment();
    // 时间戳基准现场保护：批次按"无历史"基线渲染（批次内消息间正常插分隔，
    // 第一条显示自己的时间），渲染完恢复为新消息用的基准
    const savedLast = wbLastMsgTime;
    wbLastMsgTime = null;
    for (const e of older) wbRenderEntryInto(e, frag);
    const batchLast = wbLastMsgTime;
    wbLastMsgTime = savedLast;
    if (!frag.childNodes.length) return Promise.resolve();
    // 边界修正：锚点=现有顶部气泡行（连续补渲染时=上一批的第一行）。
    // 批次必须插在锚点**之前**、上一批之后——绝不能 insertBefore(firstChild)，
    // 否则后补的较新批次会跑到先补的较旧批次上面（实测时间倒挂）。
    const topRow = log.querySelector(".bubble-row");
    // 锚点前面的旧分隔是上一批次的边界残留，摘掉按真实间隔重插
    const prev0 = topRow?.previousElementSibling;
    if (prev0?.classList?.contains("lc-time-sep")) prev0.remove();
    if (batchLast && topRow?.dataset?.t) {
      const boundarySep = wbTimeSepDiv(batchLast, topRow.dataset.t);
      if (boundarySep) frag.appendChild(boundarySep);
    }
    const beforeH = log.scrollHeight;
    const beforeTop = log.scrollTop;
    log.insertBefore(frag, topRow ?? null);
    log.scrollTo({ top: beforeTop + (log.scrollHeight - beforeH), behavior: "instant" });
    upgradeEmojiFallback(log);
  } finally {
    wbPrepending = false;
  }
  return Promise.resolve();
}

// ---------- 聊天页 DOM 快照缓存（切页不重载） ----------
// 问题：router() 每次都重建 #view.innerHTML，initWorkbench 又无条件 wbPickCard，
// 于是「点三个点看设置」「打开侧边栏看配置」回来都要清空聊天区 + 串行 4 个请求 +
// 逐条重画几十上百条气泡 —— 表现就是每次都在重新加载聊天记录。
// 方案：离开聊天页时把聊天区 DOM 与上下文整体存下来，回来只要卡没换就原样贴回。
const lcSnap = {
  slug: "",          // 快照属于哪张卡（换卡则作废）
  logHtml: "",       // #chat-log 的 innerHTML
  scrollTop: 0,
  history: null,     // wbChatHistory 副本
  renderedIds: null, // wbRenderedIds 副本
  cardObj: null,     // 卡对象（省一次 /api/cards/<slug>）
  mirror: null,      // 联通状态（省一次 mirror/status）
  allEntries: [],    // 懒渲染：完整会话记录
  renderedFrom: 0,   // 懒渲染：已渲染区间起点
  lastMsgTime: null, // 时间戳基准（上一条已渲染消息的时间）
  dot: { cls: "", title: "" },
  greeted: false,    // 已领过开场白（回来不再重复领）
};

/** 离开聊天页前：把当前聊天区整体存进快照 */
function saveLcSnapshot() {
  const log = $("#chat-log");
  if (!log || !wbSlug) return;
  lcSnap.slug = wbSlug;
  lcSnap.logHtml = log.innerHTML;
  lcSnap.scrollTop = log.scrollTop;
  lcSnap.history = wbChatHistory.slice();
  lcSnap.renderedIds = new Set(wbRenderedIds);
  lcSnap.cardObj = wbCardObj;
  lcSnap.mirror = wbMirror;
  // 懒渲染状态：快照里画到哪了，回来接着从那里往上补
  lcSnap.allEntries = wbAllEntries;
  lcSnap.renderedFrom = wbRenderedFrom;
  lcSnap.lastMsgTime = wbLastMsgTime; // 时间戳基准跟着快照走
  const dot = $("#lc-dot");
  lcSnap.dot = { cls: dot?.className?.replace("lc-dot", "").trim() ?? "", title: dot?.title ?? "" };
}

/** 快照对这张卡还有效吗（有内容且是同一张卡） */
function lcSnapshotUsable(slug) {
  return !!slug && lcSnap.slug === slug && !!lcSnap.logHtml;
}

/**
 * 卡配置改过（cacheInvalidate 把 lcSnap.cardObj 清成 null）后补取卡对象。
 * 只补这一份数据，聊天 DOM 不动 —— 改个配置不该让聊天记录重新加载。
 */
async function refreshLcCardObj(slug) {
  if (!slug || lcSnap.slug !== slug) return;
  const c = await cachedGet(`/api/cards/${slug}`).catch(() => null);
  if (!c || lcSnap.slug !== slug) return;
  lcSnap.cardObj = c;
  if (wbSlug === slug) wbCardObj = c;
  // 头像/名字可能改了，顺手刷新页头
  const avEl = $("#lc-avatar");
  const nameEl = $("#lc-name");
  if (avEl) {
    avEl.innerHTML = c.identity?.avatar
      ? `<img src="${escapeHtml(c.identity.avatar)}" alt="">`
      : `<span>${escapeHtml(String(c.name ?? "?").slice(0, 1))}</span>`;
  }
  if (nameEl) nameEl.textContent = middleEllipsis(c.name ?? slug, 16);
}

/** 用快照秒开聊天页：贴回 DOM 与上下文，不发任何请求 */
function restoreLcSnapshot() {
  const log = $("#chat-log");
  if (!log) return false;
  wbSlug = lcSnap.slug;
  wbCardObj = lcSnap.cardObj;
  wbChatHistory = (lcSnap.history ?? []).slice();
  wbRenderedIds = new Set(lcSnap.renderedIds ?? []);
  wbMirror = lcSnap.mirror;
  // 懒渲染状态跟着快照走：上翻仍能继续补更早的消息
  wbAllEntries = lcSnap.allEntries ?? [];
  wbRenderedFrom = lcSnap.renderedFrom ?? 0;
  wbLastMsgTime = lcSnap.lastMsgTime ?? null; // 时间戳基准恢复（DOM 里分隔条原样贴回）
  log.innerHTML = lcSnap.logHtml;
  // 头像与名字（快照里有卡对象，不用再请求）
  const c = wbCardObj;
  const avEl = $("#lc-avatar");
  const nameEl = $("#lc-name");
  if (avEl) {
    avEl.innerHTML = c?.identity?.avatar
      ? `<img src="${escapeHtml(c.identity.avatar)}" alt="">`
      : `<span>${escapeHtml(String(c?.name ?? "?").slice(0, 1))}</span>`;
  }
  if (nameEl) nameEl.textContent = middleEllipsis(c?.name ?? wbSlug, 16);
  setLcDot(lcSnap.dot.cls, lcSnap.dot.title);
  // 滚动位置还原（instant：容器 CSS 是 smooth，平滑动画会被后续渲染打断）
  log.scrollTo({ top: lcSnap.scrollTop, behavior: "instant" });
  // 兜底：快照里可能有当年「库没回来按文本兜底」的 [表情:名]，升级成图片
  upgradeEmojiFallback(log);
  // 从搜索页点命中跳回来的：快照秒开不走 wbReloadHistory，这里也要消费定位
  void wbFocusPendingHit();
  // 正在生成中就把占位气泡接回来（切页期间请求没断，见 wbDoSend）
  if (wbAbort && !$("#chat-log .lc-pending-row")) {
    wbThinkingBubble = addChatBubble("bot", "（正在输出… 发新消息可截断重来）", undefined, undefined, null);
    wbThinkingBubble?.classList.add("lc-pending-row");
  }
  // 联通模式：重新挂上轮询（定时器在离开时被 cleanup 清掉了）
  if (wbMirror?.slug === wbSlug && !wbMirrorTimer) {
    wbMirrorTimer = setInterval(() => wbMirrorSync(wbSlug), 3000);
  }
  // 卡对象被配置变更清掉了 → 后台补取一份（不阻塞、不重画聊天）
  if (!wbCardObj) void refreshLcCardObj(wbSlug);
  // 模型商/模型/思考深度的按键标签：秒开路径不走 wbPickCard，必须在这里补上，
  // 否则按键会一直显示「模型商」「模型」占位文字（lcModelState 是空的）。
  // /api/providers 已走缓存，正常是命中缓存、不发请求。
  void loadLcModelDefaults();
  return true;
}

/** 联通状态圆点：on=绿（已联通） err=红（同步异常） 默认=白（本地） */
function setLcDot(cls, title) {
  const dotEl = $("#lc-dot");
  if (dotEl) { dotEl.className = "lc-dot " + cls; dotEl.title = title; }
}

function renderWorkbench() {
  return `
  <div class="lc-root">
    <!-- 顶栏（本页即页头）：返回通讯录 + 头像 + 名字 + 联通圆点 | 撤掉上一轮 / 更多 -->
    <div class="lc-top">
      <button id="lc-back" class="lc-back-btn" title="返回通讯录" aria-label="返回通讯录"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
      <div class="lc-who" id="lc-who">
        <div class="lc-avatar" id="lc-avatar"></div>
        <div class="lc-who-text">
          <div class="lc-name" id="lc-name">选择角色卡</div>
        </div>
        <span class="lc-dot" id="lc-dot" title="联通状态：绿=已联通 红=联通异常 白=本地"></span>
      </div>
      <div class="lc-top-actions">
        <button id="wb-undo-round" class="ghost small-btn" title="撤掉最近一问一答（网页与 QQ/微信 上下文一起摘，破甲被拒时用）">撤掉上一轮</button>
        <!-- 三个点=更多：进这张卡的聊天设置页（记忆/查找/置顶/一键删除都在里面） -->
        <button id="wb-more" class="lc-more-btn" title="更多（聊天设置）" aria-label="更多">⋯</button>
      </div>
    </div>

    <!-- 消息区 -->
    <div id="chat-log" class="lc-log"></div>

    <!-- 底部悬浮输入岛（RP-Hub 单聊式）：上排按键（模型商/模型/思考深度） + 下排输入 -->
    <div class="lc-dock">
      <div class="lc-island">
        <div class="lc-tools-row">
          <div class="lc-pop-wrap">
            <button type="button" class="lc-pill" id="lc-prov-pill" title="模型商"><span id="lc-prov-label">模型商</span><span class="lc-pill-caret">▾</span></button>
            <div class="lc-pop" id="lc-prov-pop" hidden></div>
          </div>
          <div class="lc-pop-wrap">
            <button type="button" class="lc-pill" id="lc-model-pill" title="模型">模型<span class="lc-pill-caret">▾</span></button>
            <div class="lc-pop" id="lc-model-pop" hidden></div>
          </div>
          <span style="flex:1"></span>
          <div class="lc-pop-wrap">
            <button type="button" class="lc-pill" id="lc-think-pill" title="思考深度"><span id="lc-think-label">自动</span><span class="lc-pill-caret">▾</span></button>
            <div class="lc-pop lc-pop-right" id="lc-think-pop" hidden></div>
          </div>
        </div>
        <div class="lc-input-row">
          <button type="button" id="wb-emoji" class="lc-icon-btn" title="表情包">${icon("emoji")}</button>
          <textarea id="wb-input" rows="1" placeholder="回车换行，双击回车发送…"></textarea>
          <button id="wb-send" class="lc-send" title="发送">${icon("send")}</button>
        </div>
      </div>
      <!-- 表情面板（QQ 式）：在输入框「下方」展开，输入框整体上移，这里占住下半屏 -->
      <div class="lc-emoji-panel" id="lc-emoji-panel" hidden>
        <div class="lc-emoji-scroll" id="lc-emoji-scroll"></div>
      </div>
    </div>
  </div>`;
}

async function initWorkbench() {
  // 卡列表走缓存且不阻塞首屏：本地聊天页用不到它（模型固定跟卡片配置），
  // 原来 await 它会让整个聊天页等一个网络往返才开始渲染。
  void cachedGet("/api/cards").then((r) => { wbCards = r.cards ?? []; }).catch(() => {});
  $("#wb-send").addEventListener("click", wbSend);
  // 返回箭头：回通讯录（微信式；聊天页内不提供侧边栏入口）
  $("#lc-back").addEventListener("click", () => { location.hash = "#/chats"; });
  // 单击回车换行、双击回车发送（对齐 RP-Hub；中文输入法组字中不拦截）
  const input = $("#wb-input");
  input.addEventListener("keydown", wbInputEnter);
  input.addEventListener("input", () => wbAutoGrow(input));
  $("#wb-undo-round").addEventListener("click", () => {
    if (!wbSlug) return toast("先选一张卡", false);
    void wbUndoLastRound();
  });
  // 三个点「更多」→ 这张卡的聊天设置页（记忆 / 查找 / 置顶 / 一键删除都在里面，
  // 对齐微信：聊天页右上角进去就是这个会话的设置）
  $("#wb-more").addEventListener("click", () => {
    if (!wbSlug) return toast("先选一张卡", false);
    openChatSettings(wbSlug);
  });
  // 头像/名字不再绑点击：卡片配置统一走右上角三个点 → 聊天设置 → 卡片配置
  // 上排按键：模型商 / 模型 / 思考深度（弹层选择，RP-Hub 式）
  const wbOpts = wbChatOpts();
  lcModelState.provider = wbOpts.provider ?? "";
  lcModelState.model = wbOpts.model ?? "";
  lcModelState.thinking = wbOpts.thinking ?? "auto";
  bindLcPopovers();
  // 表情包按钮：弹出当前卡配置分组的表情，点击插入 [表情:名]
  $("#wb-emoji").addEventListener("click", openWbEmojiPicker);
  // 长按消息进入多选删除（触屏长按 500ms；桌面右键同样生效）
  const log = $("#chat-log");
  let pressTimer = null;
  const startPress = (e) => {
    const row = e.target.closest?.(".bubble-row[data-conv-id]");
    if (!row || wbSelectMode) return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      wbEnterSelectMode();
      wbToggleSelect(row);
    }, 500);
  };
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  log.addEventListener("touchstart", startPress, { passive: true });
  log.addEventListener("touchend", cancelPress);
  log.addEventListener("touchmove", cancelPress);
  log.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".bubble-row[data-conv-id]");
    if (!row || wbSelectMode) return;
    e.preventDefault();
    wbEnterSelectMode();
    wbToggleSelect(row);
  });
  log.addEventListener("click", (e) => {
    if (!wbSelectMode) return;
    const row = e.target.closest(".bubble-row[data-conv-id]");
    if (row) { e.preventDefault(); wbToggleSelect(row); }
  });
  // 上翻补渲染（懒加载）：滚到离顶部约 2-3 轮消息的高度时，把更早的轮次连续补出来
  // （wbMaybePrependOlder 内部会一批接一批补到离开阈值区为止，见其注释）。
  // 初始渲染/上翻补渲染进行中不触发（见 wbHistoryLoading 注释）。
  log.addEventListener("scroll", () => wbMaybePrependOlder(), { passive: true });
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
  if (!last) return;
  // 卡没换 → 用 DOM 快照秒开（0 请求、不重画气泡）；否则才真正加载这张卡
  if (lcSnapshotUsable(last)) {
    restoreLcSnapshot();
    // 通道消息同步交给 3 秒一次的定时器，秒开这一刻不发请求（免得刚进页面又卡一下）。
    // 它本身是增量渲染（wbRenderedIds 去重），漏不了消息，只是最多晚 3 秒。
    return;
  }
  await wbPickCard(last);
}

async function wbPickCard(slug) {
  // 同一张卡且已有快照（例如从通讯录点当前正在聊的卡）→ 秒开，不重载
  if (lcSnapshotUsable(slug) && $("#chat-log")) {
    restoreLcSnapshot();
    if (wbMirror?.slug === slug) void wbMirrorSync(slug);
    return;
  }
  // 换卡：旧快照作废
  if (lcSnap.slug && lcSnap.slug !== slug) {
    lcSnap.slug = "";
    lcSnap.logHtml = "";
    lcSnap.history = null;
  }
  wbSlug = slug;
  wbLastMsgTime = null; // 换卡时间基准重置
  wbCardObj = null;
  wbChatHistory = [];
  wbPending = null;
  // 换卡后表情分组不同 → 面板收起并丢弃已渲染的表情，下次打开按新卡重建
  closeWbEmojiPanel();
  lcEmojiLoaded = false;
  const emojiBox = $("#lc-emoji-scroll");
  if (emojiBox) emojiBox.innerHTML = "";
  wbDir = "";
  bubbleCardAvatarUrl = null; // 换卡后头像缓存失效（旧 Blob 留着给已渲染气泡用，不回收）
  $("#chat-log").innerHTML = "";
  localStorage.setItem("ocs_workbench_slug", slug);
  const nameEl = $("#lc-name");
  const avEl = $("#lc-avatar");
  if (slug) {
    // 卡片与联通状态并行取（原来是串行，公网上每个请求 0.5-1.7s，串起来就是等待感的主要来源）；
    // 卡片走缓存层：卡片内容变化时相关写操作已 cacheInvalidate，不会读到旧数据
    const [cardRes, mirRes] = await Promise.all([
      cachedGet(`/api/cards/${slug}`).catch(() => null),
      api.get(`/api/cards/${encodeURIComponent(slug)}/mirror/status`).catch(() => ({ bound: false })),
    ]);
    wbCardObj = cardRes;
    const c = wbCardObj;
    if (avEl) {
      avEl.innerHTML = c?.identity?.avatar
        ? `<img src="${c.identity.avatar}" alt="">`
        : `<span>${escapeHtml((c?.name ?? "?").slice(0, 1))}</span>`;
    }
    if (nameEl) nameEl.textContent = middleEllipsis(c?.name ?? slug, 16);
    void loadLcModelDefaults(); // 模型默认选中这张卡配置的
    // 跨端会话：绑定（联通）→ 网页聊天 = 通道会话（互传，记录相同）；未绑定 → 本地聊天
    wbMirror = null;
    if (wbMirrorTimer) { clearInterval(wbMirrorTimer); wbMirrorTimer = null; }
    wbRenderedIds = new Set();
    const mir = mirRes;
    if (mir?.bound) {
      wbMirror = { ...mir, slug };
      setLcDot("on", "已联通" + (mir.channel === "qqbot" ? "QQ" : "微信") + "，通道消息同步中");
      // 单向同步：通道消息实时显示到本地，本地聊天不发送到通道（清空只清本地记录）
      wbMirrorTimer = setInterval(() => wbMirrorSync(slug), 3000);
      void wbMirrorSync(slug); // 立即同步一次
    } else {
      setLcDot("", "本地聊天（未联通通道）");
    }
    // 开场白（网页版默认直接放上去）：本地没开场过就领取并显示（联通与否都显示）
    const first = c?.sillytavern_v2?.first_mes?.trim();
    if (first) {
      try {
        const g = await api.send(`/api/cards/${encodeURIComponent(slug)}/greeting/claim`, {
          method: "POST",
          body: JSON.stringify({ userKey: "local" }),
        });
        if (g.greeted && g.text) addChatBubble("bot", g.text);
      } catch { /* 领取失败不阻塞选卡 */ }
    }
    // 恢复历史（网页消息回填 wbChatHistory 并渲染，重进不再丢历史；通道消息只在联通时渲染）
    await wbReloadHistory();
  } else {
    if (nameEl) nameEl.textContent = "选择角色卡";
    setLcDot("", "本地聊天（未联通通道）");
    if (avEl) avEl.innerHTML = "";
  }
  if (FEATURES.workspace) wbLoadFiles();
}

/** 从统一日志重载本地聊天历史（进入选卡 / 删除消息后共用） */
async function wbReloadHistory() {
  if (!wbSlug) return;
  wbHistoryLoading = true;
  try {
    await wbReloadHistoryInner();
  } finally {
    wbHistoryLoading = false;
  }
}

async function wbReloadHistoryInner() {
  // 先等表情库就绪再渲染：否则 [表情:名] 会按文本兜底渲染、之后永不升级（用户反馈「旧消息只显示名字」）
  await ensureEmojiLib();
  wbChatHistory = [];
  wbPending = null;
  wbRenderedIds = new Set();
  wbLastMsgTime = null; // 时间戳基准重置：重画后的第一条消息显示自己的时间
  $("#chat-log").innerHTML = "";
  const conv = await api.get(`/api/cards/${encodeURIComponent(wbSlug)}/conversation`).catch(() => ({ entries: [] }));
  wbAllEntries = conv.entries ?? [];
  // 上下文（发给模型的 history）始终要完整的；但 DOM 只画最近 WB_RENDER_ROUNDS 轮，
  // 更早的消息等用户上翻时由 wbPrependOlderBatch 补（懒渲染，见顶部说明）
  for (const e of wbAllEntries) {
    if (e.surface === "web") wbChatHistory.push({ role: e.role, content: e.content });
    // 生图元数据（url→提示词）：历史渲染建记录时带上提示词，URL 失效后卡片能显示出来
    if (Array.isArray(e.images)) for (const im of e.images) if (im?.url) ocUrlPrompt.set(im.url, im.prompt || "");
  }
  wbRenderedFrom = wbRoundsStartIndex(wbAllEntries, WB_RENDER_ROUNDS);
  const tail = wbAllEntries.slice(wbRenderedFrom);
  for (const e of tail) wbRenderEntryInto(e, null);
  // 从「聊天设置 → 查找聊天记录」点某条命中过来的：滚到那条并高亮（含快照秒开路径）
  await wbFocusPendingHit();
  // 兜底：把历史上按文本兜底的 [表情:名] 升级成图片（老快照/库晚到的情况）
  upgradeEmojiFallback($("#chat-log"));
  // 渲染完滚到底。表情/生图是异步加载的，加载完内容会撑高把视口顶离底部
  // （表情越大越明显），所以 600ms 后校正一次——前提是用户这会儿没自己动手滚。
  const logEl = $("#chat-log");
  if (logEl) {
    logEl.scrollTo({ top: logEl.scrollHeight, behavior: "instant" });
    const expect = Math.round(logEl.scrollTop);
    setTimeout(() => {
      if (logEl.isConnected && Math.round(logEl.scrollTop) === expect) {
        logEl.scrollTo({ top: logEl.scrollHeight, behavior: "instant" });
      }
    }, 600);
  }
}

/**
 * 消费 pendingChatFocusId（从聊天记录搜索页点某条命中过来）：滚到那条并高亮。
 * 目标可能在还没渲染的旧轮次里 → 边往上补渲染边找，直到找到或没有更早的了。
 * 快照秒开路径（restoreLcSnapshot）不经过 wbReloadHistory，所以这里独立成函数两处共用。
 */
async function wbFocusPendingHit() {
  if (!pendingChatFocusId) return;
  const target = pendingChatFocusId;
  pendingChatFocusId = "";
  // 必须显式 behavior:"instant"：.lc-log 设了 CSS scroll-behavior:smooth，
  // 而 scrollTop 赋值 / scrollIntoView / scrollTo({behavior:"auto"}) 都会沿用这个 CSS 值
  // 变成平滑动画（"auto" 按规范就是"用元素的 scroll-behavior"，不是"瞬时"），
  // 动画又被随后的图片加载与渲染打断 → 实测 scrollTop 同步读回一直是 0。
  const scrollToRow = (log, row) => {
    const top = Math.max(0, row.offsetTop - log.clientHeight / 2 + row.offsetHeight / 2);
    log.scrollTo({ top, behavior: "instant" });
  };
  const findRow = () => document.querySelector(`#chat-log .bubble-row[data-conv-id="${CSS.escape(target)}"]`);
  // 先补渲染直到目标出现（最多把整份记录补完）
  let guard = 0;
  while (!findRow() && wbRenderedFrom > 0 && guard++ < 200) {
    await wbPrependOlderBatch();
  }
  const row = findRow();
  const log = $("#chat-log");
  if (row && log) {
    scrollToRow(log, row);
    row.classList.add("hit-flash");
    setTimeout(() => row.classList.remove("hit-flash"), 4000);
    // 图片加载完布局高度会变，再校正一次位置（不重复加高亮类）
    setTimeout(() => scrollToRow(log, row), 400);
  }
}

// ---------- 长按多选删除（消息删除会联动记忆修复，规则见后端 /conversation/delete） ----------
let wbSelectMode = false;
const wbSelectedIds = new Set();

function wbEnterSelectMode() {
  wbSelectMode = true;
  wbSelectedIds.clear();
  $("#chat-log")?.classList.add("selecting");
  if (!$("#wb-select-bar")) {
    const bar = document.createElement("div");
    bar.id = "wb-select-bar";
    bar.innerHTML = `<span id="wb-select-count">已选 0 条</span>
      <button class="danger small-btn" id="wb-select-del">删除</button>
      <button class="ghost small-btn" id="wb-select-cancel">取消</button>`;
    document.body.appendChild(bar);
    $("#wb-select-del").addEventListener("click", wbDeleteSelected);
    $("#wb-select-cancel").addEventListener("click", wbExitSelectMode);
  }
}

function wbExitSelectMode() {
  wbSelectMode = false;
  wbSelectedIds.clear();
  $("#chat-log")?.classList.remove("selecting");
  document.querySelectorAll(".bubble-row.sel").forEach((r) => r.classList.remove("sel"));
  $("#wb-select-bar")?.remove();
}

function wbToggleSelect(row) {
  const id = row.dataset.convId;
  if (row.classList.contains("sel")) { row.classList.remove("sel"); wbSelectedIds.delete(id); }
  else { row.classList.add("sel"); wbSelectedIds.add(id); }
  const c = $("#wb-select-count");
  if (c) c.textContent = `已选 ${wbSelectedIds.size} 条`;
}

/**
 * 多选删除 = 「从最早的选中项开始，把它和它之后的全部删掉」。
 * 为什么必须删到底：通道（QQ/微信）的上下文是一条单链，只能从尾部截断——
 * 删中间会让链断开。所以选中中间某条时，一律连带它后面的所有消息一起清，
 * 这样网页与通道两边的上下文才是一致的。
 */
async function wbDeleteSelected() {
  if (!wbSelectedIds.size) return toast("先选几条消息", false);
  // 按页面顺序找出最早的选中项，算出「它及之后」的所有消息
  const rows = [...document.querySelectorAll("#chat-log .bubble-row[data-conv-id]")];
  const firstIdx = rows.findIndex((r) => wbSelectedIds.has(r.dataset.convId));
  if (firstIdx < 0) return toast("选中的消息已不在列表里，请重试", false);
  const tailRows = rows.slice(firstIdx);
  const ids = tailRows.map((r) => r.dataset.convId).filter(Boolean);
  const extra = ids.length - wbSelectedIds.size;
  const ok = await wbConfirm({
    title: `删除这 ${ids.length} 条消息`,
    lead: extra > 0
      ? `你选了 ${wbSelectedIds.size} 条，位于它们之后的 ${extra} 条也会一起删除。`
      : `将删除选中的 ${ids.length} 条消息。`,
    points: [
      "网页这边的聊天记录会被删掉",
      "QQ / 微信 那边的对话上下文同步截断（下次回复不再带这些内容）",
      "QQ / 微信 App 里已经发出的消息不会被撤回，只是机器人不再记得",
      "删除量较大时，最新一条记忆会一并解散、之后自动重算",
    ],
    note: "此操作不可恢复。",
    okText: `删除 ${ids.length} 条`,
  });
  if (!ok) return;
  try {
    const r = await api.send(`/api/cards/${encodeURIComponent(wbSlug)}/conversation/delete`, {
      method: "POST",
      body: JSON.stringify({ ids, trimChannel: true }),
    });
    wbExitSelectMode();
    // 局部移除（不整页重载）：后端回 removedIds，只摘这些气泡，其余不动
    await wbRemoveRowsByIds(r.removedIds ?? ids);
    const parts = [`✓ 已删除 ${r.removed ?? ids.length} 条`];
    if (r.channelTrimmed) parts.push(`通道上下文截断 ${r.channelTrimmed} 轮`);
    if (r.channelNote) parts.push(r.channelNote);
    if (r.memGone) parts.push(`相关记忆删除 ${r.memGone} 条`);
    if (r.dissolved) parts.push("最新记忆已解散");
    toast(parts.join("，"));
  } catch (e) { toast("删除失败：" + e.message, false); }
}

/**
 * 局部移除已删消息的气泡（不重载整页历史）。
 * 为什么不用 wbReloadHistory：那会清空 #chat-log 再逐条重画，视觉上是「记录全消失又冒出来」；
 * 这里只摘掉被删的行，其余气泡的 DOM 一动不动，观感与 QQ 撤回一致（下方内容自然上移）。
 * 一个 convId 可能对应多个气泡（拆条回复每条一个气泡都挂同一个 id），所以按 id 全量匹配。
 * 兜底：后端没给 removedIds（老版本）时才回退整页重载。
 */
async function wbRemoveRowsByIds(removedIds) {
  const ids = (Array.isArray(removedIds) ? removedIds : []).map(String).filter(Boolean);
  if (!ids.length) { await wbReloadHistory(); return; }
  const idSet = new Set(ids);
  const log = $("#chat-log");
  if (!log) return;
  const rows = [...log.querySelectorAll(".bubble-row[data-conv-id]")].filter((r) => idSet.has(r.dataset.convId));
  // 服务端确认删了、DOM 里却一条都没匹配到（快照/时序异常）→ 整页重载兜底，不留幽灵气泡
  if (!rows.length) { await wbReloadHistory(); return; }
  // 上下文条数按「不同 convId 个数」算，不能按气泡数：一条拆条回复是多个气泡但只占一条历史
  const goneIds = new Set(rows.map((r) => r.dataset.convId));
  rows.forEach((r) => {
    // 审批按钮行（.approve-row）是气泡的兄弟节点，一并清掉避免留下孤立按钮
    const sib = r.nextElementSibling;
    if (sib?.classList?.contains("approve-row")) sib.remove();
    r.remove();
  });
  for (const id of idSet) wbRenderedIds.delete(id);
  // 删掉的轮次同时从本地上下文尾部摘掉（本地删除一律是「从某条删到底」，所以截尾准确）
  if (goneIds.size) wbChatHistory = wbChatHistory.slice(0, Math.max(0, wbChatHistory.length - goneIds.size));
  // 懒渲染的完整记录同步剔除（否则快照/上翻补渲染还会把已删的消息带回来）
  if (wbAllEntries.length) {
    wbAllEntries = wbAllEntries.filter((e) => !idSet.has(e.id));
    if (wbRenderedFrom > wbAllEntries.length) wbRenderedFrom = wbAllEntries.length;
  }
}

/** 撤掉上一轮（破甲被拒时最常用）：一问一答从网页与通道两边一起摘掉 */
async function wbUndoLastRound() {
  // 发送有 2 秒防抖：队列里还没发出的消息不在这轮日志里，撤销时先取消它们
  // （不然服务端删的是上一轮、排队的气泡却留下来 = 用户看到的"撤了没变化"）
  if (wbSendTimer) {
    clearTimeout(wbSendTimer);
    wbSendTimer = null;
    const queued = wbSendQueue.splice(0);
    if (queued.length) {
      wbPendingUserRows.splice(0).forEach((row) => row?.remove());
      wbChatHistory.splice(-queued.length);
    }
  }
  // 生成中还点撤销：先截断当前生成（同"发新消息可截断"逻辑——占位移除、本轮气泡摘掉、
  // 上下文回滚），再撤上一完整轮。否则刚发的那条还挂在屏幕上，看起来就是"撤了没变化"。
  if (wbAbort) {
    try { wbAbort.abort(); } catch { /* 已结束 */ }
    wbAbort = null;
    if (wbThinkingBubble) { wbThinkingBubble.closest(".bubble-row")?.remove(); wbThinkingBubble = null; }
    wbPendingUserRows.splice(0).forEach((row) => row?.remove());
    wbChatHistory.pop(); // 本轮只有用户消息入了上下文（回复还没返回）
  }
  const ok = await wbConfirm({
    title: "撤掉上一轮对话",
    lead: "把最近的一问一答从上下文里摘掉，常用于回复被模型拒绝、不想让它影响后续。",
    points: [
      "网页记录里的这一轮会删掉",
      "QQ / 微信 的对话上下文同步截断这一轮",
      "QQ / 微信 App 里已发出的消息不会被撤回",
    ],
    note: "此操作不可恢复。",
    okText: "撤掉这一轮",
  });
  if (!ok) return;
  try {
    const r = await api.send(`/api/cards/${encodeURIComponent(wbSlug)}/conversation/undo`, {
      method: "POST",
      body: JSON.stringify({ rounds: 1 }),
    });
    // 局部移除这一轮的气泡（不整页重载，观感同 QQ 撤回：下面的内容直接上移）
    await wbRemoveRowsByIds(r.removedIds);
    const parts = [`✓ 已撤掉 ${r.rounds || 1} 轮`];
    if (r.channelTrimmed) parts.push("通道上下文已同步");
    if (r.channelNote) parts.push(r.channelNote);
    if (r.memGone) parts.push(`相关记忆删除 ${r.memGone} 条`);
    if (r.dissolved) parts.push("最新记忆已解散");
    toast(parts.join("，"));
  } catch (e) { toast("撤销失败：" + e.message, false); }
}

// 绑定（联通）模式：定期把通道新消息同步进网页（互传）；解绑时自动切回本地聊天
async function wbMirrorSync(slug) {
  if (!wbMirror || wbMirror.slug !== slug) return;
  try {
    await api.send(`/api/cards/${encodeURIComponent(slug)}/mirror/sync`, { method: "POST", body: "{}" });
    const st = await api.get(`/api/cards/${encodeURIComponent(slug)}/mirror/status`).catch(() => ({ bound: false }));
    if (!st.bound) {
      if (wbMirrorTimer) { clearInterval(wbMirrorTimer); wbMirrorTimer = null; }
      wbMirror = null;
      setLcDot("", "本地聊天（未联通通道）");
      toast("已解除绑定，聊天切回本地模式");
      return;
    }
    setLcDot("on", "已联通，通道消息同步中");
    const conv = await api.get(`/api/cards/${encodeURIComponent(slug)}/conversation`).catch(() => ({ entries: [] }));
    for (const e of conv.entries ?? []) {
      if (e.surface === "web") continue; // 本地消息走 wbChatHistory，不重复渲染
      if (wbRenderedIds.has(e.id)) continue;
      wbRenderedIds.add(e.id);
      addChatBubble(e.role === "assistant" ? "bot" : "user", e.content, undefined, undefined, e.t);
    }
  } catch {
    // 单次同步失败：圆点变红提示联通异常，下轮重试
    if (wbMirror) setLcDot("err", "联通异常（同步失败，自动重试中）");
  }
}

/** 本次聊天的模型覆盖："提供商::模型"；没选则用卡片自己的模型 */
function lcModelOverride() {
  return lcModelState.provider && lcModelState.model ? `${lcModelState.provider}::${lcModelState.model}` : "";
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
    el.value = el.value.replace(/\r?\n+$/, "").replace(/[ \t]+$/, ""); // 去掉第一次回车留下的空行
    if (el.value.trim()) wbSend();
    return;
  }
  lcEnterPending = true;
  if (lcEnterTimer) clearTimeout(lcEnterTimer);
  lcEnterTimer = setTimeout(() => { lcEnterPending = false; lcEnterTimer = null; }, 420);
  setTimeout(() => wbAutoGrow(), 0);
}

// 工作台聊天选项（模型商/模型/思考深度），记在本地
const WB_OPTS_KEY = "ocs_wb_chat_opts";
const LC_THINKING = [
  ["off", "不思考"], ["auto", "自动"], ["low", "浅"], ["medium", "中"], ["high", "深"], ["extreme", "极深"],
];
/** 本地聊天选择状态：模型商 / 模型 / 思考深度 */
let lcModelState = { provider: "", model: "", thinking: "auto" };

function wbChatOpts() {
  try { return JSON.parse(localStorage.getItem(WB_OPTS_KEY) || "{}"); } catch { return {}; }
}
function saveWbChatOpts() {
  localStorage.setItem(WB_OPTS_KEY, JSON.stringify({
    provider: lcModelState.provider,
    model: lcModelState.model,
    thinking: lcModelState.thinking,
  }));
}

/** 用当前状态刷新三个按键的文字 */
function refreshLcPills() {
  const prov = $("#lc-prov-label"), think = $("#lc-think-label");
  if (prov) prov.textContent = lcModelState.provider || "模型商";
  if (think) think.textContent = LC_THINKING.find((t) => t[0] === lcModelState.thinking)?.[1] ?? "自动";
}

/** 上排三个按键的弹层（RP-Hub 式：模型商列表 / 模型列表 / 思考深度竖排） */
function bindLcPopovers() {
  let providers = [];
  const closeAll = () => { $("#lc-prov-pop").hidden = true; $("#lc-model-pop").hidden = true; $("#lc-think-pop").hidden = true; };
  const toggle = async (popId, fill) => {
    const pop = $(popId);
    const wasHidden = pop.hidden;
    closeAll();
    if (wasHidden) { await fill(); pop.hidden = false; }
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".lc-pop-wrap")) closeAll();
  });
  const item = (label, active) =>
    `<button type="button" class="lc-pop-item${active ? " on" : ""}">${escapeHtml(label)}${active ? '<span class="lc-pop-check">✓</span>' : ""}</button>`;

  // 模型商：全部已启用的提供商
  $("#lc-prov-pill").addEventListener("click", () => toggle("#lc-prov-pop", async () => {
    if (!providers.length) {
      try {
        const r = await cachedGet("/api/providers");
        providers = (r.chat ?? []).filter((p) => p.enabled !== false);
      } catch { providers = []; }
    }
    $("#lc-prov-pop").innerHTML = providers.length
      ? providers.map((p) => item(p.name, p.name === lcModelState.provider).replace(
          'class="lc-pop-item', `data-prov="${escapeHtml(p.name)}" class="lc-pop-item`
        )).join("")
      : '<div class="lc-pop-empty">没有启用的模型商</div>';
    $("#lc-prov-pop").querySelectorAll("[data-prov]").forEach((b) =>
      b.addEventListener("click", () => {
        lcModelState.provider = b.dataset.prov;
        // 换模型商后模型重置为该商的第一个
        const p = providers.find((x) => x.name === lcModelState.provider);
        lcModelState.model = p?.models?.[0] ?? "";
        refreshLcPills();
        saveWbChatOpts();
        saveLcModelPick(wbSlug, lcModelState.provider, lcModelState.model); // 手动选择按卡记住
        closeAll();
      })
    );
  }));

  // 模型：当前模型商下的模型（按键只写「模型」，点开看得见选了啥）
  $("#lc-model-pill").addEventListener("click", () => toggle("#lc-model-pop", async () => {
    if (!providers.length) {
      try {
        const r = await api.get("/api/providers");
        providers = (r.chat ?? []).filter((p) => p.enabled !== false);
      } catch { providers = []; }
    }
    const p = providers.find((x) => x.name === lcModelState.provider);
    const models = p?.models ?? [];
    $("#lc-model-pop").innerHTML = models.length
      ? models.map((m) => item(m, m === lcModelState.model).replace(
          'class="lc-pop-item', `data-model="${escapeHtml(m)}" class="lc-pop-item`
        )).join("")
      : '<div class="lc-pop-empty">先在左边选一个模型商</div>';
    $("#lc-model-pop").querySelectorAll("[data-model]").forEach((b) =>
      b.addEventListener("click", () => {
        lcModelState.model = b.dataset.model;
        refreshLcPills();
        saveWbChatOpts();
        saveLcModelPick(wbSlug, lcModelState.provider, lcModelState.model); // 手动选择按卡记住
        closeAll();
      })
    );
  }));

  // 思考深度：竖排选择
  $("#lc-think-pill").addEventListener("click", () => toggle("#lc-think-pop", async () => {
    $("#lc-think-pop").innerHTML = LC_THINKING.map(([v, label]) =>
      item(label, v === lcModelState.thinking).replace(
        'class="lc-pop-item', `data-think="${v}" class="lc-pop-item`
      )).join("");
    $("#lc-think-pop").querySelectorAll("[data-think]").forEach((b) =>
      b.addEventListener("click", () => {
        lcModelState.thinking = b.dataset.think;
        refreshLcPills();
        saveWbChatOpts();
        closeAll();
      })
    );
  }));
  refreshLcPills();
}

/** 本地聊天的模型选择（与卡片高级配置解绑）：手动选过按卡记住，没选过跟随卡片配置 */
/**
 * 本地聊天的模型选择（与卡片高级配置解绑）：
 * - 用户在按键弹层里手动选过 → 记在 localStorage（按卡分），刷新/切页/重开都保持；
 * - 没选过 → 跟随卡片高级配置的模型（改卡仍会自动跟随，符合预期）。
 * 原来 loadLcModelDefaults 无条件用卡片配置覆盖 lcModelState，导致「网页一刷新、
 * 甚至只是切个页面，模型就变回高级配置里的」——就是用户反馈的问题。
 */
const LC_MODEL_PICK_KEY = "ocs_lc_model_pick";
function loadLcModelPicks() {
  try { return JSON.parse(localStorage.getItem(LC_MODEL_PICK_KEY) || "{}"); } catch { return {}; }
}
function saveLcModelPick(slug, provider, model) {
  if (!slug || !provider) return;
  const picks = loadLcModelPicks();
  picks[slug] = { provider, model: model ?? "" };
  localStorage.setItem(LC_MODEL_PICK_KEY, JSON.stringify(picks));
}

async function loadLcModelDefaults() {
  let provs = [];
  try {
    // 走缓存：提供商列表极少变，写操作处已 cacheInvalidate("/api/providers")
    const r = await cachedGet("/api/providers");
    provs = (r.chat ?? []).filter((p) => p.enabled !== false);
  } catch { provs = []; }
  // 手动选择优先；否则跟随这张卡高级配置的模型
  const pick = loadLcModelPicks()[wbSlug];
  const cm = pick ?? wbCardObj?.model;
  if (cm?.provider && provs.some((p) => p.name === cm.provider)) {
    lcModelState.provider = cm.provider;
    const p = provs.find((x) => x.name === cm.provider);
    lcModelState.model = (p?.models ?? []).includes(cm.model) ? cm.model : (p?.models?.[0] ?? "");
  } else if (provs.length) {
    lcModelState.provider = provs[0].name;
    lcModelState.model = provs[0].models?.[0] ?? "";
  }
  refreshLcPills();
}

/**
 * 表情面板（QQ 式）：不再弹居中弹窗，而是在**输入框下方**展开一块面板——
 * 输入岛整体上移、下方腾出的空间就是表情区，可上下滑动看更多。
 * 点一个表情 = 直接把 [表情:名] 发出去（对齐 QQ：点了就发，不用再按发送）。
 * 手机每行 4 个（CSS grid 固定 4 列），格子下方显示表情名字。
 */
let lcEmojiLoaded = false;

async function openWbEmojiPicker() {
  const panel = $("#lc-emoji-panel");
  if (!panel) return;
  // 再点一次收起（QQ 式开关）
  if (!panel.hidden) { closeWbEmojiPanel(); return; }
  const groups = wbCardObj?.emojiGroups ?? [];
  if (!groups.length) return toast("这张卡还没配表情包分组（卡片高级配置里选）", false);
  const box = $("#lc-emoji-scroll");
  if (!lcEmojiLoaded) {
    box.innerHTML = '<div class="lc-emoji-empty">加载中…</div>';
    panel.hidden = false;
    $("#wb-emoji")?.classList.add("on");
    let lib = [];
    try {
      const r = await cachedGet("/api/emojis");
      lib = r.emojis ?? [];
    } catch {
      box.innerHTML = '<div class="lc-emoji-empty">表情库读取失败</div>';
      return;
    }
    const pool = lib.filter((e) => groups.includes(e.group));
    if (!pool.length) {
      box.innerHTML = '<div class="lc-emoji-empty">配置的表情分组里还没有表情</div>';
      return;
    }
    box.innerHTML = pool
      .map(
        (e) => `<button type="button" class="lc-emoji-item" data-name="${escapeHtml(e.name)}" title="${escapeHtml(e.explanation || e.name)}">
        <img src="${escapeHtml(e.url)}" alt="${escapeHtml(e.name)}" loading="lazy">
        <span class="lc-emoji-label">${escapeHtml(e.name)}</span>
      </button>`
      )
      .join("");
    lcEmojiLoaded = true;
    // 点一个 = 直接发送这个表情
    box.addEventListener("click", (ev) => {
      const el = ev.target.closest(".lc-emoji-item");
      if (!el) return;
      sendEmojiFromPanel(el.dataset.name);
    });
  } else {
    panel.hidden = false;
    $("#wb-emoji")?.classList.add("on");
  }
  // 展开后把消息区滚到底（输入岛上移，别让最后一条被挡住）
  const log = $("#chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function closeWbEmojiPanel() {
  const panel = $("#lc-emoji-panel");
  if (panel) panel.hidden = true;
  $("#wb-emoji")?.classList.remove("on");
}

/** 面板里点表情 → 直接发送（输入框已有文字时，表情跟在文字后面一起发） */
function sendEmojiFromPanel(name) {
  if (!name) return;
  const input = $("#wb-input");
  if (!input) return;
  const tag = `[表情:${name}]`;
  input.value = input.value.trim() ? `${input.value.trim()}${tag}` : tag;
  closeWbEmojiPanel();
  void wbSend();
}


// 发送防抖与截断状态：2 秒内用户连续发消息合并成一次请求（减少 API 浪费、避免强行截断）；
// 输出未完成时用户发新消息 → 截断当前生成，结合新消息重新输出。
let wbSendTimer = null;
let wbSendQueue = [];
let wbAbort = null;          // 当前 /api/chat 请求的 AbortController（截断用）
let wbThinkingBubble = null; // "正在输出"占位气泡
let wbPendingUserRows = [];  // 本轮已渲染、还没拿到统一日志 id 的用户气泡

async function wbSend() {
  const input = $("#wb-input");
  const message = input.value.trim();
  if (!message) return;
  if (!wbSlug) { addChatBubble("bot", "请先在顶部选一张卡片当助手。", undefined, undefined, null); return; }
  wbPendingUserRows.push(addChatBubble("user", message));
  input.value = "";
  wbAutoGrow(input); // 清空后收回高度
  wbChatHistory.push({ role: "user", content: message });

  // 上一段输出还没完就发了新消息 → 截断：中止请求、移除占位、丢弃未完成回复
  if (wbAbort) {
    wbAbort.abort();
    wbAbort = null;
    if (wbThinkingBubble) { wbThinkingBubble.closest(".bubble-row")?.remove(); wbThinkingBubble = null; }
    addChatBubble("bot", "（已截断上一条输出，将结合你的新消息重新生成）", undefined, undefined, null);
  }

  // 防抖合并：入队后停顿 2 秒无新消息才真正请求
  wbSendQueue.push(message);
  if (wbSendTimer) clearTimeout(wbSendTimer);
  wbSendTimer = setTimeout(() => {
    wbSendTimer = null;
    const merged = wbSendQueue.splice(0);
    if (merged.length) void wbDoSend(merged);
  }, 2000);
}

async function wbDoSend(msgs) {
  const btn = $("#wb-send");
  if (btn) btn.disabled = true;
  const sendSlug = wbSlug; // 记住这轮是哪张卡（用户可能中途去别处，回来要对得上）
  // 能力跟随这张卡的「高级配置」；联网搜索由输入框旁的按钮临时叠加
  const cardTools = Array.isArray(wbCardObj?.tools?.enabled) ? [...wbCardObj.tools.enabled] : [];
  // 联网搜索等能力跟随卡片高级配置（输入岛不再放开关）
  const tools = FEATURES.workspace ? cardTools : cardTools.filter((t) => !WORKSPACE_TOOL_IDS.includes(t));
  wbLastOpts = {
    tools,
    thinking: lcModelState.thinking || wbCardObj?.chat?.thinking || "auto",
    model: lcModelOverride(),
  };
  const ctrl = new AbortController();
  wbAbort = ctrl;
  wbThinkingBubble = addChatBubble("bot", "（正在输出… 发新消息可截断重来）", undefined, undefined, null);
  // 打标记：切页存快照时要能认出这条占位并在回复到达时替换掉它
  wbThinkingBubble?.classList.add("lc-pending-row");
  try {
    const r = await api.send("/api/chat", {
      method: "POST",
      signal: ctrl.signal,
      body: JSON.stringify({ slug: wbSlug, message: msgs.join("\n"), history: wbChatHistory.slice(0, -msgs.length), userKey: "local", ...wbLastOpts }),
    });
    if (ctrl.signal.aborted) return;
    // 用户可能在等回复期间去看配置了 → 聊天页 DOM 不在，回复要落到快照里而不是丢掉
    if (!$("#chat-log")) { stashReplyToSnapshot(sendSlug, r); return; }
    if (wbThinkingBubble) { wbThinkingBubble.closest(".bubble-row")?.remove(); wbThinkingBubble = null; }
    // 先挂 id 再播动画（撤掉上一轮在气泡逐条冒出的几秒内也可能被点）：
    // 合并发送的多条用户消息共用一条日志 → 都挂 ids[0]；bot 气泡由 addBotReplyHumanLike 逐条挂 ids[1]
    const ids = Array.isArray(r.convIds) ? r.convIds : [];
    // 生图记录入本地媒体库（NAI=url 记录；OpenAI=顺手把字节拉进 IndexedDB）
    void ocSaveImageMeta(r, wbSlug);
    const rows = wbPendingUserRows.splice(0);
    if (ids[0]) rows.forEach((row) => { if (row) row.dataset.convId = ids[0]; });
    await wbFinishTurn(r, ids[1]);
    if (ids[1]) {
      // 动画结束后兜底：仍有没挂 id 的 bot 气泡（如审批流程产生的）统一补挂
      document.querySelectorAll("#chat-log .bubble-row.bot:not([data-conv-id])").forEach((row) => {
        row.dataset.convId = ids[1];
      });
    }
  } catch (e) {
    if (ctrl.signal.aborted) return; // 截断不算错误
    wbChatHistory.pop();
    if (!$("#chat-log")) {
      // 同上：人不在聊天页，错误也记进快照，回来能看到
      stashReplyToSnapshot(sendSlug, { type: "error", message: e.message });
      return;
    }
    if (wbThinkingBubble) { wbThinkingBubble.closest(".bubble-row")?.remove(); wbThinkingBubble = null; }
    addChatBubble("bot", "⚠ " + e.message, undefined, undefined, null);
  } finally {
    if (wbAbort === ctrl) wbAbort = null;
    const b = $("#wb-send");
    if (b) b.disabled = false;
  }
}

/**
 * 回复到达时用户已经离开聊天页 → 把这轮结果直接写进 DOM 快照，
 * 这样他回到聊天页就能看到回复（既不打断生成，也不用重新拉历史）。
 * 做法：用一个离屏容器复用同一套气泡渲染，再把 HTML 追加到快照。
 */
function stashReplyToSnapshot(slug, r) {
  if (lcSnap.slug !== slug) return; // 期间换了卡：这轮结果留在服务端日志里，下次进那张卡自然会读到
  if (r?.type === "reply") void ocSaveImageMeta(r, slug); // 不在聊天页生成的图也要入库
  const text = r?.type === "reply" ? String(r.reply ?? "") : `⚠ ${r?.message ?? "生成失败"}`;
  const convId = Array.isArray(r?.convIds) ? r.convIds[1] : "";
  // 离屏渲染：临时挂一个 id=chat-log 的容器，让 addChatBubble 照常工作
  const holder = document.createElement("div");
  holder.id = "chat-log";
  holder.style.display = "none";
  document.body.appendChild(holder);
  try {
    if (r?.type === "reply") {
      // 快照里不做逐条延时动画（人不在场），按 parts 一次性渲染；时间戳=回复到达的现在
      const parts = Array.isArray(r.parts) && r.parts.length ? r.parts : [text];
      for (const p of parts) {
        const s = String(p ?? "").trim();
        if (s) addChatBubble("bot", s, convId || undefined, holder, new Date().toISOString()); // 正则在 addChatBubble 里统一套
      }
    } else {
      addChatBubble("bot", text, undefined, holder, null);
    }
    // 去掉快照里的「正在输出」占位，再把新气泡接上去。
    // 用 DOM 解析而不是正则替换：气泡是嵌套 div，正则匹配 </div></div> 很容易咬错边界。
    const tmp = document.createElement("div");
    tmp.innerHTML = lcSnap.logHtml;
    tmp.querySelectorAll(".lc-pending-row").forEach((el) => el.remove());
    lcSnap.logHtml = tmp.innerHTML + holder.innerHTML;
    if (r?.type === "reply") {
      if (!Array.isArray(lcSnap.history)) lcSnap.history = [];
      lcSnap.history.push({ role: "assistant", content: text });
    }
    lcSnap.scrollTop = 10_000_000; // 回来时滚到底（会被 clamp 到最大值）
    toast("✓ 回复已生成，回聊天页查看");
  } finally {
    holder.remove();
  }
}

async function wbFinishTurn(r, assistantConvId) {
  if (r.type === "reply") {
    // 走真人化渲染：后端拆好的 parts（段落/句号/逗号四级拆条）逐条冒出；没 parts 时退回按空行拆
    // assistantConvId：本轮日志 id，动画中每条气泡创建时立即挂上（撤掉上一轮随时可能被点）
    await addBotReplyHumanLike(r.reply, r.parts, assistantConvId);
    wbChatHistory.push({ role: "assistant", content: r.reply });
    // 不自动朗读：只有点气泡右上角的喇叭才合成语音（手动触发）
  } else if (r.type === "pending") {
    const bubble = addChatBubble("bot", "需要确认：助手想调用\n" + r.pending.map((p) => "· " + p.name).join("\n"), undefined, undefined, null);
    const row = document.createElement("div");
    row.className = "approve-row";
    const ok = document.createElement("button");
    ok.className = "small-btn primary"; ok.textContent = "执行";
    const no = document.createElement("button");
    no.className = "small-btn danger"; no.textContent = "拒绝";
    wbPending = { slug: wbSlug, messages: r.messages, tools: wbLastOpts?.tools ?? [], model: wbLastOpts?.model ?? "", userKey: "local", approve: false };
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
  } catch (e) { addChatBubble("bot", "⚠ " + e.message, undefined, undefined, null); }
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

/**
 * 危险操作确认弹窗（替代原生 confirm，可带要点列表）。
 * 返回 Promise<boolean>，用 await 取用户选择。
 */
function wbConfirm({ title = "确认操作", lead = "", points = [], note = "", okText = "确定删除", cancelText = "取消", danger = true }) {
  return new Promise((resolve) => {
    $("#wb-confirm-ov")?.remove();
    const ov = document.createElement("div");
    ov.id = "wb-confirm-ov";
    ov.className = "wb-confirm-ov";
    ov.innerHTML = `<div class="wb-confirm ${danger ? "danger" : ""}" role="dialog" aria-modal="true">
      <div class="wb-confirm-head">
        <span class="wb-confirm-icon">${danger ? "⚠" : "?"}</span>
        <h3>${escapeHtml(title)}</h3>
      </div>
      ${lead ? `<p class="wb-confirm-lead">${escapeHtml(lead)}</p>` : ""}
      ${points.length ? `<ul class="wb-confirm-points">${points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}
      ${note ? `<p class="wb-confirm-note">${escapeHtml(note)}</p>` : ""}
      <div class="wb-confirm-foot">
        <button class="ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
        <button class="${danger ? "danger" : "primary"}" data-act="ok">${escapeHtml(okText)}</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", onKey);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return close(false);
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") close(false);
      if (act === "ok") close(true);
    });
  });
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
//  视图：人设卡库（分条式头像卡片网格 + 编辑表单）
// ============================================================
let cardsGridData = [];
let cardSearch = "";
let botsData = { bots: [] };
// 进卡库后要自动打开的卡（退出本地聊天时回到原来那张卡的编辑页）
let pendingOpenCardSlug = "";

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
  // 从本地聊天退出时带过来的卡：直接进它的编辑页（不用用户再点一次）
  if (pendingOpenCardSlug) {
    const slug = pendingOpenCardSlug;
    pendingOpenCardSlug = "";
    void loadCardIntoEditor(slug);
  }
}

/** 本地聊天：以这张卡为形象进入聊天视图（SPA 内部切换，不整页重载） */
async function openLocalChat() {
  if (!editingCard) return;
  await saveCard();
  localStorage.setItem("ocs_workbench_slug", editingCard.slug);
  // 聊天页是独立路由 #/chat（通讯录同款入口）
  if ((location.hash || "").replace(/^#\/?/, "").split("?")[0] === "chat") router();
  else location.hash = "#/chat";
}

async function loadCardsGrid() {
  // 有缓存就先画（公网上避免 1-2s 空白），后台刷新后只在数据真变了才重绘
  try {
    const bots = cachePeek("/api/bots?skipStatus=1");
    if (bots) botsData = bots;
    const { cards } = await cachedGet("/api/cards", (fresh) => {
      cardsGridData = fresh.cards ?? [];
      renderCardsGrid();
    });
    cardsGridData = cards ?? [];
    renderCardsGrid();
  } catch (e) {
    const grid = $("#cards-grid");
    if (grid) {
      grid.innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)} <button class="ghost small-btn" id="cards-retry">重试</button></div>`;
      $("#cards-retry")?.addEventListener("click", loadCardsGrid);
    }
    return;
  }
  // 角标只需知道"有没有绑机器人"，用 skipStatus 快路径（不跑 openclaw CLI）
  cachedGet("/api/bots?skipStatus=1", (fresh) => { botsData = fresh; renderCardsGrid(); })
    .then((b) => {
      // 首帧已用缓存画过，这里只在内容变化时重绘，避免"卡片重新生成一遍"的闪动
      if (JSON.stringify(b) !== JSON.stringify(botsData)) { botsData = b; renderCardsGrid(); }
    })
    .catch(() => {});
}

async function refreshBots() {
  cacheInvalidate("/api/bots");
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
let botConnections = null;   // /api/channels/connections 快照（已认证账号 + 绑定状态）

/**
 * 统一取 connections 快照。
 * 这份数据被三处共用（通道连接页列表、卡片机器人弹窗、高级配置的账号下拉），
 * 以前各自抓各自缓存，换卡/解绑后另外两处还是旧快照——表现就是"换了卡但里面显示老卡，
 * 刷新页面才对"。现在统一走这里，任何变更后调 invalidateConnections() 即可全局生效。
 * 默认 repair=0（纯文件读，毫秒级）；repair=1 会跑 openclaw CLI 自愈绑定（5-15s），只在后台补。
 */
async function fetchConnections({ force = false, repair = false } = {}) {
  if (!force && !repair && botConnections) return botConnections;
  const data = await api.get("/api/channels/connections" + (repair ? "?repair=1" : "")).catch(() => null);
  if (data) botConnections = data;
  return botConnections;
}

function invalidateConnections() {
  botConnections = null;
}

/** 绑定关系变更后：立刻重取共享快照并重绘所有可见的相关界面 */
async function syncAfterBotChange() {
  invalidateConnections();
  const [conn, bots] = await Promise.all([
    fetchConnections({ force: true }),
    api.get("/api/bots?skipStatus=1").catch(() => ({ bots: [] })),
  ]);
  botsData = bots;
  // 通道连接页开着就重绘列表；卡片弹窗/高级配置开着就重绘机器人区块
  if ($("#conn-list")) renderConnections(conn);
  if ($("#bot-dialog-body") || $("#adv-bot-body")) {
    const cur = (bots.bots ?? []).find((b) => b.cardSlug === botDialogSlug);
    if (!botLoginTimer) renderBotBody(cur ?? null); // 正在扫码时别重绘掉二维码
  }
  if ($("#cards-grid")) renderCardsGrid();
  // 后台再跑一次带自愈的（补齐可能缺失的路由绑定），完成后静默刷新
  fetchConnections({ repair: true }).then((fresh) => {
    if (fresh && $("#conn-list")) renderConnections(fresh);
  }).catch(() => {});
}

/** 账号显示名：昵称优先，没起名回落渠道名/accountId */
function accountText(a) {
  return a?.label || a?.name || a?.accountId || "";
}

function connChannelTag(channel) {
  return channel === "qqbot" ? "QQ" : "微信";
}

function connBusyKey(channel, accountId) {
  return `acc:${channel}|${accountId}`;
}

/** 换卡/绑卡进行中的整行：转圈，不响应重绘 */
function connBusyRow(channel, accountId, accName) {
  return `<div class="conn-row busy">
    <span class="chip" title="${escapeHtml(accountId)}">${connChannelTag(channel)} · ${escapeHtml(accName)}</span>
    <span class="conn-loading">更换中…</span>
  </div>`;
}

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
  // 已认证渠道账号 + 绑定状态（供「直接连接已绑定账号」流程用）。
  // 两个请求都走快路径并行拉：connections 纯文件读、bots 带 skipStatus 不跑 CLI，秒开。
  const [conn, bots] = await Promise.all([
    fetchConnections({ force: true }),
    api.get("/api/bots?skipStatus=1").catch(() => ({ bots: [] })),
  ]);
  botConnections = conn;
  botsData = bots;
  const bot = (botsData.bots ?? []).find((b) => b.cardSlug === slug);
  render(bot ?? null);
  // 存活状态要跑 openclaw CLI（5-15s），后台补，别挡首屏
  api.get("/api/bots").then((full) => {
    if (!$("#bot-dialog-body")) return;
    botsData = full;
    const fresh = (full.bots ?? []).find((b) => b.cardSlug === slug);
    if (fresh && !botLoginTimer) renderBotBody(fresh);
  }).catch(() => {});
}

/**
 * 「保存配置」时顺带把账号绑定落实：
 * - 账号下拉停在「新建（扫码）」档 → 不动（要走二维码，由「连接 / 创建」负责）
 * - 选了未绑卡的已认证账号 → 直接连到本卡（免扫码）
 * - 选了别的卡占用的账号 → 二次确认后换到本卡（凭证复用，旧卡自动让位）
 * - 已经是本卡当前账号 → 什么都不做
 * 返回一句给 toast 用的说明；不涉及绑定就返回空串。
 */
async function applyAdvAccountBinding() {
  const sel = $("#adv-bot-body #bot-account");
  if (!sel) return ""; // 已有实例的详情态，没有账号下拉
  const acc = sel.value;
  if (!acc) return ""; // 「新建」档：留给二维码流程
  const chan = $("#adv-bot-body #bot-channel")?.value;
  if (!chan) return "";
  const conn = await fetchConnections();
  const acct = (conn?.accounts ?? []).find((a) => a.channel === chan && a.accountId === acc);
  const acctName = accountText(acct) || acc;
  // 已经绑在本卡上，无需重复操作
  if (acct?.boundCardSlug === editingCard.slug) return "";
  const curName = editingCard.name || editingCard.slug;
  if (acct?.boundCardSlug) {
    // 被别的卡占用 → 确认后换卡
    if (!confirm(`账号「${acctName}」当前绑定的是「${acct.boundCardName ?? acct.boundCardSlug}」。\n\n确认换到「${curName}」吗？换卡后旧卡不再接收该账号消息（凭证复用，不用重新扫码）。`)) {
      return "账号未改动";
    }
    await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId: acct.boundBotId, toCardSlug: editingCard.slug }) });
    await syncAfterBotChange();
    return `已把「${acctName}」换到本卡`;
  }
  // 未绑卡 → 直接连
  const r = await api.send("/api/bots", {
    method: "POST",
    body: JSON.stringify({ cardSlug: editingCard.slug, channel: chan, accountId: acc }),
  });
  await syncAfterBotChange();
  return r.evicted?.length ? `已连接「${acctName}」，卸下「${r.evicted.join("、")}」` : `已连接「${acctName}」`;
}

/**
 * 高级配置底部按钮的显隐：
 * 「连接 / 创建」只在账号下拉停在「新建（扫码）」档时才需要——那时要走二维码流程。
 * 选了已认证账号时，「保存配置」自己就会完成绑定/换绑，不该再出现第二个按钮。
 * 机器人区块自带的按钮行在高级配置里隐藏（CSS .adv-dialog .bot-create-row），只当逻辑入口用。
 */
function syncAdvCreateBtn() {
  const btn = $("#adv-create");
  if (!btn) return;
  const inner = $("#adv-bot-body #bot-create");
  const sel = $("#adv-bot-body #bot-account");
  // 没有创建入口（已有实例的详情态）→ 不显示
  btn.hidden = !inner || !sel || Boolean(sel.value);
}

function renderBotBody(bot) {
  // 机器人弹窗用 #bot-dialog-body；卡片高级配置内嵌的机器人区块用 #adv-bot-body（二者不会同时存在）
  const body = $("#bot-dialog-body") ?? $("#adv-bot-body");
  if (!body) return;
  // 当前卡名：这个函数里没有 card 对象（只有 botDialogSlug），换卡确认框要用到卡名，
  // 从卡库缓存/正在编辑的卡里取，取不到就退回 slug（曾因直接写 card.name 报 card is not defined）
  const curCardName =
    cardsGridData.find((c) => c.slug === botDialogSlug)?.name ||
    (editingCard?.slug === botDialogSlug ? editingCard.name : "") ||
    botDialogSlug;
  if (!bot) {
    const limits = botsData.limits ?? botConnections?.limits ?? {};
    const bots = botsData.bots ?? [];
    const qqCount = bots.filter((b) => b.channel === "qqbot").length;
    const maxQq = limits.maxQq ?? 5;
    // 已认证账号（本渠道）：全部列出来，各自标状态——未绑卡可直连、已绑别的卡选了就换卡。
    // 渠道一律不禁用：微信「最多绑 1 个」不该挡住"把微信换到这张卡"这个操作（旧卡会自动掉落）。
    const accounts = (botConnections?.accounts ?? []).filter((a) => a.authed);
    const qqAccounts = accounts.filter((a) => a.channel === "qqbot");
    const wxAccounts = accounts.filter((a) => a.channel === "openclaw-weixin");
    const slots = botConnections?.slots ?? {};
    // 账号槽位满 = 不能再扫新码（只能选已有账号）；绑卡数满只影响 QQ 新增
    const updateFullState = () => {
      const chan = $("#bot-channel")?.value;
      const btn = $("#bot-create");
      const sel = $("#bot-account");
      if (!btn || !sel) return;
      const isNew = !sel.value; // 空值 = 新建扫码
      const slot = slots[chan] ?? null;
      const slotFull = slot ? slot.used >= slot.max : false;
      const qqBotFull = chan === "qqbot" && qqCount >= maxQq;
      const blocked = isNew && (slotFull || qqBotFull);
      btn.disabled = blocked;
      btn.title = blocked
        ? slotFull
          ? `账号已存满（${slot.used}/${slot.max}），请先到「通道连接」页彻底删除一个账号`
          : "该渠道绑卡已达上限"
        : "";
    };
    const renderAccountSelect = (preserve) => {
      const chan = $("#bot-channel").value;
      const list = chan === "qqbot" ? qqAccounts : wxAccounts;
      const sel = $("#bot-account");
      if (!sel) return;
      const prev = preserve ? sel.value : "";
      const slot = slots[chan] ?? null;
      const slotFull = slot ? slot.used >= slot.max : false;
      const newOpt = slotFull
        ? `<option value="" disabled>（账号已存满 ${slot.used}/${slot.max}，先删一个才能扫码）</option>`
        : `<option value="">（新建机器人，扫码绑定）</option>`;
      sel.innerHTML = [newOpt]
        .concat(list.map((a) => {
          const nm = accountText(a);
          const state = !a.boundCardSlug
            ? "未绑卡，可直接连接"
            : a.boundCardSlug === botDialogSlug
              ? "当前"
              : `现绑「${a.boundCardName ?? a.boundCardSlug}」，选它=换到本卡`;
          return `<option value="${escapeHtml(a.accountId)}" ${prev === a.accountId ? "selected" : ""}>${escapeHtml(nm)} · ${escapeHtml(state)}</option>`;
        }))
        .join("");
      sel.disabled = false;
      // 槽位满时默认选第一个已有账号，避免停在禁用项上
      if (slotFull && !sel.value && list.length) sel.selectedIndex = 1;
    };
    body.innerHTML = `
      <div class="bot-form">
        <label>渠道：
          <select id="bot-channel">
            <option value="qqbot">QQ 机器人</option>
            <option value="openclaw-weixin">微信机器人</option>
          </select>
        </label>
        <label>账号：
          <select id="bot-account"></select>
        </label>
      </div>
      <div class="row bot-create-row" style="justify-content:flex-end">
        <button id="bot-create" class="primary">连接 / 创建</button>
      </div>`;
    $("#bot-channel").addEventListener("change", () => { renderAccountSelect(false); updateFullState(); syncAdvCreateBtn(); });
    $("#bot-account").addEventListener("change", () => { updateFullState(); syncAdvCreateBtn(); });
    renderAccountSelect(false);
    updateFullState();
    syncAdvCreateBtn();
    $("#bot-create").addEventListener("click", async () => {
      const btn = $("#bot-create");
      btn.disabled = true; btn.textContent = "处理中…";
      const chan = $("#bot-channel").value;
      const acc = $("#bot-account").value; // 空 = 新建扫码；非空 = 直连已认证账号
      try {
        if (acc) {
          // ── 直连已认证账号 ──
          const conn = await fetchConnections();
          const acct = (conn?.accounts ?? []).find((a) => a.channel === chan && a.accountId === acc);
          const acctName = accountText(acct) || acc;
          if (acct?.boundCardSlug && acct.boundCardSlug !== botDialogSlug) {
            // 该账号已绑定别的卡 → 二次确认换卡
            if (!confirm(`账号「${acctName}」当前已绑定「${acct.boundCardName ?? acct.boundCardSlug}」这张卡。\n\n确认把它换到当前卡「${curCardName}」吗？换卡后旧卡不再接收该账号消息（凭证复用，不重新扫码）。`)) {
              btn.disabled = false; btn.textContent = "连接 / 创建";
              return;
            }
            try {
              await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId: acct.boundBotId, toCardSlug: botDialogSlug }) });
              toast("✓ 已换到当前卡并连接");
              await syncAfterBotChange();
              return;
            } catch (err) {
              toast("换卡失败：" + err.message, false);
              btn.disabled = false; btn.textContent = "连接 / 创建";
              return;
            }
          }
          // 未占用 → 直接创建 bot 并绑定该已认证账号（免扫码）
          const r = await api.send("/api/bots", {
            method: "POST",
            body: JSON.stringify({ cardSlug: botDialogSlug, channel: chan, accountId: acc }),
          });
          // 微信只能绑 1 张卡：后端会把旧卡顶下来，这里如实告诉用户被卸掉的是哪张
          toast(r.evicted?.length
            ? `✓ 已连接「${acctName}」，已卸下「${r.evicted.join("、")}」`
            : `✓ 已连接「${acctName}」`);
          await syncAfterBotChange();
          return;
        }
        // ── 新建机器人（扫码绑定） ──
        const r = await api.send("/api/bots", {
          method: "POST",
          body: JSON.stringify({ cardSlug: botDialogSlug, channel: chan, accountId: "" }),
        });
        toast(r.evicted?.length ? `机器人已创建，已卸下「${r.evicted.join("、")}」，接下来扫码绑定` : "机器人已创建，接下来扫码绑定");
        renderBotBody({ ...r.bot, channelLabel: r.bot.channel === "qqbot" ? "QQ 机器人" : "微信机器人", agentExists: r.agentExists ?? null });
        invalidateConnections();
        refreshBots();
      } catch (e) {
        // 账号被其他卡占用 → 一键转移（凭证复用不重新扫码）
        if (/占用/.test(e.message)) {
          const conn = await fetchConnections();
          const occupier = conn?.bots?.find((b) => b.channel === chan && b.accountId === acc);
          if (occupier && confirm(`该账号已被「${occupier.cardName ?? occupier.cardSlug}」占用。一键转移：把账号从旧卡顶到当前卡？（凭证复用，不重新扫码）`)) {
            try {
              await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId: occupier.id, toCardSlug: botDialogSlug }) });
              toast("✓ 已转移");
              await syncAfterBotChange();
              return;
            } catch (err) { toast("转移失败：" + err.message, false); }
          } else {
            toast("创建失败：" + e.message, false);
          }
        } else {
          toast("创建失败：" + e.message, false);
        }
        btn.disabled = false;
        btn.textContent = "连接 / 创建";
        updateFullState();
      }
    });
    return;
  }
  // 已有实例：详情 + 操作
  // 换绑账号下拉：把这张卡换成别的已认证账号。账号被别的卡占用时，确认后自动顶掉旧卡换过来——
  // 不要求用户先自己去解绑/换卡（用户拍板的机制）。
  const allAccs = (botConnections?.accounts ?? []).filter((a) => a.authed && a.channel === bot.channel);
  const rebindOpts = [`<option value="">（保持当前账号）</option>`]
    .concat(allAccs
      .filter((a) => a.accountId !== bot.accountId)
      .map((a) => {
        const nm = accountText(a) || a.accountId;
        const state = !a.boundCardSlug
          ? "未绑卡"
          : a.boundCardSlug === botDialogSlug
            ? "当前"
            : `现绑「${a.boundCardName ?? a.boundCardSlug}」`;
        return `<option value="${escapeHtml(a.accountId)}" ${a.boundCardSlug && a.boundCardSlug !== botDialogSlug ? "data-occupied=\"1\"" : ""}>${escapeHtml(nm)} · ${escapeHtml(state)}</option>`;
      }))
    .join("");
  body.innerHTML = `
    <div class="bot-detail">
      <div class="bot-detail-row"><span>接到哪</span><b>${bot.channelLabel ?? (bot.channel === "qqbot" ? "QQ 机器人" : "微信机器人")}</b></div>
      <div class="bot-detail-row"><span>账号</span><b>${escapeHtml(bot.accountLabel || bot.accountId)}</b>${bot.accountLabel && bot.accountLabel !== bot.accountId ? ` <code class="muted">${escapeHtml(bot.accountId)}</code>` : ""}</div>
      <div class="bot-detail-row"><span>运行状态</span>${bot.agentExists === true ? '<span class="ok-badge">正常 ✓</span>' : bot.agentExists === false ? '<span class="warn-badge">需要重新创建</span>' : '<span class="muted">检测中…</span>'}</div>
    </div>
    <div class="bot-form" style="margin-top:8px">
      <label>换绑账号：
        <select id="bot-rebind">${rebindOpts}</select>
      </label>
    </div>
    <p class="hint" id="bot-rebind-msg"></p>
    <div class="bot-login-area">
      <div class="row">
        <button id="bot-login" class="primary small-btn">扫码绑定此账号</button>
      </div>
      <p class="hint" id="bot-login-msg"></p>
      <pre id="bot-qr" class="qr-box" style="display:none"></pre>
      <div id="bot-qr-img" class="qr-img" style="display:none"></div>
      <a id="bot-qr-link" class="qr-link" target="_blank" style="display:none">扫不了？点这里在浏览器打开链接</a>
    </div>`;
  $("#bot-login").addEventListener("click", () => startBotLogin(bot.id));
  // 换绑账号：选占用账号 → 确认后 transfer 顶掉旧卡；选空闲账号 → 本 agent 直接换绑
  $("#bot-rebind")?.addEventListener("change", async () => {
    const sel = $("#bot-rebind");
    const acc = sel?.value;
    if (!sel || !acc) return;
    const acct = (botConnections?.accounts ?? []).find((a) => a.channel === bot.channel && a.accountId === acc);
    const accName = accountText(acct) || acc;
    const msg = $("#bot-rebind-msg");
    sel.disabled = true;
    try {
      if (acct?.boundCardSlug && acct.boundCardSlug !== botDialogSlug) {
        // 账号被别的卡占用：问一句，确定后自动把旧卡顶掉换过来
        if (!confirm(`账号「${accName}」现绑「${acct.boundCardName ?? acct.boundCardSlug}」这张卡。\n\n确定把它换到当前卡吗？旧卡上的绑定会解除（凭证复用，不重新扫码）。`)) {
          sel.value = ""; sel.disabled = false;
          return;
        }
        await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId: acct.boundBotId, toCardSlug: botDialogSlug }) });
        toast("✓ 已换到当前卡");
      } else {
        // 空闲账号：本卡 agent 直接换绑到它
        if (!confirm(`把当前卡换绑到账号「${accName}」？`)) {
          sel.value = ""; sel.disabled = false;
          return;
        }
        await api.send(`/api/bots/${bot.id}/bind`, { method: "POST", body: JSON.stringify({ channel: bot.channel, accountId: acc }) });
        toast("✓ 已换绑账号");
      }
      await syncAfterBotChange(); // 重绘成新账号
    } catch (e) {
      toast("换绑失败：" + e.message, false);
      const s2 = $("#bot-rebind");
      if (s2) { s2.disabled = false; s2.value = ""; }
    }
    if (msg) msg.textContent = "";
  });
  // 「重新应用」「删除机器人」两个按钮已移除（2026-09-08）：
  // 前者与「保存配置」重复——卡片保存时 syncCardToChannel 已自动重编译并同步模型/节奏；
  // 后者是历史遗留，换卡直接用上面的「换绑账号」，不需要先删机器人。
  // 后端 /recompile 与 DELETE /api/bots/:id 端点保留（供脚本/排障使用）。
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
        msg.textContent = s.ok ? "扫码成功，账号已绑定，已立即生效" : "未成功，检查输出后重试";
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

/**
 * 通道机器人第 3 个起强制走官方中转站（Soul API）：锁死高级配置里的提供商/模型选择。
 * 判定用 /api/bots 返回的 officialLocked（已建的按创建位次）/ official.nextLocked（还没建的预判）。
 * 本地网页聊天不受影响——这里只锁「接 QQ/微信 的机器人」用哪个商。
 */
function applyAdvModelLock() {
  const provSel = $("#adv-model-provider"), modelSel = $("#adv-model-id"), tip = $("#adv-model-lock");
  if (!provSel || !modelSel) return;
  const bots = botsData.bots ?? [];
  const mine = bots.find((b) => b.cardSlug === botDialogSlug);
  const lockFrom = botsData.official?.lockFrom ?? 3;
  // 这张卡已有机器人 → 看它自己的位次；还没有 → 看「再建一个是否会被锁」
  const locked = mine ? mine.officialLocked === true : botsData.official?.nextLocked === true;
  if (!locked) {
    provSel.disabled = false; modelSel.disabled = false;
    if (tip) tip.style.display = "none";
    return;
  }
  const name = botsData.official?.name ?? OFFICIAL_PROVIDER_NAME;
  // 强制选中官方商并按它的模型列表刷新
  const official = advChatProviders.find((p) => p.name === name);
  if (official) {
    if (![...provSel.options].some((o) => o.value === name)) {
      provSel.insertAdjacentHTML("afterbegin", `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
    }
    provSel.value = name;
    const cur = modelSel.value;
    modelSel.innerHTML = (official.models ?? []).map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("") || `<option value=""></option>`;
    if ((official.models ?? []).includes(cur)) modelSel.value = cur;
  }
  provSel.disabled = true; // 商锁死，模型仍可在官方站内部选
  modelSel.disabled = false;
  if (tip) {
    tip.style.display = "";
    tip.textContent = official
      ? `第 ${lockFrom} 个及以后的机器人固定使用「${name}」，只能在它的模型里选。本地聊天不受此限制。`
      : `第 ${lockFrom} 个及以后的机器人必须使用「${name}」，请先到「API 与模型」页给它填 Key、启用并拉取模型。`;
  }
}

function closeAdvConfig() {
  if (botLoginTimer) { clearInterval(botLoginTimer); botLoginTimer = null; }
  $("#adv-overlay")?.remove();
  botDialogSlug = "";
}

/** 表情包分组选择弹窗：选一个分组并确认 = 开启表情包（editingCard.emojiGroup） */
async function openEmojiGroupPicker() {
  if (!$("#adv-overlay")) return;
  let data;
  try { data = await cachedGet("/api/emojis"); } catch { return toast("读取表情库失败", false); }
  const groups = data.groups ?? [];
  const countBy = {};
  for (const e of data.emojis ?? []) countBy[e.group] = (countBy[e.group] ?? 0) + 1;
  const cur = new Set(editingCard.emojiGroups ?? []);
  const wrap = document.createElement("div");
  wrap.className = "bot-overlay";
  wrap.id = "emoji-picker-overlay";
  wrap.innerHTML = `<div class="bot-dialog" style="max-width:440px">
    <div class="bot-dialog-head">
      <h3>${icon("image")} 表情包 · ${escapeHtml(editingCard.name)}</h3>
      <button class="ghost small-btn" id="emoji-picker-close">${icon("x")}</button>
    </div>
    <div class="adv-sec">
      <p class="hint">点选一个或多个分组（可多选，高亮 = 已选），AI 就从这些分组里挑表情发送。全部取消高亮 = 关闭表情包。想管理分组去「表情包库」页。</p>
      <div class="emoji-groups" style="margin-top:8px">
        ${groups.map((g) => {
          const checked = cur.has(g.id);
          return `<span class="emoji-group-tab${checked ? " on" : ""}" data-g="${escapeHtml(g.id)}">${escapeHtml(g.name)}<span class="g-count">${countBy[g.id] ?? 0}</span></span>`;
        }).join("")}
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button class="ghost" id="emoji-picker-cancel">取消</button>
      <button class="primary" id="emoji-picker-ok">确认选择</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const tabs = [...wrap.querySelectorAll(".emoji-group-tab")];
  tabs.forEach((t) => t.addEventListener("click", () => t.classList.toggle("on")));
  const close = () => wrap.remove();
  $("#emoji-picker-close").addEventListener("click", close);
  $("#emoji-picker-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  $("#emoji-picker-ok").addEventListener("click", () => {
    const picked = tabs.filter((t) => t.classList.contains("on")).map((t) => t.dataset.g);
    editingCard.emojiGroups = picked;
    close();
    // 同步高级配置里的高亮与提示
    const cap = document.querySelector('.cap-toggle[data-cap="emoji"]');
    if (cap) cap.classList.toggle("on", picked.length > 0);
    const hint = $("#adv-emoji-hint"), nameEl = $("#adv-emoji-group-name");
    if (hint) hint.style.display = picked.length ? "" : "none";
    if (nameEl) nameEl.textContent = picked.length
      ? picked.map((id) => groups.find((g) => g.id === id)?.name ?? id).join("、")
      : "";
    toast(picked.length ? "✓ 已开启表情包" : "已关闭表情包");
  });
}

/** 主动发消息配置弹窗：滑动杆选间隔（0-24h，步进 1h，0=关闭），0-6 点固定静默 */
function openLifePicker() {
  if (!$("#adv-overlay")) return;
  const cur = editingCard.life?.intervalHours ?? 0;
  const wrap = document.createElement("div");
  wrap.className = "bot-overlay";
  wrap.id = "life-picker-overlay";
  wrap.innerHTML = `<div class="bot-dialog" style="max-width:440px">
    <div class="bot-dialog-head">
      <h3>${icon("zap")} 主动发消息 · ${escapeHtml(editingCard.name)}</h3>
      <button class="ghost small-btn" id="life-picker-close">${icon("x")}</button>
    </div>
    <div class="adv-sec">
      <div class="slider-wrap" style="margin:18px 0 10px">
        <b class="slider-val" id="life-interval-label"></b>
        <input type="range" id="life-interval" min="0" max="24" step="1" value="${cur}" style="width:100%">
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button class="ghost" id="life-picker-cancel">取消</button>
      <button class="primary" id="life-picker-ok">确认</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const range = $("#life-interval"), label = $("#life-interval-label");
  const syncLabel = () => {
    const v = Number(range.value);
    label.textContent = v === 0 ? "关闭" : v + " 小时一次";
    label.style.left = (v / 24) * 100 + "%";
  };
  syncLabel();
  range.addEventListener("input", syncLabel);
  const close = () => wrap.remove();
  $("#life-picker-close").addEventListener("click", close);
  $("#life-picker-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  $("#life-picker-ok").addEventListener("click", () => {
    const h = Number(range.value);
    editingCard.life = { ...(editingCard.life ?? {}), intervalHours: h, quietFrom: 0, quietTo: 6 };
    close();
    // 同步高级配置里的高亮与提示
    const cap = document.querySelector('.cap-toggle[data-cap="life"]');
    if (cap) cap.classList.toggle("on", h > 0);
    const hint = $("#adv-life-hint"), intervalEl = $("#adv-life-interval");
    if (hint) hint.style.display = h > 0 ? "" : "none";
    if (intervalEl) intervalEl.textContent = String(h);
    toast(h > 0 ? `✓ 已开启：每 ${h} 小时主动发消息` : "已关闭主动发消息");
  });
}

/** 高级配置数据拉取失败：给明确错误 + 重试按钮（不再画一个空下拉框让用户猜） */
function showAdvError(msg) {
  const ov = document.createElement("div");
  ov.id = "adv-overlay";
  ov.className = "bot-overlay";
  ov.innerHTML = `<div class="bot-dialog adv-dialog" style="max-width:420px">
    <div class="bot-dialog-head"><h3>${icon("settings")} 高级配置</h3>
      <button class="ghost small-btn" id="adv-err-close">${icon("x")}</button></div>
    <div class="adv-sec"><p class="hint">读取配置失败：${escapeHtml(msg)}</p>
      <p class="hint">公网访问偶发超时，点重试通常就好。</p></div>
    <div class="row" style="justify-content:flex-end"><button class="primary" id="adv-err-retry">重试</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeAdvConfig(); });
  $("#adv-err-close").addEventListener("click", closeAdvConfig);
  $("#adv-err-retry").addEventListener("click", () => { closeAdvConfig(); void openAdvConfig(); });
}

/**
 * 拉高级配置需要的四份数据。
 * 都走快路径：providers 读本地配置、bots 带 skipStatus、connections 纯文件读（都不跑 openclaw CLI）。
 * connections 必须一起拉：账号下拉靠它，缺了就会错报「该渠道还没有已认证账号」。
 * **失败会抛出**：原来每个请求各自 `.catch()` 成空数组，弹窗照样画出来但下拉框是空的
 * （用户看到的「模型/预设加载不出来，关掉重开才好」就是这个）。现在失败即报错 + 可重试。
 */
async function fetchAdvData() {
  const [prov, bots, conn, presets] = await Promise.all([
    apiGetRetry("/api/providers"),
    apiGetRetry("/api/bots?skipStatus=1"),
    apiGetRetry("/api/channels/connections"),
    apiGetRetry("/api/presets"),
  ]);
  // 回填缓存，后续开弹窗可以秒开
  apiCache.set("/api/providers", { data: prov, ts: Date.now(), inflight: null });
  apiCache.set("/api/bots?skipStatus=1", { data: bots, ts: Date.now(), inflight: null });
  apiCache.set("/api/presets", { data: presets, ts: Date.now(), inflight: null });
  return { prov, bots, conn, presets };
}

async function openAdvConfig() {
  if (!editingCard) return;
  closeAdvConfig();
  closeBotDialog();
  botDialogSlug = editingCard.slug;
  // 先用缓存立即开窗（公网上四个请求串起来要 1-2s，硬等就是「点了没反应」）；
  // 缓存缺失才等网络，且失败给明确错误 + 重试，不再静默画空下拉框。
  const cProv = cachePeek("/api/providers");
  const cBots = cachePeek("/api/bots?skipStatus=1");
  const cPresets = cachePeek("/api/presets");
  let prov = cProv, bots = cBots, conn = botConnections;
  if (!cProv || !cBots || !cPresets || !conn) {
    try {
      const got = await fetchAdvData();
      prov = got.prov; bots = got.bots; conn = got.conn;
      presetStoreData = got.presets;
    } catch (e) {
      showAdvError(e.message);
      return;
    }
  } else {
    presetStoreData = cPresets;
    // 缓存开窗后台静默刷新，数据变了就重开一次（保证不会一直用旧的）
    void fetchAdvData().then((got) => {
      const changed = JSON.stringify(got.prov) !== JSON.stringify(cProv)
        || JSON.stringify(got.presets) !== JSON.stringify(cPresets);
      if (changed && $("#adv-overlay") && !botLoginTimer) {
        botConnections = got.conn;
        presetStoreData = got.presets;
        openAdvConfig();
      }
    }).catch(() => {});
  }
  // 停用的提供商不出现在选择框里
  advChatProviders = (prov.chat ?? []).filter((p) => p.enabled !== false);
  botsData = bots;
  botConnections = conn;
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
  const splitCfg = editingCard.chat?.split ?? { min: 1, max: 7 };
  const enabledTools = new Set(editingCard.tools?.enabled ?? []);
  const ab = editingCard.abilities ?? {};
  const cardPresets = editingCard.presets ?? {};
  // 档位默认「破甲」：没选过（或选的组已删）就落到 break，不再提供「不使用档位」
  const curTier = presetStoreData.tiers.some((t) => t.id === cardPresets.tier) ? cardPresets.tier : "break";
  const tierOpts = presetStoreData.tiers
    .map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === curTier ? "selected" : ""}>${escapeHtml(t.name)}</option>`)
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
      <p class="hint" id="adv-model-lock" style="display:none"></p>
    </div>

    <div class="adv-sec">
      <h4>${icon("tool")} 能力</h4>
      <div class="cap-toggles">
        ${capBtn("web_search", "联网搜索", enabledTools.has("web_search"))}
        ${capBtn("image_gen", "生图", enabledTools.has("image_gen"))}
        ${capBtn("tts", "TTS 朗读", ab.tts === true)}
        ${capBtn("emoji", "表情包", (editingCard.emojiGroups ?? []).length > 0)}
        ${capBtn("life", "主动发消息", (editingCard.life?.intervalHours ?? 0) > 0)}
      </div>
      <p class="hint" id="adv-emoji-hint" style="${(editingCard.emojiGroups ?? []).length ? "" : "display:none"}">表情包分组：<b id="adv-emoji-group-name"></b>（AI 从这些分组挑表情发）</p>
      <p class="hint" id="adv-life-hint" style="${(editingCard.life?.intervalHours ?? 0) > 0 ? "" : "display:none"}">主动发消息：每 <b id="adv-life-interval"></b> 小时一次（0-6 点静默）</p>
    </div>

    <div class="adv-sec">
      <h4>${icon("database")} 记忆</h4>
      <div class="adv-grid2">
        <div class="slider-wrap">
          <b class="slider-val" id="adv-mem-rounds-label"></b>
          <input type="range" id="adv-mem-rounds" min="0" max="20" step="1" value="${memCfg.auto_rounds ?? 5}">
        </div>
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
      <h4>${icon("message")} 回复拆条</h4>
      <div class="adv-grid2">
        <label>最少条数<input type="number" id="adv-split-min" min="${SPLIT_RANGE.min}" max="${SPLIT_RANGE.max}" step="1" value="${splitCfg.min}"></label>
        <label>最多条数<input type="number" id="adv-split-max" min="${SPLIT_RANGE.min}" max="${SPLIT_RANGE.max}" step="1" value="${splitCfg.max}"></label>
      </div>
    </div>

    <div class="adv-sec">
      <h4>${icon("bot")} 接入 QQ / 微信</h4>
      <div id="adv-bot-body"></div>
    </div>

    <div class="adv-foot">
      <button id="adv-create" class="ghost" hidden>连接 / 创建</button>
      <button id="adv-save" class="primary">保存配置</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeAdvConfig(); });
  $("#adv-close").addEventListener("click", closeAdvConfig);
  renderBotBody(bot ?? null);
  applyAdvModelLock(); // 第 3 个起的机器人：模型锁定官方中转站
  // 底部「连接 / 创建」：只在账号选了「新建」档时出现（其它情况用「保存配置」就能换绑）
  $("#adv-create").addEventListener("click", () => $("#bot-create")?.click());
  syncAdvCreateBtn();
  // 有实例时后台补 agent 存活状态（这一步要跑 openclaw CLI，不能挡面板显示）
  if (bot) {
    api.get("/api/bots").then((full) => {
      if (!$("#adv-overlay")) return; // 面板已关就别改 DOM
      botsData = full;
      const fresh = (full.bots ?? []).find((b) => b.cardSlug === botDialogSlug);
      if (fresh && !botLoginTimer) renderBotBody(fresh); // 正在扫码时不要重绘掉二维码
      applyAdvModelLock();
    }).catch(() => {});
  }

  $("#adv-model-provider").addEventListener("change", (e) => {
    const p = advChatProviders.find((x) => x.name === e.target.value);
    $("#adv-model-id").innerHTML = (p?.models ?? [])
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("") || `<option value=""></option>`;
  });
  // 记忆滑杆：标签跟随滑块位置（0=关闭在最左，其他显示轮数）
  const memSlider = $("#adv-mem-rounds"), memLabel = $("#adv-mem-rounds-label");
  if (memSlider && memLabel) {
    const syncMemLabel = () => {
      const v = Number(memSlider.value);
      memLabel.textContent = v === 0 ? "关闭" : v + " 轮";
      memLabel.style.left = (v / 20) * 100 + "%";
    };
    syncMemLabel();
    memSlider.addEventListener("input", syncMemLabel);
  }
  // 能力：点一下切换高亮（表情包/主动发消息除外——它们弹配置框）
  ov.querySelectorAll(".cap-toggle").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.cap === "emoji") return openEmojiGroupPicker();
      if (b.dataset.cap === "life") return openLifePicker();
      b.classList.toggle("on");
    })
  );
  // 已开启主动消息的卡：回显间隔
  if ((editingCard.life?.intervalHours ?? 0) > 0) {
    const el = $("#adv-life-interval");
    if (el) el.textContent = editingCard.life.intervalHours;
  }
  // 已选分组的卡：回显分组名
  if ((editingCard.emojiGroups ?? []).length) {
    cachedGet("/api/emojis").then((r) => {
      if (!$("#adv-overlay")) return;
      const names = (editingCard.emojiGroups ?? [])
        .map((id) => (r.groups ?? []).find((x) => x.id === id)?.name ?? id)
        .join("、");
      if (names && $("#adv-emoji-group-name")) $("#adv-emoji-group-name").textContent = names;
    }).catch(() => {});
  }

  $("#adv-save").addEventListener("click", async () => {
    const btn = $("#adv-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const provider = $("#adv-model-provider").value;
      const model = $("#adv-model-id").value;
      editingCard.model = provider ? { provider, ...(model ? { model } : {}) } : {};
      // 能力：高亮的即启用（tts 归 abilities，其余归 tools.enabled；emoji 是独立字段不进 tools）
      const onCaps = [...ov.querySelectorAll(".cap-toggle.on")].map((b) => b.dataset.cap);
      editingCard.tools = editingCard.tools ?? { enabled: [], policy: "auto", deny: [] };
      const memRounds = Math.min(20, Math.max(0, Number($("#adv-mem-rounds").value) || 0));
      // 滑杆归零 = 记忆整体关闭（memory_save 工具一并摘掉）；>0 时自动带上
      editingCard.tools.enabled = onCaps.filter((c) => c !== "tts" && c !== "emoji" && c !== "memory_save");
      if (memRounds > 0) editingCard.tools.enabled.push("memory_save");
      editingCard.abilities = { ...(editingCard.abilities ?? {}), tts: onCaps.includes("tts") };
      editingCard.memoryConfig = { auto_rounds: memRounds };
      editingCard.presets = {
        ...(editingCard.presets ?? {}),
        tier: $("#adv-tier").value || null,
        style: $("#adv-style").value || null,
      };
      // 回复拆条：min≤max、1≤min、max≤7（后端 schema 再兜底校验）
      const splitMin = Math.min(SPLIT_RANGE.max, Math.max(SPLIT_RANGE.min, Number($("#adv-split-min").value) || 1));
      const splitMax = Math.min(SPLIT_RANGE.max, Math.max(splitMin, Number($("#adv-split-max").value) || 7));
      editingCard.chat = {
        ...(editingCard.chat ?? {}),
        split: { min: splitMin, max: splitMax },
      };
      const res = await api.send(`/api/cards/${editingCard.slug}`, { method: "PUT", body: JSON.stringify(editingCard) });
      editingCard = res.card ?? editingCard;
      // 顺带处理账号绑定：选了已认证账号就一并完成连接/换绑（选「新建」档不动，
      // 那种情况要走二维码，由「连接 / 创建」按钮负责）
      const botNote = await applyAdvAccountBinding();
      toast("✓ 高级配置已保存 v" + editingCard.version + (botNote ? "，" + botNote : ""));
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
  return { tools, thinking };
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
    // 聊天测试开场白：本地没开场过就显示气泡（和进入工作台一致）
    const first = editingCard.sillytavern_v2?.first_mes?.trim();
    if (first && $("#chat-log")) {
      try {
        const g = await api.send(`/api/cards/${encodeURIComponent(slug)}/greeting/claim`, {
          method: "POST",
          body: JSON.stringify({ userKey: "local" }),
        });
        if (g.greeted && g.text) addChatBubble("bot", g.text);
      } catch { /* 忽略 */ }
    }
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
    cacheInvalidate("/api/cards");
    // 卡片编辑可能改了世界书/正则（影响聊天气泡显示与 AI 行为）：聊天快照 DOM 作废，
    // 回聊天按新数据重新渲染
    if (lcSnap.slug === editingCard.slug) { lcSnap.logHtml = ""; lcSnap.allEntries = []; lcSnap.renderedFrom = 0; }
    loadCardsGrid();
  } catch (e) { toast("保存失败：" + e.message, false); }
}

/** 卡库卡片上的删除（分条式，直接在卡上操作） */
async function deleteCardBySlug(slug, name) {
  if (!confirm(`确定删除「${name}」？不可恢复。`)) return;
  try {
    await api.send(`/api/cards/${slug}`, { method: "DELETE" });
    toast("已删除");
    cacheInvalidate("/api/cards", "/api/bots");
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
    cacheInvalidate("/api/cards");
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
          <label class="btn-like ghost small-btn">上传图片<input type="file" id="cf-cover-file" accept=".png,.jpg,.jpeg,.webp" hidden></label>
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
      <div class="ai-draft-model">
        <label>模型商<select id="ai-provider"><option value="">跟随默认</option></select></label>
        <label>模型<select id="ai-model"><option value="">—</option></select></label>
      </div>
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
  // AI 草稿的模型选择：加载启用中的模型商，联动模型下拉（复用本地聊天的数据源）
  loadAiDraftProviders();
  $("#ai-provider").addEventListener("change", () => fillAiDraftModels(true));
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
/** 做卡页：加载启用中的模型商到 AI 草稿下拉（默认 = 第一个启用的提供商，直接选中可换） */
async function loadAiDraftProviders() {
  const sel = $("#ai-provider");
  if (!sel) return;
  try {
    const prov = await api.get("/api/providers");
    lcProviders = (prov.chat ?? []).filter((p) => p.enabled !== false);
  } catch { lcProviders = []; }
  sel.innerHTML = lcProviders.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  fillAiDraftModels(false);
}

/** 按选中的模型商填充模型下拉 */
function fillAiDraftModels(keepModel) {
  const sel = $("#ai-model");
  if (!sel) return;
  const p = lcProviders.find((x) => x.name === $("#ai-provider")?.value);
  if (!p) { sel.innerHTML = `<option value="">—</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  const cur = keepModel ? sel.value : "";
  const models = p.models ?? [];
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m)}" ${m === cur ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")
    : `<option value="">—</option>`;
}

async function aiDraft() {
  const idea = $("#ai-idea").value.trim();
  if (!idea) return toast("先写下你的想法", false);
  const btn = $("#btn-ai-draft");
  const msg = $("#ai-msg");
  btn.disabled = true;
  btn.textContent = "生成中…（2-5 分钟，内容较多）";
  msg.textContent = "";
  try {
    // 选了具体模型才传（"提供商::模型"），跟随默认则交给后端
    const prov = $("#ai-provider")?.value || "";
    const model = $("#ai-model")?.value || "";
    const chosen = prov && model ? `${prov}::${model}` : "";
    const r = await api.send("/api/cards/ai-draft", {
      method: "POST",
      body: JSON.stringify({ idea, model: chosen }),
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
    ? entries.map((en, i) => cwRowHTML(en, i, false)).join("")
    : cwRowHTML({}, undefined, false);
  if (!entries.length) {
    const first = $("#cf-book")?.querySelector(".cw-detail");
    if (first) first.hidden = false;
  }
  $("#cf-regex").innerHTML = (draft.sillytavern_v2?.regex_scripts || []).map((sc, i) => crRowHTML(sc, i, false)).join("");
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
function renderApi() { return renderProvidersPage("chat", "API 与模型", "对话 API 提供商。点「设为默认」选择默认提供商（卡片未单独指定时用它）；默认商里勾选的第一个模型即默认模型。"); }
function renderImagegen() { return renderImgGenPage(); }

// 生图配置专用页（NovelAI / OpenAI 兼容 / 本地 SD WebUI 三套参数，网页聊天与 QQ/微信共用）
function renderImgGenPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>生图配置</h2></div>
    <p class="hint">提示：NAI 生图的上游只保存约 15 天，过期后聊天里的图会失效。有需要请到 设置 → 本地存储 开启自动保存，或在聊天设置页手动保存。</p>
    <div class="card-box">
      <div class="form">
        <label>提供商（互斥，开启一个另一个关闭）</label>
        <div class="cap-toggles img-provider-row">
          <button type="button" class="cap-toggle" data-provider="novelai">NovelAI</button>
          <button type="button" class="cap-toggle" data-provider="openai">OpenAI</button>
        </div>
        <div id="ig-pane-novelai" class="ig-pane">
          <label>服务地址</label>
          <input id="ig-nai-base" readonly disabled
                 style="background:var(--panel);color:var(--muted);cursor:not-allowed">
          <label style="margin-top:10px">API Key</label>
          <div class="pv-key-row">
            <input id="ig-nai-key" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false">
            <button type="button" id="ig-nai-key-eye" class="pv-eye-btn" title="显示 / 隐藏密钥">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <label style="margin-top:10px">生图模型</label>
          <div class="row">
            <select id="ig-nai-model" style="flex:1;min-width:200px"><option value="">（点右边拉取模型）</option></select>
            <button id="ig-nai-models" class="ghost small-btn">拉取模型</button>
          </div>
          <div id="ig-nai-models-status" class="status"></div>
          <div class="artists-box" style="margin-top:12px">
            <label>画师串</label>
            <div id="ig-artists-list"></div>
            <button id="ig-artist-add" class="ghost small-btn" style="margin-top:6px">${icon("plus")} 添加画师串</button>
            <div id="ig-artist-edit" style="display:none;margin-top:6px;border:1px dashed var(--border);border-radius:8px;padding:8px">
              <input id="ig-artist-name" placeholder="名称（如：默认画风）">
              <textarea id="ig-artist-content" rows="6" style="margin-top:6px" placeholder="画师串内容，如 masterpiece, best quality, [artist:ciloranko], ..."></textarea>
              <div class="row" style="margin-top:6px">
                <button id="ig-artist-save" class="small-btn primary">保存</button>
                <button id="ig-artist-cancel" class="small-btn ghost">取消</button>
                <span style="flex:1"></span>
                <button id="ig-artist-del" class="small-btn danger" style="display:none">删除</button>
              </div>
            </div>
          </div>
        </div>
        <div id="ig-pane-openai" class="ig-pane" style="display:none">
          <label>Base URL（以 /v1 结尾）</label>
          <input id="ig-oai-url" placeholder="https://api.example.com/v1">
          <label style="margin-top:8px">API Key（留空 = 保留原值）</label>
          <input id="ig-oai-key" type="password" placeholder="sk-...">
          <label style="margin-top:8px">生图模型</label>
          <div class="row">
            <select id="ig-oai-model" style="flex:1;min-width:160px"><option value="">（先拉取模型列表）</option></select>
            <button id="ig-oai-models" class="ghost small-btn">拉取模型</button>
          </div>
          <div id="ig-oai-models-status" class="status"></div>
        </div>
        <label style="margin-top:14px">出图尺寸</label>
        <div class="cap-toggles ig-aspect-row">
          <button type="button" class="cap-toggle" data-aspect="auto">自动</button>
          <button type="button" class="cap-toggle" data-aspect="portrait">竖图</button>
          <button type="button" class="cap-toggle" data-aspect="landscape">横图</button>
          <button type="button" class="cap-toggle" data-aspect="square">方图</button>
        </div>
        <div class="row" style="margin-top:12px">
          <button id="ig-save" class="primary">${icon("save")} 保存配置</button>
          <button id="ig-test" class="ghost">测试</button>
        </div>
        <div id="ig-status" class="status"></div>
      </div>
    </div>
    <!-- 测试结果：点「测试」后在这里直接出图（内置提示词，不用用户写） -->
    <div class="card-box">
      <div id="ig-test-status" class="status"></div>
      <div id="ig-test-img" class="ig-test-img"><div class="muted">点上面的「测试」按钮出图</div></div>
    </div>
  </div>`;
}

// ---------- 提供商图标（列表头像）：知名厂商用官方 logo，自定义的取名字首字 ----------
const PROVIDER_BRANDS = {
  deepseek: { color: "#4D6BFE", d: "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" },
  openai: { color: "#10A37F", d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
  anthropic: { color: "#D97757", d: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" },
  gemini: { color: "#4285F4", d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" },
  openrouter: { color: "#6B6B6B", d: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" },
  xai: { color: "#111111", d: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" },
  moonshot: { color: "#111111", d: "m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866" },
  qwen: { color: "#615CED", d: "M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" },
  minimax: { color: "#F23F5D", d: "M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997" },
  ollama: { color: "#111111", d: "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z" },
  mistral: { color: "#FA520F", d: "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" },
};
/** 硅基流动：simple-icons 未收录，手绘一个水流质感标记（描边风格，非填充） */
const PROVIDER_BRAND_EXTRA = {
  siliconflow: {
    color: "#6E29F6",
    stroke: true,
    d: "M5 8.6c0-2 1.6-3.6 3.6-3.6h4.8a2.7 2.7 0 0 1 0 5.4H9.4a2.7 2.7 0 0 0 0 5.4h4.6a3.6 3.6 0 0 0 3.6-3.6",
  },
};
/** 名称匹配规则：小写包含即命中（「我的deepseek中转」也能认出 DeepSeek） */
const PROVIDER_BRAND_ALIASES = {
  deepseek: ["deepseek", "深度求索"],
  openai: ["openai", "gpt"],
  anthropic: ["anthropic", "claude"],
  gemini: ["gemini", "googlegemini", "google", "谷歌"],
  xai: ["xai", "grok", "x.ai"],
  moonshot: ["moonshot", "kimi", "月之暗面"],
  qwen: ["qwen", "通义", "千问", "tongyi"],
  minimax: ["minimax", "海螺"],
  mistral: ["mistral"],
  ollama: ["ollama"],
  openrouter: ["openrouter"],
  siliconflow: ["siliconflow", "silicon", "硅基流动", "硅基"],
};

/** 按名称找品牌图标（找不到返回 null，调用方回退首字） */
function providerBrand(name) {
  const n = String(name ?? "").toLowerCase();
  if (!n) return null;
  for (const [key, aliases] of Object.entries(PROVIDER_BRAND_ALIASES)) {
    if (aliases.some((a) => n.includes(a))) {
      const b = PROVIDER_BRANDS[key] ?? PROVIDER_BRAND_EXTRA[key];
      if (b) return b;
    }
  }
  return null;
}

/** 官方自营中转站名（与后端 OFFICIAL_PROVIDER_NAME 一致；永远置顶、多机器人第 3 个起强制用它） */
const OFFICIAL_PROVIDER_NAME = "Soul API";

/** 列表左侧的提供商头像：官方站/soulAPI=用户指定图；知名厂商=品牌色淡底 + 官方 logo；自定义=名字首字 */
function providerAvatarHTML(name) {
  // 官方自营站（Soul API）与用户自建的 soulAPI：都用用户指定的图标
  if (name === OFFICIAL_PROVIDER_NAME || /^soul[_ -]?api$/i.test(String(name ?? "").trim())) {
    return `<span class="prov-avatar prov-avatar-img"><img src="assets/soulapi.jpg" alt="soulAPI"></span>`;
  }
  const b = providerBrand(name);
  if (b) {
    const inner = b.stroke
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${b.d}"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${b.d}"/></svg>`;
    return `<span class="prov-avatar" style="background:${b.color}1f;color:${b.color}">${inner}</span>`;
  }
  const ch = String(name ?? "").trim().slice(0, 1) || "?";
  return `<span class="prov-avatar prov-avatar-text">${escapeHtml(ch)}</span>`;
}

function renderProvidersPage(type, title, desc) {
  return `
  <div class="view">
    <div class="page-head"><h2>${title}</h2><p class="hint">${desc}</p></div>
    <div id="prov-list"></div>
    <button id="prov-add" class="primary">${icon("plus")} 添加提供商</button>
  </div>`;
}

let provState = { type: "chat", editing: null, allModels: [], selected: [], list: null };

function initApi() { initProvidersPage("chat"); }
function initImagegen() { initImgGenPage(); }

// ---------- 生图配置页交互 ----------
function igRadio() {
  return document.querySelector(".cap-toggle[data-provider].on")?.dataset?.provider ?? "novelai";
}
/** 出图尺寸：点一下即选中（互斥高亮），默认「自动」 */
function igAspect() {
  return document.querySelector(".cap-toggle[data-aspect].on")?.dataset?.aspect ?? "auto";
}
function setIgAspect(aspect) {
  const v = ["auto", "portrait", "landscape", "square"].includes(aspect) ? aspect : "auto";
  document.querySelectorAll(".cap-toggle[data-aspect]").forEach((b) => {
    b.classList.toggle("on", b.dataset.aspect === v);
  });
}
let imgState = { artists: [], activeArtist: "", originalKey: "", keyRevealed: false };
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
    aspect: igAspect(),
    // 服务地址不提交（后端固定）；密钥：占位点号或留空 = 不传（后端沿用原值），
    // 只有真实输入才会改密钥——与文本 API 的收集口径一致
    novelai: {
      key: (() => { const s = v("#ig-nai-key"); return s && s !== PV_KEY_DOTS ? s : ""; })(),
      model: v("#ig-nai-model"),
    },
    openai: { baseUrl: v("#ig-oai-url"), key: v("#ig-oai-key"), model: v("#ig-oai-model") },
    artists: imgState.artists,
    activeArtist: imgState.activeArtist,
  };
}
function fillImgForm(cfg) {
  setIgProvider(cfg.provider);
  setIgAspect(cfg.aspect);
  // 服务地址由后端下发（只读展示，防止用户以为能改成别的站）
  if ($("#ig-nai-base") && cfg.novelai?.base) $("#ig-nai-base").value = cfg.novelai.base;
  // 密钥：与文本 API 配置同一做法——已保存的用点号占位，点眼睛时再去后端取原文；
  // 不搞「留空=保留原值」那套（用户明确要求去掉）。
  // 注意 originalKey 初始必须是空串（表示"还不知道原文"），不能存点号，
  // 否则眼睛会误判成"没有原文"而直接清空输入框（实测踩到）。
  if ($("#ig-nai-key")) {
    imgState.keyRevealed = false;
    imgState.originalKey = "";
    $("#ig-nai-key").value = cfg.novelai?.key ? PV_KEY_DOTS : "";
  }
  // 已保存的网关模型：不在下拉里就补一个选项，保证能显示当前值
  if ($("#ig-nai-model")) {
    const sel = $("#ig-nai-model");
    const cur = cfg.novelai?.model ?? "";
    if (cur) {
      if (!Array.from(sel.options).some((o) => o.value === cur)) {
        sel.innerHTML = `<option value="${escapeHtml(cur)}">${escapeHtml(cur)}</option>`;
      }
      sel.value = cur;
    }
  }
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
  // builtin 标记必须一起拷：丢了它内置串就会渲染成普通可编辑行（实测踩到）
  imgState.artists = (cfg.artists ?? []).map((a) => ({ name: a.name, content: a.content, builtin: a.builtin === true }));
  imgState.activeArtist = cfg.activeArtist ?? "";
  renderArtistsList();
  if ($("#ig-oai-key")) $("#ig-oai-key").placeholder = cfg.openai?.key ? "•••••• 已设置（留空保留）" : "sk-...";
}
function renderArtistsList() {
  const box = $("#ig-artists-list");
  if (!box) return;
  if (!imgState.artists.length) {
    box.innerHTML = `<div class="muted">还没有画师串</div>`;
    return;
  }
  // 一行一个：只显示名称（点名称=选用，高亮表示生效），「删除」在编辑框里，列表不放假按钮。
  // 内置默认串：编辑键照常显示但**变灰禁用**（用户点名要求：变灰、不能调用），改不了也删不掉。
  box.innerHTML = imgState.artists
    .map((a, i) => {
      const on = a.name === imgState.activeArtist;
      const ops = a.builtin
        ? '<button class="ghost small-btn" disabled title="内置默认串，不可编辑">编辑</button>'
        : '<button class="ghost small-btn" data-edit="' + i + '">编辑</button>';
      return `
    <div class="artist-item${on ? " on" : ""}">
      <button type="button" class="artist-name-btn" data-pick="${i}" title="${on ? "点一下取消选用" : "点一下选用这个画师串"}">${escapeHtml(a.name)}</button>
      ${ops}
    </div>`;
    })
    .join("");
  // 点名称 = 选用（只能选一个；再点已选中的取消 = 生成时不拼画师串）
  box.querySelectorAll("[data-pick]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = imgState.artists[Number(b.dataset.pick)];
      if (!a) return;
      imgState.activeArtist = imgState.activeArtist === a.name ? "" : a.name;
      renderArtistsList();
      saveImgConfig();
    })
  );
  box.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openArtistEdit(Number(b.dataset.edit)))
  );
}
function openArtistEdit(i) {
  const a = i === null ? null : imgState.artists[i];
  if (a?.builtin) return; // 内置默认串不可编辑（后端也会剥掉，这里是防误点）
  artistEditing = i;
  $("#ig-artist-name").value = a?.name ?? "";
  $("#ig-artist-content").value = a?.content ?? "";
  $("#ig-artist-edit").style.display = "block";
  // 删除键只在编辑已有条目时出现（新增时没有可删的）
  $("#ig-artist-del").style.display = i === null ? "none" : "";
  // 刻意不自动聚焦：手机上会自动弹键盘、遮住半屏，用户点了输入框或内容区才弹
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
  closeArtistEdit(); // 从编辑框里删的，删完顺手收起
  renderArtistsList();
  saveImgConfig();
}
async function saveImgConfig() {
  const f = collectImgForm();
  const r = await api.send("/api/image/config", { method: "POST", body: JSON.stringify(f) });
  cacheInvalidate("/api/image/config");
  if (r.ok) setStatus("#ig-status", "✓ 已保存", true);
  else setStatus("#ig-status", "保存失败：" + (r.error ?? "未知错误"), false);
}
async function initImgGenPage() {
  imgState = { artists: [], activeArtist: "", originalKey: "", keyRevealed: false };
  artistEditing = null;
  const imgBox = $("#ig-test-img");
  if (imgBox) imgBox.innerHTML = '<div class="muted">点上面的「测试」按钮出图</div>';
  artistEditing = null;
  document.querySelectorAll(".cap-toggle[data-provider]").forEach((b) =>
    b.addEventListener("click", () => setIgProvider(b.dataset.provider))
  );
  // 出图尺寸：点一下即选中并立刻存盘（默认自动）
  document.querySelectorAll(".cap-toggle[data-aspect]").forEach((b) =>
    b.addEventListener("click", () => {
      setIgAspect(b.dataset.aspect);
      void saveImgConfig();
    })
  );
  // 生图模型：服务地址固定，模型由用户从自己密钥可用的列表里挑
  $("#ig-nai-models").addEventListener("click", async () => {
    const raw = $("#ig-nai-key")?.value?.trim();
    // 密钥显示为点号占位时 = 用已保存的密钥（与「测试」同一口径）。
    // 别把点号字符串当真密钥发出去——否则隐藏密钥时拉取模型必 401（实测踩到）。
    const key = raw && raw !== PV_KEY_DOTS ? raw : undefined;
    setStatus("#ig-nai-models-status", "拉取中…");
    try {
      const r = await api.send("/api/image/nai-models", {
        method: "POST",
        body: JSON.stringify({ key: key || undefined }),
      });
      if (r.error) { setStatus("#ig-nai-models-status", "拉取失败：" + r.error, false); return; }
      const models = r.models ?? [];
      if (!models.length) { setStatus("#ig-nai-models-status", "没有可用的生图模型", false); return; }
      const sel = $("#ig-nai-model");
      const cur = sel.value || "";
      const ids = models.map((m) => m.id).sort((a, b) => a.localeCompare(b));
      sel.innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
      if (cur && ids.includes(cur)) sel.value = cur;
      setStatus("#ig-nai-models-status", `✓ 拉取到 ${ids.length} 个生图模型${cur ? "，已保留原选择" : ""}`, true);
    } catch (e) {
      setStatus("#ig-nai-models-status", "拉取失败：" + e.message, false);
    }
  });
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
    cacheInvalidate("/api/image/config");
    if (r.ok) {
      toast(r.hint || "已保存");
      setStatus("#ig-status", "✓ 已保存", true);
    } else setStatus("#ig-status", "保存失败：" + (r.error ?? "未知错误"), false);
  });
  // 「测试」= 校验密钥 + 用内置提示词出一张图，结果直接展示在下面的图片区
  $("#ig-test").addEventListener("click", async () => {
    const f = collectImgForm();
    const btn = $("#ig-test");
    const imgBox = $("#ig-test-img");
    btn.disabled = true;
    imgBox.innerHTML = '<div class="muted">生成中（约 5-30 秒）…</div>';
    setStatus("#ig-test-status", "", true);
    try {
      // ① 先校验密钥（快、不扣费），失败就没必要往下走
      const t = await api.send("/api/image/test", { method: "POST", body: JSON.stringify(f) });
      setStatus("#ig-test-status", t.info ?? "", t.ok);
      if (!t.ok) { imgBox.innerHTML = '<div class="muted">密钥不可用，未生成</div>'; return; }
      // ② 出图（不传 prompt → 后端按提供商挑内置提示词；不传 aspect → 用全局尺寸设置）
      const r = await api.send("/api/image/generate", { method: "POST", body: JSON.stringify(f) });
      if (!r.ok) {
        imgBox.innerHTML = `<div class="muted">生成失败：${escapeHtml(r.error ?? "未知错误")}</div>`;
        return;
      }
      imgBox.innerHTML = `<img src="${escapeHtml(r.url)}" alt="测试图" class="ig-test-pic" data-lb="${escapeHtml(r.url)}">
        <div class="muted ig-test-meta">${r.width}×${r.height}</div>`;
      setStatus("#ig-test-status", `✓ 出图成功（${r.width}×${r.height}）`, true);
    } catch (e) {
      setStatus("#ig-test-status", "失败：" + e.message, false);
      imgBox.innerHTML = `<div class="muted">生成失败：${escapeHtml(e.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
  // 眼睛：在「点号占位」与「已保存的密钥原文」之间切换（与文本 API 配置同一做法）
  $("#ig-nai-key-eye").addEventListener("click", async () => {
    const input = $("#ig-nai-key");
    if (!input) return;
    if (imgState.keyRevealed) {
      input.value = imgState.originalKey ? PV_KEY_DOTS : "";
      imgState.keyRevealed = false;
      return;
    }
    if (!imgState.originalKey) {
      // 还没保存过密钥（或刚清空）：先问后端要一次真实值
      try {
        const r = await api.get("/api/image/reveal-key");
        if (r.key) imgState.originalKey = r.key;
      } catch { /* 取不到就当没有 */ }
    }
    if (!imgState.originalKey || imgState.originalKey === PV_KEY_DOTS) {
      input.value = "";
      imgState.keyRevealed = true; // 允许直接输入
      input.focus();
      return;
    }
    input.value = imgState.originalKey;
    imgState.keyRevealed = true;
  });
  // 手输密钥后同步缓存，避免下一次点眼睛又去后端取（也避免把点号当原文）
  $("#ig-nai-key").addEventListener("input", () => {
    const v = $("#ig-nai-key").value.trim();
    if (v && v !== PV_KEY_DOTS) { imgState.originalKey = v; imgState.keyRevealed = true; }
  });
  $("#ig-artist-add").addEventListener("click", () => openArtistEdit(null));
  $("#ig-artist-cancel").addEventListener("click", closeArtistEdit);
  $("#ig-artist-del").addEventListener("click", () => {
    if (artistEditing === null) return;
    deleteArtist(artistEditing);
  });
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
  try {
    // 走缓存先填表单（公网上省掉一次 0.5-1.7s 往返）。后台刷新只更新缓存，
    // 不回填正在编辑的表单（否则会覆盖用户没保存的输入）。
    const cfg = await cachedGet("/api/image/config");
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
        <img src="${it.url}" alt="${escapeHtml(it.file)}" loading="lazy" data-lb="${escapeHtml(it.url)}" style="cursor:zoom-in">
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
// data-lb 委托：替代内联 onclick 拼接 URL（URL 含引号时会炸）
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-lb]");
  if (t) showLightbox(t.dataset.lb);
});

function initProvidersPage(type) {
  // 不整体重置：provState.list 是列表的内存缓存，保留它返回列表页才能立刻渲染（不闪、不重载）
  provState.type = type;
  provState.editing = null;
  provState.allModels = [];
  provState.selected = [];
  $("#prov-add").addEventListener("click", () => { location.hash = "#/apiprovider"; });
  loadProvList();
}

async function loadProvList() {
  const box = $("#prov-list");
  if (!box) return;
  // 先用手上的数据立刻画（内存缓存 → 返回列表页零等待、不闪）；没有才显示加载中
  if (provState.list) paintProvList();
  else box.innerHTML = '<div class="card-box muted">加载中…</div>';
  try {
    const data = await cachedGet("/api/providers", (fresh) => {
      const next = provState.type === "chat" ? fresh.chat : fresh.image;
      // 只有数据真的变了才重绘，避免返回列表时无谓闪动
      if (JSON.stringify(next) !== JSON.stringify(provState.list)) {
        provState.list = next;
        if ($("#prov-list")) paintProvList();
      }
    });
    const list = provState.type === "chat" ? data.chat : data.image;
    if (JSON.stringify(list) !== JSON.stringify(provState.list)) {
      provState.list = list;
      paintProvList();
    }
  } catch (e) {
    if (!provState.list) box.innerHTML = `<div class="card-box muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

function paintProvList() {
  const box = $("#prov-list");
  if (!box) return;
  const list = provState.list ?? [];
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
    // 停用只表现为名称变灰划线（不加「已停用」文字）；启用/停用与设为默认都收进编辑页
    d.innerHTML = `
      <div class="prov-head">
        ${providerAvatarHTML(p.name)}
        <b>${escapeHtml(p.name)}</b>
        ${isDefault ? '<span class="chip ok">默认</span>' : ""}
        <span class="prov-btns">
          <button class="ghost small-btn" data-act="edit" data-name="${escapeHtml(p.name)}">编辑</button>
          <button class="danger small-btn" data-act="del" data-name="${escapeHtml(p.name)}">删除</button>
        </span>
      </div>`;
    box.appendChild(d);
  });
  box.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      const name = b.dataset.name;
      if (b.dataset.act === "edit") location.hash = `#/apiprovider?name=${encodeURIComponent(name)}`;
      else if (b.dataset.act === "del") {
        if (!confirm(`删除提供商 ${name}？`)) return;
        await api.send("/api/providers/delete", { method: "POST", body: JSON.stringify({ type: provState.type, name }) });
        await refreshProvCache();
        paintProvList();
      }
    })
  );
}

/**
 * 写操作（保存/拉取/设为默认/停用）后主动刷新内存与接口缓存：
 * 这样返回列表页时直接用手上的数据立刻渲染，不再重新请求等待（公网 0.5-1.7s 的"大刷新"）。
 */
async function refreshProvCache() {
  try {
    const data = await api.get("/api/providers");
    apiCache.set("/api/providers", { data, ts: Date.now(), inflight: null });
    provState.list = provState.type === "chat" ? data.chat : data.image;
  } catch { /* 取不到就交给下次进入页面时的正常加载 */ }
}

// ============================================================
//  视图：语音合成 TTS（独立页：默认通道/本地兜底 + 提供商管理，同 API 页添加模式）
// ============================================================
const TTS_PRESETS = [
  { kind: "openai", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B", voice: "FunAudioLLM/CosyVoice2-0.5B:alex", speed: 1, label: "OpenAI 兼容" },
  { kind: "openai", name: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "alloy", speed: 1, label: "OpenAI 兼容", models: ["gpt-4o-mini-tts", "gpt-4o-tts", "tts-1", "tts-1-hd"], voices: [{ id: "alloy", label: "Alloy" }, { id: "echo", label: "Echo" }, { id: "fable", label: "Fable" }, { id: "onyx", label: "Onyx" }, { id: "nova", label: "Nova" }, { id: "shimmer", label: "Shimmer" }] },
  { kind: "openai", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash-preview-tts", voice: "Kore", speed: 1, label: "OpenAI 兼容", models: ["gemini-2.5-flash-preview-tts", "gemini-2.0-flash-tts"] },
  { kind: "openai", name: "通义 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-audio-3.0-tts-flash", voice: "longanhuan_v3.6", speed: 1, label: "OpenAI 兼容", models: ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus"], voices: [{ id: "longanfengyue", label: "longanfengyue" }, { id: "longanyuanfei", label: "longanyuanfei" }, { id: "longanlingxi", label: "longanlingxi" }, { id: "longanxiaoxin", label: "longanxiaoxin" }, { id: "longanhuan_v3.6", label: "longanhuan_v3.6" }, { id: "longjielidou_v3.6", label: "longjielidou_v3.6" }, { id: "longpaopao_v3.6", label: "longpaopao_v3.6" }, { id: "longhuohuo_v3.6", label: "longhuohuo_v3.6" }, { id: "longchuanshu_v3.6", label: "longchuanshu_v3.6" }, { id: "loongmary", label: "loongmary" }, { id: "loongeva_v3.6", label: "loongeva_v3.6" }, { id: "loongjohn", label: "loongjohn" }, { id: "longanlingxin", label: "longanlingxin" }, { id: "longanlufeng", label: "longanlufeng" }] },
  { kind: "openai", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "canopylabs/orpheus-v1-english", voice: "austin", speed: 1, label: "OpenAI 兼容", voices: [{ id: "austin", label: "Austin" }, { id: "natalie", label: "Natalie" }, { id: "kailin", label: "Kailin" }] },
  { kind: "openai", name: "xAI", baseUrl: "https://api.x.ai/v1", model: "", voice: "eve", speed: 1, label: "OpenAI 兼容", voices: [{ id: "eve", label: "Eve" }, { id: "ara", label: "Ara" }, { id: "rex", label: "Rex" }, { id: "sal", label: "Sal" }, { id: "leo", label: "Leo" }] },
  { kind: "openai", name: "阶跃 Step", baseUrl: "https://api.stepfun.com/v1", model: "step-tts-mini", voice: "elegantgentle-female", speed: 1, label: "OpenAI 兼容", models: ["step-tts-mini", "step-tts-vivid", "stepaudio-2.5-tts", "step-tts-2"], voices: [{ id: "elegantgentle-female", label: "气质温婉" }, { id: "livelybreezy-female", label: "活力轻快" }, { id: "energeticconfident-female", label: "活力自信" }, { id: "jingdiannvsheng", label: "经典女声" }, { id: "wenroushunv", label: "温柔熟女" }, { id: "tianmeinvsheng", label: "甜美女声" }, { id: "qingchunshaonv", label: "清纯少女" }, { id: "wenrounvsheng", label: "温柔女声" }, { id: "ruanmengnvsheng", label: "软萌女生" }, { id: "youyanvsheng", label: "优雅女生" }, { id: "lengyanyujie", label: "冷艳御姐" }, { id: "shuangkuaijiejie", label: "爽快姐姐" }, { id: "wenjingxuejie", label: "文静学姐" }, { id: "linjiajiejie", label: "邻家姐姐" }, { id: "linjiameimei", label: "邻家妹妹" }, { id: "zhixingjiejie", label: "知性姐姐" }, { id: "cixingnansheng", label: "磁性男声" }, { id: "wenrounansheng", label: "温柔男声" }, { id: "yuanqinansheng", label: "元气男声" }, { id: "zhengpaiqingnian", label: "正派青年" }, { id: "ruyananshi", label: "儒雅男士" }, { id: "boyinnansheng", label: "播音男声" }] },
  { kind: "minimax", name: "MiniMax 海螺", baseUrl: "https://api.minimaxi.com/v1", model: "speech-2.6-turbo", voice: "female-shaonv", speed: 1, label: "MiniMax 海螺（t2a_v2）", voices: [{ id: "male-qn-qingse", label: "青涩青年（男）" }, { id: "male-qn-jingying", label: "精英青年（男）" }, { id: "male-qn-badao", label: "霸道青年（男）" }, { id: "male-qn-daxuesheng", label: "大学生（男）" }, { id: "female-shaonv", label: "少女" }, { id: "female-yujie", label: "御姐" }, { id: "female-chengshu", label: "成熟女声" }, { id: "female-tianmei", label: "甜美女声" }, { id: "audiobook_male_1", label: "有声书男 1" }, { id: "audiobook_female_1", label: "有声书女 1" }, { id: "cartoon_pig", label: "卡通小猪" }] },
  { kind: "volc", name: "火山豆包", baseUrl: "https://openspeech.bytedance.com/api/v3/tts/unidirectional", model: "seed-tts-2.0", voice: "zh_female_qingxin_mars_bigtts", speed: 1, label: "火山豆包（openspeech V3）" },
  { kind: "mimo", name: "小米 MiMo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default", speed: 1, label: "小米 MiMo（SSE 流式）", models: ["mimo-v2.5-tts", "mimo-v2-tts"], voices: [{ id: "mimo_default", label: "默认" }, { id: "冰糖", label: "冰糖" }, { id: "茉莉", label: "茉莉" }, { id: "苏打", label: "苏打" }, { id: "白桦", label: "白桦" }, { id: "Mia", label: "Mia" }, { id: "Chloe", label: "Chloe" }, { id: "Milo", label: "Milo" }, { id: "Dean", label: "Dean" }] },
  { kind: "elevenlabs", name: "ElevenLabs", baseUrl: "https://api.elevenlabs.io/v1", model: "eleven_multilingual_v2", voice: "JBFqnCBsd6RMkjVDRZzb", speed: 1, label: "ElevenLabs", models: ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5"] },
  { kind: "fishaudio", name: "Fish Audio", baseUrl: "https://api.fish.audio/v1", model: "s2.1-pro", voice: "", speed: 1, label: "Fish Audio", models: ["s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"] },
  { kind: "openai", name: "", baseUrl: "", model: "", voice: "", speed: 1, label: "自定义 OpenAI 兼容" },
];
const TTS_KIND_LABEL = {
  openai: "OpenAI 兼容", minimax: "MiniMax 海螺（t2a_v2）", volc: "火山豆包（openspeech V3）",
  mimo: "小米 MiMo", elevenlabs: "ElevenLabs", fishaudio: "Fish Audio",
};

function renderTtsPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>语音合成</h2></div>

    <div class="card-box">
      <h3>TTS 通道</h3>
      <div id="tts-prov-list"><div class="muted">加载中…</div></div>
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
            <div><label>名称</label><input id="tts-pv-name" placeholder="如 硅基流动"></div>
          </div>
          <div class="cf-grid2">
            <div><label>Base URL</label><input id="tts-pv-url" placeholder="OpenAI 兼容以 /v1 结尾；豆包填完整接口地址"></div>
            <div><label>API Key（编辑留空=保留）</label><input id="tts-pv-key" type="password"></div>
          </div>
          <div class="cf-grid2" id="tts-pv-appid-wrap" style="display:none">
            <div><label>App ID（仅火山豆包旧版鉴权）</label><input id="tts-pv-appid" placeholder="豆包新版单 Key 鉴权留空"></div>
            <div></div>
          </div>
          <div class="cf-grid2">
            <div>
              <label>模型</label><input id="tts-pv-model" placeholder="选服务商自动填入，可手改">
            </div>
            <div>
              <label>音色</label>
              <div class="tts-combo">
                <input id="tts-pv-voice" placeholder="点右侧箭头选官方音色，或手输">
                <button type="button" class="tts-combo-btn" id="tts-pv-voice-btn" title="官方音色列表">▾</button>
                <div class="tts-combo-menu" id="tts-pv-voice-menu" style="display:none"></div>
              </div>
            </div>
          </div>
          <div class="cf-grid">
            <div><label>语速 (0.25~4)</label><input id="tts-pv-speed" type="number" step="0.1" value="1"></div>
            <div></div><div></div>
          </div>
          <div class="row">
            <button id="tts-pv-save" class="primary">保存</button>
            <button id="tts-pv-fetch" class="ghost">拉取</button>
            <button id="tts-pv-cancel" class="ghost">取消</button>
          </div>
          <div id="tts-pv-msg" class="status"></div>
        </div>
      </div>
    </div>

    <div class="card-box" id="tts-local-box" style="display:none">
      <h3>本地语音设置</h3>
      <div class="form">
        <div class="cf-grid">
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
          <button id="tts-save-local" class="primary">保存本地设置</button>
          <button id="tts-test-local" class="ghost">测试本地</button>
        </div>
      </div>
    </div>
  </div>`;
}

let ttsState = { providers: [], commonVoices: [], editingId: null, models: [], voices: [], editKind: "openai", defProvider: "local", localEngine: "edge", localVoice: "" };

async function initTtsPage() {
  ttsState = { providers: [], commonVoices: [], editingId: null, models: [], voices: [], editKind: "openai", defProvider: "local", localEngine: "edge", localVoice: "" };
  $("#tts-save-local").addEventListener("click", saveTtsLocal);
  $("#tts-test-local").addEventListener("click", () => testTtsTarget("local"));
  $("#tts-prov-add").addEventListener("click", () => showTtsProvForm(null));
  $("#tts-pv-cancel").addEventListener("click", () => ($("#tts-prov-form").style.display = "none"));
  $("#tts-pv-preset").addEventListener("change", ttsApplyPreset);
  $("#tts-pv-save").addEventListener("click", saveTtsProvider);
  $("#tts-pv-fetch").addEventListener("click", ttsProvFetch);
  // 音色 combo：右侧箭头弹出官方音色列表，点选填入；点外部关闭
  $("#tts-pv-voice-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#tts-pv-voice-menu");
    const open = menu.style.display !== "none";
    document.querySelectorAll(".tts-combo-menu").forEach((m) => (m.style.display = "none"));
    if (!open) renderTtsVoiceMenu();
    menu.style.display = open ? "none" : "block";
  });
  // 音色 combo：右侧箭头弹出官方音色列表，点选填入；点外部关闭（document 监听只绑一次，防多次进出页面叠加）
  if (!window.__ttsComboDocBound) {
    window.__ttsComboDocBound = true;
    document.addEventListener("click", (e) => {
      if (!e.target.closest?.(".tts-combo")) {
        document.querySelectorAll(".tts-combo-menu").forEach((m) => (m.style.display = "none"));
      }
    });
  }
  await loadTtsConfig();
}

async function loadTtsConfig() {
  try {
    // 走缓存先渲染（公网上省掉一次往返）。后台刷新拿到新数据时只更新缓存，
    // 不在回调里再调本函数（会递归），下次进页面自然用到新值。
    const cfg = await cachedGet("/api/tts/config");
    ttsState.providers = cfg.providers || [];
    ttsState.commonVoices = cfg.commonVoices || [];
    ttsState.defProvider = cfg.defaultProvider || "local";
    ttsState.localEngine = cfg.local?.engine || "edge";
    ttsState.localVoice = cfg.local?.voice || "";
    $("#tts-local-engine").value = cfg.local?.engine || "edge";
    const vSel = $("#tts-local-voice");
    vSel.innerHTML = (cfg.commonVoices || []).map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`).join("");
    vSel.value = cfg.local?.voice || "";
    $("#tts-local-rate").value = cfg.local?.rate || "+0%";
    $("#tts-local-pitch").value = cfg.local?.pitch || "+0Hz";
    renderTtsProviders();
  } catch (e) {
    $("#tts-prov-list").innerHTML = `<div class="card-box muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

function ttsKindTag(kind) {
  return TTS_KIND_LABEL[kind] || "OpenAI 兼容";
}

/** 单选列表：本地条目固定最前，其余是各提供商；radio 选中 = 当前生效通道（同一时间只开一个） */
function renderTtsProviders() {
  const box = $("#tts-prov-list");
  if (!box) return;
  const cur = ttsState.defProvider ?? "local";
  const rows = [];

  // 本地条目（Edge/SAPI 也算一个可选项，编辑/试听与普通提供商一致）
  // 分发用户不列它：本地兜底只给管理员/单用户版（后端也拒绝为设备合成，见 localTtsAllowed）
  if (!ocIsDevice()) {
    rows.push(ttsRowHtml({
      id: "local",
      name: "本地（" + (ttsState.localEngine === "sapi" ? "Windows SAPI 离线" : "Edge 在线免费") + "）",
      kind: "local",
      selected: cur === "local",
    }));
  }

  (ttsState.providers || []).forEach((p) => {
    rows.push(ttsRowHtml({
      id: p.id,
      name: p.name,
      kind: p.kind,
      selected: cur === p.id,
    }));
  });

  if (!rows.length) box.innerHTML = '<div class="card-box muted">还没有 TTS 提供商，点下方按钮添加（如 硅基流动）</div>';
  else box.innerHTML = rows.join("");

  // 事件：最右「使用」小按键 = 切换当前通道；按钮：试听/编辑/删除/本地编辑
  box.querySelectorAll("[data-tts-use]").forEach((b) =>
    b.addEventListener("click", async () => {
      const target = b.dataset.ttsUse;
      await saveTtsConfigOnly({ defaultProvider: target });
      ttsState.defProvider = target;
      toast(target === "local" ? "✓ 当前通道：本地" : "✓ 当前通道已切换");
      renderTtsProviders();
    })
  );
  box.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "test") testTtsTarget(b.dataset.target);
      else if (act === "edit") {
        if (b.dataset.target === "local") {
          $("#tts-local-box").style.display = "block";
          $("#tts-local-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          const p = ttsState.providers.find((x) => x.id === b.dataset.target);
          if (p) showTtsProvForm(p);
        }
      } else if (act === "del") {
        const p = ttsState.providers.find((x) => x.id === b.dataset.target);
        if (!p || !confirm(`删除提供商「${p.name}」？`)) return;
        await api.send(`/api/tts/providers/${p.id}`, { method: "DELETE" });
        toast("✓ 已删除");
        loadTtsConfig();
      }
    })
  );
}

function ttsRowHtml({ id, name, kind, selected }) {
  return `<div class="prov-item${selected ? " on" : ""}">
    <div class="prov-head">
      <b>${escapeHtml(name)}</b>
      <span class="chip">${ttsKindTag(kind)}</span>
      <span class="prov-btns">
        <button type="button" class="ghost small-btn" data-act="test" data-target="${escapeHtml(id)}">试听</button>
        <button type="button" class="ghost small-btn" data-act="edit" data-target="${escapeHtml(id)}">编辑</button>
        ${kind !== "local" ? `<button type="button" class="danger small-btn" data-act="del" data-target="${escapeHtml(id)}">删除</button>` : ""}
        <button type="button" class="tts-use-btn${selected ? " on" : ""}" data-tts-use="${escapeHtml(id)}" title="设为当前通道"></button>
      </span>
    </div>
    <div class="tts-player" data-player="${escapeHtml(id)}" style="display:none"></div>
  </div>`;
}

/** 试听：合成后出播放器（不自动播），可停止；学 rikkahub 的喇叭但用可控播放器形式 */
async function testTtsTarget(target) {
  const player = document.querySelector(`[data-player="${CSS.escape(target)}"]`);
  const msgEl = player?.previousElementSibling;
  if (player) {
    player.style.display = "block";
    player.innerHTML = '<span class="status">合成中…</span>';
  }
  try {
    const r = await api.send("/api/tts/test", { method: "POST", body: JSON.stringify({ target }) });
    if (!player) { toast(r.ok ? r.info : r.info, r.ok); return; }
    if (!r.ok) {
      player.innerHTML = `<span class="status err">合成失败：${escapeHtml(r.info)}</span>`;
      return;
    }
    player.innerHTML =
      `<span class="status ok">${escapeHtml(r.info)}</span>
       <audio controls preload="metadata" style="width:100%;margin-top:6px"><source src="${r.dataUrl}" type="audio/mpeg">你的浏览器不支持播放</audio>`;
  } catch (e) {
    if (player) player.innerHTML = `<span class="status err">测试失败：${escapeHtml(e.message)}</span>`;
    else toast("测试失败：" + e.message, false);
  }
}

async function saveTtsLocal() {
  try {
    await saveTtsConfigOnly({
      local: {
        engine: $("#tts-local-engine").value,
        voice: $("#tts-local-voice").value,
        rate: $("#tts-local-rate").value,
        pitch: $("#tts-local-pitch").value,
      },
    });
    toast("✓ 本地设置已保存");
    loadTtsConfig();
  } catch (e) { toast("保存失败：" + e.message, false); }
}

async function saveTtsConfigOnly(body) {
  cacheInvalidate("/api/tts/config"); // 所有 TTS 写操作的统一出口，改完让缓存失效
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
  // 服务商预设回显：编辑时 kind 匹配就选中（预填官方模型/音色），否则归「自定义」
  if (p) {
    const idx = TTS_PRESETS.findIndex((x) => x.kind === p.kind && x.baseUrl && x.baseUrl === p.baseUrl);
    $("#tts-pv-preset").value = idx >= 0 ? String(idx) : String(TTS_PRESETS.length - 1);
  } else {
    $("#tts-pv-preset").value = "";
  }
  $("#tts-pv-msg").textContent = "";
  $("#tts-pv-appid-wrap").style.display = ttsFormKind() === "volc" ? "" : "none"; // App ID 只豆包显示
  $("#tts-pv-voice-menu").style.display = "none";
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
    enabled: true, // 单选机制：保存后一律启用，defaultProvider 由列表单选控制
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
  $("#tts-pv-model").value = p.model || "";
  $("#tts-pv-voice").value = p.voice || "";
  $("#tts-pv-speed").value = p.speed ?? 1;
  $("#tts-pv-key").value = "";
  $("#tts-pv-appid").value = "";
  $("#tts-pv-msg").textContent = "";
  $("#tts-pv-appid-wrap").style.display = p.kind === "volc" ? "" : "none"; // App ID 只豆包显示
  // 官方音色列表进下拉菜单（输入框右侧箭头点开可选，也可手输）
  ttsState.voices = p.voices || (p.voice ? [{ id: p.voice, label: p.voice }] : []);
  $("#tts-pv-voice-menu").style.display = "none";
}

// 拉取官方模型/音色（openai 兼容走 /models；其他走内置预置）
async function ttsProvFetch() {
  const body = ttsFormBody();
  if (!body.baseUrl) { toast("Base URL 必填", false); return; }
  $("#tts-pv-msg").textContent = "拉取中…";
  try {
    const fr = await api.send("/api/tts/fetch-models", {
      method: "POST",
      body: JSON.stringify({ id: body.id, kind: body.kind, baseUrl: body.baseUrl, key: body.key || undefined }),
    });
    ttsState.models = fr.models || [];
    ttsState.voices = fr.voices || [];
    $("#tts-pv-msg").textContent = `✓ 拉取到 ${ttsState.models.length} 个模型${ttsState.voices.length ? `、${ttsState.voices.length} 个音色` : ""}。模型可直接填在「模型」框，音色点右侧箭头选择`;
    renderTtsVoiceMenu();
  } catch (e) {
    $("#tts-pv-msg").textContent = "拉取失败：" + e.message + "——可手动填写「模型/音色」后保存";
  }
}

/** 填充音色下拉菜单（输入框右侧箭头点开）；items 可为字符串数组或 {id,label} 数组 */
function renderTtsVoiceMenu() {
  const menu = $("#tts-pv-voice-menu");
  if (!menu) return;
  const items = ttsState.voices || [];
  if (!items.length) {
    menu.innerHTML = '<div class="tts-combo-empty">（暂无官方音色列表，手动填写上方输入框）</div>';
    return;
  }
  menu.innerHTML = "";
  items.forEach((m) => {
    const id = typeof m === "string" ? m : m.id;
    const label = typeof m === "string" ? m : m.label;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tts-combo-item";
    item.textContent = label && label !== id ? `${label} · ${id}` : id;
    item.addEventListener("click", () => {
      $("#tts-pv-voice").value = id;
      menu.style.display = "none";
    });
    menu.appendChild(item);
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



// ============================================================
//  视图：API 提供商编辑二级页（#/apiprovider?name=…，name 空 = 新增）
//  - 右上角 ✕ 关闭（不保存）；密钥用 •••• 占位，眼睛查看原文，点「保存」才更改
//  - 模型选取从底部弹上来（bottom sheet）：搜索 + 滚动框，长名称可在行内左右滑看全貌
//  - 不再自动把拉取列表的第一个设为默认：勾选的第一个模型才是该提供商的默认模型
// ============================================================
const PV_KEY_DOTS = "••••••••";
let pveState = { type: "chat", name: "", originalKey: "", keyRevealed: false, allModels: [], selected: [] };

function renderProviderEdit() {
  return `
  <div class="view pv-edit-page">
    <div class="page-head pv-edit-head">
      <h2 id="pve-title">编辑提供商</h2>
      <button id="pve-close" class="pv-close-btn" title="关闭（不保存）">✕</button>
    </div>
    <div class="card-box">
      <div class="form">
        <label>名称（≤32 字）</label>
        <input id="pve-name" placeholder="如 agnes / myrelay / 硅基流动">
        <label style="margin-top:10px">Base URL（以 /v1 结尾）</label>
        <input id="pve-url" placeholder="https://api.example.com/v1">
        <label style="margin-top:10px">API Key</label>
        <div class="pv-key-row">
          <input id="pve-key" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false">
          <button type="button" id="pve-key-eye" class="pv-eye-btn" title="显示 / 隐藏密钥">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <p class="hint">已保存的密钥用 ${PV_KEY_DOTS} 显示；点右边的眼睛查看原文。只有点「保存」后密钥才会更改。</p>
        <div class="row" style="margin-top:12px">
          <button id="pve-fetch" class="primary">保存并拉取模型</button>
          <button id="pve-pick" class="ghost">选择模型（<span id="pve-count">0</span>）</button>
        </div>
        <div id="pve-msg" class="status"></div>
      </div>
    </div>
    <button id="pve-save" class="primary">${icon("save")} 保存</button>

    <!-- 提供商级操作（编辑已有提供商时显示）：设为默认 / 停用·启用 -->
    <div class="card-box pve-actions" id="pve-actions" hidden>
      <div class="pve-action-row">
        <div class="pve-action-text">
          <b>设为默认</b>
          <span class="hint" id="pve-default-hint">卡片未单独指定模型时使用这个提供商</span>
        </div>
        <button id="pve-set-default" class="ghost small-btn">设为默认</button>
      </div>
      <div class="pve-action-row">
        <div class="pve-action-text">
          <b id="pve-toggle-title">停用</b>
          <span class="hint" id="pve-toggle-hint">停用后不参与聊天与解析，配置保留</span>
        </div>
        <button id="pve-toggle" class="ghost small-btn">停用</button>
      </div>
    </div>

    <div class="pv-sheet-ov" id="pve-sheet-ov" hidden>
      <div class="pv-sheet">
        <div class="pv-sheet-head">
          <b>选择模型</b>
          <span class="hint" style="flex:1">勾选的第一个 = 该提供商的默认模型</span>
          <button id="pve-sheet-close" class="pv-close-btn" title="收起">✕</button>
        </div>
        <input id="pve-model-search" type="text" placeholder="搜索模型…">
        <div id="pve-model-list" class="pv-model-list"></div>
        <div class="pv-sheet-foot">
          <button id="pve-sheet-done" class="primary">完成</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function initProviderEdit() {
  const m = (location.hash || "").match(/[?&]name=([^&]+)/);
  pveState = {
    type: "chat",
    name: m ? decodeURIComponent(m[1]) : "",
    originalKey: "",
    keyRevealed: false,
    allModels: [],
    selected: [],
  };
  const editing = Boolean(pveState.name);
  $("#pve-title").textContent = editing ? `编辑 ${pveState.name}` : "添加提供商";
  $("#pve-name").value = pveState.name; // 编辑态回填名称（collect 要用到）
  $("#pve-name").disabled = editing;
  const updateCount = () => { const el = $("#pve-count"); if (el) el.textContent = String(pveState.selected.length); };

  // 关闭（不保存）→ 回列表
  $("#pve-close").addEventListener("click", () => { location.hash = "#/api"; });

  // 眼睛：在「隐藏（占位符）」与「显示已保存原文」之间切换；没保存过就提示直接输入
  $("#pve-key-eye").addEventListener("click", async () => {
    const input = $("#pve-key");
    if (pveState.keyRevealed) {
      input.value = pveState.originalKey ? PV_KEY_DOTS : "";
      pveState.keyRevealed = false;
      return;
    }
    if (editing && !pveState.originalKey) {
      try {
        const r = await api.get(`/api/providers/reveal-key?type=${pveState.type}&name=${encodeURIComponent(pveState.name)}`);
        pveState.originalKey = r.apiKey ?? "";
      } catch { /* 取不到就当没有 */ }
    }
    if (!pveState.originalKey) { toast("还没保存过密钥，直接输入即可", false); return; }
    input.value = pveState.originalKey;
    pveState.keyRevealed = true;
  });

  // 收集表单：占位符（没动）或空 = 不传 apiKey（后端沿用原值）；只有真实输入才会更改密钥
  const collect = () => ({
    type: pveState.type,
    name: $("#pve-name").value.trim(),
    baseUrl: $("#pve-url").value.trim(),
    apiKey: (() => { const v = $("#pve-key").value.trim(); return v && v !== PV_KEY_DOTS ? v : undefined; })(),
    models: [...pveState.selected],
  });

  const openSheet = () => {
    $("#pve-sheet-ov").hidden = false;
    renderPveModelList();
  };

  // 保存并拉取模型：先保存，再拉取，然后弹模型选取
  $("#pve-fetch").addEventListener("click", async () => {
    const f = collect();
    if (!f.name) return toast("请填名称", false);
    if (!f.baseUrl) return toast("请填 Base URL", false);
    $("#pve-msg").textContent = "保存中，随后拉取模型…";
    try {
      await api.send("/api/providers/save", { method: "POST", body: JSON.stringify({ ...f, models: undefined }) });
      const r = await api.send("/api/providers/fetch-models", { method: "POST", body: JSON.stringify({ type: pveState.type, name: f.name }) });
      pveState.allModels = r.models ?? [];
      // 已勾选的模型若不在新列表里（上游下架/改名）则剔除
      pveState.selected = pveState.selected.filter((x) => pveState.allModels.includes(x));
      await refreshProvCache(); // 主动回填缓存：返回列表页零等待、不重新加载
      $("#pve-msg").textContent = `✓ 拉取到 ${pveState.allModels.length} 个模型`;
      updateCount();
      openSheet();
    } catch (e) {
      $("#pve-msg").textContent = "失败：" + e.message;
    }
  });

  // 手动打开模型选取（不重新拉取）
  $("#pve-pick").addEventListener("click", openSheet);

  // 搜索过滤
  $("#pve-model-search").addEventListener("input", () => renderPveModelList());
  $("#pve-sheet-close").addEventListener("click", () => { $("#pve-sheet-ov").hidden = true; });
  $("#pve-sheet-done").addEventListener("click", () => { $("#pve-sheet-ov").hidden = true; });
  $("#pve-sheet-ov").addEventListener("click", (e) => { if (e.target === $("#pve-sheet-ov")) $("#pve-sheet-ov").hidden = true; });

  // 保存 → 回列表
  $("#pve-save").addEventListener("click", async () => {
    const f = collect();
    if (!f.name) return toast("请填名称", false);
    if (!f.baseUrl) return toast("请填 Base URL", false);
    if (!f.models.length) return toast("请至少勾选一个模型（勾选的第一个为该提供商的默认模型）", false);
    try {
      await api.send("/api/providers/save", { method: "POST", body: JSON.stringify(f) });
      await refreshProvCache(); // 主动回填缓存：返回列表页零等待、不重新加载
      toast("✓ 已保存");
      location.hash = "#/api";
    } catch (e) { toast("保存失败：" + e.message, false); }
  });

  // 填充编辑数据
  if (editing) {
    const data = await api.get("/api/providers").catch(() => null);
    const p = data?.chat?.find((x) => x.name === pveState.name);
    if (!p) { toast("找不到该提供商", false); location.hash = "#/api"; return; }
    $("#pve-url").value = p.baseUrl ?? "";
    if (p.apiKey) $("#pve-key").value = PV_KEY_DOTS; // 圆点占位 = 已填写（真实值在服务端，眼睛可查）
    pveState.selected = [...(p.models ?? [])];
    pveState.allModels = [...(p.models ?? [])];
    updateCount();

    // 提供商级操作：设为默认 / 停用·启用（立即生效，不等保存）
    const list = data.chat ?? [];
    const isDefault = list.find((x) => x.enabled !== false)?.name === pveState.name;
    const off = p.enabled === false;
    $("#pve-actions").hidden = false;
    const setDefaultBtn = $("#pve-set-default");
    setDefaultBtn.disabled = isDefault;
    setDefaultBtn.textContent = isDefault ? "已是默认" : "设为默认";
    $("#pve-default-hint").textContent = isDefault
      ? "当前就是默认提供商（卡片未单独指定模型时用它）"
      : "卡片未单独指定模型时使用这个提供商";
    const toggleBtn = $("#pve-toggle");
    let stopped = off; // 跟随实际状态（点击后翻转），不能用初始快照判断
    const paintToggle = (s) => {
      $("#pve-toggle-title").textContent = s ? "启用" : "停用";
      $("#pve-toggle-hint").textContent = s ? "当前已停用：不参与聊天与解析，配置保留" : "停用后不参与聊天与解析，配置保留";
      toggleBtn.textContent = s ? "启用" : "停用";
      toggleBtn.classList.toggle("primary", s);
      toggleBtn.classList.toggle("ghost", !s);
    };
    paintToggle(stopped);

    setDefaultBtn.addEventListener("click", async () => {
      try {
        await api.send("/api/providers/set-default", { method: "POST", body: JSON.stringify({ type: pveState.type, name: pveState.name }) });
        await refreshProvCache();
        setDefaultBtn.disabled = true;
        setDefaultBtn.textContent = "已是默认";
        $("#pve-default-hint").textContent = "当前就是默认提供商（卡片未单独指定模型时用它）";
        toast("✓ 已设为默认");
      } catch (e) { toast("操作失败：" + e.message, false); }
    });
    toggleBtn.addEventListener("click", async () => {
      const turnOn = stopped; // 停用中点 = 启用
      try {
        await api.send("/api/providers/toggle", { method: "POST", body: JSON.stringify({ type: pveState.type, name: pveState.name, enabled: turnOn }) });
        await refreshProvCache();
        stopped = !turnOn;
        paintToggle(stopped);
        toast(turnOn ? `✓ 已启用 ${pveState.name}` : `已停用 ${pveState.name}（配置保留）`);
      } catch (e) { toast("操作失败：" + e.message, false); }
    });
  }
}

function renderPveModelList() {
  const box = $("#pve-model-list");
  if (!box) return;
  const q = ($("#pve-model-search")?.value ?? "").trim().toLowerCase();
  const list = q ? pveState.allModels.filter((mm) => mm.toLowerCase().includes(q)) : pveState.allModels;
  box.innerHTML = list.length ? "" : '<div class="muted" style="padding:12px">（无匹配模型）</div>';
  for (const mm of list) {
    const idx = pveState.selected.indexOf(mm);
    const row = document.createElement("div");
    row.className = "pv-model-item" + (idx >= 0 ? " on" : "");
    row.innerHTML = `
      <button type="button" class="pv-model-check" aria-label="选择模型">${idx >= 0 ? "✓" : ""}</button>
      <span class="pv-model-name">${escapeHtml(mm)}${idx === 0 ? ' <b class="pv-def-tag">默认</b>' : ""}</span>`;
    // 只有勾选圈触发选择；名称区留给左右滑动看全貌，不误触
    row.querySelector(".pv-model-check").addEventListener("click", () => {
      const i = pveState.selected.indexOf(mm);
      if (i >= 0) pveState.selected.splice(i, 1);
      else pveState.selected.push(mm);
      renderPveModelList();
      const el = $("#pve-count");
      if (el) el.textContent = String(pveState.selected.length);
    });
    box.appendChild(row);
  }
}

// ============================================================
//  视图：通讯录（微信式会话列表）
//  只列「真的聊过」的卡（后端 /api/conversations 已按有无聊天记录过滤），
//  一个长条 = 一个人：头像靠左固定尺寸，右边上行名字+时间、下行最后一句预览。
//  点条目 = 进入该卡的本地聊天；长按/右键 = 置顶或取消置顶。
// ============================================================
function renderChats() {
  return `
  <div class="view">
    <div class="page-head"><h2>通讯录</h2></div>
    <div class="chat-search-wrap">
      <input id="chats-filter" type="text" placeholder="搜索聊天…">
    </div>
    <div id="chats-list" class="chat-list"></div>
  </div>`;
}

let chatsCache = [];

function initChats() {
  const box = $("#chats-list");
  box.innerHTML = '<div class="muted" style="padding:14px">加载中…</div>';
  const draw = (items) => {
    chatsCache = items ?? [];
    paintChatList();
  };
  (async () => {
    try {
      const r = await cachedGet("/api/conversations", (fresh) => draw(fresh.items));
      draw(r.items);
    } catch (e) {
      box.innerHTML = `<div class="muted" style="padding:14px">读取失败：${escapeHtml(e.message)}</div>`;
    }
  })();
  $("#chats-filter").addEventListener("input", paintChatList);
  // 点条目进聊天；长按（触屏 500ms）/ 右键 = 置顶开关
  let pressTimer = null;
  const startPress = (e) => {
    const row = e.target.closest?.(".chat-item");
    if (!row) return;
    pressTimer = setTimeout(() => { pressTimer = null; void toggleChatPin(row.dataset.slug); }, 500);
  };
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  box.addEventListener("touchstart", startPress, { passive: true });
  box.addEventListener("touchend", cancelPress);
  box.addEventListener("touchmove", cancelPress);
  box.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".chat-item");
    if (!row) return;
    e.preventDefault();
    void toggleChatPin(row.dataset.slug);
  });
  box.addEventListener("click", (e) => {
    const pin = e.target.closest(".chat-pin-btn");
    if (pin) { e.stopPropagation(); void toggleChatPin(pin.closest(".chat-item")?.dataset.slug); return; }
    const row = e.target.closest(".chat-item");
    if (row?.dataset.slug) openChatFromList(row.dataset.slug);
  });
}

function paintChatList() {
  const box = $("#chats-list");
  if (!box) return;
  const q = ($("#chats-filter")?.value ?? "").trim().toLowerCase();
  const items = q
    ? chatsCache.filter((c) => c.name.toLowerCase().includes(q) || String(c.last).toLowerCase().includes(q))
    : chatsCache;
  if (!items.length) {
    box.innerHTML = `<div class="muted" style="padding:16px">${
      q ? "没有匹配的聊天" : "还没有聊过天。去卡库选一张卡开始聊，这里就会出现它。"
    }</div>`;
    return;
  }
  box.innerHTML = items
    .map((c) => {
      const initial = escapeHtml(String(c.name || "?").slice(0, 1));
      const av = c.avatar
        ? `<img src="${escapeHtml(c.avatar)}" alt="" loading="lazy">`
        : `<span class="chat-av-txt">${initial}</span>`;
      const who = c.lastRole === "user" ? "我：" : "";
      return `<div class="chat-item${c.pinned ? " pinned" : ""}" data-slug="${escapeHtml(c.slug)}">
        <div class="chat-av">${av}</div>
        <div class="chat-main">
          <div class="chat-line1">
            <span class="chat-name">${escapeHtml(c.name)}</span>
            <span class="chat-time">${escapeHtml(fmtChatTime(c.lastAt))}</span>
          </div>
          <div class="chat-line2">
            <span class="chat-preview">${escapeHtml(who + (c.last || "（无内容）"))}</span>
            ${c.pinned ? '<span class="chat-pin-flag" title="已置顶">置顶</span>' : ""}
          </div>
        </div>
      </div>`;
    })
    .join("");
}

/** 会话列表时间：今天只显时分、昨天显“昨天”、更早显日期（微信口径） */
function fmtChatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

async function toggleChatPin(slug) {
  if (!slug) return;
  const cur = chatsCache.find((c) => c.slug === slug);
  const next = !cur?.pinned;
  try {
    await api.send(`/api/cards/${encodeURIComponent(slug)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned: next }),
    });
    cacheInvalidate("/api/conversations");
    const r = await api.get("/api/conversations");
    chatsCache = r.items ?? [];
    paintChatList();
    toast(next ? "✓ 已置顶" : "已取消置顶");
  } catch (e) { toast("操作失败：" + e.message, false); }
}

/** 从通讯录进入某张卡的本地聊天（聊天页是独立路由 #/chat） */
function openChatFromList(slug) {
  localStorage.setItem("ocs_workbench_slug", slug);
  if ((location.hash || "").replace(/^#\/?/, "").split("?")[0] === "chat") router();
  else location.hash = "#/chat";
}

// ============================================================
//  视图：单卡聊天设置（微信「聊天信息」式）
//  从本地聊天页右上角三个点进来，是**这一个会话**的设置面板：
//  置顶 / 聊天记录查找 / 记忆（跟随这张卡，不再走侧边栏的全局记忆页）/ 一键删除。
//  记忆区复用记忆页那套 DOM id 与函数（loadMemEntries / onMemRowClick 等），
//  所以这里的容器 id 必须与 renderMemory 保持一致。
// ============================================================
let chatSettingsSlug = "";

/** 打开某张卡的聊天设置页（SPA 内跳转，hash 带 slug 便于刷新后仍在这一页） */
function openChatSettings(slug) {
  chatSettingsSlug = slug;
  location.hash = `#/chatinfo?slug=${encodeURIComponent(slug)}`;
}

function renderChatInfo() {
  return `
  <div class="view">
    <div class="page-head ci-head">
      <button id="ci-back" class="ghost small-btn" title="返回聊天">← 返回聊天</button>
      <h2>聊天设置</h2>
    </div>

    <div class="card-box ci-who">
      <div class="ci-av" id="ci-av"></div>
      <div class="ci-who-text">
        <div class="ci-name" id="ci-name">—</div>
        <div class="hint" id="ci-meta"></div>
      </div>
      <button id="ci-open-card" class="ghost small-btn" title="打开这张卡的高级配置">卡片配置</button>
    </div>

    <div class="card-box">
      <div class="ci-row">
        <span class="ci-row-label">置顶聊天</span>
        <label class="switch"><input type="checkbox" id="ci-pin"><span class="slider"></span></label>
      </div>
    </div>

    <div class="card-box">
      <button id="ci-goto-search" class="ghost" style="width:100%">${icon("search")} 查找聊天记录</button>
      <button id="ci-goto-imgsave" class="ghost" style="width:100%;margin-top:8px">${icon("package")} 保存图片到本地</button>
    </div>

    <div class="card-box ci-mem-nav">
      <button id="ci-mem-local" class="ghost">${icon("database")} 本地记忆</button>
      <button id="ci-mem-group" class="ghost">${icon("message")} 群聊记忆</button>
    </div>

    <div class="card-box ci-mem-nav">
      <button id="ci-goto-wb" class="ghost">${icon("book")} 世界书</button>
      <button id="ci-goto-rx" class="ghost">${icon("sliders")} 正则</button>
    </div>

    <button id="ci-wipe" class="danger small-btn ci-wipe-btn">清除所有聊天记录和记忆</button>
  </div>`;
}

function initChatInfo() {
  // slug 来源：hash 参数优先（刷新后仍在这一页），否则用刚才聊天的那张卡
  const m = (location.hash || "").match(/[?&]slug=([^&]+)/);
  const slug = m ? decodeURIComponent(m[1]) : chatSettingsSlug || localStorage.getItem("ocs_workbench_slug") || "";
  chatSettingsSlug = slug;
  if (!slug) {
    $("#ci-name").textContent = "没有选中的聊天";
    return;
  }
  // 返回聊天：回到这张卡的本地聊天页
  $("#ci-back").addEventListener("click", () => openChatFromList(slug));
  $("#ci-open-card").addEventListener("click", async () => {
    const card = await api.get(`/api/cards/${encodeURIComponent(slug)}`).catch(() => null);
    if (!card) return toast("读取卡片失败", false);
    editingCard = card;
    openAdvConfig();
  });
  // 记忆二分 / 世界书 / 正则：都是独立子页（chatinfo 只留导航按键）
  $("#ci-mem-local").addEventListener("click", () => {
    location.hash = `#/chatmem?slug=${encodeURIComponent(slug)}&tab=local`;
  });
  $("#ci-mem-group").addEventListener("click", () => {
    location.hash = `#/chatmem?slug=${encodeURIComponent(slug)}&tab=group`;
  });
  $("#ci-goto-wb").addEventListener("click", () => {
    location.hash = `#/chatwb?slug=${encodeURIComponent(slug)}`;
  });
  $("#ci-goto-rx").addEventListener("click", () => {
    location.hash = `#/chatrx?slug=${encodeURIComponent(slug)}`;
  });
  // 查找聊天记录 → 独立搜索页（搜索框 + 图片/时间筛选，微信式）
  $("#ci-goto-search").addEventListener("click", () => {
    location.hash = `#/chatsearch?slug=${encodeURIComponent(slug)}`;
  });
  // 保存图片 → 批量保存页（拉起这张卡还没存过的图，微信式多选）
  $("#ci-goto-imgsave").addEventListener("click", () => {
    location.hash = `#/imgsave?slug=${encodeURIComponent(slug)}`;
  });
  // 置顶开关
  $("#ci-pin").addEventListener("change", async (e) => {
    const pinned = e.target.checked;
    try {
      await api.send(`/api/cards/${encodeURIComponent(slug)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
      cacheInvalidate("/api/conversations");
      toast(pinned ? "✓ 已置顶" : "已取消置顶");
    } catch (err) {
      e.target.checked = !pinned; // 失败回滚开关
      toast("操作失败：" + err.message, false);
    }
  });
  // 一键删除（二次确认）
  $("#ci-wipe").addEventListener("click", () => void ciWipeAll(slug));
  // 填充数据
  (async () => {
    const card = await api.get(`/api/cards/${encodeURIComponent(slug)}`).catch(() => null);
    if (!card) { $("#ci-name").textContent = "卡片不存在"; return; }
    $("#ci-name").textContent = card.name;
    $("#ci-meta").textContent = roleLabel(card.role) || "";
    const av = $("#ci-av");
    const url = card.identity?.avatar || "";
    av.innerHTML = url
      ? `<img src="${escapeHtml(url)}" alt="">`
      : `<span>${escapeHtml(String(card.name || "?").slice(0, 1))}</span>`;
    // 置顶状态从会话列表读（那里是置顶的唯一来源）
    const conv = await cachedGet("/api/conversations").catch(() => ({ items: [] }));
    const hit = (conv.items ?? []).find((c) => c.slug === slug);
    $("#ci-pin").checked = !!hit?.pinned;
  })();
}

/** 聊天记录查找：命中列表点一条 → 回聊天页并定位高亮那条消息 */
// ============================================================
//  视图：聊天记忆页（#/chatmem，从聊天设置两个按键进来）
//  本地记忆：关键记忆（折叠按键）+ 搜索 + 记忆列表；没有总结轮数等配置。
//  群聊记忆：不给看内容，只有群列表 + 整群清除。
// ============================================================
function renderChatMem() {
  return `
  <div class="view">
    <div class="page-head ci-head">
      <button id="cm-back" class="ghost small-btn">← 返回</button>
      <h2 id="cm-title">记忆</h2>
    </div>
    <div class="card-box">
      <div class="row">
        <button id="cm-tab-local" class="ghost">本地记忆</button>
        <button id="cm-tab-group" class="ghost">群聊记忆</button>
      </div>
      <!-- 本地记忆面板 -->
      <div id="cm-local-pane" hidden>
        <button id="cm-key-toggle" class="cm-key-toggle" hidden></button>
        <div id="cm-key-section" class="mem-key-section" hidden>
          <div class="mem-sec-head"><span class="mem-sec-icon">${icon("shield")}</span> 关键记忆（必须遵守）</div>
          <div id="cm-key-entries" class="small-out" style="padding:4px 10px"></div>
        </div>
        <input id="cm-search" type="text" placeholder="搜索记忆…" style="width:100%;margin-top:8px">
        <div id="cm-entries" class="small-out tall" style="max-height:520px;padding:4px 10px"></div>
      </div>
      <!-- 群聊记忆面板 -->
      <div id="cm-group-pane" hidden>
        <p class="hint">群聊记录与单聊/网页完全分开存放，不展示内容，只能整群清除。</p>
        <div id="cm-groups" class="mem-group-list"></div>
      </div>
    </div>
  </div>`;
}

function initChatMem() {
  const m = (location.hash || "").match(/[?&]slug=([^&]+)/);
  const slug = m ? decodeURIComponent(m[1]) : localStorage.getItem("ocs_workbench_slug") || "";
  const tabM = (location.hash || "").match(/[?&]tab=(local|group)/);
  let tab = tabM ? tabM[1] : "local";
  $("#cm-back").addEventListener("click", () => {
    location.hash = slug ? `#/chatinfo?slug=${encodeURIComponent(slug)}` : "#/chats";
  });
  const btnLocal = $("#cm-tab-local");
  const btnGroup = $("#cm-tab-group");
  const localPane = $("#cm-local-pane");
  const groupPane = $("#cm-group-pane");
  let groupLoaded = false;
  const show = async (which) => {
    tab = which;
    localPane.hidden = which !== "local";
    groupPane.hidden = which !== "group";
    btnLocal.classList.toggle("on", which === "local");
    btnGroup.classList.toggle("on", which === "group");
    if (which === "group" && !groupLoaded) {
      groupLoaded = true;
      await loadMemGroups("cm-groups"); // 复用记忆页的群列表渲染（容器 id 传入）
    }
  };
  btnLocal.addEventListener("click", () => void show("local"));
  btnGroup.addEventListener("click", () => void show("group"));
  // 关键记忆折叠按键：默认收起，点击往下展开成红色分区
  let keyOpen = false;
  $("#cm-key-toggle").addEventListener("click", () => {
    keyOpen = !keyOpen;
    const t = $("#cm-key-toggle");
    t.classList.toggle("open", keyOpen);
    $("#cm-key-section").hidden = !keyOpen;
    // 箭头跟随展开状态（条数不变，只换箭头）
    const n = (t.textContent.match(/（(\d+)）/) || [])[1];
    if (n) t.textContent = `关键记忆（${n}）${keyOpen ? " ▴" : " ▾"}`;
  });
  $("#cm-search").addEventListener("input", () => void cmLoadEntries());
  $("#cm-entries").addEventListener("click", onMemRowClick);
  $("#cm-key-entries").addEventListener("click", onMemRowClick);
  $("#cm-groups").addEventListener("click", onMemGroupClick);
  // 数据填充
  (async () => {
    const card = await api.get(`/api/cards/${encodeURIComponent(slug)}`).catch(() => null);
    if (!card) { $("#cm-title").textContent = "卡片不存在"; return; }
    memCard = card; // onMemRowClick / loadMemGroups / onMemGroupClick 都依赖它
    $("#cm-title").textContent = `${card.name} 的记忆`;
    await cmLoadEntries();
    await show(tab);
  })();
}

/** 聊天记忆页的本地记忆渲染：关键记忆计数进折叠键，展开才显示；普通记忆直接列 */
async function cmLoadEntries() {
  if (!memCard) return;
  const mem = await api.get("/api/memory").catch(() => ({ memory: {} }));
  const entries = mem.memory?.[memCard.slug] ?? [];
  const q = ($("#cm-search")?.value ?? "").trim();
  const filtered = q ? entries.filter((e) => (e.fact + " " + (e.keywords ?? []).join(" ")).includes(q)) : entries;
  const byTime = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const keyList = filtered.filter((e) => e.important).sort(byTime);
  const normalList = filtered.filter((e) => !e.important).sort(byTime);
  // 折叠按键：有关键记忆才显示；文案带条数与当前展开状态
  const toggle = $("#cm-key-toggle");
  if (toggle) {
    toggle.hidden = !keyList.length;
    toggle.textContent = keyList.length ? `关键记忆（${keyList.length}）${toggle.classList.contains("open") ? " ▴" : " ▾"}` : "";
  }
  $("#cm-key-section").hidden = !toggle.classList.contains("open") || !keyList.length;
  $("#cm-key-entries").innerHTML = keyList.map((e) => renderMemRow(e, true)).join("");
  const el = $("#cm-entries");
  if (!normalList.length) {
    el.textContent = q ? "（没有匹配）" : "（暂无记忆）";
    return;
  }
  el.innerHTML = normalList.map((e) => renderMemRow(e)).join("");
}

// ============================================================
//  视图：世界书编辑页（#/chatwb，从聊天设置进来）
//  与卡库编辑器同一份数据（sillytavern_v2.character_book.entries），
//  保存 = PUT 整卡（后端会重编译 + 同步通道），所以通道端改完也生效。
//  列表行：状态chip + 名称（超长省略）+ 编辑符号键 + 删除；添加 = 空白条目。
// ============================================================
function renderChatWb() {
  return `
  <div class="view">
    <div class="page-head ci-head">
      <button id="cw-back" class="ghost small-btn">← 返回</button>
      <h2>世界书</h2>
      <span style="flex:1"></span>
      <button id="cw-add" class="primary small-btn">${icon("plus")} 添加条目</button>
    </div>
    <div id="cw-list" class="cw-list"></div>
  </div>`;
}

/** 世界书条目行（通讯录世界书页与卡库编辑器共用）：状态 + 名称 + 编辑/删除符号键；展开后 名称/关键词各占一行，常驻为按键 + 顺序
 *  withActions：是否带行级「保存/取消」（通讯录页即时保存用 true；卡库整卡保存用 false） */
/** 空白世界书条目（添加条目一律空白，通讯录世界书页与卡库编辑器共用） */
function blankEntry() {
  return {
    keys: [], secondary_keys: [], content: "", name: "", comment: "",
    enabled: true, selective: false, constant: false,
    insertion_order: 100, priority: 10, position: "before_char", probability: 100, depth: 4,
  };
}

function cwRowHTML(e, idx, withActions = true) {
  const keys = Array.isArray(e?.keys) ? e.keys.join("、") : (e?.keys ?? "");
  const title = e?.comment || e?.name || "未命名条目";
  // 完全空白的条目（刚添加）：名称框留空显示 placeholder，不预填「未命名条目」
  const nameValue = e?.comment || e?.name || "";
  const on = e?.enabled !== false;
  return `<div class="cw-item${on ? "" : " disabled"}" data-idx="${Number.isInteger(idx) ? idx : ""}">
    <div class="cw-head">
      <button type="button" class="cw-state${on ? " on" : ""}" data-act="state" title="${on ? "启用中，点击停用" : "已停用，点击启用"}">${on ? "启用中" : "已停用"}</button>
      <span class="cw-name">${escapeHtml(String(title))}</span>
      <span class="wb-spacer-flex"></span>
      <button type="button" class="cw-icon-btn" data-act="edit" title="编辑条目">${icon("pen")}</button>
      <button type="button" class="cw-icon-btn danger" data-act="del" title="删除条目">${icon("trash")}</button>
    </div>
    <div class="cw-detail" hidden>
      <div class="wb-field"><label>条目名称</label><input class="cw-f-name" placeholder="如：人物形象 / 世界观 / 人物关系" value="${escapeHtml(String(nameValue))}"></div>
      <div class="wb-field"><label>触发关键词</label><input class="cw-f-keys" placeholder="多个关键词用逗号分隔；常驻条目可留空（始终生效，不靠关键词触发）" value="${escapeHtml(keys)}"></div>
      <div class="cw-row2">
        <button type="button" class="cw-constant${e?.constant ? " on" : ""}" title="常驻条目始终生效，不靠关键词触发">常驻</button>
        <label class="cw-order-label">顺序 <input type="number" class="cw-f-order" min="0" value="${e?.insertion_order ?? 100}" title="多条条目同时触发时的排序"></label>
      </div>
      <div class="wb-field"><label>条目内容</label><textarea class="cw-f-content" rows="14" placeholder="这个世界观里发生了什么、角色是什么样的人…（触发或常驻时注入给 AI 的正文）">${escapeHtml(String(e?.content ?? ""))}</textarea></div>
      ${withActions ? `<div class="wb-foot">
        <button class="cw-cancel ghost small-btn" type="button">取消</button>
        <button class="cw-save primary small-btn" type="button">${icon("check")} 保存</button>
      </div>` : ""}
    </div>
  </div>`;
}

function initChatWb() {
  const m = (location.hash || "").match(/[?&]slug=([^&]+)/);
  const slug = m ? decodeURIComponent(m[1]) : localStorage.getItem("ocs_workbench_slug") || "";
  $("#cw-back").addEventListener("click", () => {
    location.hash = slug ? `#/chatinfo?slug=${encodeURIComponent(slug)}` : "#/chats";
  });
  let card = null;

  const draw = () => {
    const box = $("#cw-list");
    const entries = chatStv(card)?.character_book?.entries ?? [];
    if (!entries.length) { box.innerHTML = '<div class="muted">还没有条目，点右上角「添加条目」</div>'; return; }
    box.innerHTML = entries.map((e, i) => cwRowHTML(e, i)).join("");
  };

  const save = async () => {
    try {
      await api.send(`/api/cards/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify(card) });
      cacheInvalidate("/api/cards");
      // 世界书影响 AI 行为（通道端由 PUT 后的重编译同步）；聊天快照里的 DOM 作废，
      // 回聊天重新渲染（不然快照贴回的还是旧世界书时代的样子）
      if (lcSnap.slug === slug) { lcSnap.logHtml = ""; lcSnap.allEntries = []; lcSnap.renderedFrom = 0; }
      return true;
    } catch (e) {
      toast("保存失败：" + e.message, false);
      return false;
    }
  };

  (async () => {
    card = await api.get(`/api/cards/${encodeURIComponent(slug)}`).catch(() => null);
    if (!card) { $("#cw-list").innerHTML = '<div class="muted">卡片不存在</div>'; return; }
    draw();
  })();

  // 添加条目 = 一律空白条目（不需要用户选模板）
  $("#cw-add").addEventListener("click", async () => {
    if (!card) return;
    const st = chatStv(card);
    st.character_book ??= { entries: [] };
    st.character_book.entries ??= [];
    st.character_book.entries.push(blankEntry());
    if (!(await save())) { st.character_book.entries.pop(); return; }
    draw();
    // 新条目自动进入编辑态
    const rows = [...$("#cw-list").querySelectorAll(".cw-item")];
    const last = rows[rows.length - 1];
    if (last) { last.querySelector(".cw-detail").hidden = false; last.querySelector(".cw-f-name").focus(); }
  });

  $("#cw-list").addEventListener("click", async (e) => {
    if (!card) return;
    const row = e.target.closest(".cw-item");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    const entries = chatStv(card).character_book?.entries ?? [];
    const entry = entries[idx];
    if (!entry) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "state") {
      entry.enabled = entry.enabled === false ? true : false;
      if (!(await save())) { entry.enabled = !entry.enabled; draw(); return; }
      draw();
    } else if (act === "edit") {
      const d = row.querySelector(".cw-detail");
      d.hidden = !d.hidden;
    } else if (act === "del") {
      if (!confirm(`删除条目「${entry.comment || entry.name || "未命名"}」？`)) return;
      entries.splice(idx, 1);
      if (!(await save())) { draw(); return; }
      draw();
    } else if (e.target.closest(".cw-save")) {
      entry.comment = row.querySelector(".cw-f-name").value.trim();
      entry.name = entry.comment;
      const keysRaw = row.querySelector(".cw-f-keys").value;
      entry.keys = keysRaw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      entry.constant = row.querySelector(".cw-constant").classList.contains("on");
      entry.insertion_order = Number(row.querySelector(".cw-f-order").value) || 100;
      entry.content = row.querySelector(".cw-f-content").value;
      if (!(await save())) return;
      draw();
      toast("✓ 已保存");
    } else if (e.target.closest(".cw-cancel")) {
      draw(); // 丢弃输入，按已存数据重画
    }
  });
  // 常驻按键：点击切换高亮（不是开关控件）
  $("#cw-list").addEventListener("click", (e) => {
    if (e.target.closest(".cw-constant")) e.target.closest(".cw-constant").classList.toggle("on");
  });
}

/** 取卡的 sillytavern_v2 段（保证存在，方便直接改） */
function chatStv(card) {
  card.sillytavern_v2 ??= {};
  return card.sillytavern_v2;
}

// ============================================================
//  视图：正则编辑页（#/chatrx，从聊天设置进来）
//  同一份数据（sillytavern_v2.regex_scripts，兼容 extensions 旧位置），
//  保存 = PUT 整卡。正则作用于本地聊天气泡的显示（见 addChatBubble）。
// ============================================================
function renderChatRx() {
  return `
  <div class="view">
    <div class="page-head ci-head">
      <button id="cr-back" class="ghost small-btn">← 返回</button>
      <h2>正则</h2>
      <span style="flex:1"></span>
      <button id="cr-add" class="primary small-btn">${icon("plus")} 添加正则</button>
    </div>
    <div id="cr-list" class="cw-list"></div>
  </div>`;
}

/** 正则行（通讯录正则页与卡库编辑器共用）：状态 + 名称 + 查找摘要 + 编辑/删除符号键 */
function crRowHTML(s, idx, withActions = true) {
  const name = s?.scriptName || "未命名正则";
  const find = String(s?.findRegex ?? "");
  const on = !(s?.disabled === true || s?.enabled === false);
  return `<div class="cw-item${on ? "" : " disabled"}" data-idx="${Number.isInteger(idx) ? idx : ""}">
    <div class="cw-head">
      <button type="button" class="cw-state${on ? " on" : ""}" data-act="state" title="${on ? "启用中，点击停用" : "已停用，点击启用"}">${on ? "启用中" : "已停用"}</button>
      <span class="cw-name">${escapeHtml(String(name))}</span>
      <span class="cw-summary-meta">${escapeHtml(find.slice(0, 24))}${find.length > 24 ? "…" : ""}</span>
      <span class="wb-spacer-flex"></span>
      <button type="button" class="cw-icon-btn" data-act="edit" title="编辑正则">${icon("pen")}</button>
      <button type="button" class="cw-icon-btn danger" data-act="del" title="删除正则">${icon("trash")}</button>
    </div>
    <div class="cw-detail" hidden>
      <div class="wb-field"><label>名称</label><input class="cr-f-name" placeholder="如：去星号 / 去旁白" value="${escapeHtml(String(s?.scriptName ?? ""))}"></div>
      <div class="wb-field"><label>查找（正则表达式）</label><input class="cr-f-find" placeholder="/\\*.*?\\*/g 或裸表达式，$1 等分组可用" value="${escapeHtml(find)}"></div>
      <div class="wb-field"><label>替换为</label><input class="cr-f-rep" placeholder="留空 = 删除匹配内容" value="${escapeHtml(String(s?.replaceString ?? ""))}"></div>
      ${withActions ? `<div class="wb-foot">
        <button class="cr-cancel ghost small-btn" type="button">取消</button>
        <button class="cr-save primary small-btn" type="button">${icon("check")} 保存</button>
      </div>` : ""}
    </div>
  </div>`;
}

function initChatRx() {
  const m = (location.hash || "").match(/[?&]slug=([^&]+)/);
  const slug = m ? decodeURIComponent(m[1]) : localStorage.getItem("ocs_workbench_slug") || "";
  $("#cr-back").addEventListener("click", () => {
    location.hash = slug ? `#/chatinfo?slug=${encodeURIComponent(slug)}` : "#/chats";
  });
  let card = null;

  /** 正则统一存 sillytavern_v2.regex_scripts（schema 位置）；extensions 里若有旧副本一并同步，避免两处不一致 */
  const getScripts = () => {
    const stv = chatStv(card);
    if (!Array.isArray(stv.regex_scripts)) {
      stv.regex_scripts = [...(stv.extensions?.regex_scripts ?? [])];
    }
    return stv.regex_scripts;
  };
  const syncExtensions = () => {
    const stv = chatStv(card);
    if (stv.extensions && Array.isArray(stv.extensions.regex_scripts)) {
      stv.extensions.regex_scripts = stv.regex_scripts;
    }
  };

  const draw = () => {
    const box = $("#cr-list");
    const scripts = getScripts();
    if (!scripts.length) { box.innerHTML = '<div class="muted">还没有正则，点右上角「添加正则」</div>'; return; }
    box.innerHTML = scripts.map((s, i) => crRowHTML(s, i)).join("");
  };

  const save = async () => {
    try {
      syncExtensions();
      await api.send(`/api/cards/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify(card) });
      cacheInvalidate("/api/cards");
      // 正则影响聊天气泡显示：快照 DOM 作废，回聊天按新正则重新渲染
      if (lcSnap.slug === slug) { lcSnap.logHtml = ""; lcSnap.allEntries = []; lcSnap.renderedFrom = 0; }
      return true;
    } catch (e) {
      toast("保存失败：" + e.message, false);
      return false;
    }
  };

  (async () => {
    card = await api.get(`/api/cards/${encodeURIComponent(slug)}`).catch(() => null);
    if (!card) { $("#cr-list").innerHTML = '<div class="muted">卡片不存在</div>'; return; }
    getScripts(); // 归一化到顶层
    draw();
  })();

  $("#cr-add").addEventListener("click", async () => {
    if (!card) return;
    const scripts = getScripts();
    scripts.push({ scriptName: "", findRegex: "", replaceString: "" });
    if (!(await save())) { scripts.pop(); return; }
    draw();
    const rows = [...$("#cr-list").querySelectorAll(".cw-item")];
    const last = rows[rows.length - 1];
    if (last) { last.querySelector(".cw-detail").hidden = false; last.querySelector(".cr-f-name").focus(); }
  });

  $("#cr-list").addEventListener("click", async (e) => {
    if (!card) return;
    const row = e.target.closest(".cw-item");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    const scripts = getScripts();
    const s = scripts[idx];
    if (!s) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "state") {
      s.disabled = !(s.disabled === true);
      if (!(await save())) { s.disabled = !s.disabled; draw(); return; }
      draw();
    } else if (act === "edit") {
      const d = row.querySelector(".cw-detail");
      d.hidden = !d.hidden;
    } else if (act === "del") {
      if (!confirm(`删除正则「${s.scriptName || "未命名"}」？`)) return;
      scripts.splice(idx, 1);
      if (!(await save())) { draw(); return; }
      draw();
    } else if (e.target.closest(".cr-save")) {
      s.scriptName = row.querySelector(".cr-f-name").value.trim();
      s.findRegex = row.querySelector(".cr-f-find").value.trim();
      s.replaceString = row.querySelector(".cr-f-rep").value;
      if (!(await save())) return;
      draw();
      toast("✓ 已保存");
    } else if (e.target.closest(".cr-cancel")) {
      draw();
    }
  });
}

// ============================================================
//  视图：聊天记录搜索页（微信式：搜索框置顶 + 图片/时间筛选）
//  从聊天设置页「查找聊天记录」进来；点命中条目跳回聊天并定位高亮
// ============================================================
function renderChatSearch() {
  return `
  <div class="view">
    <div class="page-head ci-head">
      <button id="cs-back" class="ghost small-btn">← 返回</button>
      <h2>查找聊天记录</h2>
    </div>
    <div class="card-box">
      <input id="cs-q" type="text" placeholder="搜索聊天内容…" style="width:100%">
      <div class="cs-filters">
        <button type="button" id="cs-img" class="cs-chip">图片/表情</button>
        <input type="date" id="cs-date" class="cs-date" title="只看某一天">
        <button type="button" id="cs-clear" class="ghost small-btn">清除条件</button>
      </div>
      <div id="cs-out" class="ci-search-out"></div>
    </div>
  </div>`;
}

function initChatSearch() {
  const m = (location.hash || "").match(/[?&]slug=([^&]+)/);
  const slug = m ? decodeURIComponent(m[1]) : localStorage.getItem("ocs_workbench_slug") || "";
  $("#cs-back").addEventListener("click", () => {
    location.hash = slug ? `#/chatinfo?slug=${encodeURIComponent(slug)}` : "#/chats";
  });
  const qEl = $("#cs-q");
  const imgEl = $("#cs-img");
  const dateEl = $("#cs-date");
  let timer = null;
  const run = () => void csRunSearch(slug);
  // 输入防抖 350ms；图片/时间条件变化立即搜
  qEl.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 350);
  });
  imgEl.addEventListener("click", () => { imgEl.classList.toggle("on"); run(); });
  dateEl.addEventListener("change", run);
  $("#cs-clear").addEventListener("click", () => {
    qEl.value = "";
    dateEl.value = "";
    imgEl.classList.remove("on");
    $("#cs-out").innerHTML = "";
    qEl.focus();
  });
  qEl.focus();
}

async function csRunSearch(slug) {
  const out = $("#cs-out");
  if (!out || !slug) return;
  const q = ($("#cs-q")?.value ?? "").trim();
  const wantImg = $("#cs-img")?.classList.contains("on");
  const date = ($("#cs-date")?.value ?? "").trim();
  if (!q && !wantImg && !date) { out.innerHTML = ""; return; }
  out.innerHTML = '<div class="muted">查找中…</div>';
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (wantImg) params.set("image", "1");
    if (date) params.set("date", date);
    const r = await api.get(`/api/cards/${encodeURIComponent(slug)}/conversation/search?${params}`);
    const hits = r.hits ?? [];
    if (!hits.length) { out.innerHTML = '<div class="muted">没有找到符合条件的消息</div>'; return; }
    out.innerHTML =
      `<div class="hint">找到 ${hits.length} 条（点一条跳到聊天里）</div>` +
      hits
        .map(
          (h) => `<div class="ci-hit" data-id="${escapeHtml(h.id)}">
        <span class="ci-hit-who">${h.role === "user" ? "我" : "TA"}</span>
        <span class="ci-hit-text">${highlightHit(stripMediaLines(h.content), q)}</span>
        <span class="ci-hit-time">${escapeHtml(fmtChatTime(h.t))}</span>
      </div>`
        )
        .join("");
    out.querySelectorAll(".ci-hit").forEach((el) =>
      el.addEventListener("click", () => {
        pendingChatFocusId = el.dataset.id; // 回聊天页后滚动并高亮这条
        openChatFromList(slug);
      })
    );
  } catch (e) {
    out.innerHTML = `<div class="muted">查找失败：${escapeHtml(e.message)}</div>`;
  }
}

/** 关键词高亮（先转义再插标签，避免把用户输入当 HTML） */
function highlightHit(text, q) {
  const safe = escapeHtml(String(text));
  const needle = escapeHtml(q);
  if (!needle) return safe;
  // 简单不区分大小写替换（关键词已转义，正则里的特殊字符要再escape一次）
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (mm) => `<mark>${mm}</mark>`);
}

/** 从设置页跳回聊天时要定位的消息 id（wbReloadHistory 渲染完消费） */
let pendingChatFocusId = "";

/** 一键删除：清空聊天记录 + 记忆 + 开场状态（二次确认） */
async function ciWipeAll(slug) {
  const name = memCard?.name ?? slug;
  const ok = await wbConfirm({
    title: `清空「${name}」的聊天与记忆`,
    lead: "这张卡的聊天记录与长期记忆会被全部删除，AI 会忘掉之前的一切。",
    points: [
      "网页聊天记录全部清空",
      "长期记忆全部删除（包括通道里记住的事）",
      "QQ / 微信 的对话上下文一并重置",
      "开场白状态复位，下次见面重新开场",
    ],
    note: "此操作不可恢复。",
    okText: "全部删除",
  });
  if (!ok) return;
  // 第二次确认（用户点名要求二次确认）
  const again = await wbConfirm({
    title: "再确认一次",
    lead: `真的要清空「${name}」的全部聊天记录与记忆吗？删除后无法恢复。`,
    points: [],
    note: "",
    okText: "确认清空",
  });
  if (!again) return;
  try {
    await api.send(`/api/cards/${encodeURIComponent(slug)}/reset`, { method: "POST", body: "{}" });
    // 本地聊天页的状态一起清掉（否则回聊天页还会看到旧气泡）
    if (wbSlug === slug) {
      wbChatHistory = [];
      wbPending = null;
      wbRenderedIds = new Set();
      wbAllEntries = [];
      wbRenderedFrom = 0;
      wbLastMsgTime = null;
      lcSnap.slug = ""; // 快照里存的还是旧聊天 DOM，一并作废
      lcSnap.logHtml = "";
      const log = $("#chat-log");
      if (log) log.innerHTML = "";
    }
    void api.send(`/api/cards/${encodeURIComponent(slug)}/greeting/push`, { method: "POST" }).catch(() => {});
    cacheInvalidate("/api/conversations");
    await loadMemEntries();
    toast(`✓ 「${name}」的聊天与记忆已清空`);
  } catch (e) { toast("删除失败：" + e.message, false); }
}

// ============================================================
//  视图：记忆（每卡配置 + 查看 + 单条管理）
// ============================================================
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
    <div class="page-head"><h2>记忆</h2></div>
    <div id="mem-cards-head" class="mem-cards-head">选择角色卡</div>
    <div id="mem-cards" class="card-grid"></div>
    <div id="mem-detail" class="card-box" style="display:none">
      <h3 id="mem-title"></h3>
      <div class="row" style="align-items:center">
        <label>每 <input id="mem-rounds" type="number" min="1" max="20" style="width:64px;text-align:center"> 轮自动总结</label>
        <button id="mem-save-rounds" class="primary small-btn">保存</button>
        <button id="mem-clear" class="danger small-btn">清空此卡记忆</button>
      </div>
      <div class="mem-tabs">
        <button id="mem-tab-solo" class="mem-tab on" type="button">单聊记忆</button>
        <button id="mem-tab-group" class="mem-tab" type="button">群聊记录</button>
      </div>
      <div id="mem-solo-pane">
        <input id="mem-search" type="text" placeholder="搜索记忆…" style="width:100%">
        <div id="mem-key-section" class="mem-key-section" style="display:none">
          <div class="mem-sec-head"><span class="mem-sec-icon">${icon("shield")}</span> 关键记忆（必须遵守）</div>
          <div id="mem-key-entries" class="small-out" style="padding:4px 10px"></div>
        </div>
        <div id="mem-entries" class="small-out tall" style="max-height:520px;padding:4px 10px"></div>
      </div>
      <div id="mem-group-pane" hidden>
        <p class="hint">群聊记录与单聊/网页完全分开存放，只按人名存原文、不做总结。这里不展示聊天内容，只能整群删除。</p>
        <div id="mem-groups" class="mem-group-list"></div>
      </div>
    </div>
  </div>`;
}

let memCard = null;
function initMemory() {
  (async () => {
    const { cards } = await cachedGet("/api/cards");
    const box = $("#mem-cards");
    box.innerHTML = "";
    if (!cards.length) { box.innerHTML = '<div class="muted">还没有卡片</div>'; return; }
    // 正在本地聊天（#/chat）→ 只显示当前这张卡的记忆并直接展开；退出后恢复全部
    const chatting = (location.hash || "").startsWith("#/chat") ? localStorage.getItem("ocs_workbench_slug") : "";
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
  $("#mem-search").addEventListener("input", loadMemEntries);
  $("#mem-entries").addEventListener("click", onMemRowClick);
  $("#mem-groups")?.addEventListener("click", onMemGroupClick);
  $("#mem-tab-solo")?.addEventListener("click", () => switchMemTab("solo"));
  $("#mem-tab-group")?.addEventListener("click", () => switchMemTab("group"));
}

async function openMemDetail(slug) {
  memCard = await api.get(`/api/cards/${slug}`);
  $("#mem-detail").style.display = "block";
  $("#mem-title").textContent = `${memCard.name} 的记忆`;
  $("#mem-rounds").value = memCard.memoryConfig?.auto_rounds ?? 5;
  switchMemTab("solo"); // 换卡时回到默认的单聊视图
  await loadMemEntries();
  $("#mem-detail").scrollIntoView({ behavior: "smooth" });
}

// ---------- 群聊对话记忆（与网页/私聊完全分开，不做总结） ----------
async function loadMemGroups(boxId = "mem-groups") {
  if (!memCard) return;
  const box = $("#" + boxId);
  if (!box) return;
  const r = await api.get(`/api/groupchat/${memCard.slug}`).catch(() => ({ groups: [] }));
  const groups = r.groups ?? [];
  if (!groups.length) {
    box.innerHTML = '<div class="muted" style="padding:12px 0">这张卡还没有群聊记录</div>';
    return;
  }
  // 只显示群名 + 规模；不展示任何聊天内容（用户拍板）。
  // 「起名」保留：给群成员起的名字会用在 AI 检索与称呼上，属于配置不是聊天内容。
  box.innerHTML = groups
    .map(
      (g) => `<div class="mem-group-item" data-gid="${escapeHtml(g.gid)}">
        <div class="mem-group-box">
          <span class="mem-group-name">${escapeHtml(g.name)}</span>
          <span class="mem-group-meta">${g.turns} 轮 · ${g.members} 人</span>
        </div>
        <button class="small-btn ghost" data-act="name" data-gid="${escapeHtml(g.gid)}" title="给群成员起名字（用于 AI 称呼与检索）">起名</button>
        <button class="small-btn danger" data-act="del" data-gid="${escapeHtml(g.gid)}" title="删除机器人在这个群的全部聊天记录">删除</button>
      </div>`
    )
    .join("");
}

/** 单聊 / 群聊切换：默认单聊；群聊只列群、不展示内容 */
function switchMemTab(which) {
  const solo = which !== "group";
  $("#mem-solo-pane").hidden = !solo;
  $("#mem-group-pane").hidden = solo;
  $("#mem-tab-solo").classList.toggle("on", solo);
  $("#mem-tab-group").classList.toggle("on", !solo);
  // 「清空此卡记忆」只对单聊记忆有效，切到群聊时藏起来避免误解
  const clr = $("#mem-clear");
  if (clr) clr.hidden = !solo;
  const rounds = $("#mem-rounds")?.closest("label");
  if (rounds) rounds.hidden = !solo;
  const saveRounds = $("#mem-save-rounds");
  if (saveRounds) saveRounds.hidden = !solo;
  if (!solo) void loadMemGroups();
}

async function onMemGroupClick(ev) {
  const btn = ev.target.closest("button[data-act]");
  if (!btn || !memCard) return;
  const gid = btn.dataset.gid;
  if (btn.dataset.act === "del") {
    if (!confirm("删除机器人在这个群的全部聊天记录？\n只影响这个群，单聊/网页记忆不受影响，此操作不可恢复。")) return;
    await api.send(`/api/groupchat/${memCard.slug}/${encodeURIComponent(gid)}/delete`, { method: "POST", body: "{}" });
    await loadMemGroups();
    toast("✓ 已删除该群记录");
    return;
  }
  if (btn.dataset.act === "name") await openGroupMembers(gid);
}

async function openGroupMembers(gid) {
  const d = await api.get(`/api/groupchat/${memCard.slug}/${encodeURIComponent(gid)}`).catch(() => null);
  if (!d) { toast("读取失败", false); return; }
  const rows = (d.members ?? [])
    .map(
      (m) => `<div class="row" style="align-items:center;gap:6px">
        <input class="gm-name" data-id="${escapeHtml(m.id)}" value="${escapeHtml(m.name)}" placeholder="给这个人起个名字" style="flex:1">
        <span class="muted" style="font-size:12px">${m.turns} 轮</span>
      </div>`
    )
    .join("");
  // 注意：wbModal 的确定回调触发时弹窗已被移除，所以先把输入值收集到闭包变量里
  const pending = [];
  wbModal(
    `${escapeHtml(d.meta.name)} · 成员`,
    `<p class="hint">QQ 开放平台不提供群成员昵称，默认显示成员短码。这里起的名字会用在 AI 的检索与称呼上。</p>
     <div id="gm-list">${rows || '<div class="muted">还没有人在群里跟她说过话</div>'}</div>`,
    async () => {
      for (const { memberId, name } of pending) {
        await api
          .send(`/api/groupchat/${memCard.slug}/${encodeURIComponent(gid)}/member`, {
            method: "POST",
            body: JSON.stringify({ memberId, name }),
          })
          .catch(() => {});
      }
      if (pending.length) toast("✓ 已保存成员名字");
      await loadMemGroups();
    }
  );
  // 输入即记录（弹窗移除后仍能拿到最终值）
  for (const el of document.querySelectorAll("#gm-list .gm-name")) {
    el.addEventListener("input", () => {
      const memberId = el.dataset.id;
      const name = el.value.trim();
      const idx = pending.findIndex((p) => p.memberId === memberId);
      if (idx >= 0) pending[idx].name = name;
      else pending.push({ memberId, name });
    });
  }
}

async function loadMemEntries() {
  if (!memCard) return;
  const mem = await api.get("/api/memory").catch(() => ({ memory: {} }));
  const entries = mem.memory?.[memCard.slug] ?? [];
  const q = ($("#mem-search")?.value ?? "").trim();
  const filtered = q ? entries.filter((e) => (e.fact + " " + (e.keywords ?? []).join(" ")).includes(q)) : entries;
  const keySec = $("#mem-key-section");
  const keyEl = $("#mem-key-entries");
  const el = $("#mem-entries");
  if (!filtered.length) {
    if (keySec) keySec.style.display = "none";
    if (keyEl) keyEl.innerHTML = "";
    el.textContent = q ? "（没有匹配）" : "（还没有记忆）";
    return;
  }
  const byTime = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const keyList = filtered.filter((e) => e.important).sort(byTime);
  const normalList = filtered.filter((e) => !e.important).sort(byTime);
  // 关键记忆：独立分区（红色卡片，醒目、方便查看）
  if (keySec) keySec.style.display = keyList.length ? "" : "none";
  if (keyEl) keyEl.innerHTML = keyList.length ? keyList.map((e) => renderMemRow(e, true)).join("") : "";
  // 普通记忆：主列表
  if (!normalList.length) {
    el.textContent = q ? "（没有匹配）" : "（暂无普通记忆）";
    return;
  }
  el.innerHTML = normalList.map((e) => renderMemRow(e)).join("");
}

function memNsLabel(ns) {
  if (!ns || ns === "shared") return "";
  if (ns === "local") return "本地";
  if (ns.startsWith("qq:")) return "QQ";
  if (ns.startsWith("wx:")) return "微信";
  return ns;
}

function renderMemRow(e, inKeySection) {
  const src = MEM_SRC_LABEL[e.src] ?? e.src ?? "";
  const nsBadge = memNsLabel(e.ns) ? `<span class="mem-badge mem-ns">${escapeHtml(memNsLabel(e.ns))}</span>` : "";
  // 事件时间（聊于 X月X日）：evtFrom 才有 = 新版总结的记忆；旧数据显示记录时间（fmtTime(e.ts)）
  let evtText = "";
  if (e.evtFrom) {
    const d = new Date(e.evtFrom);
    if (!isNaN(d.getTime())) {
      const f = (x) => `${x.getMonth() + 1}月${x.getDate()}日`;
      const from = f(d);
      const to = e.evtTo ? new Date(e.evtTo) : null;
      evtText = to && !isNaN(to.getTime()) && to.toDateString() !== d.toDateString()
        ? `聊于 ${from}~${f(to)}`
        : `聊于 ${from}`;
    }
  }
  // #关键词标签已按用户要求去掉（展示层面用不到；触发词数据本身保留，检索仍生效）
  // 关键记忆单独分区里不再叠整行红色（分区已有红框）；主列表里的关键记忆（搜索命中时）保留高亮
  const rowCls = `mem-row${!inKeySection && e.important ? " mem-key-row" : ""}`;
  return `<div class="${rowCls}" data-id="${escapeHtml(e.id)}">
    ${e.important ? `<span class="mem-badge mem-key">关键</span>` : ""}
    ${nsBadge}
    <span class="mem-fact">${escapeHtml(e.fact)}</span>
    <span class="mem-meta">${evtText ? evtText + " · " : ""}${fmtTime(e.ts)}${src ? " · " + src : ""}</span>
    <span class="mem-ops">
      <button class="small-btn" data-act="edit" data-id="${escapeHtml(e.id)}">编辑</button>
      <button class="small-btn danger" data-act="del" data-id="${escapeHtml(e.id)}">删除</button>
    </span>
  </div>`;
}

function renderMemEditRow(e) {
  return `<div class="mem-row mem-edit" data-id="${escapeHtml(e.id)}">
    <label class="mem-key-label${e.important ? " on" : ""}">
      <span class="switch"><input class="mem-edit-key" type="checkbox" ${e.important ? "checked" : ""}><span class="slider"></span></span>
      关键
    </label>
    <input class="mem-edit-fact" type="text" value="${escapeHtml(e.fact)}">
    <input class="mem-edit-kw" type="text" placeholder="触发词，逗号分隔" value="${escapeHtml((e.keywords ?? []).join("，"))}" style="max-width:130px">
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
    if (entry) row.outerHTML = renderMemRow(entry, !!row.closest("#mem-key-entries"));
  } else if (btn.dataset.act === "save") {
    const editRow = btn.closest(".mem-edit");
    const fact = editRow.querySelector(".mem-edit-fact").value.trim();
    const important = editRow.querySelector(".mem-edit-key")?.checked === true;
    const keywords = (editRow.querySelector(".mem-edit-kw")?.value ?? "")
      .split(/[,，、]/).map((k) => k.trim()).filter(Boolean);
    if (!fact) { toast("记忆不能为空", false); return; }
    const r = await api.send(`/api/memory/${memCard.slug}/update`, { method: "POST", body: JSON.stringify({ id, fact, important, keywords }) });
    toast("✓ 已保存");
    loadMemEntries();
  }
}

async function saveMemRounds() {
  if (!memCard) return;
  const rounds = Math.min(20, Math.max(1, Number($("#mem-rounds").value) || 5));
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
// 图片识别：① 「已生成图片：<url>」整行（上游图链可能无扩展名，必须按前缀认）
// ② https 图片直链 ③ /api/image/<id> 服务器内存图 ④ /img/ 本地历史图
const CHAT_IMG_RE = /(已生成图片：\s*\S+|https?:\/\/[^\s"'<>()]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>()]*)?|\/api\/image\/[A-Za-z0-9_-]+|\/img\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|gif))/gi;
// 半角/全角方括号都认（模型在通道常把 [表情:名] 写成【表情:名】，同步时已转半角，这里双保险）
const CHAT_EMOJI_RE = /\[表情:([^\]]+)\]/g;
const CHAT_EMOJI_NORM_RE = /【表情:([^】]+)】/g;

/** 当前聊天用的卡片：卡片编辑器里是 editingCard，工作台里是 wbCardObj */
function curCard() { return wbCardObj || editingCard; }

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
let emojiLibPromise = null;
/** 确保表情库已加载（幂等、带并发合并）：聊天渲染前必须 await 它，
 * 否则库还没回来时 [表情:名] 会按文本兜底渲染，之后再也不升级 = 用户看到的「只显示名字」 */
function ensureEmojiLib() {
  if (!emojiLibPromise) emojiLibPromise = loadEmojiLib();
  return emojiLibPromise;
}
async function loadEmojiLib() {
  try {
    const r = await cachedGet("/api/emojis");
    emojiLib = r.emojis ?? [];
  } catch { emojiLib = []; }
  return emojiLib;
}

/**
 * 剔除通道消息里残留的 MEDIA: 路径行（模型复读生图/表情工具结果留下的脏数据）。
 * 口径与后端 clean-media-lines 一致：按扩展名截断，路径后还跟着文字就保留文字，
 * 整行只有路径就整行丢掉——否则网页上会显示一坨 `MEDIA:C:\...\开心.gif`。
 */
function stripMediaLines(text) {
  const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|mp4|mp3|wav|silk)/i;
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*MEDIA:\s*(.*)$/i);
    if (!m) { out.push(line); continue; }
    const rest = m[1] ?? "";
    const em = rest.match(MEDIA_EXT_RE);
    if (!em) continue; // 没有扩展名 = 整行是编造路径，丢弃
    const tail = rest.slice(em.index + em[0].length).trim();
    if (tail) out.push(tail); // 路径后跟着的文字保留（如有）
    // 纯路径行：整行丢弃（不 push）
  }
  return out.join("\n").trim();
}

/**
 * 把已渲染成纯文本的 [表情:名] / 【表情:名】 升级成图片。
 * 场景：表情库请求还没回来时渲染的历史消息（按文本兜底了），以及 DOM 快照里
 * 存着当年文本兜底的老气泡——库就绪后走这里补渲染，旧消息也能看到表情图。
 */
function upgradeEmojiFallback(root) {
  if (!root || !emojiLib.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const v = walker.currentNode.nodeValue || "";
    if (/\[表情:[^\]]+\]/.test(v) || /【表情:[^】]+】/.test(v)) targets.push(walker.currentNode);
  }
  for (const node of targets) {
    const tmp = document.createElement("span");
    appendChatContent(tmp, node.nodeValue);
    if (!tmp.hasChildNodes()) continue;
    const frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    node.parentNode.replaceChild(frag, node);
  }
}

/** 把回复文本渲染进气泡：[表情:名字] → 共享表情库图片；/img/... → 可点击放大的生图；其余纯文本 */
function appendChatContent(div, text) {
  // 先剥 MEDIA: 路径行（通道历史污染，见 stripMediaLines）
  text = stripMediaLines(text);
  // 全角【表情:名】归一化为半角 [表情:名]（通道模型常写全角）
  const emojiParts = String(text).replace(CHAT_EMOJI_NORM_RE, "[表情:$1]").split(CHAT_EMOJI_RE);
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
    // 文本段里还可能混着生图；「已生成图片：<url>」按前缀整段认成图片
    // （上游图链可能没有扩展名，如 sta1n 的 /api/images/xxx/content，不能只靠扩展名匹配）
    const imgParts = seg.split(CHAT_IMG_RE);
    for (let j = 0; j < imgParts.length; j++) {
      const p = imgParts[j];
      if (!p) continue;
      if (j % 2 === 1) {
        const src = p.replace(/^已生成图片：\s*/, "");
        const img = document.createElement("img");
        img.src = src;
        img.className = "chat-img";
        img.alt = "AI 生成的图片";
        img.loading = "lazy";
        img.dataset.imgUrl = src;
        // 渲染链：本地有就换本地（OpenAI blob / NAI 已保存的文件夹文件），失败逐级兜底
        ocHydrateChatImage(img, src);
        // 加载失败 → NAI 已保存文件兜底 → 提示词卡片（"URL 不会露给用户"）
        img.addEventListener("error", () => ocImgFail(img, src));
        img.addEventListener("click", () => showLightbox(img.src));
        div.appendChild(img);
      } else {
        div.appendChild(document.createTextNode(p));
      }
    }
  }
}

/** 渲染气泡并返回**外层 .bubble-row 元素**（调用方依赖它挂 id / 移除 / 追加按钮）
 *  t：消息时间。undefined=现在（新消息）；null=豁免（占位/错误提示等非时间线气泡，不插分隔也不动基准）；字符串=指定时间（历史渲染） */
function addChatBubble(role, text, convId, logEl, t) {
  // 卡片正则（酒馆 regex_scripts）统一在气泡层套用：新回复与历史记录口径一致，
  // 刷新/翻旧消息显示不会变回原文。只改显示，不改会话数据与上下文。
  if (role === "bot") text = applyRegexScripts(text);
  // bot 消息里含 [表情:名] 标签时，表情独立成气泡（文本一个、每个表情一个），
  // 不再让图片挤在文本气泡里；未命中的表情名按原文显示（appendChatContent 兜底）
  if (role === "bot" && /\[表情:/.test(String(text ?? ""))) {
    const segs = String(text).split(CHAT_EMOJI_RE);
    let last = null;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      // 同一轮拆出来的每个气泡都挂同一个 convId：删除时按 id 能把这轮的所有气泡一起摘掉
      // （以前只给第一条挂 id，局部删除会漏掉后面的表情气泡）
      const r = renderBubbleRow(role, i % 2 === 1 ? `[表情:${seg}]` : seg, convId, logEl, t);
      if (r) last = r;
    }
    return last; // 表情拆分时返回最后一条（"正在输出"占位等场景不会走这里）
  }
  return renderBubbleRow(role, text, convId, logEl, t);
}

/**
 * 渲染单个气泡行（addChatBubble 的底层实现；bot 表情拆分时逐条调用）。
 * logEl 不传 = 追加到当前 #chat-log 并滚到底；传容器（如 DocumentFragment）=
 * 离屏构建（上翻补渲染/快照回填用），不碰滚动。
 */
function renderBubbleRow(role, text, convId, logEl, t) {
  const log = logEl ?? $("#chat-log");
  const detached = !(log instanceof Element) || !log.isConnected;
  // 时间戳分隔：与上一条真实消息间隔超阈值就在本条上方插一条居中时间（微信式）。
  // 每条气泡的时间记在 dataset.t 上，上翻补渲染的边界修正要用。
  let sepDiv = null;
  let ts = null;
  if (t !== null) {
    ts = t || new Date().toISOString();
    sepDiv = wbTimeSepDiv(wbLastMsgTime, ts);
    wbLastMsgTime = ts;
  }
  const row = document.createElement("div");
  row.className = "bubble-row " + (role === "user" ? "me" : "bot");
  if (convId) row.dataset.convId = convId;
  // 头像：角色用卡面（圆形裁剪），用户用资料头像；整个会话只取一次，气泡复用同一份，不重复下载
  const av = document.createElement("img");
  av.className = "bubble-avatar";
  av.alt = "";
  av.loading = "lazy";
  const src = role === "user" ? getUserAvatarCached() : getCardAvatarCached();
  if (src) av.src = src;
  else av.src = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='72' height='72'><rect width='72' height='72' fill='#ececec'/><text x='36' y='46' font-size='30' text-anchor='middle' fill='#999999'>${role === "user" ? "我" : "AI"}</text></svg>`
  );
  row.appendChild(av);
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "bot");
  appendChatContent(div, String(text));
  // 朗读喇叭已按用户要求移除（原 bot 气泡右上角 hover 出现的 tts-speak-btn）
  row.appendChild(div);
  if (sepDiv) log.appendChild(sepDiv);
  if (ts) row.dataset.t = ts;
  log.appendChild(row);
  // 离屏构建（fragment/隐藏容器）不滚动；只有真往聊天区追加时才滚到底。
  // 滚到底必须显式 behavior:"instant"：.lc-log 的 CSS scroll-behavior:smooth 会把
  // scrollTop 赋值变成平滑动画，逐条渲染时后一条又把前一条的动画打断 → 实测滚不动。
  if (!detached) log.scrollTo({ top: log.scrollHeight, behavior: "instant" });
  // 返回**外层 .bubble-row**（不是内层 .bubble）：调用方要用它挂 data-conv-id、
  // 用 closest(".bubble-row") 移除、用 parentNode 追加审批按钮——都依赖外层这一层。
  // 2026-09-10 重构抽出本函数时这里误留了旧代码的 `return div`（那时 div 就是外层），
  // 导致 addChatBubble 的返回值不可用 → 「正在输出」气泡删不掉 + dataset 报错。
  return row;
}

// 会话级头像缓存：dataURL 只转一次 Blob URL，所有气泡复用同一个短字符串
// （不这么做的话，几百条气泡每条内嵌一份完整 dataURL，DOM 内存会像 RP-Hub 群聊那样涨上去）
let bubbleCardAvatarUrl = null;
let bubbleUserAvatarUrl = null;
function toBubbleAvatarUrl(raw) {
  if (!raw) return "";
  if (raw.startsWith("data:")) {
    try {
      const bin = atob(raw.slice(raw.indexOf(",") + 1));
      const mime = raw.slice(5, raw.indexOf(";")) || "image/png";
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch { return raw; }
  }
  return raw; // http 路径走浏览器缓存，天然不重复下载
}
function getCardAvatarCached() {
  if (bubbleCardAvatarUrl === null) bubbleCardAvatarUrl = toBubbleAvatarUrl(wbCardObj?.identity?.avatar || "");
  return bubbleCardAvatarUrl;
}
function getUserAvatarCached() {
  if (bubbleUserAvatarUrl === null) bubbleUserAvatarUrl = toBubbleAvatarUrl(userProfile?.avatar || "");
  return bubbleUserAvatarUrl;
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
    // 本地音频缓存：同一段朗读第二次起直接放本地，不再烧一次合成
    const cacheKey = ocAudioKey(curCard()?.slug || "local", String(text).slice(0, 500));
    // 已删除（墓碑）→ 提示已删除，不重新合成（避免悄悄再花钱）
    const tomb = await ocTx("audio", "readonly", (s) => s.get(cacheKey)).catch(() => null);
    if (tomb?.deleted) {
      stopSpeak();
      toast("这条语音已删除", false);
      return;
    }
    let blob = await ocAudioGet(cacheKey).catch(() => null);
    if (!blob) {
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
      blob = await resp.blob();
      void ocAudioPut(cacheKey, curCard()?.slug || "local", String(text).slice(0, 500), blob).catch(() => {});
    }
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
 * 像真人一样分条显示回复。优先用后端拆好的 parts（splitter.ts 的段落/句号/逗号
 * 四级拆条 + 条数/字数约束）；没有 parts 时退回旧逻辑：multi_send 开 → 按空行切。
 * 逐条冒出来，每条之间按卡里的 chat.delay 停顿（与通道端 humanDelay 一致）。
 */
async function addBotReplyHumanLike(rawText, serverParts, assistantConvId) {
  const card = curCard();
  // 正则替换统一在 addChatBubble 气泡层套用（历史消息同样生效），这里不再预处理
  let parts;
  if (Array.isArray(serverParts) && serverParts.length > 0) {
    parts = serverParts.map((s) => String(s ?? "").trim()).filter(Boolean);
  } else {
    const multi = card?.voice?.message_style?.multi_send === true;
    parts = multi
      ? String(rawText).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
      : [String(rawText)];
  }
  if (parts.length <= 1) {
    addChatBubble("bot", rawText, assistantConvId);
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
    addChatBubble("bot", parts[i], assistantConvId);
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
          <div class="cf-grid2">
            <div><label>模型商（蒸馏用）</label><select id="distill-provider"><option value="">跟随默认</option></select></div>
            <div><label>模型</label><select id="distill-model"><option value="">—</option></select></div>
          </div>
          <div class="row"><button id="btn-distill-run" class="primary">开始蒸馏</button></div>
          <div id="distill-msg" class="status"></div>
        </div>
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
  loadDistillProviders();
  $("#distill-provider").addEventListener("change", () => fillDistillModels(false));
}

/** 蒸馏页：加载启用中的模型商（默认 = 第一个启用的提供商 + 它的第一个模型，直接选中可换） */
async function loadDistillProviders() {
  const sel = $("#distill-provider");
  if (!sel) return;
  if (!lcProviders.length) {
    try {
      const prov = await api.get("/api/providers");
      lcProviders = (prov.chat ?? []).filter((p) => p.enabled !== false);
    } catch { lcProviders = []; }
  }
  sel.innerHTML = lcProviders.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  fillDistillModels(false);
}

/** 按选中的模型商填充蒸馏模型下拉 */
function fillDistillModels(keepModel) {
  const sel = $("#distill-model");
  if (!sel) return;
  const p = lcProviders.find((x) => x.name === $("#distill-provider")?.value);
  if (!p) { sel.innerHTML = `<option value="">—</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  const cur = keepModel ? sel.value : "";
  const models = p.models ?? [];
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m)}" ${m === cur ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")
    : `<option value="">—</option>`;
}

/** 蒸馏页当前选择的模型（"提供商::模型"，跟随默认 = 空串） */
function distillModelChoice() {
  const prov = $("#distill-provider")?.value || "";
  const model = $("#distill-model")?.value || "";
  return prov && model ? `${prov}::${model}` : "";
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
        model: distillModelChoice(),
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
  } catch (e) {
    // 账号槽位满：后端拒绝生成二维码，把原因原样告诉用户（要先彻底删一个账号）
    $(msgSel).textContent = e.message || "启动失败";
    if (/存满/.test(e.message || "")) toast(e.message, false);
  }
}

function initChannels() {
  $("#btn-wx-login").addEventListener("click", () => startLogin("/api/channels/wechat/login", "#wx-qr", "#wx-login-msg", () => { refreshWechat(); refreshPairing(); }));
  $("#btn-wx-refresh").addEventListener("click", () => { refreshWechat(true); refreshConnections(); });
  $("#btn-pair-approve").addEventListener("click", approvePairing);
  $("#btn-qq-login").addEventListener("click", () => startLogin("/api/channels/qq/login", "#qq-qr", "#qq-login-msg", refreshQQ));
  $("#btn-qq-refresh").addEventListener("click", () => { refreshQQ(true); refreshConnections(); });
  refreshWechat(); refreshPairing(); refreshQQ(); refreshConnections();
}
let connCardsCache = null; // 卡片列表（渲染换卡下拉用，变动少，缓存一份省一次请求
const connBusy = new Set(); // 正在换卡中的 bot id：该行渲染成「更换中…」转圈，防止后台静默重绘把它跳回老卡

async function refreshConnections() {
  const box = $("#conn-list");
  if (!box) return;
  // 先用快路径渲染（纯文件读，毫秒级），再后台跑自愈刷新一次——
  // 以前默认就跑 openclaw CLI 自愈，进页面/换卡后都要干等 5-15s 才看到结果
  const conn = await fetchConnections({ force: true });
  await renderConnections(conn);
  fetchConnections({ repair: true }).then((fresh) => {
    if (fresh && $("#conn-list")) renderConnections(fresh);
  }).catch(() => {});
}

async function renderConnections(connData) {
  const box = $("#conn-list");
  if (!box) return;
  try {
    const [conn, cards] = await Promise.all([
      connData ? Promise.resolve(connData) : fetchConnections({ force: true }),
      connCardsCache ? Promise.resolve(connCardsCache) : api.get("/api/cards").catch(() => ({ cards: [] })),
    ]);
    connCardsCache = cards;
    if (!conn) throw new Error("读取连接状态失败");
    const bots = conn.bots ?? [];
    const accounts = conn.accounts ?? [];
    const cardOpts = (cards.cards ?? []).map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join("");
    // 已绑定实例
    let html = "";
    const maxQq = conn.limits?.maxQq ?? 5;
    const maxWx = conn.limits?.maxWeixin ?? 1;
    const maxQqAcc = conn.limits?.maxQqAccounts ?? 5;
    const maxWxAcc = conn.limits?.maxWeixinAccounts ?? 2;
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
        const accName = b.accountLabel || b.accountId;
        // 换卡进行中：整行换成转圈状态，任何后台重绘都不会让它跳回老卡，成功后才一次到位
        if (connBusy.has(b.id) || connBusy.has(connBusyKey(b.channel, b.accountId))) {
          html += connBusyRow(b.channel, b.accountId, accName);
          continue;
        }
        html += `<div class="conn-row">
          <span class="chip" title="${escapeHtml(b.accountId)}">${connChannelTag(b.channel)} · ${escapeHtml(accName)}</span>
          <button class="ghost small-btn" data-acc-rename="${b.channel}|${escapeHtml(b.accountId)}" title="给这个账号起个昵称">✏️</button>
          <button class="danger small-btn" data-conn-del="${b.id}">解绑</button>
          <select class="conn-target" data-bot="${b.id}" data-cur="${escapeHtml(b.cardSlug)}" title="当前连接：${escapeHtml(cardName)}（可换卡）">${opts}</select>
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
        const accName = accountText(a);
        if (connBusy.has(connBusyKey(a.channel, a.accountId))) {
          html += connBusyRow(a.channel, a.accountId, accName);
          continue;
        }
        html += `<div class="conn-row">
          <span class="chip" title="${escapeHtml(a.accountId)}">${connChannelTag(a.channel)} · ${escapeHtml(accName)}</span>
          <button class="ghost small-btn" data-acc-rename="${a.channel}|${escapeHtml(a.accountId)}" title="给这个账号起个昵称">✏️</button>
          <button class="danger small-btn" data-acc-del="${a.channel}|${escapeHtml(a.accountId)}" title="删除这个账号（连凭证一起删，释放槽位）">删除</button>
          <select class="conn-cardpick" data-acc="${a.channel}|${escapeHtml(a.accountId)}"><option value="">选一张卡绑定…</option>${cardOpts}</select>
        </div>`;
      }
    }
    // 账号槽位用量：满了扫码按钮会被禁用，必须先彻底删一个
    const qqSlot = conn.slots?.qqbot ?? { used: 0, max: maxQqAcc };
    const wxSlot = conn.slots?.["openclaw-weixin"] ?? { used: 0, max: maxWxAcc };
    html += `<p class="hint" style="margin-top:8px">账号槽位：QQ ${qqSlot.used}/${qqSlot.max}${qqSlot.used >= qqSlot.max ? "（已存满）" : ""} · 微信 ${wxSlot.used}/${wxSlot.max}${wxSlot.used >= wxSlot.max ? "（已存满）" : ""}。存满后需先删除一个账号才能扫新码。QQ 可同时绑 ${maxQq} 张卡；微信同时只能绑 1 张，绑新卡时旧卡自动掉落。</p>`;
    box.innerHTML = html;
    // 事件
    box.querySelectorAll("[data-conn-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("解绑这个机器人实例？（账号凭证保留，可复用）")) return;
        const r = await api.send(`/api/bots/${b.dataset.connDel}`, { method: "DELETE" });
        toast("已解绑");
        await syncAfterBotChange();
      })
    );
    // 昵称：给账号起个自己认得的名字（底层仍按 accountId 路由）
    box.querySelectorAll("[data-acc-rename]").forEach((b) =>
      b.addEventListener("click", async () => {
        const [channel, accountId] = b.dataset.accRename.split("|");
        const cur = (conn.accounts ?? []).find((a) => a.channel === channel && a.accountId === accountId);
        const now = cur?.hasLabel ? cur.label : "";
        const next = prompt(`给账号起个昵称（留空恢复显示原编号）\n原编号：${accountId}`, now);
        if (next === null) return;
        try {
          await api.send("/api/channels/accounts/label", {
            method: "POST",
            body: JSON.stringify({ channel, accountId, label: next }),
          });
          toast(next.trim() ? "✓ 昵称已保存" : "已恢复显示原编号");
          await syncAfterBotChange();
        } catch (e) { toast("保存昵称失败：" + e.message, false); }
      })
    );
    // 彻底删除账号：连凭证一起删，腾出槽位（账号存满后加新号的唯一途径）
    box.querySelectorAll("[data-acc-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        const [channel, accountId] = b.dataset.accDel.split("|");
        const cur = (conn.accounts ?? []).find((a) => a.channel === channel && a.accountId === accountId);
        const nm = accountText(cur) || accountId;
        if (!confirm(`彻底删除账号「${nm}」？\n\n会删掉它的登录凭证和会话数据（不可恢复，要再用必须重新扫码），并释放一个账号槽位。\n平台侧（QQ 开放平台 / 微信）的机器人本身不受影响。`)) return;
        b.disabled = true; b.textContent = "删除中…";
        try {
          const r = await api.send("/api/channels/accounts/delete", {
            method: "POST",
            body: JSON.stringify({ channel, accountId }),
          });
          toast("✓ 账号已删除，槽位已释放");
          await syncAfterBotChange();
          refreshQQ(true); refreshWechat(true);
        } catch (e) {
          toast("删除失败：" + e.message, false);
          b.disabled = false; b.textContent = "删除";
        }
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
        // 立即进入「更换中…」转圈态：这行不再响应任何重绘（后台静默刷新也跳不回老卡），
        // 请求成功才由 syncAfterBotChange 一次性渲染成最终态，失败则还原
        const botId = sel.dataset.bot;
        connBusy.add(botId);
        renderConnections(conn); // 用当前快照重绘，busy 行会走转圈分支
        try {
          await api.send("/api/bots/transfer", { method: "POST", body: JSON.stringify({ botId, toCardSlug: sel.value }) });
          connBusy.delete(botId);
          toast("✓ 已换卡");
          await syncAfterBotChange(); // 一次到位：新卡 + 当前标志
        } catch (e) {
          connBusy.delete(botId);
          toast("换卡失败：" + e.message, false);
          // 还原列表（下拉回到老卡）
          const fresh = await fetchConnections({ force: true }).catch(() => null);
          if (fresh && $("#conn-list")) renderConnections(fresh);
        }
      })
    );
    box.querySelectorAll(".conn-cardpick").forEach((sel) =>
      sel.addEventListener("change", async () => {
        if (!sel.value) return;
        const [channel, accountId] = sel.dataset.acc.split("|");
        const accName = accountText((conn.accounts ?? []).find((a) => a.channel === channel && a.accountId === accountId)) || accountId;
        const occ = (conn.bots ?? []).find((b) => b.cardSlug === sel.value);
        const targetName = sel.options[sel.selectedIndex]?.textContent ?? sel.value;
        if (occ) {
          if (!confirm(`「${targetName}」已绑定「${occ.accountLabel || occ.accountId}」。\n\n确定换成账号「${accName}」吗？原绑定会解除（凭证保留）。`)) {
            sel.value = "";
            return;
          }
        }
        const busyKey = connBusyKey(channel, accountId);
        connBusy.add(busyKey);
        renderConnections(conn);
        try {
          if (occ) {
            // 同卡换账号：agent 还是这张卡的，只换绑账号，别删再建（慢而且同 slug 会打架）
            await api.send(`/api/bots/${occ.id}/bind`, { method: "POST", body: JSON.stringify({ channel, accountId }) });
            toast("✓ 已换成「" + accName + "」");
          } else {
            const r = await api.send("/api/bots", { method: "POST", body: JSON.stringify({ cardSlug: sel.value, channel, accountId }) });
            if (r.evicted?.length) toast(`✓ 已绑定，已卸下「${r.evicted.join("、")}」`);
            else toast("✓ 已绑定");
          }
          connBusy.delete(busyKey);
          await syncAfterBotChange();
        } catch (e) {
          connBusy.delete(busyKey);
          const msg = e.message || "";
          if (msg.includes("占用")) {
            toast("账号已被占用，可先在旧卡上换卡", false);
          } else {
            toast("绑定失败：" + msg, false);
          }
          const fresh = await fetchConnections({ force: true }).catch(() => null);
          if (fresh && $("#conn-list")) renderConnections(fresh);
        }
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
//  本地聊天的默认能力配置；聊天入口在侧边栏「通讯录」
//  四块：开关 / 默认能力 / 工作区概览
// ============================================================
function renderWorkbenchSettings() {
  return `
  <div class="view">
    <div class="page-head"><h2>工作台设置</h2><p class="hint">本地聊天从侧边栏「通讯录」进入；这里配置它的默认能力</p></div>

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


function initWorkbenchSettings() {
  // ---- 默认能力（未启用的功能对应的勾选框不会渲染，取值用可选链兜底） ----
  const def = capDefaults();
  const tools = def.tools ?? [];
  if ($("#cap-code")) $("#cap-code").checked = tools.includes("code_exec");
  if ($("#cap-file")) $("#cap-file").checked = tools.includes("sandbox_list");
  $("#cap-search").checked = tools.includes("web_search");
  $("#cap-weather").checked = tools.includes("weather");
  $("#cap-memory").checked = tools.includes("memory_save");
  $("#cap-thinking").value = def.thinking ?? "auto";
  $("#btn-cap-save").addEventListener("click", () => {
    const t = [];
    if ($("#cap-code")?.checked) t.push("code_exec");
    if ($("#cap-file")?.checked) t.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
    if ($("#cap-search").checked) t.push("web_search");
    if ($("#cap-weather").checked) t.push("weather");
    if ($("#cap-memory").checked) t.push("memory_save");
    saveCapDefaults({ tools: t, thinking: $("#cap-thinking").value });
    $("#cap-msg").textContent = "✓ 已保存";
  });

  if (FEATURES.workspace) wsLoadOverview();
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
//  视图：预设库（侧边栏「预设」）—— 档位/风格 = 预设组，组内一条一条条目
//  两级结构：首页只显示组名（看不见内容）→ 点进组看条目名 → 点条目单独编辑
// ============================================================
let presetStoreData = { tiers: [], styles: [] };
let presetView = null; // null=首页；{kind:'tier'|'style', groupId}=组内

/**
 * 读预设库。走缓存先渲染；**失败不再静默变空**（原来 catch 成空数组 →
 * 预设页只剩「新增档位/恢复内置」两个按钮，高级配置的档位/风格下拉也空白），
 * 失败时抛出让调用方显示错误 + 重试。
 */
async function loadPresetStore(onFresh) {
  presetStoreData = await cachedGet("/api/presets", (fresh) => {
    presetStoreData = fresh;
    if (onFresh) onFresh(fresh);
  });
  return presetStoreData;
}

const presetRoleLabel = (r) => (r === "user" ? "用户消息" : r === "assistant" ? "AI 消息" : "系统提示词");

/** 首页：只显示档位/风格组名，不显示内容 */
function renderPresets() {
  if (presetView) return renderPresetGroupView(presetView.kind, presetView.groupId);
  const groupCard = (kind, g) => {
    const locked = presetGroupLocked(kind, g.id);
    return `
    <div class="preset-group-card${locked ? " locked" : ""}" data-kind="${kind}" data-group="${escapeHtml(g.id)}" title="${locked ? "此预设仅管理员可查看" : "点击查看组内条目"}">
      <div class="preset-group-name">${escapeHtml(g.name)}${locked ? ` ${icon("shield")}` : ""}</div>
      <div class="preset-group-meta">${g.items.length} 条${g.builtin ? " · 内置" : ""}</div>
    </div>`;
  };
  // 档位区（对外叫「通用基础预设」）：按键只留「添加」；「恢复内置」按用户要求只在风格区保留
  const section = (kind, title, hint, groups) => `
    <div class="card-box">
      <h3>${icon("sliders")} ${title}</h3>
      <p class="hint">${hint}</p>
      <div class="preset-group-grid">
        ${groups.length ? groups.map((g) => groupCard(kind, g)).join("") : '<div class="muted">还没有组，点下方「新增」创建</div>'}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ghost small-btn preset-group-add" data-kind="${kind}">${icon("plus")} ${kind === "tier" ? "添加" : "新增" + (kind === "guard" ? "全局规则组" : "风格")}</button>
        ${kind === "tier" ? "" : `<button class="ghost small-btn preset-reset-all" data-kind="${kind}" style="margin-left:8px">恢复内置</button>`}
      </div>
    </div>`;
  return `
  <div class="view">
    <div class="page-head">
      <h2>${icon("sliders")} 角色扮演预设</h2>
      
    </div>
    ${section("tier", "通用基础预设", "", presetStoreData.tiers)}
    <div style="height:12px"></div>
    ${section("style", "风格", "", presetStoreData.styles)}
  </div>`;
}

/** 组内视图：只显示条目名与插入位置，点条目编辑 */
function renderPresetGroupView(kind, groupId) {
  const list = kind === "tier" ? presetStoreData.tiers : presetStoreData.styles;
  const g = list.find((x) => x.id === groupId);
  // 锁住的组连组内视图都不渲染（正常路径在点组卡那步就挡住了，这里兜底）
  if (!g || presetGroupLocked(kind, groupId)) { presetView = null; return renderPresets(); }
  return `
  <div class="view">
    <div class="page-head">
      <h2>${icon("sliders")} ${escapeHtml(g.name)}</h2>
      <p class="hint">组内 ${g.items.length} 条预设：点条目编辑内容与插入位置；条目名右侧显示插入位置。</p>
    </div>
    <div class="card-box">
      <div class="preset-list" id="preset-item-list">
        ${g.items.length ? g.items.map((it) => `
          <div class="preset-item" data-item="${escapeHtml(it.id)}">
            <div class="preset-item-head">
              <b>${escapeHtml(it.name)}</b>
              <span class="preset-badge ${it.builtin ? "builtin" : "custom"}">${it.builtin ? "内置" : "自定义"}</span>
              <span class="preset-badge" style="background:var(--bg-soft)">插入：${presetRoleLabel(it.role || "system")}</span>
              <div class="row" style="margin-left:auto">
                <button class="ghost small-btn preset-item-edit" title="编辑">${icon("pen")}</button>
                <button class="ghost small-btn preset-item-del" title="删除" ${it.builtin ? "disabled" : ""}>${icon("trash")}</button>
              </div>
            </div>
          </div>`).join("") : '<div class="muted">这个组还没有条目，点下方「新增条目」</div>'}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ghost small-btn preset-item-add">${icon("plus")} 新增条目</button>
        <button class="ghost small-btn preset-group-back" style="margin-left:8px">← 返回预设列表</button>
      </div>
    </div>
  </div>`;
}

async function initPresets() {
  presetView = null;
  // 有缓存时 loadPresetStore 立即返回旧数据（公网上省掉一次 0.5-1.7s 往返），
  // 后台刷新到新数据再重绘；失败显示错误 + 重试，不再静默只剩两个按钮
  try {
    await loadPresetStore(() => {
      if (!$("#view")) return;
      $("#view").innerHTML = renderPresets();
      bindPresets();
    });
  } catch (e) {
    $("#view").innerHTML = `<div class="view"><div class="page-head"><h2>${icon("sliders")} 角色扮演预设</h2></div>
      <div class="card-box"><div class="muted">读取预设失败：${escapeHtml(e.message)}</div>
      <div class="row" style="margin-top:10px"><button class="primary small-btn" id="presets-retry">重试</button></div></div></div>`;
    $("#presets-retry")?.addEventListener("click", initPresets);
    return;
  }
  $("#view").innerHTML = renderPresets();
  bindPresets();
}

function refreshPresetView() {
  // 预设改动后必须拿最新数据（不能吃缓存）
  cacheInvalidate("/api/presets");
  loadPresetStore()
    .then(() => {
      $("#view").innerHTML = renderPresets();
      bindPresets();
    })
    .catch((e) => toast("刷新预设失败：" + e.message, false));
}

function bindPresets() {
  // 条目编辑弹窗（组内条目：名称 + 插入位置 + 内容）
  const openItemEditor = (kind, groupId, item, isNew) => {
    const name = isNew ? "" : item.name;
    const content = isNew ? "" : item.content;
    const role = isNew ? "system" : item.role || "system";
    const overlay = document.createElement("div");
    overlay.className = "bot-overlay";
    overlay.id = "preset-editor-overlay";
    overlay.innerHTML = '<div class="bot-dialog adv-dialog" style="max-width:640px">' +
      '<div class="bot-dialog-head"><h3>' + (isNew ? "新增" : "编辑") + '条目' + (isNew ? "" : " · " + escapeHtml(item.name)) + '</h3>' +
      '<button class="ghost small-btn" id="pe-close">' + icon("x") + '</button></div>' +
      '<div class="bot-form">' +
      '<label>名称<input id="pe-name" value="' + escapeHtml(name) + '" placeholder="如：防神化"></label>' +
      '<label>插入位置<select id="pe-role">' +
      '<option value="system"' + (role === "system" ? " selected" : "") + '>系统提示词</option>' +
      '<option value="user"' + (role === "user" ? " selected" : "") + '>用户消息</option>' +
      '<option value="assistant"' + (role === "assistant" ? " selected" : "") + '>AI 消息</option>' +
      '</select></label>' +
      '<label>内容<textarea id="pe-content" rows="14" placeholder="这条预设的内容……">' + escapeHtml(content) + '</textarea></label>' +
      '<p class="hint">插入位置决定这条注入哪里：系统提示词 / 用户消息 / AI 消息（示范对话选 AI 消息或用户消息，注入对话开头供 AI 模仿）。</p>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end;margin-top:6px"><button id="pe-save" class="primary">保存</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#pe-close").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#pe-save").addEventListener("click", async () => {
      const name = overlay.querySelector("#pe-name").value.trim();
      const content = overlay.querySelector("#pe-content").value;
      const role = overlay.querySelector("#pe-role").value;
      try {
        if (isNew) {
          presetStoreData = await api.send("/api/presets/" + kind + "/" + groupId + "/items", { method: "POST", body: JSON.stringify({ name, content, role }) });
        } else {
          presetStoreData = await api.send("/api/presets/" + kind + "/" + groupId + "/items/" + item.id, { method: "PUT", body: JSON.stringify({ name, content, role }) });
        }
        overlay.remove();
        refreshPresetView();
        toast("✓ 已保存");
      } catch (e) {
        toast("保存失败：" + e.message, false);
      }
    });
  };

  // 首页：点组卡进入组内视图（内置档位组对普通用户锁住：点不动，只提示一句）
  document.querySelectorAll(".preset-group-card").forEach((card) => {
    card.addEventListener("click", () => {
      const kind = card.dataset.kind;
      const groupId = card.dataset.group;
      if (presetGroupLocked(kind, groupId)) {
        toast("这个预设不可编辑", false);
        return;
      }
      presetView = { kind, groupId };
      $("#view").innerHTML = renderPresets();
      bindPresets();
    });
  });
  // 首页：添加组（档位区按键叫「添加」，与「通用基础预设」的叫法统一，不再用"档位"这个词）
  document.querySelectorAll(".preset-group-add").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const kind = btn.dataset.kind;
      const name = prompt("新预设名称：");
      if (!name || !name.trim()) return;
      try {
        presetStoreData = await api.send("/api/presets", { method: "POST", body: JSON.stringify({ kind, name: name.trim() }) });
        refreshPresetView();
        toast("✓ 已创建，点进组添加条目");
      } catch (e) { toast("创建失败：" + e.message, false); }
    });
  });
  // 首页：恢复内置
  document.querySelectorAll(".preset-reset-all").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("恢复内置预设？自定义条目保留，内置条目的文本会重置为代码默认。")) return;
      try {
        presetStoreData = await api.send("/api/presets/reset", { method: "POST" });
        refreshPresetView();
        toast("✓ 已恢复内置");
      } catch (e) { toast("恢复失败：" + e.message, false); }
    });
  });
  // 组内：返回列表
  document.querySelectorAll(".preset-group-back").forEach((btn) => {
    btn.addEventListener("click", () => {
      presetView = null;
      refreshPresetView();
    });
  });
  // 组内：新增条目
  document.querySelectorAll(".preset-item-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = (presetView.kind === "tier" ? presetStoreData.tiers : presetStoreData.styles).find((x) => x.id === presetView.groupId);
      openItemEditor(presetView.kind, presetView.groupId, g, true);
    });
  });
  // 组内：条目编辑/删除
  document.querySelectorAll(".preset-item-edit, .preset-item-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = btn.closest(".preset-item");
      if (!row) return;
      const itemId = row.dataset.item;
      const g = (presetView.kind === "tier" ? presetStoreData.tiers : presetStoreData.styles).find((x) => x.id === presetView.groupId);
      const item = g && g.items.find((x) => x.id === itemId);
      if (!item) return;
      if (btn.classList.contains("preset-item-edit")) {
        openItemEditor(presetView.kind, presetView.groupId, item, false);
      } else {
        if (!confirm("删除条目「" + item.name + "」？")) return;
        api.send("/api/presets/" + presetView.kind + "/" + presetView.groupId + "/items/" + itemId, { method: "DELETE" })
          .then((data) => { presetStoreData = data; refreshPresetView(); toast("已删除"); })
          .catch((err) => toast("删除失败：" + err.message, false));
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
  // 设置菜单：长条按键，点击进入各自独立页面
  const row = (route, iconName, title, desc, badge) => `
    <a class="setting-row" href="#/${route}" data-route="${route}">
      <span class="sr-icon">${icon(iconName)}</span>
      <div class="sr-body">
        <div class="sr-title">${title}${badge ? ` <span class="plug-badge">${badge}</span>` : ""}</div>
        <div class="sr-desc">${desc}</div>
      </div>
      <span class="sr-chevron">${icon("chevron")}</span>
    </a>`;
  // 运行日志 / 插件是运营向的（后端对设备 403），分发用户整行不出现——包括分隔与留白
  const adminRows = ocIsDevice()
    ? ""
    : `${row("logs", "clipboard", "运行日志", "聊天 / 通道 / 生图 / 语音 / 记忆的报错记录，出问题先看这里（留最近 500 条）")}
      `;
  const pluginRow = ocIsDevice() ? "" : `${row("plugins", "store", "插件", "已安装插件只读列表", "暂未开放")}
      `;
  return `
  <div class="view">
    <div class="page-head"><h2>设置</h2></div>
    <div class="setting-rows">
      ${adminRows}${row("device", "tool", "我的设备 ID", "记住它：服务器最多保存 15 天聊天记录，删了可凭 ID 恢复")}
      ${row("storage", "database", "本地存储", "图片与语音存放在这台设备上：占用统计 / 保存位置 / 自动保存 / 压缩 / 删除")}
      ${pluginRow}${row("data", "package", "数据备份与记忆", "全部卡片 + 记忆 + 配置导出为 JSON；查看全部记忆")}
    </div>
  </div>`;
}
function initSettings() {
  // 服务状态点仍然要亮（原来挂在服务信息块里）
  api.get("/api/health").then(() => {
    $("#drawer-meta").textContent = `SoulBox`;
    $("#svc-dot").classList.add("on");
  }).catch(() => { $("#svc-dot").classList.add("bad"); });
}

// 设置子页统一返回按钮（放在 page-head，点击回设置菜单）
function settingsBack() {
  return `<a class="btn-back" href="#/settings">${icon("chevron")} 返回设置</a>`;
}

// ---- 设置子页：运行日志 ----
function renderLogsPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>${icon("clipboard")} 运行日志</h2><p class="hint">出问题先看这里：聊天、通道、生图、语音、记忆的报错都会记下来。只留最近 500 条。</p>${settingsBack()}</div>
    <div class="card-box">
      <h3>${icon("zap")} 模型缓存统计 <button id="cache-refresh" class="ghost small-btn">刷新</button></h3>
      <div id="cache-stats" class="small-out" style="max-height:200px;overflow-y:auto;margin-bottom:1rem">加载中…</div>
    </div>
    <div class="card-box">
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
  </div>`;
}
function initLogsPage() {
  loadCacheStats();
  $("#cache-refresh").addEventListener("click", loadCacheStats);
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
}

async function loadCacheStats() {
  const box = $("#cache-stats");
  if (!box) return;
  try {
    const data = await api.get("/api/llm/usage");
    const rows = data?.byModel ?? [];
    if (!rows.length) {
      box.innerHTML = '<div class="muted">暂无统计数据（发起聊天后会记录）</div>';
      return;
    }
    const pct = (r) => Math.round((r.hitRate ?? 0) * 100);
    let html =
      `<div style="margin-bottom:0.6rem"><strong>合计</strong>：输入 ${data.promptTokens.toLocaleString()} · ` +
      `输出 ${data.completionTokens.toLocaleString()} · 缓存命中 ${data.cacheHitTokens.toLocaleString()}` +
      `（<strong>${pct(data)}%</strong>）· 调用 ${data.calls} 次 · 近 24h ${data.last24h} 次</div>`;
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.85em">';
    html += '<tr style="text-align:left;opacity:0.7"><th>模型</th><th>命中率</th><th>输入</th><th>输出</th><th>调用</th></tr>';
    for (const m of rows) {
      html += `<tr><td>${escapeHtml(m.id)}</td><td><strong>${pct(m)}%</strong></td>` +
        `<td>${m.promptTokens.toLocaleString()}</td><td>${m.completionTokens.toLocaleString()}</td><td>${m.calls}</td></tr>`;
    }
    html += "</table>";
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

// ---- 设置子页：插件（只读） ----
function renderPluginsPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>${icon("store")} 插件 <span class="plug-badge">暂未开放</span></h2><p class="hint">插件功能暂未开放（正在评估可用性）。已安装的插件会继续生效，但市场浏览、安装、卸载等操作暂不提供；开放后会回到这里。</p>${settingsBack()}</div>
    <div class="card-box">
      <div id="plug-installed-ro" class="small-out tall">加载中…</div>
    </div>
  </div>`;
}
function initPluginsPage() {
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
}

// ---- 设置子页：数据备份与记忆 ----
function renderDataPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>${icon("package")} 数据备份与记忆</h2><p class="hint">全部卡片 + 记忆 + 各项配置 → 一个 JSON 文件；下面是每张卡的长期记忆</p>${settingsBack()}</div>
    <div class="two-col">
      <div class="card-box">
        <h3>${icon("package")} 数据备份</h3>
        <p class="hint">全部卡片 + 记忆 + 各项配置 → 一个 JSON 文件</p>
        <button id="btn-backup" class="primary">下载备份</button>
      </div>
      <div class="card-box">
        <h3>全部记忆</h3>
        <div id="memory-list" class="small-out tall"></div>
      </div>
    </div>
  </div>`;
}
function initDataPage() {
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
          `${f}\n  ` + (entries || []).map((e) => `${e.important ? "【关键】" : ""}${e.fact}${(e.keywords ?? []).length ? "  #" + e.keywords.join(" #") : ""}`).join("\n  ")).join("\n\n")
      : "（还没有记忆）";
  }).catch(() => {});
}

// ---- 设置子页：首页公告 ----
function renderNoticePage() {
  return `
  <div class="view">
    <div class="page-head"><h2>${icon("message")} 首页公告</h2><p class="hint">编辑展示在首页的公告内容</p>${settingsBack()}</div>
    <div class="card-box">
      <div class="form">
        <label>展示在首页公告卡（支持换行，留空则首页显示「暂无公告」）</label>
        <textarea id="notice-text" rows="5" maxlength="2000"></textarea>
        <div class="row"><button id="notice-save" class="primary">${icon("save")} 保存公告</button></div>
        <div id="notice-msg" class="status"></div>
      </div>
    </div>
  </div>`;
}
function initNoticePage() {
  api.get("/api/announcement").then((a) => { $("#notice-text").value = a.text ?? ""; }).catch(() => {});
  $("#notice-save").addEventListener("click", async () => {
    try {
      await api.send("/api/announcement", { method: "POST", body: JSON.stringify({ text: $("#notice-text").value }) });
      $("#notice-msg").textContent = "✓ 已保存";
      toast("✓ 公告已更新");
    } catch (e) { $("#notice-msg").textContent = "保存失败：" + e.message; }
  });
}

// ============================================================
//  技能库（内置只读 + 用户自定义增删改）
// ============================================================
// ============================================================
//  视图：表情包库（全局共享，所有角色卡共用）
// ============================================================
function renderEmojis() {
  return `
  <div class="view">
    <div class="page-head">
      <h2>表情包库</h2>
    </div>
    <div class="card-box">
      <h3>分组</h3>
      <div class="emoji-groups" id="em-groups"></div>
    </div>
    <div class="card-box">
      <h3>添加表情 <span class="hint" id="em-cur-group-hint"></span></h3>
      <div class="form">
        <div class="cf-grid2">
          <div><label>表情名</label><input id="em-name" placeholder="如：得意、无语、抱抱"></div>
          <div><label>什么场合用</label><input id="em-exp" placeholder="如：调皮得意，占了上风的时候"></div>
        </div>
        <label>图片（png / jpg / gif / webp）</label>
        <input type="file" id="em-file" accept=".png,.jpg,.jpeg,.gif,.webp">
        <div class="row">
          <button id="em-add" class="primary">${icon("plus")} 添加到当前分组</button>
          <span id="em-msg" class="status"></span>
        </div>
        <div class="row" style="margin-top:12px;align-items:center;gap:8px;flex-wrap:wrap">
          <button id="em-zip" class="ghost small-btn">${icon("package")} 导入表情包 zip</button>
          <input type="file" id="em-zip-file" accept=".zip,application/zip" hidden>
          <span class="hint">一整包导入：zip 里放 <b>1.大笑.gif</b>、<b>2.偷笑.gif</b>… 外加一份 <b>说明.txt</b>（按序号填使用场景，留空也行）。图片文件夹用 scripts/make-emoji-pack.bat 一键就能打成这种包。</span>
        </div>
      </div>
    </div>
    <div class="card-box">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 style="margin:0">「<span id="em-group-title">默认</span>」里的表情 <span id="em-count" class="hint"></span></h3>
        <button id="em-import" class="ghost small-btn" title="把其他分组的表情复制到当前分组（共用同一张图，不重复存文件）">${icon("download")} 从其他分组导入</button>
      </div>
      <div id="em-list" class="emoji-grid"></div>
    </div>
  </div>`;
}

let emojiGroups = [];        // 分组列表
let emojiCurGroup = "default"; // 当前选中分组

function initEmojis() {
  $("#em-add").addEventListener("click", addEmojiToLib);
  $("#em-zip").addEventListener("click", () => $("#em-zip-file").click());
  $("#em-zip-file").addEventListener("change", importEmojiZip);
  $("#em-import").addEventListener("click", openEmojiImport);
  loadEmojiList();
}

/** 从其他分组导入：选来源分组 → 勾选表情 → 路径复用导入当前分组（不复制图片文件） */
function openEmojiImport() {
  const others = emojiGroups.filter((g) => g.id !== emojiCurGroup);
  if (!others.length) return toast("没有其他分组可导入", false);
  const ov = document.createElement("div");
  ov.className = "bot-overlay";
  ov.id = "emoji-import-overlay";
  ov.innerHTML = `<div class="bot-dialog" style="max-width:460px">
    <div class="bot-dialog-head">
      <h3>从其他分组导入</h3>
      <button class="ghost small-btn" id="emoji-import-close">${icon("x")}</button>
    </div>
    <label>来源分组</label>
    <select id="emoji-import-src" style="width:100%">
      ${others.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")}
    </select>
    <div id="emoji-import-pool" class="emoji-grid" style="margin-top:10px;max-height:300px;overflow-y:auto"></div>
    <p class="hint" id="emoji-import-tip" style="margin-top:6px">点击图片勾选；导入共用原图不重复存文件，重名会自动加序号</p>
    <div class="row" style="justify-content:flex-end;margin-top:6px">
      <span class="muted" id="emoji-import-count">已选 0 个</span>
      <button class="ghost small-btn" id="emoji-import-cancel">取消</button>
      <button class="primary small-btn" id="emoji-import-ok">导入到当前分组</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const picked = new Set();
  const renderPool = () => {
    const gid = $("#emoji-import-src").value;
    const pool = emojiLib.filter((e) => e.group === gid);
    $("#emoji-import-pool").innerHTML = pool.length
      ? pool.map((e) => `<div class="emoji-item emoji-pick${picked.has(e.id) ? " picked" : ""}" data-id="${escapeHtml(e.id)}">
          <img src="${escapeHtml(e.url)}" alt="${escapeHtml(e.name)}" loading="lazy">
          <div class="emoji-name">${escapeHtml(e.name)}</div>
        </div>`).join("")
      : '<div class="muted">这个分组还没有表情</div>';
    $("#emoji-import-pool").querySelectorAll(".emoji-pick").forEach((el) =>
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        if (picked.has(id)) { picked.delete(id); el.classList.remove("picked"); }
        else { picked.add(id); el.classList.add("picked"); }
        const c = $("#emoji-import-count");
        if (c) c.textContent = `已选 ${picked.size} 个`;
      })
    );
  };
  renderPool();
  $("#emoji-import-src").addEventListener("change", renderPool);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $("#emoji-import-close").addEventListener("click", close);
  $("#emoji-import-cancel").addEventListener("click", close);
  $("#emoji-import-ok").addEventListener("click", async () => {
    if (!picked.size) return toast("先勾选要导入的表情", false);
    try {
      const r = await api.send("/api/emojis/import", { method: "POST", body: JSON.stringify({ ids: [...picked], group: emojiCurGroup }) });
      toast(`✓ 已导入 ${r.imported.length} 个（共用原图）`);
      close();
      cacheInvalidate("/api/emojis");
      await loadEmojiList();
    } catch (e) { toast("导入失败：" + e.message, false); }
  });
}

/** 渲染分组标签栏 */
function renderEmojiGroups() {
  const box = $("#em-groups");
  if (!box) return;
  const countByGroup = {};
  for (const e of emojiLib) countByGroup[e.group] = (countByGroup[e.group] ?? 0) + 1;
  const tabs = emojiGroups
    .map((g) => {
      const cnt = countByGroup[g.id] ?? 0;
      const extra = g.builtin
        ? ""
        : `<span class="g-rename" title="重命名分组" data-gr="${escapeHtml(g.id)}">${icon("pen")}</span>
           <span class="g-del" title="删除分组（组内表情移回默认）" data-gd="${escapeHtml(g.id)}">${icon("trash")}</span>`;
      return `<span class="emoji-group-tab${g.id === emojiCurGroup ? " on" : ""}" data-g="${escapeHtml(g.id)}">
        ${escapeHtml(g.name)}<span class="g-count">${cnt}</span>${extra}
      </span>`;
    })
    .join("");
  box.innerHTML = tabs + `<button class="emoji-group-add" id="em-group-add">＋ 新建分组</button>`;
  box.querySelectorAll("[data-g]").forEach((t) =>
    t.addEventListener("click", (e) => {
      if (e.target.closest("[data-gr]") || e.target.closest("[data-gd]")) return; // 管理按钮不切分组
      emojiCurGroup = t.dataset.g;
      renderEmojiGroups();
      renderEmojiList();
    })
  );
  box.querySelectorAll("[data-gr]").forEach((b) =>
    b.addEventListener("click", async () => {
      const g = emojiGroups.find((x) => x.id === b.dataset.gr);
      if (!g) return;
      const name = prompt("分组名", g.name);
      if (!name || name === g.name) return;
      try {
        await api.send(`/api/emojis/groups/${g.id}`, { method: "PUT", body: JSON.stringify({ name }) });
        toast("✓ 已重命名");
        cacheInvalidate("/api/emojis");
        await loadEmojiList();
      } catch (e) { toast(e.message, false); }
    })
  );
  box.querySelectorAll("[data-gd]").forEach((b) =>
    b.addEventListener("click", async () => {
      const g = emojiGroups.find((x) => x.id === b.dataset.gd);
      if (!g) return;
      if (!confirm(`删除分组「${g.name}」？组内表情会移回「默认」分组。`)) return;
      try {
        await api.send(`/api/emojis/groups/${g.id}`, { method: "DELETE" });
        if (emojiCurGroup === g.id) emojiCurGroup = "default";
        toast("✓ 已删除");
        cacheInvalidate("/api/emojis");
        await loadEmojiList();
      } catch (e) { toast(e.message, false); }
    })
  );
  $("#em-group-add").addEventListener("click", async () => {
    const name = prompt("新分组名");
    if (!name) return;
    try {
      await api.send("/api/emojis/groups", { method: "POST", body: JSON.stringify({ name }) });
      toast("✓ 已创建");
      cacheInvalidate("/api/emojis");
      await loadEmojiList();
    } catch (e) { toast(e.message, false); }
  });
}

async function loadEmojiList() {
  const box = $("#em-list");
  try {
    // 走缓存先渲染（公网上省掉一次往返）；库内 CRUD 都会 cacheInvalidate 后再调本函数，
    // 所以增删改后拿到的一定是新数据
    const r = await cachedGet("/api/emojis");
    emojiLib = r.emojis ?? [];
    emojiGroups = r.groups ?? [];
    if ($("#em-count")) {
      const cnt = emojiLib.filter((e) => e.group === emojiCurGroup).length;
      $("#em-count").textContent = `${cnt} / ${r.max ?? 300}`;
    }
    if ($("#em-group-title")) $("#em-group-title").textContent = emojiGroups.find((g) => g.id === emojiCurGroup)?.name ?? "默认";
    renderEmojiGroups();
    renderEmojiList();
  } catch (e) {
    if (box) box.innerHTML = `<div class="muted">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderEmojiList() {
  const box = $("#em-list");
  if (!box) return;
  const items = emojiLib.filter((e) => e.group === emojiCurGroup);
  if (!items.length) {
    box.innerHTML = '<div class="muted">这个分组还没有表情，上面添加第一个</div>';
    return;
  }
  // 紧凑格子：只显示图 + 名字；点击弹出单个表情的放大详情（含解释与全部操作）
  box.innerHTML = items
    .map(
      (e) => `<div class="emoji-item" data-id="${escapeHtml(e.id)}" title="点击查看大图与操作">
        <img src="${escapeHtml(e.url)}" alt="${escapeHtml(e.name)}" loading="lazy">
        <div class="emoji-name">${escapeHtml(e.name)}</div>
      </div>`
    )
    .join("");
  box.querySelectorAll(".emoji-item").forEach((el) =>
    el.addEventListener("click", () => {
      const item = emojiLib.find((x) => x.id === el.dataset.id);
      if (item) openEmojiDetail(item);
    })
  );
}

/** 单个表情的放大详情：大图 + 解释 + 全部操作（编辑/删除/移动/复制） */
function openEmojiDetail(item) {
  const others = emojiGroups.filter((g) => g.id !== emojiCurGroup);
  const ov = document.createElement("div");
  ov.className = "bot-overlay";
  ov.id = "emoji-detail-overlay";
  ov.innerHTML = `<div class="bot-dialog emoji-detail">
    <div class="bot-dialog-head">
      <h3>${escapeHtml(item.name)}</h3>
      <button class="ghost small-btn" id="emoji-detail-close">${icon("x")}</button>
    </div>
    <img class="emoji-detail-img" src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}">
    <p class="emoji-detail-exp">${escapeHtml(item.explanation || "（未写用法）")}</p>
    <div class="row" style="justify-content:center">
      <button class="ghost small-btn" data-act="edit">编辑</button>
      <button class="danger small-btn" data-act="del">删除</button>
    </div>
    ${others.length ? `<div class="row" style="justify-content:center;margin-top:6px">
      <select class="em-detail-move">
        <option value="">移动/复制到其他分组…</option>
        ${others.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")}
      </select>
      <button class="ghost small-btn" data-act="move">移动</button>
      <button class="ghost small-btn" data-act="copy">复制</button>
    </div>` : ""}
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $("#emoji-detail-close").addEventListener("click", close);
  ov.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "edit") { close(); editEmoji(item); return; }
      if (act === "del") { close(); delEmoji(item); return; }
      if (act === "move" || act === "copy") {
        const target = ov.querySelector(".em-detail-move").value;
        if (!target) return toast("先选一个目标分组", false);
        try {
          await api.send(`/api/emojis/${item.id}/move`, { method: "POST", body: JSON.stringify({ group: target, copy: act === "copy" }) });
          toast(act === "copy" ? "✓ 已复制" : "✓ 已移动");
          close();
          cacheInvalidate("/api/emojis");
          await loadEmojiList();
        } catch (e) { toast(e.message, false); }
      }
    })
  );
}

/** 编辑表情：名称 + 适用场合同一个弹窗一起改（原来连弹两个 prompt，第二个会被浏览器拦掉） */
function editEmoji(item) {
  const ov = document.createElement("div");
  ov.className = "bot-overlay";
  ov.id = "emoji-edit-overlay";
  ov.innerHTML = `<div class="bot-dialog" style="max-width:420px">
    <div class="bot-dialog-head">
      <h3>编辑表情</h3>
      <button class="ghost small-btn" id="emoji-edit-close">${icon("x")}</button>
    </div>
    <div class="form">
      <label>表情名</label>
      <input id="emoji-edit-name" value="${escapeHtml(item.name)}">
      <label>什么场合用（给 AI 看）</label>
      <input id="emoji-edit-exp" value="${escapeHtml(item.explanation || "")}">
      <div class="row" style="justify-content:flex-end;margin-top:6px">
        <button class="ghost small-btn" id="emoji-edit-cancel">取消</button>
        <button class="primary small-btn" id="emoji-edit-save">保存</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $("#emoji-edit-close").addEventListener("click", close);
  $("#emoji-edit-cancel").addEventListener("click", close);
  $("#emoji-edit-save").addEventListener("click", async () => {
    const name = $("#emoji-edit-name").value.trim();
    if (!name) return toast("表情名不能为空", false);
    try {
      await api.send(`/api/emojis/${item.id}`, { method: "POST", body: JSON.stringify({ name, explanation: $("#emoji-edit-exp").value.trim() }) });
      toast("✓ 已保存");
      close();
      cacheInvalidate("/api/emojis");
      await loadEmojiList();
    } catch (e) { toast("保存失败：" + e.message, false); }
  });
}

/**
 * 表情包 zip 批量导入：先 dryRun 出预览 → 用户确认 → 再真导入。
 * zip 交后端解析（序号/名字/编码/分组/重名都在那边处理），这里只管确认与报告。
 */
async function importEmojiZip() {
  const input = $("#em-zip-file");
  const f = input?.files?.[0];
  if (!f) return;
  const btn = $("#em-zip");
  const raw = async (dryRun) => {
    const r = await fetchApi(`/api/emojis/import-zip${dryRun ? "?dryRun=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: f,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  };
  btn.disabled = true;
  try {
    const preview = await raw(true);
    if (!preview.count) {
      toast("这个包里没有能导入的表情", false);
      return;
    }
    const renamed = (preview.items || []).filter((x) => x.renamedFrom).length;
    const lines = [
      `将导入 ${preview.count} 个表情`,
      preview.groupsToCreate?.length ? `新建分组：${preview.groupsToCreate.join("、")}` : "",
      renamed ? `重名自动改名：${renamed} 个` : "",
      preview.problemCount ? `有问题跳过/改动：${preview.problemCount} 项` : "",
      "",
      (preview.items || []).slice(0, 12).map((x) => `${x.name}${x.scene ? "（" + x.scene.slice(0, 16) + "）" : ""}${x.renamedFrom ? " ← 原「" + x.renamedFrom + "」" : ""}`).join("\n"),
      preview.count > 12 ? `…还有 ${preview.count - 12} 个` : "",
      "",
      "确认导入？",
    ].filter(Boolean);
    if (!confirm(lines.join("\n"))) return;
    const done = await raw(false);
    toast(`✓ 已导入 ${done.added?.length ?? 0} 个表情`);
    const problems = done.problems || [];
    if (problems.length) {
      alert(`导入完成，${done.skipped ?? 0} 个未导入/被改名：\n\n` + problems.slice(0, 12).map((p) => `· ${p.what}：${p.reason}`).join("\n"));
    }
    cacheInvalidate("/api/emojis");
    await loadEmojiLib();
    await loadEmojiList();
  } catch (e) {
    toast("导入失败：" + e.message, false);
  } finally {
    btn.disabled = false;
    input.value = "";
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
    // 二进制直传：跳过 FileReader/base64/JSON，大图导入更快
    const ext = (f.name.split(".").pop() || "png").toLowerCase();
    const q = new URLSearchParams({ name, ext, exp: $("#em-exp").value.trim(), group: emojiCurGroup }).toString();
    const r = await fetchApi("/api/emojis/raw?" + q, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: f,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    $("#em-name").value = "";
    $("#em-exp").value = "";
    $("#em-file").value = "";
    toast("✓ 已添加");
    cacheInvalidate("/api/emojis");
    await loadEmojiList();
  } catch (e) {
    toast("添加失败：" + e.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function delEmoji(item) {
  if (!confirm(`删除表情「${item.name}」？`)) return;
  try {
    await api.send(`/api/emojis/${item.id}`, { method: "DELETE" });
    toast("✓ 已删除");
    cacheInvalidate("/api/emojis");
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
  chats: { render: renderChats, init: initChats },          // 通讯录（微信式会话列表）
  chat: { render: renderWorkbench, init: initWorkbench },   // 本地聊天（从通讯录点进来，整页接管）
  chatinfo: { render: renderChatInfo, init: initChatInfo }, // 单卡聊天设置（三个点进来）
  chatsearch: { render: renderChatSearch, init: initChatSearch }, // 聊天记录搜索页（图片/时间筛选）
  chatmem: { render: renderChatMem, init: initChatMem },     // 聊天记忆页（本地/群聊二分）
  chatwb: { render: renderChatWb, init: initChatWb },        // 世界书查看页
  chatrx: { render: renderChatRx, init: initChatRx },        // 正则查看页
  apiprovider: { render: renderProviderEdit, init: initProviderEdit }, // API 提供商编辑二级页
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
  // 设置子页（设置菜单里长条按键跳转过来）
  logs: { render: renderLogsPage, init: initLogsPage },
  plugins: { render: renderPluginsPage, init: initPluginsPage },
  data: { render: renderDataPage, init: initDataPage },
  notice: { render: renderNoticePage, init: initNoticePage },
  workbench: { render: renderWorkbenchSettings, init: initWorkbenchSettings },
  capabilities: { render: renderWorkbenchSettings, init: initWorkbenchSettings }, // 旧地址 #/capabilities 兼容
  settings: { render: renderSettings, init: initSettings },
  storage: { render: () => ocRenderStoragePage(), init: () => { ocSt.view = "overview"; ocBindStorage(); } },
  imgsave: { render: () => ocRenderImgSave(), init: () => ocInitImgSave() },
  login: { render: renderAdminLogin, init: initAdminLogin },
  users: { render: renderUsersPage, init: initUsersPage },
  usercards: { render: renderUserCards, init: initUserCards },
  userchats: { render: renderUserChats, init: initUserChats },
  device: { render: renderDevicePage, init: initDevicePage },
};

$("#btn-menu").addEventListener("click", openDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);
$("#drawer-user-btn").addEventListener("click", openProfileDialog);
document.querySelectorAll(".drawer-nav a").forEach((a) => a.addEventListener("click", closeDrawer));
// 抽屉导航注入线性 SVG 图标（替代 emoji）
document.querySelectorAll(".drawer-nav a").forEach((a) => {
  a.insertAdjacentHTML("afterbegin", icon(a.dataset.icon));
});
// 首屏启动调用已移到文件末尾（本地媒体库的 const 状态声明之后执行），
// 否则 #/storage 首次进入会撞 TDZ：Cannot access 'ocSt' before initialization

// ==================== 本地媒体库（图片 / 语音） ====================
// 设计：图片与语音存用户浏览器 IndexedDB（磁盘，不占内存）；用户可选保存到本地文件夹。
// NAI 图 = 只存记录（url+提示词），显示走上游 URL，URL 死了读文件夹里的文件，再不行显示提示词卡片；
// OpenAI 图 = 字节从服务器内存图库拉进 IndexedDB（服务器不留）；语音 = 朗读缓存，重听不再合成。
const OC_DB_NAME = "ocs-media";
/** url → 提示词：会话记录里带着生图元数据，历史渲染建记录时用它补上提示词 */
const ocUrlPrompt = new Map();
let ocDbPromise = null;
function ocMediaDB() {
  if (ocDbPromise) return ocDbPromise;
  ocDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OC_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("images")) {
        const s = db.createObjectStore("images", { keyPath: "id" });
        s.createIndex("by-url", "url", { unique: false });
        s.createIndex("by-slug", "slug", { unique: false });
      }
      if (!db.objectStoreNames.contains("audio")) {
        const s = db.createObjectStore("audio", { keyPath: "id" });
        s.createIndex("by-slug", "slug", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return ocDbPromise;
}
async function ocTx(store, mode, fn) {
  const db = await ocMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const ocImgPut = (rec) => ocTx("images", "readwrite", (s) => s.put(rec));
const ocImgDel = (id) => ocTx("images", "readwrite", (s) => s.delete(id));
const ocImgGetByUrl = (url) => ocTx("images", "readonly", (s) => s.index("by-url").get(url)).then((r) => r || null);
const ocMetaGet = (k) => ocTx("meta", "readonly", (s) => s.get(k)).then((r) => r?.v ?? null);
const ocMetaPut = (k, v) => ocTx("meta", "readwrite", (s) => s.put({ k, v }));
/** 流式遍历图片记录（只留元数据，逐条释放，防大库 OOM——同 RP-Hub 的游标做法） */
function ocImgForEach(cb) {
  return ocMediaDB().then(
    (db) =>
      new Promise((resolve) => {
        const req = db.transaction(["images"], "readonly").objectStore("images").openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          try {
            const v = c.value;
            cb({ id: v.id, url: v.url, slug: v.slug, provider: v.provider, prompt: v.prompt, fileRel: v.fileRel, savedAt: v.savedAt, createdAt: v.createdAt, bytes: v.blob?.size || 0, deleted: !!v.deleted });
          } catch { /* 单条出错不影响整体 */ }
          c.continue();
        };
        req.onerror = () => resolve();
      })
  );
}
/** 生图响应入库：NAI 存 url 记录；OpenAI 顺手把字节拉进本地（服务器只暂存 2 小时） */
async function ocSaveImageMeta(r, slug) {
  try {
    const metas = Array.isArray(r?.images) ? r.images : [];
    if (!metas.length) return;
    for (const m of metas) {
      const url = String(m?.url || "");
      if (!url || url.startsWith("/img/")) continue; // 旧 /img 本地图不入库
      if (m?.prompt) ocUrlPrompt.set(url, String(m.prompt));
      if (await ocImgGetByUrl(url).catch(() => null)) continue;
      const rec = {
        id: "i_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        url,
        provider: url.startsWith("/api/image/") ? "openai" : "nai",
        slug: slug || "",
        prompt: String(m?.prompt || ""),
        blob: null,
        fileRel: "",
        savedAt: 0,
        createdAt: Date.now(),
      };
      if (rec.provider === "openai") {
        const resp = await fetchApi(url).catch(() => null);
        if (resp?.ok) rec.blob = await resp.blob().catch(() => null);
      }
      await ocImgPut(rec).catch(() => {});
      // 自动保存（默认关）：NAI 图经服务器代理拉一次字节写进文件夹；OpenAI 图本来就在应用内本地
      if (rec.provider === "nai" && ocTgl("ocs_as_nai", false)) void ocSaveRecords([rec]);
    }
  } catch (e) {
    console.warn("图片入库失败：", e);
  }
}
/** 渲染链：本地有副本就用本地（NAI=已保存文件；OpenAI=IndexedDB blob），上游 URL 只做即时显示 */
async function ocHydrateChatImage(img, url) {
  try {
    let rec = await ocImgGetByUrl(url).catch(() => null);
    // 已删除（墓碑）：只显示提示词占位，不重新加载、不二次生图
    if (rec?.deleted) {
      ocShowDeadCard(img, rec, "图片已删除");
      return;
    }
    // 已有记录但缺提示词（老数据/历史建的记录）→ 用会话里的元数据补上
    if (rec && !rec.prompt && ocUrlPrompt.get(url)) {
      rec.prompt = ocUrlPrompt.get(url);
      await ocImgPut(rec).catch(() => {});
    }
    if (!rec) {
      if (url.startsWith("/api/image/")) {
        const resp = await fetchApi(url).catch(() => null);
        if (resp?.ok) {
          const blob = await resp.blob();
          rec = { id: "i_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), url, provider: "openai", slug: wbSlug || "", prompt: "", blob, fileRel: "", savedAt: 0, createdAt: Date.now() };
          await ocImgPut(rec).catch(() => {});
        }
      } else if (/^https?:/i.test(url)) {
        // 历史里的 NAI 图（例如重启后从会话记录渲染出来）也要入库，才能在存储页管理与删除
        rec = {
          id: "i_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          url,
          provider: "nai",
          slug: wbSlug || "",
          prompt: ocUrlPrompt.get(url) || "",
          blob: null,
          fileRel: "",
          savedAt: 0,
          createdAt: Date.now(),
        };
        await ocImgPut(rec).catch(() => {});
      }
      if (!rec) return;
    }
    if (rec.blob) {
      img.src = URL.createObjectURL(rec.blob);
      return;
    }
    if (rec.provider === "nai" && rec.fileRel) {
      const blob = await ocReadSavedFile(rec.fileRel).catch(() => null);
      if (blob) img.src = URL.createObjectURL(blob);
    }
  } catch { /* 交给 onerror 链 */ }
}
/** 图片加载失败兜底链：NAI 本地文件 → 提示词卡片（绝不把 URL 露给用户当文本） */
async function ocImgFail(img, url) {
  try {
    const rec = await ocImgGetByUrl(url).catch(() => null);
    if (rec?.deleted) {
      ocShowDeadCard(img, rec, "图片已删除");
      return;
    }
    if (rec) {
      if (rec.blob) {
        img.src = URL.createObjectURL(rec.blob);
        return;
      }
      if (rec.fileRel) {
        const blob = await ocReadSavedFile(rec.fileRel).catch(() => null);
        if (blob) {
          img.src = URL.createObjectURL(blob);
          return;
        }
      }
    }
    ocShowDeadCard(img, rec);
  } catch {
    ocShowDeadCard(img, null);
  }
}
function ocShowDeadCard(img, rec, title) {
  const prompt = String(rec?.prompt || "").trim();
  const box = document.createElement("div");
  box.className = "chat-img-dead";
  box.innerHTML =
    `<div class="cid-t">${escapeHtml(title || "图片已过期（上游只保存约 15 天）")}</div>` +
    (prompt
      ? `<div class="cid-p">${escapeHtml(prompt.slice(0, 200))}${prompt.length > 200 ? "…" : ""}</div>` +
        `<button type="button" class="ghost small-btn cid-copy">复制提示词</button>`
      : `<div class="cid-p">没有记录到提示词</div>`);
  const btn = box.querySelector(".cid-copy");
  if (btn)
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        toast("提示词已复制，可粘贴到聊天里重新生成");
      } catch {
        toast("复制失败，请手动选中复制", false);
      }
    });
  img.replaceWith(box);
}

// ---------- 文件夹保存（File System Access API；手机浏览器不支持 → 退回下载文件夹） ----------
function ocTgl(key, def) {
  const v = localStorage.getItem(key);
  return v === null ? def : v === "1";
}
const ocDirSupported = typeof window.showDirectoryPicker === "function" || ocHasNative("pickFolder");
/** 套壳里的保存文件夹是壳用 SAF 选的（授权持久化在壳里，重启依然有效），名字由壳提供 */
function ocNativeFolderName() {
  try {
    return ocHasNative("getFolderName") ? String(ocNative.getFolderName() || "") : "";
  } catch {
    return "";
  }
}
/** 壳里选完文件夹会回调这个（原生侧 onActivityResult 里 evaluateJavascript 调用） */
if (typeof window !== "undefined") {
  window.soulboxOnFolderPicked = function () {
    void ocFillDirName();
    ocStCache = null; // 文件夹变了，存储页统计作废
  };
}
async function ocPickSaveDir() {
  if (!ocDirSupported) {
    toast("这个浏览器不支持选择文件夹，保存会直接进「下载」文件夹", false);
    return null;
  }
  if (ocHasNative("pickFolder")) {
    // 原生：弹系统文件夹选择器（结果通过 soulboxOnFolderPicked 回调，授权持久化）
    try {
      ocNative.pickFolder();
      toast("选好文件夹就会记住，以后批量保存不再问");
    } catch (e) {
      toast("无法打开文件夹选择器", false);
      console.warn(e);
    }
    return null;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: "readwrite", id: "ocs-save" });
    await ocMetaPut("dirHandle", h).catch(() => {});
    await ocMetaPut("dirName", h.name).catch(() => {});
    toast(`保存位置已设为：${h.name}`);
    return h;
  } catch {
    return null; // 用户取消
  }
}
/** 取目录句柄并确保权限（浏览器重启后首次会被问一次，点「允许」即可；Chrome 可选「每次访问都允许」） */
async function ocEnsureDirPerm() {
  const h = await ocMetaGet("dirHandle").catch(() => null);
  if (!h) return null;
  try {
    let p = await h.queryPermission({ mode: "readwrite" });
    if (p !== "granted") {
      // requestPermission 需要用户手势：自动保存时若刚点过发送通常也算，失败就静默跳过
      p = await h.requestPermission({ mode: "readwrite" });
    }
    return p === "granted" ? h : null;
  } catch {
    return null;
  }
}
async function ocWriteToFolder(slug, blob) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
  const name = `${ts}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  // 套壳：写进壳里已授权的文件夹（按卡建子目录，重名自动加序号），不弹框
  if (!ocHasNative("saveToFolder") && ocHasNative("pickFolder")) return "";
  if (ocHasNative("saveToFolder")) {
    try {
      const b64 = await ocBlobToBase64(blob);
      const ok = ocNative.saveToFolder(String(slug || "未分类"), name, blob.type || "image/png", b64);
      return ok ? `${slug || "未分类"}/${name}` : "";
    } catch (e) {
      console.warn("写入原生文件夹失败：", e);
      return "";
    }
  }
  const h = await ocEnsureDirPerm().catch(() => null);
  if (!h) return "";
  try {
    const dir = await h.getDirectoryHandle(String(slug || "未分类"), { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return `${slug || "未分类"}/${name}`;
  } catch (e) {
    console.warn("写入文件夹失败：", e);
    return "";
  }
}
async function ocReadSavedFile(rel) {
  // 套壳的文件夹是 SAF 目录（按名字回读不划算）：这里跳过，显示链会退到"提示词卡片"
  if (ocHasNative("saveToFolder")) return null;
  const h = await ocMetaGet("dirHandle").catch(() => null);
  if (!h || !rel) return null;
  const parts = String(rel).split("/");
  if (parts.length !== 2) return null;
  const p = await h.queryPermission({ mode: "readwrite" }).catch(() => "denied");
  if (p !== "granted") {
    const rp = await h.requestPermission({ mode: "readwrite" }).catch(() => "denied");
    if (rp !== "granted") return null;
  }
  const dir = await h.getDirectoryHandle(parts[0]);
  const fh = await dir.getFileHandle(parts[1]);
  return await fh.getFile();
}
async function ocRemoveSavedFile(rel) {
  // 套壳的 SAF 文件夹：应用不去删用户文件（要在文件管理器里删，或换保存位置）
  if (ocHasNative("saveToFolder")) return;
  try {
    const h = await ocEnsureDirPerm();
    if (!h || !rel) return;
    const parts = String(rel).split("/");
    if (parts.length !== 2) return;
    const dir = await h.getDirectoryHandle(parts[0]);
    await dir.removeEntry(parts[1]);
  } catch { /* 文件已被用户删掉等情况，忽略 */ }
}
/** 压缩开关（服务端配置，保存文件用 WebP） */
async function ocCompressEnabled() {
  try {
    const cfg = await api.get("/api/image/config");
    return cfg?.compression?.enabled === true;
  } catch {
    return false;
  }
}
async function ocSetCompress(on) {
  const p = await api.send("/api/image/config", { method: "POST", body: JSON.stringify({ compression: { enabled: !!on } }) });
  return !!p?.ok;
}
async function ocToWebp(blob, q = 0.85) {
  try {
    if (blob.type === "image/webp") return blob;
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    cv.getContext("2d").drawImage(bmp, 0, 0);
    const out = await new Promise((res) => cv.toBlob(res, "image/webp", q));
    if (out && out.size > 0 && out.size < blob.size) return out;
    return blob;
  } catch {
    return blob;
  }
}
/** 下载兜底（没有文件夹权限时）：套壳走原生保存对话框，浏览器直接进「下载」文件夹 */
async function ocDownloadBlob(blob, name) {
  if (ocHasNative("saveFile")) {
    try {
      const b64 = await ocBlobToBase64(blob);
      if (ocNativeSave(name, blob.type || "application/octet-stream", b64)) return;
    } catch (e) {
      console.warn("原生保存失败，退回浏览器下载：", e);
    }
  }
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}
/**
 * 批量保存：NAI 图经服务器代理拉字节（绕 CORS）；压缩开 → WebP。
 * 有文件夹 → 写进「保存位置/角色卡名/时间戳.webp」；没有 → 下载到下载文件夹。
 */
async function ocSaveRecords(records) {
  records = records.filter((r) => !r.deleted); // 墓碑记录不参与保存
  const compress = await ocCompressEnabled().catch(() => false);
  let ok = 0;
  let fail = 0;
  let usedFolder = false;
  for (const rec of records) {
    try {
      let bytes = rec.blob || null;
      if (!bytes && rec.url && /^https?:/i.test(rec.url)) {
        const resp = await fetchApi(`/api/image/fetch?url=${encodeURIComponent(rec.url)}${compress ? "&fmt=webp" : ""}`);
        if (!resp.ok) throw new Error("上游图片拉取失败");
        bytes = await resp.blob();
      }
      if (!bytes) throw new Error("没有图片数据");
      if (compress) bytes = await ocToWebp(bytes);
      const rel = await ocWriteToFolder(rec.slug || "未分类", bytes);
      if (rel) usedFolder = true;
      else {
        // 没有可用文件夹（没选位置/没授权/套壳里没选过）→ 走导出兜底，保证用户拿到图
        await ocDownloadBlob(bytes, `${rec.slug || "image"}_${(rec.id || "").slice(2, 8)}.${bytes.type === "image/webp" ? "webp" : bytes.type === "image/jpeg" ? "jpg" : "png"}`);
      }
      rec.fileRel = rel;
      rec.savedAt = Date.now();
      if (rec.provider !== "openai") rec.blob = null; // NAI 图不入 IndexedDB（文件夹就是它的家）
      await ocImgPut(rec).catch(() => {});
      ok++;
    } catch (e) {
      fail++;
      console.warn("保存失败：", e);
    }
  }
  return { ok, fail, usedFolder };
}

// ---------- 语音缓存（朗读音频存本地，重听不再合成） ----------
function ocAudioKey(slug, text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `a_${slug}_${(h >>> 0).toString(36)}`;
}
async function ocAudioGet(id) {
  const r = await ocTx("audio", "readonly", (s) => s.get(id)).catch(() => null);
  if (!r || r.deleted) return null; // 已删除（墓碑）→ 不再合成
  return r.blob || null;
}
async function ocAudioPut(id, slug, text, blob) {
  await ocTx("audio", "readwrite", (s) => s.put({ id, slug, text, blob, size: blob.size, createdAt: Date.now() }));
}
function ocAudioForEach(cb) {
  return ocMediaDB().then(
    (db) =>
      new Promise((resolve) => {
        const req = db.transaction(["audio"], "readonly").objectStore("audio").openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          try {
            const v = c.value;
            cb({ id: v.id, slug: v.slug, text: v.text, size: v.size || v.blob?.size || 0, createdAt: v.createdAt, deleted: !!v.deleted });
          } catch { /* 忽略单条 */ }
          c.continue();
        };
        req.onerror = () => resolve();
      })
  );
}
const ocFmtSize = (n) =>
  !n
    ? "0 B"
    : n > 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

// ---------- 设置 → 本地存储（RP-Hub 式：空间条 + 分类占用 + 按角色卡钻取） ----------
const ocSt = { view: "overview", slug: "", name: "" };
let ocStCache = null; // 本次进视图的扫描结果（浏览器 + 服务端 + 用户文件夹）
const ocStColors = { chat: "#1677ff", card: "#f59e0b", mem: "#8b5cf6", img: "#1677ff", au: "#22c55e" };

function ocStGo(view, slug, name) {
  ocSt.view = view;
  if (slug !== undefined) ocSt.slug = slug;
  if (name !== undefined) ocSt.name = name;
  // 不主动统计：缓存跨视图/进出保留，只有用户点「重新统计」或删除后才重算
  const host = $("#view");
  if (!host) return;
  host.innerHTML = ocRenderStoragePage();
  ocBindStorage();
  host.scrollTop = 0;
}
function ocStHead(title, backTo) {
  return `<div class="page-head">
    <button class="ghost small-btn" data-back="${backTo}">← 返回</button>
    <h2>${title}</h2>
  </div>`;
}
function ocStRow(label, valueHtml, color, go) {
  return `<div class="oc-row"${go ? ` data-go="${go}"` : ""}>
    ${color ? `<span class="oc-bar" style="background:${color}"></span>` : ""}
    <span class="oc-row-label">${label}</span>
    <span class="oc-row-val">${valueHtml}</span>
    ${go ? `<span class="oc-chev">›</span>` : ""}
  </div>`;
}
function ocRenderStoragePage() {
  if (ocSt.view === "chats") return ocRenderCatPage("聊天记录", "chats", ocStColors.chat);
  if (ocSt.view === "cards") return ocRenderCatPage("角色卡", "cards", ocStColors.card);
  if (ocSt.view === "mems") return ocRenderCatPage("记忆", "mems", ocStColors.mem);
  if (ocSt.view === "img_card") return ocRenderImgCard();
  if (ocSt.view === "au_card") return ocRenderAuCard();
  return ocRenderStOverview();
}
function ocRenderStOverview() {
  return `
  <div class="view">
    <div class="page-head"><h2>${icon("database")} 本地存储</h2>${settingsBack()}</div>

    <div class="card-box oc-card">
      <div class="oc-card-head">
        <h3>网页存储空间</h3>
        <button id="oc-calc" class="ghost small-btn">重新统计</button>
      </div>
      <div class="oc-space-row"><span class="oc-space-val" id="oc-usage-text">—</span><span class="oc-space-total" id="oc-quota-text"></span></div>
      <div class="oc-meter"><i id="oc-meter-fill" style="width:0%"></i></div>
    </div>

    <div class="card-box oc-card">
      <h3>分类占用</h3>
      <div class="oc-rows">
        ${ocStRow("聊天记录", '<span id="oc-chat-total">—</span>', ocStColors.chat, "chats")}
        ${ocStRow("角色卡", '<span id="oc-card-total">—</span>', ocStColors.card, "cards")}
        ${ocStRow("记忆", '<span id="oc-mem-total">—</span>', ocStColors.mem, "mems")}
      </div>
    </div>

    <div class="card-box oc-card">
      <h3>保存设置</h3>
      <div class="oc-rows">
        <div class="oc-row">
          <span class="oc-row-label">保存位置</span>
          <span class="oc-row-val" id="oc-dir-name"></span>
          <button id="oc-pick-dir" class="ghost small-btn"${ocDirSupported ? "" : " disabled"}>选择文件夹</button>
        </div>
        <div class="oc-row">
          <span class="oc-row-label">自动保存 NAI 图</span>
          <label class="switch"><input type="checkbox" id="oc-as-nai"><span class="slider"></span></label>
        </div>
        <div class="oc-row">
          <span class="oc-row-label">保存时压缩</span>
          <label class="switch"><input type="checkbox" id="oc-compress"><span class="slider"></span></label>
        </div>
      </div>
    </div>
  </div>`;
}
function ocRenderCatPage(title, kind, color) {
  return `
  <div class="view">
    ${ocStHead(title, "overview")}
    <div class="card-box oc-card">
      <div class="oc-rows" id="oc-${kind}-list"><div class="oc-empty">统计中…</div></div>
    </div>
  </div>`;
}
function ocRenderImgCard() {
  return `
  <div class="view">
    ${ocStHead(escapeHtml(ocSt.name || ocSt.slug), "chats")}
    <div class="card-box oc-card">
      <div class="oc-card-head"><h3>图片</h3><button id="oc-del-all" class="danger small-btn">全部删除</button></div>
      <div class="oc-grid" id="oc-grid"><div class="oc-empty">统计中…</div></div>
    </div>
  </div>`;
}
function ocRenderAuCard() {
  return `
  <div class="view">
    ${ocStHead(escapeHtml(ocSt.name || ocSt.slug), "chats")}
    <div class="card-box oc-card">
      <div class="oc-card-head"><h3>语音</h3><button id="oc-del-all-au" class="danger small-btn">全部删除</button></div>
      <div class="oc-rows" id="oc-au-rows"><div class="oc-empty">统计中…</div></div>
    </div>
  </div>`;
}
function ocBindStorage() {
  document.querySelectorAll("#view [data-back]").forEach((b) =>
    b.addEventListener("click", () => ocStGo(b.dataset.back))
  );
  document.querySelectorAll("#view .oc-row[data-go]").forEach((r) =>
    r.addEventListener("click", () => ocStGo(r.dataset.go))
  );
  if (ocSt.view === "overview") {
    $("#oc-pick-dir")?.addEventListener("click", async () => {
      if (!ocDirSupported) return;
      const h = await ocPickSaveDir();
      if (h) await ocFillDirName();
    });
    $("#oc-calc")?.addEventListener("click", () => {
      const t = $("#oc-usage-text");
      if (t) t.textContent = "统计中…";
      void ocFillOverview(true);
    });
    const nai = $("#oc-as-nai");
    if (nai) {
      nai.checked = ocTgl("ocs_as_nai", false);
      nai.addEventListener("change", () => localStorage.setItem("ocs_as_nai", nai.checked ? "1" : "0"));
    }
    const cpx = $("#oc-compress");
    if (cpx) {
      ocCompressEnabled().then((on) => { cpx.checked = on; });
      cpx.addEventListener("change", async () => {
        const ok = await ocSetCompress(cpx.checked).catch(() => false);
        if (!ok) {
          cpx.checked = !cpx.checked;
          toast("保存失败", false);
        }
      });
    }
    void ocFillDirName();
    void ocFillOverview();
    return;
  }
  if (ocSt.view === "chats") return void ocFillChats();
  if (ocSt.view === "cards") return void ocFillCat("card");
  if (ocSt.view === "mems") return void ocFillCat("mem");
  if (ocSt.view === "img_card") return void ocFillImgCard();
  if (ocSt.view === "au_card") return void ocFillAuCard();
}

async function ocFillDirName() {
  const el = $("#oc-dir-name");
  if (!el) return;
  if (!ocDirSupported) {
    el.textContent = "";
    return;
  }
  // 套壳：文件夹由壳管理（SAF 持久授权），名字直接问壳
  if (ocHasNative("getFolderName")) {
    const n = ocNativeFolderName();
    el.textContent = n || "未选择";
    return;
  }
  const h = await ocMetaGet("dirHandle").catch(() => null);
  if (!h) {
    el.textContent = "未选择";
    return;
  }
  const name = await ocMetaGet("dirName").catch(() => null);
  let perm = "prompt";
  try { perm = await h.queryPermission({ mode: "readwrite" }); } catch { /* 忽略 */ }
  el.textContent = (name || "已选择") + (perm === "granted" ? "" : " · 待授权");
}
async function ocCardName(slug) {
  return (await api.get(`/api/cards/${encodeURIComponent(slug)}`).catch(() => null))?.name || slug;
}
/** 一次扫描拿全三类数据：服务端（聊天/角色卡/记忆/服务器图片）+ 浏览器（图片/语音）+ 用户文件夹
 *  force=true 强制重算（用户点「重新统计」）；否则命中缓存直接返回 */
async function ocStData(force) {
  if (ocStCache && !force) return ocStCache;
  const d = {
    usage: 0, quota: 0,
    serverCards: [], totals: { chat: 0, mem: 0, card: 0, img: 0 },
    browserImgs: [], browserAu: [],
    legacy: new Map(), folder: new Map(),
  };
  try {
    const e = await navigator.storage.estimate();
    d.usage = e.usage || 0;
    d.quota = e.quota || 0;
  } catch { /* 部分浏览器不支持 */ }
  await ocImgForEach((m) => { if (!m.deleted) d.browserImgs.push(m); });
  await ocAudioForEach((m) => { if (!m.deleted) d.browserAu.push(m); });
  const sb = await api.get("/api/storage/breakdown").catch(() => null);
  if (sb) {
    d.serverCards = sb.cards ?? [];
    d.totals = sb.totals ?? d.totals;
  }
  const lg = await api.get("/api/image/list").catch(() => null);
  for (const it of lg?.images ?? []) {
    if (!d.legacy.has(it.dir)) d.legacy.set(it.dir, []);
    d.legacy.get(it.dir).push(it);
  }
  const h = await ocMetaGet("dirHandle").catch(() => null);
  if (h) {
    let perm = "denied";
    try { perm = await h.queryPermission({ mode: "readwrite" }); } catch { /* 忽略 */ }
    if (perm === "granted") {
      try {
        for await (const [name, handle] of h.entries()) {
          if (handle.kind !== "directory") continue;
          const files = [];
          let bytes = 0;
          for await (const [fname, fh] of handle.entries()) {
            if (fh.kind !== "file") continue;
            const f = await fh.getFile().catch(() => null);
            if (!f) continue;
            bytes += f.size;
            files.push({ name: fname, size: f.size, mtime: f.lastModified || 0, rel: `${name}/${fname}` });
          }
          d.folder.set(name, { bytes, files });
        }
      } catch (e) {
        console.warn("读取保存文件夹失败：", e);
      }
    }
  }
  ocStCache = d;
  return d;
}
/** 按角色卡合并三类数据（服务端占用 + 浏览器图片/语音 + 服务器历史图 + 文件夹） */
function ocStMerged(d) {
  const m = new Map();
  const get = (slug) => {
    if (!m.has(slug)) {
      m.set(slug, { slug, name: slug, chat: 0, mem: 0, card: 0, serverImg: 0, records: [], audio: [], legacy: [], folder: { bytes: 0, files: [] } });
    }
    return m.get(slug);
  };
  for (const c of d.serverCards) {
    const x = get(c.slug);
    x.name = c.name || c.slug;
    x.chat = c.chat || 0;
    x.mem = c.mem || 0;
    x.card = c.card || 0;
    x.serverImg = c.img || 0;
  }
  for (const r of d.browserImgs) get(r.slug || "未分类").records.push(r);
  for (const a of d.browserAu) get(a.slug || "未分类").audio.push(a);
  for (const [slug, items] of d.legacy) get(slug).legacy = items;
  for (const [slug, f] of d.folder) get(slug).folder = f;
  return m;
}
function ocStTotal(x) {
  const recBytes = x.records.reduce((s, r) => s + (r.bytes || 0), 0);
  const auBytes = x.audio.reduce((s, a) => s + (a.size || 0), 0);
  const legacyBytes = x.legacy.reduce((s, l) => s + (l.size || 0), 0);
  return x.chat + x.mem + x.card + x.serverImg + recBytes + auBytes + legacyBytes + x.folder.bytes;
}
async function ocStFixNames(merged) {
  for (const x of merged.values()) {
    if (!x.name || x.name === x.slug) x.name = await ocCardName(x.slug);
  }
}
async function ocFillOverview(force) {
  if (ocSt.view !== "overview" || !$("#oc-usage-text")) return;
  // 不主动统计：没有缓存且不是用户点「重新统计」→ 显示占位，等用户点
  if (!ocStCache && !force) {
    const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    set("#oc-usage-text", "—");
    set("#oc-quota-text", "");
    set("#oc-chat-total", "—");
    set("#oc-card-total", "—");
    set("#oc-mem-total", "—");
    const fill = $("#oc-meter-fill");
    if (fill) fill.style.width = "0%";
    return;
  }
  const d = await ocStData(force);
  if (ocSt.view !== "overview" || !$("#oc-usage-text")) return;
  $("#oc-usage-text").textContent = ocFmtSize(d.usage);
  $("#oc-quota-text").textContent = d.quota ? `/ ${ocFmtSize(d.quota)}` : "";
  const fill = $("#oc-meter-fill");
  if (fill) fill.style.width = Math.min(100, d.quota ? (d.usage / d.quota) * 100 : 0) + "%";
  const browserImg = d.browserImgs.reduce((s, r) => s + (r.bytes || 0), 0);
  const browserAu = d.browserAu.reduce((s, a) => s + (a.size || 0), 0);
  const folder = [...d.folder.values()].reduce((s, f) => s + f.bytes, 0);
  const legacy = [...d.legacy.values()].reduce((s, arr) => s + arr.reduce((t, i) => t + (i.size || 0), 0), 0);
  const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  set("#oc-chat-total", ocFmtSize(d.totals.chat + browserImg + browserAu + folder + legacy));
  set("#oc-card-total", ocFmtSize(d.totals.card));
  set("#oc-mem-total", ocFmtSize(d.totals.mem));
}
async function ocFillChats() {
  const d = await ocStData();
  const box = $("#oc-chats-list");
  if (!box) return;
  const merged = ocStMerged(d);
  await ocStFixNames(merged);
  const list = [...merged.values()].filter((x) => ocStTotal(x) > 0 || x.records.length || x.audio.length);
  list.sort((a, b) => ocStTotal(b) - ocStTotal(a));
  if (!list.length) {
    box.innerHTML = `<div class="oc-empty">暂无记录</div>`;
    return;
  }
  box.innerHTML = "";
  for (const x of list) {
    const row = document.createElement("div");
    row.className = "oc-row";
    row.innerHTML = `
      <span class="oc-bar" style="background:${ocStColors.chat}"></span>
      <span class="oc-row-label">${escapeHtml(x.name)}</span>
      <span class="oc-row-val">${ocFmtSize(ocStTotal(x))}</span>
      <button class="ghost small-btn oc-more-btn">更多</button>`;
    const panel = document.createElement("div");
    panel.className = "oc-more-panel";
    panel.hidden = true;
    const imgBtn = document.createElement("button");
    imgBtn.className = "ghost small-btn";
    const imgCount = x.records.length + x.legacy.length + x.folder.files.length;
    imgBtn.textContent = `图片${imgCount ? ` ${imgCount}` : ""}`;
    imgBtn.addEventListener("click", () => ocStGo("img_card", x.slug, x.name));
    const auBtn = document.createElement("button");
    auBtn.className = "ghost small-btn";
    auBtn.textContent = `语音${x.audio.length ? ` ${x.audio.length}` : ""}`;
    auBtn.addEventListener("click", () => ocStGo("au_card", x.slug, x.name));
    panel.append(imgBtn, auBtn);
    row.querySelector(".oc-more-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    box.append(row, panel);
  }
}
async function ocFillCat(kind) {
  const d = await ocStData();
  const box = $("#oc-" + (kind === "card" ? "cards" : "mems") + "-list");
  if (!box) return;
  const merged = ocStMerged(d);
  await ocStFixNames(merged);
  const list = [...merged.values()].filter((x) => (kind === "card" ? x.card : x.mem) > 0);
  list.sort((a, b) => (kind === "card" ? b.card - a.card : b.mem - a.mem));
  if (!list.length) {
    box.innerHTML = `<div class="oc-empty">暂无数据</div>`;
    return;
  }
  const color = kind === "card" ? ocStColors.card : ocStColors.mem;
  box.innerHTML = list
    .map(
      (x) => `<div class="oc-row">
        <span class="oc-bar" style="background:${color}"></span>
        <span class="oc-row-label">${escapeHtml(x.name)}</span>
        <span class="oc-row-val">${ocFmtSize(kind === "card" ? x.card : x.mem)}</span>
      </div>`
    )
    .join("");
}
async function ocFillImgCard() {
  const d = await ocStData();
  const merged = ocStMerged(d);
  const x = merged.get(ocSt.slug);
  const grid = $("#oc-grid");
  if (!grid) return;
  // 三类图片混排成一条时间线（最新在前）：本机记录 / 服务器历史图 / 已保存到文件夹的文件
  const items = [];
  for (const r of x?.records ?? []) items.push({ kind: "record", ts: r.createdAt || 0, rec: r });
  for (const l of x?.legacy ?? []) items.push({ kind: "legacy", ts: l.mtime || 0, legacy: l });
  for (const f of x?.folder?.files ?? []) items.push({ kind: "folder", ts: f.mtime || 0, file: f });
  items.sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    grid.innerHTML = `<div class="oc-empty">暂无图片</div>`;
    return;
  }
  grid.innerHTML = "";
  for (const it of items) grid.appendChild(ocImgCell(it));
  $("#oc-del-all")?.addEventListener("click", async () => {
    if (!confirm(`删除「${ocSt.name || ocSt.slug}」的 ${items.length} 张图片？`)) return;
    for (const it of items) {
      if (it.kind === "record") await ocDeleteImageRecord(it.rec);
      else if (it.kind === "legacy") await api.send("/api/image/delete", { method: "POST", body: JSON.stringify({ url: it.legacy.url }) }).catch(() => {});
      else await ocRemoveSavedFile(it.file.rel);
    }
    void ocStAfterDelete();
  });
}
/** 图片格子（三种来源统一渲染：状态/大小角标 + 右上删除 + 点击看大图） */
function ocImgCell(it) {
  const cell = document.createElement("div");
  cell.className = "oc-cell";
  const img = document.createElement("img");
  img.alt = "图片";
  img.loading = "lazy";
  const mark = document.createElement("span");
  mark.className = "oc-cell-mark";
  const del = document.createElement("button");
  del.className = "oc-cell-del";
  del.title = "删除";
  del.textContent = "✕";
  cell.append(img, mark, del);
  const guard = (fn) => async (e) => {
    e.stopPropagation();
    if (!confirm("删除这张图片？")) return;
    await fn();
    void ocStAfterDelete();
  };
  if (it.kind === "record") {
    const r = it.rec;
    cell.dataset.id = r.id;
    mark.textContent = r.savedAt ? "已存文件" : r.provider === "nai" ? "仅链接" : "应用内";
    del.addEventListener("click", guard(() => ocDeleteImageRecord(r)));
    cell.addEventListener("click", (e) => { if (e.target !== del && img.src) showLightbox(img.src); });
    ocLazyThumb(img, r);
    return cell;
  }
  if (it.kind === "legacy") {
    const l = it.legacy;
    img.src = l.url; // 同源 /img/ 直出
    mark.textContent = ocFmtSize(l.size || 0);
    del.addEventListener("click", guard(() => api.send("/api/image/delete", { method: "POST", body: JSON.stringify({ url: l.url }) }).catch(() => {})));
    cell.addEventListener("click", (e) => { if (e.target !== del) showLightbox(l.url); });
    return cell;
  }
  const f = it.file;
  mark.textContent = ocFmtSize(f.size || 0);
  void (async () => {
    const b = await ocReadSavedFile(f.rel).catch(() => null);
    if (b) img.src = URL.createObjectURL(b);
  })();
  del.addEventListener("click", guard(() => ocRemoveSavedFile(f.rel)));
  cell.addEventListener("click", (e) => { if (e.target !== del && img.src) showLightbox(img.src); });
  return cell;
}
/** 删除后：缓存作废并原地刷新当前视图（数字跟着变；只有删除会触发重算） */
async function ocStAfterDelete() {
  ocStCache = null;
  if (ocSt.view === "img_card") return void ocFillImgCard();
  if (ocSt.view === "au_card") return void ocFillAuCard();
  if (ocSt.view === "chats") return void ocFillChats();
  if (ocSt.view === "cards") return void ocFillCat("card");
  if (ocSt.view === "mems") return void ocFillCat("mem");
  return void ocFillOverview(true);
}
async function ocFillAuCard() {
  const d = await ocStData();
  const merged = ocStMerged(d);
  const items = (merged.get(ocSt.slug)?.audio ?? []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const box = $("#oc-au-rows");
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="oc-empty">暂无语音</div>`;
    return;
  }
  box.innerHTML = "";
  let curAudio = null;
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "oc-row";
    const txt = String(it.text || "");
    row.innerHTML = `<span class="oc-au-text">${escapeHtml(txt.slice(0, 40))}${txt.length > 40 ? "…" : ""}</span><span class="oc-row-val">${ocFmtSize(it.size || 0)}</span>`;
    const play = document.createElement("button");
    play.className = "ghost small-btn";
    play.textContent = "▶";
    play.addEventListener("click", async () => {
      const blob = await ocAudioGet(it.id);
      if (!blob) return toast("语音已删除", false);
      if (curAudio) curAudio.pause();
      curAudio = new Audio(URL.createObjectURL(blob));
      void curAudio.play().catch(() => {});
    });
    const del = document.createElement("button");
    del.className = "danger small-btn";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      await ocAudioDelete(it.id, it.slug, it.text);
      void ocStAfterDelete();
    });
    row.append(play, del);
    box.appendChild(row);
  }
  $("#oc-del-all-au")?.addEventListener("click", async () => {
    if (!confirm(`删除「${ocSt.name || ocSt.slug}」的 ${items.length} 条语音？`)) return;
    for (const it of items) await ocAudioDelete(it.id, it.slug, it.text);
    void ocStAfterDelete();
  });
}

/** 缩略图加载：直接取源（延迟交给 img 的 loading="lazy"）。
 *  之前用 IntersectionObserver，在 #view 这个自滚动容器里实测不触发，导致空格子。 */
function ocLazyThumb(img, it) {
  const load = async () => {
    if (it.provider === "openai" && it.bytes === 0 && it.savedAt === 0) {
      img.src = it.url;
      return;
    }
    if (it.provider === "nai" && !it.savedAt) {
      img.src = it.url;
      return;
    }
    if (it.fileRel) {
      const b = await ocReadSavedFile(it.fileRel).catch(() => null);
      if (b) { img.src = URL.createObjectURL(b); return; }
    }
    const rec = await ocTx("images", "readonly", (s) => s.get(it.id)).catch(() => null);
    if (rec?.blob) img.src = URL.createObjectURL(rec.blob);
    else img.src = it.url;
  };
  void load();
}
/**
 * 删除图片：清掉本地 blob、删掉文件夹里的文件，但保留一条「墓碑」记录——
 * 聊天里那张图从此只显示提示词占位，且绝不触发二次生图。
 */
async function ocDeleteImageRecord(it) {
  if (it.fileRel) await ocRemoveSavedFile(it.fileRel);
  const rec = await ocTx("images", "readonly", (s) => s.get(it.id)).catch(() => null);
  await ocImgPut({
    id: it.id,
    url: it.url || rec?.url || "",
    slug: it.slug || rec?.slug || "",
    provider: it.provider || rec?.provider || "nai",
    prompt: it.prompt || rec?.prompt || "",
    blob: null,
    fileRel: "",
    savedAt: 0,
    createdAt: it.createdAt || rec?.createdAt || Date.now(),
    deleted: true,
  }).catch(() => {});
}
/** 删除语音：同样留墓碑（保住正文文本），聊天气泡再点朗读提示已删除、不再重新合成 */
async function ocAudioDelete(id, slug, text) {
  await ocTx("audio", "readwrite", (s) =>
    s.put({ id, slug, text: String(text || ""), blob: null, size: 0, createdAt: Date.now(), deleted: true })
  ).catch(() => {});
}

// ---------- 聊天设置 → 保存图片（批量多选，微信式） ----------
function ocRenderImgSave() {
  return `
  <div class="view">
    <div class="page-head">
      <button id="oims-back" class="ghost small-btn">← 返回</button>
      <h2>保存图片到本地</h2>
      <p class="hint">勾选要保存的图片，点「保存」。</p>
    </div>
    <div class="card-box">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button id="oims-all" class="ghost small-btn">全选</button>
        <span class="hint" id="oims-count">已选 0 张</span>
        <button id="oims-save" class="small-btn">保存</button>
      </div>
    </div>
    <div class="card-box"><div id="oims-grid" class="oc-grid">读取中…</div></div>
  </div>`;
}
function ocInitImgSave() {
  const m = (location.hash || "").match(/[?&]slug=([^&]+)/);
  const slug = m ? decodeURIComponent(m[1]) : chatSettingsSlug || localStorage.getItem("ocs_workbench_slug") || "";
  $("#oims-back").addEventListener("click", () => {
    location.hash = `#/chatinfo?slug=${encodeURIComponent(slug)}`;
  });
  const grid = $("#oims-grid");
  const selected = new Set();
  const items = [];
  const refreshCount = () => { $("#oims-count").textContent = `已选 ${selected.size} 张`; };
  $("#oims-all").addEventListener("click", () => {
    const all = selected.size === items.length;
    selected.clear();
    if (!all) items.forEach((i) => selected.add(i.id));
    grid.querySelectorAll(".oc-cell").forEach((c) => c.classList.toggle("sel", selected.has(c.dataset.id)));
    refreshCount();
  });
  $("#oims-save").addEventListener("click", async () => {
    const picked = items.filter((i) => selected.has(i.id));
    if (!picked.length) return toast("先勾选要保存的图片", false);
    toast(`正在保存 ${picked.length} 张…`);
    const r = await ocSaveRecords(picked);
    toast(`保存完成：成功 ${r.ok} 张${r.fail ? `，失败 ${r.fail} 张` : ""}`);
    void loadImgSaveList(slug, grid, items, selected, refreshCount);
    ocStCache = null;
  });
  void loadImgSaveList(slug, grid, items, selected, refreshCount);
}
// 列表加载代际号：并发/重复加载时丢弃过期结果，避免两次加载共用一个数组互相清空（实测丢记录）
let oimsListGen = 0;
async function loadImgSaveList(slug, grid, items, selected, refreshCount) {
  const gen = ++oimsListGen;
  const found = [];
  const skip = [];
  await ocImgForEach((rec) => {
    if (slug && rec.slug !== slug) return;
    if (rec.savedAt) { skip.push(rec); return; }
    if (rec.deleted) return; // 已删除的图不再出现在待保存列表
    found.push(rec);
  });
  if (gen !== oimsListGen) return; // 期间又发起了一次加载：这次结果作废
  found.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  items.length = 0;
  found.forEach((f) => items.push(f));
  selected.clear();
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = `<p class="hint">这张卡没有待保存的图片${skip.length ? `（已有 ${skip.length} 张保存过了）` : ""}。</p>`;
    refreshCount();
    return;
  }
  for (const it of items) {
    const cell = document.createElement("div");
    cell.className = "oc-cell";
    cell.dataset.id = it.id;
    const img = document.createElement("img");
    img.alt = "生图";
    img.loading = "lazy";
    const circle = document.createElement("span");
    circle.className = "oc-pick";
    cell.append(img, circle);
    cell.addEventListener("click", () => {
      if (selected.has(it.id)) selected.delete(it.id);
      else selected.add(it.id);
      cell.classList.toggle("sel", selected.has(it.id));
      refreshCount();
    });
    grid.appendChild(cell);
    ocLazyThumb(img, it);
  }
  refreshCount();
}


// ==================== 启动（必须放在文件末尾：本地媒体库的 const 状态需先初始化） ====================
// 立刻渲染首屏，不等任何网络请求。
// 原来是 `loadProfile().finally(() => router())`——必须等 /api/profile 回来才画第一屏，
// 公网上这一等就是 1-2s，期间页面只有顶栏 + 背景色（用户看到的「只有 SoulBox 加黄页」）。
// 资料与表情库改为后台加载，回来后 loadProfile 内部会补昵称头像并刷新首页。
router();
// 身份先用缓存同步摆一次（避免管理入口闪一下），再后台校正
applyModeVisibility();
applyAdminLink();
void loadProfile();
// 身份（管理员/分发用户）决定抽屉里露哪些入口。ocMode 有 localStorage 缓存，本函数负责
// 后台校正 + 按结果调整可见性（首屏不等它，见文件上方 ocMode 注释）。
void loadMode();
// 启动即拉表情库（幂等）：回来后若聊天页已在，顺手把文本兜底的 [表情:名] 升级成图片
void ensureEmojiLib().then(() => upgradeEmojiFallback($("#chat-log")));

// ==================== 管理员登录（分发形态：用户免登录，管理员用密码） ====================
// 两条身份路线：设备 ID（用户，各自命名空间）/ 管理员密码（全局数据）。
// 浏览器可能同时带设备 cookie，所以管理员入口必须是页面内的登录表单，不能只靠 Basic 弹窗。
function renderAdminLogin() {
  return `
  <div class="view">
    <div class="page-head"><h2>管理员登录</h2></div>
    <div class="card-box oc-card" style="max-width:420px">
      <div class="form">
        <label>账号</label>
        <input id="adm-user" autocomplete="username" placeholder="管理员账号">
        <label>密码</label>
        <input id="adm-pass" type="password" autocomplete="current-password" placeholder="管理员密码">
        <button id="adm-go" class="small-btn" style="margin-top:12px;width:100%">登录</button>
      </div>
      <p class="hint" id="adm-msg"></p>
    </div>
  </div>`;
}
function initAdminLogin() {
  const go = async () => {
    const user = $("#adm-user").value.trim();
    const pass = $("#adm-pass").value;
    const r = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, pass }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      // 登录成功直接进管理页：抽屉底部的管理入口已随「底部文案」一起删掉，
      // 落地在首页的话管理员进来会找不到入口（只能手输 #/users）。
      location.hash = "#/users";
      location.reload();
      return;
    }
    $("#adm-msg").textContent = j.error || "登录失败";
  };
  $("#adm-go").addEventListener("click", go);
  $("#adm-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  $("#adm-user").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#adm-pass").focus();
  });
}
// ---------- 设备管理页（管理员） ----------
function renderUsersPage() {
  return `
  <div class="view">
    <div class="page-head"><h2>设备管理</h2><button id="u-back" class="ghost small-btn">← 返回</button></div>
    <div class="card-box oc-card">
      <div class="u-search-row">
        <input id="u-search" placeholder="搜索设备 ID（输前几位就行）">
        <span class="u-count" id="u-count"></span>
      </div>
      <div class="oc-rows" id="u-list"><div class="oc-empty">读取中…</div></div>
    </div>
  </div>`;
}
/** 设备列表快照（搜索在本地过滤，不再打接口） */
let uDevices = [];
let uQuery = "";
/** 注册/最近时间显示到分钟（用户要看"哪台是什么时候来的"） */
function uFmtTime(s) {
  const t = Date.parse(s || "");
  if (!t) return "?";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 排序：管理员置顶；其余按注册时间从早到晚（新设备自然加在列表下面） */
function uSortedDevices(list) {
  return list.slice().sort((a, b) => {
    if (!!a.admin !== !!b.admin) return a.admin ? -1 : 1;
    const ta = Date.parse(a.createdAt || "") || 0;
    const tb = Date.parse(b.createdAt || "") || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}
/** 重建列表（搜索框内容变化时只重画 #u-list） */
function uRenderRows() {
  const box = $("#u-list");
  if (!box) return;
  const all = uSortedDevices(uDevices);
  const hit = uQuery ? all.filter((d) => String(d.id || "").toLowerCase().includes(uQuery)) : all;
  const count = $("#u-count");
  if (count) count.textContent = uQuery ? `共 ${all.length} 台 · 显示 ${hit.length}` : `共 ${all.length} 台`;
  if (!hit.length) {
    box.innerHTML = `<div class="oc-empty">${uQuery ? "没有匹配的设备 ID" : "还没有设备接入"}</div>`;
    return;
  }
  box.innerHTML = "";
  for (const dev of hit) {
    const row = document.createElement("div");
    row.className = "oc-row";
    const isMe = dev.id === OC_DEVICE;
    const marks =
      (isMe ? '<span class="oc-cell-mark">本机</span>' : "") +
      (dev.admin ? '<span class="oc-cell-mark">管理员</span>' : "") +
      (dev.disabled ? '<span class="oc-cell-mark">已停用</span>' : "");
    row.innerHTML = `
      <span class="oc-bar" style="background:${dev.disabled ? "var(--faint)" : "var(--accent)"}"></span>
      <span class="u-dev-main">
        <span class="u-dev-id" title="点击复制完整 ID">${escapeHtml(dev.id || "")}${marks}</span>
        <span class="u-dev-meta">注册 ${uFmtTime(dev.createdAt)} · 最近 ${uFmtTime(dev.lastSeen)}</span>
      </span>`;
    // 完整 ID 点一下即复制（用户要拿它去对"哪台是谁"、贴给用户查记录）
    row.querySelector(".u-dev-id").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(dev.id || "");
        toast("已复制设备 ID");
      } catch {
        toast("复制失败，请手动选中复制", false);
      }
    });
    const look = document.createElement("button");
    look.className = "ghost small-btn";
    look.textContent = "查看";
    look.addEventListener("click", () => {
      location.hash = "#/usercards?id=" + encodeURIComponent(dev.id);
    });
    row.appendChild(look);
    // 自己这台不给「取消管理员」：点掉就进不了管理端了（要再进来得走 #/login 输密码）
    if (!(isMe && dev.admin)) {
      const adm = document.createElement("button");
      adm.className = "ghost small-btn";
      adm.textContent = dev.admin ? "取消管理员" : "设为管理员";
      adm.addEventListener("click", async () => {
        await api.send("/api/users/admin", { method: "POST", body: JSON.stringify({ id: dev.id, admin: !dev.admin }) });
        void initUsersPage();
      });
      row.appendChild(adm);
    }
    const dis = document.createElement("button");
    dis.className = "ghost small-btn";
    dis.textContent = dev.disabled ? "恢复" : "停用";
    if (dev.disabled) dis.classList.add("danger");
    dis.addEventListener("click", async () => {
      await api.send("/api/users/disable", { method: "POST", body: JSON.stringify({ id: dev.id, disabled: !dev.disabled }) });
      void initUsersPage();
    });
    row.appendChild(dis);
    box.appendChild(row);
  }
}
async function initUsersPage() {
  $("#u-back").addEventListener("click", () => { location.hash = "#/home"; });
  const me = await fetch("/api/admin/me").then((r) => r.json()).catch(() => ({ admin: false }));
  uDevices = [];
  uQuery = "";
  const box = $("#u-list");
  const search = $("#u-search");
  if (!me.admin) {
    box.innerHTML = `<div class="oc-empty">仅管理员可见。<a href="#/login">去登录</a></div>`;
    if (search) search.disabled = true;
    return;
  }
  if (search) {
    search.value = "";
    search.addEventListener("input", () => {
      uQuery = search.value.trim().toLowerCase();
      uRenderRows();
    });
  }
  const d = await api.get("/api/users").catch(() => ({ devices: [] }));
  uDevices = d.devices || [];
  uRenderRows();
}
// ---------- 管理员查看：某设备的卡库 → 某卡的聊天记录（纯文本，一行一句） ----------
function renderUserCards() {
  return `
  <div class="view">
    <div class="page-head"><h2>该用户的角色卡</h2><button id="uc-back" class="ghost small-btn">← 返回</button></div>
    <p class="hint" id="uc-head"></p>
    <div class="card-box oc-card"><div class="oc-rows" id="uc-list"><div class="oc-empty">读取中…</div></div></div>
  </div>`;
}
async function initUserCards() {
  const id = new URLSearchParams((location.hash.split("?")[1] || "")).get("id") || "";
  $("#uc-back").addEventListener("click", () => { location.hash = "#/users"; });
  const box = $("#uc-list");
  const d = await api.get("/api/users/" + encodeURIComponent(id) + "/cards").catch(() => null);
  const cards = (d && d.cards) || [];
  // 管理员设备的数据存在全局空间（它平时看的就是全局那份），下划线这句省得下次又以为"没数据"
  const head = $("#uc-head");
  if (head && d && d.admin) head.textContent = "管理员设备：显示的是全局空间的卡（它平时用的就是这一份）";
  if (!cards.length) { box.innerHTML = '<div class="oc-empty">这张设备没有卡</div>'; return; }
  box.innerHTML = "";
  for (const c of cards) {
    const row = document.createElement("div");
    row.className = "oc-row";
    row.innerHTML = '<span class="oc-bar"></span><span class="oc-row-label">' + escapeHtml(c.name || c.slug) + '</span><span class="oc-row-val">' + String(c.updated_at || "").slice(0, 10) + '</span><span class="oc-chev">›</span>';
    row.addEventListener("click", () => {
      location.hash = "#/userchats?id=" + encodeURIComponent(id) + "&slug=" + encodeURIComponent(c.slug);
    });
    box.appendChild(row);
  }
}
function renderUserChats() {
  return `
  <div class="view">
    <div class="page-head"><h2>聊天记录</h2><button id="uh-back" class="ghost small-btn">← 返回</button></div>
    <div class="card-box oc-card"><div class="small-out tall" id="uh-list"><div class="oc-empty">读取中…</div></div></div>
  </div>`;
}
async function initUserChats() {
  const q = new URLSearchParams((location.hash.split("?")[1] || ""));
  const id = q.get("id") || "";
  const slug = q.get("slug") || "";
  $("#uh-back").addEventListener("click", () => { location.hash = "#/usercards?id=" + encodeURIComponent(id); });
  const box = $("#uh-list");
  const d = await api.get("/api/users/" + encodeURIComponent(id) + "/chats/" + encodeURIComponent(slug)).catch(() => null);
  const rows = (d && d.entries) || [];
  if (!rows.length) { box.innerHTML = '<div class="oc-empty">没有聊天记录</div>'; return; }
  box.innerHTML = rows.map((e) => {
    const who = e.role === "user" ? "用户" : "AI";
    const src = e.surface === "web" ? "" : "[" + e.surface + "] ";
    const t = String(e.t || "").slice(5, 16).replace("T", " ");
    return '<div class="hint" style="margin:3px 0">' + t + " " + src + who + "：" + escapeHtml(String(e.content || "")) + "</div>";
  }).join("");
}

// ---------- 设置：我的设备 ID（记住它，删了可恢复） ----------
function renderDevicePage() {
  return `
  <div class="view">
    <div class="page-head"><h2>我的设备 ID</h2>${settingsBack()}</div>
    <div class="card-box oc-card">
      <h3>当前设备 ID</h3>
      <div class="oc-space-row"><span class="oc-space-val" id="dev-id" style="font-size:13px;word-break:break-all">—</span></div>
      <button id="dev-copy" class="ghost small-btn">复制</button>
      <p class="hint">请牢记这个 ID。我们最多保存 15 天且仅有聊天记录，我们不会私自调用您的数据。15 天内遇到不慎删除，凭此 ID 可以恢复聊天记录；记忆和图片我们无能为力（服务器磁盘有限）。</p>
    </div>
    <div class="card-box oc-card">
      <h3>用旧 ID 恢复</h3>
      <div class="form">
        <input id="dev-input" placeholder="粘贴以前的设备 ID（32 位十六进制）">
        <button id="dev-restore" class="small-btn" style="margin-top:10px;width:100%">恢复</button>
      </div>
      <p class="hint" id="dev-msg"></p>
    </div>
  </div>`;
}
function initDevicePage() {
  const el = $("#dev-id");
  if (el) el.textContent = OC_DEVICE;
  $("#dev-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(OC_DEVICE);
      toast("已复制设备 ID");
    } catch {
      toast("复制失败，请手动选中复制", false);
    }
  });
  $("#dev-restore").addEventListener("click", () => {
    const v = String($("#dev-input").value || "").trim().toLowerCase();
    const msg = $("#dev-msg");
    if (!/^[a-f0-9]{32}$/.test(v)) { msg.textContent = "格式不对：应为 32 位十六进制"; return; }
    if (v === OC_DEVICE) { msg.textContent = "这就是当前设备 ID"; return; }
    localStorage.setItem("oc_device", v);
    document.cookie = "oc_device=" + v + "; path=/; max-age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
    msg.textContent = "已切换到该 ID，正在重新载入…";
    setTimeout(() => location.reload(), 600);
  });
}

/**
 * 按当前身份调整可见性：隐藏运营向入口，并在设备身份下把落在隐藏路由上的访问退回首页
 * （直接粘 #/channels 这类地址进来的情况）。
 */
function applyModeVisibility() {
  const dev = ocIsDevice();
  document.querySelectorAll(".drawer-nav a").forEach((a) => {
    if (OC_DEVICE_HIDDEN_ROUTES.includes(a.dataset.route)) a.hidden = dev;
  });
  const cur = (location.hash.replace(/^#\//, "").split("?")[0] || "home").trim();
  if (dev && OC_DEVICE_HIDDEN_ROUTES.includes(cur)) location.hash = "#/home";
}

/**
 * 抽屉底部管理入口：只有「托管形态（服务器）+ 管理员」才显示。
 * 本地/自部署（无认证 = 单用户模式）一律当普通用户处理 —— 那边没有"多租户设备"这个概念，
 * 设备管理页永远是空的，所以整块（含上边框）都不出现，避免留一条空横线。
 * 需要进管理端时手动访问 #/login（与设备身份无关，永远有效）。
 */
function applyAdminLink() {
  const link = $("#drawer-admin-link");
  const foot = $("#drawer-admin-foot");
  const sep = $("#drawer-admin-sep");
  if (!link) return;
  const show = !!ocMode?.admin && !!ocMode?.hosted;
  link.hidden = !show;
  if (foot) foot.hidden = !show;
  if (sep) sep.hidden = !show;
  if (show) {
    link.textContent = "管理";
    link.setAttribute("href", "#/users");
  }
}

/** 拉一次身份（管理员判定沿用服务端 /api/admin/me），缓存并刷新可见性 */
async function loadMode() {
  const j = await fetch("/api/admin/me").then((r) => r.json()).catch(() => null);
  if (!j) {
    applyAdminLink(); // 网络失败：保留缓存里的身份信息，至少把底部链接按旧结论摆好
    return;
  }
  const next = { hosted: j.hosted === true, admin: j.admin === true };
  const changed = JSON.stringify(next) !== JSON.stringify(ocMode);
  ocMode = next;
  try {
    localStorage.setItem("ocs_mode", JSON.stringify(next));
  } catch {
    /* 隐私模式禁用 localStorage：仅本次会话内存生效 */
  }
  if (changed) {
    applyModeVisibility();
    // 首屏是在身份未知时画的（ocMode 无缓存 → 按"全开"渲染），身份确定后要把当前视图重画一遍，
    // 否则首页那些按身份裁剪的入口（蒸馏/通道快捷键）会一直留在页面上。只在身份变化时重画一次。
    router();
  }
  applyAdminLink();
}
