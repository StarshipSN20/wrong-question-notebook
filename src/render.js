// 前端逻辑：与本地 FastAPI 通信、渲染错题卡片与公式、录入/设置交互。

const API_BASE = "http://127.0.0.1:8000";

// 视图 → 标题的 i18n key（标题随语言切换，见 i18n.js）。
const VIEW_TITLE_KEYS = {
  notebook: "nav.notebook",
  editor: "nav.editor",
  similar: "nav.similar",
  review: "nav.review",
  export: "nav.export",
  settings: "nav.settings",
};

function viewTitle(view) {
  return t(VIEW_TITLE_KEYS[view] || "nav.notebook");
}

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
// 当前视图（切换语言后据此重新渲染动态内容）
let currentView = "notebook";

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
// 「源自 #N」里的 N：优先显示父题的连续序号（seq），
// 缓存里没有父题时退回其数据库 id。
function parentSeq(parentId) {
  const parent = problemsCache.get(parentId);
  return parent && parent.seq ? parent.seq : parentId;
}

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
  const content =
    problem.question_latex || problem.latex_code || problem.raw_text || t("card.noText");

  const generatedBadge = problem.is_generated
    ? `<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-700">${escapeHtml(
        t("card.fromParent", { n: parentSeq(problem.parent_id) })
      )}</span>`
    : "";

  return `
    <article class="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
             data-id="${escapeHtml(problem.id)}">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="inline-block px-2 py-0.5 text-xs rounded ${subjectClass}">${escapeHtml(
    subjectLabel(problem.subject)
  )}</span>
          ${generatedBadge}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-400">#${escapeHtml(problem.seq || problem.id)}</span>
          <button class="delete-btn text-slate-300 hover:text-red-500 text-sm leading-none" data-id="${escapeHtml(
            problem.id
          )}" title="${escapeHtml(t("card.delete"))}">✕</button>
        </div>
      </div>
      <div class="latex-content text-sm text-slate-700 mb-3 line-clamp-3">${escapeHtml(
        content
      )}</div>
      <div class="flex flex-wrap gap-1 mb-3">${tagsHtml}</div>
      <div class="flex items-center gap-2 mb-3">
        <button class="gen-btn px-2 py-1 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100"
                data-id="${escapeHtml(problem.id)}" data-type="变式">${escapeHtml(
    t("card.genVariant")
  )}</button>
        <button class="gen-btn px-2 py-1 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100"
                data-id="${escapeHtml(problem.id)}" data-type="拓展">${escapeHtml(
    t("card.genExtend")
  )}</button>
      </div>
      <div class="flex items-center justify-between text-xs text-slate-400 border-t border-slate-100 pt-2">
        <span>${escapeHtml(
          t("card.nextReview", { date: problem.next_review_date })
        )}</span>
        <span>${escapeHtml(t("card.stage", { n: problem.review_stage }))}</span>
      </div>
    </article>
  `;
}

async function loadProblems() {
  const container = document.getElementById("problems-container");
  container.innerHTML = `<p class="text-slate-400 col-span-full">${escapeHtml(
    t("common.loading")
  )}</p>`;

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
          <p class="text-lg mb-1">${escapeHtml(
            t(q ? "notebook.noMatchTitle" : "notebook.emptyTitle")
          )}</p>
          <p class="text-sm">${escapeHtml(
            q
              ? t("notebook.noMatchHint", { q: searchQuery })
              : t("notebook.emptyHint")
          )}</p>
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
        <p class="text-lg mb-1">${escapeHtml(t("notebook.offlineTitle"))}</p>
        <p class="text-sm">${escapeHtml(
          t("notebook.offlineHint", { msg: err.message, url: API_BASE })
        )}</p>
      </div>`;
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
  if (!window.confirm(t("card.deleteConfirm"))) return;
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
    window.alert(t("card.deleteFailed", { msg: err.message }));
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
    .catch((err) => window.alert(t("detail.loadFailed", { msg: err.message })));
}

function renderDetail(p) {
  detailProblem = p;
  renderSubjectBadge(p);
  document.getElementById("detail-id").textContent = `#${p.seq || p.id}`;

  const badge = document.getElementById("detail-badge");
  if (p.is_generated) {
    badge.textContent = t("card.fromParent", { n: parentSeq(p.parent_id) });
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  // 题目面板：只用题目部分
  const content = document.getElementById("detail-content");
  content.textContent =
    p.question_latex || p.latex_code || p.raw_text || t("card.noText");
  renderLatex(content);

  renderAnswerPanel();
  renderDetailTags();
  setDetailTab("question");
  document.getElementById("answer-correct-input").value = "";
  document.getElementById("subject-status").textContent = "";

  document.getElementById("detail-created").textContent = p.created_at || "-";
  document.getElementById("detail-review-date").textContent = p.next_review_date || "-";
  document.getElementById("detail-review-stage").textContent = p.review_stage ?? 0;

  document.getElementById("detail-modal").classList.remove("hidden");
}

function closeDetailModal() {
  document.getElementById("detail-modal").classList.add("hidden");
}

// 答案面板：有答案则渲染并显示「重新生成 / 修正 / 编辑」工具区，
// 无答案显示空态（手动输入 / AI 生成）。与「录入/编辑」页的题目流程一致。
// keepStatus：AI 生成完成后保留状态提示（否则刚写的「已生成 ✓」会被立刻擦掉）。
function renderAnswerPanel(keepStatus = false) {
  const p = detailProblem;
  const render = document.getElementById("detail-answer-render");
  const empty = document.getElementById("answer-empty");
  const edit = document.getElementById("answer-edit");
  const tools = document.getElementById("answer-tools");

  const answer = p.answer_latex;
  // textContent 而非 innerHTML：答案是纯文本，KaTeX 随后就地把公式替换成 DOM，
  // 这样既不会 XSS 也不会把用户写的 < 当标签。
  render.textContent = answer || "";
  renderLatex(render);

  const hasAnswer = !!(answer && answer.trim());
  render.classList.toggle("hidden", !hasAnswer);
  empty.classList.toggle("hidden", hasAnswer);
  tools.classList.toggle("hidden", !hasAnswer);
  edit.classList.add("hidden");
  document.getElementById("answer-input").value = answer || "";
  document.getElementById("answer-edit-status").textContent = "";
  if (!keepStatus) setAnswerStatus("");
}

// 答案区状态提示（生成中 / 已生成 / 失败）
function setAnswerStatus(msg, kind = "info") {
  const el = document.getElementById("answer-status");
  el.textContent = msg || "";
  const color =
    kind === "error"
      ? "text-red-500"
      : kind === "ok"
      ? "text-emerald-600"
      : "text-slate-500";
  // 有内容时才留上边距，避免空状态下多出一条空白
  el.className = `text-sm ${color}${msg ? " mt-2" : ""}`;
}

// 详情弹窗标签区渲染
function renderDetailTags() {
  const p = detailProblem;
  const tags = Array.isArray(p.tags) ? p.tags : [];
  const delTitle = escapeHtml(t("detail.deleteTag"));
  document.getElementById("detail-tags").innerHTML = tags
    .map(
      (tag) => `<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-slate-100 text-slate-600 rounded">
        ${escapeHtml(tag)}
        <button class="tag-del-btn text-slate-400 hover:text-red-500" data-tag="${escapeHtml(tag)}" title="${delTitle}">✕</button>
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

// 手动输入 / 编辑答案：显示源码编辑区
function showAnswerEdit() {
  document.getElementById("answer-empty").classList.add("hidden");
  document.getElementById("answer-edit").classList.remove("hidden");
  document.getElementById("answer-input").focus();
}

// 保存手动输入的答案（PATCH answer_latex）
async function saveAnswer() {
  if (!detailProblem) return;
  const input = document.getElementById("answer-input");
  const status = document.getElementById("answer-edit-status");
  status.textContent = t("editor.saving");
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
    status.textContent = t("settings.saved");
    status.className = "text-sm text-emerald-600";
  } catch (err) {
    status.textContent = t("settings.saveFailed", { msg: err.message });
    status.className = "text-sm text-red-500";
  }
}

// 用 AI 生成 / 重新生成 / 按自然语言修正答案。
//
// 三种用法共用一个接口（POST /api/generate-answer）：
//   {}                        首次生成
//   { regenerate: true }      不满意，换一种思路重解
//   { user_feedback: "…" }    用自然语言说明哪里要改
// 与「录入/编辑」页题目的「提交修正」是同一套交互，只是作用在答案上。
async function generateAnswerByAI({ regenerate = false, feedback = "" } = {}) {
  if (!detailProblem) return;
  const buttons = [
    document.getElementById("answer-ai-btn"),
    document.getElementById("answer-regen-btn"),
    document.getElementById("answer-correct-btn"),
  ];
  const labels = buttons.map((b) => b.textContent);
  buttons.forEach((b) => {
    b.disabled = true;
  });
  const busyBtn = feedback
    ? document.getElementById("answer-correct-btn")
    : regenerate
    ? document.getElementById("answer-regen-btn")
    : document.getElementById("answer-ai-btn");
  busyBtn.textContent = t("card.generating");
  setAnswerStatus(
    feedback ? t("detail.answerCorrecting") : t("detail.aiGenerating")
  );

  try {
    const res = await fetch(`${API_BASE}/api/generate-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: detailProblem.id,
        regenerate,
        user_feedback: feedback || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    detailProblem = data;
    problemsCache.set(data.id, data);
    renderAnswerPanel(true);
    if (feedback) document.getElementById("answer-correct-input").value = "";
    setAnswerStatus(
      feedback
        ? t("detail.answerCorrected")
        : regenerate
        ? t("detail.answerRegenerated")
        : t("detail.aiGenerated"),
      "ok"
    );
  } catch (err) {
    setAnswerStatus(t("detail.aiGenFailed", { msg: err.message }), "error");
  } finally {
    buttons.forEach((b, i) => {
      b.disabled = false;
      b.textContent = labels[i];
    });
  }
}

// 自然语言修正答案（读输入框后走同一条生成链路）
function submitAnswerCorrection() {
  const input = document.getElementById("answer-correct-input");
  const feedback = input.value.trim();
  if (!feedback) return;
  generateAnswerByAI({ feedback });
}

// 改学科：PATCH subject，后端会同步替换旧的学科标签
async function changeSubject(value) {
  if (!detailProblem) return;
  const status = document.getElementById("subject-status");
  status.textContent = t("editor.saving");
  status.className = "text-xs text-slate-400";
  try {
    const res = await fetch(`${API_BASE}/api/problems/${detailProblem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    detailProblem = data;
    problemsCache.set(data.id, data);
    // 学科色块、标签、列表卡片都跟着变
    renderSubjectBadge(data);
    renderDetailTags();
    status.textContent = t("settings.saved");
    status.className = "text-xs text-emerald-600";
    refreshCurrentList();
  } catch (err) {
    status.textContent = t("detail.subjectFailed", { msg: err.message });
    status.className = "text-xs text-red-500";
  }
}

// 弹窗顶部的学科色块（改学科后要重画）
function renderSubjectBadge(p) {
  const el = document.getElementById("detail-subject");
  el.textContent = subjectLabel(p.subject);
  el.className = `inline-block px-2 py-0.5 text-xs rounded ${
    SUBJECT_COLORS[p.subject] || "bg-slate-100 text-slate-700"
  }`;
  document.getElementById("detail-subject-select").value = p.subject || "";
}

// 重新加载当前视图的列表（改学科/标签后让卡片同步）
function refreshCurrentList() {
  if (currentView === "notebook") loadProblems();
  else if (currentView === "similar") loadSimilar();
  else if (currentView === "review") loadReviewDue();
  else if (currentView === "export") loadExportList();
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
    status.textContent = t("detail.tagExists");
    status.className = "text-xs text-slate-400";
    return;
  }
  status.textContent = t("editor.saving");
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
    status.textContent = t("detail.tagAdded");
    status.className = "text-xs text-emerald-600";
  } catch (err) {
    status.textContent = t("detail.tagFailed", { msg: err.message });
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
    window.alert(t("detail.tagDelFailed", { msg: err.message }));
  }
}

// 生成变式/拓展题（举一反三）。
async function generateSimilar(btn) {
  const id = btn.dataset.id;
  // data-type 传给后端的值始终是中文（接口协议），界面文案另行翻译。
  const type = btn.dataset.type || "变式";
  const typeLabel = t(type === "拓展" ? "type.extend" : "type.variant");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("card.generating");
  try {
    const res = await fetch(`${API_BASE}/api/generate-similar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_id: Number(id), type }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    window.alert(
      t("card.genDone", { type: typeLabel, n: data.seq || data.id })
    );
    loadProblems();
  } catch (err) {
    window.alert(t("card.genFailed", { msg: err.message }));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function checkBackend() {
  const el = document.getElementById("backend-status");
  // 状态文本由本函数动态写入，去掉 data-i18n 标记避免语言切换时被覆盖回「检测中」。
  el.removeAttribute("data-i18n");
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    el.textContent = t(
      data.status === "ok" ? "backend.running" : "backend.abnormal"
    );
    el.className = "text-emerald-400";
  } catch {
    el.textContent = t("backend.offline");
    el.className = "text-red-400";
  }
}

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.getElementById("view-title").textContent = viewTitle(view);

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
  }
}

// ---------------------------------------------------------------------------
// 举一反三视图：列出所有已生成题目
// ---------------------------------------------------------------------------
async function loadSimilar() {
  const container = document.getElementById("similar-container");
  container.innerHTML = `<p class="text-slate-400 col-span-full">${escapeHtml(
    t("common.loading")
  )}</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/problems`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    const generated = all.filter((p) => p.is_generated);
    all.forEach((p) => problemsCache.set(p.id, p));
    if (!generated.length) {
      container.innerHTML = `
        <div class="col-span-full text-center py-16 text-slate-400">
          <p class="text-lg mb-1">${escapeHtml(t("similar.emptyTitle"))}</p>
          <p class="text-sm">${escapeHtml(t("similar.emptyHint"))}</p>
        </div>`;
      return;
    }
    container.innerHTML = generated.map(renderCard).join("");
    renderLatex(container);
  } catch (err) {
    container.innerHTML = `<p class="text-red-400 col-span-full">${escapeHtml(
      t("common.loadFailed", { msg: err.message })
    )}</p>`;
  }
}

// ---------------------------------------------------------------------------
// 复习计划视图
// ---------------------------------------------------------------------------
async function loadReviewDue() {
  const container = document.getElementById("review-container");
  container.innerHTML = `<p class="text-slate-400">${escapeHtml(
    t("common.loading")
  )}</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/review/due`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const due = await res.json();
    if (!due.length) {
      container.innerHTML = `
        <div class="text-center py-16 text-slate-400">
          <p class="text-lg mb-1">${escapeHtml(t("review.emptyTitle"))}</p>
          <p class="text-sm">${escapeHtml(t("review.emptyHint"))}</p>
        </div>`;
      return;
    }
    due.forEach((p) => problemsCache.set(p.id, p));
    container.innerHTML = due
      .map((p) => {
        const content =
          p.question_latex || p.latex_code || p.raw_text || t("card.noText");
        return `
          <div class="review-item bg-white rounded-lg border border-slate-200 p-4 flex items-start justify-between gap-4 cursor-pointer hover:border-blue-300"
               data-id="${escapeHtml(p.id)}">
            <div class="min-w-0">
              <div class="text-xs text-slate-400 mb-1">#${escapeHtml(
                p.seq || p.id
              )} · ${escapeHtml(subjectLabel(p.subject))} · ${escapeHtml(
          t("card.stage", { n: p.review_stage })
        )}</div>
              <div class="latex-content text-sm text-slate-700 line-clamp-3">${escapeHtml(
                content
              )}</div>
            </div>
            <button class="review-done-btn shrink-0 px-3 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
                    data-id="${escapeHtml(p.id)}">${escapeHtml(
          t("review.markDone")
        )}</button>
          </div>`;
      })
      .join("");
    renderLatex(container);
  } catch (err) {
    container.innerHTML = `<p class="text-red-400">${escapeHtml(
      t("common.loadFailed", { msg: err.message })
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
    window.alert(t("review.opFailed", { msg: err.message }));
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
  container.innerHTML = `<p class="text-slate-400">${escapeHtml(
    t("common.loading")
  )}</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/problems`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const problems = await res.json();
    if (!problems.length) {
      container.innerHTML = `<p class="text-slate-400 text-center py-16">${escapeHtml(
        t("export.emptyHint")
      )}</p>`;
      return;
    }
    problems.forEach((p) => problemsCache.set(p.id, p));
    container.innerHTML = problems
      .map((p) => {
        const content =
          p.question_latex || p.latex_code || p.raw_text || t("card.noText");
        return `
          <div class="export-item flex items-start gap-3 bg-white rounded-lg border border-slate-200 p-3 cursor-pointer">
            <input type="checkbox" class="export-cb mt-1" value="${escapeHtml(
              p.id
            )}" />
            <div class="export-body min-w-0 flex-1" data-id="${escapeHtml(p.id)}">
              <div class="text-xs text-slate-400 mb-1">#${escapeHtml(
                p.seq || p.id
              )} · ${escapeHtml(subjectLabel(p.subject))}</div>
              <div class="latex-content text-sm text-slate-700 line-clamp-2">${escapeHtml(
                content
              )}</div>
            </div>
          </div>`;
      })
      .join("");
    renderLatex(container);
  } catch (err) {
    container.innerHTML = `<p class="text-red-400">${escapeHtml(
      t("common.loadFailed", { msg: err.message })
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
    window.alert(t("export.selectFirst"));
    return;
  }
  const btn = document.getElementById("export-btn");
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_ids: ids,
        ...getExportVersion(),
        // .tex 卷头语言跟随界面，避免英文界面导出中文卷头
        language: getLanguage(),
      }),
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
    window.alert(t("export.failed", { msg: err.message }));
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
    window.alert(t("export.selectFirst"));
    return;
  }
  const items = checked
    .map((id) => problemsCache.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      subject: subjectLabel(p.subject),
      question:
        p.question_latex || p.latex_code || p.raw_text || t("pdf.noContent"),
      answer: p.answer_latex || "",
    }));
  if (!items.length) {
    window.alert(t("export.notLoaded"));
    return;
  }

  const btn = document.getElementById("export-pdf-btn");
  btn.disabled = true;
  try {
    if (!window.pdfApi || typeof window.pdfApi.exportPdf !== "function") {
      throw new Error(t("export.pdfUnsupported"));
    }
    const result = await window.pdfApi.exportPdf({
      html: buildPdfHtml(items),
      suggestedName: "mistakes.pdf",
    });
    if (!result.canceled) {
      window.alert(t("export.pdfSaved", { path: result.filePath }));
    }
  } catch (err) {
    window.alert(t("export.pdfFailed", { msg: err.message }));
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
    const title = escapeHtml(
      t("pdf.problemNo", { n: num, subject: item.subject })
    );
    const answerLabel = escapeHtml(t("pdf.answerLabel"));
    return `
      <div class="problem">
        <div class="p-title">${title}</div>
        <div class="p-body">${q}</div>
        ${withAnswer ? `<div class="p-answer"><div class="p-answer-label">${answerLabel}</div><div>${a}</div></div>` : ""}
      </div>`;
  };

  let body = "";
  if (answers_last && include_answers) {
    // 答案在最后：题目区 + 参考答案区（参考答案另起一页）
    body = items.map((item, i) => problemBlock(item, i + 1)).join("");
    body += `<div class="answers-section"><h2>${escapeHtml(
      t("pdf.refAnswers")
    )}</h2>`;
    items.forEach((item, i) => {
      const a = escapeHtml(item.answer);
      body += `<div class="problem"><div class="p-title">${escapeHtml(
        t("pdf.problemN", { n: i + 1 })
      )}</div><div class="p-body">${a || escapeHtml(t("pdf.noAnswer"))}</div></div>`;
    });
    body += `</div>`;
  } else {
    body = items.map((item, i) => problemBlock(item, i + 1)).join("");
  }

  // 本地 KaTeX（打包后离线可用）。主窗口是 file:// 页面，据此算出
  // vendor 的绝对路径，打印窗口以 file:// 加载（主进程写临时文件）。
  const katexBase = new URL("vendor/katex/", window.location.href).href;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(t("pdf.title"))}</title>
<link rel="stylesheet" href="${katexBase}katex.min.css" />
<script src="${katexBase}katex.min.js"></script>
<script defer src="${katexBase}auto-render.min.js"></script>
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
    <h1>${escapeHtml(t("pdf.title"))}</h1>
    <p class="paper-meta">${escapeHtml(
      t("pdf.meta", { n: count, date: today })
    )}</p>
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
  document.getElementById("result-subject").textContent = subjectLabel(
    problem.subject
  );
  document.getElementById("result-id").textContent = `#${
    problem.seq || problem.id
  }`;

  const render = document.getElementById("result-render");
  render.textContent =
    problem.latex_code || problem.raw_text || t("editor.empty");
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
  setEditorStatus(t("editor.recognizing"));
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
    setEditorStatus(t("editor.recognized"));
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

  setEditorStatus(t("editor.correcting"));
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
    setEditorStatus(t("editor.corrected"));
  } catch (err) {
    setEditorStatus(err.message, true);
  }
}

async function updateLatex() {
  if (!currentProblem) return;
  const latex = document.getElementById("latex-textarea").value;

  setEditorStatus(t("editor.saving"));
  try {
    const res = await fetch(`${API_BASE}/api/problems/${currentProblem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latex_code: latex }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    showResult(data);
    setEditorStatus(t("editor.updated"));
  } catch (err) {
    setEditorStatus(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// 设置视图
// ---------------------------------------------------------------------------
// 推理档位下拉框的展示名（阶梯值 → i18n key）。
const EFFORT_LABEL_KEYS = {
  none: "effort.none",
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
};

// 按当前模型构建推理档位下拉框。
//
// 档位不是写死的：向 /api/effort/levels 要「这个模型实际能用哪些档位」，
// 数据来源可能是真实探测（probe）、调用中撞墙学到的（learned）、
// 已知模型表（catalog）或完全未知（default）。
// 不支持的档位不隐藏、只标注，因为探测结果可能偏保守，用户仍应能手动选。
async function loadEffortLevels(selected) {
  const select = document.getElementById("cfg-reasoning-effort");
  const note = document.getElementById("effort-source");
  const model = document.getElementById("cfg-model-name").value.trim();

  // 把「当前选中的档位」一起带上：后端据此算出实际会发送的档位，
  // 于是用户还没点保存就能看到「这一档会被降级成 X」。
  const wanted = selected || document.getElementById("cfg-reasoning-effort").value;

  let info = null;
  try {
    const qs = new URLSearchParams({ model });
    if (wanted) qs.set("requested", wanted);
    const res = await fetch(`${API_BASE}/api/effort/levels?${qs}`);
    if (res.ok) info = await res.json();
  } catch {
    /* 后端不可用：下面用整条阶梯兜底，不影响用户改设置 */
  }

  const ladder = info?.ladder || Object.keys(EFFORT_LABEL_KEYS);
  const supported = info?.supported || ladder;
  const knownSupport = info && info.source !== "default";

  const options = ladder.map((level) => {
    const label = t(EFFORT_LABEL_KEYS[level] || level);
    // 只有在「确实知道支持情况」时才标注不支持，避免 default 状态下误导。
    const suffix = knownSupport && !supported.includes(level)
      ? ` ${t("effort.unsupportedSuffix")}`
      : "";
    return `<option value="${escapeHtml(level)}">${escapeHtml(label + suffix)}</option>`;
  });
  options.push(
    `<option value="auto">${escapeHtml(t("settings.effortAuto"))}</option>`
  );
  select.innerHTML = options.join("");

  const want = selected || info?.requested || "high";
  select.value = ladder.includes(want) || want === "auto" ? want : "high";

  renderEffortSource(info, note);
}

// 档位信息的来源说明 + 「会自动降级为 X」提示
function renderEffortSource(info, note) {
  if (!info) {
    note.textContent = "";
    return;
  }
  const sourceText = t(`effort.source.${info.source}`);
  const select = document.getElementById("cfg-reasoning-effort");
  const chosen = select.value;
  const knownSupport = info.source !== "default";

  let extra = "";
  if (knownSupport && chosen !== "auto" && !info.supported.includes(chosen)) {
    // info.effective 就是后端 resolve() 对「当前选中档位」算出的实际发送值。
    // 只有在它确实换了一档时才说「会用 X」，否则退回泛化提示。
    const effective =
      info.requested === chosen && info.effective && info.effective !== chosen
        ? info.effective
        : null;
    extra = effective
      ? ` ${t("effort.willDegrade", { level: effective })}`
      : ` ${t("effort.mayDegrade")}`;
  }
  note.textContent = sourceText + extra;
  note.className = `mt-1 text-xs ${extra ? "text-amber-600" : "text-slate-500"}`;
}

async function loadConfig() {
  const status = document.getElementById("config-status");
  status.textContent = "";
  document.getElementById("models-status").textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const cfg = await res.json();
    document.getElementById("cfg-api-key").value = cfg.api_key || "";
    document.getElementById("cfg-base-url").value = cfg.base_url || "";
    document.getElementById("cfg-model-name").value = cfg.model_name || "";
    await loadEffortLevels(cfg.reasoning_effort || "high");
    // 界面语言以本地生效的值为准（localStorage 已在 i18n.js 中读取），
    // 避免后端配置与当前界面不一致时下拉框显示错位。
    document.getElementById("cfg-ui-language").value = getLanguage();
  } catch (err) {
    status.textContent = t("settings.loadFailed", { msg: err.message });
    status.className = "text-sm text-red-500";
  }
}

// 真实探测当前模型支持哪些档位：后端会逐档发一次极小请求。
// 需要先保存配置（探测用的是后端已存的 key/base_url/model）。
async function probeEffort() {
  const btn = document.getElementById("probe-effort-btn");
  const note = document.getElementById("effort-source");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("settings.probing");
  note.textContent = t("settings.probingHint");
  note.className = "mt-1 text-xs text-slate-500";
  try {
    // 先落盘当前表单，否则探测的是上一次保存的模型
    await saveConfig({ silent: true });
    const res = await fetch(`${API_BASE}/api/effort/probe`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    const select = document.getElementById("cfg-reasoning-effort");
    await loadEffortLevels(select.value);
    const parts = [
      t("settings.probeDone", {
        list: data.supported.length ? data.supported.join(" / ") : t("settings.probeNone"),
      }),
    ];
    if (data.inconclusive?.length) {
      parts.push(t("settings.probeUnclear", { list: data.inconclusive.join(" / ") }));
    }
    note.textContent = parts.join("  ");
    note.className = "mt-1 text-xs text-emerald-600";
  } catch (err) {
    note.textContent = t("settings.probeFailed", { msg: err.message });
    note.className = "mt-1 text-xs text-red-500";
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 拉上游模型列表，填进 datalist（输入框仍可手填）
async function fetchModels() {
  const btn = document.getElementById("fetch-models-btn");
  const status = document.getElementById("models-status");
  const original = btn.textContent;
  btn.disabled = true;
  status.textContent = t("common.loading");
  status.className = "mt-1 text-xs text-slate-400";
  try {
    await saveConfig({ silent: true });
    const res = await fetch(`${API_BASE}/api/models`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    const models = data.models || [];
    document.getElementById("cfg-model-list").innerHTML = models
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join("");
    status.textContent = models.length
      ? t("settings.modelsLoaded", { n: models.length })
      : t("settings.modelsEmpty");
    status.className = `mt-1 text-xs ${models.length ? "text-emerald-600" : "text-slate-400"}`;
  } catch (err) {
    status.textContent = t("settings.modelsFailed", { msg: err.message });
    status.className = "mt-1 text-xs text-red-500";
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 保存设置。silent=true 时不写状态提示、失败向上抛——
// 供「检测可用档位」「获取模型列表」先落盘表单再调用后端时复用
// （后端读的是 config.json，不先保存就会拿上一次的模型名去探测）。
async function saveConfig({ silent = false } = {}) {
  const status = document.getElementById("config-status");
  const payload = {
    api_key: document.getElementById("cfg-api-key").value,
    base_url: document.getElementById("cfg-base-url").value,
    model_name: document.getElementById("cfg-model-name").value,
    reasoning_effort: document.getElementById("cfg-reasoning-effort").value,
    ui_language: document.getElementById("cfg-ui-language").value,
  };
  if (!silent) {
    status.textContent = t("editor.saving");
    status.className = "text-sm text-slate-500";
  }
  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!silent) {
      status.textContent = t("settings.saved");
      status.className = "text-sm text-emerald-600";
    }
  } catch (err) {
    if (silent) throw err;
    status.textContent = t("settings.saveFailed", { msg: err.message });
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

// 切换界面语言：刷新静态文本 + 重渲染当前视图的动态内容，
// 并把选择写回后端 config.json（主进程的系统通知文案复用同一份配置）。
async function changeLanguage(lang) {
  setLanguage(lang);

  // 标题、侧栏后端状态等由 JS 动态写入，需重新生成一遍。
  document.getElementById("view-title").textContent = viewTitle(currentView);
  checkBackend();
  const langSelect = document.getElementById("cfg-ui-language");
  if (langSelect) langSelect.value = getLanguage();

  // 推理档位下拉框是动态生成的，applyStaticTranslations 管不到它，
  // 必须重建一遍，否则切到英文后档位名还是中文。
  const effortSelect = document.getElementById("cfg-reasoning-effort");
  if (effortSelect) await loadEffortLevels(effortSelect.value);

  // 重渲染当前视图（卡片、列表里的文案与学科名都随语言变）。
  refreshCurrentList();

  // 详情弹窗若开着，一并重渲染。
  const modal = document.getElementById("detail-modal");
  if (detailProblem && modal && !modal.classList.contains("hidden")) {
    renderDetail(detailProblem);
  }

  // 持久化到后端（失败不影响界面，语言已存 localStorage）。
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const cfg = await res.json();
    await fetch(`${API_BASE}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...cfg, ui_language: getLanguage() }),
    });
  } catch {
    /* 后端不可用时忽略：界面语言已生效，下次保存配置时会补写 */
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // 先按已存语言刷新一遍静态文本（i18n.js 已从 localStorage 读出语言）。
  applyStaticTranslations();

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
  // 包一层箭头函数：直接传 saveConfig 会把 MouseEvent 当参数传进去
  document
    .getElementById("save-config-btn")
    .addEventListener("click", () => saveConfig());

  // 设置页：模型列表 / 档位探测
  document.getElementById("fetch-models-btn").addEventListener("click", fetchModels);
  document.getElementById("probe-effort-btn").addEventListener("click", probeEffort);

  // 模型名输入框右侧的 ⌄ 是 CSS 画的（为了和下拉框长得一样），本身不可点。
  // 点在箭头区域时用 showPicker() 打开候选列表，让它和真下拉框一样好用；
  // 点在文字区域仍然是正常输入，不会动不动就弹出列表。
  const modelInput = document.getElementById("cfg-model-name");
  modelInput.addEventListener("click", (e) => {
    const arrowZone = 34; // 与 styles.css 里 .choice-box 的 padding-right 对齐
    if (e.offsetX < modelInput.clientWidth - arrowZone) return;
    try {
      modelInput.showPicker();
    } catch {
      /* 老版本 Chromium 没有 showPicker：退回原生行为（聚焦后按 ↓ 也能开） */
    }
  });
  // 改模型名 → 重建档位下拉框（不同模型可用档位不同）
  let modelTimer = null;
  document.getElementById("cfg-model-name").addEventListener("input", () => {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(() => {
      const select = document.getElementById("cfg-reasoning-effort");
      loadEffortLevels(select.value);
    }, 400);
  });
  // 选了档位 → 立即提示是否会被降级
  document
    .getElementById("cfg-reasoning-effort")
    .addEventListener("change", () => {
      const select = document.getElementById("cfg-reasoning-effort");
      loadEffortLevels(select.value);
    });

  // 界面语言下拉框：选中即时生效（无需点保存）
  const langSelect = document.getElementById("cfg-ui-language");
  langSelect.value = getLanguage();
  langSelect.addEventListener("change", (e) => changeLanguage(e.target.value));

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
  // 答案：手动输入 / AI 生成 / 重新生成 / 自然语言修正 / 编辑源码
  document.getElementById("answer-input-btn").addEventListener("click", showAnswerEdit);
  document
    .getElementById("answer-ai-btn")
    .addEventListener("click", () => generateAnswerByAI());
  document
    .getElementById("answer-regen-btn")
    .addEventListener("click", () => generateAnswerByAI({ regenerate: true }));
  document
    .getElementById("answer-correct-btn")
    .addEventListener("click", submitAnswerCorrection);
  document
    .getElementById("answer-correct-input")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitAnswerCorrection();
    });
  document.getElementById("answer-save-btn").addEventListener("click", saveAnswer);
  // 取消编辑：回到只读态（箭头函数避免把 MouseEvent 当 keepStatus 传进去）
  document
    .getElementById("answer-cancel-btn")
    .addEventListener("click", () => renderAnswerPanel());
  document.getElementById("answer-edit-btn").addEventListener("click", showAnswerEdit);

  // 学科：下拉切换即保存（后端同步替换旧学科标签）
  document
    .getElementById("detail-subject-select")
    .addEventListener("change", (e) => changeSubject(e.target.value));
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
  // 初始标题按当前语言（HTML 里的中文只是首屏占位）
  document.getElementById("view-title").textContent = viewTitle(currentView);
  checkBackend();
  loadProblems();
});
