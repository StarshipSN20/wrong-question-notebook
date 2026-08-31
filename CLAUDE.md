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
src/render.js    全部前端逻辑（约 1550 行，单文件）
src/i18n.js      中英词典（158 键）+ t() / setLanguage() / subjectLabel()
src/vendor/katex 本地 KaTeX（离线可用）；Tailwind 仍走 CDN
backend/main.py  FastAPI 全部路由 + 提示词
backend/services scheduler(艾宾浩斯) / exporter(.tex) / ai_client(OpenAI 兼容)
                 effort(推理档位探测与降级) / textfix(AI 文本收敛，纯函数)
```

## 动手前先做这件事

**端口 8000 上的残留后端会让你的测试静默测错东西。** 上个会话吃过一次：
临时 `USER_DATA` 起的后端没绑上端口，请求全打到旧实例，结果测试用例被写进了
用户真实数据库。开测前先清：

```bash
netstat -ano | grep '127.0.0.1:8000' | grep LISTENING | awk '{print $NF}' \
  | sort -u | while read PID; do taskkill //F //PID $PID; done
```

清完还不够，**要做归属证明**：起完后端往 `/api/problems` 写一条记录，
确认它落在你的临时 `USER_DATA` 库里再开测。只 curl `/health` 证明不了端口是谁的。

另外：**bash 里用 `&` 起的后端在本环境活不到测试结束**（试过两次，日志空、
端口没人听、写入不知去向）。用 Python `subprocess.Popen` 管生命周期才稳，
界面测试也照这个路子起 Electron（见验证套路）。

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
- **所有 AI 调用点共用一份格式契约**：`FORMAT_CONTRACT`（格式规则）+ 一个字段说明
  （`JSON_SPEC` 录入类 / `ANSWER_SPEC` 生成答案 / `QUESTION_SPEC` 修正题目），
  全部要求返回 JSON，全部用 `textfix.parse_ai_json` 解析。
  **不要再拆成「有的要 JSON、有的要纯文本」**——拆过一次，代价见下面两节。
  前端只有一套渲染（KaTeX 扫 `\( \)` `\[ \]`），所以格式必须只有一套。
- `reasoning_effort` 被上游拒绝时，`ai_client` 会**去掉该参数自动重试一次**——
  看到这段重试逻辑别当成 bug 删掉，它是兼容非推理模型的关键。
  现在还会顺手 `effort.record_rejection()` 记下来，下次直接降档不再白跑。

## 推理档位不是写死的枚举

`services/effort.py` 是唯一的档位真相来源：阶梯 `none/minimal/low/medium/high/xhigh/max`
（`auto` = 不发送该参数，不在阶梯里）。可用档位按三层优先级取：

```
probe（真机逐档试探，最准）> learned（调用中被拒学到的）> catalog（模型名匹配表）> default（全给出）
```

**别把 catalog 当真理。** 它就是错的：本机实测 `gpt-5.6-luna`（经 api.apikey.fun 网关）
七档全收，而 catalog 的 `^gpt-5` 规则只写到 high。用户的 base_url 多半是中转网关，
能用哪些档由网关决定、跟模型名对不上；各家文档本身也不准（Gemini 3 Preview 拒 medium、
Gemini 3 Flash 不认文档里写着的 minimal）。所以 `/api/effort/probe` 的结果覆盖一切。

- 缓存在 `{userData}/effort_cache.json`，键是 `base_url::model`——换网关不串号。
- `describe()` 返回的 `source=default` 表示**毫无信息**，此时 `_resolve_effort()`
  必须传 `supported=None` 原样发送。传空列表会被当成「已知完全不支持」而静默不发参数。
- 探测**必须先发一次不带该参数的基线请求**。基线失败（key/模型名错）就直接报错，
  否则「全都失败」会被误判成「一档都不支持」。
- 一次全 inconclusive 的探测不覆盖已有缓存，免得一次网络抖动清空之前的结果。
- 下拉框里不支持的档位**只标注不隐藏**（探测可能偏保守，用户仍应能手选）；
  真发请求时 `resolve()` 会降到最近的可用档位（选 max 而模型只到 high → 发 high）。
- **超时必须随档位放宽**，见 `_EFFORT_TIMEOUTS`。原来固定 120 秒，加了 xhigh/max
  之后必然超时：实测 gpt-5.6-luna 在 max 档解一道 1561 字的多问题目，三次调用
  全部卡满 120 秒返回 502。现在 max 给 900 秒，且超时有独立报错文案
  （否则会被「无法连接 AI 接口」吞掉，让人以为是网络问题）。

## LaTeX 装在 JSON 里的两类坑（都修过，别退回去）

模型返回的 JSON 里塞满 LaTeX 反斜杠，于是有两种坏法，**症状完全不同**：

**坑 A：解析直接失败。** `\(` 不是合法 JSON 转义，模型写
`"latex_code": "\(x\)"` 时 `json.loads` 报 `Invalid \escape`。真实事故：一条
2623 字的答案在 char 878 处炸掉，解析失败后**整坨 JSON 被当正文存进库**，
界面上显示 `{"latex_code":...}`。
→ `textfix.repair_json_escapes()` 先把落单的反斜杠补成 `\\` 再解析。
注意它必须先整对吃掉已经正确的 `\\`，否则会翻倍成四个。

**坑 B：解析成功但内容静默错掉（更阴）。** `\f` `\b` `\v` **是**合法 JSON 转义，
所以 `"\frac{1}{2}"` 解析不报错，只是变成换页符 + `rac{1}{2}`——公式错了但没人报警。
受害的都是高频命令：`\frac`→换页、`\beta`→退格、`\nabla`→换行、`\theta`→制表、`\rho`→回车。
→ `textfix.undo_control_damage()` 在 `json.loads` **之后**还原：
- 换页/退格/垂直制表符在正文里永远不合理出现，**无条件**还原；
- `\n` `\t` `\r` 是正文里的真换行/制表，**只在后面紧跟已知命令尾巴时**才还原
  （`\n`+`abla`→`\nabla`）。宁可漏修也不能把 `"step1\nstep2"` 的真换行改坏——
  有测试专门盯这条。

正常解析路径与截断兜底路径**都要**调 `undo_control_damage`，漏一条就有洞。

老数据由 `database._repair_answer_blobs()` 一次性修好：只挑
`TRIM(answer_latex) LIKE '{%'` 的行，修完不再以 `{` 开头，因此天然幂等。
两类坏法它都能修。

## `\[\[` 会让整段公式渲染失败

`sanitize_latex()` 给 `\begin{aligned}` 补 `\[` 时，若原文已经有 `\[` 就叠成 `\[\[`，
KaTeX 直接报错。模型自己也会写两遍（真实数据里见过 `"\\[\n\\[\\begin{aligned}"`）。
所以最后有一步「合并重复行间定界符」，循环到稳定。嵌套行间公式在 LaTeX 里本就不合法，
无条件合并是安全的；但**别顺手把 `\\` 也合并了**，那是矩阵/换行用的。

## 两个反复咬人的技术坑

**1. `buildPdfHtml` 是模板字符串，反斜杠要写四层。**
打印页的 KaTeX 定界符必须写成 `\\\\[`：模板输出后是 `\\[`，页面 JS 解析后才是 `\[`。
写两层会退化成普通括号 `(`，auto-render 把 `(x^2)` 当公式，整页公式渲染失败。
这个 bug 修了三次才找对——因为测试文件里写的是四层，测试通过而实际代码是坏的。

**2. 打印页必须 `loadFile` 临时 HTML，不能用 data URL。** 它要引用本地
`vendor/katex`，data URL 页面加载不了 file:// 子资源。

**2.5 `styles.css` 里想压过 Tailwind，必须写「元素名 + 类名」。** Tailwind Play CDN
是运行时把 `<style>` 插到 `<head>` 末尾的，排在 `styles.css` 之后；同为单类选择器时
它的 `.px-3` 会赢。`.choice-box { padding-right: 2.1rem }` 就这么被静默吃掉过
（量出来还是 12px），改成 `input.choice-box, select.choice-box` 才生效。
**验证要量 `getComputedStyle`，别看源码想当然。**

**2.6 选择框的 ⌄ 是自绘的，点击行为在 JS 里。** 为了让「模型名」输入框和下拉框长得
一样，`.choice-box` 用 `appearance: none` + 背景 SVG 画箭头，并把 input[list] 的
原生 `::-webkit-calendar-picker-indicator` **`display:none`**（各版本 Chromium
绘制时机不一致，留着会在 hover 时冒出第二个箭头并排）。代价是自绘箭头不可点，
故 `render.js` 里给模型名输入框挂了 click：`offsetX` 落在右侧 34px 内就调
`showPicker()`。改 `padding-right` 时记得同步那个 34。
另外 `getComputedStyle(el, "::-webkit-calendar-picker-indicator")` **返回的是宿主
元素的值**（量出 width=454px 就是 input 自己），别拿它判断伪元素样式有没有生效。

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
  注意 `/* */` 块注释（PDF 模板里的 CSS 注释）也会被简单的按行扫描算进去，
  别把那 7 处当漏翻。
- **动态生成的下拉框不吃 `applyStaticTranslations()`**。推理档位选项是 JS 拼的，
  切语言时必须在 `changeLanguage()` 里重建（`loadEffortLevels()`），
  否则切到英文档位名还是中文——这条是测出来的，不是想出来的。
- **状态提示别塞进会被隐藏的容器**。`#answer-status` 一度放在 `#answer-tools` 里，
  而空态下工具区是 `hidden`，于是首次「AI 生成中…」根本看不见。
  测法是从该元素往上逐级找带 `hidden` 的祖先，比查 `offsetParent` 稳
  （弹窗自己是 flex 布局，offsetParent 会骗人）。
- **测 CSS 要测行为，别测属性名**。Tailwind 内置 line-clamp 的 computed
  `display` 是 `flow-root` 不是 `-webkit-box`，按属性断言会误报失败；量
  `clientHeight`（3 行 20px 行高 → 60px）才是对的。Play CDN 靠
  MutationObserver 编译，动态插入的元素要等 ~1s 再量。

**别信"成功"字样，信独立通道。** 上个会话 spec 打印"已附带 sqlite3.dll"而包里没有，
是 `archive_viewer` 抓到的；三项"已完成"的改动其实从未落盘，是重新打包产物名还是中文
才暴露的。声明与验证是两件事，报告时把两者分开说。

## macOS「已损坏」≠ Gatekeeper 拦截

用户装 dmg 报「已损坏，无法打开」，而且**把「允许任何来源」打开也没用**。
别往 Gatekeeper 方向查——那是两个不同的拦截点：

| 提示 | 原因 | 隐私设置能否放行 |
|------|------|------------------|
| 来自身份不明的开发者 | 有签名但非 Apple 认证 | 能（「仍要打开」） |
| **已损坏，无法打开** | **完全没有签名** | **不能** |

Apple Silicon 上内核直接拒绝加载无签名的 arm64 二进制，压根到不了 Gatekeeper 那一步。
CI 日志里 `skipped macOS application code signing` + `arch=arm64` 就是这个坑的信号。

解法是 **ad-hoc 签名**（`codesign --sign -`），不需要任何 Apple 证书，
已实现在 `scripts/afterPack.js`（electron-builder 的 `afterPack` 钩子）。两个要点：

1. **签名顺序必须从内到外**：先签 `Resources/backend/mistake-backend`（PyInstaller
   产物，走 extraResources 放在非标准位置，`--deep` 不保证覆盖），最后签 `.app` 外壳。
   反了会破坏外壳封印，签完又失效。
2. **CI 里要断言 `Signature=adhoc`**，不能只看构建成功。
   工作流有 `Verify ad-hoc signature` 一步，签名没生效就直接失败——
   否则又是「声明成功但产物是坏的」，只有用户装的时候才发现。

另外 quarantine 属性也会报同样的「已损坏」，用户侧 `xattr -cr` 清掉，见 BUILD.md。

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
