// Electron 主进程：
// 1. 启动时用 child_process.spawn 拉起 Python FastAPI 后端。
// 2. 轮询 /health，后端就绪后创建 1024x768 窗口加载前端。
// 3. 应用退出时干净地杀掉 Python 子进程，防止残留。

const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8000;
const HEALTH_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/health`;

let backendProcess = null;
let mainWindow = null;

// 解析虚拟环境中的 Python 解释器路径（Windows 优先，其他平台兜底）。
function resolvePythonExecutable() {
  const venvWin = path.join(__dirname, "backend", "venv", "Scripts", "python.exe");
  const venvUnix = path.join(__dirname, "backend", "venv", "bin", "python3");
  if (require("fs").existsSync(venvWin)) return venvWin;
  if (require("fs").existsSync(venvUnix)) return venvUnix;
  // 未创建虚拟环境时，退回系统 python（Windows 通常为 python，其它为 python3）。
  return process.platform === "win32" ? "python" : "python3";
}

// 启动 Python 后端子进程。
function startBackend() {
  const python = resolvePythonExecutable();
  const scriptPath = path.join(__dirname, "backend", "main.py");
  const cwd = path.join(__dirname, "backend");

  // 统一数据目录：把 Electron 的 userData 目录传给后端，
  // 后端的 SQLite 与后续 uploads 都落在这里（禁止硬编码 ./data）。
  backendProcess = spawn(python, [scriptPath], {
    cwd,
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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
  startBackend();
  try {
    await waitForBackend();
  } catch (err) {
    console.error(err.message, "— 仍将打开窗口，前端会提示无法连接后端。");
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopBackend);
process.on("exit", stopBackend);
