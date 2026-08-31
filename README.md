# 数理化错题本

跨平台（Windows / macOS）桌面错题本：AI 识别错题、公式渲染、艾宾浩斯复习提醒、举一反三、试卷导出。

基于 Electron + FastAPI + SQLite 构建，前端用 Tailwind CSS + KaTeX（本地资源，离线可用）。

## 功能

- **AI 识题录入**：上传图片 / PDF / DOCX，AI 自动识别题目、学科与知识点标签（支持 OpenAI 兼容接口，如 Qwen-VL、Claude、DeepSeek）
- **题目 / 答案分离**：录入时自动提取解答；没有答案时可手动输入或用 AI 生成
- **答案也能反复打磨**：和录入题目一样，AI 生成的答案不满意可以「重新生成」换一种思路，
  或用自然语言说明哪里不对（如「第二步符号错了」）让 AI 基于当前解答修正，也支持直接改源码
- **公式渲染**：KaTeX 渲染 LaTeX 公式（行内 `\( \)`、行间 `\[ \]`）
- **举一反三**：基于原题用 AI 生成「变式」或「拓展」新题，附带完整解答
- **艾宾浩斯复习**：按 1 / 2 / 4 / 7 / 15 天排程，到期待复习时弹出系统通知提醒
- **标签搜索**：按知识点 / 学科标签检索错题，随时增删标签（学科标签自动附带）
- **学科可改**：在题目详情里直接改学科，旧的学科标签会同步换成新的（自定义标签不受影响）
- **推理档位按模型自适应**：档位从 `none` 到 `max` 共七档，点「检测可用档位」会真机逐档
  试探当前模型/网关到底收哪些；选了不支持的档位会自动降到最接近的可用档位，不会报错
- **试卷导出**：勾选题目导出 LaTeX（.tex）或 PDF，支持「含答案 / 不含答案 / 答案在最后」三种版本，排版为试卷样式

## 开发运行

前置：Node.js ≥ 18、Python 3.10+（后端依赖见 `backend/requirements.txt`）。

```bash
# 1. 前端依赖
npm install

# 2. 后端虚拟环境（首次）
python -m venv backend/venv
backend/venv/Scripts/pip install -r backend/requirements.txt   # Windows
backend/venv/bin/pip install -r backend/requirements.txt       # macOS

# 3. 启动（自动拉起后端）
npm start
```

首次使用在「设置」页填写 AI 接口配置（API Key / Base URL / Model Name，兼容 OpenAI 规范）。

## 打包发布

见 [BUILD.md](BUILD.md)。Windows 安装包与 macOS dmg 均支持：

- Windows：`npm run dist:win`（本机直接构建）
- macOS：在 Mac 上执行 `npm run dist:mac`，或使用仓库内置的 GitHub Actions workflow 在云端构建

## 目录结构

```
├── main.js              # Electron 主进程（拉起后端、系统通知、PDF 打印）
├── preload.js           # 渲染进程桥接（PDF 导出 IPC）
├── src/                 # 前端（index.html / render.js / styles.css）
│   └── vendor/katex/    # 本地 KaTeX（离线渲染公式）
└── backend/             # FastAPI 后端
    ├── main.py          # 入口与全部路由
    ├── database.py      # SQLite 建表与幂等迁移
    ├── models.py        # Pydantic 模型
    ├── services/        # AI 客户端 / 复习调度 / LaTeX 导出 / 推理档位 / 文本修复
    └── backend.spec     # PyInstaller 打包配置
```

应用数据（数据库、上传文件、AI 配置）存放在系统用户数据目录，卸载重装不丢失。
