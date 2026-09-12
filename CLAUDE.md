# CLAUDE.md

给新会话的速查手册。功能说明见 `README.md`，打包步骤见 `BUILD.md`；
这里记**架构概览**和**不看代码就会踩的坑**。

---

## 项目结构速览

```
wrong-question-notebook/
├── main.js              Electron 主进程：拉起后端子进程、contextBridge、printToPDF
├── preload.js           contextBridge 暴露 window.pdfApi.exportPdf
├── src/
│   ├── index.html       全部界面（单页，静态文本带 data-i18n）
│   ├── render.js        全部前端逻辑（约 1700 行，单文件，CommonJS-free 普通脚本）
│   ├── i18n.js          中英词典（~165 键）+ t() / setLanguage() / subjectLabel()
│   └── vendor/katex/    本地 KaTeX（离线可用）；Tailwind 走 CDN
├── backend/
│   ├── main.py          FastAPI 全部路由 + 提示词（FORMAT_CONTRACT / JSON_SPEC 等）
│   ├── models.py        Pydantic 模型（ProblemOut / ExportRequest 等）
│   ├── database.py      SQLite 连接、建表、迁移（ALTER TABLE 幂等式）
│   ├── config.py        config.json 读写（api_key / base_url / model_name 等）
│   └── services/
│       ├── ai_client.py OpenAI 兼容调用（纯文本 + multimodal vision）
│       ├── effort.py    推理档位探测与降级（none→max 七档）
│       ├── exporter.py  LaTeX/PDF 导出（build_tex / build_tex_with_images）
│       ├── scheduler.py 艾宾浩斯复习计划（1/2/4/7/15 天）
│       └── textfix.py   AI 文本收敛（JSON 修复、定界符统一，纯函数）
└── scripts/
    └── afterPack.js     electron-builder 钩子：macOS ad-hoc 签名
```

---

## 数据库 Schema（`notebook.db`）

```sql
problems (
  id              INTEGER PRIMARY KEY,
  image_path      TEXT,          -- 上传图片的本地绝对路径（uploads/ 下）
  raw_text        TEXT,          -- AI 识别的纯文本
  latex_code      TEXT,          -- AI 产出的 LaTeX（题目+答案混在一起的旧格式 OR 题目部分）
  subject         TEXT,          -- 数学/物理/化学（永远中文枚举）
  tags            TEXT,          -- JSON 数组字符串，如 ["二次函数","导数"]
  created_at      TEXT,
  next_review_date TEXT,
  review_stage    INTEGER DEFAULT 0,
  raw_image_hash  TEXT,          -- SHA-256，去重用
  is_generated    INTEGER DEFAULT 0,   -- 举一反三生成的题
  parent_id       INTEGER,             -- 来源题 id
  last_review_date TEXT,
  answer_latex    TEXT,          -- 独立的答案字段（与 latex_code 分离）
  question_type   TEXT DEFAULT 'SAQ',  -- MC / TF / SAQ / LAQ
  has_diagram     INTEGER DEFAULT 0,   -- AI 检测到图示为 1
  diagram_path    TEXT           -- 图示图片路径（通常等于 image_path）
)
```

**`seq` 不在库里**，是查询时 `ROW_NUMBER() OVER (ORDER BY id)` 算出的连续序号，
删题不留空号。前端显示用 `seq`，接口调用用真实主键 `id`，混用会操作错题。

数据目录：`%APPDATA%\wrong-question-notebook\`（由 `main.js` 通过 `app.setPath`
传入 `USER_DATA` 环境变量；后端 `database.get_data_dir()` 读该变量，
未设置时退回 `backend/data/`）。

---

## API 路由一览（`backend/main.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/problems` | 列出全部错题（含 seq） |
| GET | `/api/problems/{id}` | 单题详情 |
| POST | `/api/problems` | 手动新增 |
| PATCH | `/api/problems/{id}` | 更新字段（subject/tags/latex_code/answer_latex） |
| DELETE | `/api/problems/{id}` | 删除 |
| POST | `/api/upload` | 上传图片/PDF/DOCX → AI 识别 → 存库，返回 ProblemOut |
| POST | `/api/correct-latex` | 自然语言修正题目 LaTeX |
| POST | `/api/generate-answer` | AI 生成/重生成/修正答案 |
| POST | `/api/generate-similar` | 举一反三（变式/拓展） |
| GET | `/api/review/due` | 今日待复习列表 |
| POST | `/api/review/{id}/complete` | 标记复习完成（推进阶段） |
| GET | `/api/config` | 读配置（注意：api_key 明文，别打印到终端） |
| POST | `/api/config` | 写配置 |
| GET | `/api/effort/levels` | 当前模型支持的推理档位列表 |
| POST | `/api/effort/probe` | 逐档探测，写入缓存 |
| POST | `/api/export` | 导出 .tex/.zip（见下；PDF 不走后端） |

### `/api/export` 入参（`ExportRequest`）

```python
problem_ids: List[int]           # 要导出的题目 id，按此顺序排列
include_answers: bool = True
answers_last: bool = False       # True = 答案集中放末页
language: str = "zh"             # 卷头语言
image_problem_ids: List[int] = []  # 要嵌入原图的题目 id（前端每题有「含图」checkbox）
```

- `image_problem_ids` 为空 → 不嵌入任何图，返回 `.tex`
- `image_problem_ids` 非空 → 返回 `.zip`（`mistakes.tex` + `images/problem_{序号}.{ext}`）
- 图片文件不存在或后缀不是图片格式时静默跳过，不会 500
- 三种版本（含答案 / 不含答案 / 答案末页）每题之后都有 `\vspace{0.8cm}` 间距；
  不含答案版本额外按题型留作答空白（`exporter.answer_space_cm`）

**后端不编译 PDF**（用户没有 XeLaTeX）。PDF 一律由前端 `exportPDF()` 生成：
`buildPdfHtml` 拼 HTML → `window.pdfApi.exportPdf` → `main.js` 隐藏窗口 `loadFile`
→ `printToPDF`。原图通过 `file://` URL 嵌入（`toFileUrl()`），所以打印页必须是
`file://` 页面而不是 data URL。

**作答空白规则前后端各有一份**（`exporter.answer_space_cm` ↔ `render.js`
`answerSpaceCm`），改一处要同步另一处：MC/TF 无；SAQ 3cm + min(行数×0.5, 3)；
LAQ/未知 6cm + min(行数×0.8, 6)，行数 = 字数/80。

回归测试：`backend/venv/Scripts/python.exe tests/test_export_backend.py`
（起临时 `USER_DATA` 的 uvicorn，端口 8765，不碰真实库）。

---

## 前端架构（`src/render.js`）

单文件，无构建工具，普通 `<script src="render.js">`（非 module，避免 Electron 的 ES
module 限制）。

**关键全局状态：**
- `problemsCache`：`Map<id, ProblemOut>`，所有已加载题目的本地缓存
- `detailProblem`：当前详情弹窗显示的题目
- `currentView`：当前视图名（notebook / similar / review / export）

**并发上传：**`RequestQueue`（内联在文件顶部，类实现；**不要**再建独立的
`requestQueue.js`，非 module 脚本 import 不了它）控制最大并发 3、间隔 200ms，
批量上传多张图片时以标签页方式展示各题结果。

**结果标签页（`showBatchResults`）：**
- 按 `data.id` 去重——同一文件传两次，后端按哈希去重返回同一条记录，否则出现两个
  `tab-<id>`。
- 关闭按钮是 `<span class="tab-close">`，靠 `#result-tabs` 上的事件委托处理；
  别改回 `<button>` 套 `<button>`，那是非法 HTML，浏览器会拆开。
- 面板来自 `<template>`，**`applyStaticTranslations()` 扫不到 template 内容**，
  克隆后要手动翻译 `[data-i18n]` / `[data-i18n-ph]`。
- 文件 `<input>` 的 `change` 处理完要 `e.target.value = ""`，否则重选同一批文件不触发。

**图片显示：**只要 `problem.diagram_path || problem.image_path` 存在就在卡片和
详情弹窗显示（统一走 `problemImagePath()`），不依赖 `has_diagram` 标志
（`has_diagram` 只影响 AI 生成答案时是否附图）。

**导出列表：**每道有图的题目显示「含图」checkbox（`export-img-cb`），勾选状态决定
`image_problem_ids`（LaTeX）和 PDF 中嵌图的题目集合。**动态生成的 HTML 不要带
`data-i18n`**，直接写 `t()` 结果，否则切语言时会被 `applyStaticTranslations()` 覆盖。

---

## AI 调用约定（必须遵守）

所有 AI 调用点（识图/文本整理/修正题目/生成答案/举一反三）共用：

```
FORMAT_CONTRACT  （格式规则：定界符、大括号配对、JSON 转义）
+ 字段说明：
  JSON_SPEC      录入类（识图/文本整理）→ subject/question_type/has_diagram/latex_code/raw_text/tags/answer_latex
  ANSWER_SPEC    生成答案               → answer_latex
  QUESTION_SPEC  修正题目               → latex_code
```

**所有调用都要求返回 JSON，所有返回都用 `textfix.parse_ai_json` 解析。**
不要拆成「有的要 JSON、有的要纯文本」——拆过一次，答案被原样存成 `{"latex_code":"..."}` 进库。

`has_diagram=true` 的题目在 `/api/generate-answer` 时会附带原图（base64）给 AI，
让视觉模型看到图形细节再解题。

---

## 上手

git 根目录是 `E:\MistakeNotebook\wrong-question-notebook`（**不是**上层的
`E:\MistakeNotebook`）。`npm start` 必须在这个子目录里跑。

```
main.js → spawn backend/venv/Scripts/python.exe backend/main.py
       → loadFile src/index.html
       → USER_DATA = app.getPath('userData')
         = C:\Users\<user>\AppData\Roaming\wrong-question-notebook\
```

---

## 动手前先做这件事

**端口 8000 上的残留后端会让你静默测错东西。** 开测前先清：

```bash
netstat -ano | grep '127.0.0.1:8000' | grep LISTENING | awk '{print $NF}' \
  | sort -u | while read PID; do taskkill //F //PID $PID; done
```

清完还不够——**要做归属证明**：起完后端往 `/api/problems` 写一条记录，
确认它落在你的临时 `USER_DATA` 库里再开测。只 curl `/health` 证明不了端口是谁的。

---

## 数据与隐私

- `config.json` 里 **api_key 是明文**。不要 `curl /api/config` 后把响应打到终端。
- 用户数据在 `%APPDATA%\wrong-question-notebook\`，目录名由 `main.js:24`
  的 `app.setPath` 钉死，改 `productName` 不会让老用户丢数据。

---

## 容易搞错的约定

- **`seq` 显示，`id` 接口**。混用会删错题。
- **学科在库里永远是中文枚举**（数学/物理/化学）。`_normalize_subject()` 把模型返
  回的 `Mathematics` 转回中文；界面靠 `subjectLabel()` 翻译显示。
- **`data-type="变式"/"拓展"` 是协议值，不要 i18n 化**。
- **`sqlite3.Row` 没有 `.get()` 方法**，用 `row["field"] if "field" in row.keys() else default`。
- **`reasoning_effort` 被上游拒绝时 `ai_client` 自动重试一次**（去掉参数），
  看到这段重试逻辑别当 bug 删掉，它是兼容非推理模型的关键。

---

## LaTeX 装在 JSON 里的两类坑（都修过，别退回去）

**坑 A：解析失败。** `\(` 不是合法 JSON 转义 → `json.loads` 报错。
→ `textfix.repair_json_escapes()` 先补转义再解析。

**坑 B：静默内容损坏（更阴）。** `\f` `\b` `\v` **是**合法 JSON 转义，
`"\frac{1}{2}"` 解析不报错，但变成换页符 + `rac{1}{2}`。
→ `textfix.undo_control_damage()` 在 `json.loads` 之后还原。
受害命令：`\frac`→换页、`\beta`→退格、`\nabla`→换行、`\theta`→制表、`\rho`→回车。

---

## 推理档位不是写死的枚举

`services/effort.py` 是唯一真相来源：阶梯 `none/minimal/low/medium/high/xhigh/max`。
优先级：`probe（真机探测）> learned（调用中被拒）> catalog（名称匹配表）> default`。

**别把 catalog 当真理**，它就是错的——用户的 base_url 多半是中转网关，能用哪些档
由网关决定。`/api/effort/probe` 的结果覆盖一切。

- 缓存在 `{userData}/effort_cache.json`，键是 `base_url::model`。
- 超时必须随档位放宽（见 `_EFFORT_TIMEOUTS`）；max 档给 900 秒。

---

## 两个反复咬人的技术坑

**1. `buildPdfHtml` 模板字符串反斜杠要写四层。**
KaTeX 定界符必须写成 `\\\\[`：模板输出 `\\[`，页面 JS 解析后才是 `\[`。

**2. 打印页必须 `loadFile` 临时 HTML，不能用 data URL。**
它要引用本地 `vendor/katex`，data URL 页面加载不了 file:// 子资源。

**3. `styles.css` 覆盖 Tailwind 必须写「元素名 + 类名」。**
Tailwind Play CDN 把 `<style>` 插到 `<head>` 末尾，排在 `styles.css` 之后，
同为单类选择器时 Tailwind 的 `.px-3` 会赢。

**4. 选择框的 ⌄ 是自绘的，`appearance: none` + 背景 SVG，
原生 `::-webkit-calendar-picker-indicator` 已 `display:none`。**
改 `padding-right` 时同步 `render.js` 里的 34px 点击阈值。

---

## `\[\[` 会让整段公式渲染失败

`sanitize_latex()` 给 `\begin{aligned}` 补 `\[` 时若原文已有 `\[` 就叠成 `\[\[`，
KaTeX 直接报错。最后有一步「合并重复行间定界符」，循环到稳定。
**别顺手把 `\\` 也合并了**，那是矩阵/换行用的。

---

## macOS「已损坏」≠ Gatekeeper 拦截

| 提示 | 原因 | 隐私设置能否放行 |
|------|------|------------------|
| 来自身份不明的开发者 | 有签名但非 Apple 认证 | 能 |
| **已损坏，无法打开** | **完全没有签名** | **不能** |

Apple Silicon 上内核直接拒绝无签名 arm64 二进制。
→ `scripts/afterPack.js` 实现 ad-hoc 签名（`codesign --sign -`）。
**签名顺序必须从内到外**：先签 PyInstaller 产物，最后签 `.app` 外壳。

---

## PyInstaller + conda

`sqlite3.dll` 必须走 `datas` 不走 `binaries`（放 binaries 会被 hook 去重掉）。
见 `backend.spec` 注释。验证：

```bash
python -m PyInstaller.utils.cliutils.archive_viewer -l dist/mistake-backend.exe | grep sqlite
```

---

## 验证套路

- **后端**：起临时 `USER_DATA` 的子进程 + urllib 打断言，跑完 terminate。
- **界面**：无头 Electron `loadFile` 真实 index.html，`executeJavaScript` 取 DOM 断言。
- **i18n 遗漏**：扫 `render.js` 字符串里的 CJK（排除注释），应剩 8 处协议值/DB 键。
- **动态下拉框**不吃 `applyStaticTranslations()`，切语言时必须在 `changeLanguage()` 里重建。
- **状态提示别塞进会被隐藏的容器**（曾因此让「AI 生成中…」看不见）。
- **测 CSS 要测行为，别测属性名**：`line-clamp` 的 computed `display` 是 `flow-root`。

**别信"成功"字样，信独立通道。**

---

## 环境

- Python：`backend/venv/Scripts/python.exe`（conda 基座，3.13）
- 真实用户数据库：`C:\Users\liuya\AppData\Roaming\wrong-question-notebook\notebook.db`
  （调试时别查 `backend/data/notebook.db`，那是空库）
- gh CLI：`"C:\Program Files\GitHub CLI\gh.exe"`（PATH 里可能没有，用全路径）
- 临时文件放 `$CLAUDE_JOB_DIR/tmp`，别用 `/tmp`
- **没有菜单栏**：`Ctrl+R` 和 `F12` 已随 `Menu.setApplicationMenu(null)` 禁用
- macOS dmg 用 GitHub Actions 构建（`.github/workflows/build-mac.yml`，手动触发）
