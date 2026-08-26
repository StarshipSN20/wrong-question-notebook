// 界面多语言（中文 / English）。
//
// 用法：
// - 静态文本：在 HTML 元素上标 data-i18n="key"（文本）或 data-i18n-ph="key"（placeholder），
//   切换语言时由 applyStaticTranslations() 统一刷新。
// - 动态文本：在 render.js 里调用 t("key") 或 t("key", { n: 3 })。
//
// 语言偏好存 localStorage（前端即时生效），同时写入后端 config.json，
// 供主进程的系统通知文案复用。

const I18N = {
  zh: {
    "app.title": "数理化错题本",
    "nav.notebook": "错题本",
    "nav.editor": "录入/编辑",
    "nav.similar": "举一反三",
    "nav.review": "复习计划",
    "nav.export": "导出",
    "nav.settings": "设置",
    "backend.checking": "后端：检测中…",
    "backend.running": "后端：运行中 ●",
    "backend.abnormal": "后端：异常",
    "backend.offline": "后端：未连接 ○",
    "header.refresh": "刷新列表",

    "notebook.searchPh": "按标签搜索，如：函数、数学…",
    "common.loading": "加载中…",
    "common.loadFailed": "加载失败：{msg}",
    "notebook.emptyTitle": "还没有错题",
    "notebook.emptyHint": "在「录入/编辑」中上传图片/PDF/DOCX 让 AI 识别。",
    "notebook.noMatchTitle": "没有找到匹配的错题",
    "notebook.noMatchHint": "没有题目带标签「{q}」。",
    "notebook.offlineTitle": "无法连接后端",
    "notebook.offlineHint": "{msg}（请确认后端已启动于 {url}）",

    "card.uncategorized": "未分类",
    "card.fromParent": "源自 #{n}",
    "card.genVariant": "生成变式",
    "card.genExtend": "生成拓展",
    "card.generating": "生成中…",
    "card.delete": "删除",
    "card.noText": "（无题目文本）",
    "card.nextReview": "下次复习：{date}",
    "card.stage": "阶段 {n}/5",
    "card.deleteConfirm": "确定删除这道错题吗？此操作不可恢复。",
    "card.deleteFailed": "删除失败：{msg}",
    "card.genDone": "已生成{type}题 #{n}，可在「错题本」或「举一反三」查看。",
    "card.genFailed": "生成失败：{msg}",

    "editor.dropText": "拖拽文件到此处，或",
    "editor.dropClick": "点击选择",
    "editor.dropFormats": "支持 PNG / JPG / PDF / DOCX",
    "editor.previewAlt": "预览",
    "editor.recognize": "开始识别",
    "editor.recognizing": "识别中，请稍候…",
    "editor.recognized": "识别完成 ✓",
    "editor.resultLabel": "识别结果",
    "editor.correctLabel": "手动修正（自然语言）",
    "editor.correctPh": "如：把第二行的系数 2 改成 3",
    "editor.correctBtn": "提交修正",
    "editor.correcting": "AI 修正中…",
    "editor.corrected": "修正完成 ✓",
    "editor.latexLabel": "LaTeX 源码（可直接编辑）",
    "editor.updateBtn": "更新并重新渲染",
    "editor.saving": "保存中…",
    "editor.updated": "已更新 ✓",
    "editor.empty": "（空）",

    "settings.aiDesc": "配置兼容 OpenAI 规范的 AI 接口（如 Qwen-VL、Claude、DeepSeek）。识图需模型具备多模态能力。",
    "settings.apiKey": "API Key",
    "settings.baseUrl": "Base URL",
    "settings.modelName": "Model Name",
    "settings.modelPh": "如 qwen-vl-max / gpt-4o",
    "settings.effort": "推理强度",
    "settings.effortHint": "推理档位越高越准但更慢。不同模型支持的档位不同；若所选模型不支持，会自动忽略该参数。",
    "settings.effortAuto": "自动（不指定，由模型默认）",
    "settings.effortMinimal": "最低（minimal）",
    "settings.effortLow": "低（low）",
    "settings.effortMedium": "中（medium）",
    "settings.effortHigh": "高（high，推荐）",
    "settings.language": "界面语言",
    "settings.save": "保存配置",
    "settings.saved": "已保存 ✓",
    "settings.saveFailed": "保存失败：{msg}",
    "settings.loadFailed": "读取配置失败：{msg}",

    "similar.desc": "在「错题本」的任意卡片上点击「生成变式」或「生成拓展」，AI 会基于原题出一道带解答的新题。下面列出所有已生成的题目（带「源自」标签）。",
    "similar.emptyTitle": "还没有生成的题目",
    "similar.emptyHint": "去「错题本」某道题上点「生成变式」或「生成拓展」。",

    "review.desc": "按艾宾浩斯遗忘曲线（1 / 2 / 4 / 7 / 15 天）排程。下面是今天（含逾期）待复习的错题，复习完点「标记为已复习」即可推进到下一阶段。",
    "review.emptyTitle": "今天没有待复习的错题 🎉",
    "review.emptyHint": "新录入的错题会在次日进入复习计划。",
    "review.markDone": "标记为已复习",
    "review.opFailed": "操作失败：{msg}",

    "export.desc": "勾选要导出的错题，选择版本后下载 .tex 或 .pdf 文件。",
    "export.latexBtn": "导出 LaTeX",
    "export.pdfBtn": "导出 PDF",
    "export.versionLabel": "导出版本：",
    "export.withAnswers": "含答案",
    "export.noAnswers": "不含答案",
    "export.answersLast": "答案在最后",
    "export.emptyHint": "还没有错题可导出。",
    "export.selectFirst": "请先勾选要导出的错题。",
    "export.failed": "导出失败：{msg}",
    "export.pdfFailed": "导出 PDF 失败：{msg}",
    "export.pdfUnsupported": "当前环境不支持 PDF 导出（需通过 Electron 运行）",
    "export.notLoaded": "所选错题数据未加载，请刷新后重试。",
    "export.pdfSaved": "PDF 已导出：{path}",

    "detail.tabQuestion": "题目",
    "detail.tabAnswer": "答案",
    "detail.noAnswer": "这道题还没有答案",
    "detail.inputAnswer": "手动输入答案",
    "detail.aiAnswer": "用 AI 生成答案",
    "detail.answerPh": "输入答案内容（支持 \\( \\) 和 \\[ \\] 公式）",
    "detail.saveAnswer": "保存答案",
    "detail.cancel": "取消",
    "detail.editAnswer": "编辑答案",
    "detail.aiGenerating": "AI 生成中，请稍候…",
    "detail.aiGenerated": "已生成 ✓",
    "detail.aiGenFailed": "生成失败：{msg}",
    "detail.tags": "标签：",
    "detail.tagPh": "添加标签…",
    "detail.addTag": "添加",
    "detail.tagExists": "该标签已存在",
    "detail.tagAdded": "已添加 ✓",
    "detail.tagFailed": "添加失败：{msg}",
    "detail.tagDelFailed": "删除标签失败：{msg}",
    "detail.deleteTag": "删除标签",
    "detail.createdAt": "创建于：",
    "detail.nextReviewLabel": "下次复习：",
    "detail.stageLabel": "复习阶段：",
    "detail.loadFailed": "加载题目失败：{msg}",

    "pdf.title": "错题本 · 复习卷",
    "pdf.meta": "共 {n} 题 · 导出日期 {date}",
    "pdf.problemNo": "第 {n} 题（{subject}）",
    "pdf.answerLabel": "【答案】",
    "pdf.refAnswers": "参考答案",
    "pdf.problemN": "第 {n} 题",
    "pdf.noAnswer": "（无答案）",
    "pdf.noContent": "（无内容）",

    "subject.math": "数学",
    "subject.physics": "物理",
    "subject.chemistry": "化学",
    "type.variant": "变式",
    "type.extend": "拓展",
  },

  en: {
    "app.title": "Mistake Notebook",
    "nav.notebook": "Notebook",
    "nav.editor": "Add / Edit",
    "nav.similar": "Similar Problems",
    "nav.review": "Review Plan",
    "nav.export": "Export",
    "nav.settings": "Settings",
    "backend.checking": "Backend: checking…",
    "backend.running": "Backend: running ●",
    "backend.abnormal": "Backend: error",
    "backend.offline": "Backend: offline ○",
    "header.refresh": "Refresh",

    "notebook.searchPh": "Search by tag, e.g. functions, calculus…",
    "common.loading": "Loading…",
    "common.loadFailed": "Failed to load: {msg}",
    "notebook.emptyTitle": "No problems yet",
    "notebook.emptyHint": "Go to “Add / Edit” and upload an image / PDF / DOCX for AI recognition.",
    "notebook.noMatchTitle": "No matching problems",
    "notebook.noMatchHint": "No problem is tagged “{q}”.",
    "notebook.offlineTitle": "Cannot reach the backend",
    "notebook.offlineHint": "{msg} (make sure the backend is running at {url})",

    "card.uncategorized": "Uncategorized",
    "card.fromParent": "from #{n}",
    "card.genVariant": "Variant",
    "card.genExtend": "Harder",
    "card.generating": "Generating…",
    "card.delete": "Delete",
    "card.noText": "(no content)",
    "card.nextReview": "Next review: {date}",
    "card.stage": "Stage {n}/5",
    "card.deleteConfirm": "Delete this problem? This cannot be undone.",
    "card.deleteFailed": "Delete failed: {msg}",
    "card.genDone": "Generated {type} problem #{n}. Find it in Notebook or Similar Problems.",
    "card.genFailed": "Generation failed: {msg}",

    "editor.dropText": "Drag a file here, or ",
    "editor.dropClick": "click to choose",
    "editor.dropFormats": "Supports PNG / JPG / PDF / DOCX",
    "editor.previewAlt": "Preview",
    "editor.recognize": "Recognize",
    "editor.recognizing": "Recognizing, please wait…",
    "editor.recognized": "Done ✓",
    "editor.resultLabel": "Recognition result",
    "editor.correctLabel": "Manual correction (plain language)",
    "editor.correctPh": "e.g. change the coefficient 2 in line 2 to 3",
    "editor.correctBtn": "Apply correction",
    "editor.correcting": "AI is correcting…",
    "editor.corrected": "Corrected ✓",
    "editor.latexLabel": "LaTeX source (editable)",
    "editor.updateBtn": "Update & re-render",
    "editor.saving": "Saving…",
    "editor.updated": "Updated ✓",
    "editor.empty": "(empty)",

    "settings.aiDesc": "Configure any OpenAI-compatible AI endpoint (Qwen-VL, Claude, DeepSeek…). Image recognition requires a multimodal model.",
    "settings.apiKey": "API Key",
    "settings.baseUrl": "Base URL",
    "settings.modelName": "Model Name",
    "settings.modelPh": "e.g. qwen-vl-max / gpt-4o",
    "settings.effort": "Reasoning effort",
    "settings.effortHint": "Higher effort is more accurate but slower. Supported levels vary by model; unsupported values are ignored automatically.",
    "settings.effortAuto": "Auto (leave to the model)",
    "settings.effortMinimal": "Minimal",
    "settings.effortLow": "Low",
    "settings.effortMedium": "Medium",
    "settings.effortHigh": "High (recommended)",
    "settings.language": "Interface language",
    "settings.save": "Save settings",
    "settings.saved": "Saved ✓",
    "settings.saveFailed": "Save failed: {msg}",
    "settings.loadFailed": "Failed to read settings: {msg}",

    "similar.desc": "Click “Variant” or “Harder” on any card in the Notebook — the AI writes a new problem with a full solution based on it. All generated problems are listed below (marked “from”).",
    "similar.emptyTitle": "No generated problems yet",
    "similar.emptyHint": "Open the Notebook and click “Variant” or “Harder” on a problem.",

    "review.desc": "Scheduled by the Ebbinghaus curve (1 / 2 / 4 / 7 / 15 days). Problems due today (including overdue) are listed below — click “Mark reviewed” to advance to the next stage.",
    "review.emptyTitle": "Nothing due for review today 🎉",
    "review.emptyHint": "Newly added problems enter the review plan the next day.",
    "review.markDone": "Mark reviewed",
    "review.opFailed": "Operation failed: {msg}",

    "export.desc": "Select the problems to export, choose a version, then download a .tex or .pdf file.",
    "export.latexBtn": "Export LaTeX",
    "export.pdfBtn": "Export PDF",
    "export.versionLabel": "Version:",
    "export.withAnswers": "With answers",
    "export.noAnswers": "Without answers",
    "export.answersLast": "Answers at the end",
    "export.emptyHint": "No problems to export yet.",
    "export.selectFirst": "Please select at least one problem.",
    "export.failed": "Export failed: {msg}",
    "export.pdfFailed": "PDF export failed: {msg}",
    "export.pdfUnsupported": "PDF export is unavailable in this environment (requires Electron).",
    "export.notLoaded": "Selected problems are not loaded. Please refresh and retry.",
    "export.pdfSaved": "PDF exported: {path}",

    "detail.tabQuestion": "Problem",
    "detail.tabAnswer": "Answer",
    "detail.noAnswer": "This problem has no answer yet",
    "detail.inputAnswer": "Type answer manually",
    "detail.aiAnswer": "Generate with AI",
    "detail.answerPh": "Type the answer (supports \\( \\) and \\[ \\] formulas)",
    "detail.saveAnswer": "Save answer",
    "detail.cancel": "Cancel",
    "detail.editAnswer": "Edit answer",
    "detail.aiGenerating": "AI is generating, please wait…",
    "detail.aiGenerated": "Generated ✓",
    "detail.aiGenFailed": "Generation failed: {msg}",
    "detail.tags": "Tags:",
    "detail.tagPh": "Add a tag…",
    "detail.addTag": "Add",
    "detail.tagExists": "Tag already exists",
    "detail.tagAdded": "Added ✓",
    "detail.tagFailed": "Failed to add: {msg}",
    "detail.tagDelFailed": "Failed to remove tag: {msg}",
    "detail.deleteTag": "Remove tag",
    "detail.createdAt": "Created: ",
    "detail.nextReviewLabel": "Next review: ",
    "detail.stageLabel": "Review stage: ",
    "detail.loadFailed": "Failed to load problem: {msg}",

    "pdf.title": "Mistake Notebook · Review Paper",
    "pdf.meta": "{n} problems · exported {date}",
    "pdf.problemNo": "Problem {n} ({subject})",
    "pdf.answerLabel": "[Answer]",
    "pdf.refAnswers": "Answer Key",
    "pdf.problemN": "Problem {n}",
    "pdf.noAnswer": "(no answer)",
    "pdf.noContent": "(no content)",

    "subject.math": "Mathematics",
    "subject.physics": "Physics",
    "subject.chemistry": "Chemistry",
    "type.variant": "variant",
    "type.extend": "harder",
  },
};

// 学科在数据库里始终以中文存储（AI 返回值 + 导出/接口协议一致），
// 仅在界面展示时按当前语言翻译。
const SUBJECT_KEYS = {
  数学: "subject.math",
  物理: "subject.physics",
  化学: "subject.chemistry",
};

const LANG_STORAGE_KEY = "ui_language";

let currentLang =
  (typeof localStorage !== "undefined" && localStorage.getItem(LANG_STORAGE_KEY)) ||
  "zh";
if (!I18N[currentLang]) currentLang = "zh";

function getLanguage() {
  return currentLang;
}

// 取译文并做 {var} 占位替换；缺 key 时回退中文，再回退 key 本身（便于发现漏翻）。
function t(key, vars) {
  const dict = I18N[currentLang] || I18N.zh;
  let text = dict[key];
  if (text === undefined) text = I18N.zh[key];
  if (text === undefined) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

// 学科名按当前语言展示（数据仍是中文）。
function subjectLabel(subject) {
  if (!subject) return t("card.uncategorized");
  const key = SUBJECT_KEYS[subject];
  return key ? t(key) : subject;
}

// 刷新所有带 data-i18n / data-i18n-ph 标记的静态文本。
function applyStaticTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.title = t("app.title");
  document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
}

// 切换语言：存 localStorage 并刷新静态文本（动态内容由调用方重新渲染）。
function setLanguage(lang) {
  currentLang = I18N[lang] ? lang : "zh";
  try {
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch {
    /* 隐私模式下 localStorage 不可用时忽略，仅本次会话生效 */
  }
  applyStaticTranslations();
}
