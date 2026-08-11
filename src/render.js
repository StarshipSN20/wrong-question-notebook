// 前端逻辑：与本地 FastAPI 通信、渲染错题卡片与公式、录入/设置交互。

const API_BASE = "http://127.0.0.1:8000";

const VIEW_TITLES = {
  notebook: "错题本",
  editor: "录入/编辑",
  similar: "举一反三",
  review: "复习计划",
  settings: "设置",
};

// 学科对应的标签配色
const SUBJECT_COLORS = {
  数学: "bg-blue-100 text-blue-700",
  物理: "bg-green-100 text-green-700",
  化学: "bg-purple-100 text-purple-700",
};

// 录入页当前正在编辑的错题（识别/修正/更新共享）
let currentProblem = null;
// 待上传的文件
let pendingFile = null;

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 用 KaTeX 自动渲染元素内的 \( \) 与 \[ \] 公式。
function renderLatex(element) {
  if (!element || typeof window.renderMathInElement !== "function") return;
  try {
    window.renderMathInElement(element, {
      delimiters: [
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  } catch (err) {
    console.warn("KaTeX 渲染失败：", err);
  }
}

// ---------------------------------------------------------------------------
// 错题本视图
// ---------------------------------------------------------------------------
function renderCard(problem) {
  const subjectClass =
    SUBJECT_COLORS[problem.subject] || "bg-slate-100 text-slate-700";
  const tags = Array.isArray(problem.tags) ? problem.tags : [];
  const tagsHtml = tags
    .map(
      (t) =>
        `<span class="inline-block px-2 py-0.5 text-xs bg-slate-100 text-slate-600 rounded">${escapeHtml(
          t
        )}</span>`
    )
    .join(" ");

  const content = problem.latex_code || problem.raw_text || "（无题目文本）";

  return `
    <article class="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div class="flex items-center justify-between mb-2">
        <span class="inline-block px-2 py-0.5 text-xs rounded ${subjectClass}">${escapeHtml(
    problem.subject || "未分类"
  )}</span>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-400">#${escapeHtml(problem.id)}</span>
          <button class="delete-btn text-slate-300 hover:text-red-500 text-sm leading-none" data-id="${escapeHtml(
            problem.id
          )}" title="删除">✕</button>
        </div>
      </div>
      <div class="latex-content text-sm text-slate-700 mb-3 line-clamp-3">${escapeHtml(
        content
      )}</div>
      <div class="flex flex-wrap gap-1 mb-3">${tagsHtml}</div>
      <div class="flex items-center justify-between text-xs text-slate-400 border-t border-slate-100 pt-2">
        <span>下次复习：${escapeHtml(problem.next_review_date)}</span>
        <span>阶段 ${escapeHtml(problem.review_stage)}/5</span>
      </div>
    </article>
  `;
}

async function loadProblems() {
  const container = document.getElementById("problems-container");
  container.innerHTML = `<p class="text-slate-400 col-span-full">加载中…</p>`;

  try {
    const res = await fetch(`${API_BASE}/api/problems`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const problems = await res.json();

    if (!problems.length) {
      container.innerHTML = `
        <div class="col-span-full text-center py-16 text-slate-400">
          <p class="text-lg mb-1">还没有错题</p>
          <p class="text-sm">在「录入/编辑」中上传图片/PDF/DOCX 让 AI 识别，或用 POST /api/problems 手动新增。</p>
        </div>`;
      return;
    }

    container.innerHTML = problems.map(renderCard).join("");
    renderLatex(container);
  } catch (err) {
    container.innerHTML = `
      <div class="col-span-full text-center py-16 text-red-400">
        <p class="text-lg mb-1">无法连接后端</p>
        <p class="text-sm">${escapeHtml(
          err.message
        )}（请确认 FastAPI 已启动于 ${API_BASE}）</p>
      </div>`;
  }
}

// 删除错题（事件委托：卡片上的 .delete-btn）。
async function onCardClick(e) {
  const btn = e.target.closest(".delete-btn");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!window.confirm("确定删除这道错题吗？此操作不可恢复。")) return;
  try {
    const res = await fetch(`${API_BASE}/api/problems/${id}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    loadProblems();
  } catch (err) {
    window.alert(`删除失败：${err.message}`);
  }
}

async function checkBackend() {
  const el = document.getElementById("backend-status");
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    el.textContent = data.status === "ok" ? "后端：运行中 ●" : "后端：异常";
    el.className = "text-emerald-400";
  } catch {
    el.textContent = "后端：未连接 ○";
    el.className = "text-red-400";
  }
}

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------
function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.getElementById("view-title").textContent =
    VIEW_TITLES[view] || "错题本";

  // 刷新按钮只在错题本视图有意义
  document.getElementById("refresh-btn").classList.toggle(
    "hidden",
    view !== "notebook"
  );

  // 隐藏所有视图
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));

  if (view === "notebook") {
    document.getElementById("view-notebook").classList.remove("hidden");
    loadProblems();
  } else if (view === "editor") {
    document.getElementById("view-editor").classList.remove("hidden");
  } else if (view === "settings") {
    document.getElementById("view-settings").classList.remove("hidden");
    loadConfig();
  } else {
    // 举一反三 / 复习计划：占位
    const ph = document.getElementById("view-placeholder");
    document.getElementById("placeholder-title").textContent =
      `「${VIEW_TITLES[view]}」`;
    ph.classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// 录入 / 编辑视图
// ---------------------------------------------------------------------------
function setEditorStatus(msg, isError = false) {
  const el = document.getElementById("editor-status");
  el.textContent = msg || "";
  el.className = `ml-3 text-sm ${isError ? "text-red-500" : "text-slate-500"}`;
}

function showResult(problem) {
  currentProblem = problem;
  document.getElementById("result-area").classList.remove("hidden");
  document.getElementById("result-subject").textContent =
    problem.subject || "未分类";
  document.getElementById("result-id").textContent = `#${problem.id}`;

  const render = document.getElementById("result-render");
  render.textContent = problem.latex_code || problem.raw_text || "（空）";
  renderLatex(render);

  document.getElementById("latex-textarea").value = problem.latex_code || "";
}

function handleFileSelected(file) {
  if (!file) return;
  pendingFile = file;
  document.getElementById("recognize-btn").disabled = false;
  setEditorStatus("");

  const wrap = document.getElementById("preview-wrap");
  const img = document.getElementById("preview-img");
  document.getElementById("preview-name").textContent = file.name;

  if (file.type.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target.result;
      img.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  } else {
    img.classList.add("hidden");
    img.removeAttribute("src");
  }
  wrap.classList.remove("hidden");
}

async function recognizeFile() {
  if (!pendingFile) return;
  setEditorStatus("识别中，请稍候…");
  document.getElementById("recognize-btn").disabled = true;

  const form = new FormData();
  form.append("file", pendingFile);

  try {
    const res = await fetch(`${API_BASE}/api/upload`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    showResult(data);
    setEditorStatus("识别完成 ✓");
  } catch (err) {
    setEditorStatus(err.message, true);
  } finally {
    document.getElementById("recognize-btn").disabled = false;
  }
}

async function submitCorrection() {
  if (!currentProblem) return;
  const input = document.getElementById("correct-input");
  const feedback = input.value.trim();
  if (!feedback) return;

  setEditorStatus("AI 修正中…");
  try {
    const res = await fetch(`${API_BASE}/api/correct-latex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: currentProblem.id,
        user_feedback: feedback,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    showResult(data);
    input.value = "";
    setEditorStatus("修正完成 ✓");
  } catch (err) {
    setEditorStatus(err.message, true);
  }
}

async function updateLatex() {
  if (!currentProblem) return;
  const latex = document.getElementById("latex-textarea").value;

  setEditorStatus("保存中…");
  try {
    const res = await fetch(`${API_BASE}/api/problems/${currentProblem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latex_code: latex }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    showResult(data);
    setEditorStatus("已更新 ✓");
  } catch (err) {
    setEditorStatus(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// 设置视图
// ---------------------------------------------------------------------------
async function loadConfig() {
  const status = document.getElementById("config-status");
  status.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const cfg = await res.json();
    document.getElementById("cfg-api-key").value = cfg.api_key || "";
    document.getElementById("cfg-base-url").value = cfg.base_url || "";
    document.getElementById("cfg-model-name").value = cfg.model_name || "";
  } catch (err) {
    status.textContent = `读取配置失败：${err.message}`;
    status.className = "text-sm text-red-500";
  }
}

async function saveConfig() {
  const status = document.getElementById("config-status");
  const payload = {
    api_key: document.getElementById("cfg-api-key").value,
    base_url: document.getElementById("cfg-base-url").value,
    model_name: document.getElementById("cfg-model-name").value,
  };
  status.textContent = "保存中…";
  status.className = "text-sm text-slate-500";
  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.textContent = "已保存 ✓";
    status.className = "text-sm text-emerald-600";
  } catch (err) {
    status.textContent = `保存失败：${err.message}`;
    status.className = "text-sm text-red-500";
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
function bindEditorEvents() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) =>
    handleFileSelected(e.target.files[0])
  );

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () =>
    dropzone.classList.remove("dragover")
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  document
    .getElementById("recognize-btn")
    .addEventListener("click", recognizeFile);
  document
    .getElementById("correct-btn")
    .addEventListener("click", submitCorrection);
  document
    .getElementById("update-latex-btn")
    .addEventListener("click", updateLatex);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.getElementById("refresh-btn").addEventListener("click", loadProblems);
  document
    .getElementById("problems-container")
    .addEventListener("click", onCardClick);
  document
    .getElementById("save-config-btn")
    .addEventListener("click", saveConfig);

  bindEditorEvents();
  checkBackend();
  loadProblems();
});
