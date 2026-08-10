// 前端逻辑：与本地 FastAPI 通信、渲染错题卡片、导航切换。
// 骨架阶段：仅错题本视图拉取真实数据，其余视图为占位。

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

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 渲染单张错题卡片
function renderCard(problem) {
  const subjectClass = SUBJECT_COLORS[problem.subject] || "bg-slate-100 text-slate-700";
  const tags = Array.isArray(problem.tags) ? problem.tags : [];
  const tagsHtml = tags
    .map(
      (t) =>
        `<span class="inline-block px-2 py-0.5 text-xs bg-slate-100 text-slate-600 rounded">${escapeHtml(t)}</span>`
    )
    .join(" ");

  const text = problem.raw_text || problem.latex_code || "（无题目文本）";

  return `
    <article class="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div class="flex items-center justify-between mb-2">
        <span class="inline-block px-2 py-0.5 text-xs rounded ${subjectClass}">${escapeHtml(problem.subject || "未分类")}</span>
        <span class="text-xs text-slate-400">#${escapeHtml(problem.id)}</span>
      </div>
      <p class="text-sm text-slate-700 mb-3 line-clamp-3">${escapeHtml(text)}</p>
      <div class="flex flex-wrap gap-1 mb-3">${tagsHtml}</div>
      <div class="flex items-center justify-between text-xs text-slate-400 border-t border-slate-100 pt-2">
        <span>下次复习：${escapeHtml(problem.next_review_date)}</span>
        <span>阶段 ${escapeHtml(problem.review_stage)}/5</span>
      </div>
    </article>
  `;
}

// 拉取并渲染错题列表
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
          <p class="text-sm">在「录入/编辑」中添加，或用 POST /api/problems 接口新增一条测试数据。</p>
        </div>`;
      return;
    }

    container.innerHTML = problems.map(renderCard).join("");
  } catch (err) {
    container.innerHTML = `
      <div class="col-span-full text-center py-16 text-red-400">
        <p class="text-lg mb-1">无法连接后端</p>
        <p class="text-sm">${escapeHtml(err.message)}（请确认 FastAPI 已启动于 ${API_BASE}）</p>
      </div>`;
  }
}

// 检测后端健康状态，更新侧边栏提示
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

// 导航切换（骨架阶段仅切换高亮与标题；非错题本视图显示占位）
function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.getElementById("view-title").textContent = VIEW_TITLES[view] || "错题本";

  const container = document.getElementById("problems-container");
  if (view === "notebook") {
    loadProblems();
  } else {
    container.innerHTML = `
      <div class="col-span-full text-center py-16 text-slate-400">
        <p class="text-lg mb-1">「${VIEW_TITLES[view]}」</p>
        <p class="text-sm">该功能将在后续阶段实现。</p>
      </div>`;
  }
}

// 初始化事件绑定
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.getElementById("refresh-btn").addEventListener("click", loadProblems);

  checkBackend();
  loadProblems();
});
