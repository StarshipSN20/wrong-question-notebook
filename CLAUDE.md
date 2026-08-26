# CLAUDE.md

给新会话的速查手册。功能说明见 `README.md`，打包步骤见 `BUILD.md`；
这里只记**不看代码就会踩的坑**。

## 上手

git 根目录是 `E:\MistakeNotebook\wrong-question-notebook`（**不是**上层的
`E:\MistakeNotebook`）。`npm start` 必须在这个子目录里跑，否则报 ENOENT。

```
main.js          Electron 主进程：拉起后端、系统通知、PDF 打印（printToPDF）
preload.js       contextBridge 暴露 window.pdfApi.exportPdf
src/index.html   全部界面，静态文本带 data-i18n 标记
src/render.js    全部前端逻辑（约 1200 行，单文件）
src/i18n.js      中英词典（128 键）+ t() / setLanguage() / subjectLabel()
src/vendor/katex 本地 KaTeX（离线可用）；Tailwind 仍走 CDN
backend/main.py  FastAPI 全部路由 + 提示词
backend/services scheduler(艾宾浩斯) / exporter(.tex) / ai_client(OpenAI 兼容)
```

## 动手前先做这件事

**端口 8000 上的残留后端会让你的测试静默测错东西。** 上个会话吃过一次：
临时 `USER_DATA` 起的后端没绑上端口，请求全打到旧实例，结果测试用例被写进了
用户真实数据库。开测前先清：

```bash
netstat -ano | grep '127.0.0.1:8000' | grep LISTENING | awk '{print $NF}' \
  | sort -u | while read PID; do taskkill //F //PID $PID; done
```

## 数据与隐私

- 用户数据在 `%APPDATA%\wrong-question-notebook\`（db / uploads / config.json）。
  这个目录名由 `main.js:24` 的 `app.setPath` **钉死**，不随 `productName` 变，
  所以改应用名不会让老用户丢数据——别把它改回默认行为。
- `config.json` 里 **api_key 是明文**。不要 `curl /api/config` 后把响应打到终端
  （干过一次，泄进了会话记录）。要看就只取需要的字段。
- 用户明确说"删测试数据"时，**包括 api_key**。别替他保留。

## 容易搞错的约定

- **`seq` 用于显示，`id` 用于接口**。`seq` 是 SQL 子查询算的连续序号（删题不留
  空号），`data-id` / URL 里必须是真实主键 `id`。混用会删错题。
- **学科在库里永远是中文枚举**（数学/物理/化学）。`_normalize_subject()` 会把模型
  返回的 `Mathematics` 转回中文；界面靠 `subjectLabel()` 翻译显示。别把英文写进库，
  否则色块失效、自动标签中英分裂、按标签搜索被割裂。
- **`data-type="变式"/"拓展"` 是发给后端的协议值**，不要 i18n 化；按钮上的文字才翻译。
- 提示词集中在 `backend/main.py` 的 `FORMAT_RULES` / `JSON_SPEC`（5 处引用、
  6 个 AI 调用点共用）。改一处等于改全部链路。
- `reasoning_effort` 被上游拒绝时，`ai_client` 会**去掉该参数自动重试一次**——
  看到这段重试逻辑别当成 bug 删掉，它是兼容非推理模型的关键。

## 两个反复咬人的技术坑

**1. `buildPdfHtml` 是模板字符串，反斜杠要写四层。**
打印页的 KaTeX 定界符必须写成 `\\\\[`：模板输出后是 `\\[`，页面 JS 解析后才是 `\[`。
写两层会退化成普通括号 `(`，auto-render 把 `(x^2)` 当公式，整页公式渲染失败。
这个 bug 修了三次才找对——因为测试文件里写的是四层，测试通过而实际代码是坏的。

**2. 打印页必须 `loadFile` 临时 HTML，不能用 data URL。** 它要引用本地
`vendor/katex`，data URL 页面加载不了 file:// 子资源。

**3. PyInstaller + conda：`sqlite3.dll` 走 `datas` 不走 `binaries`。**
放 binaries 会被 PyInstaller 的 hook 去重掉，包里其实没有。`backend.spec` 里有注释。
验证方式是列包内容，别信 spec 自己的打印：

```bash
python -m PyInstaller.utils.cliutils.archive_viewer -l dist/mistake-backend.exe | grep sqlite
```

## 验证套路（都验证过好用）

- **后端**：起临时 `USER_DATA` 的子进程 + urllib 打断言，跑完 terminate。
- **界面**：无头 Electron `loadFile` 真实 index.html，`executeJavaScript` 取 DOM 断言。
  语言切换就是这么验的（切 en 后断言可见文本零 CJK；语言下拉框的 `中文` 选项要排除，
  它按惯例保持本族文字）。
- **i18n 遗漏扫描**：扫 `render.js` 字符串字面量里的 CJK（排除注释）。应剩 8 处，
  全是协议值与 DB 键（`SUBJECT_COLORS` 三行、两处 `data-type`、
  `dataset.type` 比较两行、一句 `console.warn`）。多出来的就是漏翻。
- **测 CSS 要测行为，别测属性名**。Tailwind 内置 line-clamp 的 computed
  `display` 是 `flow-root` 不是 `-webkit-box`，按属性断言会误报失败；量
  `clientHeight`（3 行 20px 行高 → 60px）才是对的。Play CDN 靠
  MutationObserver 编译，动态插入的元素要等 ~1s 再量。

**别信"成功"字样，信独立通道。** 上个会话 spec 打印"已附带 sqlite3.dll"而包里没有，
是 `archive_viewer` 抓到的；三项"已完成"的改动其实从未落盘，是重新打包产物名还是中文
才暴露的。声明与验证是两件事，报告时把两者分开说。

## 环境

- Python：`backend/venv/Scripts/python.exe`（conda 基座，3.13）
- gh CLI：`"C:\Program Files\GitHub CLI\gh.exe"`（PATH 里可能没有，用全路径）
- Git 身份是**仓库局部**配置，不要动全局
- 临时文件放 `$CLAUDE_JOB_DIR/tmp`，别用 `/tmp`
- **没有菜单栏**：`Ctrl+R` 刷新和 `F12` 开发者工具已随 `Menu.setApplicationMenu(null)`
  一起禁用，所以不能让用户"打开控制台看报错"。要排查得先临时加回加速器。
- macOS 的 dmg 用 GitHub Actions 构建（`.github/workflows/build-mac.yml`，
  手动触发）。electron-builder 在 CI 会隐式发布，`package.json` 里已加
  `--publish never`，去掉会让构建成功后仍以退出码 1 失败。
