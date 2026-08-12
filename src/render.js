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
// 已加载的错题缓存（id → ProblemOut），供详情弹窗用
const problemsCache = new Map();
// 详情弹窗当前显示的题目
let detailProblem = null;
// 错题本搜索关键字（按标签匹配）
let searchQuery = "";

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

  // 预览只用题目部分；答案在详情弹窗里看
  const content = problem.question_latex || problem.latex_code || problem.raw_text || "（无题目文本）";

  const generatedBadge = problem.is_generated
    ? `<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-700">源自 #${escapeHtml(
        problem.parent_id
      )}</span>`
    : "";

  return `
    <article class="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
             data-id="${escapeHtml(problem.id)}">
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
    let problems = await res.json();

    // 按标签过滤（大小写不敏感，子串匹配）
    const q = searchQuery.toLowerCase();
    if (q) {
      problems = problems.filter((p) =>
        (Array.isArray(p.tags) ? p.tags : []).some((t) =>
          t.toLowerCase().includes(q)
        )
      );
    }

    if (!problems.length) {
      container.innerHTML = `
        <div class="col-span-full text-center py-16 text-slate-400">
          <p class="text-lg mb-1">${q ? "没有找到匹配的错题" : "还没有错题"}</p>
          <p class="text-sm">${q
            ? `没有题目带标签「${escapeHtml(searchQuery)}」。`
            : "在「录入/编辑」中上传图片/PDF/DOCX 让 AI 识别，或用 POST /api/problems 手动新增。"}</p>
        </div>`;
      return;
    }

    problemsCache.clear();
    problems.forEach((p) => problemsCache.set(p.id, p));
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

// 单题详情刷新：只更新缓存中对应题目，不刷新整个列表。
async function refreshSingleProblem(id) {
  try {
    const res = await fetch(`${API_BASE}/api/problems/${id}`);
    if (res.ok) {
      const p = await res.json();
      problemsCache.set(p.id, p);
    }
  } catch {
    // 静默失败，缓存保持旧值
  }
}

// 卡片事件委托：删除（.delete-btn）与举一反三（.gen-btn）与查看详情（article[data-id]）。
async function onCardClick(e) {
  const delBtn = e.target.closest(".delete-btn");
  if (delBtn) return deleteProblem(delBtn.dataset.id);

  const genBtn = e.target.closest(".gen-btn");
  if (genBtn) return generateSimilar(genBtn);

  const card = e.target.closest("article[data-id]");
  if (card) showProblemDetail(Number(card.dataset.id));
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
    problemsCache.delete(id);
    loadProblems();
  } catch (err) {
    window.alert(`删除失败：${err.message}`);
  }
}

// 题目详情弹窗
function showProblemDetail(id) {
  // 优先走缓存；缓存未命中时尝试从后端拉取
  const cached = problemsCache.get(id);
  if (cached) return renderDetail(cached);

  fetch(`${API_BASE}/api/problems/${id}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((p) => {
      problemsCache.set(p.id, p);
      renderDetail(p);
    })
    .catch((err) => window.alert(`加载题目失败：${err.message}`));
}

function renderDetail(p) {
  detailProblem = p;
  document.getElementById("detail-subject").textContent = p.subject || "未分类";
  document.getElementById("detail-subject").className =
    `inline-block px-2 py-0.5 text-xs rounded ${SUBJECT_COLORS[p.subject] || "bg-slate-100 text-slate-700"}`;
  document.getElementById("detail-id").textContent = `#${p.id}`;

  const badge = document.getElementById("detail-badge");
  if (p.is_generated) {
    badge.textContent = `源自 #${p.parent_id}`;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  // 题目面板：只用题目部分
  const content = document.getElementById("detail-content");
  content.textContent =
    p.question_latex || p.latex_code || p.raw_text || "（无题目文本）";
  renderLatex(content);

  renderAnswerPanel();
  renderDetailTags();
  setDetailTab("question");

  document.getElementById("detail-created").textContent = p.created_at || "-";
  document.getElementById("detail-review-date").textContent = p.next_review_date || "-";
  document.getElementById("detail-review-stage").textContent = p.review_stage ?? 0;

  document.getElementById("detail-modal").classList.remove("hidden");
}

function closeDetailModal() {
  document.getElementById("detail-modal").classList.add("hidden");
}

// 答案面板：有答案则渲染，无答案显示空态（手动输入 / AI 生成）
function renderAnswerPanel() {
  const p = detailProblem;
  const render = document.getElementById("detail-answer-render");
  const empty = document.getElementById("answer-empty");
  const edit = document.getElementById("answer-edit");
  const editBtn = document.getElementById("answer-edit-btn");

  const answer = p.answer_latex;
  render.textContent = answer || "";
  renderLatex(render);

  const hasAnswer = !!(answer && answer.trim());
  render.classList.toggle("hidden", !hasAnswer);
  empty.classList.toggle("hidden", hasAnswer);
  edit.classList.add("hidden");
  editBtn.classList.toggle("hidden", !hasAnswer);
  document.getElementById("answer-input").value = answer || "";
  document.getElementById("answer-status").textContent = "";
}

// 详情弹窗标签区渲染
function renderDetailTags() {
  const p = detailProblem;
  const tags = Array.isArray(p.tags) ? p.tags : [];
  document.getElementById("detail-tags").innerHTML = tags
    .map(
      (t) => `<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-slate-100 text-slate-600 rounded">
        ${escapeHtml(t)}
        <button class="tag-del-btn text-slate-400 hover:text-red-500" data-tag="${escapeHtml(t)}" title="删除标签">✕</button>
      </span>`
    )
    .join("");
}

// 题目/答案 tab 切换
function setDetailTab(tab) {
  const isQuestion = tab === "question";
  document.getElementById("tab-question").className =
    "detail-tab px-4 py-2.5 text-sm font-medium border-b-2 " +
    (isQuestion ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-700");
  document.getElementById("tab-answer").className =
    "detail-tab px-4 py-2.5 text-sm font-medium border-b-2 " +
    (isQuestion ? "border-transparent text-slate-500 hover:text-slate-700" : "border-blue-600 text-blue-700");
  document.getElementById("panel-question").classList.toggle("hidden", !isQuestion);
  document.getElementById("panel-answer").classList.toggle("hidden", isQuestion);
}

// 手动输入答案：显示编辑区
function showAnswerEdit() {
  document.getElementById("answer-empty").classList.add("hidden");
  document.getElementById("answer-edit").classList.remove("hidden");
  document.getElementById("answer-edit-btn").classList.add("hidden");
  document.getElementById("answer-input").focus();
}

// 保存手动输入的答案（PATCH answer_latex）
async function saveAnswer() {
  if (!detailProblem) return;
  const input = document.getElementById("answer-input");
  const status = document.getElementById("answer-status");
  status.textContent = "保存中…";
  try {
    const res = await fetch(`${API_BASE}/api/problems/${detailProblem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer_latex: input.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    detailProblem = data;
    problemsCache.set(data.id, data);
    renderAnswerPanel();
    status.textContent = "已保存 ✓";
    status.className = "text-sm text-emerald-600";
  } catch (err) {
    status.textContent = `保存失败：${err.message}`;
    status.className = "text-sm text-red-500";
  }
}

// 用 AI 生成答案
async function generateAnswerByAI() {
  if (!detailProblem) return;
  const status = document.getElementById("answer-status");
  const btn = document.getElementById("answer-ai-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "生成中…";
  status.textContent = "AI 生成中，请稍候…";
  status.className = "text-sm text-slate-500";
  try {
    const res = await fetch(`${API_BASE}/api/generate-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_id: detailProblem.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    detailProblem = data;
    problemsCache.set(data.id, data);
    renderAnswerPanel();
    status.textContent = "已生成 ✓";
    status.className = "text-sm text-emerald-600";
  } catch (err) {
    status.textContent = `生成失败：${err.message}`;
    status.className = "text-sm text-red-500";
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 添加标签（PATCH tags）
async function addTag() {
  if (!detailProblem) return;
  const input = document.getElementById("tag-input");
  const tag = input.value.trim();
  if (!tag) return;
  const status = document.getElementById("tag-status");
  const current = Array.isArray(detailProblem.tags) ? detailProblem.tags : [];
  if (current.includes(tag)) {
    status.textContent = "该标签已存在";
    status.className = "text-xs text-slate-400";
    return;
  }
  status.textContent = "保存中…";
  try {
    const res = await fetch(`${API_BASE}/api/problems/${detailProblem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [...current, tag] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    detailProblem = data;
    problemsCache.set(data.id, data);
    renderDetailTags();
    input.value = "";
    status.textContent = "已添加 ✓";
    status.className = "text-xs text-emerald-600";
  } catch (err) {
    status.textContent = `添加失败：${err.message}`;
    status.className = "text-xs text-red-500";
  }
}

// 删除标签
async function removeTag(tag) {
  if (!detailProblem) return;
  const current = Array.isArray(detailProblem.tags) ? detailProblem.tags : [];
  try {
    const res = await fetch(`${API_BASE}/api/problems/${detailProblem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: current.filter((t) => t !== tag) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    detailProblem = data;
    problemsCache.set(data.id, data);
    renderDetailTags();
  } catch (err) {
    window.alert(`删除标签失败：${err.message}`);
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
    all.forEach((p) => problemsCache.set(p.id, p));
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
    due.forEach((p) => problemsCache.set(p.id, p));
    container.innerHTML = due
      .map((p) => {
        const content =
          p.question_latex || p.latex_code || p.raw_text || "（无题目文本）";
        return `
          <div class="review-item bg-white rounded-lg border border-slate-200 p-4 flex items-start justify-between gap-4 cursor-pointer hover:border-blue-300"
               data-id="${escapeHtml(p.id)}">
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
  if (btn) return completeReview(btn.dataset.id);
  // 点击列表其他区域 → 打开详情弹窗
  const item = e.target.closest(".review-item[data-id]");
  if (item) showProblemDetail(Number(item.dataset.id));
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
    problems.forEach((p) => problemsCache.set(p.id, p));
    container.innerHTML = problems
      .map((p) => {
        const content =
          p.question_latex || p.latex_code || p.raw_text || "（无题目文本）";
        return `
          <div class="export-item flex items-start gap-3 bg-white rounded-lg border border-slate-200 p-3 cursor-pointer">
            <input type="checkbox" class="export-cb mt-1" value="${escapeHtml(
              p.id
            )}" />
            <div class="export-body min-w-0 flex-1" data-id="${escapeHtml(p.id)}">
              <div class="text-xs text-slate-400 mb-1">#${escapeHtml(
                p.id
              )} · ${escapeHtml(p.subject || "未分类")}</div>
              <div class="latex-content text-sm text-slate-700 line-clamp-2">${escapeHtml(
                content
              )}</div>
            </div>
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

// 读取当前选中的导出版本 → { include_answers, answers_last }
function getExportVersion() {
  const v = document.querySelector(
    'input[name="export-version"]:checked'
  )?.value;
  if (v === "no-answers") return { include_answers: false, answers_last: false };
  if (v === "answers-last") return { include_answers: true, answers_last: true };
  return { include_answers: true, answers_last: false };
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
      body: JSON.stringify({ problem_ids: ids, ...getExportVersion() }),
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

// 导出 PDF：构造打印用 HTML → 主进程 printToPDF → 保存对话框
async function exportPDF() {
  const checked = Array.from(
    document.querySelectorAll("#export-container .export-cb:checked")
  ).map((cb) => Number(cb.value));
  if (!checked.length) {
    window.alert("请先勾选要导出的错题。");
    return;
  }
  const items = checked
    .map((id) => problemsCache.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      subject: p.subject || "未分类",
      question: p.question_latex || p.latex_code || p.raw_text || "（无内容）",
      answer: p.answer_latex || "",
    }));
  if (!items.length) {
    window.alert("所选错题数据未加载，请刷新后重试。");
    return;
  }

  const btn = document.getElementById("export-pdf-btn");
  btn.disabled = true;
  try {
    if (!window.pdfApi || typeof window.pdfApi.exportPdf !== "function") {
      throw new Error("当前环境不支持 PDF 导出（需通过 Electron 运行）");
    }
    const result = await window.pdfApi.exportPdf({
      html: buildPdfHtml(items),
      suggestedName: "mistakes.pdf",
    });
    if (!result.canceled) {
      window.alert(`PDF 已导出：${result.filePath}`);
    }
  } catch (err) {
    window.alert(`导出 PDF 失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// 构建打印 HTML：KaTeX 随 CDN 加载（公式用 Computer Modern 字体），
// 版式参考中文 LaTeX 试卷：宋体正文 + 居中大标题 + A4 学术页边距。
function buildPdfHtml(items) {
  const { include_answers, answers_last } = getExportVersion();
  const today = new Date().toISOString().slice(0, 10);
  const count = items.length;

  const problemBlock = (item, num) => {
    const q = escapeHtml(item.question);
    const a = escapeHtml(item.answer);
    const withAnswer = include_answers && !answers_last && a;
    return `
      <div class="problem">
        <div class="p-title">第 ${num} 题（${escapeHtml(item.subject)}）</div>
        <div class="p-body">${q}</div>
        ${withAnswer ? `<div class="p-answer"><div class="p-answer-label">【答案】</div><div>${a}</div></div>` : ""}
      </div>`;
  };

  let body = "";
  if (answers_last && include_answers) {
    // 答案在最后：题目区 + 参考答案区（参考答案另起一页）
    body = items.map((item, i) => problemBlock(item, i + 1)).join("");
    body += `<div class="answers-section"><h2>参考答案</h2>`;
    items.forEach((item, i) => {
      const a = escapeHtml(item.answer);
      body += `<div class="problem"><div class="p-title">第 ${i + 1} 题</div><div class="p-body">${
        a || "（无答案）"
      }</div></div>`;
    });
    body += `</div>`;
  } else {
    body = items.map((item, i) => problemBlock(item, i + 1)).join("");
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>数理化错题本导出</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<script>
  // auto-render 脚本只定义函数不会自动渲染，必须显式调用。
  // defer 脚本在 DOMContentLoaded 前已执行，故在此注册 DOMContentLoaded。
  // 渲染完成后打标记，主进程轮询确认后再打印，避免 PDF 里出现 LaTeX 源码。
  // 注意：这里是模板字符串，\\\\ 输出后才是页面里的 \\（JS 里 \\ 才是 \[）。
  document.addEventListener("DOMContentLoaded", function () {
    if (window.renderMathInElement) {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: "\\\\[", right: "\\\\]", display: true },
          { left: "\\\\(", right: "\\\\)", display: false },
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    }
    window.__pdfRendered = true;
  });
</script>
<style>
  @page { size: A4; margin: 20mm 18mm 22mm; }
  body {
    font-family: "SimSun", "Songti SC", "Noto Serif CJK SC", serif;
    color: #111;
    font-size: 12pt;
    line-height: 1.8;
    margin: 0;
  }
  /* 试卷头部：居中大标题 + 日期说明 */
  .paper-head { text-align: center; margin-bottom: 4mm; }
  h1 {
    font-family: "SimHei", "Heiti SC", "Noto Sans CJK SC", sans-serif;
    font-size: 20pt;
    letter-spacing: 6px;
    margin: 0 0 3mm;
    font-weight: 700;
  }
  .paper-meta { font-size: 10.5pt; color: #444; margin: 0; }
  .paper-rule { border: none; border-top: 1.5px solid #111; margin: 5mm 0 8mm; }

  /* 题目 */
  .problem { margin-bottom: 7mm; page-break-inside: avoid; }
  .p-title {
    font-family: "SimHei", "Heiti SC", "Noto Sans CJK SC", sans-serif;
    font-weight: 700;
    font-size: 12.5pt;
    margin-bottom: 2mm;
  }
  .p-body { font-size: 12pt; white-space: pre-wrap; text-align: justify; }
  .p-body p { margin: 0 0 1.5mm; }

  /* 答案（含答案版）：灰色边框左侧竖线，像答案册 */
  .p-answer {
    margin-top: 3mm;
    padding: 2.5mm 4mm;
    border-left: 3px solid #888;
    background: #fafafa;
    font-size: 11.5pt;
    white-space: pre-wrap;
    line-height: 1.75;
  }
  .p-answer-label { font-weight: 700; color: #333; margin-bottom: 1mm; }

  /* 参考答案（答案在最后版）：另起一页，标题不悬空 */
  .answers-section { page-break-before: always; }
  .answers-section h2 {
    font-family: "SimHei", "Heiti SC", "Noto Sans CJK SC", sans-serif;
    font-size: 16pt;
    text-align: center;
    letter-spacing: 4px;
    border-bottom: 1.5px solid #111;
    padding-bottom: 2mm;
    margin: 0 0 6mm;
    page-break-after: avoid;
  }
  .answers-section .p-title { font-size: 11.5pt; }
  .answers-section .p-body { font-size: 11.5pt; }

  /* 题号从新页开始时不孤行 */
  .problem { break-inside: avoid; }
</style>
</head>
<body>
  <div class="paper-head">
    <h1>错题本 · 复习卷</h1>
    <p class="paper-meta">共 ${count} 题 · 导出日期 ${today}</p>
  </div>
  <hr class="paper-rule" />
${body}
</body>
</html>`;
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

  // 详情弹窗关闭方式
  document.getElementById("detail-close-btn").addEventListener("click", closeDetailModal);
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDetailModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetailModal();
  });

  // 详情弹窗：题目/答案 tab
  document.getElementById("tab-question").addEventListener("click", () => setDetailTab("question"));
  document.getElementById("tab-answer").addEventListener("click", () => setDetailTab("answer"));
  // 答案：手动输入 / AI 生成 / 编辑
  document.getElementById("answer-input-btn").addEventListener("click", showAnswerEdit);
  document.getElementById("answer-ai-btn").addEventListener("click", generateAnswerByAI);
  document.getElementById("answer-save-btn").addEventListener("click", saveAnswer);
  document.getElementById("answer-cancel-btn").addEventListener("click", renderAnswerPanel);
  document.getElementById("answer-edit-btn").addEventListener("click", showAnswerEdit);
  // 标签：添加 / 删除
  document.getElementById("tag-add-btn").addEventListener("click", addTag);
  document.getElementById("tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTag();
  });
  document.getElementById("detail-tags").addEventListener("click", (e) => {
    const btn = e.target.closest(".tag-del-btn");
    if (btn) removeTag(btn.dataset.tag);
  });

  // 导出列表：点题目内容打开详情（checkbox 独立勾选）
  document.getElementById("export-container").addEventListener("click", (e) => {
    const body = e.target.closest(".export-body[data-id]");
    if (body) showProblemDetail(Number(body.dataset.id));
  });

  // 错题本：按标签搜索（防抖 300ms）
  let searchTimer = null;
  document.getElementById("search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      loadProblems();
    }, 300);
  });

  // 导出 PDF
  document.getElementById("export-pdf-btn").addEventListener("click", exportPDF);

  bindEditorEvents();
  checkBackend();
  loadProblems();
});
