// 人设卡管理台前端（原生 JS，无构建步骤）
const $ = (sel) => document.querySelector(sel);

let currentSlug = null;
let dirty = false;

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    return r.json();
  },
  async send(path, options = {}) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = "status " + cls;
}

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

async function validateCard() {
  if (!currentSlug) return;
  let card;
  try {
    card = JSON.parse($("#editor-json").value);
  } catch (e) {
    setStatus("JSON 解析失败：" + e.message, "err");
    return;
  }
  // 临时保存校验结果：把当前内容 PUT 到服务端校验（服务端会拒绝错误卡）
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- 事件 ----------
$("#btn-create").addEventListener("click", createCard);
$("#btn-save").addEventListener("click", saveCard);
$("#btn-validate").addEventListener("click", validateCard);
$("#btn-del").addEventListener("click", deleteCard);
$("#editor-json").addEventListener("input", () => { dirty = true; });

// ---------- 启动 ----------
(async function init() {
  try {
    const h = await api.get("/api/health");
    $("#health").textContent = "✓ 服务正常 · " + h.schema;
    await loadList();
  } catch {
    $("#health").textContent = "✗ 无法连接服务，请先运行 npm run server";
  }
})();
