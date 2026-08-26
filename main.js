// Electron 主进程：
// 1. 启动时用 child_process.spawn 拉起 Python FastAPI 后端。
// 2. 轮询 /health，后端就绪后创建 1024x768 窗口加载前端。
// 3. 应用退出时干净地杀掉 Python 子进程，防止残留。

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  ipcMain,
  dialog,
} = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

// 用户数据目录固定为 ASCII 名（不随 productName 变化）：
// productName 用于安装目录与快捷方式显示，若它含非 ASCII 字符，
// Electron 默认的 userData 路径也会带非 ASCII，给 Python 子进程和
// 备份脚本带来编码麻烦。这里显式钉死，保证开发/打包共用同一目录。
const USER_DATA_DIR_NAME = "wrong-question-notebook";
app.setPath("userData", path.join(app.getPath("appData"), USER_DATA_DIR_NAME));

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8000;
const HEALTH_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/health`;
const DUE_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/api/review/due`;
const REMINDER_INTERVAL_MS = 60 * 60 * 1000; // 每小时检查一次

let backendProcess = null;
let mainWindow = null;
let reminderTimer = null;

// 解析后端启动方式：
// - 生产（app.isPackaged）：extraResources 里 PyInstaller 打包好的单文件后端。
// - 开发：虚拟环境中的 Python 解释器 + backend/main.py（Windows 优先，其他平台兜底）。
function resolveBackendLaunch() {
  if (app.isPackaged) {
    const exeName =
      process.platform === "win32" ? "mistake-backend.exe" : "mistake-backend";
    const exePath = path.join(process.resourcesPath, "backend", exeName);
    if (fs.existsSync(exePath)) {
      return { executable: exePath, args: [], cwd: path.dirname(exePath) };
    }
    console.error(`[backend] 未找到打包后端: ${exePath}，退回开发模式`);
  }
  const venvWin = path.join(__dirname, "backend", "venv", "Scripts", "python.exe");
  const venvUnix = path.join(__dirname, "backend", "venv", "bin", "python3");
  const python = fs.existsSync(venvWin)
    ? venvWin
    : fs.existsSync(venvUnix)
      ? venvUnix
      : process.platform === "win32"
        ? "python"
        : "python3";
  return {
    executable: python,
    args: [path.join(__dirname, "backend", "main.py")],
    cwd: path.join(__dirname, "backend"),
  };
}

// 启动后端进程（开发=Python 解释器跑 main.py；生产=打包好的后端可执行文件）。
function startBackend() {
  const launch = resolveBackendLaunch();

  // 统一数据目录：把 Electron 的 userData 目录传给后端，
  // 后端的 SQLite 与后续 uploads 都落在这里（禁止硬编码 ./data）。
  backendProcess = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, USER_DATA: app.getPath("userData") },
  });

  backendProcess.stdout.on("data", (data) => {
    process.stdout.write(`[backend] ${data}`);
  });
  backendProcess.stderr.on("data", (data) => {
    process.stderr.write(`[backend] ${data}`);
  });
  backendProcess.on("exit", (code) => {
    console.log(`[backend] 进程退出，code=${code}`);
    backendProcess = null;
  });
}

// 轮询后端 /health，直到就绪或超时。
function waitForBackend(retries = 40, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryOnce = () => {
      attempt += 1;
      const req = http.get(HEALTH_URL, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
        } else {
          res.resume();
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(1000, () => req.destroy());
    };

    const retry = () => {
      if (attempt >= retries) {
        reject(new Error("后端在超时时间内未就绪"));
      } else {
        setTimeout(tryOnce, intervalMs);
      }
    };

    tryOnce();
  });
}

// 查询今日待复习数量（GET /api/review/due），失败时静默返回 0。
function fetchDueCount() {
  return new Promise((resolve) => {
    const req = http.get(DUE_URL, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const list = JSON.parse(body);
          resolve(Array.isArray(list) ? list.length : 0);
        } catch {
          resolve(0);
        }
      });
    });
    req.on("error", () => resolve(0));
    req.setTimeout(3000, () => req.destroy());
  });
}

// 读取界面语言（与前端「设置」页共用 config.json），供通知文案使用。
function readUiLanguage() {
  try {
    const cfgPath = path.join(app.getPath("userData"), "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return cfg.ui_language === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

// 弹出艾宾浩斯复习提醒（若当天有待复习题目）。
async function checkReviewReminders() {
  if (!Notification.isSupported()) return;
  const count = await fetchDueCount();
  if (count <= 0) return;

  const zh = readUiLanguage() === "zh";
  const notification = new Notification({
    title: zh ? "复习提醒" : "Review reminder",
    body: zh
      ? `今天有 ${count} 道错题待复习，点击打开错题本。`
      : `${count} problem(s) due for review today. Click to open.`,
  });
  notification.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
}

// 启动复习提醒定时器：启动后延迟首查，之后每小时一次。
function startReviewReminders() {
  setTimeout(checkReviewReminders, 5000);
  reminderTimer = setInterval(checkReviewReminders, REMINDER_INTERVAL_MS);
}

function stopReviewReminders() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 渲染进程请求导出 PDF：先让用户选保存位置，再用隐藏窗口渲染 HTML 后打印。
async function handleExportPdf(_event, payload) {
  const html = payload && typeof payload === "object" ? payload.html : payload;
  const suggested =
    payload && payload.suggestedName ? payload.suggestedName : "mistakes.pdf";

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: suggested,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { canceled: true };

  // 打印页面以 file:// 加载（能引用本地 KaTeX vendor）；data URL 无法加载 file 资源。
  const printHtmlPath = path.join(
    app.getPath("temp"),
    `mistakes-${Date.now()}-${Math.round(Math.random() * 1e6)}.html`
  );
  fs.writeFileSync(printHtmlPath, html, "utf-8");

  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await printWin.loadFile(printHtmlPath);
    // 轮询页面里的渲染完成标记（页面调完 renderMathInElement 后置位），
    // 最多等 5 秒；之后等公式字体加载完毕，避免 PDF 里缺字体。
    for (let i = 0; i < 50; i++) {
      const done = await printWin.webContents.executeJavaScript(
        "window.__pdfRendered === true"
      );
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await printWin.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)"
    );
    const pdf = await printWin.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
    });
    fs.writeFileSync(filePath, pdf);
    return { canceled: false, filePath };
  } finally {
    if (!printWin.isDestroyed()) printWin.destroy();
    if (fs.existsSync(printHtmlPath)) fs.unlinkSync(printHtmlPath);
  }
}

// 干净地终止后端进程。
function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    // Windows 上 SIGTERM 也能终止；显式 kill 兜底。
    backendProcess.kill();
    backendProcess = null;
  }
}

app.whenReady().then(async () => {
  // Windows 通知需要一个稳定的 AppUserModelID，否则通知可能不显示。
  app.setAppUserModelId("com.mistakenotebook.app");
  // 移除 Electron 默认菜单栏（File / Edit / View / Window / Help）。
  // 应用自带侧边栏导航，系统菜单是多余的。注意：这会同时禁用
  // 默认快捷键（如 Ctrl+R 刷新、F12 开发者工具）。
  Menu.setApplicationMenu(null);
  ipcMain.handle("export-pdf", handleExportPdf);

  startBackend();
  try {
    await waitForBackend();
  } catch (err) {
    console.error(err.message, "— 仍将打开窗口，前端会提示无法连接后端。");
  }
  createWindow();
  startReviewReminders();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopReviewReminders();
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopBackend);
process.on("exit", stopBackend);
