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
    if (btn.dataset.tab === "api") { loadModelConfig(); loadMCPConfig(); }
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
  const paste = $("#distill-paste").value.trim();
  if (!file && !paste) { $("#distill-msg").textContent = "请选择聊天记录文件，或粘贴「昵称: 内容」文本"; return; }
  const name = $("#distill-name").value.trim();
  if (!name) { $("#distill-msg").textContent = "请填写卡片名称"; return; }
  const text = file ? await file.text() : paste;
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

// ---- WeFlow 直连 ----
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
    $("#wf-out").textContent = `✓ 蒸馏完成：${r.card.name}（${r.card.slug}）\n消息 ${r.stats.totalMessages} 条 → 目标 ${r.stats.usedMessages} 条\n点上方「保存到卡库」后去「人设卡」页编辑/编译`;
    $("#distill-msg").textContent = "完成（WeFlow 导入）";
    $("#distill-msg").className = "status ok";
  } catch (e) {
    $("#wf-out").textContent = "失败：" + e.message;
  }
  $("#btn-wf-distill").disabled = false;
}

// ================= 聊天测试 =================
let chatHistory = [];
let pendingData = null;

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
  } catch { /* 语音不可用时忽略 */ }
}

function gatherChatOptions() {
  const tools = [];
  if ($("#tool-code").checked) tools.push("code_exec");
  if ($("#tool-file").checked) tools.push("sandbox_list", "sandbox_read", "sandbox_write", "sandbox_grep");
  if ($("#tool-search").checked) tools.push("web_search");
  if ($("#tool-weather").checked) tools.push("weather");
  if ($("#tool-time").checked) tools.push("datetime");
  if ($("#tool-memory").checked) tools.push("memory_save");
  const useMCP = $("#tool-mcp").checked;
  const skills = [];
  if ($("#skill-code").checked) skills.push("code_expert");
  if ($("#skill-trans").checked) skills.push("translator");
  if ($("#skill-write").checked) skills.push("writing");
  if ($("#skill-companion").checked) skills.push("companion");
  return { tools, useMCP, skills, thinking: $("#chat-thinking").value };
}

async function finishTurn(r) {
  if (r.type === "reply") {
    addChatBubble("bot", r.reply);
    chatHistory.push({ role: "assistant", content: r.reply });
    if ($("#chat-voice-reply").checked) speak(r.reply);
  } else if (r.type === "pending") {
    const bubble = addChatBubble("bot", "🛡️ 需要你确认：机器人想调用以下工具\n" +
      r.pending.map((p) => `· ${p.name}`).join("\n"));
    const row = document.createElement("div");
    row.className = "approve-row";
    const btnOk = document.createElement("button");
    btnOk.className = "small-btn primary";
    btnOk.textContent = "✅ 执行";
    const btnNo = document.createElement("button");
    btnNo.className = "small-btn danger";
    btnNo.textContent = "🚫 拒绝";
    pendingData = { slug: currentSlug, messages: r.messages, tools: gatherChatOptions().tools, useMCP: gatherChatOptions().useMCP, approve: false };
    btnOk.addEventListener("click", async () => {
      row.remove();
      pendingData.approve = true;
      await sendApprove();
    });
    btnNo.addEventListener("click", async () => {
      row.remove();
      pendingData.approve = false;
      await sendApprove();
    });
    row.appendChild(btnOk);
    row.appendChild(btnNo);
    bubble.parentNode.appendChild(row);
  }
}

async function sendApprove() {
  const btn = $("#btn-chat-send");
  btn.disabled = true;
  try {
    const r = await api.send("/api/chat/approve", {
      method: "POST",
      body: JSON.stringify(pendingData),
    });
    pendingData = null;
    await finishTurn(r);
  } catch (e) {
    addChatBubble("bot", "⚠ " + e.message);
  }
  btn.disabled = false;
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
  const opts = gatherChatOptions();
  try {
    const r = await api.send("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        slug: currentSlug,
        message,
        history: chatHistory.slice(0, -1),
        tools: opts.tools,
        useMCP: opts.useMCP,
        skills: opts.skills,
        thinking: opts.thinking,
      }),
    });
    await finishTurn(r);
  } catch (e) {
    chatHistory.pop();
    addChatBubble("bot", "⚠ " + e.message);
  }
  btn.disabled = false;
}

function clearChat() {
  chatHistory = [];
  pendingData = null;
  $("#chat-log").innerHTML = "";
}

// 语音输入（Chrome/Edge 的 Web Speech API）
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("当前浏览器不支持语音输入，请用 Chrome 或 Edge"); return; }
  const rec = new SR();
  rec.lang = "zh-CN";
  rec.onresult = (e) => {
    $("#chat-input").value = e.results[0][0].transcript;
  };
  rec.onerror = () => { /* 忽略 */ };
  rec.start();
}

// ================= MCP =================
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
$("#btn-wf-probe").addEventListener("click", probeWeFlow);
$("#btn-wf-distill").addEventListener("click", distillFromWeFlow);
$("#btn-chat-send").addEventListener("click", sendChat);
$("#btn-chat-clear").addEventListener("click", clearChat);
$("#btn-mic").addEventListener("click", startMic);
$("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
$("#btn-mcp-save").addEventListener("click", saveMCP);

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
