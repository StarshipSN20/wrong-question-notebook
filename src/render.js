// 前端逻辑：与本地 FastAPI 通信、渲染错题卡片与公式、录入/设置交互。

const API_BASE = "http://127.0.0.1:8000";

const VIEW_TITLES = {
  notebook: "错题本",
  editor: "录入/编辑",
  similar: "举一反三",
  review: "复习计划",
  export: "导出",
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

  const generatedBadge = problem.is_generated
    ? `<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-700">源自 #${escapeHtml(
        problem.parent_id
      )}</span>`
    : "";

  return `
    <article class="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="inline-block px-2 py-0.5 text-xs rounded ${subjectClass}">${escapeHtml(
    problem.subject || "未分类"
  )}</span>
          ${generatedBadge}
        </div>
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
      <div class="flex items-center gap-2 mb-3">
        <button class="gen-btn px-2 py-1 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100"
                data-id="${escapeHtml(problem.id)}" data-type="变式">生成变式</button>
        <button class="gen-btn px-2 py-1 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100"
                data-id="${escapeHtml(problem.id)}" data-type="拓展">生成拓展</button>
      </div>
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

// 卡片事件委托：删除（.delete-btn）与举一反三（.gen-btn）。
async function onCardClick(e) {
  const delBtn = e.target.closest(".delete-btn");
  if (delBtn) return deleteProblem(delBtn.dataset.id);

  const genBtn = e.target.closest(".gen-btn");
  if (genBtn) return generateSimilar(genBtn);
}

async function deleteProblem(id) {
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

// 生成变式/拓展题（举一反三）。
async function generateSimilar(btn) {
  const id = btn.dataset.id;
  const type = btn.dataset.type || "变式";
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    const res = await fetch(`${API_BASE}/api/generate-similar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_id: Number(id), type }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    window.alert(`已生成${type}题 #${data.id}，可在「错题本」或「举一反三」查看。`);
    loadProblems();
  } catch (err) {
    window.alert(`生成失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
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
  } else if (view === "similar") {
    document.getElementById("view-similar").classList.remove("hidden");
    loadSimilar();
  } else if (view === "review") {
    document.getElementById("view-review").classList.remove("hidden");
    loadReviewDue();
  } else if (view === "export") {
    document.getElementById("view-export").classList.remove("hidden");
    loadExportList();
  } else if (view === "settings") {
    document.getElementById("view-settings").classList.remove("hidden");
    loadConfig();
  } else {
    const ph = document.getElementById("view-placeholder");
    document.getElementById("placeholder-title").textContent =
      `「${VIEW_TITLES[view]}」`;
    ph.classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// 举一反三视图：列出所有已生成题目
// ---------------------------------------------------------------------------
async function loadSimilar() {
  const container = document.getElementById("similar-container");
  container.innerHTML = `<p class="text-slate-400 col-span-full">加载中…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/problems`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    const generated = all.filter((p) => p.is_generated);
    if (!generated.length) {
      container.innerHTML = `
        <div class="col-span-full text-center py-16 text-slate-400">
          <p class="text-lg mb-1">还没有生成的题目</p>
          <p class="text-sm">去「错题本」某道题上点「生成变式」或「生成拓展」。</p>
        </div>`;
      return;
    }
    container.innerHTML = generated.map(renderCard).join("");
    renderLatex(container);
  } catch (err) {
    container.innerHTML = `<p class="text-red-400 col-span-full">加载失败：${escapeHtml(
      err.message
    )}</p>`;
  }
}

// ---------------------------------------------------------------------------
// 复习计划视图
// ---------------------------------------------------------------------------
async function loadReviewDue() {
  const container = document.getElementById("review-container");
  container.innerHTML = `<p class="text-slate-400">加载中…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/review/due`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const due = await res.json();
    if (!due.length) {
      container.innerHTML = `
        <div class="text-center py-16 text-slate-400">
          <p class="text-lg mb-1">今天没有待复习的错题 🎉</p>
          <p class="text-sm">新录入的错题会在次日进入复习计划。</p>
        </div>`;
      return;
    }
    container.innerHTML = due
      .map((p) => {
        const content = p.latex_code || p.raw_text || "（无题目文本）";
        return `
          <div class="review-item bg-white rounded-lg border border-slate-200 p-4 flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-xs text-slate-400 mb-1">#${escapeHtml(
                p.id
              )} · ${escapeHtml(p.subject || "未分类")} · 阶段 ${escapeHtml(
          p.review_stage
        )}/5</div>
              <div class="latex-content text-sm text-slate-700 line-clamp-3">${escapeHtml(
                content
              )}</div>
            </div>
            <button class="review-done-btn shrink-0 px-3 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
                    data-id="${escapeHtml(p.id)}">标记为已复习</button>
          </div>`;
      })
      .join("");
    renderLatex(container);
  } catch (err) {
    container.innerHTML = `<p class="text-red-400">加载失败：${escapeHtml(
      err.message
    )}</p>`;
  }
}

async function completeReview(id) {
  try {
    const res = await fetch(`${API_BASE}/api/review/${id}/complete`, {
      method: "POST",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    loadReviewDue();
  } catch (err) {
    window.alert(`操作失败：${err.message}`);
  }
}

function onReviewClick(e) {
  const btn = e.target.closest(".review-done-btn");
  if (btn) completeReview(btn.dataset.id);
}

// ---------------------------------------------------------------------------
// 导出视图
// ---------------------------------------------------------------------------
async function loadExportList() {
  const container = document.getElementById("export-container");
  container.innerHTML = `<p class="text-slate-400">加载中…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/problems`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const problems = await res.json();
    if (!problems.length) {
      container.innerHTML = `<p class="text-slate-400 text-center py-16">还没有错题可导出。</p>`;
      return;
    }
    container.innerHTML = problems
      .map((p) => {
        const content = p.latex_code || p.raw_text || "（无题目文本）";
        return `
          <label class="export-item flex items-start gap-3 bg-white rounded-lg border border-slate-200 p-3 cursor-pointer">
            <input type="checkbox" class="export-cb mt-1" value="${escapeHtml(
              p.id
            )}" />
            <div class="min-w-0">
              <div class="text-xs text-slate-400 mb-1">#${escapeHtml(
                p.id
              )} · ${escapeHtml(p.subject || "未分类")}</div>
              <div class="text-sm text-slate-700 line-clamp-2">${escapeHtml(
                content
              )}</div>
            </div>
          </label>`;
      })
      .join("");
  } catch (err) {
    container.innerHTML = `<p class="text-red-400">加载失败：${escapeHtml(
      err.message
    )}</p>`;
  }
}

async function exportSelected() {
  const ids = Array.from(
    document.querySelectorAll("#export-container .export-cb:checked")
  ).map((cb) => Number(cb.value));
  if (!ids.length) {
    window.alert("请先勾选要导出的错题。");
    return;
  }
  const btn = document.getElementById("export-btn");
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_ids: ids }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mistakes.tex";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    window.alert(`导出失败：${err.message}`);
  } finally {
    btn.disabled = false;
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
    .getElementById("similar-container")
    .addEventListener("click", onCardClick);
  document
    .getElementById("review-container")
    .addEventListener("click", onReviewClick);
  document.getElementById("export-btn").addEventListener("click", exportSelected);
  document
    .getElementById("save-config-btn")
    .addEventListener("click", saveConfig);

  bindEditorEvents();
  checkBackend();
  loadProblems();
});
