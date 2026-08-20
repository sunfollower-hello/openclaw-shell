// openclaw-shell 前端：人设卡 / 通道 / API 三 Tab
const $ = (sel) => document.querySelector(sel);

let currentSlug = null;
let dirty = false;

const api = {
  async get(path) {
    const r = await fetch(path);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  async send(path, options = {}) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

function setStatus(text, cls = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = text;
  el.className = "status " + cls;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ================= Tab 切换 =================
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "channels") refreshChannels();
    if (btn.dataset.tab === "api") loadModelConfig();
    if (btn.dataset.tab === "distill") loadDistillModel();
  });
});

// ================= 人设卡 =================
async function loadList() {
  const { cards } = await api.get("/api/cards");
  const ul = $("#card-list");
  ul.innerHTML = "";
  for (const c of cards) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="meta">${c.slug} · ${c.role} · v${c.version}</div>
      </div>`;
    li.addEventListener("click", () => openCard(c.slug));
    if (c.slug === currentSlug) li.classList.add("active");
    ul.appendChild(li);
  }
}

async function openCard(slug) {
  if (dirty && !confirm("当前卡片有未保存修改，确定放弃？")) return;
  const card = await api.get(`/api/cards/${slug}`);
  currentSlug = slug;
  $("#editor-title").textContent = `编辑：${card.name} (${card.slug})`;
  $("#editor-json").value = JSON.stringify(card, null, 2);
  dirty = false;
  setStatus(`已加载 v${card.version}，编辑后点保存`);
  loadList();
}

async function saveCard() {
  if (!currentSlug) return;
  let card;
  try {
    card = JSON.parse($("#editor-json").value);
  } catch (e) {
    setStatus("JSON 解析失败：" + e.message, "err");
    return;
  }
  try {
    const res = await api.send(`/api/cards/${currentSlug}`, {
      method: "PUT",
      body: JSON.stringify(card),
    });
    dirty = false;
    setStatus("✓ 已保存 v" + res.card.version + (res.warnings?.length ? "\n⚠ " + res.warnings.join("\n⚠ ") : ""), "ok");
    loadList();
  } catch (e) {
    setStatus("保存失败：" + e.message, "err");
  }
}

async function compileCard() {
  if (!currentSlug) return;
  try {
    await saveCard();
    const res = await api.send(`/api/cards/${currentSlug}/compile`, { method: "POST" });
    setStatus(
      "✓ 已编译到 workspace，共 " + res.files.length + " 个文件\n" +
      res.files.join("\n") + (res.warnings?.length ? "\n⚠ " + res.warnings.join("\n⚠ ") : ""),
      "ok"
    );
  } catch (e) {
    setStatus("编译失败：" + e.message, "err");
  }
}

async function validateCard() {
  if (!currentSlug) return;
  let card;
  try {
    card = JSON.parse($("#editor-json").value);
  } catch (e) {
    setStatus("JSON 解析失败：" + e.message, "err");
    return;
  }
  try {
    const res = await api.send(`/api/cards/${currentSlug}`, {
      method: "PUT",
      body: JSON.stringify(card),
    });
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
  $("#editor-title").textContent = "选择左侧卡片开始编辑";
  $("#editor-json").value = "";
  setStatus("已删除");
  loadList();
}

async function createCard() {
  const name = $("#new-name").value.trim();
  if (!name) return setStatus("请输入名称", "err");
  try {
    await api.send("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        name,
        slug: $("#new-slug").value.trim() || undefined,
        role: $("#new-role").value,
      }),
    });
    $("#new-name").value = "";
    $("#new-slug").value = "";
    setStatus("✓ 已创建，可开始编辑", "ok");
    loadList();
  } catch (e) {
    setStatus("创建失败：" + e.message, "err");
  }
}

// ================= 通道 =================
function setChip(sel, text, ok) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.className = "chip " + (ok === null ? "" : ok ? "ok" : "bad");
}

async function refreshWechat() {
  try {
    const s = await api.get("/api/channels/wechat/status");
    setChip("#wx-status", s.connected ? "已连接 ✓" : "未连接", s.connected);
    if (!s.connected && s.raw) $("#pairing-list").textContent = s.raw.slice(-800);
  } catch {
    setChip("#wx-status", "检测失败", false);
  }
}

// ================= 通道：通用扫码登录 =================
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
      } catch { /* 忽略瞬时错误 */ }
    }, 2000);
  } catch (e) {
    $(msgSel).textContent = "启动失败：" + e.message;
  }
}

function startWxLogin() {
  startLogin("/api/channels/wechat/login", "#wx-qr", "#wx-login-msg", () => { refreshWechat(); refreshPairing(); });
}

function startQqLogin() {
  startLogin("/api/channels/qq/login", "#qq-qr", "#qq-login-msg", refreshQQ);
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
    const r = await api.send("/api/channels/wechat/pairing/approve", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
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
    const parts = [
      s.pluginInstalled ? "插件✓" : "插件✗",
      s.napcatRunning ? "NapCat✓" : "NapCat✗",
      s.onebotSeen ? "连接✓" : "连接✗",
    ];
    const allOk = s.pluginInstalled && s.napcatRunning && s.onebotSeen;
    setChip("#qq-status", parts.join(" "), allOk);
    if (!allOk) $("#qq-out").textContent = "官方 QQ Bot 插件已安装（若状态显示插件✓），按上方四步完成绑定即可。";
  } catch (e) {
    setChip("#qq-status", "检测失败", false);
  }
}

function refreshChannels() {
  refreshWechat();
  refreshPairing();
  refreshQQ();
}

// ================= API =================
async function loadModelConfig() {
  try {
    const cfg = await api.get("/api/config/model");
    $("#cur-primary").textContent = cfg.primary || "（未设置）";
    const box = $("#provider-list");
    box.innerHTML = "";
    if (cfg.providers.length === 0) {
      box.innerHTML = '<div class="muted">还没有配置任何提供商</div>';
      return;
    }
    for (const p of cfg.providers) {
      const d = document.createElement("div");
      d.className = "provider-item" + (cfg.primary.startsWith(p.name + "/") ? " active" : "");
      d.innerHTML = `
        <div><b>${escapeHtml(p.name)}</b> ${cfg.primary.startsWith(p.name + "/") ? "· 默认" : ""}</div>
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
  if (!baseUrl || !apiKey || !modelId) {
    $("#model-msg").textContent = "请先填 Base URL / Key / 模型 ID";
    return;
  }
  $("#model-msg").textContent = "测试中…";
  try {
    const r = await api.send("/api/config/model/test", {
      method: "POST",
      body: JSON.stringify({ baseUrl, apiKey, modelId }),
    });
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
  } catch (e) {
    $("#model-msg").textContent = "保存失败：" + e.message;
    $("#model-msg").className = "status err";
  }
}

// ================= 蒸馏 =================
let lastDistilledCard = null;

async function runDistill() {
  const file = $("#distill-file").files[0];
  if (!file) { $("#distill-msg").textContent = "请先选择聊天记录 JSON 文件"; return; }
  const name = $("#distill-name").value.trim();
  if (!name) { $("#distill-msg").textContent = "请填写卡片名称"; return; }
  const text = await file.text();
  $("#distill-msg").textContent = "蒸馏中…（会调用模型 3 次，需要一点时间）";
  $("#btn-distill-run").disabled = true;
  try {
    const r = await api.send("/api/distill", {
      method: "POST",
      body: JSON.stringify({
        fileContent: text,
        fileName: file.name,
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
      `脱敏替换：${r.stats.redact.replaced} 处${r.stats.redact.blockedWordsHit.length ? "（屏蔽词剔除 " + r.stats.redact.blockedWordsHit.join(",") + "）" : ""}`,
      "",
    ];
    for (const [dim, s] of Object.entries(r.stats.dimensions)) {
      lines.push(`${dim}: ${s.items} 条（${s.via}）`);
    }
    lines.push("", "人格（traits）:", ...(r.card.personality.traits ?? []).map((t) => "  - " + t));
    lines.push("", "记忆（facts）:", ...(r.card.memory.facts ?? []).slice(0, 8).map((f) => "  - " + f.fact));
    lines.push("", "⚠ 保存前请确认授权：source.consent.granted 目前为 false，发布前需在卡片里改为 true");
    $("#distill-result").textContent = lines.join("\n");
    $("#distill-msg").textContent = "完成。点「保存到卡库」后到「人设卡」页可继续编辑/编译。";
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
    await api.send("/api/cards/import", {
      method: "POST",
      body: JSON.stringify({ card: lastDistilledCard }),
    });
    $("#distill-msg").textContent = "✓ 已保存到卡库，去「人设卡」页查看编辑";
    $("#distill-msg").className = "status ok";
    lastDistilledCard = null;
    loadList();
  } catch (e) {
    $("#distill-msg").textContent = "保存失败：" + e.message;
    $("#distill-msg").className = "status err";
  }
}

async function loadDistillModel() {
  try {
    const cfg = await api.get("/api/config/model");
    $("#distill-model").textContent = cfg.primary || "（未设置，先到 API 页配置）";
  } catch { /* 忽略 */ }
}

// ================= 事件绑定 =================
$("#btn-create").addEventListener("click", createCard);
$("#btn-save").addEventListener("click", saveCard);
$("#btn-compile").addEventListener("click", compileCard);
$("#btn-validate").addEventListener("click", validateCard);
$("#btn-del").addEventListener("click", deleteCard);
$("#editor-json").addEventListener("input", () => { dirty = true; });

$("#btn-wx-login").addEventListener("click", startWxLogin);
$("#btn-wx-refresh").addEventListener("click", refreshWechat);
$("#btn-pair-approve").addEventListener("click", approvePairing);
$("#btn-qq-login").addEventListener("click", startQqLogin);
$("#btn-qq-refresh").addEventListener("click", refreshQQ);

$("#btn-model-test").addEventListener("click", testModel);
$("#btn-model-save").addEventListener("click", saveModel);
$("#btn-distill-run").addEventListener("click", runDistill);
$("#btn-distill-save").addEventListener("click", saveDistilled);

// ================= 启动 =================
(async function init() {
  try {
    const h = await api.get("/api/health");
    $("#health").textContent = "✓ 服务正常 · " + h.schema;
    await loadList();
    refreshChannels();
  } catch {
    $("#health").textContent = "✗ 无法连接服务，请先运行桌面开关启动";
  }
})();
